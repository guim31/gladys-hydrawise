// -----------------------------------------------------------------------------
// Scene action handlers (manifest `scene_actions`, Gladys 5.1+).
//
// The zone switch of a device already waters for the configured time, and is
// a Gladys scene action ("control a device"). These ones say how long, reach
// a zone by its number or name, every zone at once, and suspend the schedule
// for a number of days. Gladys applies the field defaults to scene actions.
// Throwing fails this action only: the scene logs it and goes on.
// -----------------------------------------------------------------------------

import { MAX_COMMAND_MINUTES, MAX_SUSPEND_DAYS, parseCount } from './hub.js';

// Defaults of the manifest fields (test/manifest.test.js keeps them in sync).
export const DEFAULT_START_MINUTES = 10;
export const DEFAULT_SUSPEND_DAYS = 2;

export const SCENE_ACTIONS = {
  async start_zone(hub, { fields = {} }) {
    const minutes = parseCount(fields.minutes, DEFAULT_START_MINUTES, MAX_COMMAND_MINUTES);
    const started = await hub.startZone(fields.device || null, fields.zone, minutes);
    return { zone: started.label, minutes: started.minutes };
  },

  async stop_watering(hub, { fields = {} }) {
    const zones = await hub.stopWatering(fields.device || null, fields.zone);
    return { zones };
  },

  async suspend_watering(hub, { fields = {} }) {
    const days = parseCount(fields.days, DEFAULT_SUSPEND_DAYS, MAX_SUSPEND_DAYS);
    const until = await hub.suspend(fields.device || null, fields.zone, days);
    return { until: new Date(until).toISOString() };
  },

  async resume_watering(hub, { fields = {} }) {
    await hub.resume(fields.device || null, fields.zone);
    return undefined;
  },
};
