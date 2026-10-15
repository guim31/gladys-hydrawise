// -----------------------------------------------------------------------------
// The GraphQL requests the integration sends, checked against the schema of
// the service (pydrawise's copy, test/fixtures/hydrawise.graphql): every
// field and argument must exist, objects need a selection, scalars none.
// There is no Hydrawise account in a code session: this is the closest
// check of the queries before the real one (scripts/probe.mjs).
// Then the HTTP side of the client: headers, `appVersion`, errors.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  GRAPHQL_URL,
  GraphqlClient,
  MUTATIONS,
  READ_QUERY,
  formatUntil,
  waterUseQuery,
} from '../src/hydrawise/graphql.js';
import { ERROR_KINDS } from '../src/hydrawise/errors.js';

const sdl = await readFile(new URL('./fixtures/hydrawise.graphql', import.meta.url), 'utf8');

/** `{ Type: { field: { type, args } } }` from the SDL (types and interfaces). */
function parseSchema(text) {
  const types = {};
  let current = null;
  let inDescription = false;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('"""')) {
      const closes = trimmed.length > 3 && trimmed.endsWith('"""');
      inDescription = closes ? inDescription : !inDescription;
      continue;
    }
    if (inDescription || trimmed.startsWith('#') || trimmed === '') {
      continue;
    }
    const open = trimmed.match(/^(?:type|interface|input) (\w+)[^{]*\{$/);
    if (open) {
      current = types[open[1]] = {};
      continue;
    }
    if (trimmed === '}') {
      current = null;
      continue;
    }
    const field = current && trimmed.match(/^(\w+)(?:\((.*)\))?: ([[\]\w!]+)/);
    if (field) {
      current[field[1]] = {
        type: field[3].replace(/[[\]!]/g, ''),
        args: [...(field[2] ?? '').matchAll(/(\w+):/g)].map((m) => m[1]),
      };
    }
  }
  return types;
}

const schema = parseSchema(sdl);

/** The problems of one query or mutation against the schema. */
function check(document) {
  const tokens = document.match(/"(?:[^"\\]|\\.)*"|[A-Za-z_]\w*|-?\d+|[{}():,]/g);
  let at = 0;
  const problems = [];
  const peek = () => tokens[at];
  const next = () => tokens[at++];

  function args(field, path) {
    // ( name: value, ... )
    next();
    while (peek() !== ')') {
      const name = next();
      assert.equal(next(), ':', `${path}: argument syntax`);
      next(); // the value (a literal)
      if (!field.args.includes(name)) {
        problems.push(`${path}: unknown argument ${name}`);
      }
      if (peek() === ',') {
        next();
      }
    }
    next();
  }

  function selection(typeName, path) {
    assert.equal(next(), '{', `${path}: selection expected`);
    while (peek() !== '}') {
      const name = next();
      const field = schema[typeName]?.[name];
      const here = `${path}.${name}`;
      if (!field) {
        problems.push(`${here}: no field ${name} on ${typeName}`);
      }
      if (peek() === '(') {
        args(field ?? { args: [] }, here);
      }
      const isObject = field && schema[field.type] !== undefined;
      if (peek() === '{') {
        if (field && !isObject) {
          problems.push(`${here}: ${field.type} is a scalar, no selection`);
        }
        selection(field?.type, here);
      } else if (isObject) {
        problems.push(`${here}: ${field.type} needs a selection`);
      }
    }
    next();
  }

  const root = next();
  selection(root === 'mutation' ? 'Mutation' : 'Query', root);
  assert.equal(at, tokens.length, 'the whole document is read');
  return problems;
}

test('the schema copy is read (sanity of the checker)', () => {
  assert.ok(Object.keys(schema).length > 100);
  assert.equal(schema.Query.me.type, 'User');
  assert.deepEqual(schema.Mutation.startZone.args, [
    'zoneId',
    'markRunAsScheduled',
    'stackRuns',
    'customRunDuration',
  ]);
  // The checker catches what it must.
  assert.deepEqual(check('query { me { nope } }'), ['query.me.nope: no field nope on User']);
  assert.deepEqual(check('query { me { controllers } }'), [
    'query.me.controllers: Controller needs a selection',
  ]);
  assert.deepEqual(check('query { me { id { x } } }').length, 2);
  assert.deepEqual(check('mutation { stopZone(zone: 1) { status } }'), [
    'mutation.stopZone: unknown argument zone',
  ]);
});

test('the account read only asks for fields of the schema', () => {
  assert.deepEqual(check(READ_QUERY), []);
});

test('the water use query only asks for fields of the schema', () => {
  assert.deepEqual(check(waterUseQuery(110001, 1792022400, 1792051200)), []);
});

