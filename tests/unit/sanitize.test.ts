import test from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml, sanitizePlainText, sanitizeUsername, unescapeHtml } from '../../utils/sanitize.js';

test('sanitizePlainText stores text as typed, minus control chars', () => {
    const value = sanitizePlainText("hi\u0000 it's <b>5 & 6</b>");
    assert.equal(value, "hi it's <b>5 & 6</b>");
});

test('sanitizePlainText escapes HTML only when asked to', () => {
    const value = sanitizePlainText('hi\u0000 <script>alert(1)</script>', { escapeHtml: true });
    assert.equal(value, 'hi &lt;script&gt;alert(1)&lt;/script&gt;');
});

test('sanitizePlainText keeps line breaks when preserveNewlines is set', () => {
    const value = sanitizePlainText('line one  \r\n\n\n\n  line   two\t', { preserveNewlines: true });
    assert.equal(value, 'line one\n\nline two');
});

test('unescapeHtml exactly reverses escapeHtml', () => {
    const original = `a & b <c> "d" 'e' &amp; already`;
    assert.equal(unescapeHtml(escapeHtml(original)), original);
    assert.equal(unescapeHtml('&amp;lt;'), '&lt;');
});

test('sanitizePlainText handles empty string', () => {
    assert.equal(sanitizePlainText(''), '');
});

test('sanitizePlainText truncates to maxLength', () => {
    const long = 'a'.repeat(100);
    const result = sanitizePlainText(long, { maxLength: 10 });
    assert.equal(result.length, 10);
});

test('sanitizePlainText collapses whitespace by default', () => {
    assert.equal(sanitizePlainText('hello   world'), 'hello world');
});

test('sanitizePlainText preserves whitespace when disabled', () => {
    const result = sanitizePlainText('hello   world', { collapseWhitespace: false, escapeHtml: false });
    assert.equal(result, 'hello   world');
});

test('sanitizePlainText handles unicode content', () => {
    const result = sanitizePlainText('Hello 你好 🌍');
    assert.ok(result.includes('Hello'));
    assert.ok(result.includes('你好'));
});

test('sanitizeUsername lowercases and strips unsupported chars', () => {
    assert.equal(sanitizeUsername(' _User.Name! '), '_username');
});

test('sanitizeUsername handles already clean input', () => {
    assert.equal(sanitizeUsername('alice'), 'alice');
});

test('sanitizeUsername strips spaces', () => {
    assert.equal(sanitizeUsername('hello world'), 'helloworld');
});
