import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, MODES, credentialsSignature, normalizeConfig } from '../src/config.js';

test('the defaults: nothing to sign in with, French names, 10 minutes, 2 days', () => {
  assert.deepEqual(normalizeConfig(), {
    mode: MODES.NONE,
    username: '',
    password: '',
    apiKey: '',
    incompleteAccount: false,
    runMinutes: 10,
    suspendDays: 2,
    language: 'fr',
  });
  assert.equal(DEFAULT_CONFIG.language, 'fr');
});

test('the sign-in mode follows what was typed', () => {
  const mode = (raw) => normalizeConfig(raw).mode;
  assert.equal(mode({ username: 'a@b.c', password: 'p' }), MODES.ACCOUNT);
  assert.equal(mode({ username: 'a@b.c', password: 'p', api_key: 'k' }), MODES.HYBRID);
  assert.equal(mode({ api_key: ' k ' }), MODES.API_KEY);
  assert.equal(mode({ username: 'a@b.c', api_key: 'k' }), MODES.API_KEY);
  assert.equal(normalizeConfig({ username: 'a@b.c' }).incompleteAccount, true);
  assert.equal(normalizeConfig({ password: 'p' }).mode, MODES.NONE);
});

test('blanks around the e-mail and the key go, the password stays as typed', () => {
  const config = normalizeConfig({ username: ' a@b.c ', password: ' p ', api_key: ' k ' });
  assert.equal(config.username, 'a@b.c');
  assert.equal(config.password, ' p ');
  assert.equal(config.apiKey, 'k');
});

test('selects outside their options fall back to the defaults', () => {
  const config = normalizeConfig({ run_minutes: '7', suspend_days: 30, language: 'it' });
  assert.equal(config.runMinutes, 10);
  assert.equal(config.suspendDays, 30);
  assert.equal(config.language, 'fr');
  assert.equal(normalizeConfig({ run_minutes: 45 }).runMinutes, 45);
});

test('a new password or key is a new session; the language is not', () => {
  const base = normalizeConfig({ username: 'a@b.c', password: 'p', language: 'en' });
  assert.equal(
    credentialsSignature(base),
    credentialsSignature(normalizeConfig({ username: 'a@b.c', password: 'p', language: 'de' })),
  );
  assert.notEqual(
    credentialsSignature(base),
    credentialsSignature(normalizeConfig({ username: 'a@b.c', password: 'q' })),
  );
});