test('every mutation exists with these arguments', () => {
  const args = { zoneId: 220001, controllerId: 110001, seconds: 600, until: Date.UTC(2026, 9, 17) };
  for (const [name, build] of Object.entries(MUTATIONS)) {
    assert.deepEqual(check(build(args)), [], name);
  }
  assert.equal(
    MUTATIONS.startZone(args),
    'mutation { startZone(zoneId: 220001, markRunAsScheduled: false, customRunDuration: 600) { status summary } }',
  );
});

test('the suspension date has pydrawise format, in UTC', () => {
  // pydrawise's test: datetime(2023, 1, 1) in UTC → "Sun, 01 Jan 23 00:00:00 +0000".
  assert.equal(formatUntil(Date.UTC(2023, 0, 1)), 'Sun, 01 Jan 23 00:00:00 +0000');
  assert.equal(formatUntil(Date.UTC(2026, 9, 17, 8, 5, 9)), 'Sat, 17 Oct 26 08:05:09 +0000');
  assert.match(
    MUTATIONS.suspendZone({ zoneId: 1, until: Date.UTC(2023, 0, 1) }),
    /until: "Sun, 01 Jan 23 00:00:00 \+0000"/,
  );
});

test('identifiers are integers, never text pasted in a query', () => {
  assert.throws(() => MUTATIONS.stopZone({ zoneId: '1) { x } stopAllZones(controllerId: 2' }));
  assert.throws(() => waterUseQuery('1 }', 0, 1));
});

// --- The client ----------------------------------------------------------------

function client(responses, calls = []) {
  const auth = {
    header: async () => 'bearer token-1',
    invalidated: 0,
    invalidate() {
      this.invalidated += 1;
    },
  };
  const request = async (url, options) => {
    calls.push({ url, ...options });
    return responses.shift();
  };
  return {
    auth,
    calls,
    gql: new GraphqlClient({ auth, request, appVersion: 'gladys-hydrawise-1.0.0' }),
  };
}

const ok = (data) => ({ status: 200, body: JSON.stringify({ data }) });

test('a query is a POST with the token and appVersion', async () => {
  const { gql, calls } = client([ok({ me: { controllers: [] } })]);
  await gql.readAccount();
  const [call] = calls;
  assert.equal(call.url, `${GRAPHQL_URL}?appVersion=gladys-hydrawise-1.0.0`);
  assert.equal(call.method, 'POST');
  assert.equal(call.headers.authorization, 'bearer token-1');
  assert.equal(JSON.parse(call.body).query, READ_QUERY);
});

test('a 401 signs in again once, then reports the refusal', async () => {
  const unauthorized = { status: 401, body: 'Unauthorized' };
  const { gql, auth } = client([unauthorized, ok({ me: {} })]);
  await gql.readAccount();
  assert.equal(auth.invalidated, 1);

  const second = client([unauthorized, unauthorized]);
  await assert.rejects(second.gql.readAccount(), { kind: ERROR_KINDS.AUTH });
});

test('HTTP and GraphQL errors have their kind', async () => {
  const cases = [
    [{ status: 429, body: '' }, ERROR_KINDS.RATE_LIMITED],
    [{ status: 502, body: '<html>Bad gateway</html>' }, ERROR_KINDS.API],
    [{ status: 200, body: 'not json' }, ERROR_KINDS.API],
    [{ status: 200, body: JSON.stringify({ errors: [{ message: 'boom' }] }) }, ERROR_KINDS.API],
    [{ status: 200, body: JSON.stringify({ data: null }) }, ERROR_KINDS.API],
  ];
  for (const [response, kind] of cases) {
    const { gql } = client([response]);
    await assert.rejects(gql.readAccount(), { kind }, JSON.stringify(response));
  }
});

test('a mutation answering ERROR is refused with its summary; WARNING passes', async () => {
  const refused = client([ok({ stopZone: { status: 'ERROR', summary: 'Controller offline' } })]);
  await assert.rejects(refused.gql.mutate('stopZone', { zoneId: 1 }), {
    kind: ERROR_KINDS.REFUSED,
    message: /Controller offline/,
  });
  const warned = [];
  const warning = client([ok({ stopZone: { status: 'WARNING', summary: 'Queued' } })]);
  warning.gql.logger = { warn: (message) => warned.push(message) };
  await warning.gql.mutate('stopZone', { zoneId: 1 });
  assert.equal(warned.length, 1);
  const falsy = client([ok({ stopZone: null })]);
  await assert.rejects(falsy.gql.mutate('stopZone', { zoneId: 1 }), { kind: ERROR_KINDS.REFUSED });
});
