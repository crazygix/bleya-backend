import { config } from '../config/index.js';
import logger from '../utils/logger.js';
import { sendTelegramMessage } from '../utils/telegram.js';

export function isAlertingConfigured(): boolean {
    return config.alerts.telegramBotToken.length > 0 && config.alerts.telegramChatId.length > 0;
}

/**
 * Sends a short operator alert through the Telegram bot in TELEGRAM_BOT_TOKEN to
 * the chat in TELEGRAM_CHAT_ID. Fire-and-forget: it never throws and never
 * delays the request that triggered it. Alerts must not carry message text or
 * other user content, only what a moderator needs to go and look.
 */
export function sendAlert(text: string): void {
    if (!isAlertingConfigured() || config.isTest) {
        return;
    }

    void sendTelegramMessage(config.alerts.telegramChatId, text).then((status) => {
        if (status !== 200) {
            logger.warn('alert.send_failed', { status });
        }
    });
}
