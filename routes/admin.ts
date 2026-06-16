import express from 'express';
import { requireAdmin, AdminRequest } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { createRateLimiter } from '../middleware/rateLimiter.js';
import { config } from '../config/index.js';
import { listModerationActions } from '../services/auditService.js';
import { listReports, getReport, updateReportStatus } from '../services/reportService.js';
import { deleteMessage, restoreMessage, banUser, unbanUser, suspendUser } from '../services/moderationService.js';

const router = express.Router();

// Every admin route is gated and rate-limited. The gate is fail-closed (denies
// all when ADMIN_API_KEY is unset), so mounting this is safe even before a key
// is configured.
const adminLimiter = createRateLimiter({ name: 'admin', limit: config.isProduction ? 240 : 2000 });
router.use(requireAdmin, adminLimiter);

// Lightweight check the web panel can call to confirm the key works.
router.get('/ping', (req: AdminRequest, res: express.Response) => {
    res.json({ ok: true, actor: req.admin?.actor });
});

// --- Reports / moderation queue ---------------------------------------------

router.get('/reports', asyncHandler(async (req: AdminRequest, res: express.Response) => {
    const result = await listReports({
        status: typeof req.query.status === 'string' ? req.query.status : undefined,
        reason: typeof req.query.reason === 'string' ? req.query.reason : undefined,
        targetType: typeof req.query.targetType === 'string' ? req.query.targetType : undefined,
        page: req.query.page ? Number(req.query.page) : undefined,
        pageSize: req.query.pageSize ? Number(req.query.pageSize) : undefined,
    });
    res.json(result);
}));

router.get('/reports/:id', asyncHandler(async (req: AdminRequest, res: express.Response) => {
    const report = await getReport(req.params.id);
    res.json(report);
}));

router.patch('/reports/:id', asyncHandler(async (req: AdminRequest, res: express.Response) => {
    const report = await updateReportStatus(req.params.id, req.body.status, req.admin!.actor, req.body.note);
    res.json(report);
}));

// --- Content removal --------------------------------------------------------

router.delete('/messages/:id', asyncHandler(async (req: AdminRequest, res: express.Response) => {
    const result = await deleteMessage(req.params.id, req.admin!.actor, req.body?.reason);
    res.json(result);
}));

router.post('/messages/:id/restore', asyncHandler(async (req: AdminRequest, res: express.Response) => {
    const result = await restoreMessage(req.params.id, req.admin!.actor);
    res.json(result);
}));

// --- User enforcement -------------------------------------------------------

router.post('/users/:id/ban', asyncHandler(async (req: AdminRequest, res: express.Response) => {
    const result = await banUser(req.params.id, req.admin!.actor, req.body?.reason);
    res.json(result);
}));

router.post('/users/:id/suspend', asyncHandler(async (req: AdminRequest, res: express.Response) => {
    const result = await suspendUser(req.params.id, req.admin!.actor, req.body?.reason, req.body?.suspendedUntil);
    res.json(result);
}));

router.post('/users/:id/unban', asyncHandler(async (req: AdminRequest, res: express.Response) => {
    const result = await unbanUser(req.params.id, req.admin!.actor);
    res.json(result);
}));

// Audit trail (append-only).
router.get('/audit', asyncHandler(async (req: AdminRequest, res: express.Response) => {
    const result = await listModerationActions({
        targetId: typeof req.query.targetId === 'string' ? req.query.targetId : undefined,
        actorLabel: typeof req.query.actorLabel === 'string' ? req.query.actorLabel : undefined,
        page: req.query.page ? Number(req.query.page) : undefined,
        pageSize: req.query.pageSize ? Number(req.query.pageSize) : undefined,
    });
    res.json(result);
}));

export default router;
