// -----------------------------------------------------------------------------
// The GraphQL API of the Hydrawise app (https://app.hydrawise.com/api/v2/graph),
// as pydrawise uses it: queries with literal arguments, the bearer token of
// src/hydrawise/auth.js, and `appVersion` naming the client.
//
// The selections are the smallest ones that answer the integration's needs:
// Home Assistant had to split pydrawise's complete "user with zones" query,
// which the service answered with HTTP 502 for large accounts
// (home-assistant/core#120128); this one asks for a few scalar fields per zone.
// Every field exists in pydrawise's copy of the service schema
// (pydrawise/hydrawise.graphql), the reference of test/graphql.test.js.
// -----------------------------------------------------------------------------

import { ERROR_KINDS, HydrawiseError, kindOfStatus, parseJson } from './errors.js';

export const GRAPHQL_URL = 'https://app.hydrawise.com/api/v2/graph';

const DATE_TIME = '{ timestamp }';

export const READ_QUERY = `query {
  me {
    units { unitsName }
    controllers {
      id
      name
      online
      lastContactTime ${DATE_TIME}
      hardware { serialNumber model { name description } }
      sensors { id name model { name sensorType } status { active } }
      zones {
        id
        name
        number { value }
        scheduledRuns {
          currentRun { startTime ${DATE_TIME} endTime ${DATE_TIME} duration remainingTime }
          nextRun { startTime ${DATE_TIME} endTime ${DATE_TIME} duration }
        }
        status { suspendedUntil ${DATE_TIME} }
      }
    }
  }
}`;

const int = (value) => {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) {
    throw new Error(`Not an integer: ${value}`);
  }
  return number;
};

/** Water used and watering time since `from`, and the flow meters' totals (epoch seconds). */
export function waterUseQuery(controllerId, from, until) {
  return `query {
  controller(controllerId: ${int(controllerId)}) {
    reports {
      watering(from: ${int(from)}, until: ${int(until)}) {
        runEvent {
          zone { id }
          reportedStartTime ${DATE_TIME}
          reportedEndTime ${DATE_TIME}
          reportedDuration
          reportedWaterUsage { value unit }
        }
      }
    }
    sensors { id model { sensorType } flowSummary(start: ${int(from)}, end: ${int(until)}) { totalWaterVolume { value unit } } }
  }
}`;
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n) => String(n).padStart(2, '0');

/**
 * The date format of the suspension mutations, pydrawise's
 * `%a, %d %b %y %H:%M:%S %z`, written in UTC: "Sun, 01 Jan 23 00:00:00 +0000".
 * @param {number} ms epoch milliseconds
 */
export function formatUntil(ms) {
  const d = new Date(ms);
  return (
    `${DAYS[d.getUTCDay()]}, ${pad(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ` +
    `${pad(d.getUTCFullYear() % 100)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:` +
    `${pad(d.getUTCSeconds())} +0000`
  );
}

const STATUS = '{ status summary }';

/** The mutations the integration sends, by name: `(args) => text`. */
export const MUTATIONS = {
  startZone: ({ zoneId, seconds }) =>
    `mutation { startZone(zoneId: ${int(zoneId)}, markRunAsScheduled: false, customRunDuration: ${int(seconds)}) ${STATUS} }`,
  stopZone: ({ zoneId }) => `mutation { stopZone(zoneId: ${int(zoneId)}) ${STATUS} }`,
  stopAllZones: ({ controllerId }) =>
    `mutation { stopAllZones(controllerId: ${int(controllerId)}) ${STATUS} }`,
  suspendZone: ({ zoneId, until }) =>
    `mutation { suspendZone(zoneId: ${int(zoneId)}, until: ${JSON.stringify(formatUntil(until))}) ${STATUS} }`,
  suspendAllZones: ({ controllerId, until }) =>
    `mutation { suspendAllZones(controllerId: ${int(controllerId)}, until: ${JSON.stringify(formatUntil(until))}) ${STATUS} }`,
  resumeZone: ({ zoneId }) => `mutation { resumeZone(zoneId: ${int(zoneId)}) ${STATUS} }`,
  resumeAllZones: ({ controllerId }) =>
    `mutation { resumeAllZones(controllerId: ${int(controllerId)}) ${STATUS} }`,
};

export class GraphqlClient {
  /**
   * @param {object} options
   * @param {import('./auth.js').TokenAuth} options.auth
   * @param {Function} options.request HTTP seam
   * @param {string} options.appVersion who is asking (`appVersion` parameter)
   * @param {{ warn: Function }} [options.logger]
   */
  constructor({ auth, request, appVersion, logger }) {
    this.auth = auth;
    this.request = request;
    this.url = `${GRAPHQL_URL}?${new URLSearchParams({ appVersion })}`;
    this.logger = logger;
  }

  /** Run a query or a mutation; resolves with its `data`. */
  async execute(query, { retried = false } = {}) {
    const response = await this.request(this.url, {
      method: 'POST',
      headers: {
        authorization: await this.auth.header(),
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({ query }),
      timeoutMs: 60_000,
    });
    const kind = kindOfStatus(response.status);
    if (kind === ERROR_KINDS.AUTH && !retried) {
      // The token may have been revoked before its expiry: one new sign-in.
      this.auth.invalidate();
      return this.execute(query, { retried: true });
    }
    if (kind) {
      throw new HydrawiseError(kind, `Hydrawise API: HTTP ${response.status}`, {
        status: response.status,
      });
    }
    const json = parseJson(response.body, 'Hydrawise API');
    if (Array.isArray(json?.errors) && json.errors.length > 0) {
      const message = String(json.errors[0]?.message ?? 'unknown error').slice(0, 160);
      throw new HydrawiseError(ERROR_KINDS.API, `Hydrawise API: ${message}`);
    }
    if (!json?.data || typeof json.data !== 'object') {
      throw new HydrawiseError(ERROR_KINDS.API, 'Hydrawise API: no data in the answer');
    }
    return json.data;
  }

  /** The account, its controllers, their sensors and zones (READ_QUERY). */
  async readAccount() {
    const data = await this.execute(READ_QUERY);
    if (!data.me || typeof data.me !== 'object') {
      throw new HydrawiseError(ERROR_KINDS.API, 'Hydrawise API: no account in the answer');
    }
    return data.me;
  }

  /** The watering report and the flow meters of one controller (waterUseQuery). */
  async readWaterUse(controllerId, from, until) {
    const data = await this.execute(waterUseQuery(controllerId, from, until));
    return data.controller ?? null;
  }

  /**
   * Send one of MUTATIONS. A status ERROR is a refusal (its summary is the
   * reason), WARNING is logged and accepted, like pydrawise does.
   */
  async mutate(name, args) {
    const data = await this.execute(MUTATIONS[name](args));
    const result = data[name];
    if (result && typeof result === 'object') {
      if (result.status === 'ERROR') {
        throw new HydrawiseError(
          ERROR_KINDS.REFUSED,
          `Hydrawise refused ${name}: ${String(result.summary ?? '').slice(0, 160)}`,
        );
      }
      if (result.status === 'WARNING') {
        this.logger?.warn(`Hydrawise ${name}: ${String(result.summary ?? '').slice(0, 160)}`);
      }
      return;
    }
    if (!result) {
      throw new HydrawiseError(ERROR_KINDS.REFUSED, `Hydrawise refused ${name}`);
    }
  }
}
