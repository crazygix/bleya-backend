import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../helpers/testDb.js';
import { createTestUser } from '../helpers/auth.js';
import { PushToken } from '../../models/PushToken.js';
import {
    resetPushMessagingForTests,
    sendPushNotifications,
    setPushMessagingForTests,
} from '../../services/pushNotificationService.js';

describe('pushNotificationService', () => {
    before(async () => {
        await connectTestDb();
    });

    after(async () => {
        resetPushMessagingForTests();
        await disconnectTestDb();
    });

    beforeEach(async () => {
        await clearTestDb();
        resetPushMessagingForTests();
    });

    it('deactivates invalid tokens returned by Firebase', async () => {
        const user = await createTestUser();
        await PushToken.create({
            userId: user._id,
            token: 'invalid-token',
            platform: 'ios',
            isActive: true,
        });

        setPushMessagingForTests({
            sendEach: async () => ({
                successCount: 0,
                failureCount: 1,
                responses: [{
                    success: false,
                    error: {
                        code: 'messaging/registration-token-not-registered',
                        message: 'Token no longer valid',
                    },
                }],
            }),
        });

        await sendPushNotifications({
            type: 'message',
            recipients: [{ userId: user._id.toString() }],
            roomId: new mongoose.Types.ObjectId().toString(),
            roomName: 'General',
            roomType: 'public',
            messageId: new mongoose.Types.ObjectId().toString(),
            threadId: null,
            senderId: new mongoose.Types.ObjectId().toString(),
            senderUsername: 'alice',
            messageText: 'Hello world',
        });

        const storedToken = await PushToken.findOne({ userId: user._id }).lean();
        assert.equal(storedToken?.isActive, false);
        assert.equal(storedToken?.failureReason, 'messaging/registration-token-not-registered');
    });

    it('keeps tokens active on transient provider failures', async () => {
        const user = await createTestUser();
        await PushToken.create({
            userId: user._id,
            token: 'transient-token',
            platform: 'android',
            isActive: true,
        });

        setPushMessagingForTests({
            sendEach: async () => ({
                successCount: 0,
                failureCount: 1,
                responses: [{
                    success: false,
                    error: {
                        code: 'messaging/internal-error',
                        message: 'Temporary failure',
                    },
                }],
            }),
        });

        await sendPushNotifications({
            type: 'reply',
            recipients: [{
                userId: user._id.toString(),
                notificationId: new mongoose.Types.ObjectId().toString(),
            }],
            roomId: new mongoose.Types.ObjectId().toString(),
            roomName: 'General',
            roomType: 'public',
            messageId: new mongoose.Types.ObjectId().toString(),
            threadId: new mongoose.Types.ObjectId().toString(),
            senderId: new mongoose.Types.ObjectId().toString(),
            senderUsername: 'bob',
            messageText: 'Reply text',
        });

        const storedToken = await PushToken.findOne({ userId: user._id }).lean();
        assert.equal(storedToken?.isActive, true);
        assert.equal(storedToken?.failureReason, 'messaging/internal-error');
    });
});
