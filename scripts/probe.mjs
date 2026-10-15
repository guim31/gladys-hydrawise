#!/usr/bin/env node
// -----------------------------------------------------------------------------
// Probe of the real Hydrawise cloud with the integration's own clients, READ
// ONLY, printing nothing sensitive (no e-mail, password, key, token, name or
// identifier). For a machine with network access:
//
//   node scripts/probe.mjs
//       the sign-in path up to the refusal of an invented account: the token
//       endpoint, the GraphQL API without a valid token, the REST API with an
//       invented key. Proves the URLs, the client id and the error shapes.
//
//   HYDRAWISE_USERNAME=… HYDRAWISE_PASSWORD=… [HYDRAWISE_API_KEY=…] node scripts/probe.mjs
//       also reads a real account: the GraphQL query of the integration
//       (accepted by the service?), today's water use, the REST schedule.
//       Counts and shapes only. Sends no command.
// -----------------------------------------------------------------------------

import { randomBytes } from 'node:crypto';
import { TokenAuth } from '../src/hydrawise/auth.js';
import { GraphqlClient, GRAPHQL_URL, READ_QUERY } from '../src/hydrawise/graphql.js';
import { httpRequest } from '../src/hydrawise/http.js';
import { fromGraphql, waterUseFromGraphql } from '../src/hydrawise/model.js';
import { RestClient } from '../src/hydrawise/rest.js';

const APP_VERSION = 'gladys-hydrawise-probe';
let failures = 0;

function report(step, ok, details) {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${step}${details ? ` — ${details}` : ''}`);
  if (!ok) {
    failures += 1;
  }
}

async function step(name, fn) {
  try {
    await fn();
  } catch (err) {
    report(name, false, `${err.kind ?? 'error'}: ${err.message}`);
  }
}

// --- 1. The sign-in path, with an invented account ---------------------------

await step('token endpoint refuses an invented account', async () => {
  const auth = new TokenAuth({
    username: `probe-${randomBytes(4).toString('hex')}@example.invalid`,
    password: randomBytes(12).toString('hex'),
    request: httpRequest,
  });
  try {
    await auth.header();
    report('token endpoint refuses an invented account', false, 'a token was issued');
  } catch (err) {
    // The service's words are kept in the message: they never echo the account.
    report(
      'token endpoint refuses an invented account',
      err.kind === 'auth',
      `kind ${err.kind}, HTTP ${err.status ?? '?'}`,
    );
  }
});

await step('GraphQL API refuses an invalid token', async () => {
  const response = await httpRequest(`${GRAPHQL_URL}?appVersion=${APP_VERSION}`, {
    method: 'POST',
    headers: { authorization: 'Bearer invalid', 'content-type': 'application/json' },
    body: JSON.stringify({ query: 'query { me { id } }' }),
  });
  report(
    'GraphQL API refuses an invalid token',
    response.status === 401 || response.status === 403,
    `HTTP ${response.status}`,
  );
});

await step('REST API refuses an invented key', async () => {
  const rest = new RestClient({ apiKey: randomBytes(8).toString('hex'), request: httpRequest });
  try {
    await rest.customerDetails();
    report('REST API refuses an invented key', false, 'an answer came back');
  } catch (err) {
    report('REST API refuses an invented key', err.kind === 'auth', `kind ${err.kind}`);
  }
});

// --- 2. A real account, if given (read only) ------------------------------------

const { HYDRAWISE_USERNAME: username, HYDRAWISE_PASSWORD: password } = process.env;
const apiKey = process.env.HYDRAWISE_API_KEY;

if (username && password) {
  const auth = new TokenAuth({ username, password, request: httpRequest });
  const gql = new GraphqlClient({ auth, request: httpRequest, appVersion: APP_VERSION });
  let model = null;
  await step('GraphQL account read (the integration query)', async () => {
    const me = await gql.readAccount();
    model = fromGraphql(me, Date.now());
    const zones = model.controllers.reduce((n, c) => n + c.zones.length, 0);
    const running = model.controllers.reduce((n, c) => n + c.zones.filter((z) => z.run).length, 0);
    report(
      'GraphQL account read (the integration query)',
      true,
      `units ${model.units}, ${model.controllers.length} controller(s), ${zones} zone(s), ` +
        `${running} watering, rain sensors ${model.controllers.map((c) => c.rainSensors.length)}, ` +
        `flow meter ${model.controllers.map((c) => c.hasFlowSensor)}`,
    );
    // What the flow meters report as `status.waterFlow` (undocumented: a rate or a total?).
    const flows = (me.controllers ?? [])
      .flatMap((c) => c?.sensors ?? [])
      .filter((s) => s?.model?.sensorType === 'FLOW');
    for (const sensor of flows) {
      console.log(`     flow meter status keys: ${Object.keys(sensor.status ?? {})}`);
    }
    console.log(`     query length ${READ_QUERY.length} characters`);
  });
  const withFlow = model?.controllers.find((c) => c.hasFlowSensor);
  if (withFlow) {
    await step('GraphQL water use read', async () => {
      const now = Date.now();
      const midnight = new Date(now);
      midnight.setHours(0, 0, 0, 0);
      const from = Math.floor(midnight.getTime() / 1000);
      const until = Math.floor(now / 1000);
      const answer = await gql.readWaterUse(withFlow.id, from, until);
      const use = waterUseFromGraphql(answer, from, until, model.units);
      report(
        'GraphQL water use read',
        use !== null,
        `${answer?.reports?.watering?.length ?? 0} run(s) today, total ${Math.round(use?.totalLiters ?? 0)} L`,
      );
    });
  }
}

if (apiKey) {
  const rest = new RestClient({ apiKey, request: httpRequest });
  await step('REST controller list and schedule', async () => {
    const details = await rest.customerDetails();
    const ids = (details.controllers ?? []).map((c) => c.controller_id);
    const schedule = await rest.statusSchedule(ids[0] ?? details.controller_id);
    const times = (schedule.relays ?? []).map((r) =>
      r.time === 1 ? 'running' : r.time === 1576800000 ? 'sentinel' : 'next',
    );
    report(
      'REST controller list and schedule',
      true,
      `${ids.length} controller(s), ${times.length} relay(s) [${times}], nextpoll ${schedule.nextpoll}`,
    );
  });
}

console.log(failures === 0 ? 'Probe passed.' : `Probe: ${failures} step(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
