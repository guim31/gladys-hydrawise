// -----------------------------------------------------------------------------
// Dashboard widget (manifest `widgets`, Gladys 5.1+): `irrigation`.
//
// The use case: from the wall tablet, see which zone is watering and until
// when, start a zone for a few minutes (the vegetable patch, a new lawn),
// stop everything (someone is in the garden), suspend the schedule for a few
// days (it rained) and resume it.
//
// Budget (8 components, 6 tiles, 2 texts, 1 status, 4 buttons): up to two
// tiles (zones watering now, water used today with a flow meter), one status
// list (a row per zone, ten at most) and four buttons. The zone and duration
// forms (widget action fields, GladysAssistant/Gladys#3168) need Gladys 5.2.0,
// the manifest minimum.
//
// One controller (chosen in the widget settings), or all of them.
// -----------------------------------------------------------------------------

import { WIDGET_COLORS } from '@gladysassistant/integration-sdk';
import { LANGUAGES, MODES, RUN_MINUTES, SUSPEND_DAYS } from './config.js';
import { controllerName, remainingMinutes, zoneLabels } from './devices.js';
import { ERROR_KINDS } from './hydrawise/errors.js';
import { isRunning, isSuspended } from './hydrawise/model.js';
import { MAX_COMMAND_MINUTES, WIDGET_KEY, parseCount } from './hub.js';
import {
  ACTION_TEXT,
  CONNECTION_TEXT,
  ERROR_TEXT,
  done,
  formatDate,
  formatTime,
  pick,
} from './texts.js';

// Action keys of the buttons: permanent once published (unique, the core
// drops a button whose key is taken).
export const ACTIONS = Object.freeze({
  START: 'start_zone',
  STOP_ALL: 'stop_all',
  SUSPEND: 'suspend',
  RESUME: 'resume',
});

const MAX_ROWS = 10;
const ACTIVE_ICON = 'check-circle';

export const TEXT = {
  wateringNow: { en: 'Watering now', fr: 'En arrosage', de: 'Bewässert gerade', es: 'Regando' },
  waterToday: { en: 'Water today', fr: "Eau aujourd'hui", de: 'Wasser heute', es: 'Agua hoy' },
  watering: { en: 'Watering', fr: 'Arrosage', de: 'Bewässerung', es: 'Riego' },
  until: { en: 'until', fr: "jusqu'à", de: 'bis', es: 'hasta' },
  suspended: { en: 'Suspended', fr: 'Suspendue', de: 'Ausgesetzt', es: 'Suspendida' },
  none: { en: 'Nothing scheduled', fr: 'Rien de prévu', de: 'Nichts geplant', es: 'Nada previsto' },
  offline: { en: 'Offline', fr: 'Hors ligne', de: 'Offline', es: 'Sin conexión' },
  more: { en: 'more zones', fr: 'zones de plus', de: 'weitere Zonen', es: 'zonas más' },
  start: { en: 'Water…', fr: 'Arroser…', de: 'Bewässern…', es: 'Regar…' },
  stopAll: { en: 'Stop all', fr: 'Tout arrêter', de: 'Alles stoppen', es: 'Detener todo' },
  suspend: { en: 'Suspend…', fr: 'Suspendre…', de: 'Aussetzen…', es: 'Suspender…' },
  resume: { en: 'Resume', fr: 'Reprendre', de: 'Fortsetzen', es: 'Reanudar' },
  zone: { en: 'Zone', fr: 'Zone', de: 'Zone', es: 'Zona' },
  minutes: {
    en: 'Duration (minutes)',
    fr: 'Durée (minutes)',
    de: 'Dauer (Minuten)',
    es: 'Duración (minutos)',
  },
  days: { en: 'Days', fr: 'Jours', de: 'Tage', es: 'Días' },
  unknown: {
    en: 'This controller is no longer in the Hydrawise account: choose another one in the widget settings.',
    fr: "Ce programmateur n'est plus dans le compte Hydrawise : choisissez-en un autre dans les réglages du widget.",
    de: 'Dieses Steuergerät ist nicht mehr im Hydrawise-Konto: Wähle ein anderes in den Widget-Einstellungen.',
    es: 'Este programador ya no está en la cuenta Hydrawise: elija otro en la configuración del widget.',
  },
  waiting: {
    en: 'Connecting to Hydrawise…',
    fr: 'Connexion à Hydrawise…',
    de: 'Verbindung mit Hydrawise…',
    es: 'Conectando con Hydrawise…',
  },
  stale: {
    en: 'Hydrawise does not answer: last known state.',
    fr: 'Hydrawise ne répond pas : dernier état connu.',
    de: 'Hydrawise antwortet nicht: letzter bekannter Zustand.',
    es: 'Hydrawise no responde: último estado conocido.',
  },
  updateGladys: {
    en: 'Update Gladys to 5.2.0 or later to choose the zone and the duration.',
    fr: 'Mettez Gladys à jour (5.2.0 ou plus) pour choisir la zone et la durée.',
    de: 'Aktualisiere Gladys auf 5.2.0 oder neuer, um Zone und Dauer zu wählen.',
    es: 'Actualice Gladys a la versión 5.2.0 o posterior para elegir la zona y la duración.',
  },
};

