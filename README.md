# Hunter Hydrawise for Gladys Assistant

An external integration for [Gladys Assistant](https://gladysassistant.com) that follows and
controls **Hunter Hydrawise** sprinkler controllers (HC, HPC, Pro-HC, X2 with the Wi-Fi
module…) through the Hydrawise cloud, like the Home Assistant `hydrawise` integration does.

> **Developed without the hardware: feedback welcome.** The integration is built from the
> Hydrawise API as the [pydrawise](https://github.com/dknowles2/pydrawise) library and the Home
> Assistant integration use it, and tested against a simulated cloud built from their test
> fixtures, not against a real controller nor a real account. Please report what works and what
> does not in the [issues](https://github.com/guim31/gladys-hydrawise/issues).

## Features

- **One device per controller**, and per zone: **watering** (a switch: on waters the zone for
  the configured time, 10 minutes by default, off stops it), **time left** (minutes), **next
  watering** (date, or "suspended until…") and **water used today** (with a flow meter).
- Per controller: **online**, **automatic watering** (a switch: off suspends every zone for the
  configured number of days, 2 by default, and the schedule comes back on its own; on resumes),
  the **rain sensor** and **water used today** (with a flow meter).
- **Dashboard widget** "Hydrawise": the zones watering now and the next runs, today's water
  use, and four buttons: **Water…** (zone and duration), **Stop all**, **Suspend…** (days) and
  **Resume**.
- **Scene trigger** _Hydrawise: watering finished_ (zone, number, controller, minutes), fired
  when a zone stops on its own, not when Gladys stops it.
- **Scene actions**: _water a zone_ (by number or name, for N minutes), _stop watering_ (one
  zone, one controller, everything), _suspend watering_ (N days) and _resume watering_.
- A **Test the connection** button, a connection status that says what is wrong, a **cloud**
  transport badge per controller.
- Every text in English, French, German and Spanish.

## Requirements

- Gladys Assistant **5.2.0** or later (widget forms).
- A Hydrawise controller set up in the Hydrawise app and connected to the internet.
- The e-mail and password of the Hydrawise account, and/or its **API key** (hydrawise.com →
  Account details → API key). The account with its key is the recommended setup (Home
  Assistant's): the key alone works, without rain sensor, water use nor suspension dates.

## Installation

1. In Gladys, open **Integrations** → **Install from GitHub** and enter the address of this
   repository: `https://github.com/guim31/gladys-hydrawise` (or install **Hunter Hydrawise**
   from the catalog once it is listed).
2. In **Configuration**, enter the e-mail and password of the account, and the API key if you
   have one. **Test the connection**.
3. In the **Discovery** tab, add each controller.

The user documentation, in four languages, is in [`docs/`](docs/en.md).

## How it works

- **Sign-in**: the OAuth2 password grant of the Hydrawise app on
  `app.hydrawise.com/api/v2/oauth/access-token` (the public client id of the app, as pydrawise
  does), then refresh grants. The session token is kept under `/data` (mode 600, tied to a hash
  of the e-mail); the password and the API key stay in the Gladys configuration.
- **Reads**: the GraphQL API (`app.hydrawise.com/api/v2/graph`) with a minimal query, checked
  against the service schema in the tests; with an API key, the REST API v1
  (`api.hydrawise.com/api/v1`) for the frequent refreshes.
- **Quotas**: Hydrawise publishes none, but refuses frequent GraphQL polling. The integration
  keeps pydrawise's budget (5 GraphQL requests per 30 minutes): a read every 10 minutes with the
  account alone; with the API key, REST every 2 minutes (or the `nextpoll` the service asks
  for) and GraphQL every 30 minutes; water use hourly. HTTP 429 pauses that API 30 minutes; a
  refused password is retried after 30 minutes, never in a loop.
- **Own timer**: Gladys never polls the devices (`should_poll: false`); a one-minute timer of
  the container counts the time left down locally, ends a run at its end time, and reads the
  cloud when due. `onPoll` stays as a fallback.
- **Commands** go through GraphQL (REST with the API key alone). The expected state shows at
  once and is confirmed by a read 20 seconds later; a read that does not reflect a command yet
  does not undo it for 3 minutes (the controller fetches commands at its next contact).
- **States** are published only when they change (the SDK's `publishChangedStates`), re-sent
  every 6 hours as a heartbeat, and all again when a device is added.

## Checked, and what was not

Checked in this repository, without network: every GraphQL query and mutation against the
schema of the service (pydrawise's copy), the requests (form of the sign-in, `setzone.php`
parameters, suspension date format) against pydrawise's, the parsing on the fixtures of
pydrawise and Home Assistant, and the whole integration against the SDK's fake Gladys.

Not checked: a real account, a real controller, the actual quotas of the service, the meaning
of the flow meters' `waterFlow` (hence no flow rate feature). `scripts/probe.mjs` runs the real
sign-in path up to the refusal of an invented account, and, given credentials in environment
variables, a read-only pass over a real account (counts only):

```bash
node scripts/probe.mjs
HYDRAWISE_USERNAME=… HYDRAWISE_PASSWORD=… HYDRAWISE_API_KEY=… node scripts/probe.mjs
```

## Limitations

- Cloud only: nothing works without internet, no local control.
- No instantaneous flow rate; water use needs the account and a flow meter, refreshed hourly.
- The programs (start times, durations, watering days) stay in the Hydrawise app.
- With the API key only: no rain sensor, no water use, suspensions without end date.
- A run started from Gladys lasts at most 240 minutes; a suspension at most 365 days.

## Development

```bash
npm ci
npm run format:check
npm run lint
npm test
npx -y github:GladysAssistant/integration-store --skip-image-check .
```

The tests use the fake Gladys of the SDK (`@gladysassistant/integration-sdk/testing`) and an
in-memory Hydrawise cloud (`test/helpers/fakeHydrawise.js`) built from the fixtures of
`test/fixtures/`. See [`CLAUDE.md`](CLAUDE.md) for the project rules. Releases are made by the
Release workflow (Actions → Release).

## Credits

- [pydrawise](https://github.com/dknowles2/pydrawise) by David Knowles and contributors
  (Apache-2.0): the Hydrawise API (sign-in, GraphQL selections and mutations, REST calls, the
  REST rules, the GraphQL budget), its schema copy (`test/fixtures/hydrawise.graphql`) and the
  shapes of its test fixtures.
- Home Assistant's
  [`hydrawise`](https://github.com/home-assistant/core/tree/dev/homeassistant/components/hydrawise)
  integration (Apache-2.0), by its code owners: the hybrid account + API key setup, the
  refresh paces, the choice of entities and the rain sensor rule.
- The architecture and the conformity tests follow
  [gladys-wled](https://github.com/guim31/gladys-wled) and
  [gladys-pihole](https://github.com/guim31/gladys-pihole).

## Disclaimer

This project is not affiliated with, endorsed or sponsored by Hunter Industries. "Hunter" and
"Hydrawise" are trademarks of Hunter Industries.

## License

Apache-2.0
