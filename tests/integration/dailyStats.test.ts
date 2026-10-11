import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../helpers/testDb.js';
import { getTestAgent, resetTestApp } from '../helpers/testApp.js';
import { stopRateLimiterCleanupForTests } from '../../middleware/rateLimiter.js';
import { config } from '../../config/index.js';
import { AnalyticsEvent } from '../../models/AnalyticsEvent.js';
import { DailyStat } from '../../models/DailyStat.js';
import { Message } from '../../models/Message.js';
import { ModerationAction } from '../../models/ModerationAction.js';
import { Report } from '../../models/Report.js';
import { Room } from '../../models/Room.js';
import { User } from '../../models/User.js';
import { UserActivity } from '../../models/UserActivity.js';
import { UserBlock } from '../../models/UserBlock.js';
import { ensureDailyStats, type DailyStatData } from '../../services/dailyStatsService.js';
import { sendDailyDigestIfDue } from '../../services/dailyDigestService.js';
import { addDays, startOfUtcDay } from '../../utils/utcDay.js';

const ADMIN_KEY = 'k'.repeat(40);
const HOUR_MS = 60 * 60 * 1000;

const today = startOfUtcDay(new Date());
const yesterday = addDays(today, -1);
// Noon of a day: comfortably inside it.
const noon = (day: Date): Date => new Date(day.getTime() + 12 * HOUR_MS);

type StoredStat = DailyStatData & { day: Date; digestSentAt: Date | null; digestAttempts: number };

async function statFor(day: Date): Promise<StoredStat> {
    const stat = await DailyStat.findOne({ day }).lean<StoredStat | null>();
    assert.ok(stat, `expected totals for ${day.toISOString()}`);
    return stat;
}

// A week of history ending yesterday. The first account signed up 7 days
// before yesterday; activity tracking started 3 days before yesterday.
async function seedHistory(): Promise<{ belgrade: mongoose.Types.ObjectId }> {
    const signedUpWeekBefore = await User.create({ username: 'weekold', createdAt: noon(addDays(yesterday, -7)) });
    const signedUpDayBefore = await User.create({ username: 'dayold', createdAt: noon(addDays(yesterday, -1)) });
    const signedUpYesterday = await User.create({ username: 'newbie', createdAt: noon(yesterday) });

    await UserActivity.create([
        { userId: signedUpDayBefore._id, day: addDays(yesterday, -3), platform: 'ios' },
        { userId: signedUpDayBefore._id, day: yesterday, platform: 'ios' },
        { userId: signedUpYesterday._id, day: yesterday, platform: 'android' },
    ]);

    const belgrade = await Room.create({ name: 'Belgrade', type: 'public', cityKey: 'belgrade-rs' });
    const dm = await Room.create({
        name: 'dm',
        type: 'private',
        participants: [signedUpDayBefore._id, signedUpYesterday._id],
    });
    const message = (roomId: mongoose.Types.ObjectId, createdAt: Date) => ({
        roomId,
        userId: signedUpDayBefore._id,
        text: 'hi',
        parentMessageId: null,
        replyCount: 0,
        deletedAt: null,
        createdAt,
        updatedAt: createdAt,
    });
    await Message.collection.insertMany([
        message(belgrade._id, noon(yesterday)),
        message(belgrade._id, noon(yesterday)),
        message(dm._id, noon(yesterday)),
        message(belgrade._id, new Date()),
    ]);

    await Report.collection.insertOne({
        reporterUserId: signedUpDayBefore._id,
        reportedUserId: signedUpWeekBefore._id,
        reason: 'spam',
        status: 'open',
        createdAt: noon(yesterday),
        updatedAt: noon(yesterday),
    });
    await ModerationAction.collection.insertOne({
        actorLabel: 'admin:env-key',
        action: 'user_banned',
        targetType: 'user',
        targetId: signedUpWeekBefore._id,
        createdAt: noon(yesterday),
        updatedAt: noon(yesterday),
    });
    await UserBlock.create({
        blockerUserId: signedUpDayBefore._id,
        blockedUserId: signedUpWeekBefore._id,
        blockedAt: noon(yesterday),
    });

    const event = (name: string, extra: Record<string, unknown>) => ({
        name,
        occurredAt: noon(yesterday),
        retainUntil: addDays(today, 90),
        ...extra,
    });
    await AnalyticsEvent.create([
        event('sign_in.succeeded', {
            source: 'server',
            userId: signedUpYesterday._id,
            installId: 'install-in',
            platform: 'android',
            props: { method: 'google', isNewUser: true },
        }),
        event('client.sign_in.started', { source: 'client', installId: 'install-out', props: { provider: 'apple' } }),
        event('sign_in.failed', {
            source: 'server',
            installId: 'install-out',
            platform: 'ios',
            props: { method: 'apple', reason: 'UNAUTHORIZED', detail: 'x' },
        }),
        event('moderation.content_blocked', {
            source: 'server',
            userId: signedUpDayBefore._id,
            props: { surface: 'message', kind: 'text' },
        }),
    ]);

    return { belgrade: belgrade._id };
}

