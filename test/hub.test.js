// -----------------------------------------------------------------------------
// The hub end to end, against the SDK's fake Gladys and the fake Hydrawise
// cloud: the three sign-in modes, the states, the switches, the "watering
// finished" event, the quotas, the failures.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ERROR_KINDS } from '../src/hydrawise/errors.js';
import { HUB_TIMINGS, TRIGGERS, WIDGET_KEY } from '../src/hub.js';
import { CONNECTION_TEXT, ERROR_TEXT } from '../src/texts.js';
import {
  ACCOUNT,
  BACK_LAWN,
  DRIP,
  FRONT_LAWN,
  FakeHydrawise,
  GREENHOUSE,
  HOME,
  HYBRID,
  KEY_ONLY,
  VEGETABLES,
  createAll,
  createClock,
  createWorld,
  deviceId,
  featureId,
  setValue,
} from './helpers/world.js';

const MINUTE = 60_000;

async function world(t, options = {}) {
  const w = await createWorld(options);
  t.after(() => w.app.stop());
  return w;
}

/** Let the clock run `minutes`, one tick per minute, as the timer does. */
async function run(w, minutes) {
  for (let i = 0; i < minutes; i += 1) {
    w.clock.advance(MINUTE);
    await w.hub.tick();
  }
}

const state = (w, key, controllerId = HOME) =>
  w.fake.lastState(featureId(w.gladys, key, controllerId));
const zone = (id, key) => `zone_${id}_${key}`;

// --- Account ------------------------------------------------------------------

test('account: one device per controller, published at start, nothing polled by Gladys', async (t) => {
  const w = await world(t);
  const devices = w.fake.discoveredDevices;
  assert.deepEqual(
    devices.map((device) => [device.external_id, device.name, device.should_poll]),
    [
      [deviceId(w.gladys, HOME), 'Home Controller', false],
      [deviceId(w.gladys, GREENHOUSE), 'Greenhouse', false],
    ],
  );
  assert.equal(devices[0].model, 'HPC 10 Station Controller');
  assert.equal(w.fake.connectionStatus.connected, true);
  // No state before the user adds the devices (Gladys would drop them).
  assert.equal(w.fake.states.length, 0);
  // The sign-in, the account read and today's water use: 2 GraphQL requests.
  assert.deepEqual(
    w.cloud.requests.map((r) => `${r.api}:${r.op}`),
    ['token:token', 'graphql:me', 'graphql:controller'],
  );
});

test('account: the states of an added controller', async (t) => {
  const w = await world(t);
  await createAll(w);
  assert.equal(state(w, 'online'), 1);
  assert.equal(state(w, 'auto_watering'), 1);
  assert.equal(state(w, 'rain_330001'), 0);
  assert.equal(state(w, 'water_today'), 182.5);
  assert.equal(state(w, zone(FRONT_LAWN, 'watering')), 0);
  assert.equal(state(w, zone(FRONT_LAWN, 'next')), 'Thu 15/10, 09:00');
  assert.equal(state(w, zone(FRONT_LAWN, 'water_today')), 128.7);
  assert.equal(state(w, zone(VEGETABLES, 'watering')), 1);
  assert.equal(state(w, zone(VEGETABLES, 'remaining')), 28);
  assert.equal(state(w, zone(BACK_LAWN, 'next')), 'Suspended until Sat 17/10, 08:00');
  assert.equal(state(w, zone(DRIP, 'next'), GREENHOUSE), 'Thu 15/10, 10:00');
  assert.deepEqual(
    w.fake.transports.map((entry) => entry.transport),
    ['cloud', 'cloud'],
  );
});

test('the time left counts down every minute without any request', async (t) => {
  const w = await world(t);
  await createAll(w);
  const requests = w.cloud.requests.length;
  await run(w, 5);
  assert.equal(state(w, zone(VEGETABLES, 'remaining')), 23);
  assert.equal(w.cloud.requests.length, requests, 'counted locally');
});

