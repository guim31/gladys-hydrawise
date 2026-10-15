// -----------------------------------------------------------------------------
// Conformity with the Gladys core, on every device discovered from realistic
// fixtures (the shapes of pydrawise's and Home Assistant's tests): a
// controller with a rain sensor and a flow meter, one without, two zones
// sharing a name, an unnamed zone, the three sign-in modes, in every
// feature-name language.
//
// The table (test/fixtures/gladys-feature-table.json) is extracted from the
// core code: a category/type couple missing there shows as "undefined" or
// without icon in Gladys, a poll frequency outside its list is a 400 on
// discovery, a feature without min/max is a 422 on "Add to Gladys".
// Do not loosen this test to make it pass: fix the integration.
// (Adapted from guim31/gladys-wled.)
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  ACCOUNT,
  FakeHydrawise,
  HYBRID,
  KEY_ONLY,
  createAll,
  createClock,
  createWorld,
  loadMe,
} from './helpers/world.js';

const table = JSON.parse(
  await readFile(new URL('./fixtures/gladys-feature-table.json', import.meta.url), 'utf8'),
);

/** The fixture, plus two zones named alike and an unnamed one on the second controller. */
function trickyAccount() {
  const me = loadMe();
  const greenhouse = me.controllers[1];
  const template = greenhouse.zones[1];
  greenhouse.zones.push(
    { ...structuredClone(template), id: 220103, number: { value: 3 }, name: 'Misting' },
    { ...structuredClone(template), id: 220104, number: { value: 4 }, name: '' },
  );
  return me;
}

const scenarios = [
  { label: 'account', config: ACCOUNT },
  { label: 'account + API key', config: HYBRID },
  { label: 'API key only', config: KEY_ONLY },
  { label: 'French names', config: { ...ACCOUNT, language: 'fr' } },
  { label: 'German names', config: { ...ACCOUNT, language: 'de' } },
  { label: 'Spanish names', config: { ...ACCOUNT, language: 'es' } },
];

for (const scenario of scenarios) {
  test(`every discovered device follows the Gladys rules (${scenario.label})`, async () => {
    const clock = createClock();
    const cloud = new FakeHydrawise({ now: clock.now, me: trickyAccount() });
    const w = await createWorld({ clock, cloud, config: scenario.config });
    try {
      await createAll(w);
      const devices = w.fake.discoveredDevices;
      assert.equal(devices.length, 2, 'one device per controller');

      for (const device of devices) {
        const where = device.name;

        // should_poll: true if and only if poll_frequency is provided, in ms.
        if (device.poll_frequency === undefined) {
          assert.notEqual(device.should_poll, true, `${where}: should_poll without poll_frequency`);
        } else {
          assert.equal(device.should_poll, true, `${where}: poll_frequency without should_poll`);
          assert.ok(
            table.poll_frequencies_ms.includes(device.poll_frequency),
            `${where}: poll_frequency ${device.poll_frequency} is not one of ${table.poll_frequencies_ms}`,
          );
        }

        assert.ok(device.features.length > 0, `${where}: no feature`);
        const externalIds = new Set();
        const names = new Set();
        for (const feature of device.features) {
          const at = `${where} / ${feature.name}`;
          const pair = table.pairs[`${feature.category}/${feature.type}`];
          assert.ok(
            pair,
            `${at}: ${feature.category}/${feature.type} is not a couple Gladys knows`,
          );
          assert.ok(
            pair.label_en && pair.label_fr && pair.icon,
            `${at}: couple without label or icon`,
          );

          assert.equal(typeof feature.min, 'number', `${at}: min must be a number`);
          assert.equal(typeof feature.max, 'number', `${at}: max must be a number`);
          assert.ok(
            Number.isFinite(feature.min) && Number.isFinite(feature.max),
            `${at}: finite min/max`,
          );
          assert.ok(feature.min <= feature.max, `${at}: min > max`);
          assert.equal(typeof feature.read_only, 'boolean', `${at}: read_only must be a boolean`);
          assert.equal(
            typeof feature.has_feedback,
            'boolean',
            `${at}: has_feedback must be a boolean`,
          );
          if (feature.unit !== undefined) {
            assert.ok(table.units.includes(feature.unit), `${at}: unknown unit ${feature.unit}`);
            const allowed = table.units_by_category[feature.category];
            if (allowed) {
              assert.ok(
                allowed.includes(feature.unit),
                `${at}: ${feature.unit} for ${feature.category}`,
              );
            }
          }

          assert.ok(!externalIds.has(feature.external_id), `${at}: duplicate external_id`);
          externalIds.add(feature.external_id);
          assert.ok(!names.has(feature.name), `${at}: duplicate feature name on the device`);
          names.add(feature.name);

          // The value published from the fixtures fits the declared bounds.
          const value = w.fake.lastState(feature.external_id);
          if (feature.type === 'text') {
            assert.equal(typeof value, 'string', `${at}: no text published`);
            assert.ok(value.trim().length > 0, `${at}: an empty text is ignored by Gladys`);
            continue;
          }
          assert.equal(typeof value, 'number', `${at}: no state published`);
          assert.ok(value >= feature.min && value <= feature.max, `${at}: ${value} out of bounds`);
          if (feature.type === 'integer' || feature.type === 'binary') {
            assert.ok(Number.isInteger(value), `${at}: ${value} is not an integer`);
          }
        }
      }
    } finally {
      await w.app.stop();
    }
  });
}
