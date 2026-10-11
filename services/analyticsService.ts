import mongoose from 'mongoose';
import { AnalyticsEvent, AnalyticsEventSource } from '../models/AnalyticsEvent.js';
import { User } from '../models/User.js';
import { Message } from '../models/Message.js';
import { Room } from '../models/Room.js';
import { Report } from '../models/Report.js';
import { ModerationAction } from '../models/ModerationAction.js';
import { UserBlock } from '../models/UserBlock.js';
import { config } from '../config/index.js';
import { AppError, ErrorCode, TooManyRequestsError, ValidationError, errorDetails } from '../utils/errors.js';
import { DAY_MS, retainUntilAfter } from '../utils/retention.js';
import { addDays, startOfUtcDay } from '../utils/utcDay.js';
import {
    ClientContext,
    normalizeAppVersion,
    normalizeInstallId,
    normalizePlatform,
} from '../utils/clientContext.js';
import {
    countActiveUsers,
    countActiveUsersByPlatform,
    countActiveUsersPerDay,
} from './activityService.js';
import logger from '../utils/logger.js';

// ============================================================
// Recording
// ============================================================

export const SIGN_IN_SUCCEEDED = 'sign_in.succeeded';
export const SIGN_IN_FAILED = 'sign_in.failed';
// Text or an image the automatic content filter rejected.
export const CONTENT_BLOCKED = 'moderation.content_blocked';

export type SignInMethod = 'google' | 'apple' | 'passkey' | 'unknown';
export type ContentSurface = 'message' | 'username' | 'bio' | 'profile_photo';

interface TrackEventInput {
    name: string;
    source?: AnalyticsEventSource;
    userId?: string;
    client?: ClientContext;
    props?: Record<string, unknown>;
}

// Best-effort and fire-and-forget: analytics must never fail or slow down the
// request it describes. Skipped while the database is disconnected, where
// mongoose would otherwise hold the write until it reconnects.
export function trackEvent(input: TrackEventInput): void {
    if (mongoose.connection.readyState !== 1) {
        return;
    }

    const now = new Date();
    void AnalyticsEvent.create({
        name: input.name,
        source: input.source ?? 'server',
        userId: input.userId && mongoose.Types.ObjectId.isValid(input.userId)
            ? new mongoose.Types.ObjectId(input.userId)
            : undefined,
        installId: input.client?.installId,
        platform: input.client?.platform,
        appVersion: input.client?.appVersion,
        props: input.props,
        occurredAt: now,
        retainUntil: retainUntilAfter(config.analytics.retentionDays, now),
    }).catch((error: unknown) => {
        logger.error('analytics.track_failed', {
            name: input.name,
            error: errorDetails(error),
        });
    });
}

export function trackSignInSucceeded(input: {
    method: SignInMethod;
    client: ClientContext;
    userId: string;
    isNewUser: boolean;
}): void {
    trackEvent({
        name: SIGN_IN_SUCCEEDED,
        userId: input.userId,
        client: input.client,
        props: { method: input.method, isNewUser: input.isNewUser },
    });
}

// `reason` is the API error code the app received (e.g. USER_BLOCKED,
// UNAUTHORIZED); `detail` is the server-written error message, never input.
export function trackSignInFailed(input: {
    method: SignInMethod;
    client: ClientContext;
    error: unknown;
}): void {
    const isKnown = input.error instanceof AppError;
    trackEvent({
        name: SIGN_IN_FAILED,
        client: input.client,
        props: {
            method: input.method,
            reason: isKnown ? (input.error as AppError).code : ErrorCode.INTERNAL_ERROR,
            detail: isKnown ? (input.error as AppError).message.slice(0, 200) : '',
        },
    });
}

// Sign-ins the rate limiter turned away (429) never reach the sign-in route, so
// they are recorded from the limiter. Once per install (or per IP, for app
// builds without an install id) per window, so a flood of rejected requests
// can't turn into a flood of database writes.
const RATE_LIMITED_WINDOW_MS = 15 * 60 * 1000;
const MAX_RATE_LIMITED_KEYS = 10_000;
const recentlyRateLimited = new Map<string, number>();