test('a run that ends fires "watering finished" once, with the zone and the duration', async (t) => {
  const w = await world(t);
  await createAll(w);
  await run(w, 29); // the run ends at 08:28, seen a minute later at most
  assert.equal(state(w, zone(VEGETABLES, 'watering')), 0);
  assert.equal(state(w, zone(VEGETABLES, 'remaining')), 0);
  const events = w.fake.sceneEvents.filter((e) => e.key === TRIGGERS.WATERING_FINISHED);
  assert.deepEqual(events, [
    {
      key: TRIGGERS.WATERING_FINISHED,
      data: {
        device: deviceId(w.gladys, HOME),
        controller: 'Home Controller',
        zone: 'Vegetable Garden',
        zone_number: 2,
        minutes: 30,
      },
    },
  ]);
  // The next reads do not fire it again.
  await run(w, 15);
  assert.equal(w.fake.sceneEvents.length, 1);
});

test('a zone switch waters for the configured time, and stops; no event for a Gladys stop', async (t) => {
  const w = await world(t, { config: { ...ACCOUNT, run_minutes: '15' } });
  await createAll(w);
  assert.deepEqual(await setValue(w, zone(FRONT_LAWN, 'watering'), 1), { success: true });
  const mutation = w.cloud.requests.at(-1);
  assert.equal(mutation.op, 'startZone');
  assert.match(mutation.query, /zoneId: 220001, markRunAsScheduled: false, customRunDuration: 900/);
  assert.equal(state(w, zone(FRONT_LAWN, 'watering')), 1);
  assert.equal(state(w, zone(FRONT_LAWN, 'remaining')), 15);
  assert.ok(w.fake.widgetRefreshes.includes(WIDGET_KEY));

  await run(w, 3);
  assert.deepEqual(await setValue(w, zone(FRONT_LAWN, 'watering'), 0), { success: true });
  assert.equal(w.cloud.requests.at(-1).op, 'stopZone');
  assert.equal(state(w, zone(FRONT_LAWN, 'watering')), 0);
  await run(w, 12);
  assert.deepEqual(
    w.fake.sceneEvents.filter((e) => e.data.zone === 'Front Lawn'),
    [],
    'stopped from Gladys: no event (no loop through a scene)',
  );
});

test('a command the controller has not picked up yet is not undone by the next read', async (t) => {
  const clock = createClock();
  const cloud = new FakeHydrawise({ now: clock.now, commandDelayMs: 90_000 });
  const w = await world(t, { clock, cloud });
  await createAll(w);
  await setValue(w, zone(FRONT_LAWN, 'watering'), 1);
  clock.advance(20_000);
  await w.hub.read(); // the confirmation read: the cloud does not show the run yet
  assert.equal(state(w, zone(FRONT_LAWN, 'watering')), 1);
  clock.advance(80_000);
  await w.hub.read();
  assert.equal(state(w, zone(FRONT_LAWN, 'watering')), 1);
  const published = w.fake.states
    .filter(
      (s) => s.device_feature_external_id === featureId(w.gladys, zone(FRONT_LAWN, 'watering')),
    )
    .map((s) => s.state);
  assert.deepEqual(published, [0, 1], 'no flapping');
});

test('"Automatic watering" off suspends every zone for the configured days, on resumes', async (t) => {
  const w = await world(t, { config: { ...ACCOUNT, suspend_days: '3' } });
  await createAll(w);
  await setValue(w, 'auto_watering', 0);
  const mutation = w.cloud.requests.at(-1);
  assert.equal(mutation.op, 'suspendAllZones');
  assert.match(mutation.query, /controllerId: 110001, until: "Sun, 18 Oct 26 08:00:00 \+0000"/);
  assert.equal(state(w, 'auto_watering'), 0);
  assert.equal(state(w, zone(FRONT_LAWN, 'next')), 'Suspended until Sun 18/10, 08:00');
  assert.equal(state(w, 'auto_watering', GREENHOUSE), 1, 'the other controller is untouched');

  await setValue(w, 'auto_watering', 1);
  assert.equal(w.cloud.requests.at(-1).op, 'resumeAllZones');
  assert.equal(state(w, 'auto_watering'), 1);
  assert.equal(state(w, zone(BACK_LAWN, 'next')), 'No watering scheduled');
  // The cloud agrees at the next read.
  await w.hub.read();
  assert.equal(state(w, zone(BACK_LAWN, 'next')), 'No watering scheduled');
});

