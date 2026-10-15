// -----------------------------------------------------------------------------
// Texts the integration sends to Gladys outside the widget (src/widgets.js):
// the text states of the zones, the connection status, errors, the "Test the
// connection" report, command errors. Four languages, the four of the Gladys
// interface; German says "du", Spanish "usted". test/i18n.test.js checks
// every table.
// -----------------------------------------------------------------------------

import { ERROR_KINDS } from './hydrawise/errors.js';
import { isSuspended } from './hydrawise/model.js';

export const pick = (text, language) => text?.[language] ?? text?.en;

// Locales of the dates: 24-hour clocks, day before month.
const LOCALES = { en: 'en-GB', fr: 'fr-FR', de: 'de-DE', es: 'es-ES' };

/**
 * A date as the user reads it: "sam. 18/10 06:00". In the time zone of Gladys,
 * injected by the supervisor as TZ (the container default otherwise).
 */
export function formatDate(ms, language, { weekday = true } = {}) {
  return new Intl.DateTimeFormat(LOCALES[language] ?? LOCALES.en, {
    ...(weekday ? { weekday: 'short' } : {}),
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(ms));
}

/** "06:00", for the end of a run. */
export function formatTime(ms, language) {
  return new Intl.DateTimeFormat(LOCALES[language] ?? LOCALES.en, {
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(ms));
}

export const ZONE_TEXT = {
  none: {
    en: 'No watering scheduled',
    fr: 'Aucun arrosage prévu',
    de: 'Keine Bewässerung geplant',
    es: 'Ningún riego programado',
  },
  suspended: {
    en: 'Suspended',
    fr: 'Suspendue',
    de: 'Ausgesetzt',
    es: 'Suspendida',
  },
  suspendedUntil: {
    en: 'Suspended until',
    fr: "Suspendue jusqu'au",
    de: 'Ausgesetzt bis',
    es: 'Suspendida hasta el',
  },
};

/** The text state "next watering" of a zone. */
export function nextRunText(zone, now, language) {
  if (isSuspended(zone, now)) {
    return Number.isFinite(zone.suspendedUntil)
      ? `${pick(ZONE_TEXT.suspendedUntil, language)} ${formatDate(zone.suspendedUntil, language)}`
      : pick(ZONE_TEXT.suspended, language);
  }
  if (zone.next && zone.next.startsAt > now - 60_000) {
    return formatDate(zone.next.startsAt, language);
  }
  return pick(ZONE_TEXT.none, language);
}

export const INIT_FAILED = {
  en: 'Initialization failed, check the integration logs.',
  fr: "L'initialisation a échoué, consultez les logs de l'intégration.",
  de: 'Initialisierung fehlgeschlagen, sieh dir die Protokolle der Integration an.',
  es: 'La inicialización ha fallado, consulte los registros de la integración.',
};

export const CONNECTION_TEXT = {
  notConfigured: {
    en: 'Enter the e-mail and password of your Hydrawise account, or its API key.',
    fr: "Saisissez l'e-mail et le mot de passe de votre compte Hydrawise, ou sa clé d'API.",
    de: 'Gib die E-Mail und das Passwort deines Hydrawise-Kontos oder dessen API-Schlüssel ein.',
    es: 'Introduzca el correo y la contraseña de su cuenta Hydrawise, o su clave de API.',
  },
  incomplete: {
    en: 'The e-mail and the password of the account go together: fill in both.',
    fr: "L'e-mail et le mot de passe du compte vont ensemble : remplissez les deux.",
    de: 'E-Mail und Passwort des Kontos gehören zusammen: Fülle beide aus.',
    es: 'El correo y la contraseña de la cuenta van juntos: rellene ambos.',
  },
  apiKeyRefused: {
    en: 'API key refused: the account alone refreshes the zones, more slowly.',
    fr: "Clé d'API refusée : le compte seul rafraîchit les zones, plus lentement.",
    de: 'API-Schlüssel abgelehnt: Das Konto allein aktualisiert die Zonen, langsamer.',
    es: 'Clave de API rechazada: la cuenta sola actualiza las zonas, más despacio.',
  },
  noController: {
    en: 'Connected, but the account has no controller.',
    fr: "Connecté, mais le compte n'a aucun programmateur.",
    de: 'Verbunden, aber das Konto hat kein Steuergerät.',
    es: 'Conectado, pero la cuenta no tiene ningún programador.',
  },
};

// One short explanation per error kind (src/hydrawise/errors.js).
export const ERROR_TEXT = {
  [ERROR_KINDS.AUTH]: {
    en: 'Hydrawise refused the sign-in: check the e-mail, the password or the API key.',
    fr: "Hydrawise a refusé la connexion : vérifiez l'e-mail, le mot de passe ou la clé d'API.",
    de: 'Hydrawise hat die Anmeldung abgelehnt: Prüfe E-Mail, Passwort oder API-Schlüssel.',
    es: 'Hydrawise ha rechazado la conexión: compruebe el correo, la contraseña o la clave de API.',
  },
  [ERROR_KINDS.UNREACHABLE]: {
    en: 'The Hydrawise cloud does not answer.',
    fr: 'Le cloud Hydrawise ne répond pas.',
    de: 'Die Hydrawise-Cloud antwortet nicht.',
    es: 'La nube de Hydrawise no responde.',
  },
  [ERROR_KINDS.RATE_LIMITED]: {
    en: 'Hydrawise asks to slow down: the next refresh waits a little.',
    fr: 'Hydrawise demande de ralentir : le prochain rafraîchissement attendra un peu.',
    de: 'Hydrawise bittet um weniger Anfragen: Die nächste Aktualisierung wartet etwas.',
    es: 'Hydrawise pide reducir el ritmo: la próxima actualización esperará un poco.',
  },
  [ERROR_KINDS.API]: {
    en: 'The Hydrawise cloud answered with an error.',
    fr: 'Le cloud Hydrawise a répondu par une erreur.',
    de: 'Die Hydrawise-Cloud hat mit einem Fehler geantwortet.',
    es: 'La nube de Hydrawise ha respondido con un error.',
  },
  [ERROR_KINDS.REFUSED]: {
    en: 'Hydrawise refused the command.',
    fr: 'Hydrawise a refusé la commande.',
    de: 'Hydrawise hat den Befehl abgelehnt.',
    es: 'Hydrawise ha rechazado la orden.',
  },
};

// Errors of the commands (switches, widget, scene actions).
export const ACTION_TEXT = {
  notReady: {
    en: 'Hydrawise is not connected yet: see the Configuration screen.',
    fr: "Hydrawise n'est pas encore connecté : voir l'écran Configuration.",
    de: 'Hydrawise ist noch nicht verbunden: Sieh dir die Konfiguration an.',
    es: 'Hydrawise aún no está conectado: consulte la pantalla de configuración.',
  },
  unknownController: {
    en: 'This controller is not in the Hydrawise account.',
    fr: "Ce programmateur n'est pas dans le compte Hydrawise.",
    de: 'Dieses Steuergerät ist nicht im Hydrawise-Konto.',
    es: 'Este programador no está en la cuenta Hydrawise.',
  },
  pickController: {
    en: 'Several controllers: choose one in the action.',
    fr: "Plusieurs programmateurs : choisissez-en un dans l'action.",
    de: 'Mehrere Steuergeräte: Wähle eines in der Aktion.',
    es: 'Varios programadores: elija uno en la acción.',
  },
  unknownZone: {
    en: 'Zone not found: give its number or its name as in Hydrawise.',
    fr: 'Zone introuvable : indiquez son numéro ou son nom comme dans Hydrawise.',
    de: 'Zone nicht gefunden: Gib ihre Nummer oder ihren Namen wie in Hydrawise an.',
    es: 'Zona no encontrada: indique su número o su nombre como en Hydrawise.',
  },
  ambiguousZone: {
    en: 'Several zones match this name: give the zone number.',
    fr: 'Plusieurs zones portent ce nom : indiquez le numéro de la zone.',
    de: 'Mehrere Zonen passen zu diesem Namen: Gib die Nummer der Zone an.',
    es: 'Varias zonas coinciden con este nombre: indique el número de la zona.',
  },
  noZone: {
    en: 'Choose the zone to water.',
    fr: 'Choisissez la zone à arroser.',
    de: 'Wähle die Zone, die bewässert werden soll.',
    es: 'Elija la zona que desea regar.',
  },
  failed: {
    en: 'The command failed: see the integration logs.',
    fr: "La commande a échoué : voir les logs de l'intégration.",
    de: 'Der Befehl ist fehlgeschlagen: Sieh dir die Protokolle der Integration an.',
    es: 'La orden ha fallado: consulte los registros de la integración.',
  },
  readOnly: {
    en: 'This feature cannot be controlled.',
    fr: 'Cette fonctionnalité ne se pilote pas.',
    de: 'Diese Funktion lässt sich nicht steuern.',
    es: 'Esta función no se puede controlar.',
  },
};

// The "Test the connection" report, one line per controller.
export const REPORT_TEXT = {
  en: {
    mode: {
      account: 'Signed in with the account (GraphQL API).',
      hybrid: 'Signed in with the account and the API key (GraphQL and REST APIs).',
      api_key: 'Signed in with the API key (REST API: no sensors nor water use).',
    },
    controller: (name, zones, watering) =>
      `${name}: ${zones} zone(s)${watering ? `, ${watering} watering now` : ''}.`,
    offline: 'offline',
  },
  fr: {
    mode: {
      account: 'Connecté avec le compte (API GraphQL).',
      hybrid: "Connecté avec le compte et la clé d'API (API GraphQL et REST).",
      api_key: "Connecté avec la clé d'API (API REST : ni capteurs ni consommation).",
    },
    controller: (name, zones, watering) =>
      `${name} : ${zones} zone(s)${watering ? `, ${watering} en arrosage` : ''}.`,
    offline: 'hors ligne',
  },
  de: {
    mode: {
      account: 'Mit dem Konto angemeldet (GraphQL-API).',
      hybrid: 'Mit dem Konto und dem API-Schlüssel angemeldet (GraphQL- und REST-API).',
      api_key: 'Mit dem API-Schlüssel angemeldet (REST-API: keine Sensoren, kein Verbrauch).',
    },
    controller: (name, zones, watering) =>
      `${name}: ${zones} Zone(n)${watering ? `, ${watering} wird bewässert` : ''}.`,
    offline: 'offline',
  },
  es: {
    mode: {
      account: 'Conectado con la cuenta (API GraphQL).',
      hybrid: 'Conectado con la cuenta y la clave de API (API GraphQL y REST).',
      api_key: 'Conectado con la clave de API (API REST: sin sensores ni consumo).',
    },
    controller: (name, zones, watering) =>
      `${name}: ${zones} zona(s)${watering ? `, ${watering} regando` : ''}.`,
    offline: 'sin conexión',
  },
};

// One line in the integration logs, and a toast, per user command.
export const DONE_TEXT = {
  en: {
    started: (zone, minutes) => `${zone}: watering for ${minutes} min.`,
    stopped: (count) => `Watering stopped (${count} zone(s)).`,
    stoppedAll: (count) => `Watering stopped on ${count} controller(s).`,
    suspended: (until) => `Watering suspended until ${formatDate(until, 'en')}.`,
    resumed: () => 'Watering schedule resumed.',
  },
  fr: {
    started: (zone, minutes) => `${zone} : arrosage pendant ${minutes} min.`,
    stopped: (count) => `Arrosage arrêté (${count} zone(s)).`,
    stoppedAll: (count) => `Arrosage arrêté sur ${count} programmateur(s).`,
    suspended: (until) => `Arrosage suspendu jusqu'au ${formatDate(until, 'fr')}.`,
    resumed: () => "Programme d'arrosage repris.",
  },
  de: {
    started: (zone, minutes) => `${zone}: Bewässerung für ${minutes} min.`,
    stopped: (count) => `Bewässerung gestoppt (${count} Zone(n)).`,
    stoppedAll: (count) => `Bewässerung auf ${count} Steuergerät(en) gestoppt.`,
    suspended: (until) => `Bewässerung ausgesetzt bis ${formatDate(until, 'de')}.`,
    resumed: () => 'Bewässerungsprogramm fortgesetzt.',
  },
  es: {
    started: (zone, minutes) => `${zone}: riego durante ${minutes} min.`,
    stopped: (count) => `Riego detenido (${count} zona(s)).`,
    stoppedAll: (count) => `Riego detenido en ${count} programador(es).`,
    suspended: (until) => `Riego suspendido hasta el ${formatDate(until, 'es')}.`,
    resumed: () => 'Programa de riego reanudado.',
  },
};

/** A message built from one DONE_TEXT entry in the four languages. */
export const done = (key, ...args) =>
  Object.fromEntries(Object.entries(DONE_TEXT).map(([lang, text]) => [lang, text[key](...args)]));

/** An Error whose message is the text, in the configured language. */
export const userError = (text, language) => new Error(pick(text, language));