export function trackSignInRateLimited(input: {
    method: SignInMethod;
    client: ClientContext;
    ip: string;
}): void {
    const now = Date.now();
    const key = `${input.method}|${input.client.installId ?? input.ip}`;
    const until = recentlyRateLimited.get(key);
    if (until !== undefined && until > now) {
        return;
    }

    if (recentlyRateLimited.size >= MAX_RATE_LIMITED_KEYS) {
        for (const [entry, expiresAt] of recentlyRateLimited) {
            if (expiresAt <= now) {
                recentlyRateLimited.delete(entry);
            }
        }
        if (recentlyRateLimited.size >= MAX_RATE_LIMITED_KEYS) {
            return;
        }
    }
    recentlyRateLimited.set(key, now + RATE_LIMITED_WINDOW_MS);

    trackSignInFailed({
        method: input.method,
        client: input.client,
        error: new TooManyRequestsError('Too many requests. Please try again later.'),
    });
}

export function resetRateLimitedSignInsForTests(): void {
    recentlyRateLimited.clear();
}

// What was rejected and where, never the content itself.
export function trackContentBlocked(input: { surface: ContentSurface; userId: string }): void {
    trackEvent({
        name: CONTENT_BLOCKED,
        userId: input.userId,
        props: {
            surface: input.surface,
            kind: input.surface === 'profile_photo' ? 'image' : 'text',
        },
    });
}

// ============================================================
// Events reported by the app
// ============================================================

// Only these names are accepted from the app; each is stored as `client.<name>`.
export const CLIENT_EVENT_NAMES = [
    'app.opened',
    'sign_in.started',
    'sign_in.cancelled',
    'sign_in.failed',
] as const;
const CLIENT_EVENT_NAME_SET = new Set<string>(CLIENT_EVENT_NAMES);

// Allowlisted props and the values each may hold; anything else is dropped, so
// the app can't store free-form or personal data here.
const CLIENT_PROP_PATTERNS: Record<string, RegExp> = {
    provider: /^(google|apple|passkey)$/,
    reason: /^[\w .:/-]{1,100}$/,
    screen: /^[\w.-]{1,50}$/,
};
const MAX_CLIENT_EVENTS_PER_REQUEST = 25;
// Events the app queued while offline may arrive late, but not from the future
// or from long ago.
const MAX_CLIENT_EVENT_AGE_MS = 7 * DAY_MS;
const MAX_CLIENT_CLOCK_SKEW_MS = 5 * 60 * 1000;

export interface RecordClientEventsInput {
    installId?: unknown;
    platform?: unknown;
    appVersion?: unknown;
    events?: unknown;
}

export interface RecordClientEventsResult {
    accepted: number;
}

function pickClientProps(value: unknown): Record<string, string> | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return undefined;
    }

    const props: Record<string, string> = {};
    for (const [key, pattern] of Object.entries(CLIENT_PROP_PATTERNS)) {
        const prop = (value as Record<string, unknown>)[key];
        if (typeof prop === 'string' && pattern.test(prop)) {
            props[key] = prop;
        }
    }
    return Object.keys(props).length > 0 ? props : undefined;
}

function resolveOccurredAt(value: unknown, now: Date): Date {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return now;
    }
    const age = now.getTime() - value;
    if (age > MAX_CLIENT_EVENT_AGE_MS || age < -MAX_CLIENT_CLOCK_SKEW_MS) {
        return now;
    }
    return new Date(value);
}

/**
 * Stores a batch of events the app reports. Unknown event names and props are
 * skipped rather than rejected, so an older backend never breaks a newer app.
 * `userId` is set when the request carried a valid access token; install id,
 * platform and app version come from the body or, failing that, the request
 * headers (`headerContext`).
 */
export async function recordClientEvents(
    userId: string | undefined,
    input: RecordClientEventsInput,
    headerContext: ClientContext = {}
): Promise<RecordClientEventsResult> {
    if (!Array.isArray(input.events)) {
        throw new ValidationError('events must be an array.');
    }
    if (input.events.length > MAX_CLIENT_EVENTS_PER_REQUEST) {
        throw new ValidationError(`Send at most ${MAX_CLIENT_EVENTS_PER_REQUEST} events at once.`);
    }

    const now = new Date();
    const installId = normalizeInstallId(input.installId) ?? headerContext.installId;
    const platform = normalizePlatform(input.platform) ?? headerContext.platform;
    const appVersion = normalizeAppVersion(input.appVersion) ?? headerContext.appVersion;

    const docs = [];
    for (const event of input.events) {
        if (!event || typeof event !== 'object') {
            continue;
        }
        const { name, props, occurredAt } = event as Record<string, unknown>;
        if (typeof name !== 'string' || !CLIENT_EVENT_NAME_SET.has(name)) {
            continue;
        }

        const happenedAt = resolveOccurredAt(occurredAt, now);
        docs.push({
            name: `client.${name}`,
            source: 'client' as const,
            userId: userId ? new mongoose.Types.ObjectId(userId) : undefined,
            installId,
            platform,
            appVersion,
            props: pickClientProps(props),
            occurredAt: happenedAt,
            retainUntil: retainUntilAfter(config.analytics.retentionDays, happenedAt),
        });
    }

    if (docs.length > 0) {
        await AnalyticsEvent.insertMany(docs);
    }
    return { accepted: docs.length };
}

