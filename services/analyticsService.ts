import mongoose from 'mongoose';
import { AnalyticsEvent, AnalyticsEventSource } from '../models/AnalyticsEvent.js';
import { User } from '../models/User.js';
import { Message } from '../models/Message.js';
import { Room } from '../models/Room.js';
import { Report } from '../models/Report.js';
import { ModerationAction } from '../models/ModerationAction.js';
import { config } from '../config/index.js';
import { AppError, ErrorCode, ValidationError } from '../utils/errors.js';
import { DAY_MS, retainUntilAfter } from '../utils/retention.js';
import logger from '../utils/logger.js';

// ============================================================
// Recording
// ============================================================

export const SIGN_IN_SUCCEEDED = 'sign_in.succeeded';
export const SIGN_IN_FAILED = 'sign_in.failed';

export type SignInMethod = 'google' | 'apple' | 'passkey' | 'unknown';

interface TrackEventInput {
    name: string;
    source?: AnalyticsEventSource;
    userId?: string;
    platform?: string;
    props?: Record<string, unknown>;
}

// Best-effort and fire-and-forget: analytics must never fail or slow down the
// request it describes.
export function trackEvent(input: TrackEventInput): void {
    const now = new Date();
    void AnalyticsEvent.create({
        name: input.name,
        source: input.source ?? 'server',
        userId: input.userId && mongoose.Types.ObjectId.isValid(input.userId)
            ? new mongoose.Types.ObjectId(input.userId)
            : undefined,
        platform: input.platform,
        props: input.props,
        occurredAt: now,
        retainUntil: retainUntilAfter(config.analytics.retentionDays, now),
    }).catch((error: unknown) => {
        logger.error('analytics.track_failed', {
            name: input.name,
            error: error instanceof Error ? error.message : 'unknown',
        });
    });
}

const PLATFORM_PATTERN = /^(ios|android|web)$/;

function normalizePlatform(value: unknown): string | undefined {
    return typeof value === 'string' && PLATFORM_PATTERN.test(value) ? value : undefined;
}

export function trackSignInSucceeded(input: {
    method: SignInMethod;
    platform?: unknown;
    userId: string;
    isNewUser: boolean;
}): void {
    trackEvent({
        name: SIGN_IN_SUCCEEDED,
        userId: input.userId,
        platform: normalizePlatform(input.platform),
        props: { method: input.method, isNewUser: input.isNewUser },
    });
}

