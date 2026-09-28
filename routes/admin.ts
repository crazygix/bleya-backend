import express from 'express';
import { requireAdmin, AdminRequest } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { createRateLimiter } from '../middleware/rateLimiter.js';
import { config } from '../config/index.js';
import { listModerationActions } from '../services/auditService.js';
import { listReports, getReport, updateReportStatus } from '../services/reportService.js';
import {
    deleteMessage,
    restoreMessage,
    banUser,
    unbanUser,
    suspendUser,
    clearUserProfile,
    removeUserMessages,
} from '../services/moderationService.js';
import { exportUserData, deleteUserAccount } from '../services/accountService.js';
import { recordModerationAction } from '../services/auditService.js';
import { validateObjectId } from '../utils/validation.js';

const router = express.Router();

// Every admin route is gated and rate-limited. The gate is fail-closed (denies
// all when ADMIN_API_KEY is unset), so mounting this is safe even before a key
// is configured. Failed attempts are limited *before* the key check so the key
// can't be guessed at full speed.
const adminKeyFailureLimiter = createRateLimiter({
    name: 'admin.key-failures',
    limit: config.isProduction ? 20 : 2000,
    skipSuccessfulRequests: true,
});
const adminLimiter = createRateLimiter({ name: 'admin', limit: config.isProduction ? 240 : 2000 });
router.use(adminKeyFailureLimiter, requireAdmin, adminLimiter);

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

// Remove abusive profile content. Body: { fields?: ('username'|'bio'|'avatar')[], reason? }
router.post('/users/:id/clear-profile', asyncHandler(async (req: AdminRequest, res: express.Response) => {
    const result = await clearUserProfile(req.params.id, req.admin!.actor, req.body?.fields, req.body?.reason);
    res.json(result);
}));

// Soft-delete all of a user's messages. Body: { reason?, roomId? }
router.post('/users/:id/remove-messages', asyncHandler(async (req: AdminRequest, res: express.Response) => {
    const result = await removeUserMessages(req.params.id, req.admin!.actor, req.body?.reason, req.body?.roomId);
    res.json(result);
}));

// --- Data-subject requests received outside the app (email, under-age) -------

router.get('/users/:id/export', asyncHandler(async (req: AdminRequest, res: express.Response) => {
    const id = validateObjectId(req.params.id, 'user ID');
    const data = await exportUserData(id.toString());
    await recordModerationAction({
        actorLabel: req.admin!.actor,
        action: 'user_data_exported',
        targetType: 'user',
        targetId: id,
    });
    res.json(data);
}));

router.delete('/users/:id', asyncHandler(async (req: AdminRequest, res: express.Response) => {
    const id = validateObjectId(req.params.id, 'user ID');
    const result = await deleteUserAccount(id.toString());
    await recordModerationAction({
        actorLabel: req.admin!.actor,
        action: 'user_account_deleted',
        targetType: 'user',
        targetId: id,
        reason: typeof req.body?.reason === 'string' ? req.body.reason.slice(0, 500) : '',
        metadata: { removed: result.removed },
    });
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