// ============================================================
// Counting (shared by the admin summary and the daily rollup)
// ============================================================

export interface CountRow {
    key: string;
    count: number;
}

export interface SignInBreakdownRow {
    key: string;
    succeeded: number;
    failed: number;
}

export interface CityMessagesRow {
    roomId: string;
    name: string;
    cityKey: string | null;
    messages: number;
}

export interface SignInCounts {
    succeeded: number;
    failed: number;
    newAccounts: number;
    byMethod: Array<{ method: string; succeeded: number; failed: number }>;
    byPlatform: Array<{ platform: string; succeeded: number; failed: number }>;
    failureReasons: CountRow[];
    // Reported by the app: attempts that never reached the backend.
    client: {
        started: number;
        cancelled: number;
        failed: number;
        failureReasons: CountRow[];
    };
    // People rather than attempts: app installs that tried to sign in (any
    // sign-in event, from the app or the server) and whether any attempt
    // worked. Only app builds that send an install id are counted here.
    installs: {
        // Opened the app while signed out: the top of the sign-in funnel.
        openedSignedOut: number;
        tried: number;
        signedIn: number;
        neverSignedIn: number;
        // Never signed in and saw at least one error (the rest only gave up).
        neverSignedInAfterError: number;
    };
    // Server sign-in events without an install id (older app builds), which
    // the installs section can't include.
    attemptsWithoutInstallId: number;
}

export interface MessageCounts {
    // Messages sent, including ones moderators later removed.
    total: number;
    inCityRooms: number;
    inDirectMessages: number;
    byCity: CityMessagesRow[];
}

export interface PeriodCounts {
    users: { new: number };
    // Distinct users active at any time in the period.
    active: { users: number; byPlatform: CountRow[] };
    signIns: SignInCounts;
    messages: MessageCounts;
    reports: { created: number; byReason: CountRow[] };
    blocks: { created: number };
    moderation: { actions: number; byAction: CountRow[] };
    contentBlocked: { total: number; bySurface: CountRow[] };
}

const SIGN_IN_EVENT_NAMES = [
    SIGN_IN_SUCCEEDED,
    SIGN_IN_FAILED,
    'client.sign_in.started',
    'client.sign_in.cancelled',
    'client.sign_in.failed',
];
const SIGN_IN_FAILURE_NAMES = [SIGN_IN_FAILED, 'client.sign_in.failed'];

export function toCountRows(rows: Array<{ _id: unknown; count: number }>): CountRow[] {
    return rows
        .map((row) => ({ key: row._id === null || row._id === undefined ? 'unknown' : String(row._id), count: row.count }))
        .sort((a, b) => b.count - a.count);
}

function toBreakdownRows(
    rows: Array<{ _id: { name: string; key: string | null }; count: number }>
): SignInBreakdownRow[] {
    const byKey = new Map<string, SignInBreakdownRow>();
    for (const row of rows) {
        const key = row._id.key || 'unknown';
        const entry = byKey.get(key) ?? { key, succeeded: 0, failed: 0 };
        if (row._id.name === SIGN_IN_SUCCEEDED) {
            entry.succeeded += row.count;
        } else {
            entry.failed += row.count;
        }
        byKey.set(key, entry);
    }
    return [...byKey.values()].sort((a, b) => (b.succeeded + b.failed) - (a.succeeded + a.failed));
}

/**
 * Counts for [from, to): sign-ins (per attempt and per install), new users,
 * active users, messages per city room, reports, blocks, moderator actions and
 * content-filter rejections.
 */
