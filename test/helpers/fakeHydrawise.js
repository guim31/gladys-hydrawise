// -----------------------------------------------------------------------------
// An in-memory Hydrawise cloud, behind the HTTP seam of the integration
// (src/hydrawise/http.js): the token endpoint, the GraphQL API and the REST
// API v1, as pydrawise and its tests describe them, over a small simulation
// of the controllers (runs that end, suspensions, commands). Built from the
// fixtures of test/fixtures (realistic answers, invented identities). No
// network.
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { CLIENT_ID, CLIENT_SECRET, TOKEN_URL } from '../../src/hydrawise/auth.js';
import { GRAPHQL_URL } from '../../src/hydrawise/graphql.js';
import { REST_URL } from '../../src/hydrawise/rest.js';
import { ERROR_KINDS, HydrawiseError } from '../../src/hydrawise/errors.js';
import { REST_SUSPENDED_SENTINEL } from '../../src/hydrawise/model.js';

/** The time of the fixtures: 2026-10-15T08:00:00Z. */
export const T0 = 1792051200 * 1000;
export const USERNAME = 'gardener@example.invalid';
export const PASSWORD = 'correct horse battery staple';
export const API_KEY = 'TESTKEY0123456789ABCDEF';

export const loadFixture = (name) => {
  const data = JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8'));
  delete data._comment;
  return data;
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Thu, 17 Oct 26 08:00:00 +0000" (pydrawise's format, UTC) → epoch ms. */
export function parseUntil(text) {
  const match = String(text).match(
    /^[A-Z][a-z]{2}, (\d{2}) ([A-Z][a-z]{2}) (\d{2}) (\d{2}):(\d{2}):(\d{2}) \+0000$/,
  );
  if (!match) {
    return null;
  }
  const [, day, month, year, hours, minutes, seconds] = match;
  return Date.UTC(2000 + Number(year), MONTHS.indexOf(month), +day, +hours, +minutes, +seconds);
}

const json = (status, body) => ({ status, body: JSON.stringify(body) });
const ts = (ms) => ({ timestamp: Math.floor(ms / 1000), value: new Date(ms).toUTCString() });

export class FakeHydrawise {
  /**
   * @param {object} [options]
   * @param {() => number} [options.now]
   * @param {object} [options.me] the GraphQL `me` fixture
   * @param {object} [options.waterUse] the water use fixture of the first controller
   * @param {number[]|null} [options.apiKeyControllers] controllers the API key serves (all)
   * @param {number} [options.tokenLifetimeS]
   * @param {number} [options.commandDelayMs] commands reach the controller this late
   */
  constructor({
    now = () => T0,
    me = loadFixture('graphql-me.json'),
    waterUse = loadFixture('graphql-water-use.json'),
    username = USERNAME,
    password = PASSWORD,
    apiKey = API_KEY,
    apiKeyControllers = null,
    tokenLifetimeS = 3600,
    commandDelayMs = 0,
  } = {}) {
    this.now = now;
    this.me = me;
    this.waterUse = waterUse;
    this.username = username;
    this.password = password;
    this.apiKey = apiKey;
    this.apiKeyControllers = apiKeyControllers;
    this.tokenLifetimeS = tokenLifetimeS;
    this.commandDelayMs = commandDelayMs;
    this.online = true; // the cloud answers
    /** Failure injection by API: an HTTP status, 'network', or a function returning one. */
    this.fail = { token: null, graphql: null, rest: null };
    /** Every request: `{ api, op, at, url, body, headers }`. */
    this.requests = [];
    this.accessTokens = new Map();
    this.refreshTokens = new Set();
    this.issued = 0;
    this.queue = [];
    this.controllers = new Map();
    for (const raw of me.controllers) {
      const zones = new Map();
      for (const zone of raw.zones) {
        const current = zone.scheduledRuns.currentRun;
        const next = zone.scheduledRuns.nextRun;
        zones.set(zone.id, {
          raw: zone,
          run: current
            ? {
                startedAt: current.startTime.timestamp * 1000,
                endsAt: current.endTime.timestamp * 1000,
              }
            : null,
          next: next ? { startsAt: next.startTime.timestamp * 1000, minutes: next.duration } : null,
          suspendedUntil: zone.status.suspendedUntil
            ? zone.status.suspendedUntil.timestamp * 1000
            : null,
        });
      }
      this.controllers.set(raw.id, { raw, online: raw.online, zones });
    }
    this.request = this.request.bind(this);
  }

  // --- Simulation ---------------------------------------------------------------

  zone(zoneId) {
    for (const controller of this.controllers.values()) {
      if (controller.zones.has(zoneId)) {
        return controller.zones.get(zoneId);
      }
    }
    return null;
  }

  /** Runs end, delayed commands land. */
  sync() {
    const now = this.now();
    const due = this.queue.filter((command) => command.at <= now);
    this.queue = this.queue.filter((command) => command.at > now);
    due.forEach((command) => command.apply(now));
    for (const controller of this.controllers.values()) {
      for (const zone of controller.zones.values()) {
        if (zone.run && zone.run.endsAt <= now) {
          zone.run = null;
        }
      }
    }
  }

  command(apply) {
    if (this.commandDelayMs > 0) {
      this.queue.push({ at: this.now() + this.commandDelayMs, apply });
    } else {
      apply(this.now());
    }
  }

  start(zoneId, seconds) {
    this.command((now) => {
      const zone = this.zone(zoneId);
      zone.run = { startedAt: now, endsAt: now + seconds * 1000 };
    });
  }

  stop(zoneIds) {
    this.command(() => zoneIds.forEach((id) => (this.zone(id).run = null)));
  }

  suspend(zoneIds, until) {
    this.command(() => zoneIds.forEach((id) => (this.zone(id).suspendedUntil = until)));
  }

  zoneIdsOf(controllerId) {
    return [...(this.controllers.get(controllerId)?.zones.keys() ?? [])];
  }

  // --- HTTP ---------------------------------------------------------------------

  failure(api) {
    const fail = typeof this.fail[api] === 'function' ? this.fail[api]() : this.fail[api];
    if (!fail) {
      return null;
    }
    if (fail === 'network') {
      throw new HydrawiseError(ERROR_KINDS.UNREACHABLE, 'Hydrawise unreachable (ECONNRESET)');
    }
    return json(fail, { error: 'server_error', message: `HTTP ${fail}` });
  }

  async request(url, { method = 'GET', headers = {}, body } = {}) {
    if (!this.online) {
      throw new HydrawiseError(ERROR_KINDS.UNREACHABLE, 'Hydrawise unreachable (ENOTFOUND)');
    }
    this.sync();
    const at = this.now();
    if (url === TOKEN_URL) {
      this.requests.push({ api: 'token', op: 'token', at, url, body, headers });
      return this.failure('token') ?? this.token(method, body);
    }
    if (url.startsWith(`${GRAPHQL_URL}?`)) {
      const query = JSON.parse(body).query;
      const op = query.match(/^(?:query|mutation) \{\s*(\w+)/)[1];
      this.requests.push({ api: 'graphql', op, at, url, body, headers, query });
      return this.failure('graphql') ?? this.graphql(headers, query);
    }
    if (url.startsWith(`${REST_URL}/`)) {
      const parsed = new URL(url);
      const op = parsed.pathname.split('/').at(-1);
      this.requests.push({ api: 'rest', op, at, url, params: parsed.searchParams });
      return this.failure('rest') ?? this.rest(op, parsed.searchParams);
    }
    return { status: 404, body: 'Not found' };
  }

  count(api, op) {
    return this.requests.filter((r) => r.api === api && (op === undefined || r.op === op)).length;
  }

  issueToken() {
    this.issued += 1;
    const access = `access-${this.issued}`;
    const refresh = `refresh-${this.issued}`;
    this.accessTokens.set(access, this.now() + this.tokenLifetimeS * 1000);
    this.refreshTokens.add(refresh);
    return json(200, {
      access_token: access,
      refresh_token: refresh,
      token_type: 'bearer',
      expires_in: this.tokenLifetimeS,
    });
  }

  token(method, body) {
    const form = new URLSearchParams(body);
    if (method !== 'POST' || form.get('client_id') !== CLIENT_ID) {
      return json(400, { error: 'invalid_client' });
    }
    if (form.get('client_secret') !== CLIENT_SECRET) {
      return json(400, { error: 'invalid_client' });
    }
    if (form.get('grant_type') === 'refresh_token') {
      if (!this.refreshTokens.delete(form.get('refresh_token'))) {
        return json(400, { error: 'invalid_grant', message: 'Refresh token is invalid' });
      }
      return this.issueToken();
    }
    if (
      form.get('grant_type') === 'password' &&
      form.get('scope') === 'all' &&
      form.get('username') === this.username &&
      form.get('password') === this.password
    ) {
      return this.issueToken();
    }
    return json(400, {
      error: 'invalid_grant',
      message: 'The user credentials were incorrect.',
    });
  }

  authorized(headers) {
    const match = String(headers.authorization ?? '').match(/^bearer (\S+)$/i);
    const expires = match ? this.accessTokens.get(match[1]) : undefined;
    return expires !== undefined && expires > this.now();
  }

  graphql(headers, query) {
    if (!this.authorized(headers)) {
      return { status: 401, body: 'Unauthorized' };
    }
    if (/^query\s*\{\s*me\b/.test(query)) {
      return json(200, { data: { me: this.serializeMe() } });
    }
    const controller = query.match(/controller\(controllerId: (\d+)\)/);
    if (query.startsWith('query') && controller) {
      const id = Number(controller[1]);
      const first = this.me.controllers[0].id;
      return json(200, {
        data: {
          controller: id === first ? this.waterUse : { reports: { watering: [] }, sensors: [] },
        },
      });
    }
    const mutation = query.match(/^mutation \{ (\w+)\(([^)]*)\)/);
    if (!mutation) {
      return json(200, { errors: [{ message: 'Syntax error' }] });
    }
    const args = Object.fromEntries(
      [...mutation[2].matchAll(/(\w+): ("(?:[^"\\]|\\.)*"|[^,\s]+)/g)].map(([, key, value]) => [
        key,
        JSON.parse(value),
      ]),
    );
    const name = mutation[1];
    const ok = { data: { [name]: { status: 'OK', summary: 'Done' } } };
    switch (name) {
      case 'startZone':
        if (!this.zone(args.zoneId)) {
          return json(200, { data: { [name]: { status: 'ERROR', summary: 'Unknown zone' } } });
        }
        this.start(args.zoneId, args.customRunDuration);
        return json(200, ok);
      case 'stopZone':
        this.stop([args.zoneId]);
        return json(200, ok);
      case 'stopAllZones':
        this.stop(this.zoneIdsOf(args.controllerId));
        return json(200, ok);
      case 'suspendZone':
        this.suspend([args.zoneId], parseUntil(args.until));
        return json(200, ok);
      case 'suspendAllZones':
        this.suspend(this.zoneIdsOf(args.controllerId), parseUntil(args.until));
        return json(200, ok);
      case 'resumeZone':
        this.suspend([args.zoneId], null);
        return json(200, ok);
      case 'resumeAllZones':
        this.suspend(this.zoneIdsOf(args.controllerId), null);
        return json(200, ok);
      default:
        return json(200, { errors: [{ message: `Unknown mutation ${name}` }] });
    }
  }

  serializeMe() {
    const now = this.now();
    const me = structuredClone(this.me);
    for (const raw of me.controllers) {
      const controller = this.controllers.get(raw.id);
      raw.online = controller.online;
      for (const zone of raw.zones) {
        const state = controller.zones.get(zone.id);
        zone.scheduledRuns.currentRun = state.run
          ? {
              id: `${zone.id}-${state.run.startedAt}`,
              startTime: ts(state.run.startedAt),
              endTime: ts(state.run.endsAt),
              normalDuration: Math.round((state.run.endsAt - state.run.startedAt) / 60_000),
              duration: Math.round((state.run.endsAt - state.run.startedAt) / 60_000),
              remainingTime: Math.round((state.run.endsAt - now) / 1000),
              status: { value: 2, label: 'Running' },
            }
          : null;
        zone.scheduledRuns.nextRun =
          state.next && state.next.startsAt > now
            ? {
                id: `${zone.id}-${state.next.startsAt}`,
                startTime: ts(state.next.startsAt),
                endTime: ts(state.next.startsAt + state.next.minutes * 60_000),
                normalDuration: state.next.minutes,
                duration: state.next.minutes,
                remainingTime: 0,
                status: { value: 1, label: 'Scheduled' },
              }
            : null;
        zone.status.suspendedUntil =
          state.suspendedUntil && state.suspendedUntil > now ? ts(state.suspendedUntil) : null;
      }
    }
    return me;
  }

  rest(op, params) {
    if (params.get('api_key') !== this.apiKey) {
      return { status: 404, body: 'API key not valid' };
    }
    const controllerId = Number(params.get('controller_id'));
    const served = (id) => this.apiKeyControllers === null || this.apiKeyControllers.includes(id);
    if (op === 'customerdetails.php') {
      const [first] = this.me.controllers;
      return json(200, {
        controller_id: first.id,
        customer_id: this.me.customerId,
        current_controller: first.name,
        controllers: this.me.controllers.map((raw) => ({
          name: raw.name,
          last_contact: raw.lastContactTime.timestamp,
          serial_number: raw.hardware.serialNumber,
          controller_id: raw.id,
          status: 'Unknown',
        })),
      });
    }
    if (op === 'statusschedule.php') {
      if (!this.controllers.has(controllerId) || !served(controllerId)) {
        return { status: 404, body: 'API key not valid' };
      }
      const now = this.now();
      const relays = [...this.controllers.get(controllerId).zones.values()].map(
        ({ raw, run, next, suspendedUntil }) => {
          let time = 31_536_000;
          let seconds = 0;
          if (run) {
            time = 1;
            seconds = Math.round((run.endsAt - now) / 1000);
          } else if (suspendedUntil && suspendedUntil > now) {
            time = REST_SUSPENDED_SENTINEL;
          } else if (next && next.startsAt > now) {
            time = Math.round((next.startsAt - now) / 1000);
            seconds = next.minutes * 60;
          }
          return {
            name: raw.name,
            period: 259200,
            relay: raw.number.value,
            relay_id: raw.id,
            run: seconds,
            stop: 1,
            time,
            timestr: time === 1 ? 'Now' : 'Sat',
            type: 1,
          };
        },
      );
      return json(200, { nextpoll: 60, relays, sensors: [], time: Math.floor(now / 1000) });
    }
    if (op === 'setzone.php') {
      const action = params.get('action');
      const relay = Number(params.get('relay_id'));
      const period = Number(params.get('period_id'));
      const custom = Number(params.get('custom'));
      if (action === 'run') {
        this.start(relay, custom);
      } else if (action === 'stop') {
        this.stop([relay]);
      } else if (action === 'stopall') {
        this.stop(this.zoneIdsOf(controllerId));
      } else if (action === 'suspend') {
        this.suspend([relay], period === 0 ? null : custom * 1000);
      } else if (action === 'suspendall') {
        this.suspend(this.zoneIdsOf(controllerId), period === 0 ? null : custom * 1000);
      } else {
        return json(200, { message: 'Unknown action', message_type: 'error' });
      }
      return json(200, { message: 'Done', message_type: 'info' });
    }
    return { status: 404, body: 'Not found' };
  }
}
