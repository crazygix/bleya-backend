import mongoose from 'mongoose';
import { config } from '../config/index.js';
import { UserBlock } from '../models/UserBlock.js';
import logger from '../utils/logger.js';
import { sendTelegramMessage } from '../utils/telegram.js';

export function isModerationAlertingConfigured(): boolean {
    return config.alerts.telegramBotToken.length > 0 && config.alerts.moderationChatId.length > 0;
}

/**
 * Sends a short alert to the moderation chat (TELEGRAM_MODERATION_CHAT_ID): new
 * reports, user blocks, moderator actions. Fire-and-forget: it never throws and
 * never delays the request that triggered it. Alerts must not carry message
 * text or other user content, only what a moderator needs to go and look.
 */
export function sendModerationAlert(text: string): void {
    if (!isModerationAlertingConfigured() || config.isTest) {
        return;
    }

    void sendTelegramMessage(config.alerts.moderationChatId, text).then((status) => {
        if (status !== 200) {
            logger.warn('alert.send_failed', { status });
        }
    });
}

// A user blocked another. Includes how many people block that user now, which
// is what makes a problem account stand out.
export function alertUserBlocked(input: { blockerUserId: string; blockedUserId: string; via: 'profile' | 'direct chat' }): void {
    if (!isModerationAlertingConfigured() || config.isTest) {
        return;
    }

    void UserBlock.countDocuments({ blockedUserId: new mongoose.Types.ObjectId(input.blockedUserId), isActive: true })
        .then((blockedBy) => {
            sendModerationAlert(
                `🚫 User ${input.blockedUserId} was blocked (${input.via}) by ${input.blockerUserId}\n`
                + `Now blocked by ${blockedBy} user(s)`
            );
        })
        .catch((error: unknown) => {
            logger.warn('alert.block_count_failed', { error: error instanceof Error ? error.message : 'unknown' });
        });
}
