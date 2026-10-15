// -----------------------------------------------------------------------------
// Integration configuration: defaults (they mirror the `default` values of the
// manifest `config_schema`, see test/manifest.test.js) and normalization, so
// the rest of the code never deals with strings, blanks or `undefined`.
//
// Two ways to sign in, the two the Hydrawise cloud offers:
//   - the account (e-mail and password): the GraphQL API of the Hydrawise
//     app, complete (sensors, water use, exact suspension dates);
//   - the API key alone (hydrawise.com, Account details): the older REST
//     API, zones and commands only.
// Both together is the Home Assistant setup: GraphQL for the details, REST
// for the frequent refreshes, which spares the small GraphQL budget.
// -----------------------------------------------------------------------------

export const LANGUAGES = ['en', 'fr', 'de', 'es'];

// Watering duration of the zone switch, and default of the widget form, in minutes.
export const RUN_MINUTES = ['5', '10', '15', '20', '30', '45', '60'];

// How long turning the "Automatic watering" switch off suspends the schedule, in days.
export const SUSPEND_DAYS = ['1', '2', '3', '7', '14', '30'];

export const MODES = Object.freeze({
  NONE: 'none', // nothing usable typed yet
  ACCOUNT: 'account', // GraphQL only
  HYBRID: 'hybrid', // GraphQL, and REST for the frequent refreshes
  API_KEY: 'api_key', // REST only
});

export const DEFAULT_CONFIG = {
  username: '',
  password: '',
  api_key: '',
  run_minutes: '10',
  suspend_days: '2',
  language: 'fr',
};

/**
 * @param {Record<string, unknown>} raw the configuration returned by the SDK
 */
export function normalizeConfig(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const text = (key) => (typeof source[key] === 'string' ? source[key].trim() : '');
  const pick = (key, list) => {
    const value = source[key] === undefined || source[key] === null ? '' : String(source[key]);
    return list.includes(value) ? value : DEFAULT_CONFIG[key];
  };

  const username = text('username');
  // Passwords are kept as typed: spaces may be part of them.
  const password = typeof source.password === 'string' ? source.password : '';
  const apiKey = text('api_key');
  const account = username !== '' && password !== '';

  let mode = MODES.NONE;
  if (account) {
    mode = apiKey ? MODES.HYBRID : MODES.ACCOUNT;
  } else if (apiKey) {
    mode = MODES.API_KEY;
  }

  return {
    mode,
    username,
    password,
    apiKey,
    // A half-typed account (an e-mail without password) is worth a message.
    incompleteAccount: !account && (username !== '' || password !== ''),
    runMinutes: Number(pick('run_minutes', RUN_MINUTES)),
    suspendDays: Number(pick('suspend_days', SUSPEND_DAYS)),
    language: LANGUAGES.includes(source.language) ? source.language : DEFAULT_CONFIG.language,
  };
}

/** What the sign-in depends on: a change means a new session. */
export const credentialsSignature = (config) =>
  JSON.stringify([config.mode, config.username, config.password, config.apiKey]);
