import mongoose from 'mongoose';
import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import { config, validatePushConfig } from '../config/index.js';
import { PushToken } from '../models/PushToken.js';
import { sendPushNotifications } from '../services/pushNotificationService.js';
import { User } from '../models/User.js';
import { createMessage } from '../services/messageService.js';
import { prepareMessageDelivery } from '../services/messageDeliveryService.js';

interface CliOptions {
    sendTo: string | null;
    userId: string | null;
    pipelineFrom: string | null;
    pipelineTo: string | null;
    simulateFrom: string | null;
    simulateRoom: string | null;
}

function parseArgs(argv: string[]): CliOptions {
    const opts: CliOptions = {
        sendTo: null,
        userId: null,
        pipelineFrom: null,
        pipelineTo: null,
        simulateFrom: null,
        simulateRoom: null,
    };

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--send' && argv[i + 1]) {
            opts.sendTo = argv[++i];
        } else if (arg === '--user' && argv[i + 1]) {
            opts.userId = argv[++i];
        } else if (arg === '--pipeline-from' && argv[i + 1]) {
            opts.pipelineFrom = argv[++i];
        } else if (arg === '--pipeline-to' && argv[i + 1]) {
            opts.pipelineTo = argv[++i];
        } else if (arg === '--simulate-from' && argv[i + 1]) {
            opts.simulateFrom = argv[++i];
        } else if (arg === '--simulate-room' && argv[i + 1]) {
            opts.simulateRoom = argv[++i];
        }
    }

    return opts;
}

function header(label: string): void {
    console.log('');
    console.log(`=== ${label} ===`);
}

function ok(msg: string): void {
    console.log(`  ok   ${msg}`);
}

function bad(msg: string): void {
    console.log(`  FAIL ${msg}`);
}

function info(msg: string): void {
    console.log(`       ${msg}`);
}

async function checkPushConfig(): Promise<boolean> {
    header('1. push config (env vars)');
    const validation = validatePushConfig();
    if (!validation.complete) {
        bad(`missing env vars: ${validation.missing.join(', ')}`);
        return false;
    }

    ok(`FIREBASE_PROJECT_ID  = ${config.push.firebaseProjectId}`);
    ok(`FIREBASE_CLIENT_EMAIL = ${config.push.firebaseClientEmail}`);
    const keyLen = config.push.firebasePrivateKey.length;
    const looksLikePem = config.push.firebasePrivateKey.includes('BEGIN PRIVATE KEY');
    ok(`FIREBASE_PRIVATE_KEY  length=${keyLen} pemHeaderFound=${looksLikePem}`);
    return true;
}

async function checkFirebaseInit(): Promise<boolean> {
    header('2. firebase admin init');
    try {
        const existing = getApps()[0];
        if (existing) {
            ok('firebase app already initialized');
            return true;
        }

        initializeApp({
            credential: cert({
                projectId: config.push.firebaseProjectId,
                clientEmail: config.push.firebaseClientEmail,
                privateKey: config.push.firebasePrivateKey.replace(/\\n/g, '\n'),
            }),
        });
        ok('firebase app initialized successfully');
        return true;
    } catch (error) {
        bad(`firebase init threw: ${error instanceof Error ? error.message : String(error)}`);
        info('most common cause: FIREBASE_PRIVATE_KEY is malformed (escaped newlines, missing PEM)');
        return false;
    }
}

async function checkTokens(userIdFilter: string | null): Promise<void> {
    header('3. push tokens in mongodb');

    const total = await PushToken.countDocuments({});
    const active = await PushToken.countDocuments({ isActive: true });
    const inactive = await PushToken.countDocuments({ isActive: false });
    ok(`total=${total}  active=${active}  inactive=${inactive}`);

    if (total === 0) {
        bad('no push tokens registered at all — the mobile registration step is failing');
        info('check that mobile is calling POST /v1/notifications/push/register after sign-in');
        info('check that user actually granted the OS push permission');
        return;
    }

    const filter: Record<string, unknown> = {};
    if (userIdFilter) {
        filter.userId = new mongoose.Types.ObjectId(userIdFilter);
    }

    const recent = await PushToken.find(filter)
        .sort({ updatedAt: -1 })
        .limit(10)
        .select('userId platform isActive lastSeenAt lastSuccessAt lastFailureAt failureReason updatedAt')
        .lean();

    info('most-recent rows:');
    for (const row of recent) {
        const status = row.isActive ? 'active' : 'INACTIVE';
        const lastSuccess = row.lastSuccessAt ? new Date(row.lastSuccessAt).toISOString() : 'never';
        const lastFailure = row.lastFailureAt ? new Date(row.lastFailureAt).toISOString() : 'never';
        const reason = row.failureReason ? ` reason="${row.failureReason}"` : '';
        info(`  user=${row.userId}  platform=${row.platform}  ${status}  lastSuccess=${lastSuccess}  lastFailure=${lastFailure}${reason}`);
    }
}

