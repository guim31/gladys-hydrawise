// -----------------------------------------------------------------------------
// The `irrigation` dashboard widget: a content that fits the core budget (the
// SDK's own validator), the zone rows, the forms of the buttons (Gladys 5.2),
// and each button doing what it says.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateWidgetContent } from '@gladysassistant/integration-sdk';
import { WIDGET_KEY } from '../src/hub.js';
import { ACTIONS, TEXT } from '../src/widgets.js';
import { CONNECTION_TEXT, ERROR_TEXT } from '../src/texts.js';
import { ERROR_KINDS } from '../src/hydrawise/errors.js';
import {
  ACCOUNT,
  FRONT_LAWN,
  FakeHydrawise,
  GREENHOUSE,
  HOME,
  createClock,
  createWorld,
  deviceId,
  loadMe,
} from './helpers/world.js';

async function world(t, options = {}) {
  const w = await createWorld(options);
  t.after(() => w.app.stop());
  return w;
}

async function content(w, { settings = {}, language = 'en' } = {}) {
  const ack = await w.fake.widgetGet(WIDGET_KEY, { settings, language });
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(validateWidgetContent(ack.data.content), [], 'rendered exactly as sent');
  return ack.data.content;
}

const of = (components, type) => components.filter((c) => c.type === type);

test('every controller: a tile, a row per zone, four buttons, within the budget', async (t) => {
  const w = await world(t);
  const { components, ttl_seconds: ttl } = await content(w);
  assert.equal(ttl, 30, 'a zone is watering: refreshed sooner');
  const [watering, water] = of(components, 'value');
  assert.equal(watering.value, 1);
  assert.equal(water.value, 183);
  assert.equal(water.unit, 'L');
  const [status] = of(components, 'status');
  assert.deepEqual(
    status.items.map((item) => [item.label, item.value]),
    [
      ['Home Controller · Vegetable Garden', 'Watering · 28 min (until 08:28)'],
      ['Home Controller · Front Lawn', 'Thu 15/10, 09:00 · 30 min'],
      ['Home Controller · Back Lawn', 'Suspended · 17/10, 08:00'],
      ['Greenhouse · Drip', 'Thu 15/10, 10:00 · 15 min'],
      ['Greenhouse · Misting', 'Nothing scheduled'],
    ],
  );
  assert.deepEqual(
    of(components, 'button').map((button) => button.action.key),
    [ACTIONS.START, ACTIONS.STOP_ALL, ACTIONS.SUSPEND, ACTIONS.RESUME],
  );
});

test('one controller chosen in the settings', async (t) => {
  const w = await world(t);
  const { components } = await content(w, { settings: { device: deviceId(w.gladys, GREENHOUSE) } });
  const [status] = of(components, 'status');
  assert.deepEqual(
    status.items.map((item) => item.label),
    ['Drip', 'Misting'],
  );
  assert.equal(of(components, 'value').length, 1, 'no flow meter: no water tile');
  const start = of(components, 'button')[0];
  assert.deepEqual(
    start.action.fields[0].options.map((o) => o.value),
    [`${GREENHOUSE}:220101`, `${GREENHOUSE}:220102`],
  );
});

test('the forms: a zone and a duration, a number of days', async (t) => {
  const w = await world(t, { config: { ...ACCOUNT, run_minutes: '20', suspend_days: '7' } });
  const buttons = of((await content(w, { language: 'fr' })).components, 'button');
  const [zone, minutes] = buttons[0].action.fields;
  assert.equal(zone.type, 'select');
  assert.equal(zone.default, `${HOME}:${FRONT_LAWN}`);
  assert.equal(minutes.default, 20);
  assert.deepEqual([minutes.min, minutes.max], [1, 240]);
  const [days] = buttons[2].action.fields;
  assert.equal(days.default, '7');
  assert.equal(buttons[0].label, TEXT.start.fr);
});