const t = (text, language) => pick(text, language);
const fit = (text, max) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

function message(text, language) {
  return {
    ttl_seconds: 300,
    components: [{ type: 'text', variant: 'body', text: t(text, language) }],
  };
}

/** The status row of one zone. */
export function zoneRow(label, zone, now, language) {
  if (isRunning(zone)) {
    return {
      label: fit(label, 40),
      icon: 'droplet',
      value: fit(
        `${t(TEXT.watering, language)} · ${remainingMinutes(zone, now)} min ` +
          `(${t(TEXT.until, language)} ${formatTime(zone.run.endsAt, language)})`,
        40,
      ),
      color: WIDGET_COLORS.PRIMARY,
    };
  }
  if (isSuspended(zone, now)) {
    return {
      label: fit(label, 40),
      icon: 'pause-circle',
      value: Number.isFinite(zone.suspendedUntil)
        ? fit(
            `${t(TEXT.suspended, language)} · ${formatDate(zone.suspendedUntil, language, { weekday: false })}`,
            40,
          )
        : t(TEXT.suspended, language),
      color: WIDGET_COLORS.WARNING,
    };
  }
  if (zone.next && zone.next.startsAt > now - 60_000) {
    return {
      label: fit(label, 40),
      icon: 'clock',
      value: fit(`${formatDate(zone.next.startsAt, language)} · ${zone.next.minutes} min`, 40),
      color: WIDGET_COLORS.NEUTRAL,
    };
  }
  return {
    label: fit(label, 40),
    icon: 'minus-circle',
    value: t(TEXT.none, language),
    color: WIDGET_COLORS.NEUTRAL,
  };
}

/** The zones of the view, with their labels (prefixed by the controller when several). */
function zonesOf(controllers, language) {
  const labelsIn = (lang) =>
    controllers.map((controller) => [controller, zoneLabels(controller, lang)]);
  const byLanguage = Object.fromEntries(LANGUAGES.map((lang) => [lang, labelsIn(lang)]));
  const labelOf = (lang, index, zone) => {
    const [controller, labels] = byLanguage[lang][index];
    return controllers.length > 1
      ? `${controllerName(controller)} · ${labels.get(zone.id)}`
      : labels.get(zone.id);
  };
  return controllers.flatMap((controller, index) =>
    controller.zones.map((zone) => ({
      controller,
      zone,
      label: labelOf(language, index, zone),
      // The options of a form are multi-language objects ("Zone 3" when unnamed).
      labels: Object.fromEntries(
        LANGUAGES.map((lang) => [lang, fit(labelOf(lang, index, zone), 60)]),
      ),
    })),
  );
}

