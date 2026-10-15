// -----------------------------------------------------------------------------
// The answers of the two APIs turned into the model (src/hydrawise/model.js),
// on the fixtures: pydrawise's REST rules (running, suspended sentinel, held
// by a sensor), the water use of the watering report and the flow meters.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  REST_ONLINE_WINDOW_MS,
  applyRestSchedule,
  fromGraphql,
  fromRestCustomer,
  isSuspended,
  toLiters,
  waterUseFromGraphql,
} from '../src/hydrawise/model.js';
import { T0, loadFixture } from './helpers/fakeHydrawise.js';

const me = loadFixture('graphql-me.json');

test('the GraphQL account: controllers, sensors, zones by number', () => {
  const { units, controllers } = fromGraphql(me, T0);
  assert.equal(units, 'metric');
  assert.deepEqual(
    controllers.map((c) => [c.id, c.name, c.model, c.online]),
    [
      [110001, 'Home Controller', 'HPC 10 Station Controller', true],
      [110002, 'Greenhouse', 'HC 6 Station Controller', true],
    ],
  );
  const [home] = controllers;
  assert.deepEqual(home.rainSensors, [{ id: 330001, name: 'Rain sensor', active: false }]);
  assert.equal(home.hasFlowSensor, true);
  assert.equal(controllers[1].hasFlowSensor, false);
  const [front, vegetables, back] = home.zones;
  assert.deepEqual(front, {
    id: 220001,
    number: 1,
    name: 'Front Lawn',
    run: null,
    next: { startsAt: T0 + 3600_000, minutes: 30 },
    suspendedUntil: null,
  });
  // The end of a run comes from the remaining time (no clock skew).
  assert.deepEqual(vegetables.run, { startedAt: T0 - 120_000, endsAt: T0 + 1680_000 });
  assert.equal(back.suspendedUntil, T0 + 2 * 86_400_000);
  assert.ok(isSuspended(back, T0));
  assert.ok(!isSuspended(back, T0 + 3 * 86_400_000), 'a suspension ends on its own');
});

test('nulls where the schema promises values do not break the model', () => {
  const broken = {
    units: null,
    controllers: [
      null,
      {
        id: 7,
        name: null,
        online: null,
        hardware: null,
        sensors: [null, { id: 1, model: null, status: null }],
        zones: [null, { id: 9, number: null, name: 'Z', scheduledRuns: null, status: null }],
      },
    ],
  };
  const { units, controllers } = fromGraphql(broken, T0);
  assert.equal(units, 'metric');
  assert.equal(controllers.length, 1);
  assert.equal(controllers[0].online, null);
  assert.deepEqual(controllers[0].zones[0].run, null);
  assert.deepEqual(fromGraphql(null, T0).controllers, []);
});

test('the REST status schedule: running, next run, suspended, held (pydrawise rules)', () => {
  const schedule = loadFixture('rest-statusschedule.json');
  const controller = { id: 1, zones: [] };
  const nextPoll = applyRestSchedule(controller, schedule, T0, { trustSuspension: true });
  assert.equal(nextPoll, 60);
  const byName = Object.fromEntries(controller.zones.map((zone) => [zone.name, zone]));
  assert.deepEqual(byName['Zone A'].next, { startsAt: T0 + 5400_000, minutes: 30 });
  assert.equal(byName['Zone A'].run, null);
  assert.deepEqual(byName['Zone B'].run, { startedAt: null, endsAt: T0 + 1788_000 });
  assert.equal(byName['Zone C'].suspendedUntil, Number.POSITIVE_INFINITY);
  assert.equal(byName['Zone G'].suspendedUntil, Number.POSITIVE_INFINITY, 'type 110: held');
  assert.equal(byName['Zone D'].number, 4);
  assert.deepEqual(
    controller.zones.map((zone) => zone.number),
    [1, 2, 3, 4, 7],
  );
});