export async function countPeriod(input: { from: Date; to: Date; cityLimit: number }): Promise<PeriodCounts> {
    const range = { $gte: input.from, $lt: input.to };
    const serverSignIns = { source: 'server', name: { $in: [SIGN_IN_SUCCEEDED, SIGN_IN_FAILED] }, occurredAt: range };

    const [
        signInsByMethod,
        signInsByPlatform,
        newAccounts,
        serverFailureReasons,
        clientSignIns,
        clientFailureReasons,
        installs,
        openedSignedOut,
        attemptsWithoutInstallId,
        newUsers,
        activeUsers,
        activeByPlatform,
        messagesByRoom,
        reportsCreated,
        reportReasons,
        blocksCreated,
        moderationActions,
        contentBlocked,
    ] = await Promise.all([
        AnalyticsEvent.aggregate<{ _id: { name: string; key: string | null }; count: number }>([
            { $match: serverSignIns },
            { $group: { _id: { name: '$name', key: '$props.method' }, count: { $sum: 1 } } },
        ]),
        AnalyticsEvent.aggregate<{ _id: { name: string; key: string | null }; count: number }>([
            { $match: serverSignIns },
            { $group: { _id: { name: '$name', key: '$platform' }, count: { $sum: 1 } } },
        ]),
        AnalyticsEvent.countDocuments({ source: 'server', name: SIGN_IN_SUCCEEDED, occurredAt: range, 'props.isNewUser': true }),
        AnalyticsEvent.aggregate<{ _id: string | null; count: number }>([
            { $match: { source: 'server', name: SIGN_IN_FAILED, occurredAt: range } },
            { $group: { _id: '$props.reason', count: { $sum: 1 } } },
        ]),
        AnalyticsEvent.aggregate<{ _id: string; count: number }>([
            { $match: { source: 'client', name: /^client\.sign_in\./, occurredAt: range } },
            { $group: { _id: '$name', count: { $sum: 1 } } },
        ]),
        AnalyticsEvent.aggregate<{ _id: string | null; count: number }>([
            { $match: { source: 'client', name: 'client.sign_in.failed', occurredAt: range } },
            { $group: { _id: '$props.reason', count: { $sum: 1 } } },
        ]),
        AnalyticsEvent.aggregate<{ tried: number; signedIn: number; neverSignedInAfterError: number }>([
            { $match: { name: { $in: SIGN_IN_EVENT_NAMES }, occurredAt: range, installId: { $type: 'string' } } },
            {
                $group: {
                    _id: '$installId',
                    signedIn: { $max: { $cond: [{ $eq: ['$name', SIGN_IN_SUCCEEDED] }, 1, 0] } },
                    sawError: { $max: { $cond: [{ $in: ['$name', SIGN_IN_FAILURE_NAMES] }, 1, 0] } },
                },
            },
            {
                $group: {
                    _id: null,
                    tried: { $sum: 1 },
                    signedIn: { $sum: '$signedIn' },
                    neverSignedInAfterError: {
                        $sum: { $cond: [{ $and: [{ $eq: ['$signedIn', 0] }, { $eq: ['$sawError', 1] }] }, 1, 0] },
                    },
                },
            },
        ]),
        AnalyticsEvent.aggregate<{ installs: number }>([
            {
                $match: {
                    name: 'client.app.opened',
                    occurredAt: range,
                    installId: { $type: 'string' },
                    userId: { $exists: false },
                },
            },
            { $group: { _id: '$installId' } },
            { $count: 'installs' },
        ]),
        AnalyticsEvent.countDocuments({ ...serverSignIns, installId: { $exists: false } }),
        User.countDocuments({ createdAt: range }),
        countActiveUsers(input.from, input.to),
        countActiveUsersByPlatform(input.from, input.to),
        Message.aggregate<{ _id: mongoose.Types.ObjectId; count: number; room?: { name?: string; type?: string; cityKey?: string } }>([
            { $match: { createdAt: range } },
            { $group: { _id: '$roomId', count: { $sum: 1 } } },
            {
                $lookup: {
                    from: Room.collection.name,
                    localField: '_id',
                    foreignField: '_id',
                    as: 'room',
                    pipeline: [{ $project: { name: 1, type: 1, cityKey: 1 } }],
                },
            },
            { $set: { room: { $first: '$room' } } },
        ]),
        Report.countDocuments({ createdAt: range }),
        Report.aggregate<{ _id: string; count: number }>([
            { $match: { createdAt: range } },
            { $group: { _id: '$reason', count: { $sum: 1 } } },
        ]),
        UserBlock.countDocuments({ blockedAt: range }),
        ModerationAction.aggregate<{ _id: string; count: number }>([
            { $match: { createdAt: range } },
            { $group: { _id: '$action', count: { $sum: 1 } } },
        ]),
        AnalyticsEvent.aggregate<{ _id: string | null; count: number }>([
            { $match: { name: CONTENT_BLOCKED, occurredAt: range } },
            { $group: { _id: '$props.surface', count: { $sum: 1 } } },
        ]),
    ]);

    const byMethod = toBreakdownRows(signInsByMethod);
    const clientCount = (name: string): number => clientSignIns.find((row) => row._id === name)?.count ?? 0;
    const installTotals = installs[0] ?? { tried: 0, signedIn: 0, neverSignedInAfterError: 0 };

    // Messages: public rooms are the city channels; private rooms are DMs.
    let inCityRooms = 0;
    let inDirectMessages = 0;
    const byCity: CityMessagesRow[] = [];
    for (const row of messagesByRoom) {
        if (row.room?.type === 'private') {
            inDirectMessages += row.count;
            continue;
        }
        inCityRooms += row.count;
        byCity.push({
            roomId: row._id.toString(),
            name: row.room?.name || '(deleted room)',
            cityKey: row.room?.cityKey || null,
            messages: row.count,
        });
    }
    byCity.sort((a, b) => b.messages - a.messages);

    const blockedBySurface = toCountRows(contentBlocked);

    return {
        users: { new: newUsers },
        active: { users: activeUsers, byPlatform: toCountRows(activeByPlatform) },
        signIns: {
            succeeded: byMethod.reduce((sum, row) => sum + row.succeeded, 0),
            failed: byMethod.reduce((sum, row) => sum + row.failed, 0),
            newAccounts,
            byMethod: byMethod.map((row) => ({ method: row.key, succeeded: row.succeeded, failed: row.failed })),
            byPlatform: toBreakdownRows(signInsByPlatform)
                .map((row) => ({ platform: row.key, succeeded: row.succeeded, failed: row.failed })),
            failureReasons: toCountRows(serverFailureReasons),
            client: {
                started: clientCount('client.sign_in.started'),
                cancelled: clientCount('client.sign_in.cancelled'),
                failed: clientCount('client.sign_in.failed'),
                failureReasons: toCountRows(clientFailureReasons),
            },
            installs: {
                openedSignedOut: openedSignedOut[0]?.installs ?? 0,
                tried: installTotals.tried,
                signedIn: installTotals.signedIn,
                neverSignedIn: installTotals.tried - installTotals.signedIn,
                neverSignedInAfterError: installTotals.neverSignedInAfterError,
            },
            attemptsWithoutInstallId,
        },
        messages: {
            total: inCityRooms + inDirectMessages,
            inCityRooms,
            inDirectMessages,
            byCity: byCity.slice(0, input.cityLimit),
        },
        reports: { created: reportsCreated, byReason: toCountRows(reportReasons) },
        blocks: { created: blocksCreated },
        moderation: {
            actions: moderationActions.reduce((sum, row) => sum + row.count, 0),
            byAction: toCountRows(moderationActions),
        },
        contentBlocked: {
            total: blockedBySurface.reduce((sum, row) => sum + row.count, 0),
            bySurface: blockedBySurface,
        },
    };
}

