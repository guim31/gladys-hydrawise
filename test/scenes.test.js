// -----------------------------------------------------------------------------
// The scene actions: a zone found by its number or its name (accents and case
// ignored), one controller or all of them, the outputs of the manifest.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ACTION_TEXT } from '../src/texts.js';
import { GREENHOUSE, HOME, createWorld, deviceId } from './helpers/world.js';

async function world(t, options = {}) {
  const w = await createWorld(options);
  t.after(() => w.app.stop());
  return w;
}

test('water a zone by its name, accents and case ignored', async (t) => {
  const w = await world(t);
  const ack = await w.fake.sceneAction('start_zone', { zone: '  vegetable GARDEN ', minutes: 5 });
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(ack.data.outputs, { zone: 'Vegetable Garden', minutes: 5 });
  assert.match(w.cloud.requests.at(-1).query, /startZone\(zoneId: 220002.*customRunDuration: 300/);
});

test('a zone number is ambiguous across controllers: the device decides', async (t) => {
  const w = await world(t);
  const ambiguous = await w.fake.sceneAction('start_zone', { zone: '1', minutes: 5 });
  assert.equal(ambiguous.success, false);
  assert.equal(ambiguous.error, ACTION_TEXT.pickController.en);
  const ack = await w.fake.sceneAction('start_zone', {
    device: deviceId(w.gladys, GREENHOUSE),
    zone: '1',
    minutes: '7',
  });
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(ack.data.outputs, { zone: 'Drip', minutes: 7 });
});

test('an unknown zone, a missing zone, an absurd duration', async (t) => {
  const w = await world(t);
  const unknown = await w.fake.sceneAction('start_zone', { zone: 'Roses', minutes: 5 });
  assert.equal(unknown.error, ACTION_TEXT.unknownZone.en);
  const missing = await w.fake.sceneAction('start_zone', { zone: '', minutes: 5 });
  assert.equal(missing.error, ACTION_TEXT.noZone.en);
  const long = await w.fake.sceneAction('start_zone', { zone: 'Drip', minutes: 100000 });
  assert.equal(long.data.outputs.minutes, 240, 'at most 4 hours');
  const zero = await w.fake.sceneAction('start_zone', { zone: 'Drip', minutes: 0 });
  assert.equal(zero.data.outputs.minutes, 10, 'the default');
});

test('stop one zone, one controller, or everything', async (t) => {
  const w = await world(t);
  let ack = await w.fake.sceneAction('stop_watering', { zone: 'Vegetable Garden' });
  assert.deepEqual(ack.data.outputs, { zones: 1 });
  assert.equal(w.cloud.requests.at(-1).op, 'stopZone');

  ack = await w.fake.sceneAction('stop_watering', { device: deviceId(w.gladys, HOME) });
  assert.equal(ack.success, true);
  assert.equal(w.cloud.count('graphql', 'stopAllZones'), 1);

  ack = await w.fake.sceneAction('stop_watering', {});
  assert.equal(ack.success, true);
  assert.equal(w.cloud.count('graphql', 'stopAllZones'), 3);
});

test('suspend for N days (one zone or all), then resume', async (t) => {
  const w = await world(t);
  let ack = await w.fake.sceneAction('suspend_watering', { days: 3 });
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(ack.data.outputs, { until: '2026-10-18T08:00:00.000Z' });
  assert.equal(w.cloud.count('graphql', 'suspendAllZones'), 2);

  ack = await w.fake.sceneAction('suspend_watering', { zone: 'Front lawn', days: '2' });
  assert.deepEqual(ack.data.outputs, { until: '2026-10-17T08:00:00.000Z' });
  assert.match(
    w.cloud.requests.at(-1).query,
    /suspendZone\(zoneId: 220001, until: "Sat, 17 Oct 26/,
  );

  ack = await w.fake.sceneAction('resume_watering', { device: deviceId(w.gladys, GREENHOUSE) });
  assert.equal(ack.success, true);
  assert.equal(w.cloud.requests.at(-1).op, 'resumeAllZones');
  ack = await w.fake.sceneAction('resume_watering', { zone: 'Back Lawn' });
  assert.equal(ack.success, true);
  assert.equal(w.cloud.requests.at(-1).op, 'resumeZone');
});

test('before the first read, a clear message', async (t) => {
  const w = await world(t, { config: { language: 'en' } });
  const ack = await w.fake.sceneAction('stop_watering', {});
  assert.equal(ack.success, false);
  assert.match(ack.error, /Hydrawise account/);
});
