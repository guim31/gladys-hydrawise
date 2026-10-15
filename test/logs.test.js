// -----------------------------------------------------------------------------
// What the integration writes at the default level (info): the lifecycle
// only. A normal hour writes nothing, a failure that repeats is logged once,
// and its end once, a user command once. Never a password, an API key or a
// token, not even at debug.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { API_KEY, PASSWORD, USERNAME } from './helpers/fakeHydrawise.js';
import { ACCOUNT, FRONT_LAWN, HYBRID, createAll, createWorld, setValue } from './helpers/world.js';

/** Capture the lines of the SDK logger at the given LOG_LEVEL. */
function captureLogs(t, level = 'info') {
  const previous = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = level;
  t.after(() => {
    process.env.LOG_LEVEL = previous;
  });
  const lines = [];
  const record =
    (stream) =>
    (...args) =>
      lines.push({
        stream,
        text: args.map((arg) => (arg instanceof Error ? arg.stack : String(arg))).join(' '),
      });
  t.mock.method(console, 'log', record('out'));
  t.mock.method(console, 'error', record('err'));
  t.mock.method(console, 'warn', record('err'));
  t.mock.method(console, 'info', record('out'));
  t.mock.method(console, 'debug', record('out'));
  return {
    lines,
    clear: () => lines.splice(0),
    texts: () => lines.map((line) => line.text),
  };
}

async function world(t, options) {
  const w = await createWorld(options);
  t.after(() => w.app.stop());
  return w;
}

async function run(w, minutes) {
  for (let i = 0; i < minutes; i += 1) {
    w.clock.advance(60_000);
    await w.hub.tick();
  }
}

test('a normal hour of refreshes writes nothing at info', async (t) => {
  const logs = captureLogs(t);
  const w = await world(t, { config: HYBRID });
  assert.ok(
    logs.texts().some((text) => text.includes('Connected to Hydrawise')),
    'the start is logged',
  );
  await createAll(w);
  logs.clear();
  await run(w, 70); // REST and GraphQL reads, water use, a token refresh, a run ending
  assert.deepEqual(logs.texts(), []);
  assert.ok(w.fake.sceneEvents.length === 1, 'a run ended meanwhile');
});

test('the cloud down for half an hour: one warning, then one line when it is back', async (t) => {
  const logs = captureLogs(t);
  const w = await world(t, { config: ACCOUNT });
  logs.clear();
  w.cloud.online = false;
  await run(w, 30);
  assert.equal(logs.lines.length, 1, logs.texts().join('\n'));
  assert.equal(logs.lines[0].stream, 'err');
  logs.clear();
  w.cloud.online = true;
  await run(w, 20);
  assert.deepEqual(logs.texts().length, 1, logs.texts().join('\n'));
  assert.match(logs.lines[0].text, /answers again/);
});

test('a user command: one line', async (t) => {
  const logs = captureLogs(t);
  const w = await world(t, { config: ACCOUNT });
  await createAll(w);
  logs.clear();
  await setValue(w, `zone_${FRONT_LAWN}_watering`, 1);
  assert.equal(logs.lines.length, 1, logs.texts().join('\n'));
  assert.match(logs.lines[0].text, /Front Lawn watering for 10 min/);
});

test('a refused password: one error, never the password', async (t) => {
  const logs = captureLogs(t);
  const w = await world(t, { config: { ...ACCOUNT, password: 'my-wrong-password' } });
  await run(w, 65);
  const errors = logs.lines.filter((line) => line.stream === 'err');
  assert.equal(errors.length, 1, logs.texts().join('\n'));
  assert.ok(!logs.texts().join('\n').includes('my-wrong-password'));
});

test('LOG_LEVEL=debug shows the reads, never a secret', async (t) => {
  const logs = captureLogs(t, 'debug');
  const w = await world(t, { config: HYBRID });
  await createAll(w);
  await run(w, 65);
  await setValue(w, `zone_${FRONT_LAWN}_watering`, 1);
  w.cloud.fail.rest = 500;
  w.cloud.fail.graphql = 503;
  await run(w, 40);
  w.cloud.fail.rest = null;
  w.cloud.apiKey = 'rotated';
  await run(w, 5);
  const text = logs.texts().join('\n');
  assert.match(text, /\[DEBUG\].*Reading/);
  const secrets = [PASSWORD, API_KEY, ...w.cloud.accessTokens.keys(), ...w.cloud.refreshTokens];
  for (const secret of secrets) {
    assert.ok(!text.includes(secret), `a secret leaked into the logs: ${secret.slice(0, 4)}…`);
  }
  assert.ok(!text.includes(USERNAME), 'nor the e-mail');
  assert.ok(!text.includes('api_key='), 'nor a REST URL');
});
