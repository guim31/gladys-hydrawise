// -----------------------------------------------------------------------------
// The answers of the two Hydrawise APIs, turned into one plain model the rest
// of the integration reads. Pure functions, every time in epoch milliseconds.
//
//   controller { id, name, model, serial, online, lastContact, zones,
//                rainSensors: [{ id, name, active }], hasFlowSensor }
//   zone       { id, number, name,
//                run: { startedAt, endsAt } | null,       watering now
//                next: { startsAt, minutes } | null,      next scheduled run
//                suspendedUntil: ms | Infinity | null }   schedule suspended
//
// The REST rules come from pydrawise (Zone.update_with_json), which learnt
// them on real accounts: `time` 1 means "running, `run` seconds left", the
// sentinel 1576800000 (or `type` 110) means "suspended or held by a rain
// sensor" without telling which, any other `time` is "next run in that many
// seconds".
// -----------------------------------------------------------------------------

export const REST_SUSPENDED_SENTINEL = 1576800000;
const REST_HELD_TYPE = 110;

// The REST API has no "online" flag: a controller seen by the cloud within
// this window counts as online.
export const REST_ONLINE_WINDOW_MS = 60 * 60_000;

const GALLON_LITERS = 3.785411784;

const seconds = (value) => (Number.isFinite(Number(value)) ? Number(value) : null);
const timestampMs = (dateTime) => {
  const value = seconds(dateTime?.timestamp);
  return value === null || value <= 0 ? null : value * 1000;
};
const text = (value, fallback = '') => (typeof value === 'string' ? value.trim() : fallback);

/** A zone whose suspension is still running at `now`. */
export const isSuspended = (zone, now) =>
  zone.suspendedUntil !== null && zone.suspendedUntil !== undefined && zone.suspendedUntil > now;

/** A zone watering at `now`. */
export const isRunning = (zone) => zone.run !== null && zone.run !== undefined;

function sortZones(zones) {
  return zones.sort((a, b) => a.number - b.number || a.id - b.id);
}

function zoneFromGraphql(raw, now) {
  const current = raw.scheduledRuns?.currentRun ?? null;
  const next = raw.scheduledRuns?.nextRun ?? null;
  let run = null;
  if (current) {
    const remaining = seconds(current.remainingTime);
    const endsAt = remaining !== null ? now + remaining * 1000 : timestampMs(current.endTime);
    run = { startedAt: timestampMs(current.startTime), endsAt: endsAt ?? now };
  }
  const startsAt = next ? timestampMs(next.startTime) : null;
  return {
    id: Number(raw.id),
    number: Number(raw.number?.value) || 0,
    name: text(raw.name),
    run,
    next: startsAt === null ? null : { startsAt, minutes: Math.round(seconds(next.duration) ?? 0) },
    suspendedUntil: run ? null : timestampMs(raw.status?.suspendedUntil),
  };
}

/**
 * The model of the GraphQL `me` answer (READ_QUERY).
 * @returns {{ units: 'metric'|'imperial', controllers: object[] }}
 */
export function fromGraphql(me, now) {
  const controllers = (me?.controllers ?? []).filter(Boolean).map((raw) => {
    const sensors = (raw.sensors ?? []).filter(Boolean);
    return {
      id: Number(raw.id),
      name: text(raw.name),
      model: text(raw.hardware?.model?.description) || text(raw.hardware?.model?.name) || null,
      serial: text(raw.hardware?.serialNumber) || null,
      online: raw.online === null || raw.online === undefined ? null : raw.online === true,
      lastContact: timestampMs(raw.lastContactTime),
      // Home Assistant's rule: a sensor whose model says "rain sensor".
      rainSensors: sensors
        .filter((sensor) => /rain sensor/i.test(text(sensor.model?.name)))
        .map((sensor) => ({
          id: Number(sensor.id),
          name: text(sensor.name),
          active: sensor.status?.active === true,
        })),
      hasFlowSensor: sensors.some((sensor) => sensor.model?.sensorType === 'FLOW'),
      zones: sortZones((raw.zones ?? []).filter(Boolean).map((zone) => zoneFromGraphql(zone, now))),
    };
  });
  return {
    units: me?.units?.unitsName === 'imperial' ? 'imperial' : 'metric',
    controllers: controllers.filter((controller) => Number.isSafeInteger(controller.id)),
  };
}

/**
 * The controllers of the REST `customerdetails.php` answer (no zones yet).
 * @returns {object[]}
 */
export function fromRestCustomer(details, now) {
  let list = Array.isArray(details?.controllers) ? details.controllers : [];
  if (list.length === 0 && details?.controller_id) {
    list = [{ controller_id: details.controller_id, name: details.current_controller }];
  }
  return list
    .filter((raw) => raw && Number.isSafeInteger(Number(raw.controller_id)))
    .map((raw) => {
      const lastContact = seconds(raw.last_contact) ? seconds(raw.last_contact) * 1000 : null;
      return {
        id: Number(raw.controller_id),
        name: text(raw.name),
        model: null,
        serial: text(raw.serial_number) || null,
        online: lastContact === null ? null : now - lastContact < REST_ONLINE_WINDOW_MS,
        lastContact,
        rainSensors: [],
        hasFlowSensor: false,
        zones: [],
      };
    });
}

