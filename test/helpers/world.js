// -----------------------------------------------------------------------------
// A complete test world: the SDK's fake Gladys, the fake Hydrawise cloud, a
// temporary /data and a manual clock, with the integration wired on top
// through registerHandlers. No timer runs unless `timers: true` (with
// node:test mock timers): the tests drive the hub with `world.hub.tick()`.
// -----------------------------------------------------------------------------

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { registerHandlers } from '../../src/app.js';
import { controllerIds } from '../../src/devices.js';
import { Store } from '../../src/store.js';
import { API_KEY, FakeHydrawise, PASSWORD, T0, USERNAME, loadFixture } from './fakeHydrawise.js';

// The integration logs every change; keep the test output readable.
process.env.LOG_LEVEL ??= 'silent';
// The dates of the text states, in a fixed time zone (Gladys injects its own).
process.env.TZ = 'UTC';

export const ACCOUNT = { username: USERNAME, password: PASSWORD, language: 'en' };
export const HYBRID = { ...ACCOUNT, api_key: API_KEY };
export const KEY_ONLY = { api_key: API_KEY, language: 'en' };

export const HOME = 110001;
export const GREENHOUSE = 110002;
export const FRONT_LAWN = 220001;
export const VEGETABLES = 220002;
export const BACK_LAWN = 220003;
export const DRIP = 220101;

/** A manual clock, shared by the hub and the fake cloud. */
export function createClock(start = T0) {
  const clock = {
    time: start,
    now: () => clock.time,
    advance(ms) {
      clock.time += ms;
    },
  };
  return clock;
}

/**
 * @param {object} [options]
 * @param {object} [options.config] raw integration config
 * @param {FakeHydrawise} [options.cloud]
 * @param {Array} [options.devices] devices already created in Gladys
 */
export async function createWorld({
  clock = createClock(),
  cloud,
  config = ACCOUNT,
  devices = [],
  connect = true,
  dataDir = mkdtempSync(join(tmpdir(), 'gladys-hydrawise-')),
  timings = {},
  timers = false,
  store,
} = {}) {
  const fakeCloud = cloud ?? new FakeHydrawise({ now: clock.now });
  const gladys = createFakeGladys({ config, devices });
  const app = registerHandlers(gladys, {
    store: store ?? new Store(dataDir),
    request: fakeCloud.request,
    timers,
    timings,
    now: clock.now,
    appVersion: 'gladys-hydrawise-test',
  });
  if (connect) {
    await gladys.connect();
    await app.ready;
  }
  return { gladys, fake: gladys.fake, cloud: fakeCloud, app, hub: app.hub, clock, dataDir };
}

export const deviceId = (gladys, controllerId = HOME) => controllerIds(gladys, controllerId).device;
export const featureId = (gladys, key, controllerId = HOME) =>
  controllerIds(gladys, controllerId).feature(key);

/** Add every discovered device in Gladys, as the user would. */
export async function createAll(world) {
  for (const device of world.fake.discoveredDevices) {
    await world.fake.deviceCreated(device);
  }
}

/** The device Gladys holds for a controller (what onSetValue receives). */
export const createdDevice = (world, controllerId = HOME) =>
  world.fake.devices.find((device) => device.external_id === deviceId(world.gladys, controllerId));

/** Turn a feature on or off from Gladys, as the dashboard does. */
export function setValue(world, key, value, controllerId = HOME) {
  const device = createdDevice(world, controllerId);
  const feature = device.features.find(
    (f) => f.external_id === featureId(world.gladys, key, controllerId),
  );
  return world.fake.setValue(device, feature, value);
}

export { FakeHydrawise };

/** A fresh copy of the GraphQL `me` fixture, to edit in a test. */
export const loadMe = () => loadFixture('graphql-me.json');
