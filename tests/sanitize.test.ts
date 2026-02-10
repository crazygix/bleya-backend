import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizePlainText, sanitizePhoneNumber, sanitizeUsername } from '../utils/sanitize.js';

test('sanitizePlainText escapes html and removes control chars', () => {
  const value = sanitizePlainText('hi\u0000 <script>alert(1)</script>');
  assert.equal(value, 'hi &lt;script&gt;alert(1)&lt;/script&gt;');
});

test('sanitizePhoneNumber normalizes punctuation and spacing', () => {
  const value = sanitizePhoneNumber(' +1 (234) 567-8900 ');
  assert.equal(value, '+12345678900');
});

test('sanitizeUsername lowercases and strips unsupported chars', () => {
  const value = sanitizeUsername(' _User.Name! ');
  assert.equal(value, '_username');
});
