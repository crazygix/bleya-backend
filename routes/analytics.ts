import express from 'express';
import { identifyUserIfPresent, AuthRequest } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { createRateLimiter } from '../middleware/rateLimiter.js';
import { config } from '../config/index.js';
import { recordClientEvents } from '../services/analyticsService.js';
import { readClientContext } from '../utils/clientContext.js';

const router = express.Router();

const PROD = config.isProduction;

// Open to signed-out callers (sign-in attempts happen before there is a
// token), so it is throttled per IP.
const clientEventsLimiter = createRateLimiter({ name: 'analytics.events', limit: PROD ? 60 : 600 });

router.post('/events', clientEventsLimiter, identifyUserIfPresent, asyncHandler(async (req: AuthRequest, res: express.Response) => {
    const result = await recordClientEvents(req.user?.userId, {
        installId: req.body.installId,
        platform: req.body.platform,
        appVersion: req.body.appVersion,
        events: req.body.events,
    }, readClientContext(req.headers));
    res.status(202).json(result);
}));

export default router;
