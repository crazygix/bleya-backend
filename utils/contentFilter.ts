import { config } from '../config/index.js';
import { ValidationError } from './errors.js';

// Proactive text content filter applied at post time (messages, usernames, bios)
// — the "filter objectionable material" pillar of Apple Guideline 1.2, separate
// from after-the-fact moderation.
//
// Terms are matched per word, never across word boundaries (matching the text
// with its spaces removed blocked "who really cares" and "a bit chilly"). A term
// may carry '*' wildcards: 'shit*' matches words starting with it ("shitty"),
// '*shit' words ending with it ("bullshit"), '*fuck*' words containing it, and a
// bare term matches the whole word only. Multi-word terms ("kill yourself")
// match consecutive words.
//
// The built-in list is a small starter of common profanity so the filter works
// out of the box. Curate and extend it — especially slurs and any CSAM-adjacent
// terms — via the CONTENT_BLOCKLIST env var (comma-separated, same wildcard
// syntax) rather than growing this array. POPULATE IT BEFORE LAUNCH.
const BUILTIN_BLOCKED_TERMS: string[] = [
    '*fuck*',
    'shit*',
    '*shit',
    'bitch*',
    '*bitch',
    'cunt*',
    'asshole*',
    'whore*',
    '*whore',
];

interface CompiledTerm {
    words: string[];
    matchStart: boolean;
    matchEnd: boolean;
}

let cachedTerms: CompiledTerm[] | null = null;

// Invisible characters used to split a word without changing how it looks.
const INVISIBLE_CHARS = /[­͏؜ᅟᅠ឴឵᠋-᠏​-‏‪-‮⁠-⁯ㅤ︀-️﻿]/g;
// Removed rather than treated as a word break, so "fu'ck" is still one word.
const APOSTROPHES = /['‘’‛`´]/g;
const COMBINING_MARKS = /\p{M}+/gu;
// Word characters, plus the symbols that commonly stand in for letters.
const WORD_SPLITTER = /[^\p{L}\p{N}@$!|+]+/u;
const HAS_LETTER = /\p{L}/u;

// Cyrillic/Greek letters that look like Latin ones.
const HOMOGLYPHS: Record<string, string> = {
    'а': 'a', 'в': 'b', 'е': 'e', 'ё': 'e', 'з': '3', 'і': 'i', 'ї': 'i', 'ј': 'j', 'к': 'k',
    'м': 'm', 'н': 'h', 'о': 'o', 'р': 'p', 'с': 'c', 'т': 't', 'у': 'y', 'х': 'x', 'ѕ': 's',
    'ԁ': 'd', 'ԛ': 'q', 'ԝ': 'w', 'α': 'a', 'β': 'b', 'ε': 'e', 'η': 'n', 'ι': 'i', 'κ': 'k',
    'ν': 'v', 'ο': 'o', 'ρ': 'p', 'τ': 't', 'υ': 'u', 'χ': 'x', 'ɡ': 'g',
};

// Digits/symbols used as letters. Applied only inside words that also contain a
// letter, so plain numbers ("2025", "4 of us") are left alone.
const LEET: Record<string, string> = {
    '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b',
    '@': 'a', '$': 's', '!': 'i', '|': 'i', '+': 't',
};

function mapChars(value: string, table: Record<string, string>): string {
    let out = '';
    for (const char of value) {
        out += table[char] ?? char;
    }
    return out;
}

function toWords(text: string): string[] {
    const prepared = mapChars(
        text
            .normalize('NFKD')
            .replace(COMBINING_MARKS, '')
            .toLowerCase()
            .replace(INVISIBLE_CHARS, '')
            .replace(APOSTROPHES, ''),
        HOMOGLYPHS
    );

    const words = prepared
        .split(WORD_SPLITTER)
        .filter((word) => word.length > 0)
        .map((word) => (HAS_LETTER.test(word) ? mapChars(word, LEET) : word));

    // Rejoin runs of single characters so "f u c k" / "f.u.c.k" are caught.
    const joined: string[] = [];
    let run = '';
    for (const word of words) {
        if (word.length === 1) {
            run += word;
            continue;
        }
        if (run.length > 1) joined.push(run);
        run = '';
    }
    if (run.length > 1) joined.push(run);

    return [...words, ...joined];
}

function compileTerm(rawTerm: string): CompiledTerm | null {
    const term = rawTerm.trim();
    const matchStart = term.endsWith('*');
    const matchEnd = term.startsWith('*');
    const core = term.replace(/^\*+|\*+$/g, '');

    const words = core
        .normalize('NFKD')
        .replace(COMBINING_MARKS, '')
        .toLowerCase()
        .split(WORD_SPLITTER)
        .filter((word) => word.length > 0);

    return words.length > 0 ? { words, matchStart, matchEnd } : null;
}

function getBlockedTerms(): CompiledTerm[] {
    if (!cachedTerms) {
        cachedTerms = [...BUILTIN_BLOCKED_TERMS, ...config.contentFilter.blockedTerms]
            .map(compileTerm)
            .filter((term): term is CompiledTerm => term !== null);
    }
    return cachedTerms;
}

function wordMatches(word: string, term: CompiledTerm): boolean {
    const core = term.words[0];
    if (term.matchStart && term.matchEnd) return word.includes(core);
    if (term.matchStart) return word.startsWith(core);
    if (term.matchEnd) return word.endsWith(core);
    return word === core;
}

function sequenceMatches(words: string[], term: CompiledTerm): boolean {
    for (let start = 0; start + term.words.length <= words.length; start += 1) {
        if (term.words.every((termWord, offset) => words[start + offset] === termWord)) {
            return true;
        }
    }
    return false;
}

export function containsBlockedTerm(text: string): boolean {
    if (!text) {
        return false;
    }

    const words = toWords(text);
    if (words.length === 0) {
        return false;
    }

    return getBlockedTerms().some((term) => (
        term.words.length === 1
            ? words.some((word) => wordMatches(word, term))
            : sequenceMatches(words, term)
    ));
}

export function assertCleanText(text: string, label = 'content'): void {
    if (containsBlockedTerm(text)) {
        throw new ValidationError(`That ${label} isn't allowed. Please remove inappropriate language.`);
    }
}

export function resetContentFilterCacheForTests(): void {
    cachedTerms = null;
}
