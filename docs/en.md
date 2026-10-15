# Hunter Hydrawise

Control your **Hunter Hydrawise** sprinkler controllers (HC, HPC, Pro-HC, X2 with the Wi-Fi
module…) from Gladys, through the Hydrawise cloud: see which zone is watering and for how long,
the next scheduled run of each zone, the rain sensor and today's water use; water a zone for a
few minutes, stop everything, suspend the schedule for a few days and resume it.

This integration is not affiliated with Hunter Industries. Hydrawise is a trademark of Hunter
Industries.

> **Developed without the hardware: feedback welcome.** It was written from the Hydrawise API
> as the pydrawise library and the Home Assistant integration use it, and tested against a
> simulated cloud. Tell us what works and what does not on
> [GitHub](https://github.com/guim31/gladys-hydrawise/issues).

## Requirements

- Gladys Assistant 5.2.0 or later.
- A Hydrawise controller already set up in the Hydrawise app, and connected to the internet.
- The e-mail and password of your Hydrawise account, and/or its API key: on
  [hydrawise.com](https://app.hydrawise.com/), **Account details**, **API key**.
- Gladys must reach the internet (`app.hydrawise.com` and `api.hydrawise.com`, HTTPS).

## Configuration

In Gladys, **Integrations**, **Hunter Hydrawise**, **Configuration**:

| Field                         | Use                                                                                   |
| ----------------------------- | ------------------------------------------------------------------------------------- |
| Account e-mail                | The e-mail you sign in to the Hydrawise app with.                                     |
| Password                      | The password of the Hydrawise app.                                                    |
| API key (optional)            | With the account: faster refresh. Alone: works without the account.                   |
| Duration of the zone switches | How long a zone waters when its switch is turned on (5 to 60 minutes, 10 by default). |
| Suspension of the schedule    | How many days "Automatic watering" off suspends the schedule (2 by default).          |
| Language of the names         | Language of the feature names and of the texts (French by default).                   |

Then **Test the connection**: the integration lists your controllers and their zones. In the
**Discovery** tab, add each controller to Gladys.

### Which sign-in to choose

| Sign-in           | Refresh of the zones | Rain sensor, water use, suspension dates |
| ----------------- | -------------------- | ---------------------------------------- |
| Account           | every 10 minutes     | yes                                      |
| Account + API key | every 2 minutes      | yes                                      |
| API key only      | every 2 minutes      | no                                       |

The account with its API key is the setup Home Assistant uses, and the recommended one.

### Refresh pace and Hydrawise quotas

Hydrawise publishes no quota, but refuses too frequent requests on its GraphQL API (the one of
the account). The integration therefore follows the budget of the pydrawise library, which Home
Assistant runs with: **at most 5 GraphQL requests per 30 minutes**. With the account alone, a
read every 10 minutes, and today's water use once an hour. With the API key, the zones are read
through the older REST API every 2 minutes (or less often when Hydrawise asks for it, its
`nextpoll`), and the details through GraphQL every 30 minutes. Between two reads, the time left
of a run counts down locally, without any request. A refused request (HTTP 429) pauses that API
for 30 minutes; a refused password is tried again after 30 minutes only, never in a loop.

The integration refreshes on its own timer: Gladys does not need to poll the devices.

## Devices

One device per controller, with these features:

| Feature                | Type                       | Use                                                            |
| ---------------------- | -------------------------- | -------------------------------------------------------------- |
| Online                 | On/off, read only          | The controller is in contact with the Hydrawise cloud.         |
| Automatic watering     | Switch                     | Off: suspends every zone for the configured days. On: resumes. |
| Rain sensor            | Rain detection, read only  | When a rain sensor is wired (account sign-in).                 |
| Water used today       | Volume (liters), read only | With a flow meter (account sign-in), refreshed hourly.         |
| _zone_ · watering      | Switch                     | On: waters the zone for the configured time. Off: stops it.    |
| _zone_ · time left     | Duration (minutes)         | Time left of the run, 0 at rest.                               |
| _zone_ · next watering | Text                       | Date of the next run, or "Suspended until…".                   |
| _zone_ · water today   | Volume (liters), read only | With a flow meter.                                             |

Turning a zone switch on always waters for a limited time: Hydrawise stops the zone by itself
at the end, even if Gladys is down.

## Dashboard widget

The **Hydrawise** widget shows the number of zones watering now, the water used today (with a
flow meter), and a row per zone: watering with the time left, next run, suspended, or nothing
scheduled. Choose one controller in its settings, or leave it empty for all of them.

Its buttons:

- **Water…**: choose the zone and the duration (1 to 240 minutes).
- **Stop all**: stops every zone of the controllers shown.
- **Suspend…**: suspends the schedule for 1 to 30 days.
- **Resume**: ends the suspension now.

A check mark on **Suspend…** or **Resume** tells whether the schedule is suspended.

## Scene trigger

**Hydrawise: watering finished**: a zone stopped watering on its own, at the end of its run
or of its schedule (not when Gladys stopped it). Filter by controller if needed. Variables:
the zone name, the zone number, the controller name and the watering time in minutes.

To react to the start of a watering, use the state of the zone switch ("_zone_ · watering"
turns on) in a "device state" trigger.

## Scene actions

- **Hydrawise: water a zone**: the zone by its number or its name as in Hydrawise (accents and
  case ignored), and a duration in minutes (10 by default, 240 at most). With several
  controllers, choose the controller when the zone number exists on more than one.
- **Hydrawise: stop watering**: one zone, or every zone of one controller or of all of them.
- **Hydrawise: suspend watering**: for a number of days (2 by default), one zone or all of
  them; the schedule comes back on its own. Output: the end of the suspension.
- **Hydrawise: resume watering**: ends a suspension now.

## Scene examples

- **Rain forecast**: when the weather forecast announces rain tomorrow, **Hydrawise: suspend
  watering** for 2 days.
- **Notification at the end**: on **Hydrawise: watering finished**, send yourself "Watering of
  {{zone}} finished after {{minutes}} min".
- **Someone in the garden**: when the garden gate opens, **Hydrawise: stop watering**.
- **New lawn**: every day at 13:00, **Hydrawise: water a zone** "Front lawn" for 5 minutes.

## Troubleshooting

- **"Hydrawise refused the sign-in"**: check the e-mail and the password in the Hydrawise app,
  or the API key on hydrawise.com. After a refusal, the integration waits 30 minutes before
  trying again; saving the configuration tries at once.
- **"API key refused: the account alone refreshes the zones, more slowly"**: the key is wrong
  or revoked; generate a new one on hydrawise.com. With several controllers, the key may serve
  only one of them: the others are then refreshed through the account.
- **A started zone shows as watering, then nothing happens**: the controller fetches the
  commands from the cloud at its next contact. The integration shows the expected state for 3
  minutes, then the state Hydrawise reports.
- **The "Online" feature is off**: the controller lost its Wi-Fi, or the Hydrawise cloud does
  not answer.
- **More details**: set the `LOG_LEVEL` variable of the integration to `debug`. The logs never
  contain the password, the API key nor the session token.

## Limits

- Developed without the hardware nor a Hydrawise account: the queries are checked against the
  schema of the service, not against a real controller.
- Everything goes through the Hydrawise cloud: no local control, nothing works without
  internet.
- No instantaneous flow rate: the API reports one whose meaning is not documented.
- The water use needs the account sign-in and a flow meter, and is refreshed once an hour.
- The programs themselves (start times, durations, watering days) stay in the Hydrawise app.
- With the API key only: no rain sensor, no water use, and a suspension has no end date.
- A suspension of the schedule applies to every zone of a controller; suspend a single zone
  with the scene action.