describe('Daily stats', () => {
    const originalKey = config.admin.apiKey;

    before(async () => {
        await connectTestDb();
        config.admin.apiKey = ADMIN_KEY;
    });

    after(async () => {
        config.admin.apiKey = originalKey;
        stopRateLimiterCleanupForTests();
        await disconnectTestDb();
    });

    beforeEach(async () => {
        await clearTestDb();
        resetTestApp();
    });

    describe('ensureDailyStats', () => {
        it('writes each finished day since the first account, once', async () => {
            const { belgrade } = await seedHistory();

            assert.equal(await ensureDailyStats(new Date()), 8);
            assert.equal(await ensureDailyStats(new Date()), 0);
            assert.equal(await DailyStat.countDocuments({ day: today }), 0);

            const stat = await statFor(yesterday);
            assert.deepEqual(stat.users, { new: 1, total: 3 });
            assert.equal(stat.active!.users, 2);
            assert.equal(stat.active!.last7Days, 2);
            assert.equal(stat.active!.last30Days, 2);
            assert.deepEqual(stat.retention, {
                day1: { signups: 1, returned: 1 },
                day7: { signups: 1, returned: 0 },
                day30: { signups: 0, returned: 0 },
            });

            assert.equal(stat.messages.total, 3);
            assert.equal(stat.messages.inCityRooms, 2);
            assert.equal(stat.messages.inDirectMessages, 1);
            assert.deepEqual(stat.messages.byCity, [
                { roomId: belgrade.toString(), name: 'Belgrade', cityKey: 'belgrade-rs', messages: 2 },
            ]);

            assert.equal(stat.signIns.succeeded, 1);
            assert.equal(stat.signIns.failed, 1);
            assert.equal(stat.signIns.newAccounts, 1);
            assert.deepEqual(stat.signIns.installs, {
                openedSignedOut: 0,
                tried: 2,
                signedIn: 1,
                neverSignedIn: 1,
                neverSignedInAfterError: 1,
            });
            assert.deepEqual(stat.reports, { created: 1, byReason: [{ key: 'spam', count: 1 }] });
            assert.deepEqual(stat.blocks, { created: 1 });
            assert.deepEqual(stat.moderation, { actions: 1, byAction: [{ key: 'user_banned', count: 1 }] });
            assert.deepEqual(stat.contentBlocked, { total: 1, bySurface: [{ key: 'message', count: 1 }] });
        });

        it("leaves activity empty for days before tracking started, and doesn't rewrite history", async () => {
            await seedHistory();
            await ensureDailyStats(new Date());

            const beforeTracking = await statFor(addDays(yesterday, -5));
            assert.equal(beforeTracking.active, null);
            assert.equal(beforeTracking.retention, null);
            assert.equal((await statFor(addDays(yesterday, -3))).active!.users, 1);

            // An account deleted later takes its messages with it; the
            // written day keeps its count.
            await Message.deleteMany({});
            await ensureDailyStats(new Date());
            assert.equal((await statFor(yesterday)).messages.total, 3);
        });

        it('writes nothing before the first account', async () => {
            assert.equal(await ensureDailyStats(new Date()), 0);
        });
    });

    describe('GET /v1/admin/analytics/daily', () => {
        it('returns the written days, oldest first, with times in ms', async () => {
            await seedHistory();
            await ensureDailyStats(new Date());

            const res = await getTestAgent()
                .get('/v1/admin/analytics/daily?days=3')
                .set({ 'x-admin-key': ADMIN_KEY })
                .expect(200);

            assert.deepEqual(
                res.body.days.map((day: { day: number }) => day.day),
                [addDays(today, -3).getTime(), addDays(today, -2).getTime(), yesterday.getTime()]
            );
            assert.equal(typeof res.body.days[2].computedAt, 'number');
            assert.equal(res.body.days[2].messages.total, 3);
        });

        it('requires the admin key and a sane window', async () => {
            await getTestAgent().get('/v1/admin/analytics/daily').expect(403);
            await getTestAgent()
                .get('/v1/admin/analytics/daily?days=0')
                .set({ 'x-admin-key': ADMIN_KEY })
                .expect(400);
        });
    });

    describe('sendDailyDigestIfDue', () => {
        const digestTime = new Date(today.getTime() + config.alerts.digestHourUtc * HOUR_MS + 5 * 60 * 1000);

        it('sends yesterday once, after the digest hour', async () => {
            await seedHistory();
            await ensureDailyStats(new Date());
            const sent: string[] = [];
            const send = async (html: string): Promise<boolean> => {
                sent.push(html);
                return true;
            };

            if (config.alerts.digestHourUtc > 0) {
                assert.equal(await sendDailyDigestIfDue(new Date(digestTime.getTime() - HOUR_MS), send), false);
            }
            assert.equal(await sendDailyDigestIfDue(digestTime, send), true);
            assert.equal(await sendDailyDigestIfDue(digestTime, send), false);

            assert.equal(sent.length, 1);
            assert.match(sent[0], /Bleya daily/);
            assert.match(sent[0], /Users: <b>\+1<\/b> new · 3 total/);
            assert.match(sent[0], /Belgrade 2/);
            assert.match(sent[0], /1 open now/);
            assert.ok((await statFor(yesterday)).digestSentAt);
        });

        it('retries a failed send, at most three times', async () => {
            await seedHistory();
            await ensureDailyStats(new Date());
            let attempts = 0;
            const failingSend = async (): Promise<boolean> => {
                attempts += 1;
                return false;
            };

            for (let run = 0; run < 5; run += 1) {
                assert.equal(await sendDailyDigestIfDue(digestTime, failingSend), false);
            }
            assert.equal(attempts, 3);
            const stat = await statFor(yesterday);
            assert.equal(stat.digestSentAt, null);
            assert.equal(stat.digestAttempts, 3);
        });

        it('does nothing before the day has totals', async () => {
            let called = false;
            assert.equal(await sendDailyDigestIfDue(digestTime, async () => {
                called = true;
                return true;
            }), false);
            assert.equal(called, false);
        });
    });
});