test('with the account, the REST sentinel never creates a suspension, nor clears one', () => {
  const schedule = loadFixture('rest-statusschedule.json');
  const until = T0 + 86_400_000;
  const controller = {
    id: 1,
    zones: [
      { id: 220203, number: 3, name: 'Zone C', run: null, next: null, suspendedUntil: until },
      { id: 220201, number: 1, name: 'Zone A', run: null, next: null, suspendedUntil: until },
      { id: 220207, number: 7, name: 'Zone G', run: null, next: null, suspendedUntil: null },
    ],
  };
  applyRestSchedule(controller, schedule, T0, { trustSuspension: false });
  const byId = Object.fromEntries(controller.zones.map((zone) => [zone.id, zone]));
  assert.equal(byId[220203].suspendedUntil, until, 'the real end date is kept');
  assert.equal(byId[220201].suspendedUntil, until, 'REST cannot show a dated suspension');
  assert.equal(byId[220207].suspendedUntil, null, 'held by the rain sensor: not suspended');
});

test('a running zone keeps the start time seen before', () => {
  const schedule = { relays: [{ relay_id: 5, relay: 1, name: 'A', time: 1, run: 600 }] };
  const controller = {
    id: 1,
    zones: [
      {
        id: 5,
        number: 1,
        name: 'A',
        run: { startedAt: T0 - 60_000, endsAt: T0 + 1 },
        next: null,
        suspendedUntil: null,
      },
    ],
  };
  applyRestSchedule(controller, schedule, T0, { trustSuspension: true });
  assert.deepEqual(controller.zones[0].run, { startedAt: T0 - 60_000, endsAt: T0 + 600_000 });
});

test('the REST controller list, online when seen within an hour', () => {
  const controllers = fromRestCustomer(loadFixture('rest-customerdetails.json'), T0);
  assert.deepEqual(
    controllers.map((c) => [c.id, c.name, c.online]),
    [
      [110201, 'Home Controller', true],
      [110202, 'Other Controller', false],
    ],
  );
  assert.ok(T0 - 1792000000 * 1000 > REST_ONLINE_WINDOW_MS);
  // An old answer with the current controller only.
  assert.deepEqual(
    fromRestCustomer({ controller_id: 3, current_controller: 'Solo' }, T0).map((c) => c.name),
    ['Solo'],
  );
});

test('volumes in liters, from liters, gallons or cubic meters', () => {
  assert.equal(toLiters({ value: 10, unit: 'L' }, 'metric'), 10);
  assert.equal(Math.round(toLiters({ value: 10, unit: 'gal' }, 'metric') * 100), 3785);
  assert.equal(toLiters({ value: 1.5, unit: 'm³' }, 'metric'), 1500);
  assert.equal(Math.round(toLiters({ value: 1 }, 'imperial') * 1000), 3785);
  assert.equal(toLiters({ value: null, unit: 'L' }, 'metric'), null);
});

test("today's water use: the report's runs of the day, the flow meter's total", () => {
  const answer = loadFixture('graphql-water-use.json');
  const from = Date.UTC(2026, 9, 15) / 1000;
  const use = waterUseFromGraphql(answer, from, T0 / 1000, 'metric');
  // Yesterday's 300.5 L run is left out.
  assert.equal(Math.round(use.byZone.get(220001) * 10), 1287);
  assert.equal(Math.round(use.byZone.get(220002) * 10), 413);
  assert.equal(use.totalLiters, 182.5, 'the meter also saw water drawn while no zone ran');

  // The meter lagging behind the report: never less than the zones' sum.
  const lagging = structuredClone(answer);
  lagging.sensors[1].flowSummary.totalWaterVolume.value = 100;
  assert.equal(
    Math.round(waterUseFromGraphql(lagging, from, T0 / 1000, 'metric').totalLiters * 10),
    1700,
  );

  // No flow meter: no water use at all (not zero).
  assert.equal(waterUseFromGraphql({ sensors: [] }, from, T0 / 1000, 'metric'), null);
});

test('an imperial account in gallons is converted', () => {
  const answer = loadFixture('graphql-water-use.json');
  for (const entry of answer.reports.watering) {
    entry.runEvent.reportedWaterUsage.unit = 'gal';
  }
  answer.sensors[1].flowSummary.totalWaterVolume = { value: 200, unit: 'gal' };
  const from = Date.UTC(2026, 9, 15) / 1000;
  const use = waterUseFromGraphql(answer, from, T0 / 1000, 'imperial');
  assert.equal(Math.round(use.totalLiters), 757);
  assert.equal(Math.round(use.byZone.get(220001)), 487);
});
