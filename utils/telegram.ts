import { config } from '../config/index.js';

const TELEGRAM_TIMEOUT_MS = 5000;
// Telegram rejects messages longer than 4096 characters.
const MAX_TELEGRAM_MESSAGE_LENGTH = 4000;

export function truncateForTelegram(text: string): string {
    return text.length > MAX_TELEGRAM_MESSAGE_LENGTH ? `${text.slice(0, MAX_TELEGRAM_MESSAGE_LENGTH)}…` : text;
}

/**
 * Sends `text` to `chatId` through the bot in TELEGRAM_BOT_TOKEN. Never throws;
 * resolves to the HTTP status, or null when the request didn't complete. The
 * bot token is part of the URL, so callers must not log the URL or the
 * underlying error message. Deliberately doesn't use the logger: the logger
 * itself reports errors through here.
 */
export async function sendTelegramMessage(chatId: string, text: string): Promise<number | null> {
    if (!config.alerts.telegramBotToken || !chatId) {
        return null;
    }

    try {
        const response = await fetch(`https://api.telegram.org/bot${config.alerts.telegramBotToken}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                text: truncateForTelegram(text),
                disable_web_page_preview: true,
            }),
            signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
        });
        return response.status;
    } catch {
        return null;
    }
}
