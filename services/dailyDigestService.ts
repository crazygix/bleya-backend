import { DailyStat } from '../models/DailyStat.js';
import { Report } from '../models/Report.js';
import { config } from '../config/index.js';
import { addDays, startOfUtcDay } from '../utils/utcDay.js';
import { escapeTelegramHtml, sendTelegramMessage } from '../utils/telegram.js';
import logger from '../utils/logger.js';
import type { CountRow } from './analyticsService.js';
import type { DailyStatData } from './dailyStatsService.js';

// A morning Telegram message with yesterday's numbers (the UTC day), from the
// day's DailyStat. Sent once per day, at config.alerts.digestHourUtc or later.

const MAX_DIGEST_ATTEMPTS = 3;
const TOP_CITIES = 5;
const TOP_ROWS = 4;

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const number = (value: number): string => value.toLocaleString('en-US');

// "Sat 10 Oct 2026", the same on every Node build (locale data varies).
function formatDay(day: Date): string {
    return `${WEEKDAYS[day.getUTCDay()]} ${day.getUTCDate()} ${MONTHS[day.getUTCMonth()]} ${day.getUTCFullYear()}`;
}

function percent(part: number, whole: number): string {
    return whole > 0 ? `${Math.round((part / whole) * 100)}%` : '–';
}

// "spam 2 · harassment 1", the largest first.
function rows(list: CountRow[], limit = TOP_ROWS): string {
    const shown = list.slice(0, limit).map((row) => `${escapeTelegramHtml(row.key)} ${number(row.count)}`);
    const rest = list.slice(limit).reduce((sum, row) => sum + row.count, 0);
    return rest > 0 ? [...shown, `other ${number(rest)}`].join(' · ') : shown.join(' · ');
}

function returning(label: string, value: { signups: number; returned: number }): string | null {
    return value.signups > 0 ? `${label} ${value.returned}/${value.signups} (${percent(value.returned, value.signups)})` : null;
}

/** The digest for one day, as Telegram HTML. */
export function formatDailyDigest(day: Date, stat: DailyStatData, live: { openReports: number }): string {
    const lines = [`📊 <b>Bleya daily</b> · ${formatDay(day)} (UTC)`, ''];

    lines.push(`👥 Users: <b>+${number(stat.users.new)}</b> new · ${number(stat.users.total)} total`);

    if (stat.active) {
        lines.push(
            `🟢 Active: <b>${number(stat.active.users)}</b> that day · ${number(stat.active.last7Days)} in 7 days`
            + ` · ${number(stat.active.last30Days)} in 30 days`
        );
    }
    if (stat.retention) {
        const back = [
            returning('day 1', stat.retention.day1),
            returning('day 7', stat.retention.day7),
            returning('day 30', stat.retention.day30),
        ].filter((part): part is string => part !== null);
        if (back.length > 0) {
            lines.push(`↩️ New users who came back: ${back.join(' · ')}`);
        }
    }

    const signIns = stat.signIns;
    lines.push(
        `🔑 Sign-ins: <b>${number(signIns.succeeded)}</b> succeeded · <b>${number(signIns.failed)}</b> failed`
        + ` (${percent(signIns.succeeded, signIns.succeeded + signIns.failed)} success)`
    );
    if (signIns.failureReasons.length > 0) {
        lines.push(`   Why they failed: ${rows(signIns.failureReasons)}`);
    }
    const client = signIns.client;
    if (client.started + client.cancelled + client.failed > 0) {
        lines.push(
            `   In the app: ${number(client.started)} started · ${number(client.cancelled)} cancelled`
            + ` · ${number(client.failed)} failed before reaching us`
        );
        if (client.failureReasons.length > 0) {
            lines.push(`   App errors: ${rows(client.failureReasons)}`);
        }
    }
    const installs = signIns.installs;
    if (installs.openedSignedOut > 0) {
        lines.push(`   Signed-out installs that opened the app: ${number(installs.openedSignedOut)}`);
    }
    if (installs.tried > 0) {
        lines.push(
            `   People: ${number(installs.signedIn)} of ${number(installs.tried)} got in`
            + ` · ${number(installs.neverSignedIn)} didn't`
            + ` (${number(installs.neverSignedInAfterError)} after an error)`
        );
    }

    const messages = stat.messages;
    lines.push(
        `💬 Messages: <b>${number(messages.total)}</b> · ${number(messages.inCityRooms)} in cities`
        + ` · ${number(messages.inDirectMessages)} in DMs`
    );
    if (messages.byCity.length > 0) {
        const cities = messages.byCity
            .slice(0, TOP_CITIES)
            .map((city) => `${escapeTelegramHtml(city.name)} ${number(city.messages)}`);
        const more = messages.byCity.length > TOP_CITIES ? ` · +${messages.byCity.length - TOP_CITIES} more cities` : '';
        lines.push(`   ${cities.join(' · ')}${more}`);
    }

    const reasons = stat.reports.byReason.length > 0 ? ` (${rows(stat.reports.byReason)})` : '';
    lines.push(`🚩 Reports: <b>${number(stat.reports.created)}</b> new${reasons} · ${number(live.openReports)} open now`);
    lines.push(`🚫 Blocks: ${number(stat.blocks.created)}`);
    if (stat.moderation.actions > 0) {
        lines.push(`🔨 Moderator actions: ${number(stat.moderation.actions)} (${rows(stat.moderation.byAction)})`);
    }
    if (stat.contentBlocked.total > 0) {
        lines.push(`🤖 Filter blocked: ${number(stat.contentBlocked.total)} (${rows(stat.contentBlocked.bySurface)})`);
    }

    return lines.join('\n');
}

async function sendToDigestChat(html: string): Promise<boolean> {
    return (await sendTelegramMessage(config.alerts.digestChatId, html, { html: true })) === 200;
}

export function isDailyDigestConfigured(): boolean {
    return config.alerts.sendDigest
        && config.alerts.telegramBotToken.length > 0
        && config.alerts.digestChatId.length > 0;
}

/**
 * Sends yesterday's digest if it is due: digestHourUtc has passed, the day's
 * totals are written and the digest hasn't been sent. The day's row is claimed
 * before sending, so it goes out once even if this runs twice; a failed send
 * is retried on later runs, up to MAX_DIGEST_ATTEMPTS times.
 */
export async function sendDailyDigestIfDue(
    now: Date = new Date(),
    send: (html: string) => Promise<boolean> = sendToDigestChat
): Promise<boolean> {
    if (now.getUTCHours() < config.alerts.digestHourUtc) {
        return false;
    }

    const day = addDays(startOfUtcDay(now), -1);
    const stat = await DailyStat.findOneAndUpdate(
        { day, digestSentAt: null, digestAttempts: { $lt: MAX_DIGEST_ATTEMPTS } },
        { $set: { digestSentAt: now }, $inc: { digestAttempts: 1 } },
        { new: true }
    ).lean<(DailyStatData & { _id: unknown; day: Date }) | null>();
    if (!stat) {
        return false;
    }

    const openReports = await Report.countDocuments({ status: 'open' });
    const sent = await send(formatDailyDigest(day, stat, { openReports }));
    if (!sent) {
        await DailyStat.updateOne({ _id: stat._id }, { $set: { digestSentAt: null } });
        logger.warn('analytics.digest.send_failed', { day: day.toISOString().slice(0, 10) });
    }
    return sent;
}
