import mongoose from 'mongoose';
import { DailyStat } from '../models/DailyStat.js';
import { User } from '../models/User.js';
import { config } from '../config/index.js';
import { ValidationError } from '../utils/errors.js';
import { addDays, startOfUtcDay } from '../utils/utcDay.js';
import logger from '../utils/logger.js';
import { countActiveAmong, countActiveUsers, firstActivityDay } from './activityService.js';
import { CountRow, PeriodCounts, countPeriod } from './analyticsService.js';

// The daily rollup: once a UTC day is over, its totals are written to
// DailyStat and never change again (see models/DailyStat.ts).

// A day's city list keeps every city with messages, up to this many.
const MAX_ROLLUP_CITY_ROWS = 500;

interface ReturningSignups {
    // Users who signed up that many days earlier...
    signups: number;
    // ...and of them, how many used the app on this day.
    returned: number;
}

export interface DailyStatData {
    users: {
        new: number;
        // Accounts that existed at the end of the day (and still exist).
        total: number;
    };
    // null for days before activity tracking started.
    active: {
        users: number;
        last7Days: number;
        last30Days: number;
        byPlatform: CountRow[];
    } | null;
    retention: {
        day1: ReturningSignups;
        day7: ReturningSignups;
        day30: ReturningSignups;
    } | null;
    signIns: PeriodCounts['signIns'];
    messages: PeriodCounts['messages'];
    reports: PeriodCounts['reports'];
    blocks: PeriodCounts['blocks'];
    moderation: PeriodCounts['moderation'];
    contentBlocked: PeriodCounts['contentBlocked'];
}

async function countReturningSignups(day: Date, daysLater: number): Promise<ReturningSignups> {
    const signupDay = addDays(day, -daysLater);
    const signups = await User.find({ createdAt: { $gte: signupDay, $lt: addDays(signupDay, 1) } })
        .select('_id')
        .lean<Array<{ _id: mongoose.Types.ObjectId }>>();
    return {
        signups: signups.length,
        returned: await countActiveAmong(signups.map((user) => user._id), day),
    };
}

/** The totals for one UTC day. */
export async function computeDailyStat(day: Date, trackingStart: Date | null): Promise<DailyStatData> {
    const from = startOfUtcDay(day);
    const to = addDays(from, 1);
    const tracked = trackingStart !== null && from.getTime() >= trackingStart.getTime();

    const [counts, totalUsers] = await Promise.all([
        countPeriod({ from, to, cityLimit: MAX_ROLLUP_CITY_ROWS }),
        User.countDocuments({ createdAt: { $lt: to } }),
    ]);

    let active: DailyStatData['active'] = null;
    let retention: DailyStatData['retention'] = null;
    if (tracked) {
        const [last7Days, last30Days, day1, day7, day30] = await Promise.all([
            countActiveUsers(addDays(from, -6), to),
            countActiveUsers(addDays(from, -29), to),
            countReturningSignups(from, 1),
            countReturningSignups(from, 7),
            countReturningSignups(from, 30),
        ]);
        active = { users: counts.active.users, last7Days, last30Days, byPlatform: counts.active.byPlatform };
        retention = { day1, day7, day30 };
    }

    return {
        users: { new: counts.users.new, total: totalUsers },
        active,
        retention,
        signIns: counts.signIns,
        messages: counts.messages,
        reports: counts.reports,
        blocks: counts.blocks,
        moderation: counts.moderation,
        contentBlocked: counts.contentBlocked,
    };
}

/**
 * Writes the totals for every finished day in the backfill window that has
 * none yet, oldest first, starting no earlier than the first account. Days
 * already written are left as they are. Returns how many days were written.
 */
export async function ensureDailyStats(now: Date = new Date()): Promise<number> {
    const today = startOfUtcDay(now);
    const firstUser = await User.findOne().sort({ createdAt: 1 }).select('createdAt').lean<{ createdAt?: Date } | null>();
    if (!firstUser?.createdAt) {
        return 0;
    }

    const windowStart = addDays(today, -config.analytics.backfillDays);
    const firstDay = new Date(Math.max(windowStart.getTime(), startOfUtcDay(firstUser.createdAt).getTime()));
    if (firstDay.getTime() >= today.getTime()) {
        return 0;
    }

    const existing = await DailyStat.find({ day: { $gte: firstDay, $lt: today } })
        .select('day')
        .lean<Array<{ day: Date }>>();
    const done = new Set(existing.map((stat) => stat.day.getTime()));

    const trackingStart = await firstActivityDay();
    let written = 0;
    for (let day = firstDay; day.getTime() < today.getTime(); day = addDays(day, 1)) {
        if (done.has(day.getTime())) {
            continue;
        }
        const data = await computeDailyStat(day, trackingStart);
        // An upsert that only inserts: a day written meanwhile stays as it is.
        await DailyStat.updateOne(
            { day },
            { $setOnInsert: { day, ...data, computedAt: new Date() } },
            { upsert: true }
        );
        written += 1;
    }

    if (written > 0) {
        logger.info('analytics.daily_stats.written', { days: written });
    }
    return written;
}

// ============================================================
// Reading
// ============================================================

const DEFAULT_DAILY_DAYS = 30;
const MAX_DAILY_DAYS = 366;

export interface DailyStatResponse extends DailyStatData {
    day: number;
    computedAt: number | null;
}

/** The written daily totals of the last `days` finished days, oldest first. */
export async function listDailyStats(input: { days?: unknown }): Promise<{ days: DailyStatResponse[] }> {
    let days = DEFAULT_DAILY_DAYS;
    if (input.days !== undefined && input.days !== null && input.days !== '') {
        days = Number(input.days);
        if (!Number.isInteger(days) || days < 1 || days > MAX_DAILY_DAYS) {
            throw new ValidationError(`days must be a whole number from 1 to ${MAX_DAILY_DAYS}.`);
        }
    }

    const today = startOfUtcDay(new Date());
    const stats = await DailyStat.find({ day: { $gte: addDays(today, -days), $lt: today } })
        .sort({ day: 1 })
        .lean<Array<DailyStatData & { day: Date; computedAt?: Date }>>();

    return {
        days: stats.map((stat) => ({
            day: stat.day.getTime(),
            users: stat.users,
            active: stat.active ?? null,
            retention: stat.retention ?? null,
            signIns: stat.signIns,
            messages: stat.messages,
            reports: stat.reports,
            blocks: stat.blocks,
            moderation: stat.moderation,
            contentBlocked: stat.contentBlocked,
            computedAt: stat.computedAt ? stat.computedAt.getTime() : null,
        })),
    };
}