// "2 days", for the suspension form.
const DAYS_LABEL = {
  en: (days) => `${days} day${days === '1' ? '' : 's'}`,
  fr: (days) => `${days} jour${days === '1' ? '' : 's'}`,
  de: (days) => `${days} Tag${days === '1' ? '' : 'e'}`,
  es: (days) => `${days} día${days === '1' ? '' : 's'}`,
};

export function buttons(entries, { language, runMinutes, suspendDays, now }) {
  const allSuspended = entries.length > 0 && entries.every(({ zone }) => isSuspended(zone, now));
  return [
    {
      type: 'button',
      label: t(TEXT.start, language),
      icon: 'droplet',
      style: 'secondary',
      action: {
        key: ACTIONS.START,
        fields: [
          {
            key: 'zone',
            type: 'select',
            required: true,
            label: TEXT.zone,
            ...(entries[0] ? { default: `${entries[0].controller.id}:${entries[0].zone.id}` } : {}),
            options: entries.map(({ controller, zone, labels }) => ({
              value: `${controller.id}:${zone.id}`,
              label: labels,
            })),
          },
          {
            key: 'minutes',
            type: 'number',
            required: true,
            min: 1,
            max: MAX_COMMAND_MINUTES,
            default: runMinutes,
            label: TEXT.minutes,
          },
        ],
      },
    },
    {
      type: 'button',
      label: t(TEXT.stopAll, language),
      icon: 'square',
      style: 'secondary',
      action: { key: ACTIONS.STOP_ALL },
    },
    {
      type: 'button',
      label: t(TEXT.suspend, language),
      // The schedule suspended everywhere: said by the icon (never the
      // style: `primary` is invisible in dark mode).
      icon: allSuspended ? ACTIVE_ICON : 'pause',
      style: 'secondary',
      action: {
        key: ACTIONS.SUSPEND,
        fields: [
          {
            key: 'days',
            type: 'select',
            required: true,
            label: TEXT.days,
            default: String(suspendDays),
            options: SUSPEND_DAYS.map((days) => ({
              value: days,
              label: Object.fromEntries(LANGUAGES.map((lang) => [lang, DAYS_LABEL[lang](days)])),
            })),
          },
        ],
      },
    },
    {
      type: 'button',
      label: t(TEXT.resume, language),
      icon: allSuspended ? 'play' : ACTIVE_ICON,
      style: 'secondary',
      action: { key: ACTIONS.RESUME },
    },
  ];
}

/** The controllers the widget shows: the one of its settings, or all of them. */
function view(hub, settings) {
  if (!settings?.device) {
    return [...hub.controllers.values()];
  }
  const controller = [...hub.controllers.values()].find(
    (c) => hub.gladys.externalIds('controller', String(c.id)).device === settings.device,
  );
  return controller ? [controller] : [];
}

