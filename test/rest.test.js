// -----------------------------------------------------------------------------
// The REST API v1 client (src/hydrawise/rest.js): pydrawise's requests, the
// refused key, and an API key that never leaks into an error message.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ERROR_KINDS } from '../src/hydrawise/errors.js';
import { REST_URL, RestClient } from '../src/hydrawise/rest.js';

const KEY = 'SECRET-KEY-123';

function client(response = { status: 200, body: '{"message":"ok","message_type":"info"}' }) {
  const calls = [];
  const request = async (url) => {
    calls.push(new URL(url));
    return typeof response === 'function' ? response(url) : response;
  };
  return { calls, rest: new RestClient({ apiKey: KEY, request }) };
}

test('the commands are the setzone.php calls of pydrawise', async () => {
  const until = Date.UTC(2026, 9, 17, 8);
  const cases = [
    [
      'startZone',
      { zoneId: 5, seconds: 600 },
      { action: 'run', relay_id: '5', period_id: '999', custom: '600' },
    ],
    ['stopZone', { zoneId: 5 }, { action: 'stop', relay_id: '5' }],
    ['stopAllZones', { controllerId: 9 }, { action: 'stopall', controller_id: '9' }],
    [
      'suspendZone',
      { zoneId: 5, until },
      { action: 'suspend', relay_id: '5', period_id: '999', custom: String(until / 1000) },
    ],
    [
      'suspendAllZones',
      { controllerId: 9, until },
      { action: 'suspendall', controller_id: '9', period_id: '999', custom: String(until / 1000) },
    ],
    ['resumeZone', { zoneId: 5 }, { action: 'suspend', relay_id: '5', period_id: '0' }],
    [
      'resumeAllZones',
      { controllerId: 9 },
      { action: 'suspendall', controller_id: '9', period_id: '0' },
    ],
  ];
  for (const [method, args, expected] of cases) {
    const { rest, calls } = client();
    await rest[method](args);
    const [url] = calls;
    assert.equal(`${url.origin}${url.pathname}`, `${REST_URL}/setzone.php`);
    const params = Object.fromEntries(url.searchParams);
    assert.equal(params.api_key, KEY);
    delete params.api_key;
    assert.deepEqual(params, expected, method);
  }
});

test('the reads', async () => {
  const { rest, calls } = client({ status: 200, body: '{"controllers":[]}' });
  await rest.customerDetails();
  await rest.statusSchedule(42);
  assert.deepEqual(
    calls.map((url) => [
      url.pathname.split('/').at(-1),
      url.searchParams.get('type') ?? url.searchParams.get('controller_id'),
    ]),
    [
      ['customerdetails.php', 'controllers'],
      ['statusschedule.php', '42'],
    ],
  );
});

test('a wrong key, a 403, a 429, a 500, a refused command: kinds, never the key', async () => {
  const cases = [
    [{ status: 404, body: 'API key not valid' }, ERROR_KINDS.AUTH],
    [{ status: 403, body: 'Forbidden' }, ERROR_KINDS.AUTH],
    [{ status: 429, body: '' }, ERROR_KINDS.RATE_LIMITED],
    [{ status: 500, body: 'boom' }, ERROR_KINDS.API],
    [{ status: 404, body: 'Not found' }, ERROR_KINDS.API],
    [{ status: 200, body: '{"message":"Zone busy","message_type":"error"}' }, ERROR_KINDS.REFUSED],
  ];
  for (const [response, kind] of cases) {
    const { rest } = client(response);
    await assert.rejects(rest.stopZone({ zoneId: 1 }), (err) => {
      assert.equal(err.kind, kind, JSON.stringify(response));
      assert.ok(!err.message.includes(KEY), 'the key never appears');
      assert.ok(!err.message.includes('api.hydrawise.com'), 'nor the URL');
      return true;
    });
  }
});