test('read-only features refuse a command', async (t) => {
  const w = await world(t);
  await createAll(w);
  const ack = await setValue(w, 'online', 1);
  assert.equal(ack.success, false);
  assert.match(ack.error, /cannot be controlled/);
});

test('account only: a read every 10 minutes, never more than 5 GraphQL requests per 30 minutes', async (t) => {
  const w = await world(t);
  await createAll(w);
  await run(w, 180);
  const graphql = w.cloud.requests.filter((r) => r.api === 'graphql').map((r) => r.at);
  for (const at of graphql) {
    const inWindow = graphql.filter((other) => other >= at && other < at + 30 * MINUTE);
    assert.ok(inWindow.length <= 5, `${inWindow.length} GraphQL requests in 30 min`);
  }
  const reads = w.cloud.count('graphql', 'me');
  assert.ok(reads >= 17 && reads <= 19, `${reads} account reads in 3 hours`);
  assert.equal(w.cloud.count('graphql', 'controller'), 4, 'water use hourly: at 8, 9, 10 and 11');
  assert.deepEqual(
    w.cloud.requests
      .filter((r) => r.api === 'token')
      .map((r) => new URLSearchParams(r.body).get('grant_type')),
    ['password', 'refresh_token', 'refresh_token', 'refresh_token'],
    'the password once, then a refresh before each expiry',
  );
});

test('commands do not spend the read budget, and a spent budget only delays the reads', async (t) => {
  const w = await world(t);
  await createAll(w);
  for (let i = 0; i < 6; i += 1) {
    await setValue(w, zone(FRONT_LAWN, 'watering'), i % 2);
    await w.hub.read();
  }
  const graphql = w.cloud.requests.filter((r) => r.api === 'graphql' && r.op === 'me');
  assert.ok(graphql.length <= 5, 'the budget holds');
  assert.equal(w.fake.connectionStatus.connected, true);
});

// --- Account + API key, API key only ------------------------------------------

test('account + API key: REST every 2 minutes, GraphQL every 30', async (t) => {
  const w = await world(t, { config: HYBRID });
  await createAll(w);
  await run(w, 60);
  assert.equal(w.cloud.count('graphql', 'me'), 3, 'at start, then every 30 minutes');
  // 2 controllers, read every 2 minutes, except at the GraphQL reads.
  const rest = w.cloud.count('rest', 'statusschedule.php');
  assert.ok(rest >= 54 && rest <= 60, `${rest} REST reads`);
  // REST sees the run end and the zones keep their GraphQL suspension.
  assert.equal(state(w, zone(VEGETABLES, 'watering')), 0);
  assert.equal(state(w, zone(BACK_LAWN, 'next')), 'Suspended until Sat 17/10, 08:00');
  assert.equal(state(w, 'water_today'), 182.5, 'water use still read with the account');
});

test('account + API key: the commands still go through GraphQL', async (t) => {
  const w = await world(t, { config: HYBRID });
  await createAll(w);
  await setValue(w, zone(DRIP, 'watering'), 1, GREENHOUSE);
  assert.equal(w.cloud.requests.at(-1).op, 'startZone');
  assert.equal(w.cloud.count('rest', 'setzone.php'), 0);
});

test('account + refused API key: GraphQL only, said in the status', async (t) => {
  const cloud = new FakeHydrawise({ now: createClock().now });
  cloud.apiKey = 'another key';
  const w = await world(t, { cloud, config: HYBRID });
  await createAll(w);
  assert.equal(w.fake.connectionStatus.connected, true);
  assert.deepEqual(w.fake.connectionStatus.message, CONNECTION_TEXT.apiKeyRefused);
  assert.equal(state(w, zone(VEGETABLES, 'watering')), 1);
});