// `reason` is the API error code the app received (e.g. USER_BLOCKED,
// UNAUTHORIZED); `detail` is the server-written error message, never input.
export function trackSignInFailed(input: {
    method: SignInMethod;
    platform?: unknown;
    error: unknown;
}): void {
    const isKnown = input.error instanceof AppError;
    trackEvent({
        name: SIGN_IN_FAILED,
        platform: normalizePlatform(input.platform),
        props: {
            method: input.method,
            reason: isKnown ? (input.error as AppError).code : ErrorCode.INTERNAL_ERROR,
            detail: isKnown ? (input.error as AppError).message.slice(0, 200) : '',
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
const INSTALL_ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;
const APP_VERSION_PATTERN = /^[\w.+-]{1,32}$/;
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

function matchOptional(value: unknown, pattern: RegExp): string | undefined {
    return typeof value === 'string' && pattern.test(value) ? value : undefined;
}

function pickClientProps(value: unknown): Record<string, string> | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return undefined;
    }

    const props: Record<string, string> = {};
    for (const [key, pattern] of Object.entries(CLIENT_PROP_PATTERNS)) {
        const prop = matchOptional((value as Record<string, unknown>)[key], pattern);
        if (prop) {
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
 * `userId` is set when the request carried a valid access token.
 */
export async function recordClientEvents(
    userId: string | undefined,
    input: RecordClientEventsInput
): Promise<RecordClientEventsResult> {
    if (!Array.isArray(input.events)) {
        throw new ValidationError('events must be an array.');
    }
    if (input.events.length > MAX_CLIENT_EVENTS_PER_REQUEST) {
        throw new ValidationError(`Send at most ${MAX_CLIENT_EVENTS_PER_REQUEST} events at once.`);
    }

    const now = new Date();
    const installId = matchOptional(input.installId, INSTALL_ID_PATTERN);
    const platform = normalizePlatform(input.platform);
    const appVersion = matchOptional(input.appVersion, APP_VERSION_PATTERN);

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
// Admin summary
// ============================================================

const DEFAULT_SUMMARY_DAYS = 7;
const MAX_SUMMARY_DAYS = 90;
const MAX_CITY_ROWS = 50;

interface CountRow {
    key: string;
    count: number;
}

interface SignInMethodRow {
    method: string;
    succeeded: number;
    failed: number;
}

interface CityMessagesRow {
    roomId: string;
    name: string;
    cityKey: string | null;
    messages: number;
}

interface DailyRow {
    day: number;
    newUsers: number;
    signInsSucceeded: number;
    signInsFailed: number;
    messages: number;
    reports: number;
}

export interface AnalyticsSummary {
    from: number;
    to: number;
    days: number;
    users: {
        total: number;
        new: number;
    };
    signIns: {
        succeeded: number;
        failed: number;
        newAccounts: number;
        byMethod: SignInMethodRow[];
        failureReasons: CountRow[];
        // Reported by the app: attempts that never reached the backend.
        client: {
            started: number;
            cancelled: number;
            failed: number;
            failureReasons: CountRow[];
        };
    };
    messages: {
        total: number;
        inCityRooms: number;
        inDirectMessages: number;
        byCity: CityMessagesRow[];
    };
    reports: {
        created: number;
        openNow: number;
        byReason: CountRow[];
    };
    moderation: {
        actions: number;
        byAction: CountRow[];
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

function startOfUtcDay(date: Date): Date {
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function toCountRows(rows: Array<{ _id: unknown; count: number }>): CountRow[] {
    return rows
        .map((row) => ({ key: row._id === null || row._id === undefined ? 'unknown' : String(row._id), count: row.count }))
        .sort((a, b) => b.count - a.count);
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
 * Counts for the last `days` days (UTC, today included): sign-in outcomes, new
 * users, messages per city room, reports and moderation actions, plus a daily
 * series for charts.
 */
export async function getAnalyticsSummary(input: { days?: unknown }): Promise<AnalyticsSummary> {
    const days = parseDays(input.days);
    const to = new Date();
    const from = new Date(startOfUtcDay(to).getTime() - (days - 1) * DAY_MS);
    const inRange = { $gte: from };

    const [
        serverSignIns,
        serverFailureReasons,
        clientSignIns,
        clientFailureReasons,
        totalUsers,
        newUsers,
        messagesByRoom,
        reportsCreated,
        openReports,
        reportReasons,
        moderationActions,
        dailyUsers,
        dailySignIns,
        dailyMessages,
        dailyReports,
    ] = await Promise.all([
        AnalyticsEvent.aggregate<{ _id: { name: string; method: string | null }; count: number; newAccounts: number }>([
            { $match: { source: 'server', name: { $in: [SIGN_IN_SUCCEEDED, SIGN_IN_FAILED] }, occurredAt: inRange } },
            {
                $group: {
                    _id: { name: '$name', method: '$props.method' },
                    count: { $sum: 1 },
                    newAccounts: { $sum: { $cond: [{ $eq: ['$props.isNewUser', true] }, 1, 0] } },
                },
            },
        ]),
        AnalyticsEvent.aggregate<{ _id: string | null; count: number }>([
            { $match: { source: 'server', name: SIGN_IN_FAILED, occurredAt: inRange } },
            { $group: { _id: '$props.reason', count: { $sum: 1 } } },
        ]),
        AnalyticsEvent.aggregate<{ _id: string; count: number }>([
            { $match: { source: 'client', name: /^client\.sign_in\./, occurredAt: inRange } },
            { $group: { _id: '$name', count: { $sum: 1 } } },
        ]),
        AnalyticsEvent.aggregate<{ _id: string | null; count: number }>([
            { $match: { source: 'client', name: 'client.sign_in.failed', occurredAt: inRange } },
            { $group: { _id: '$props.reason', count: { $sum: 1 } } },
        ]),
        User.estimatedDocumentCount(),
        User.countDocuments({ createdAt: inRange }),
        Message.aggregate<{ _id: mongoose.Types.ObjectId; count: number; room?: { name?: string; type?: string; cityKey?: string } }>([
            { $match: { createdAt: inRange } },
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
        Report.countDocuments({ createdAt: inRange }),
        Report.countDocuments({ status: 'open' }),
        Report.aggregate<{ _id: string; count: number }>([
            { $match: { createdAt: inRange } },
            { $group: { _id: '$reason', count: { $sum: 1 } } },
        ]),
        ModerationAction.aggregate<{ _id: string; count: number }>([
            { $match: { createdAt: inRange } },
            { $group: { _id: '$action', count: { $sum: 1 } } },
        ]),
        countByDay(User, 'createdAt', { createdAt: inRange }),
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
    ]);

    // Sign-ins
    const methods = new Map<string, SignInMethodRow>();
    let succeeded = 0;
    let failed = 0;
    let newAccounts = 0;
    for (const row of serverSignIns) {
        const method = row._id.method || 'unknown';
        const entry = methods.get(method) ?? { method, succeeded: 0, failed: 0 };
        if (row._id.name === SIGN_IN_SUCCEEDED) {
            entry.succeeded += row.count;
            succeeded += row.count;
            newAccounts += row.newAccounts;
        } else {
            entry.failed += row.count;
            failed += row.count;
        }
        methods.set(method, entry);
    }
    const clientCount = (name: string): number => clientSignIns.find((row) => row._id === name)?.count ?? 0;

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

    // Daily series, one row per UTC day in range (zeros included).
    const daily: DailyRow[] = [];
    const dailyIndex = new Map<number, DailyRow>();
    for (let day = from.getTime(); day <= to.getTime(); day += DAY_MS) {
        const row = { day, newUsers: 0, signInsSucceeded: 0, signInsFailed: 0, messages: 0, reports: 0 };
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
    dailyMessages.forEach((row) => addDaily(row._id, 'messages', row.count));
    dailyReports.forEach((row) => addDaily(row._id, 'reports', row.count));
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
            new: newUsers,
        },
        signIns: {
            succeeded,
            failed,
            newAccounts,
            byMethod: [...methods.values()].sort((a, b) => (b.succeeded + b.failed) - (a.succeeded + a.failed)),
            failureReasons: toCountRows(serverFailureReasons),
            client: {
                started: clientCount('client.sign_in.started'),
                cancelled: clientCount('client.sign_in.cancelled'),
                failed: clientCount('client.sign_in.failed'),
                failureReasons: toCountRows(clientFailureReasons),
            },
        },
        messages: {
            total: inCityRooms + inDirectMessages,
            inCityRooms,
            inDirectMessages,
            byCity: byCity.slice(0, MAX_CITY_ROWS),
        },
        reports: {
            created: reportsCreated,
            openNow: openReports,
            byReason: toCountRows(reportReasons),
        },
        moderation: {
            actions: moderationActions.reduce((sum, row) => sum + row.count, 0),
            byAction: toCountRows(moderationActions),
        },
        daily,
    };
}
