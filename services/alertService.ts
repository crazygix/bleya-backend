import { config } from '../config/index.js';
import logger from '../utils/logger.js';

const ALERT_TIMEOUT_MS = 5000;
// Telegram rejects messages longer than 4096 characters.
const MAX_ALERT_LENGTH = 4000;

export function isAlertingConfigured(): boolean {
    return config.alerts.telegramBotToken.length > 0 && config.alerts.telegramChatId.length > 0;
}

/**
 * Sends a short operator alert through the Telegram bot in TELEGRAM_BOT_TOKEN to
 * the chat in TELEGRAM_CHAT_ID. Fire-and-forget: it never throws and never
 * delays the request that triggered it. Alerts must not carry message text or
 * other user content, only what a moderator needs to go and look. The bot token
 * is part of the URL, so neither the URL nor Telegram's reply is logged.
 */
export function sendAlert(text: string): void {
    if (!isAlertingConfigured() || config.isTest) {
        return;
    }

    const body = text.length > MAX_ALERT_LENGTH ? `${text.slice(0, MAX_ALERT_LENGTH)}…` : text;
    void fetch(`https://api.telegram.org/bot${config.alerts.telegramBotToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            chat_id: config.alerts.telegramChatId,
            text: body,
            disable_web_page_preview: true,
        }),
        signal: AbortSignal.timeout(ALERT_TIMEOUT_MS),
    })
        .then((response) => {
            if (!response.ok) {
                logger.warn('alert.send_failed', { status: response.status });
            }
        })
        .catch((error: unknown) => {
            logger.warn('alert.send_failed', {
                error: error instanceof Error ? error.name : 'unknown',
            });
        });
}
