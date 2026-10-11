import mongoose from 'mongoose';
import { UserActivity } from '../models/UserActivity.js';
import { config } from '../config/index.js';
import type { ClientContext } from '../utils/clientContext.js';
import { retainUntilAfter } from '../utils/retention.js';
import { startOfUtcDay } from '../utils/utcDay.js';
import { errorDetails } from '../utils/errors.js';
import logger from '../utils/logger.js';

const OBJECT_ID_PATTERN = /^[0-9a-fA-F]{24}$/;

// Users already recorded as active today, so a user costs one write a day
// instead of one per request. In memory is enough: the API runs as a single
// instance (railway.toml), and after a restart the upsert is repeated once.
let recordedDay = 0;
const recordedToday = new Set<string>();

/**
 * Marks the user as active today (UTC). Called on every authenticated request,
 * socket connection and sign-in. Fire-and-forget: never fails or delays the
 * request, and skipped while the database is disconnected.
 */
export function recordUserActivity(userId: string, client: ClientContext = {}): void {
    if (!OBJECT_ID_PATTERN.test(userId) || mongoose.connection.readyState !== 1) {
        return;
    }

    const day = startOfUtcDay(new Date());
    if (day.getTime() !== recordedDay) {
        recordedDay = day.getTime();
        recordedToday.clear();
    }
    if (recordedToday.has(userId)) {
        return;
    }
    recordedToday.add(userId);

    const firstSeen: Record<string, unknown> = {
        retainUntil: retainUntilAfter(config.analytics.retentionDays, day),
    };
    if (client.platform) {
        firstSeen.platform = client.platform;
    }
    if (client.appVersion) {
        firstSeen.appVersion = client.appVersion;
    }

    void UserActivity.updateOne(
        { userId: new mongoose.Types.ObjectId(userId), day },
        { $setOnInsert: firstSeen },
        { upsert: true }
    ).catch((error: unknown) => {
        recordedToday.delete(userId);
        // Two of the user's first requests of the day raced on the upsert.
        if ((error as { code?: unknown } | null)?.code === 11000) {
            return;
        }
        logger.error('activity.record_failed', { userId, error: errorDetails(error) });
    });
}

export function resetActivityCacheForTests(): void {
    recordedDay = 0;
    recordedToday.clear();
}

// ============================================================
// Counting
// ============================================================

function dayRange(from: Date, to: Date): { $gte: Date; $lt: Date } {
    return { $gte: startOfUtcDay(from), $lt: to };
}

/** Distinct users active on any day in [from, to). */
export async function countActiveUsers(from: Date, to: Date): Promise<number> {
    const [row] = await UserActivity.aggregate<{ users: number }>([
        { $match: { day: dayRange(from, to) } },
        { $group: { _id: '$userId' } },
        { $count: 'users' },
    ]);
    return row?.users ?? 0;
}

/** Distinct users active in [from, to) per platform ('unknown' for builds that don't say). */
export async function countActiveUsersByPlatform(from: Date, to: Date): Promise<Array<{ _id: string | null; count: number }>> {
    return UserActivity.aggregate<{ _id: string | null; count: number }>([
        { $match: { day: dayRange(from, to) } },
        { $group: { _id: { userId: '$userId', platform: '$platform' } } },
        { $group: { _id: '$_id.platform', count: { $sum: 1 } } },
    ]);
}

/** Active users per day in [from, to). */
export async function countActiveUsersPerDay(from: Date, to: Date): Promise<Array<{ _id: Date; count: number }>> {
    return UserActivity.aggregate<{ _id: Date; count: number }>([
        { $match: { day: dayRange(from, to) } },
        { $group: { _id: '$day', count: { $sum: 1 } } },
    ]);
}

/** How many of `userIds` were active on `day`. */
export async function countActiveAmong(userIds: mongoose.Types.ObjectId[], day: Date): Promise<number> {
    if (userIds.length === 0) {
        return 0;
    }
    return UserActivity.countDocuments({ day: startOfUtcDay(day), userId: { $in: userIds } });
}

/** The first day with any recorded activity, or null before tracking started. */
export async function firstActivityDay(): Promise<Date | null> {
    const first = await UserActivity.findOne().sort({ day: 1 }).select('day').lean<{ day: Date } | null>();
    return first?.day ?? null;
}
