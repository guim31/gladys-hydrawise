// -----------------------------------------------------------------------------
// The refresh timer of the container. The devices are published with
// should_poll: false, and Gladys does not poll external devices reliably
// (GladysAssistant/Gladys#3198): the states must refresh from the hub's own
// timer, with no onPoll at all.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VEGETABLES, createAll, createClock, createWorld, featureId } from './helpers/world.js';

/** Let the timer callback and the fake network settle. */
const settle = async () => {
  for (let i = 0; i < 20; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

test('the internal timer refreshes the states without any onPoll from Gladys', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const clock = createClock();
  const w = await createWorld({ clock, timers: true });
  t.after(() => w.app.stop());
  const polled = t.mock.method(w.hub, 'pollDevice');
  await createAll(w);
  assert.equal(w.fake.discoveredDevices[0].should_poll, false, 'Gladys is not asked to poll');
  const remaining = featureId(w.gladys, `zone_${VEGETABLES}_remaining`);
  const reads = w.cloud.count('graphql', 'me');

  for (const expected of [27, 26, 25, 24, 23, 22, 21, 20, 19, 18]) {
    clock.advance(60_000);
    t.mock.timers.tick(60_000);
    await settle();
    assert.equal(w.fake.lastState(remaining), expected);
  }
  assert.equal(w.cloud.count('graphql', 'me') - reads, 1, 'one account read in 10 minutes');
  assert.equal(polled.mock.callCount(), 0, 'no onPoll involved');
});

test('the timer stops with the integration', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const clock = createClock();
  const w = await createWorld({ clock, timers: true });
  await w.app.stop();
  const before = w.cloud.requests.length;
  clock.advance(60 * 60_000);
  t.mock.timers.tick(60 * 60_000);
  await settle();
  assert.equal(w.cloud.requests.length, before);
});