test('the buttons water, stop, suspend and resume', async (t) => {
  const w = await world(t);
  const tap = (actionKey, values) =>
    w.fake.widgetAction(
      WIDGET_KEY,
      actionKey,
      {},
      values ? { settings: {}, values } : { settings: {} },
    );

  let ack = await tap(ACTIONS.START, { zone: `${HOME}:${FRONT_LAWN}`, minutes: 12 });
  assert.equal(ack.success, true, ack.error);
  assert.equal(ack.data.message.en, 'Front Lawn: watering for 12 min.');
  assert.match(w.cloud.requests.at(-1).query, /zoneId: 220001.*customRunDuration: 720/);

  ack = await tap(ACTIONS.STOP_ALL);
  assert.equal(ack.data.message.fr, 'Arrosage arrêté (2 zone(s)).');
  assert.deepEqual(
    w.cloud.requests.slice(-2).map((r) => r.query.match(/controllerId: (\d+)/)[1]),
    [String(HOME), String(GREENHOUSE)],
  );

  ack = await tap(ACTIONS.SUSPEND, { days: '3' });
  assert.equal(ack.data.message.en, 'Watering suspended until Sun 18/10, 08:00.');
  assert.equal(w.cloud.count('graphql', 'suspendAllZones'), 2);

  ack = await tap(ACTIONS.RESUME);
  assert.equal(ack.data.message.de, 'Bewässerungsprogramm fortgesetzt.');
  assert.equal(w.cloud.count('graphql', 'resumeAllZones'), 2);
});

test('the check mark tells whether the schedule runs (never the style)', async (t) => {
  const w = await world(t);
  const settings = { device: deviceId(w.gladys, GREENHOUSE) };
  let buttons = of((await content(w, { settings })).components, 'button');
  assert.equal(buttons[3].icon, 'check-circle');
  assert.ok(buttons.every((button) => button.style === 'secondary'));
  await w.fake.widgetAction(WIDGET_KEY, ACTIONS.SUSPEND, {}, { settings, values: { days: '1' } });
  buttons = of((await content(w, { settings })).components, 'button');
  assert.equal(buttons[2].icon, 'check-circle');
  assert.equal(buttons[3].icon, 'play');
});

test('a Gladys older than 5.2.0 (no form values) gets a message, nothing is sent', async (t) => {
  const w = await world(t);
  const requests = w.cloud.requests.length;
  const ack = await w.fake.widgetAction(WIDGET_KEY, ACTIONS.START, {}, { settings: {} });
  assert.equal(ack.success, false);
  assert.equal(ack.error, TEXT.updateGladys.en);
  assert.equal(w.cloud.requests.length, requests);
});

test('not configured, refused, unknown controller: a sentence, not an error', async (t) => {
  const none = await world(t, { config: { language: 'en' } });
  assert.deepEqual((await content(none)).components, [
    { type: 'text', variant: 'body', text: CONNECTION_TEXT.notConfigured.en },
  ]);
  const refused = await world(t, { config: { ...ACCOUNT, password: 'wrong' } });
  assert.equal((await content(refused)).components[0].text, ERROR_TEXT[ERROR_KINDS.AUTH].en);
  const w = await world(t);
  const unknown = await content(w, {
    settings: { device: w.gladys.externalIds('controller', '999').device },
  });
  assert.equal(unknown.components[0].text, TEXT.unknown.en);
});

test('the cloud lost: the last known state, said in a caption', async (t) => {
  const w = await world(t);
  w.cloud.online = false;
  await w.hub.read();
  const { components } = await content(w);
  assert.equal(components[0].type, 'text');
  assert.equal(components[0].text, TEXT.stale.en);
  assert.equal(of(components, 'status').length, 1);
});

test('many zones: ten rows at most, the last one counts the others', async (t) => {
  const me = loadMe();
  const [home] = me.controllers;
  const template = home.zones[0];
  home.zones = Array.from({ length: 14 }, (_, index) => ({
    ...structuredClone(template),
    id: 230000 + index,
    number: { value: index + 1, label: `Zone ${index + 1}` },
    name: `Bed ${index + 1}`,
  }));
  me.controllers = [home];
  const clock = createClock();
  const w = await world(t, { clock, cloud: new FakeHydrawise({ now: clock.now, me }) });
  const [status] = of((await content(w)).components, 'status');
  assert.equal(status.items.length, 10);
  assert.equal(status.items.at(-1).label, '+5 more zones');
});
