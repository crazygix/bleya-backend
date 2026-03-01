import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizePlainText, sanitizePhoneNumber, sanitizeUsername } from '../../utils/sanitize.js';

test('sanitizePlainText escapes HTML and removes control chars', () => {
    const value = sanitizePlainText('hi\u0000 <script>alert(1)</script>');
    assert.equal(value, 'hi &lt;script&gt;alert(1)&lt;/script&gt;');
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

test('sanitizePhoneNumber normalizes punctuation and spacing', () => {
    assert.equal(sanitizePhoneNumber(' +1 (234) 567-8900 '), '+12345678900');
});

test('sanitizePhoneNumber handles clean number', () => {
    assert.equal(sanitizePhoneNumber('+12345678900'), '+12345678900');
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
