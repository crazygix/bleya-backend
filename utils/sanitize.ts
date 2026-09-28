/**
 * Very small, dependency-free sanitization helpers for user-supplied plain text.
 *
 * Text is stored exactly as the user meant it (minus control characters): the
 * mobile app renders plain text, so HTML-escaping at write time only showed up
 * as "&#39;" in messages, bios and pushes. Escape at render time instead, in the
 * one place that emits HTML (escapeHtml below, or the `escapeHtml` option).
 */

// ASCII control chars except \t, \n, \r
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

function normalizeWhitespace(input: string): string {
  return input.replace(/\s+/g, ' ').trim();
}

// Keeps line breaks (at most one blank line in a row) but collapses runs of
// spaces/tabs and trims each line's trailing space.
function normalizeWhitespaceKeepingLines(input: string): string {
  return input
    .replace(/\r\n?/g, '\n')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function stripControlChars(input: string): string {
  return input.replace(CONTROL_CHARS, '');
}

export function escapeHtml(input: string): string {
  return input
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

// Exact inverse of escapeHtml (only its five entities), for migrating text that
// was stored escaped. '&amp;' goes last so '&amp;lt;' becomes '&lt;', not '<'.
export function unescapeHtml(input: string): string {
  return input
    .replaceAll('&#39;', "'")
    .replaceAll('&quot;', '"')
    .replaceAll('&gt;', '>')
    .replaceAll('&lt;', '<')
    .replaceAll('&amp;', '&');
}

export function sanitizePlainText(
  input: string,
  opts?: {
    maxLength?: number;
    collapseWhitespace?: boolean;
    // With collapseWhitespace, keep line breaks instead of joining lines.
    preserveNewlines?: boolean;
    // Only for text that will be embedded in HTML. Stored text stays unescaped.
    escapeHtml?: boolean;
  }
): string {
  const maxLength = opts?.maxLength ?? 5000;
  const collapseWhitespace = opts?.collapseWhitespace ?? true;
  const doEscape = opts?.escapeHtml ?? false;

  let out = String(input);
  out = stripControlChars(out);
  if (collapseWhitespace) {
    out = opts?.preserveNewlines ? normalizeWhitespaceKeepingLines(out) : normalizeWhitespace(out);
  }
  if (doEscape) out = escapeHtml(out);
  if (out.length > maxLength) out = out.slice(0, maxLength);
  return out;
}

export function sanitizeUsername(input: string): string {
  return sanitizePlainText(input, {
    maxLength: 30,
    collapseWhitespace: true,
    escapeHtml: false,
  })
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '');
}
