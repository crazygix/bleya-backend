import test from 'node:test';
import assert from 'node:assert/strict';
import { formatDailyDigest } from '../../services/dailyDigestService.js';
import { isBlockAlertThreshold } from '../../services/alertService.js';
import type { DailyStatData } from '../../services/dailyStatsService.js';

function stat(overrides: Partial<DailyStatData> = {}): DailyStatData {
    return {
        users: { new: 12, total: 1234 },
        active: { users: 340, last7Days: 1020, last30Days: 2800, byPlatform: [] },
        retention: {
            day1: { signups: 5, returned: 2 },
            day7: { signups: 4, returned: 1 },
            day30: { signups: 0, returned: 0 },
        },
        signIns: {
            succeeded: 45,
            failed: 5,
            newAccounts: 12,
            byMethod: [],
            byPlatform: [],
            failureReasons: [
                { key: 'UNAUTHORIZED', count: 3 },
                { key: 'USER_BLOCKED', count: 1 },
                { key: 'TOO_MANY_REQUESTS', count: 1 },
            ],
            client: { started: 50, cancelled: 4, failed: 2, failureReasons: [{ key: 'network_error', count: 2 }] },
            installs: { openedSignedOut: 52, tried: 40, signedIn: 37, neverSignedIn: 3, neverSignedInAfterError: 2 },
            attemptsWithoutInstallId: 0,
        },
        messages: {
            total: 1203,
            inCityRooms: 980,
            inDirectMessages: 223,
            byCity: [
                { roomId: 'r1', name: 'Belgrade', cityKey: 'belgrade-rs', messages: 400 },
                { roomId: 'r2', name: 'Novi Sad', cityKey: 'novi-sad-rs', messages: 120 },
            ],
        },
        reports: { created: 3, byReason: [{ key: 'spam', count: 2 }, { key: 'harassment', count: 1 }] },
        blocks: { created: 4 },
        moderation: { actions: 1, byAction: [{ key: 'user_banned', count: 1 }] },
        contentBlocked: { total: 7, bySurface: [{ key: 'message', count: 6 }, { key: 'username', count: 1 }] },
        ...overrides,
    };
}

test('the digest has a line for each part of the day', () => {
    const text = formatDailyDigest(new Date(Date.UTC(2026, 9, 10)), stat(), { openReports: 5 });

    assert.match(text, /Bleya daily<\/b> · Sat 10 Oct 2026 \(UTC\)/);
    assert.match(text, /Users: <b>\+12<\/b> new · 1,234 total/);
    assert.match(text, /Active: <b>340<\/b> that day · 1,020 in 7 days · 2,800 in 30 days/);
    assert.match(text, /came back: day 1 2\/5 \(40%\) · day 7 1\/4 \(25%\)$/m);
    assert.match(text, /Sign-ins: <b>45<\/b> succeeded · <b>5<\/b> failed \(90% success\)/);
    assert.match(text, /Why they failed: UNAUTHORIZED 3 · USER_BLOCKED 1 · TOO_MANY_REQUESTS 1/);
    assert.match(text, /In the app: 50 started · 4 cancelled · 2 failed before reaching us/);
    assert.match(text, /Signed-out installs that opened the app: 52/);
    assert.match(text, /People: 37 of 40 got in · 3 didn't \(2 after an error\)/);
    assert.match(text, /Messages: <b>1,203<\/b> · 980 in cities · 223 in DMs/);
    assert.match(text, /Belgrade 400 · Novi Sad 120/);
    assert.match(text, /Reports: <b>3<\/b> new \(spam 2 · harassment 1\) · 5 open now/);
    assert.match(text, /Moderator actions: 1 \(user_banned 1\)/);
    assert.match(text, /Filter blocked: 7 \(message 6 · username 1\)/);
});

test('the digest leaves out what it has no data for and escapes names', () => {
    const text = formatDailyDigest(new Date(Date.UTC(2026, 9, 10)), stat({
        active: null,
        retention: null,
        messages: {
            total: 1,
            inCityRooms: 1,
            inDirectMessages: 0,
            byCity: [{ roomId: 'r1', name: 'A<b>&', cityKey: null, messages: 1 }],
        },
        moderation: { actions: 0, byAction: [] },
        contentBlocked: { total: 0, bySurface: [] },
    }), { openReports: 0 });

    assert.doesNotMatch(text, /Active:/);
    assert.doesNotMatch(text, /came back/);
    assert.doesNotMatch(text, /Moderator actions/);
    assert.doesNotMatch(text, /Filter blocked/);
    assert.match(text, /A&lt;b&gt;&amp; 1/);
});

test('block alerts fire at 3, 5, 10, 25, 50, 100 blockers and every 100 after', () => {
    const alerted = Array.from({ length: 400 }, (_, index) => index + 1).filter(isBlockAlertThreshold);
    assert.deepEqual(alerted, [3, 5, 10, 25, 50, 100, 200, 300, 400]);
});