// ============================================================
// Admin summary
// ============================================================

const DEFAULT_SUMMARY_DAYS = 7;
const MAX_SUMMARY_DAYS = 90;
const MAX_CITY_ROWS = 50;

interface DailyRow {
    day: number;
    newUsers: number;
    activeUsers: number;
    signInsSucceeded: number;
    signInsFailed: number;
    messages: number;
    reports: number;
    blocks: number;
}

export interface AnalyticsSummary extends Omit<PeriodCounts, 'users' | 'active' | 'reports'> {
    from: number;
    to: number;
    days: number;
    users: {
        total: number;
        new: number;
    };
    active: {
        // Distinct users active at any time in the period.
        inPeriod: number;
        today: number;
        last7Days: number;
        last30Days: number;
        byPlatform: CountRow[];
    };
    reports: {
        created: number;
        openNow: number;
        byReason: CountRow[];
    };
    daily: DailyRow[];
}

function parseDays(value: unknown): number {
    if (value === undefined || value === null || value === '') {
        return DEFAULT_SUMMARY_DAYS;
    }
    const days = Number(value);
    if (!Number.isInteger(days) || days < 1 || days > MAX_SUMMARY_DAYS) {
        throw new ValidationError(`days must be a whole number from 1 to ${MAX_SUMMARY_DAYS}.`);
    }
    return days;
}