test('API key only: zones and commands through REST, no sensors nor water use', async (t) => {
  const w = await world(t, { config: KEY_ONLY });
  const [home] = w.fake.discoveredDevices;
  const keys = home.features.map((f) => f.external_id.split(':').at(-1));
  assert.ok(!keys.some((key) => key.startsWith('rain_') || key.includes('water_today')));
  await createAll(w);
  assert.equal(state(w, zone(VEGETABLES, 'watering')), 1);
  assert.equal(state(w, zone(BACK_LAWN, 'next')), 'Suspended', 'REST knows no end date');
  assert.equal(state(w, zone(FRONT_LAWN, 'next')), 'Thu 15/10, 09:00');
  await setValue(w, zone(FRONT_LAWN, 'watering'), 1);
  const command = w.cloud.requests.at(-1);
  assert.equal(command.op, 'setzone.php');
  assert.equal(command.params.get('action'), 'run');
  assert.equal(command.params.get('custom'), '600');
  assert.equal(w.cloud.count('token'), 0, 'no sign-in to the account');
});

test('API key serving one controller of two: the other is not refreshed, no error', async (t) => {
  const clock = createClock();
  const cloud = new FakeHydrawise({ now: clock.now, apiKeyControllers: [HOME] });
  const w = await world(t, { clock, cloud, config: KEY_ONLY });
  await createAll(w);
  assert.equal(w.fake.connectionStatus.connected, true);
  await run(w, 10);
  assert.equal(state(w, zone(VEGETABLES, 'watering')), 1);
  const refused = cloud.requests.filter(
    (r) => r.op === 'statusschedule.php' && r.params.get('controller_id') === String(GREENHOUSE),
  );
  assert.equal(refused.length, 1, 'asked once, then left alone');
});

// --- Failures -----------------------------------------------------------------------

test('a wrong password: not connected, the reason said, not retried in a loop', async (t) => {
  const w = await world(t, { config: { ...ACCOUNT, password: 'wrong' } });
  assert.equal(w.fake.connectionStatus.connected, false);
  assert.deepEqual(w.fake.connectionStatus.message, ERROR_TEXT[ERROR_KINDS.AUTH]);
  await run(w, 29);
  assert.equal(w.cloud.count('token'), 1);
  await run(w, 2);
  assert.equal(w.cloud.count('token'), 2, 'tried again after 30 minutes');
  // The user fixes the password: signed in at once.
  await w.fake.configUpdated(ACCOUNT);
  assert.equal(w.fake.connectionStatus.connected, true);
});

test('HTTP 429: GraphQL rests 30 minutes, the data stays, then reads again', async (t) => {
  const w = await world(t);
  await createAll(w);
  w.cloud.fail.graphql = 429;
  await run(w, 10);
  const failed = w.cloud.count('graphql');
  w.cloud.fail.graphql = null;
  await run(w, 25);
  assert.equal(w.cloud.count('graphql'), failed, 'no GraphQL request while it rests');
  assert.equal(state(w, 'online'), 1, 'still online: the cloud answered');
  await run(w, 10);
  assert.ok(w.cloud.count('graphql') > failed);
});

test('the cloud unreachable: offline, then back', async (t) => {
  const w = await world(t);
  await createAll(w);
  w.cloud.online = false;
  await run(w, 10);
  assert.equal(state(w, 'online'), 0);
  assert.equal(w.fake.transports.at(-1).transport, 'unreachable');
  assert.equal(w.fake.connectionStatus.connected, false);
  w.cloud.online = true;
  await run(w, 10);
  assert.equal(state(w, 'online'), 1);
  assert.equal(w.fake.transports.at(-1).transport, 'cloud');
  assert.equal(w.fake.connectionStatus.connected, true);
});

test('a controller offline in Hydrawise: its "Online" feature and transport say so', async (t) => {
  const w = await world(t);
  await createAll(w);
  w.cloud.controllers.get(GREENHOUSE).online = false;
  await run(w, 10);
  assert.equal(state(w, 'online', GREENHOUSE), 0);
  assert.equal(state(w, 'online', HOME), 1);
});

