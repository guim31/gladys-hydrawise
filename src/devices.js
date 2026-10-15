// -----------------------------------------------------------------------------
// One Gladys device per Hydrawise controller, one group of features per zone.
//
// External ids are built from the cloud ids Hydrawise gives the controller
// and its zones (the same in the GraphQL and the REST APIs): they survive a
// renamed zone, a changed sign-in mode, a reinstalled integration. They are
// permanent: never change a key below.
//
//   controller   online            input/binary          read only
//                auto_watering     switch/binary         0 = schedule suspended
//                rain_<sensor id>  rain-sensor/binary    if a rain sensor is wired
//                water_today       water-valve/daily-irrigation-volume, liters,
//                                  if a flow meter is wired (account sign-in)
//   each zone    zone_<id>_watering   switch/binary      1 = watering now
//                zone_<id>_remaining  duration/integer   minutes left, 0 at rest
//                zone_<id>_next       text/text          next run, or suspension
//                zone_<id>_water_today  liters, with a flow meter
//
// Gladys never polls these devices (should_poll: false): the hub refreshes
// them on its own timer, at a pace set by the Hydrawise quotas (src/hub.js).
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as CATEGORIES,
  DEVICE_FEATURE_TYPES as TYPES,
  DEVICE_FEATURE_UNITS as UNITS,
} from '@gladysassistant/integration-sdk';
import { isRunning, isSuspended } from './hydrawise/model.js';
import { nextRunText } from './texts.js';

export const DEVICE_TYPE = 'controller';

// Feature names, by language (the language of the configuration). Zone
// features are "<zone> · <name>". Names are fixed when the device is added.
export const NAMES = {
  en: {
    online: 'Online',
    autoWatering: 'Automatic watering',
    rain: 'Rain sensor',
    waterToday: 'Water used today',
    zone: 'Zone',
    watering: 'watering',
    remaining: 'time left',
    next: 'next watering',
    zoneWater: 'water today',
  },
  fr: {
    online: 'En ligne',
    autoWatering: 'Arrosage automatique',
    rain: 'Capteur de pluie',
    waterToday: "Eau consommée aujourd'hui",
    zone: 'Zone',
    watering: 'arrosage',
    remaining: 'temps restant',
    next: 'prochain arrosage',
    zoneWater: "eau aujourd'hui",
  },
  de: {
    online: 'Online',
    autoWatering: 'Automatische Bewässerung',
    rain: 'Regensensor',
    waterToday: 'Wasserverbrauch heute',
    zone: 'Zone',
    watering: 'Bewässerung',
    remaining: 'Restzeit',
    next: 'nächste Bewässerung',
    zoneWater: 'Wasser heute',
  },
  es: {
    online: 'En línea',
    autoWatering: 'Riego automático',
    rain: 'Sensor de lluvia',
    waterToday: 'Agua consumida hoy',
    zone: 'Zona',
    watering: 'riego',
    remaining: 'tiempo restante',
    next: 'próximo riego',
    zoneWater: 'agua hoy',
  },
};

// Display bounds (the core never applies them on write): a run lasts at most
// a day, a garden does not use 100 m³ a day.
export const MAX_RUN_MINUTES = 1440;
export const MAX_DAILY_LITERS = 100_000;

export const controllerIds = (gladys, controllerId) =>
  gladys.externalIds(DEVICE_TYPE, String(controllerId));

export const FEATURE_KEYS = {
  online: 'online',
  autoWatering: 'auto_watering',
  waterToday: 'water_today',
  rain: (sensorId) => `rain_${sensorId}`,
  zoneWatering: (zoneId) => `zone_${zoneId}_watering`,
  zoneRemaining: (zoneId) => `zone_${zoneId}_remaining`,
  zoneNext: (zoneId) => `zone_${zoneId}_next`,
  zoneWater: (zoneId) => `zone_${zoneId}_water_today`,
};

