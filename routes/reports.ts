import express from 'express';
import { authenticateUser, AuthRequest } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { createRateLimiter } from '../middleware/rateLimiter.js';
import { config } from '../config/index.js';
import { createReport } from '../services/reportService.js';

const router = express.Router();

const PROD = config.isProduction;

// Reports are user-initiated and low-frequency; throttle to limit abuse/spam.
const reportLimiter = createRateLimiter({ name: 'reports.create', limit: PROD ? 20 : 200 });

router.post('/', authenticateUser, reportLimiter, asyncHandler(async (req: AuthRequest, res: express.Response) => {
    const result = await createReport(req.user!.userId, {
        reportedUserId: req.body.reportedUserId,
        roomId: req.body.roomId,
        messageId: req.body.messageId,
        reason: req.body.reason,
        details: req.body.details,
    });
    res.status(201).json(result);
}));

export default router;
