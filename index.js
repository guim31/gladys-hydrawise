// -----------------------------------------------------------------------------
// Entry point: wires the Gladys SDK to the Hydrawise hub (src/app.js). No
// device logic here. Handlers are registered before connect().
//
// Environment provided by the Gladys supervisor: GLADYS_HOST_API_URL,
// GLADYS_INTEGRATION_TOKEN, GLADYS_INTEGRATION_SELECTOR (read by the SDK),
// and TZ, the time zone of Gladys (the dates of the next waterings).
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { GladysIntegration, logger } from '@gladysassistant/integration-sdk';
import { registerHandlers } from './src/app.js';

const { version } = JSON.parse(
  readFileSync(new URL('./gladys-assistant-integration.json', import.meta.url), 'utf8'),
);

const gladys = new GladysIntegration();
// `appVersion` names this client to the Hydrawise GraphQL API, as pydrawise does.
const app = registerHandlers(gladys, { appVersion: `gladys-hydrawise-${version}` });

gladys.handleShutdown((signal) => {
  logger.info(`Received ${signal}, stopping`);
  return app.stop(); // waits for the last write under /data
});

logger.info(`Starting the Hunter Hydrawise integration ${version}...`);
gladys.connect().catch((err) => {
  logger.error('Initial connection failed', err);
  process.exit(1);
});
