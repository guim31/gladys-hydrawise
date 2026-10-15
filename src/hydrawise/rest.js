// -----------------------------------------------------------------------------
// The older REST API of Hydrawise (https://api.hydrawise.com/api/v1), signed
// with the API key of the account (hydrawise.com, Account details). Still
// served in 2026: pydrawise's RestClient and Home Assistant's hybrid client
// use it. It knows the controllers and their zones, and runs the commands;
// no sensors, no water use, and an ambiguous suspension (see model.js).
//
// The key travels in the query string, as the API requires: no URL is ever
// logged or put in an error message.
// -----------------------------------------------------------------------------

import { ERROR_KINDS, HydrawiseError, kindOfStatus, parseJson } from './errors.js';

export const REST_URL = 'https://api.hydrawise.com/api/v1';

// The REST API answers a wrong key with this body and HTTP 404 (pydrawise).
const INVALID_KEY = 'API key not valid';

// `period_id` of a run or a suspension with a custom duration or date.
const CUSTOM_PERIOD = 999;

export class RestClient {
  /**
   * @param {object} options
   * @param {string} options.apiKey
   * @param {Function} options.request HTTP seam
   */
  constructor({ apiKey, request }) {
    this.apiKey = apiKey;
    this.request = request;
  }

  async get(path, params = {}) {
    const query = new URLSearchParams({ api_key: this.apiKey });
    for (const [key, value] of Object.entries(params)) {
      query.set(key, String(value));
    }
    const response = await this.request(`${REST_URL}/${path}?${query}`, {
      headers: { accept: 'application/json' },
    });
    if (response.status === 404 && response.body.trim() === INVALID_KEY) {
      throw new HydrawiseError(ERROR_KINDS.AUTH, `Hydrawise REST API: ${INVALID_KEY}`, {
        status: 404,
      });
    }
    const kind = kindOfStatus(response.status);
    if (kind) {
      throw new HydrawiseError(kind, `Hydrawise REST API: HTTP ${response.status}`, {
        status: response.status,
      });
    }
    const json = parseJson(response.body, 'Hydrawise REST API');
    if (!json || typeof json !== 'object') {
      throw new HydrawiseError(ERROR_KINDS.API, 'Hydrawise REST API: empty answer');
    }
    return json;
  }

  /** The account and its controllers (`customerdetails.php`). */
  customerDetails() {
    return this.get('customerdetails.php', { type: 'controllers' });
  }

  /** Zones, their next or current run, and `nextpoll` (`statusschedule.php`). */
  statusSchedule(controllerId) {
    return this.get('statusschedule.php', { controller_id: controllerId });
  }

  /** A command (`setzone.php`); a `message_type` "error" is a refusal. */
  async setZone(params) {
    const json = await this.get('setzone.php', params);
    if (json.message_type === 'error') {
      throw new HydrawiseError(
        ERROR_KINDS.REFUSED,
        `Hydrawise refused the command: ${String(json.message ?? '').slice(0, 160)}`,
      );
    }
    return json;
  }

  startZone({ zoneId, seconds }) {
    return this.setZone({
      action: 'run',
      relay_id: zoneId,
      period_id: CUSTOM_PERIOD,
      custom: seconds,
    });
  }

  stopZone({ zoneId }) {
    return this.setZone({ action: 'stop', relay_id: zoneId });
  }

  stopAllZones({ controllerId }) {
    return this.setZone({ action: 'stopall', controller_id: controllerId });
  }

  suspendZone({ zoneId, until }) {
    return this.setZone({
      action: 'suspend',
      relay_id: zoneId,
      period_id: CUSTOM_PERIOD,
      custom: Math.floor(until / 1000),
    });
  }

  suspendAllZones({ controllerId, until }) {
    return this.setZone({
      action: 'suspendall',
      controller_id: controllerId,
      period_id: CUSTOM_PERIOD,
      custom: Math.floor(until / 1000),
    });
  }

  resumeZone({ zoneId }) {
    return this.setZone({ action: 'suspend', relay_id: zoneId, period_id: 0 });
  }

  resumeAllZones({ controllerId }) {
    return this.setZone({ action: 'suspendall', controller_id: controllerId, period_id: 0 });
  }
}
