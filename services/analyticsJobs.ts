import { errorDetails } from '../utils/errors.js';
import logger from '../utils/logger.js';
import { ensureDailyStats } from './dailyStatsService.js';
import { isDailyDigestConfigured, sendDailyDigestIfDue } from './dailyDigestService.js';

// Every 10 minutes: write the totals of days that ended (DailyStat), then send
// yesterday's Telegram digest once it is due. In-process, because the API runs
// as a single instance (railway.toml); both steps are idempotent, so a restart
// or an overlapping deploy can't double them.
const JOB_INTERVAL_MS = 10 * 60 * 1000;
// Let the server settle after a deploy before the first (possibly long) backfill.
const FIRST_RUN_DELAY_MS = 60 * 1000;

let started = false;
let running = false;

async function runAnalyticsJobs(): Promise<void> {
    if (running) {
        return;
    }
    running = true;
    try {
        await ensureDailyStats();
        if (isDailyDigestConfigured()) {
            await sendDailyDigestIfDue();
        }
    } catch (error) {
        logger.error('analytics.jobs.failed', { error: errorDetails(error) });
    } finally {
        running = false;
    }
}

export function startAnalyticsJobs(): void {
    if (started) {
        return;
    }
    started = true;
    setTimeout(() => void runAnalyticsJobs(), FIRST_RUN_DELAY_MS).unref();
    setInterval(() => void runAnalyticsJobs(), JOB_INTERVAL_MS).unref();
}