function countByDay(
    model: { aggregate: typeof Message.aggregate },
    dateField: string,
    match: Record<string, unknown>
): Promise<Array<{ _id: Date; count: number }>> {
    return model.aggregate([
        { $match: match },
        { $group: { _id: { $dateTrunc: { date: `$${dateField}`, unit: 'day', timezone: 'UTC' } }, count: { $sum: 1 } } },
    ]);
}

/**
 * Counts for the last `days` days (UTC, today included, so live): everything
 * in countPeriod, plus total users, open reports, active users today / in the
 * last 7 and 30 days, and a daily series for charts. For finished days that
 * never change, see the daily rollup (GET /v1/admin/analytics/daily).
 */
export async function getAnalyticsSummary(input: { days?: unknown }): Promise<AnalyticsSummary> {
    const days = parseDays(input.days);
    const to = new Date();
    const today = startOfUtcDay(to);
    const tomorrow = addDays(today, 1);
    const from = addDays(today, -(days - 1));
    const inRange = { $gte: from };

    const [
        counts,
        totalUsers,
        openReports,
        activeToday,
        activeLast7Days,
        activeLast30Days,
        dailyUsers,
        dailyActive,
        dailySignIns,
        dailyMessages,
        dailyReports,
        dailyBlocks,
    ] = await Promise.all([
        countPeriod({ from, to: tomorrow, cityLimit: MAX_CITY_ROWS }),
        User.estimatedDocumentCount(),
        Report.countDocuments({ status: 'open' }),
        countActiveUsers(today, tomorrow),
        countActiveUsers(addDays(today, -6), tomorrow),
        countActiveUsers(addDays(today, -29), tomorrow),
        countByDay(User, 'createdAt', { createdAt: inRange }),
        countActiveUsersPerDay(from, tomorrow),
        AnalyticsEvent.aggregate<{ _id: { day: Date; name: string }; count: number }>([
            { $match: { source: 'server', name: { $in: [SIGN_IN_SUCCEEDED, SIGN_IN_FAILED] }, occurredAt: inRange } },
            {
                $group: {
                    _id: { day: { $dateTrunc: { date: '$occurredAt', unit: 'day', timezone: 'UTC' } }, name: '$name' },
                    count: { $sum: 1 },
                },
            },
        ]),
        countByDay(Message, 'createdAt', { createdAt: inRange }),
        countByDay(Report, 'createdAt', { createdAt: inRange }),
        countByDay(UserBlock, 'blockedAt', { blockedAt: inRange }),
    ]);

    // Daily series, one row per UTC day in range (zeros included).
    const daily: DailyRow[] = [];
    const dailyIndex = new Map<number, DailyRow>();
    for (let day = from.getTime(); day <= to.getTime(); day += DAY_MS) {
        const row = {
            day,
            newUsers: 0,
            activeUsers: 0,
            signInsSucceeded: 0,
            signInsFailed: 0,
            messages: 0,
            reports: 0,
            blocks: 0,
        };
        daily.push(row);
        dailyIndex.set(day, row);
    }
    const addDaily = (date: Date, field: keyof Omit<DailyRow, 'day'>, count: number): void => {
        const row = dailyIndex.get(new Date(date).getTime());
        if (row) {
            row[field] += count;
        }
    };
    dailyUsers.forEach((row) => addDaily(row._id, 'newUsers', row.count));
    dailyActive.forEach((row) => addDaily(row._id, 'activeUsers', row.count));
    dailyMessages.forEach((row) => addDaily(row._id, 'messages', row.count));
    dailyReports.forEach((row) => addDaily(row._id, 'reports', row.count));
    dailyBlocks.forEach((row) => addDaily(row._id, 'blocks', row.count));
    dailySignIns.forEach((row) => addDaily(
        row._id.day,
        row._id.name === SIGN_IN_SUCCEEDED ? 'signInsSucceeded' : 'signInsFailed',
        row.count
    ));

    return {
        from: from.getTime(),
        to: to.getTime(),
        days,
        users: {
            total: totalUsers,
            new: counts.users.new,
        },
        active: {
            inPeriod: counts.active.users,
            today: activeToday,
            last7Days: activeLast7Days,
            last30Days: activeLast30Days,
            byPlatform: counts.active.byPlatform,
        },
        signIns: counts.signIns,
        messages: counts.messages,
        reports: {
            created: counts.reports.created,
            openNow: openReports,
            byReason: counts.reports.byReason,
        },
        blocks: counts.blocks,
        moderation: counts.moderation,
        contentBlocked: counts.contentBlocked,
        daily,
    };
}
