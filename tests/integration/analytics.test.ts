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

const ADMIN_KEY = 'k'.repeat(40);

interface StoredEvent {
    name: string;
    source: string;
    userId?: mongoose.Types.ObjectId;
    installId?: string;
    platform?: string;
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

        it('rejects an out-of-range window', async () => {
            await getTestAgent()
                .get('/v1/admin/analytics?days=365')
                .set({ 'x-admin-key': ADMIN_KEY })
                .expect(400);
        });
    });
});
