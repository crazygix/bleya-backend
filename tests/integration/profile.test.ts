import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import type { S3Client } from '@aws-sdk/client-s3';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../helpers/testDb.js';
import { getTestAgent, resetTestApp } from '../helpers/testApp.js';
import { createTestUser, authHeader } from '../helpers/auth.js';
import { stopRateLimiterCleanupForTests } from '../../middleware/rateLimiter.js';
import { config } from '../../config/index.js';
import { User } from '../../models/User.js';
import { Room } from '../../models/Room.js';
import { Message } from '../../models/Message.js';
import { Report } from '../../models/Report.js';
import { setR2ClientForTests, resetR2ClientForTests } from '../../services/r2Service.js';
import { createMessage } from '../../services/messageService.js';
import { deleteUserAccount } from '../../services/accountService.js';
import { getReport } from '../../services/reportService.js';

interface CapturedUpload {
    Key: string;
    Body: Buffer;
    ContentType: string;
}

describe('Profiles, reports and exports', () => {
    const originalBucket = config.r2.bucketName;
    const originalBaseUrl = config.r2.publicBaseUrl;
    let uploads: CapturedUpload[] = [];

    before(async () => {
        await connectTestDb();
        config.r2.bucketName = 'test-bucket';
        config.r2.publicBaseUrl = 'https://media.example.com';
        setR2ClientForTests({
            send: async (command: { input: CapturedUpload }) => {
                if (command.input.Body) {
                    uploads.push(command.input);
                }
                return {};
            },
        } as unknown as S3Client);
    });

    after(async () => {
        config.r2.bucketName = originalBucket;
        config.r2.publicBaseUrl = originalBaseUrl;
        resetR2ClientForTests();
        stopRateLimiterCleanupForTests();
        await disconnectTestDb();
    });

    beforeEach(async () => {
        await clearTestDb();
        resetTestApp();
        uploads = [];
    });

    describe('usernames', () => {
        it('filters profanity during onboarding', async () => {
            const user = await createTestUser();
            const agent = getTestAgent();

            await agent.post('/v1/auth/set-username').set(authHeader(user._id.toString()))
                .send({ username: 'fuck_you' }).expect(400);

            const check = await agent.post('/v1/auth/check-username').set(authHeader(user._id.toString()))
                .send({ username: 'fuck_you' }).expect(200);
            assert.equal(check.body.available, false);
        });

        it('can be set once through the profile but never changed', async () => {
            const user = await createTestUser();
            const agent = getTestAgent();

            await agent.put('/v1/users/profile').set(authHeader(user._id.toString()))
                .send({ username: 'first_name' }).expect(200);
            await agent.put('/v1/users/profile').set(authHeader(user._id.toString()))
                .send({ username: 'second_name' }).expect(400);

            const stored = await User.findById(user._id).lean();
            assert.equal(stored?.username, 'first_name');
        });
    });

    it('stores text exactly as typed', async () => {
        const user = await createTestUser({ username: 'writer' });
        const room = await Room.create({ name: 'General', type: 'public' });
        await User.updateOne({ _id: user._id }, { $addToSet: { joinedRooms: room._id } });

        const bio = await getTestAgent().put('/v1/users/profile').set(authHeader(user._id.toString()))
            .send({ bio: `It's me <3 & you` }).expect(200);
        assert.equal(bio.body.bio, `It's me <3 & you`);

        const result = await createMessage({
            userId: user._id.toString(),
            roomId: room._id.toString(),
            text: `Rock 'n' roll & "blues"\nsecond   line`,
        });
        assert.equal(result.messageData.text, `Rock 'n' roll & "blues"\nsecond line`);
    });

    describe('profile images', () => {
        it('re-encodes uploads to WebP and drops all EXIF metadata', async () => {
            const user = await createTestUser({ username: 'photographer' });
            const jpeg = await sharp({
                create: { width: 64, height: 48, channels: 3, background: { r: 200, g: 50, b: 50 } },
            })
                .jpeg()
                .withExifMerge({ IFD0: { ImageDescription: 'taken at 44.8125,20.4612' } })
                .toBuffer();
            assert.ok((await sharp(jpeg).metadata()).exif, 'fixture should carry EXIF');

            const res = await getTestAgent()
                .post('/v1/users/profile-image')
                .set(authHeader(user._id.toString()))
                .attach('image', jpeg, { filename: 'image_picker_1.jpg', contentType: 'application/octet-stream' })
                .expect(200);

            assert.equal(uploads.length, 1);
            assert.equal(uploads[0].ContentType, 'image/webp');
            assert.match(uploads[0].Key, /^profiles\/profile-[0-9a-f-]{36}\.webp$/);
            const stored = await sharp(uploads[0].Body).metadata();
            assert.equal(stored.format, 'webp');
            assert.equal(stored.exif, undefined);
            assert.equal(res.body.profileImageUrl, `https://media.example.com/${uploads[0].Key}`);
        });

        it('rejects a file that is not really an image', async () => {
            const user = await createTestUser({ username: 'sneaky' });
            await getTestAgent()
                .post('/v1/users/profile-image')
                .set(authHeader(user._id.toString()))
                .attach('image', Buffer.from('<html><script>alert(1)</script></html>'), {
                    filename: 'avatar.png',
                    contentType: 'text/html',
                })
                .expect(400);
            assert.equal(uploads.length, 0);
        });
    });

    describe('reports', () => {
        it('keeps a copy of the reported message after its author deletes their account', async () => {
            const reporter = await createTestUser({ username: 'reporter' });
            const author = await createTestUser({ username: 'author' });
            const room = await Room.create({ name: 'General', type: 'public' });
            const message = await Message.create({ roomId: room._id, userId: author._id, text: 'abusive text' });

            const created = await getTestAgent()
                .post('/v1/reports')
                .set(authHeader(reporter._id.toString()))
                .send({ messageId: message._id.toString(), reason: 'underage' })
                .expect(201);

            await deleteUserAccount(author._id.toString());

            const report = await getReport(created.body.id);
            assert.equal(report.reason, 'underage');
            assert.equal(report.message, null);
            assert.equal(report.messageSnapshot?.text, 'abusive text');
            assert.equal(report.messageSnapshot?.author.username, 'author');
            assert.equal(report.messageSnapshot?.author.id, author._id.toString());
            assert.equal(report.roomId, room._id.toString());
        });

        it('rejects a report for a message that does not exist', async () => {
            const reporter = await createTestUser({ username: 'reporter' });
            await getTestAgent()
                .post('/v1/reports')
                .set(authHeader(reporter._id.toString()))
                .send({ messageId: '507f1f77bcf86cd799439011', reason: 'spam' })
                .expect(404);
        });
    });

    it('exports filed reports, account status and moderation flags', async () => {
        const user = await createTestUser({ username: 'exporter' });
        const other = await createTestUser({ username: 'other' });
        const room = await Room.create({ name: 'General', type: 'public' });
        await Message.create({ roomId: room._id, userId: user._id, text: 'removed', deletedAt: new Date() });
        await Report.create({ reporterUserId: user._id, reportedUserId: other._id, reason: 'spam' });

        const res = await getTestAgent().get('/v1/users/me/export').set(authHeader(user._id.toString())).expect(200);
        assert.equal(res.body.account.status, 'active');
        assert.equal(res.body.messages[0].removedByModerator, true);
        assert.deepEqual(res.body.reportsFiled.map((r: { reason: string; targetTypes: string[] }) => [r.reason, r.targetTypes]), [
            ['spam', ['user']],
        ]);
    });
});