async function sendTestPush(tokenString: string): Promise<void> {
    header('4. send test push');
    try {
        const messaging = getMessaging();
        const response = await messaging.send({
            token: tokenString,
            notification: {
                title: 'Bleya diagnostic',
                body: 'If you see this, FCM delivery works.',
            },
            data: {
                type: 'diagnostic',
            },
        });
        ok(`firebase accepted the message id=${response}`);
        info('if device still does not show notification:');
        info('  - iOS: APNs Authentication Key not configured at Firebase Console');
        info('  - iOS: app is in foreground (foreground notifications need extra plugin handling)');
        info('  - Android: notification channel not created / app force-stopped');
    } catch (error) {
        const err = error as { code?: string; message?: string };
        bad(`send failed code=${err.code} message=${err.message}`);
        if (err.code === 'messaging/registration-token-not-registered') {
            info('this token is stale — mobile must re-register');
        } else if (err.code === 'messaging/invalid-registration-token') {
            info('this token is malformed — check what the mobile sent to the register endpoint');
        } else if (err.code === 'messaging/third-party-auth-error') {
            info('iOS-specific: APNs key/cert missing or invalid at Firebase Console');
        }
    }
}

async function sendPipeline(senderUserId: string, recipientUserId: string): Promise<void> {
    header('5. full-pipeline send (calls real sendPushNotifications)');
    const sender = await User.findById(senderUserId).select('username').lean<{ username?: string }>();
    if (!sender) {
        bad(`sender user ${senderUserId} not found`);
        return;
    }

    const recipientToken = await PushToken.findOne({
        userId: new mongoose.Types.ObjectId(recipientUserId),
        isActive: true,
    }).lean();
    if (!recipientToken) {
        bad(`recipient user ${recipientUserId} has no active push token`);
        return;
    }

    info(`sender=${senderUserId} (${sender.username})`);
    info(`recipient=${recipientUserId}  platform=${recipientToken.platform}`);
    info('calling sendPushNotifications with synthesized SendPushNotificationsInput...');

    const fakeRoomId = new mongoose.Types.ObjectId().toString();
    const fakeMessageId = new mongoose.Types.ObjectId().toString();

    try {
        await sendPushNotifications({
            type: 'message',
            recipients: [{ userId: recipientUserId }],
            roomId: fakeRoomId,
            roomName: 'Pipeline Test Room',
            roomType: 'public',
            messageId: fakeMessageId,
            threadId: null,
            senderId: senderUserId,
            senderUsername: sender.username || 'unknown',
            messageText: 'Pipeline test: a real message from sender to recipient.',
        });
        ok('sendPushNotifications returned without throwing');

        const updated = await PushToken.findById(recipientToken._id)
            .select('lastSuccessAt lastFailureAt failureReason')
            .lean<{ lastSuccessAt?: Date; lastFailureAt?: Date; failureReason?: string }>();

        if (updated?.lastSuccessAt && (!recipientToken.lastSuccessAt
            || new Date(updated.lastSuccessAt).getTime() > new Date(recipientToken.lastSuccessAt).getTime())) {
            ok(`token row updated: lastSuccessAt=${updated.lastSuccessAt.toISOString()}`);
            info('check the device now — banner should be visible if app is backgrounded');
        } else if (updated?.lastFailureAt) {
            bad(`token marked failed: reason=${updated.failureReason} at=${updated.lastFailureAt}`);
        } else {
            bad('no DB update happened — recipient probably filtered out before send');
            info('most likely: tokens.length===0 (no active token for recipient) or messages.length===0');
        }
    } catch (error) {
        bad(`sendPushNotifications threw: ${error instanceof Error ? error.message : String(error)}`);
    }
}

