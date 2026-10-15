# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- Hunter Hydrawise sprinkler controllers through the Hydrawise cloud: sign-in
  with the account (e-mail and password), its API key, or both (recommended).
- One device per controller: online, automatic watering (a switch that
  suspends every zone for a configurable number of days, then resumes on its
  own), rain sensor, water used today (with a flow meter).
- Per zone: watering (a switch that waters for a configurable time, then stops
  on its own), time left, next watering (or "suspended until…"), water used
  today (with a flow meter).
- Dashboard widget "Hydrawise": the zones watering and the next runs, today's
  water use, and the Water…, Stop all, Suspend… and Resume buttons (Gladys
  5.2.0 or later).
- Scene trigger "Hydrawise: watering finished", with the zone, its number, the
  controller and the watering time.
- Scene actions: water a zone for N minutes (by number or name), stop watering,
  suspend watering for N days, resume watering.
- "Test the connection" button, connection status naming the problem, cloud
  transport badge per controller.
- Refresh on the integration's own timer, within the Hydrawise quotas
  (pydrawise's GraphQL budget); the session token kept under `/data`.
- Every text in English, French, German and Spanish, with the documentation in
  the four languages.

[Unreleased]: https://github.com/guim31/gladys-hydrawise/commits/main
