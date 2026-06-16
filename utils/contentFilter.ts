import { config } from '../config/index.js';
import { ValidationError } from './errors.js';

// Proactive text content filter applied at post time (messages, usernames, bios)
// — the "filter objectionable material" pillar of Apple Guideline 1.2, separate
// from after-the-fact moderation.
//
// The built-in list below is a small starter of common profanity so the filter
// works out of the box. Curate and extend it — especially slurs and any
// CSAM-adjacent terms — via the CONTENT_BLOCKLIST env var (comma-separated) or a
// managed list, rather than growing this array in source. POPULATE IT BEFORE
// LAUNCH: a public chat app is expected to block the obvious worst terms.
const BUILTIN_BLOCKED_TERMS: string[] = [
    'fuck',
    'motherfucker',
    'shit',
    'bitch',
    'cunt',
    'asshole',
    'whore',
];

let cachedTerms: string[] | null = null;

// Normalize to a comparable form: lowercase, strip diacritics, and remove all
// non-alphanumerics so trivial evasion ("f.u.c k", "fück") still matches.
function normalize(value: string): string {
    return value
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9]+/g, '');
}

function getBlockedTerms(): string[] {
    if (!cachedTerms) {
        cachedTerms = [...BUILTIN_BLOCKED_TERMS, ...config.contentFilter.blockedTerms]
            .map((term) => normalize(term))
            .filter((term) => term.length > 0);
    }
    return cachedTerms;
}

export function containsBlockedTerm(text: string): boolean {
    if (!text) {
        return false;
    }
    const normalized = normalize(text);
    if (!normalized) {
        return false;
    }
    return getBlockedTerms().some((term) => normalized.includes(term));
}

export function assertCleanText(text: string, label = 'content'): void {
    if (containsBlockedTerm(text)) {
        throw new ValidationError(`That ${label} isn't allowed. Please remove inappropriate language.`);
    }
}
