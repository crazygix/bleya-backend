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
 * reports, users many people block, moderator actions. Fire-and-forget: it
 * never throws and never delays the request that triggered it. Alerts must not
 * carry message text or other user content, only what a moderator needs to go
 * and look.
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

// How many users must block someone before the moderation chat hears about
// it, and again at each further mark (then every 100). A single block is
// routine; several people blocking the same account is what makes it stand out.
const BLOCK_ALERT_THRESHOLDS = [3, 5, 10, 25, 50, 100];

export function isBlockAlertThreshold(blockedBy: number): boolean {
    return BLOCK_ALERT_THRESHOLDS.includes(blockedBy) || (blockedBy > 100 && blockedBy % 100 === 0);
}

// A user blocked another. Alerted only when the number of people blocking
// that user reaches one of BLOCK_ALERT_THRESHOLDS.
export function alertUserBlocked(input: { blockerUserId: string; blockedUserId: string; via: 'profile' | 'direct chat' }): void {
    if (!isModerationAlertingConfigured() || config.isTest) {
        return;
    }

    void UserBlock.countDocuments({ blockedUserId: new mongoose.Types.ObjectId(input.blockedUserId), isActive: true })
        .then((blockedBy) => {
            if (!isBlockAlertThreshold(blockedBy)) {
                return;
            }
            sendModerationAlert(
                `🚫 User ${input.blockedUserId} is now blocked by ${blockedBy} users\n`
                + `Latest: blocked (${input.via}) by ${input.blockerUserId}`
            );
        })
        .catch((error: unknown) => {
            logger.warn('alert.block_count_failed', { error: error instanceof Error ? error.message : 'unknown' });
        });
}
