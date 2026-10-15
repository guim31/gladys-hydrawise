// -----------------------------------------------------------------------------
// The Hydrawise hub: the account's controllers and zones, read from the cloud
// on a timer of the container, published to Gladys when they change; the
// commands of the switches, the widget and the scene actions; the "watering
// finished" scene event.
//
// Gladys never polls these devices (should_poll: false): the pace is the
// Hydrawise quotas', far slower than the core scheduler's fixed list, and
// the core does not poll external devices reliably (GladysAssistant/Gladys#3198).
//
// The pace, by sign-in mode (see CLAUDE.md, "Hydrawise"):
//   - account only: a GraphQL read every 10 minutes, within a budget of 5
//     GraphQL requests per 30 minutes (pydrawise's default, Home Assistant's
//     setting), water use once an hour when a flow meter is wired;
//   - account + API key (Home Assistant's setup): REST every 2 minutes, or the
//     `nextpoll` delay the service asks for when longer, GraphQL every 30 minutes;
//   - API key only: REST, at the same pace.
// Between two reads, a one-minute local tick counts the time left of a run
// down and ends it when its end time has passed: no request for that.
// After a command, the expected state is shown at once and confirmed by a
// read 20 seconds later; a read that does not reflect the command yet (the
// controller only fetches it from the cloud at its next contact) does not
// undo it for 3 minutes.
// -----------------------------------------------------------------------------

import { DEVICE_TRANSPORTS, createLogger } from '@gladysassistant/integration-sdk';
import { Budget } from './budget.js';
import { MODES, credentialsSignature } from './config.js';
import {
  buildDevice,
  controllerIdOf,
  controllerIds,
  controllerName,
  featureStates,
  parseFeatureId,
  remainingMinutes,
  zoneLabels,
} from './devices.js';
import { TokenAuth } from './hydrawise/auth.js';
import { ERROR_KINDS, HydrawiseError } from './hydrawise/errors.js';
import { GraphqlClient } from './hydrawise/graphql.js';
import { httpRequest } from './hydrawise/http.js';
import {
  applyRestSchedule,
  fromGraphql,
  fromRestCustomer,
  isRunning,
  isSuspended,
  waterUseFromGraphql,
} from './hydrawise/model.js';
import { RestClient } from './hydrawise/rest.js';
import {
  ACTION_TEXT,
  CONNECTION_TEXT,
  ERROR_TEXT,
  REPORT_TEXT,
  nextRunText,
  pick,
  userError,
} from './texts.js';

const logger = createLogger({ name: 'hydrawise' });

export const WIDGET_KEY = 'irrigation';

// Scene trigger keys (manifest `scene_triggers`): permanent once published.
export const TRIGGERS = Object.freeze({
  WATERING_FINISHED: 'watering_finished',
});

export const HUB_TIMINGS = {
  tickMs: 60_000,
  // GraphQL budget (pydrawise's HybridClient default).
  gqlTokens: 5,
  gqlWindowMs: 30 * 60_000,
  // Reads: GraphQL only / REST (or `nextpoll` when longer, up to restMaxMs).
  accountReadMs: 10 * 60_000,
  restReadMs: 2 * 60_000,
  restMaxMs: 10 * 60_000,
  // With the API key: the GraphQL details (suspensions, sensors) this often.
  hybridGqlMs: 30 * 60_000,
  // API key only: the controller list (names, last contact) this often.
  restCustomerMs: 30 * 60_000,
  // Today's water use, with a flow meter (Home Assistant: hourly).
  waterUseMs: 60 * 60_000,
  // A command is confirmed by a read this long after.
  confirmMs: 20_000,
  // A read contradicting a command is ignored this long.
  commandHoldMs: 3 * 60_000,
  // A run is over this long after its end time, without waiting for a read.
  runEndGraceMs: 60_000,
  // HTTP 429: that API rests this long.
  rateLimitPauseMs: 30 * 60_000,
  // Refused credentials: tried again this long after (never in a loop).
  authRetryMs: 30 * 60_000,
  // Unchanged states are re-sent this often (Gladys shows "no recent value" after 48 h).
  heartbeatMs: 6 * 60 * 60_000,
};

// Longest run and suspension a command accepts.
export const MAX_COMMAND_MINUTES = 240;
export const MAX_SUSPEND_DAYS = 365;

const DAY_MS = 24 * 60 * 60_000;

const zoneKey = (controllerId, zoneId) => `${controllerId}:${zoneId}`;

