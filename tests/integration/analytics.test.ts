import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../helpers/testDb.js';
import { getTestAgent, resetTestApp } from '../helpers/testApp.js';
import { createTestUser, authHeader, makeProviderTestToken } from '../helpers/auth.js';
import { stopRateLimiterCleanupForTests } from '../../middleware/rateLimiter.js';
import { config } from '../../config/index.js';
import { AnalyticsEvent } from '../../models/AnalyticsEvent.js';
import { Room } from '../../models/Room.js';
import { Message } from '../../models/Message.js';
import { Report } from '../../models/Report.js';
import { UserActivity } from '../../models/UserActivity.js';
import { resetActivityCacheForTests } from '../../services/activityService.js';
import { resetRateLimitedSignInsForTests, trackSignInRateLimited } from '../../services/analyticsService.js';
import { startOfUtcDay } from '../../utils/utcDay.js';

const ADMIN_KEY = 'k'.repeat(40);

interface StoredEvent {
    name: string;
    source: string;
    userId?: mongoose.Types.ObjectId;
    installId?: string;
    platform?: string;
    appVersion?: string;
    props?: Record<string, unknown>;
    occurredAt: Date;
    retainUntil?: Date;
}

// Server events are written fire-and-forget, after the response.
async function waitForEvents(filter: Record<string, unknown>, count: number): Promise<StoredEvent[]> {
    for (let attempt = 0; attempt < 50; attempt += 1) {
        const events = await AnalyticsEvent.find(filter).sort({ occurredAt: 1 }).lean<StoredEvent[]>();
        if (events.length >= count) {
            return events;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.fail(`expected ${count} events matching ${JSON.stringify(filter)}`);
}

function googleSignIn(sub: string) {
    return getTestAgent()
        .post('/v1/auth/provider-sign-in')
        .send({
            provider: 'google',
            platform: 'ios',
            idToken: makeProviderTestToken({ sub, email: `${sub}@example.com`, email_verified: true }),
        });
}

// What the app sends with every request.
function appHeaders(installId: string, platform = 'android'): Record<string, string> {
    return { 'X-App-Platform': platform, 'X-App-Version': '1.0.0+13', 'X-Install-Id': installId };
}

async function waitForActivity(userId: mongoose.Types.ObjectId): Promise<{ day: Date; platform?: string; appVersion?: string }> {
    for (let attempt = 0; attempt < 50; attempt += 1) {
        const activity = await UserActivity.findOne({ userId }).lean<{ day: Date; platform?: string; appVersion?: string } | null>();
        if (activity) {
            return activity;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.fail(`expected activity for ${userId.toString()}`);
}

describe('Analytics', () => {
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
        resetActivityCacheForTests();
        resetRateLimitedSignInsForTests();
    });

    describe('sign-in tracking', () => {
        it('records a successful sign-in, marking only the first one as a new account', async () => {
            await googleSignIn('google-analytics-1').expect(200);
            await googleSignIn('google-analytics-1').expect(200);

            const events = await waitForEvents({ name: 'sign_in.succeeded' }, 2);
            assert.equal(events.length, 2);
            assert.equal(events[0].source, 'server');
            assert.equal(events[0].platform, 'ios');
            assert.ok(events[0].userId);
            assert.deepEqual(events.map((event) => event.props), [
                { method: 'google', isNewUser: true },
                { method: 'google', isNewUser: false },
            ]);

            const days = (events[0].retainUntil!.getTime() - events[0].occurredAt.getTime()) / (24 * 60 * 60 * 1000);
            assert.ok(Math.abs(days - 90) < 0.01, `retainUntil is ${days} days after the event`);
        });

        it('records a failed sign-in with the error code the app received', async () => {
            await getTestAgent()
                .post('/v1/auth/provider-sign-in')
                .send({ provider: 'apple', platform: 'android' })
                .expect(400);

            const [event] = await waitForEvents({ name: 'sign_in.failed' }, 1);
            assert.equal(event.platform, 'android');
            assert.equal(event.userId, undefined);
            assert.deepEqual(event.props, {
                method: 'apple',
                reason: 'VALIDATION_ERROR',
                detail: 'Missing identity token.',
            });
        });

        it('takes the platform, app version and install id from the app headers', async () => {
            await getTestAgent()
                .post('/v1/auth/provider-sign-in')
                .set(appHeaders('install-headers-1', 'ios'))
                .send({
                    provider: 'google',
                    // What builds before the headers sent; the header wins.
                    platform: 'mobile',
                    idToken: makeProviderTestToken({ sub: 'google-headers-1', email: 'h@example.com', email_verified: true }),
                })
                .expect(200);

            const [event] = await waitForEvents({ name: 'sign_in.succeeded' }, 1);
            assert.equal(event.platform, 'ios');
            assert.equal(event.appVersion, '1.0.0+13');
            assert.equal(event.installId, 'install-headers-1');
        });

        it('marks the user active the day they sign in', async () => {
            await googleSignIn('google-activity-1').expect(200);
            const [event] = await waitForEvents({ name: 'sign_in.succeeded' }, 1);

            const activity = await waitForActivity(event.userId!);
            assert.equal(activity.day.getTime(), startOfUtcDay(new Date()).getTime());
        });

        it('records a rate-limited sign-in once per install per window', async () => {
            const client = { platform: 'android', installId: 'install-limited-1' };
            trackSignInRateLimited({ method: 'google', client, ip: '203.0.113.7' });
            trackSignInRateLimited({ method: 'google', client, ip: '203.0.113.7' });
            // Another install behind the same IP (carrier NAT) is someone else.
            trackSignInRateLimited({ method: 'google', client: { installId: 'install-limited-2' }, ip: '203.0.113.7' });

            const events = await waitForEvents({ name: 'sign_in.failed' }, 2);
            await new Promise((resolve) => setTimeout(resolve, 100));
            assert.equal(await AnalyticsEvent.countDocuments({ name: 'sign_in.failed' }), 2);
            assert.deepEqual(events.map((event) => event.installId).sort(), ['install-limited-1', 'install-limited-2']);
            assert.ok(events.every((event) => event.props?.reason === 'TOO_MANY_REQUESTS'));
        });
    });

    describe('daily activity', () => {
        it('records each user once a day, with the platform and version of the first request', async () => {
            const me = await createTestUser({ username: 'alice' });
            await getTestAgent().get('/v1/users/me').set({ ...authHeader(me._id.toString()), ...appHeaders('install-a') }).expect(200);
            await getTestAgent().get('/v1/users/me').set({ ...authHeader(me._id.toString()), ...appHeaders('install-a', 'ios') }).expect(200);

            const activity = await waitForActivity(me._id);
            await new Promise((resolve) => setTimeout(resolve, 100));
            assert.equal(await UserActivity.countDocuments({ userId: me._id }), 1);
            assert.equal(activity.platform, 'android');
            assert.equal(activity.appVersion, '1.0.0+13');
        });

        it('is deleted with the account and included in the data export', async () => {
            const me = await createTestUser({ username: 'alice' });
            await getTestAgent().get('/v1/users/me').set(authHeader(me._id.toString())).expect(200);
            await waitForActivity(me._id);
            await getTestAgent()
                .post('/v1/analytics/events')
                .set(authHeader(me._id.toString()))
                .send({ events: [{ name: 'app.opened' }] })
                .expect(202);

            const exported = await getTestAgent().get('/v1/users/me/export').set(authHeader(me._id.toString())).expect(200);
            assert.deepEqual(exported.body.usage.activeDays.map((entry: { day: string }) => entry.day), [
                new Date().toISOString().slice(0, 10),
            ]);
            assert.deepEqual(exported.body.usage.events.map((event: { name: string }) => event.name), ['client.app.opened']);

            const deleted = await getTestAgent().delete('/v1/users/me').set(authHeader(me._id.toString())).expect(200);
            assert.equal(deleted.body.removed.activityDays, 1);
            assert.equal(await UserActivity.countDocuments({ userId: me._id }), 0);
        });
    });

    describe('content filter', () => {
        it('counts what the filter rejected, never the text', async () => {
            const me = await createTestUser();
            await getTestAgent()
                .post('/v1/auth/set-username')
                .set(authHeader(me._id.toString()))
                .send({ username: 'shithead' })
                .expect(400);

            const [event] = await waitForEvents({ name: 'moderation.content_blocked' }, 1);
            assert.equal(event.userId!.toString(), me._id.toString());
            assert.deepEqual(event.props, { surface: 'username', kind: 'text' });
        });
    });

    describe('POST /v1/analytics/events', () => {
        it('stores allowlisted events from a signed-out app and drops the rest', async () => {
            const occurredAt = Date.now() - 60_000;
            const res = await getTestAgent()
                .post('/v1/analytics/events')
                .send({
                    installId: 'c0ffee00-1234-4abc-9def-000000000001',
                    platform: 'android',
                    appVersion: '1.4.0+52',
                    events: [
                        { name: 'sign_in.started', occurredAt, props: { provider: 'google' } },
                        { name: 'sign_in.failed', props: { provider: 'google', reason: 'network_error', email: 'x@example.com' } },
                        { name: 'not_an_event' },
                        'garbage',
                    ],
                })
                .expect(202);

            assert.deepEqual(res.body, { accepted: 2 });

            const events = await AnalyticsEvent.find({}).sort({ name: 1 }).lean<StoredEvent[]>();
            assert.deepEqual(events.map((event) => event.name), ['client.sign_in.failed', 'client.sign_in.started']);
            assert.ok(events.every((event) => event.source === 'client' && event.userId === undefined));
            assert.ok(events.every((event) => event.installId === 'c0ffee00-1234-4abc-9def-000000000001'));
            assert.deepEqual(events[0].props, { provider: 'google', reason: 'network_error' });
            assert.equal(events[1].occurredAt.getTime(), occurredAt);
        });

        it('takes the install id, platform and version from the headers when the body has none', async () => {
            await getTestAgent()
                .post('/v1/analytics/events')
                .set(appHeaders('install-header-events', 'ios'))
                .send({ events: [{ name: 'sign_in.started', props: { provider: 'apple' } }] })
                .expect(202);

            const event = await AnalyticsEvent.findOne({ name: 'client.sign_in.started' }).lean<StoredEvent | null>();
            assert.equal(event!.installId, 'install-header-events');
            assert.equal(event!.platform, 'ios');
            assert.equal(event!.appVersion, '1.0.0+13');
        });

        it('attaches the user when the request carries a valid token', async () => {
            const me = await createTestUser({ username: 'alice' });
            await getTestAgent()
                .post('/v1/analytics/events')
                .set(authHeader(me._id.toString()))
                .send({ events: [{ name: 'app.opened' }] })
                .expect(202);

            const event = await AnalyticsEvent.findOne({ name: 'client.app.opened' }).lean<StoredEvent | null>();
            assert.equal(event!.userId!.toString(), me._id.toString());
        });

        it('treats an invalid token as signed out', async () => {
            await getTestAgent()
                .post('/v1/analytics/events')
                .set({ Authorization: 'Bearer not-a-token' })
                .send({ events: [{ name: 'app.opened' }] })
                .expect(202);

            const event = await AnalyticsEvent.findOne({ name: 'client.app.opened' }).lean<StoredEvent | null>();
            assert.equal(event!.userId, undefined);
        });

        it('rejects a body without an events array or with too many events', async () => {
            await getTestAgent().post('/v1/analytics/events').send({}).expect(400);
            await getTestAgent()
                .post('/v1/analytics/events')
                .send({ events: Array.from({ length: 26 }, () => ({ name: 'app.opened' })) })
                .expect(400);
        });
    });

    describe('GET /v1/admin/analytics', () => {
        it('requires the admin key', async () => {
            await getTestAgent().get('/v1/admin/analytics').expect(403);
        });

        it('summarizes sign-ins, messages per city, reports and the daily series', async () => {
            await googleSignIn('google-analytics-2').expect(200);
            await getTestAgent().post('/v1/auth/provider-sign-in').send({ provider: 'google' }).expect(400);
            await waitForEvents({ name: { $in: ['sign_in.succeeded', 'sign_in.failed'] } }, 2);

            const alice = await createTestUser({ username: 'alice' });
            const bob = await createTestUser({ username: 'bob' });
            const belgrade = await Room.create({ name: 'Belgrade', type: 'public', cityKey: 'belgrade-rs' });
            const novi = await Room.create({ name: 'Novi Sad', type: 'public', cityKey: 'novi-sad-rs' });
            const dm = await Room.create({ name: 'dm', type: 'private', participants: [alice._id, bob._id] });
            await Message.create([
                { roomId: belgrade._id, userId: alice._id, text: 'a', parentMessageId: null },
                { roomId: belgrade._id, userId: bob._id, text: 'b', parentMessageId: null },
                { roomId: novi._id, userId: alice._id, text: 'c', parentMessageId: null },
                { roomId: dm._id, userId: alice._id, text: 'd', parentMessageId: null },
            ]);
            await Report.create({ reporterUserId: alice._id, reportedUserId: bob._id, reason: 'spam' });

            const res = await getTestAgent()
                .get('/v1/admin/analytics?days=7')
                .set({ 'x-admin-key': ADMIN_KEY })
                .expect(200);

            const summary = res.body;
            assert.equal(summary.days, 7);
            assert.equal(summary.signIns.succeeded, 1);
            assert.equal(summary.signIns.failed, 1);
            assert.equal(summary.signIns.newAccounts, 1);
            assert.deepEqual(summary.signIns.byMethod, [{ method: 'google', succeeded: 1, failed: 1 }]);
            assert.deepEqual(summary.signIns.failureReasons, [{ key: 'VALIDATION_ERROR', count: 1 }]);

            assert.equal(summary.messages.total, 4);
            assert.equal(summary.messages.inDirectMessages, 1);
            assert.deepEqual(
                summary.messages.byCity.map((row: { name: string; messages: number }) => [row.name, row.messages]),
                [['Belgrade', 2], ['Novi Sad', 1]]
            );

            assert.equal(summary.reports.created, 1);
            assert.equal(summary.reports.openNow, 1);
            assert.deepEqual(summary.reports.byReason, [{ key: 'spam', count: 1 }]);

            assert.equal(summary.users.new, 3);
            assert.equal(summary.daily.length, 7);
            const today = summary.daily[summary.daily.length - 1];
            assert.equal(today.messages, 4);
            assert.equal(today.signInsSucceeded, 1);
            assert.equal(today.signInsFailed, 1);
            assert.equal(today.reports, 1);
        });

        it('counts people by install: who got in, who gave up and who hit an error', async () => {
            const now = Date.now();
            const clientEvents = (installId: string, names: string[]) => getTestAgent()
                .post('/v1/analytics/events')
                .set(appHeaders(installId))
                .send({ events: names.map((name) => ({ name, occurredAt: now, props: { provider: 'google' } })) })
                .expect(202);

            // A: an error, then in. B: an error and never in. C: gave up.
            await clientEvents('install-a', ['app.opened', 'sign_in.started', 'sign_in.failed', 'sign_in.started']);
            await getTestAgent()
                .post('/v1/auth/provider-sign-in')
                .set(appHeaders('install-a'))
                .send({
                    provider: 'google',
                    idToken: makeProviderTestToken({ sub: 'google-people-a', email: 'a@example.com', email_verified: true }),
                })
                .expect(200);
            await clientEvents('install-b', ['sign_in.started']);
            await getTestAgent().post('/v1/auth/provider-sign-in').set(appHeaders('install-b')).send({ provider: 'google' }).expect(400);
            await clientEvents('install-c', ['app.opened', 'sign_in.started', 'sign_in.cancelled']);
            // Opened while signed in: not part of the sign-in funnel.
            const me = await createTestUser({ username: 'opener' });
            await getTestAgent()
                .post('/v1/analytics/events')
                .set({ ...appHeaders('install-d'), ...authHeader(me._id.toString()) })
                .send({ events: [{ name: 'app.opened' }] })
                .expect(202);
            // A build without the headers.
            await getTestAgent().post('/v1/auth/provider-sign-in').send({ provider: 'apple' }).expect(400);
            await waitForEvents({ source: 'server' }, 3);

            const res = await getTestAgent()
                .get('/v1/admin/analytics?days=1')
                .set({ 'x-admin-key': ADMIN_KEY })
                .expect(200);

            assert.deepEqual(res.body.signIns.installs, {
                openedSignedOut: 2,
                tried: 3,
                signedIn: 1,
                neverSignedIn: 2,
                neverSignedInAfterError: 1,
            });
            assert.equal(res.body.signIns.attemptsWithoutInstallId, 1);
            assert.deepEqual(res.body.signIns.byPlatform, [
                { platform: 'android', succeeded: 1, failed: 1 },
                { platform: 'unknown', succeeded: 0, failed: 1 },
            ]);
            assert.equal(res.body.signIns.client.started, 4);
            assert.equal(res.body.signIns.client.cancelled, 1);
            assert.equal(res.body.signIns.client.failed, 1);
        });

        it('reports active users, blocks and filter rejections', async () => {
            const alice = await createTestUser({ username: 'alice' });
            const bob = await createTestUser({ username: 'bob' });
            const today = startOfUtcDay(new Date());
            await UserActivity.create([
                { userId: alice._id, day: today, platform: 'ios' },
                { userId: bob._id, day: today, platform: 'android' },
                { userId: alice._id, day: new Date(today.getTime() - 3 * 24 * 60 * 60 * 1000), platform: 'ios' },
            ]);
            await getTestAgent().post(`/v1/users/${bob._id.toString()}/block`).set(authHeader(alice._id.toString())).expect(200);
            await getTestAgent().put('/v1/users/profile').set(authHeader(bob._id.toString())).send({ bio: 'what a shitshow' }).expect(400);
            await waitForEvents({ name: 'moderation.content_blocked' }, 1);

            const res = await getTestAgent()
                .get('/v1/admin/analytics?days=7')
                .set({ 'x-admin-key': ADMIN_KEY })
                .expect(200);

            assert.equal(res.body.active.today, 2);
            assert.equal(res.body.active.last7Days, 2);
            assert.equal(res.body.active.inPeriod, 2);
            assert.deepEqual(
                [...res.body.active.byPlatform].sort((a: { key: string }, b: { key: string }) => a.key.localeCompare(b.key)),
                [{ key: 'android', count: 1 }, { key: 'ios', count: 1 }]
            );
            assert.equal(res.body.blocks.created, 1);
            assert.deepEqual(res.body.contentBlocked, { total: 1, bySurface: [{ key: 'bio', count: 1 }] });

            const daily = res.body.daily;
            assert.equal(daily[daily.length - 1].activeUsers, 2);
            assert.equal(daily[daily.length - 4].activeUsers, 1);
            assert.equal(daily[daily.length - 1].blocks, 1);
        });

        it('rejects an out-of-range window', async () => {
            await getTestAgent()
                .get('/v1/admin/analytics?days=365')
                .set({ 'x-admin-key': ADMIN_KEY })
                .expect(400);
        });
    });
});