/** The controller id of a device or feature external id, null if not ours. */
export function controllerIdOf(gladys, externalId) {
  const prefix = gladys.externalId(`${DEVICE_TYPE}:`);
  if (typeof externalId !== 'string' || !externalId.startsWith(prefix)) {
    return null;
  }
  const id = Number(externalId.slice(prefix.length).split(':')[0]);
  return Number.isSafeInteger(id) ? id : null;
}

/** What a feature external id controls: `{ controllerId, key, zoneId }`. */
export function parseFeatureId(gladys, externalId) {
  const controllerId = controllerIdOf(gladys, externalId);
  if (controllerId === null) {
    return null;
  }
  const key = externalId.slice(controllerIds(gladys, controllerId).device.length + 1);
  const zone = key.match(/^zone_(\d+)_(.+)$/);
  return {
    controllerId,
    key: zone ? `zone_${zone[2]}` : key,
    zoneId: zone ? Number(zone[1]) : null,
  };
}

/** "Front lawn", or "Zone 3" for a zone without name; numbered when two share a name. */
export function zoneLabels(controller, language) {
  const names = NAMES[language] ?? NAMES.en;
  const base = (zone) => zone.name || `${names.zone} ${zone.number || zone.id}`;
  const counts = new Map();
  for (const zone of controller.zones) {
    counts.set(base(zone).toLowerCase(), (counts.get(base(zone).toLowerCase()) ?? 0) + 1);
  }
  return new Map(
    controller.zones.map((zone) => {
      const label = base(zone);
      return [
        zone.id,
        counts.get(label.toLowerCase()) > 1 ? `${zone.number || zone.id}. ${label}` : label,
      ];
    }),
  );
}

export const controllerName = (controller) => controller.name || `Hydrawise ${controller.id}`;

const feature = (spec) => ({
  read_only: true,
  has_feedback: false,
  keep_history: true,
  min: 0,
  max: 1,
  ...spec,
});

/**
 * The discovery payload of a controller.
 * @param {object} gladys
 * @param {object} controller see src/hydrawise/model.js
 * @param {string} language language of the feature names
 */
export function buildDevice(gladys, controller, language = 'fr') {
  const ids = controllerIds(gladys, controller.id);
  const names = NAMES[language] ?? NAMES.en;
  const labels = zoneLabels(controller, language);
  const features = [
    feature({
      name: names.online,
      external_id: ids.feature(FEATURE_KEYS.online),
      category: CATEGORIES.INPUT,
      type: TYPES.SENSOR.BINARY,
    }),
    feature({
      name: names.autoWatering,
      external_id: ids.feature(FEATURE_KEYS.autoWatering),
      category: CATEGORIES.SWITCH,
      type: TYPES.SWITCH.BINARY,
      read_only: false,
      has_feedback: true,
    }),
  ];
  controller.rainSensors.forEach((sensor) => {
    features.push(
      feature({
        name:
          controller.rainSensors.length > 1
            ? `${names.rain} ${sensor.name || sensor.id}`
            : names.rain,
        external_id: ids.feature(FEATURE_KEYS.rain(sensor.id)),
        category: CATEGORIES.RAIN_SENSOR,
        type: TYPES.SENSOR.BINARY,
      }),
    );
  });
  if (controller.hasFlowSensor) {
    features.push(
      feature({
        name: names.waterToday,
        external_id: ids.feature(FEATURE_KEYS.waterToday),
        category: CATEGORIES.WATER_VALVE,
        type: TYPES.WATER_VALVE.DAILY_IRRIGATION_VOLUME,
        unit: UNITS.LITER,
        max: MAX_DAILY_LITERS,
      }),
    );
  }
  for (const zone of controller.zones) {
    const label = labels.get(zone.id);
    features.push(
      feature({
        name: `${label} · ${names.watering}`,
        external_id: ids.feature(FEATURE_KEYS.zoneWatering(zone.id)),
        category: CATEGORIES.SWITCH,
        type: TYPES.SWITCH.BINARY,
        read_only: false,
        has_feedback: true,
      }),
      feature({
        name: `${label} · ${names.remaining}`,
        external_id: ids.feature(FEATURE_KEYS.zoneRemaining(zone.id)),
        category: CATEGORIES.DURATION,
        type: TYPES.DURATION.INTEGER,
        unit: UNITS.MINUTES,
        max: MAX_RUN_MINUTES,
        keep_history: false,
      }),
      // A text state: no history, min/max 0 (NOT NULL columns in Gladys).
      feature({
        name: `${label} · ${names.next}`,
        external_id: ids.feature(FEATURE_KEYS.zoneNext(zone.id)),
        category: CATEGORIES.TEXT,
        type: TYPES.TEXT.TEXT,
        keep_history: false,
        max: 0,
      }),
    );
    if (controller.hasFlowSensor) {
      features.push(
        feature({
          name: `${label} · ${names.zoneWater}`,
          external_id: ids.feature(FEATURE_KEYS.zoneWater(zone.id)),
          category: CATEGORIES.WATER_VALVE,
          type: TYPES.WATER_VALVE.DAILY_IRRIGATION_VOLUME,
          unit: UNITS.LITER,
          max: MAX_DAILY_LITERS,
        }),
      );
    }
  }
  const params = [{ name: 'CONTROLLER_ID', value: String(controller.id) }];
  if (controller.model) {
    params.push({ name: 'MODEL', value: controller.model });
  }
  return {
    name: controllerName(controller),
    external_id: ids.device,
    model: controller.model ?? 'Hydrawise',
    should_poll: false,
    features,
    params,
  };
}