/** Lower case, no accents, single spaces: how zone names are compared. */
export const normalizeName = (value) =>
  String(value ?? '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

/** A whole number from a scene field or a form ("15", 15, "2,5"); fallback otherwise. */
export function parseCount(raw, fallback, max) {
  const number =
    typeof raw === 'number'
      ? raw
      : typeof raw === 'string' && raw.trim() !== ''
        ? Number(raw.trim().replace(',', '.'))
        : NaN;
  if (!Number.isFinite(number) || number <= 0) {
    return fallback;
  }
  return Math.min(max, Math.max(1, Math.round(number)));
}

/** Local midnight of the day of `now` (the TZ of Gladys, injected by the supervisor). */
function startOfDay(now) {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

const dayKey = (now) => {
  const date = new Date(now);
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
};

export class HydrawiseHub {
  /**
   * @param {object} options
   * @param {object} options.gladys GladysIntegration (or the SDK's fake Gladys)
   * @param {object} options.store persistence (src/store.js)
   * @param {Function} [options.request] HTTP seam (src/hydrawise/http.js)
   * @param {boolean} [options.timers] periodic timers (off in tests)
   * @param {object} [options.timings] HUB_TIMINGS overrides
   * @param {() => number} [options.now]
   * @param {string} [options.appVersion] the `appVersion` sent to the GraphQL API
   */
  constructor({ gladys, store, request, timers = true, timings, now, appVersion }) {
    this.gladys = gladys;
    this.store = store;
    this.request = request ?? httpRequest;
    this.timersEnabled = timers;
    this.timings = { ...HUB_TIMINGS, ...timings };
    this.now = now ?? (() => Date.now());
    this.appVersion = appVersion ?? 'gladys-hydrawise';
    this.config = null;
    this.signature = null;
    this.stopped = false;
    this.tickTimer = null;
    this.confirmTimer = null;
    /** Problems already logged, by key: their repeats go to debug. */
    this.warned = new Set();
    this.reset();
  }

  /** Forget the account: a new sign-in starts from scratch. */
  reset() {
    this.gql = null;
    this.rest = null;
    this.restDisabled = false;
    this.restSkipped = new Set();
    this.gqlBudget = new Budget({
      tokens: this.timings.gqlTokens,
      windowMs: this.timings.gqlWindowMs,
      now: () => this.now(),
    });
    this.gqlPausedUntil = 0;
    this.restPausedUntil = 0;
    /** @type {Map<number, object>} controllers by id (src/hydrawise/model.js) */
    this.controllers = new Map();
    this.units = 'metric';
    this.reachable = null;
    this.error = null;
    this.authFailedAt = null;
    this.connectedOnce = false;
    this.lastReadAt = 0;
    this.lastGqlAt = 0;
    this.lastCustomerAt = 0;
    this.nextReadAt = 0;
    this.restNextPollMs = null;
    /** Today's water use by controller id: `{ day, at, totalLiters, byZone }`. */
    this.waterUse = new Map();
    /** Zones seen watering, by zoneKey: `{ startedAt }`. */
    this.runningSeen = new Map();
    this.transitionsReady = false;
    /** Runs ended by a Gladys command: no "watering finished" event for them. */
    this.ownStops = new Set();
    /** Commands not yet reflected by the cloud, by zoneKey: `{ expect, until, run, suspendedUntil }`. */
    this.pending = new Map();
    this.structureKey = null;
    this.widgetKey = null;
    this.transports = new Map();
    this.connection = null;
    this.reading = null;
  }

  // --- Logs ----------------------------------------------------------------------
  // Info keeps the lifecycle only (signed in, lost, back, user commands). A
  // problem that repeats every cycle is logged once at its own level, then at
  // debug until it clears. LOG_LEVEL=debug shows every read.

  problem(key, message, level = 'warn') {
    if (this.warned.has(key)) {
      logger.debug(message);
      return;
    }
    this.warned.add(key);
    logger[level](message);
  }

  resolved(key, message) {
    if (this.warned.delete(key) && message) {
      logger.info(message);
    }
  }

  // --- Lifecycle -----------------------------------------------------------------

  async start(config) {
    await this.reconfigure(config);
  }

  /** Gladys reconnected (it restarted): send everything again. */
  async resync(config) {
    this.structureKey = null;
    this.widgetKey = null;
    this.transports.clear();
    this.connection = null;
    this.gladys.forgetPublishedStates?.();
    await this.reconfigure(config);
  }

  async reconfigure(config) {
    const signature = credentialsSignature(config);
    const languageChanged = this.config?.language !== config.language;
    this.config = config;
    if (signature !== this.signature) {
      this.signature = signature;
      this.reset();
      this.buildClients(config);
      if (config.mode !== MODES.NONE) {
        logger.info(`Signing in to Hydrawise (${config.mode.replace('_', ' ')})`);
      }
      await this.read({ user: true });
      await this.checkApiKey();
      await this.refreshWaterUse();
    } else if (languageChanged) {
      // New feature names (for devices not added yet) and new text states.
      this.structureKey = null;
      this.gladys.forgetPublishedStates?.();
      await this.afterUpdate();
    } else {
      await this.afterUpdate();
    }
    this.scheduleTick();
  }

  /**
   * Account + API key: the first read used GraphQL; a REST read right after
   * tells at once whether the key works (Home Assistant checks both too).
   */
  async checkApiKey() {
    if (this.gql && this.rest && !this.restDisabled && this.reachable) {
      this.nextReadAt = 0;
      await this.read({ user: true });
    }
  }

  buildClients(config) {
    if (config.mode === MODES.ACCOUNT || config.mode === MODES.HYBRID) {
      const auth = new TokenAuth({
        username: config.username,
        password: config.password,
        request: this.request,
        tokens: this.store.tokens(),
        now: this.now,
      });
      this.gql = new GraphqlClient({
        auth,
        request: this.request,
        appVersion: this.appVersion,
        logger,
      });
    }
    if (config.mode === MODES.API_KEY || config.mode === MODES.HYBRID) {
      this.rest = new RestClient({ apiKey: config.apiKey, request: this.request });
    }
  }

  async stop() {
    this.stopped = true;
    clearTimeout(this.tickTimer);
    clearTimeout(this.confirmTimer);
    await this.store.flush();
  }

  scheduleTick() {
    clearTimeout(this.tickTimer);
    if (!this.timersEnabled || this.stopped) {
      return;
    }
    this.tickTimer = setTimeout(async () => {
      try {
        await this.tick();
        this.resolved('tick');
      } catch (err) {
        this.problem('tick', `Refresh failed: ${err.message}`, 'error');
      }
      this.scheduleTick();
    }, this.timings.tickMs);
  }

  /**
   * One minute went by: end the runs whose time is up, read the cloud when
   * due, publish what changed. The timer calls it; so do the tests.
   */
  async tick() {
    if (!this.config || this.config.mode === MODES.NONE) {
      return;
    }
    const now = this.now();
    this.expireRuns(now);
    if (now >= this.nextReadAt) {
      await this.read();
    } else {
      await this.afterUpdate();
    }
    await this.refreshWaterUse();
  }

  // --- Reading the cloud ---------------------------------------------------------

  /** The interval between two reads in the current mode. */
  readInterval() {
    const restUsable = this.rest && !this.restDisabled;
    if (!restUsable) {
      return this.timings.accountReadMs;
    }
    const asked = this.restNextPollMs ?? 0;
    return Math.min(this.timings.restMaxMs, Math.max(this.timings.restReadMs, asked));
  }

  /** Which API the next read uses, or null when none is allowed now. */
  chooseSource({ preferGraphql = false } = {}) {
    const now = this.now();
    const gqlOk = this.gql !== null && now >= this.gqlPausedUntil && this.gqlBudget.available() > 0;
    const restOk = this.rest !== null && !this.restDisabled && now >= this.restPausedUntil;
    if (!this.gql) {
      return restOk ? 'rest' : null;
    }
    if (!restOk) {
      return gqlOk ? 'graphql' : null;
    }
    const gqlDue =
      preferGraphql || this.lastGqlAt === 0 || now - this.lastGqlAt >= this.timings.hybridGqlMs;
    return gqlDue && gqlOk ? 'graphql' : 'rest';
  }

  /**
   * Read the cloud now (one read at a time: concurrent callers share it).
   * @param {object} [options]
   * @param {boolean} [options.user] asked by the user (start, new configuration,
   *   test): tried even while refused credentials rest
   * @param {boolean} [options.preferGraphql] the details, not only the runs
   * @returns {Promise<boolean>} whether the cloud answered
   */
  read(options = {}) {
    this.reading ??= this.doRead(options).finally(() => {
      this.reading = null;
    });
    return this.reading;
  }

  async doRead({ user = false, preferGraphql = false } = {}) {
    const signature = this.signature;
    const now = this.now();
    if (!this.config || this.config.mode === MODES.NONE) {
      await this.afterUpdate();
      return false;
    }
    if (!user && this.authFailedAt !== null && now - this.authFailedAt < this.timings.authRetryMs) {
      this.nextReadAt = this.authFailedAt + this.timings.authRetryMs;
      return false;
    }
    const source = this.chooseSource({ preferGraphql });
    if (!source) {
      // The budget is spent: wait for it, the data stays as it is.
      const at = Math.max(this.gqlBudget.nextAt(), this.gqlPausedUntil, this.restPausedUntil);
      this.nextReadAt = Math.max(now + 60_000, at);
      logger.debug('Hydrawise read skipped: request budget spent');
      await this.afterUpdate();
      return false;
    }
    try {
      if (source === 'graphql') {
        await this.readGraphql(now);
      } else {
        await this.readRest(now);
      }
      if (signature !== this.signature) {
        return false; // the configuration changed meanwhile: that read is moot
      }
      this.onReadSuccess(now, source);
      this.nextReadAt = now + this.readInterval();
      await this.afterUpdate();
      return true;
    } catch (err) {
      if (signature !== this.signature) {
        return false;
      }
      if (!(err instanceof HydrawiseError)) {
        throw err;
      }
      if (
        source === 'rest' &&
        this.gql &&
        (err.kind === ERROR_KINDS.AUTH || err.kind === ERROR_KINDS.RATE_LIMITED)
      ) {
        // Account + API key: the account still works, go on with GraphQL.
        if (err.kind === ERROR_KINDS.AUTH) {
          this.restDisabled = true;
          this.problem('rest-key', `Hydrawise API key refused: GraphQL only (${err.message})`);
        } else {
          this.restPausedUntil = now + this.timings.rateLimitPauseMs;
          this.problem('rest-rate', `Hydrawise REST API rate limit: ${err.message}`);
        }
        this.nextReadAt = now;
        return this.doRead({ user, preferGraphql: true });
      }
      this.onReadFailure(now, source, err);
      await this.afterUpdate();
      return false;
    }
  }

  async readGraphql(now) {
    // chooseSource checked the budget just before: there is room.
    this.gqlBudget.trySpend();
    logger.debug('Reading the Hydrawise account (GraphQL)');
    const model = fromGraphql(await this.gql.readAccount(), now);
    this.units = model.units;
    const previous = this.controllers;
    this.controllers = new Map();
    for (const controller of model.controllers) {
      this.controllers.set(controller.id, controller);
      // A run seen before keeps the start time it was seen with.
      const before = previous.get(controller.id);
      for (const zone of controller.zones) {
        const old = before?.zones.find((z) => z.id === zone.id);
        if (zone.run && zone.run.startedAt === null && old?.run?.startedAt) {
          zone.run.startedAt = old.run.startedAt;
        }
      }
    }
    this.lastGqlAt = now;
  }

  async readRest(now) {
    const apiKeyOnly = !this.gql;
    if (
      this.controllers.size === 0 ||
      (apiKeyOnly && now - this.lastCustomerAt >= this.timings.restCustomerMs)
    ) {
      logger.debug('Reading the Hydrawise controllers (REST)');
      const list = fromRestCustomer(await this.rest.customerDetails(), now);
      const merged = new Map();
      for (const controller of list) {
        const known = this.controllers.get(controller.id);
        merged.set(
          controller.id,
          known
            ? {
                ...known,
                name: controller.name || known.name,
                online: apiKeyOnly ? controller.online : known.online,
                lastContact: controller.lastContact ?? known.lastContact,
              }
            : controller,
        );
      }
      this.controllers = merged;
      this.lastCustomerAt = now;
    }
    let answered = 0;
    let refused = null;
    const refusedIds = [];
    let nextPoll = null;
    for (const controller of this.controllers.values()) {
      if (this.restSkipped.has(controller.id)) {
        continue;
      }
      logger.debug(`Reading the zones of controller ${controller.id} (REST)`);
      try {
        const asked = applyRestSchedule(
          controller,
          await this.rest.statusSchedule(controller.id),
          now,
          { trustSuspension: apiKeyOnly },
        );
        answered += 1;
        if (asked !== null) {
          nextPoll = nextPoll === null ? asked : Math.min(nextPoll, asked);
        }
      } catch (err) {
        if (err.kind !== ERROR_KINDS.AUTH) {
          throw err;
        }
        // An API key serves one controller of a multi-controller account
        // (pydrawise): the others are left to GraphQL, or not refreshed.
        refused = err;
        refusedIds.push(controller.id);
      }
    }
    if (answered === 0 && refused) {
      throw refused;
    }
    for (const id of refusedIds) {
      logger.debug(`Controller ${id}: not served by this API key, left to GraphQL`);
      this.restSkipped.add(id);
    }
    this.restNextPollMs = nextPoll === null ? null : nextPoll * 1000;
  }

  onReadSuccess(now, source) {
    const wasDown = this.error !== null;
    this.reachable = true;
    this.error = null;
    this.authFailedAt = null;
    this.lastReadAt = now;
    this.applyPending(now);
    this.trackRuns(now);
    if (!this.connectedOnce) {
      this.connectedOnce = true;
      const zones = [...this.controllers.values()].reduce((n, c) => n + c.zones.length, 0);
      logger.info(
        `Connected to Hydrawise (${source}): ${this.controllers.size} controller(s), ${zones} zone(s)`,
      );
    } else if (wasDown) {
      logger.info('Hydrawise answers again');
    }
    for (const kind of Object.values(ERROR_KINDS)) {
      this.warned.delete(`read-${kind}`);
    }
  }

  onReadFailure(now, source, err) {
    this.error = { kind: err.kind, message: err.message };
    if (err.kind === ERROR_KINDS.RATE_LIMITED) {
      if (source === 'graphql') {
        this.gqlPausedUntil = now + this.timings.rateLimitPauseMs;
      } else {
        this.restPausedUntil = now + this.timings.rateLimitPauseMs;
      }
    } else {
      this.reachable = false;
    }
    if (err.kind === ERROR_KINDS.AUTH) {
      this.authFailedAt = now;
      this.nextReadAt = now + this.timings.authRetryMs;
      this.problem(`read-${err.kind}`, err.message, 'error');
      return;
    }
    this.nextReadAt = now + this.readInterval();
    this.problem(`read-${err.kind}`, `Hydrawise read failed: ${err.message}`);
  }

  /** Today's water use of the controllers with a flow meter (GraphQL, hourly). */
  async refreshWaterUse() {
    if (!this.gql || this.error) {
      return;
    }
    const now = this.now();
    let read = false;
    for (const controller of this.controllers.values()) {
      if (!controller.hasFlowSensor) {
        continue;
      }
      const known = this.waterUse.get(controller.id);
      if (known && known.day === dayKey(now) && now - known.at < this.timings.waterUseMs) {
        continue;
      }
      // Keep one request of the budget for the reads.
      if (now < this.gqlPausedUntil || this.gqlBudget.available() <= 1) {
        return;
      }
      this.gqlBudget.trySpend();
      read = true;
      const from = Math.floor(startOfDay(now) / 1000);
      const until = Math.floor(now / 1000);
      try {
        logger.debug(`Reading the water use of controller ${controller.id}`);
        const answer = await this.gql.readWaterUse(controller.id, from, until);
        const use = waterUseFromGraphql(answer, from, until, this.units);
        if (use) {
          this.waterUse.set(controller.id, { day: dayKey(now), at: now, ...use });
        }
        this.resolved('water-use', 'Water use readable again');
      } catch (err) {
        if (!(err instanceof HydrawiseError)) {
          throw err;
        }
        if (err.kind === ERROR_KINDS.RATE_LIMITED) {
          this.gqlPausedUntil = now + this.timings.rateLimitPauseMs;
        }
        // Tried again in an hour, not at every tick.
        this.waterUse.set(controller.id, {
          day: dayKey(now),
          at: now,
          totalLiters: known?.day === dayKey(now) ? known.totalLiters : 0,
          byZone: known?.day === dayKey(now) ? known.byZone : new Map(),
        });
        this.problem('water-use', `Water use read failed: ${err.message}`);
      }
    }
    if (read) {
      await this.afterUpdate();
    }
  }

  /** Today's water use as published: a new day starts at zero. */
  waterUseOf(controller, now) {
    const use = this.waterUse.get(controller.id);
    if (!use) {
      return null;
    }
    return use.day === dayKey(now) ? use : { totalLiters: 0, byZone: new Map() };
  }

  // --- Runs, commands not yet confirmed, events ----------------------------------------

  /** End the runs whose end time has passed, without a request. */
  expireRuns(now) {
    let ended = false;
    for (const controller of this.controllers.values()) {
      for (const zone of controller.zones) {
        if (zone.run && zone.run.endsAt + this.timings.runEndGraceMs <= now) {
          zone.run = null;
          ended = true;
        }
      }
    }
    if (ended) {
      this.trackRuns(now);
    }
  }

  /** Commands the cloud does not reflect yet are kept for commandHoldMs. */
  applyPending(now) {
    for (const [key, command] of this.pending) {
      const [controllerId, zoneId] = key.split(':').map(Number);
      const zone = this.controllers.get(controllerId)?.zones.find((z) => z.id === zoneId);
      if (!zone || now > command.until) {
        this.pending.delete(key);
        continue;
      }
      if (command.expect === 'running') {
        if (isRunning(zone)) {
          this.pending.delete(key);
        } else if (command.run.endsAt > now) {
          zone.run = { ...command.run };
        }
      } else if (command.expect === 'stopped') {
        if (isRunning(zone)) {
          zone.run = null;
        } else {
          this.pending.delete(key);
        }
      } else if (command.expect === 'suspended') {
        if (isSuspended(zone, now)) {
          this.pending.delete(key);
        } else {
          zone.suspendedUntil = command.suspendedUntil;
        }
      } else if (command.expect === 'resumed') {
        if (isSuspended(zone, now)) {
          zone.suspendedUntil = null;
        } else {
          this.pending.delete(key);
        }
      }
    }
  }

  /** Fire "watering finished" for every run seen ending. */
  trackRuns(now) {
    const current = new Map();
    for (const controller of this.controllers.values()) {
      for (const zone of controller.zones) {
        if (!isRunning(zone)) {
          continue;
        }
        const key = zoneKey(controller.id, zone.id);
        const seen = this.runningSeen.get(key);
        zone.run.startedAt ??= seen?.startedAt ?? now;
        current.set(key, { startedAt: zone.run.startedAt, endsAt: zone.run.endsAt });
      }
    }
    if (this.transitionsReady) {
      for (const [key, seen] of this.runningSeen) {
        if (current.has(key)) {
          continue;
        }
        if (this.ownStops.delete(key)) {
          continue; // stopped from Gladys: no event for a Gladys command
        }
        const [controllerId, zoneId] = key.split(':').map(Number);
        const controller = this.controllers.get(controllerId);
        const zone = controller?.zones.find((z) => z.id === zoneId);
        if (zone) {
          // Ended at its end time, or earlier (stopped at the controller, seen by a read).
          const end = Math.min(now, seen.endsAt ?? now);
          const minutes = Math.max(0, Math.round((end - seen.startedAt) / 60_000));
          this.fireFinished(controller, zone, minutes);
        }
      }
    }
    this.runningSeen = current;
    this.transitionsReady = true;
  }

  fireFinished(controller, zone, minutes) {
    const label = zoneLabels(controller, this.config.language).get(zone.id);
    logger.debug(`${controllerName(controller)}: ${label} finished watering (${minutes} min)`);
    this.gladys
      .publishSceneEvent(TRIGGERS.WATERING_FINISHED, {
        device: controllerIds(this.gladys, controller.id).device,
        controller: controllerName(controller),
        zone: label,
        zone_number: zone.number,
        minutes,
      })
      .then(() => this.resolved('scene-event'))
      .catch((err) => this.problem('scene-event', `Scene event refused: ${err.message}`));
  }

  // --- Publishing to Gladys ----------------------------------------------------------

  /** Devices, states, transports, connection status, widget: what changed. */
  async afterUpdate() {
    await this.publishDevices();
    await this.publishStates();
    await this.publishTransports();
    await this.publishConnectionStatus();
    this.refreshWidgetIfChanged();
  }

  async publishDevices({ force = false } = {}) {
    if (!this.config) {
      return;
    }
    const language = this.config.language;
    const devices = [...this.controllers.values()].map((controller) =>
      buildDevice(this.gladys, controller, language),
    );
    const key = JSON.stringify(devices);
    if (!force && key === this.structureKey) {
      return;
    }
    try {
      // Even an empty list: the Discovery tab then shows no stale controller.
      await this.gladys.publishDiscoveredDevices(devices);
      this.structureKey = key;
      this.resolved('devices');
    } catch (err) {
      this.problem('devices', `Publishing the devices failed: ${err.message}`);
    }
  }

  /** The controllers whose device the user added to Gladys. */
  createdControllers() {
    const created = new Set((this.gladys.devices ?? []).map((device) => device.external_id));
    return [...this.controllers.values()].filter((controller) =>
      created.has(controllerIds(this.gladys, controller.id).device),
    );
  }

  async publishStates() {
    const now = this.now();
    const states = this.createdControllers().flatMap((controller) =>
      featureStates(this.gladys, controller, {
        now,
        language: this.config.language,
        reachable: this.reachable === true,
        waterUse: this.waterUseOf(controller, now),
      }),
    );
    if (states.length === 0) {
      return;
    }
    try {
      await this.gladys.publishChangedStates(states, { heartbeat: this.timings.heartbeatMs });
      this.resolved('states');
    } catch (err) {
      this.problem('states', `States refused by Gladys: ${err.message}`);
    }
  }

  async publishTransports() {
    const entries = [];
    if (this.reachable === null) {
      return;
    }
    for (const controller of this.createdControllers()) {
      const externalId = controllerIds(this.gladys, controller.id).device;
      const transport =
        this.reachable && controller.online !== false
          ? DEVICE_TRANSPORTS.CLOUD
          : DEVICE_TRANSPORTS.UNREACHABLE;
      if (this.transports.get(externalId) !== transport) {
        entries.push({ external_id: externalId, transport });
      }
    }
    if (entries.length === 0) {
      return;
    }
    try {
      await this.gladys.publishTransports(entries);
      for (const entry of entries) {
        this.transports.set(entry.external_id, entry.transport);
      }
      this.resolved('transports');
    } catch (err) {
      this.problem('transports', `Transports refused: ${err.message}`);
    }
  }

  /** The status under the integration name, with the reason when not connected. */
  connectionStatus() {
    const config = this.config;
    if (!config || config.mode === MODES.NONE) {
      return {
        connected: false,
        message: config?.incompleteAccount
          ? CONNECTION_TEXT.incomplete
          : CONNECTION_TEXT.notConfigured,
      };
    }
    if (this.error && this.error.kind !== ERROR_KINDS.RATE_LIMITED) {
      return { connected: false, message: ERROR_TEXT[this.error.kind] };
    }
    if (this.reachable === null) {
      return { connected: false, message: null };
    }
    if (this.controllers.size === 0) {
      return { connected: true, message: CONNECTION_TEXT.noController };
    }
    if (this.restDisabled) {
      return { connected: true, message: CONNECTION_TEXT.apiKeyRefused };
    }
    return { connected: true, message: null };
  }

  async publishConnectionStatus() {
    const status = this.connectionStatus();
    if (status.connected === false && status.message === null) {
      return; // first read in progress
    }
    const key = JSON.stringify(status);
    if (key === this.connection) {
      return;
    }
    try {
      await this.gladys.setConnectionStatus(status.connected, status.message ?? undefined);
      this.connection = key;
      this.resolved('connection-status');
    } catch (err) {
      this.problem('connection-status', `Connection status refused: ${err.message}`);
    }
  }

  /** What the widget shows: a new content is asked for when it changes. */
  refreshWidgetIfChanged() {
    const now = this.now();
    const language = this.config?.language ?? 'en';
    const key = JSON.stringify([
      this.reachable,
      this.error?.kind ?? null,
      [...this.controllers.values()].map((controller) => [
        controller.id,
        controller.online,
        this.waterUseOf(controller, now)?.totalLiters ?? null,
        controller.zones.map((zone) => [
          zone.id,
          remainingMinutes(zone, now),
          isRunning(zone),
          nextRunText(zone, now, language),
        ]),
      ]),
    ]);
    if (key === this.widgetKey) {
      return;
    }
    const first = this.widgetKey === null;
    this.widgetKey = key;
    if (!first) {
      this.gladys.requestWidgetRefresh(WIDGET_KEY);
    }
  }

  /** The user added a device: its states sent before were dropped by Gladys. */
  async onDeviceCreated(device) {
    const controllerId = controllerIdOf(this.gladys, device.external_id);
    if (controllerId === null || !this.controllers.has(controllerId)) {
      return;
    }
    this.gladys.forgetPublishedStates?.(device.external_id);
    this.transports.delete(device.external_id);
    await this.publishStates();
    await this.publishTransports();
    this.gladys.requestWidgetRefresh(WIDGET_KEY);
  }

  /** Gladys asks for a refresh (onPoll): read when the last read is old enough. */
  async pollDevice(device) {
    if (controllerIdOf(this.gladys, device.external_id) === null) {
      return;
    }
    if (this.now() >= this.nextReadAt) {
      await this.read();
    } else {
      await this.publishStates();
    }
  }

  // --- Commands --------------------------------------------------------------------------

  language() {
    return this.config?.language ?? 'fr';
  }

  assertReady() {
    if (!this.config || this.config.mode === MODES.NONE || this.controllers.size === 0) {
      throw userError(
        this.config?.mode === MODES.NONE ? CONNECTION_TEXT.notConfigured : ACTION_TEXT.notReady,
        this.language(),
      );
    }
  }

  /** The controllers a command targets: one device, or all of them. */
  targets(deviceExternalId) {
    this.assertReady();
    if (!deviceExternalId) {
      return [...this.controllers.values()];
    }
    const controller = this.controllers.get(controllerIdOf(this.gladys, deviceExternalId));
    if (!controller) {
      throw userError(ACTION_TEXT.unknownController, this.language());
    }
    return [controller];
  }

  /**
   * Find a zone by its Hydrawise number ("3"), id or name (accents and case
   * ignored), in one controller or all of them.
   * @returns {{ controller: object, zone: object }}
   */
  findZone(deviceExternalId, reference) {
    const controllers = this.targets(deviceExternalId);
    const ref = normalizeName(reference);
    if (ref === '') {
      throw userError(ACTION_TEXT.noZone, this.language());
    }
    const all = controllers.flatMap((controller) =>
      controller.zones.map((zone) => ({ controller, zone })),
    );
    let found = [];
    if (/^\d+$/.test(ref)) {
      const number = Number(ref);
      found = all.filter(({ zone }) => zone.number === number);
      if (found.length === 0) {
        found = all.filter(({ zone }) => zone.id === number);
      }
    }
    if (found.length === 0) {
      found = all.filter(({ controller, zone }) => {
        const label = zoneLabels(controller, this.language()).get(zone.id);
        return normalizeName(zone.name) === ref || normalizeName(label) === ref;
      });
    }
    if (found.length === 0) {
      throw userError(ACTION_TEXT.unknownZone, this.language());
    }
    if (found.length > 1) {
      throw userError(
        controllers.length > 1 && new Set(found.map((f) => f.controller.id)).size > 1
          ? ACTION_TEXT.pickController
          : ACTION_TEXT.ambiguousZone,
        this.language(),
      );
    }
    return found[0];
  }

  /** A command sent to the cloud, its errors explained in the user's language. */
  async send(name, args) {
    try {
      if (this.gql) {
        await this.gql.mutate(name, args);
      } else {
        await this.rest[name](args);
      }
    } catch (err) {
      if (!(err instanceof HydrawiseError)) {
        throw err;
      }
      logger.warn(`Command ${name} failed: ${err.message}`);
      throw userError(ERROR_TEXT[err.kind] ?? ACTION_TEXT.failed, this.language());
    }
  }

  hold(controller, zone, command) {
    this.pending.set(zoneKey(controller.id, zone.id), {
      ...command,
      until: this.now() + this.timings.commandHoldMs,
    });
  }

  /** After a command: show the expected state now, confirm with a read soon. */
  async afterCommand() {
    this.trackRuns(this.now());
    await this.afterUpdate();
    this.gladys.requestWidgetRefresh(WIDGET_KEY);
    clearTimeout(this.confirmTimer);
    if (!this.timersEnabled || this.stopped) {
      return;
    }
    this.confirmTimer = setTimeout(() => {
      this.read()
        .then(() => this.resolved('confirm'))
        .catch((err) => this.problem('confirm', `Confirmation read failed: ${err.message}`));
    }, this.timings.confirmMs);
    this.confirmTimer.unref?.();
  }

  /**
   * Water one zone for `minutes`.
   * @returns {Promise<{ controller: object, zone: object, label: string, minutes: number }>}
   */
  async startZone(deviceExternalId, reference, minutes) {
    const { controller, zone } = this.findZone(deviceExternalId, reference);
    const duration = Math.min(MAX_COMMAND_MINUTES, Math.max(1, Math.round(minutes)));
    const label = await this.startZoneById(controller, zone, duration);
    return { controller, zone, label, minutes: duration };
  }

  /**
   * Stop one zone, or every zone of the targeted controllers.
   * @returns {Promise<number>} zones stopped (counted from the known runs)
   */
  async stopWatering(deviceExternalId, reference) {
    let stopped = 0;
    if (reference !== undefined && reference !== null && String(reference).trim() !== '') {
      const { controller, zone } = this.findZone(deviceExternalId, reference);
      await this.send('stopZone', { zoneId: zone.id });
      this.markStopped(controller, zone);
      stopped = 1;
      logger.info(
        `${controllerName(controller)}: ${zoneLabels(controller, this.language()).get(zone.id)} stopped`,
      );
    } else {
      for (const controller of this.targets(deviceExternalId)) {
        await this.send('stopAllZones', { controllerId: controller.id });
        for (const zone of controller.zones) {
          if (isRunning(zone)) {
            stopped += 1;
          }
          this.markStopped(controller, zone);
        }
        logger.info(`${controllerName(controller)}: all zones stopped`);
      }
    }
    await this.afterCommand();
    return stopped;
  }

  markStopped(controller, zone) {
    const key = zoneKey(controller.id, zone.id);
    if (isRunning(zone) || this.runningSeen.has(key)) {
      this.ownStops.add(key);
    }
    zone.run = null;
    this.hold(controller, zone, { expect: 'stopped' });
  }

  /**
   * Suspend the schedule of one zone, or of every zone of the targeted
   * controllers, for `days`; it comes back on its own.
   * @returns {Promise<number>} the end of the suspension (epoch ms)
   */
  async suspend(deviceExternalId, reference, days) {
    const count = Math.min(MAX_SUSPEND_DAYS, Math.max(1, Math.round(days)));
    const until = this.now() + count * DAY_MS;
    const apply = (controller, zone) => {
      zone.suspendedUntil = until;
      this.hold(controller, zone, { expect: 'suspended', suspendedUntil: until });
    };
    if (reference !== undefined && reference !== null && String(reference).trim() !== '') {
      const { controller, zone } = this.findZone(deviceExternalId, reference);
      await this.send('suspendZone', { zoneId: zone.id, until });
      apply(controller, zone);
      logger.info(
        `${controllerName(controller)}: ${zoneLabels(controller, this.language()).get(zone.id)} suspended for ${count} day(s)`,
      );
    } else {
      for (const controller of this.targets(deviceExternalId)) {
        await this.send('suspendAllZones', { controllerId: controller.id, until });
        controller.zones.forEach((zone) => apply(controller, zone));
        logger.info(`${controllerName(controller)}: watering suspended for ${count} day(s)`);
      }
    }
    await this.afterCommand();
    return until;
  }

  /** Resume the schedule of one zone, or of every zone of the targeted controllers. */
  async resume(deviceExternalId, reference) {
    const apply = (controller, zone) => {
      zone.suspendedUntil = null;
      this.hold(controller, zone, { expect: 'resumed' });
    };
    if (reference !== undefined && reference !== null && String(reference).trim() !== '') {
      const { controller, zone } = this.findZone(deviceExternalId, reference);
      await this.send('resumeZone', { zoneId: zone.id });
      apply(controller, zone);
      logger.info(
        `${controllerName(controller)}: ${zoneLabels(controller, this.language()).get(zone.id)} resumed`,
      );
    } else {
      for (const controller of this.targets(deviceExternalId)) {
        await this.send('resumeAllZones', { controllerId: controller.id });
        controller.zones.forEach((zone) => apply(controller, zone));
        logger.info(`${controllerName(controller)}: watering schedule resumed`);
      }
    }
    await this.afterCommand();
  }

  /** The switches: a zone (water for the configured time / stop), the schedule. */
  async setValue(device, feature, value) {
    const parsed = parseFeatureId(this.gladys, feature.external_id);
    const deviceId = device?.external_id ?? null;
    const on = Number(value) === 1;
    if (parsed?.key === 'zone_watering') {
      const controller = this.controllers.get(parsed.controllerId);
      const zone = controller?.zones.find((z) => z.id === parsed.zoneId);
      if (!zone) {
        throw userError(ACTION_TEXT.unknownZone, this.language());
      }
      if (on) {
        await this.startZoneById(controller, zone, this.config.runMinutes);
      } else {
        await this.stopZoneById(controller, zone);
      }
      return;
    }
    if (parsed?.key === 'auto_watering') {
      if (on) {
        await this.resume(deviceId, null);
      } else {
        await this.suspend(deviceId, null, this.config.suspendDays);
      }
      return;
    }
    throw userError(ACTION_TEXT.readOnly, this.language());
  }

  /** Water a zone for `minutes`; resolves with its label. */
  async startZoneById(controller, zone, minutes) {
    await this.send('startZone', { zoneId: zone.id, seconds: minutes * 60 });
    const now = this.now();
    zone.run = { startedAt: now, endsAt: now + minutes * 60_000 };
    this.ownStops.delete(zoneKey(controller.id, zone.id));
    this.hold(controller, zone, { expect: 'running', run: { ...zone.run } });
    const label = zoneLabels(controller, this.language()).get(zone.id);
    logger.info(`${controllerName(controller)}: ${label} watering for ${minutes} min`);
    await this.afterCommand();
    return label;
  }

  async stopZoneById(controller, zone) {
    await this.send('stopZone', { zoneId: zone.id });
    this.markStopped(controller, zone);
    logger.info(
      `${controllerName(controller)}: ${zoneLabels(controller, this.language()).get(zone.id)} stopped`,
    );
    await this.afterCommand();
  }

  // --- Report ------------------------------------------------------------------------------

  /** "Test the connection": read now, one line per controller. */
  async testConnection() {
    if (!this.config || this.config.mode === MODES.NONE) {
      return this.connectionStatus().message;
    }
    this.authFailedAt = null;
    await this.read({ user: true, preferGraphql: true });
    await this.checkApiKey();
    if (this.error && this.error.kind !== ERROR_KINDS.RATE_LIMITED) {
      throw userError(ERROR_TEXT[this.error.kind], this.language());
    }
    const mode = this.gql && this.rest && this.restDisabled ? MODES.ACCOUNT : this.config.mode;
    const message = {};
    for (const [language, text] of Object.entries(REPORT_TEXT)) {
      const lines = [text.mode[mode]];
      if (this.restDisabled) {
        lines.push(pick(CONNECTION_TEXT.apiKeyRefused, language));
      }
      if (this.controllers.size === 0) {
        lines.push(pick(CONNECTION_TEXT.noController, language));
      }
      for (const controller of this.controllers.values()) {
        const watering = controller.zones.filter(isRunning).length;
        const name =
          controller.online === false
            ? `${controllerName(controller)} (${text.offline})`
            : controllerName(controller);
        lines.push(text.controller(name, controller.zones.length, watering));
      }
      message[language] = lines.join('\n');
    }
    return message;
  }
}
