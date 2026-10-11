import { config } from '../config/index.js';

const TELEGRAM_TIMEOUT_MS = 5000;
// Telegram rejects messages longer than 4096 characters.
const MAX_TELEGRAM_MESSAGE_LENGTH = 4000;

export function escapeTelegramHtml(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// `text` as a <pre> block (one tap copies it in Telegram), cut to fit one
// message together with `headerHtml`.
export function telegramPreBlock(headerHtml: string, text: string): string {
    const room = MAX_TELEGRAM_MESSAGE_LENGTH - headerHtml.length - '\n<pre>…</pre>'.length;
    let escaped = escapeTelegramHtml(text);
    if (escaped.length > room) {
        let body = text.slice(0, room);
        escaped = escapeTelegramHtml(body);
        // Escaping lengthens the text; shorten until it fits.
        while (escaped.length > room) {
            body = body.slice(0, body.length - 100);
            escaped = escapeTelegramHtml(body);
        }
        escaped += '…';
    }
    return `${headerHtml}\n<pre>${escaped}</pre>`;
}

/**
 * Sends a message to `chatId` through the bot in TELEGRAM_BOT_TOKEN. Plain text
 * by default; with `html` the text uses Telegram's HTML subset and the caller
 * escapes anything it didn't write. Never throws; resolves to the HTTP status,
 * or null when the request didn't complete. The bot token is part of the URL,
 * so callers must not log the URL or the underlying error. Deliberately doesn't
 * use the logger: the logger itself reports errors through here.
 */
export async function sendTelegramMessage(
    chatId: string,
    text: string,
    options: { html?: boolean } = {}
): Promise<number | null> {
    if (!config.alerts.telegramBotToken || !chatId) {
        return null;
    }

    const body = !options.html && text.length > MAX_TELEGRAM_MESSAGE_LENGTH
        ? `${text.slice(0, MAX_TELEGRAM_MESSAGE_LENGTH)}…`
        : text;

    try {
        const response = await fetch(`https://api.telegram.org/bot${config.alerts.telegramBotToken}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                text: body,
                disable_web_page_preview: true,
                ...(options.html ? { parse_mode: 'HTML' } : {}),
            }),
            signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
        });
        return response.status;
    } catch {
        return null;
    }
}