async function simulateRealMessage(senderUserId: string, roomId: string): Promise<void> {
    header('6. simulate real message flow');
    info(`sender=${senderUserId}  room=${roomId}`);

    let createResult;
    try {
        createResult = await createMessage({
            userId: senderUserId,
            roomId,
            text: 'Diagnostic: simulated real message via socket handler path.',
        });
        ok('createMessage succeeded');
    } catch (error) {
        bad(`createMessage threw: ${error instanceof Error ? error.message : String(error)}`);
        info('common causes: sender not in room, room not found, sender blocked');
        return;
    }

    info(`messageId=${createResult.messageData.id}`);
    info(`pushType=${createResult.pushType}  isTopLevel=${createResult.isTopLevel}`);
    info(`candidateRecipientUserIds=[${createResult.candidateRecipientUserIds.join(', ') || '(empty)'}]`);

    if (createResult.candidateRecipientUserIds.length === 0) {
        bad('candidate list is empty — nobody to push to');
        info('=> bug source: sender is the only member of this room');
        info('   fix: ensure the recipient user joined the same room');
        return;
    }

    const offlinePresence = {
        isUserActiveInRoom: () => false,
        isUserActiveInThread: () => false,
    };

    let delivery;
    try {
        delivery = await prepareMessageDelivery(createResult, offlinePresence);
        ok('prepareMessageDelivery succeeded');
    } catch (error) {
        bad(`prepareMessageDelivery threw: ${error instanceof Error ? error.message : String(error)}`);
        return;
    }

    if (!delivery.pushRequest) {
        bad('pushRequest is null — pipeline filtered everyone out');
        info('=> with offline presence resolver, this should not happen unless candidate list was empty');
        return;
    }

    info(`pushRequest.recipients=${delivery.pushRequest.recipients.length}`);

    try {
        await sendPushNotifications(delivery.pushRequest);
        ok('sendPushNotifications returned without throwing');
        info('check the device — banner should be visible if app is backgrounded');
        info('if NO banner: the recipient does not have a registered push token');
    } catch (error) {
        bad(`sendPushNotifications threw: ${error instanceof Error ? error.message : String(error)}`);
    }
}

async function main(): Promise<void> {
    const opts = parseArgs(process.argv.slice(2));

    console.log('Bleya push notification diagnostic');
    console.log(`MONGODB_URI = ${config.mongoUri}`);

    const configOk = await checkPushConfig();
    if (!configOk) {
        process.exit(1);
    }

    const firebaseOk = await checkFirebaseInit();
    if (!firebaseOk) {
        process.exit(1);
    }

    await mongoose.connect(config.mongoUri);
    try {
        await checkTokens(opts.userId);
        if (opts.sendTo) {
            await sendTestPush(opts.sendTo);
        } else {
            header('4. send test push (skipped)');
            info('pass --send <fcm-token> to attempt a real send to a device');
            info('  example: npm run diagnose-push -- --send "abc123..."');
        }

        if (opts.pipelineFrom && opts.pipelineTo) {
            await sendPipeline(opts.pipelineFrom, opts.pipelineTo);
        } else {
            header('5. full-pipeline send (skipped)');
            info('pass --pipeline-from <senderUserId> --pipeline-to <recipientUserId>');
            info('to exercise the real sendPushNotifications() function');
        }

        if (opts.simulateFrom && opts.simulateRoom) {
            await simulateRealMessage(opts.simulateFrom, opts.simulateRoom);
        } else {
            header('6. simulate real message flow (skipped)');
            info('pass --simulate-from <senderUserId> --simulate-room <roomId>');
            info('to call createMessage + prepareMessageDelivery + sendPushNotifications');
            info('(same code path the socket handler uses)');
        }
    } finally {
        await mongoose.disconnect();
    }
}

main().catch((error) => {
    console.error('diagnostic crashed:', error);
    process.exit(1);
});