async function get(hub, { settings, language = 'en' }) {
  const config = hub.config;
  if (!config || config.mode === MODES.NONE) {
    return message(
      config?.incompleteAccount ? CONNECTION_TEXT.incomplete : CONNECTION_TEXT.notConfigured,
      language,
    );
  }
  if (hub.controllers.size === 0) {
    if (hub.error && hub.error.kind !== ERROR_KINDS.RATE_LIMITED) {
      return message(ERROR_TEXT[hub.error.kind], language);
    }
    return message(hub.reachable ? CONNECTION_TEXT.noController : TEXT.waiting, language);
  }
  const controllers = view(hub, settings);
  if (controllers.length === 0) {
    return message(TEXT.unknown, language);
  }
  const now = hub.now();
  const entries = zonesOf(controllers, language);
  const components = [];
  if (hub.reachable === false) {
    components.push({ type: 'text', variant: 'caption', text: t(TEXT.stale, language) });
  }
  const watering = entries.filter(({ zone }) => isRunning(zone)).length;
  components.push({
    type: 'value',
    value: watering,
    label: t(TEXT.wateringNow, language),
    icon: 'droplet',
    color: watering > 0 ? WIDGET_COLORS.PRIMARY : WIDGET_COLORS.NEUTRAL,
  });
  const uses = controllers
    .filter((controller) => controller.hasFlowSensor)
    .map((controller) => hub.waterUseOf(controller, now))
    .filter(Boolean);
  if (uses.length > 0) {
    components.push({
      type: 'value',
      value: Math.round(uses.reduce((sum, use) => sum + use.totalLiters, 0)),
      unit: 'L',
      label: t(TEXT.waterToday, language),
      icon: 'bar-chart-2',
    });
  }

  // The zones watering first, then by number; a last row counts the others.
  const sorted = [...entries].sort((a, b) => Number(isRunning(b.zone)) - Number(isRunning(a.zone)));
  const items = [];
  for (const controller of controllers) {
    if (controller.online === false) {
      items.push({
        label: fit(controllerName(controller), 40),
        icon: 'wifi-off',
        value: t(TEXT.offline, language),
        color: WIDGET_COLORS.DANGER,
      });
    }
  }
  const room = MAX_ROWS - items.length;
  const shown = sorted.length > room ? sorted.slice(0, room - 1) : sorted;
  items.push(...shown.map(({ zone, label }) => zoneRow(label, zone, now, language)));
  if (shown.length < sorted.length) {
    items.push({
      label: `+${sorted.length - shown.length} ${t(TEXT.more, language)}`,
      icon: 'more-horizontal',
      value: '…',
      color: WIDGET_COLORS.NEUTRAL,
    });
  }
  if (items.length > 0) {
    components.push({ type: 'status', items });
  }
  components.push(
    ...buttons(entries, {
      language,
      runMinutes: config.runMinutes,
      suspendDays: config.suspendDays,
      now,
    }),
  );
  // A run counts down: refresh sooner.
  return { ttl_seconds: watering > 0 ? 30 : 120, components };
}

/** The zone of the form's `controllerId:zoneId` value, or null. */
function zoneOfValue(hub, value) {
  const match = String(value ?? '').match(/^(\d+):(\d+)$/);
  const controller = match ? hub.controllers.get(Number(match[1])) : null;
  const zone = controller?.zones.find((z) => z.id === Number(match[2]));
  return zone ? { controller, zone } : null;
}

async function action(hub, { actionKey, settings, values }) {
  const device = settings?.device || null;
  const language = hub.language();
  if (actionKey === ACTIONS.START) {
    if (!values || values.zone === undefined || values.zone === null) {
      // A Gladys older than 5.2.0 relays the tap without the form.
      throw new Error(t(TEXT.updateGladys, language));
    }
    const target = zoneOfValue(hub, values.zone);
    if (!target) {
      throw new Error(pick(ACTION_TEXT.unknownZone, language));
    }
    const minutes = parseCount(values.minutes, Number(RUN_MINUTES[1]), MAX_COMMAND_MINUTES);
    const label = await hub.startZoneById(target.controller, target.zone, minutes);
    return { message: done('started', label, minutes) };
  }
  if (actionKey === ACTIONS.STOP_ALL) {
    const count = await hub.stopWatering(device, null);
    return { message: done('stopped', count) };
  }
  if (actionKey === ACTIONS.SUSPEND) {
    if (!values || values.days === undefined || values.days === null) {
      throw new Error(t(TEXT.updateGladys, language));
    }
    const until = await hub.suspend(device, null, parseCount(values.days, 1, 365));
    return { message: done('suspended', until) };
  }
  if (actionKey === ACTIONS.RESUME) {
    await hub.resume(device, null);
    return { message: done('resumed') };
  }
  throw new Error(`Unknown action ${actionKey}`);
}

export const WIDGETS = {
  [WIDGET_KEY]: { get, action },
};
