/**
 * Very small, dependency-free sanitization helpers.
 *
 * Goal: prevent accidental HTML/script injection + remove control characters.
 * NOTE: This is not a full HTML sanitizer. For rich-text support, use a vetted library.
 */

// ASCII control chars except \t, \n, \r
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

function normalizeWhitespace(input: string): string {
  return input.replace(/\s+/g, ' ').trim();
}

function stripControlChars(input: string): string {
  return input.replace(CONTROL_CHARS, '');
}

function escapeHtml(input: string): string {
  return input
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function sanitizePlainText(
  input: string,
  opts?: { maxLength?: number; collapseWhitespace?: boolean; escapeHtml?: boolean }
): string {
  const maxLength = opts?.maxLength ?? 5000;
  const collapseWhitespace = opts?.collapseWhitespace ?? true;
  const doEscape = opts?.escapeHtml ?? true;

  let out = String(input);
  out = stripControlChars(out);
  if (collapseWhitespace) out = normalizeWhitespace(out);
  if (doEscape) out = escapeHtml(out);
  if (out.length > maxLength) out = out.slice(0, maxLength);
  return out;
}