/** Minutes left of a run, rounded up: 0 at rest. */
export const remainingMinutes = (zone, now) =>
  isRunning(zone)
    ? Math.min(MAX_RUN_MINUTES, Math.max(0, Math.ceil((zone.run.endsAt - now) / 60_000)))
    : 0;

/** The automatic schedule runs unless every zone is suspended. */
export const autoWateringOn = (controller, now) =>
  controller.zones.length === 0 || controller.zones.some((zone) => !isSuspended(zone, now));

const round1 = (value) => Math.round(value * 10) / 10;

/**
 * The states of every feature of a controller, in the publishStates format.
 * @param {object} gladys
 * @param {object} controller
 * @param {object} context
 * @param {number} context.now
 * @param {string} context.language
 * @param {boolean} context.reachable the last read of the cloud succeeded
 * @param {{ totalLiters: number, byZone: Map<number, number> }|null} [context.waterUse]
 */
export function featureStates(gladys, controller, { now, language, reachable, waterUse = null }) {
  const ids = controllerIds(gladys, controller.id);
  const states = [
    {
      device_feature_external_id: ids.feature(FEATURE_KEYS.online),
      state: reachable && controller.online !== false ? 1 : 0,
    },
    {
      device_feature_external_id: ids.feature(FEATURE_KEYS.autoWatering),
      state: autoWateringOn(controller, now) ? 1 : 0,
    },
  ];
  for (const sensor of controller.rainSensors) {
    states.push({
      device_feature_external_id: ids.feature(FEATURE_KEYS.rain(sensor.id)),
      state: sensor.active ? 1 : 0,
    });
  }
  if (controller.hasFlowSensor && waterUse) {
    states.push({
      device_feature_external_id: ids.feature(FEATURE_KEYS.waterToday),
      state: round1(Math.min(MAX_DAILY_LITERS, waterUse.totalLiters)),
    });
  }
  for (const zone of controller.zones) {
    states.push(
      {
        device_feature_external_id: ids.feature(FEATURE_KEYS.zoneWatering(zone.id)),
        state: isRunning(zone) ? 1 : 0,
      },
      {
        device_feature_external_id: ids.feature(FEATURE_KEYS.zoneRemaining(zone.id)),
        state: remainingMinutes(zone, now),
      },
      {
        device_feature_external_id: ids.feature(FEATURE_KEYS.zoneNext(zone.id)),
        text: nextRunText(zone, now, language),
      },
    );
    if (controller.hasFlowSensor && waterUse) {
      states.push({
        device_feature_external_id: ids.feature(FEATURE_KEYS.zoneWater(zone.id)),
        state: round1(Math.min(MAX_DAILY_LITERS, waterUse.byZone.get(zone.id) ?? 0)),
      });
    }
  }
  return states;
}
