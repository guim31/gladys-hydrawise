// -----------------------------------------------------------------------------
// What can go wrong with the Hydrawise cloud, as a few kinds the hub and the
// texts know how to explain. A message never carries a password, a token or
// the API key: they only ever travel in request bodies and headers.
// -----------------------------------------------------------------------------

export const ERROR_KINDS = Object.freeze({
  AUTH: 'auth', // credentials or API key refused
  UNREACHABLE: 'unreachable', // no answer (network, DNS, timeout)
  RATE_LIMITED: 'rate_limited', // HTTP 429: too many requests
  API: 'api', // the service answered with an error (5xx, GraphQL error)
  REFUSED: 'refused', // a command refused by Hydrawise (status ERROR)
});

export class HydrawiseError extends Error {
  /**
   * @param {string} kind one of ERROR_KINDS
   * @param {string} message
   * @param {{ status?: number }} [details]
   */
  constructor(kind, message, { status } = {}) {
    super(message);
    this.name = 'HydrawiseError';
    this.kind = kind;
    this.status = status;
  }
}

/** The error kind of an HTTP status, null for a success. */
export function kindOfStatus(status) {
  if (status >= 200 && status < 300) {
    return null;
  }
  if (status === 401 || status === 403) {
    return ERROR_KINDS.AUTH;
  }
  if (status === 429) {
    return ERROR_KINDS.RATE_LIMITED;
  }
  return ERROR_KINDS.API;
}

/** Parse a JSON body, or throw an API error naming what was expected. */
export function parseJson(body, what) {
  try {
    return JSON.parse(body);
  } catch {
    throw new HydrawiseError(ERROR_KINDS.API, `${what}: the answer is not JSON`);
  }
}
