// -----------------------------------------------------------------------------
// The one function that talks to the network: an HTTPS request on the global
// fetch of Node, with a timeout and a bounded body. The clients take it as a
// parameter: the tests replace it with an in-memory Hydrawise cloud
// (test/helpers/fakeHydrawise.js), and never touch the network.
// -----------------------------------------------------------------------------

import { ERROR_KINDS, HydrawiseError } from './errors.js';

const MAX_BODY_BYTES = 4 * 1024 * 1024;

/**
 * @param {string} url absolute URL
 * @param {object} [options]
 * @param {string} [options.method]
 * @param {Record<string, string>} [options.headers]
 * @param {string} [options.body]
 * @param {number} [options.timeoutMs]
 * @returns {Promise<{ status: number, body: string }>}
 * @throws {HydrawiseError} UNREACHABLE when no answer came back
 */
export async function httpRequest(
  url,
  { method = 'GET', headers = {}, body, timeoutMs = 30_000 } = {},
) {
  let response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    // Never the URL: the REST API carries the API key in its query string.
    const reason =
      err?.name === 'TimeoutError'
        ? `no answer after ${timeoutMs} ms`
        : err?.cause?.code || err?.message;
    throw new HydrawiseError(ERROR_KINDS.UNREACHABLE, `Hydrawise unreachable (${reason})`);
  }
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_BODY_BYTES) {
    throw new HydrawiseError(ERROR_KINDS.API, 'Hydrawise answer too large');
  }
  return { status: response.status, body: text };
}
