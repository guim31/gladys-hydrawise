// -----------------------------------------------------------------------------
// Sign-in to the Hydrawise account (src/hydrawise/auth.js), against the fake
// token endpoint: pydrawise's request, a refresh before expiry, the token kept
// under /data across restarts, a refused password.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLIENT_ID, CLIENT_SECRET, TOKEN_URL, TokenAuth } from '../src/hydrawise/auth.js';
import { ERROR_KINDS } from '../src/hydrawise/errors.js';
import { Store } from '../src/store.js';
import { FakeHydrawise, PASSWORD, USERNAME } from './helpers/fakeHydrawise.js';
import { createClock } from './helpers/world.js';

function setup({ password = PASSWORD, dataDir = mkdtempSync(join(tmpdir(), 'hw-auth-')) } = {}) {
  const clock = createClock();
  const cloud = new FakeHydrawise({ now: clock.now });
  const store = new Store(dataDir);
  const auth = new TokenAuth({
    username: USERNAME,
    password,
    request: cloud.request,
    tokens: store.tokens(),
    now: clock.now,
  });
  return { clock, cloud, store, auth, dataDir };
}

const form = (request) => Object.fromEntries(new URLSearchParams(request.body));

test('the first sign-in is the password grant of pydrawise', async () => {
  const { cloud, auth } = setup();
  assert.equal(await auth.header(), 'bearer access-1');
  const [request] = cloud.requests;
  assert.equal(request.url, TOKEN_URL);
  assert.equal(request.headers['content-type'], 'application/x-www-form-urlencoded');
  assert.deepEqual(form(request), {
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    grant_type: 'password',
    scope: 'all',
    username: USERNAME,
    password: PASSWORD,
  });
});

test('the token is reused, then refreshed 5 minutes before it expires', async () => {
  const { clock, cloud, auth } = setup();
  await auth.header();
  clock.advance(50 * 60_000);
  assert.equal(await auth.header(), 'bearer access-1');
  assert.equal(cloud.count('token'), 1);

  clock.advance(6 * 60_000); // 4 minutes left
  assert.equal(await auth.header(), 'bearer access-2');
  assert.deepEqual(form(cloud.requests[1]), {
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    grant_type: 'refresh_token',
    refresh_token: 'refresh-1',
  });
});

test('concurrent requests share one sign-in', async () => {
  const { cloud, auth } = setup();
  await Promise.all([auth.header(), auth.header(), auth.header()]);
  assert.equal(cloud.count('token'), 1);
});

test('a restart reuses the saved session: no password sent again', async () => {
  const first = setup();
  await first.auth.header();
  await first.store.flush();
  const file = join(first.dataDir, 'hydrawise-session.json');
  const saved = readFileSync(file, 'utf8');
  assert.ok(!saved.includes(USERNAME), 'never the e-mail');
  assert.ok(!saved.includes(PASSWORD), 'never the password');
  assert.equal(statSync(file).mode & 0o777, 0o600);

  // The same /data, a new process, one hour later: the refresh token signs in.
  const second = setup({ dataDir: first.dataDir });
  second.cloud.refreshTokens = first.cloud.refreshTokens;
  second.cloud.issued = first.cloud.issued;
  second.clock.advance(60 * 60_000);
  await second.auth.header();
  assert.equal(form(second.cloud.requests[0]).grant_type, 'refresh_token');
});

test('another account does not reuse the saved session', async () => {
  const first = setup();
  await first.auth.header();
  await first.store.flush();
  const other = new TokenAuth({
    username: 'someone.else@example.invalid',
    password: 'x',
    request: first.cloud.request,
    tokens: new Store(first.dataDir).tokens(),
    now: first.clock.now,
  });
  await assert.rejects(other.header(), { kind: ERROR_KINDS.AUTH });
  assert.equal(form(first.cloud.requests.at(-1)).grant_type, 'password');
});

test('a refused refresh falls back to the password', async () => {
  const { clock, cloud, auth } = setup();
  await auth.header();
  cloud.refreshTokens.clear(); // revoked
  clock.advance(58 * 60_000);
  assert.equal(await auth.header(), 'bearer access-2');
  assert.deepEqual(
    cloud.requests.map((r) => form(r).grant_type),
    ['password', 'refresh_token', 'password'],
  );
});

test('a wrong password is an AUTH error with the words of the service, not the password', async () => {
  const { auth } = setup({ password: 'wrong-password' });
  await assert.rejects(auth.header(), (err) => {
    assert.equal(err.kind, ERROR_KINDS.AUTH);
    assert.match(err.message, /credentials were incorrect/);
    assert.ok(!err.message.includes('wrong-password'));
    return true;
  });
});

test('a 5xx or a 429 of the token endpoint is not a refused password', async () => {
  const { cloud, auth } = setup();
  cloud.fail.token = 503;
  await assert.rejects(auth.header(), { kind: ERROR_KINDS.API });
  cloud.fail.token = 429;
  await assert.rejects(auth.header(), { kind: ERROR_KINDS.RATE_LIMITED });
  cloud.fail.token = null;
  assert.equal(await auth.header(), 'bearer access-1');
});

test('invalidate() forces a new token at the next request', async () => {
  const { cloud, auth } = setup();
  await auth.header();
  auth.invalidate();
  assert.equal(await auth.header(), 'bearer access-2');
  assert.equal(cloud.count('token'), 2);
});