test('a command refused by Hydrawise is reported, the state unchanged', async (t) => {
  const w = await world(t);
  await createAll(w);
  w.cloud.fail.graphql = 500;
  const ack = await setValue(w, zone(FRONT_LAWN, 'watering'), 1);
  assert.equal(ack.success, false);
  assert.equal(ack.error, ERROR_TEXT[ERROR_KINDS.API].en);
  assert.equal(state(w, zone(FRONT_LAWN, 'watering')), 0);
});

// --- Gladys side --------------------------------------------------------------------

test('not configured: a status saying what to type, no request', async (t) => {
  const w = await world(t, { config: { language: 'en' } });
  assert.deepEqual(w.fake.connectionStatus, {
    connected: false,
    message: CONNECTION_TEXT.notConfigured,
  });
  assert.equal(w.cloud.requests.length, 0);
  const incomplete = await world(t, { config: { username: 'a@example.invalid' } });
  assert.deepEqual(incomplete.fake.connectionStatus.message, CONNECTION_TEXT.incomplete);
});

test('a device added later gets every state at once, and the widget is refreshed', async (t) => {
  const w = await world(t);
  await createAll(w);
  const before = w.fake.states.length;
  await w.fake.deviceUpdated(w.fake.devices[0]);
  await w.fake.deviceCreated(w.fake.devices[0]);
  const resent = w.fake.states.slice(before);
  assert.ok(resent.length >= 15, `${resent.length} states sent again`);
  assert.ok(w.fake.widgetRefreshes.includes(WIDGET_KEY));
});

test('onPoll is a fallback: it reads only when a read is due', async (t) => {
  const w = await world(t);
  await createAll(w);
  const device = w.fake.devices[0];
  const reads = w.cloud.count('graphql', 'me');
  await w.fake.poll(device);
  assert.equal(w.cloud.count('graphql', 'me'), reads);
  w.clock.advance(HUB_TIMINGS.accountReadMs);
  await w.fake.poll(device);
  assert.equal(w.cloud.count('graphql', 'me'), reads + 1);
});

test('the language of the configuration names the features and writes the texts', async (t) => {
  const w = await world(t, { config: { ...ACCOUNT, language: 'fr' } });
  const names = w.fake.discoveredDevices[0].features.map((f) => f.name);
  assert.ok(names.includes('Arrosage automatique'));
  assert.ok(names.includes('Front Lawn · prochain arrosage'));
  await createAll(w);
  assert.equal(state(w, zone(FRONT_LAWN, 'next')), 'jeu. 15/10 09:00');
  await w.fake.configUpdated({ ...ACCOUNT, language: 'de' });
  assert.equal(state(w, zone(FRONT_LAWN, 'next')), 'Do., 15.10., 09:00');
  assert.ok(
    w.fake.discoveredDevices[0].features.some((f) => f.name === 'Automatische Bewässerung'),
  );
});

test('a Gladys restart: the devices and the states are sent again', async (t) => {
  const w = await world(t);
  await createAll(w);
  const before = w.fake.states.length;
  await w.gladys.disconnect();
  await w.gladys.connect();
  assert.ok(w.fake.states.length - before >= 15);
});

test('the scan of the Discovery tab reads the account again', async (t) => {
  const w = await world(t);
  const reads = w.cloud.count('graphql', 'me');
  w.clock.advance(MINUTE);
  await w.fake.scanRequest();
  assert.equal(w.cloud.count('graphql', 'me'), reads + 1);
});

test('"Test the connection" reports every controller', async (t) => {
  const w = await world(t);
  const ack = await w.fake.action('test_connection', {});
  assert.equal(ack.success, true);
  assert.equal(
    ack.data.message.en,
    [
      'Signed in with the account (GraphQL API).',
      'Home Controller: 3 zone(s), 1 watering now.',
      'Greenhouse: 2 zone(s).',
    ].join('\n'),
  );
  const refused = await world(t, { config: { ...ACCOUNT, password: 'wrong' } });
  const failed = await refused.fake.action('test_connection', {});
  assert.equal(failed.success, false);
  assert.equal(failed.error, ERROR_TEXT[ERROR_KINDS.AUTH].en);
});