/**
 * Apply a REST `statusschedule.php` answer to a controller of the model.
 * @param {object} controller updated in place
 * @param {object} schedule the answer
 * @param {number} now
 * @param {object} options
 * @param {boolean} options.trustSuspension the REST API is the only source
 *   (no account): its ambiguous sentinel counts as a suspension. With the
 *   account, GraphQL knows the real suspensions: the sentinel then only
 *   confirms a suspension already known, never creates one (a rain sensor
 *   holding the zones made them flap between suspended and not).
 * @returns {number|null} `nextpoll`, the delay in seconds the service suggests
 */
export function applyRestSchedule(controller, schedule, now, { trustSuspension }) {
  const known = new Map(controller.zones.map((zone) => [zone.id, zone]));
  for (const relay of schedule?.relays ?? []) {
    const id = Number(relay?.relay_id);
    if (!Number.isSafeInteger(id)) {
      continue;
    }
    let zone = known.get(id);
    if (!zone) {
      zone = { id, number: 0, name: '', run: null, next: null, suspendedUntil: null };
      known.set(id, zone);
      controller.zones.push(zone);
    }
    zone.number = Number(relay.relay) || zone.number;
    zone.name = text(relay.name) || zone.name;
    const time = seconds(relay.time);
    const run = seconds(relay.run) ?? 0;
    if (time === 1) {
      // Running: it cannot be suspended at the same time.
      zone.run = { startedAt: zone.run?.startedAt ?? null, endsAt: now + run * 1000 };
      zone.suspendedUntil = null;
    } else if (time === REST_SUSPENDED_SENTINEL || Number(relay.type) === REST_HELD_TYPE) {
      zone.run = null;
      zone.next = null;
      if (trustSuspension) {
        zone.suspendedUntil = zone.suspendedUntil ?? Number.POSITIVE_INFINITY;
      }
    } else {
      zone.run = null;
      zone.next =
        time === null ? null : { startsAt: now + time * 1000, minutes: Math.round(run / 60) };
      if (trustSuspension) {
        zone.suspendedUntil = null;
      }
      // With the account, the suspension stays as GraphQL said: the REST API
      // cannot represent a suspension with an end date.
    }
  }
  sortZones(controller.zones);
  const nextPoll = seconds(schedule?.nextpoll);
  return nextPoll !== null && nextPoll > 0 ? nextPoll : null;
}

/**
 * A volume in liters, from the service's localized value.
 * @param {{ value?: number, unit?: string }|null} localized
 * @param {'metric'|'imperial'} units the account units, when the value has none
 */
export function toLiters(localized, units) {
  const value = localized?.value === null ? NaN : Number(localized?.value);
  if (!Number.isFinite(value)) {
    return null;
  }
  const unit = text(localized?.unit).toLowerCase();
  if (/gal/.test(unit)) {
    return value * GALLON_LITERS;
  }
  if (/m3|m³|cubic/.test(unit)) {
    return value * 1000;
  }
  if (unit === '' && units === 'imperial') {
    return value * GALLON_LITERS;
  }
  return value;
}

/**
 * Today's water use of one controller (waterUseQuery), pydrawise's
 * get_water_use_summary: water used per zone by the runs of the watering
 * report, total from the flow meters (also counting water drawn while no zone
 * ran), never less than the zones' sum.
 * @returns {{ totalLiters: number, byZone: Map<number, number> }|null} null without a flow meter
 */
export function waterUseFromGraphql(controllerJson, from, until, units) {
  const sensors = (controllerJson?.sensors ?? []).filter(Boolean);
  const flowSensors = sensors.filter((sensor) => sensor.model?.sensorType === 'FLOW');
  if (flowSensors.length === 0) {
    return null;
  }
  const fromMs = from * 1000;
  const untilMs = until * 1000;
  const byZone = new Map();
  let active = 0;
  for (const entry of controllerJson?.reports?.watering ?? []) {
    const run = entry?.runEvent;
    const start = timestampMs(run?.reportedStartTime);
    const end = timestampMs(run?.reportedEndTime);
    // The report may hold runs outside the window asked for (pydrawise).
    const inside = (t) => t !== null && t >= fromMs && t <= untilMs;
    if (!run?.zone || !(inside(start) || inside(end))) {
      continue;
    }
    const liters = toLiters(run.reportedWaterUsage, units);
    if (liters === null) {
      continue;
    }
    const zoneId = Number(run.zone.id);
    byZone.set(zoneId, (byZone.get(zoneId) ?? 0) + liters);
    active += liters;
  }
  let total = 0;
  for (const sensor of flowSensors) {
    total += toLiters(sensor.flowSummary?.totalWaterVolume, units) ?? 0;
  }
  return { totalLiters: Math.max(total, active), byZone };
}
