// -----------------------------------------------------------------------------
// Sign-in to the Hydrawise account, as the Hydrawise app and pydrawise do: an
// OAuth2 "password" grant on the token endpoint, with the public client id of
// the Hydrawise app, then "refresh_token" grants while the session lasts.
//
// The token is kept under /data (src/store.js), tied to the account (a hash
// of the e-mail, never the e-mail itself): a restart reuses it instead of
// signing in again, and another account starts a new session. The password
// is only sent when there is no usable refresh token.
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { ERROR_KINDS, HydrawiseError, kindOfStatus, parseJson } from './errors.js';

export const TOKEN_URL = 'https://app.hydrawise.com/api/v2/oauth/access-token';

// The client of the Hydrawise mobile app: public, the same for every user,
// published by pydrawise (Apache 2.0). Not a secret of this integration.
export const CLIENT_ID = 'hydrawise_app';
export const CLIENT_SECRET = 'zn3CrjglwNV1';

// Refreshed this long before it expires (pydrawise: 5 minutes).
const REFRESH_MARGIN_MS = 5 * 60_000;

/** The account a saved token belongs to, without storing the e-mail. */
export const accountHash = (username) =>
  createHash('sha256').update(username.trim().toLowerCase()).digest('hex');

export class TokenAuth {
  /**
   * @param {object} options
   * @param {string} options.username
   * @param {string} options.password
   * @param {Function} options.request HTTP seam (src/hydrawise/http.js)
   * @param {{ load: Function, save: Function }} [options.tokens] persistence of the token
   * @param {() => number} [options.now]
   */
  constructor({ username, password, request, tokens, now = () => Date.now() }) {
    this.username = username;
    this.password = password;
    this.request = request;
    this.tokens = tokens;
    this.now = now;
    this.account = accountHash(username);
    this.token = null;
    this.loaded = false;
    /** One sign-in at a time: concurrent callers wait for the same one. */
    this.pending = null;
  }

  /** The Authorization header value, signing in or refreshing when needed. */
  async header() {
    if (!this.loaded) {
      this.loaded = true;
      const saved = await this.tokens?.load();
      if (saved && saved.account === this.account && saved.refresh) {
        this.token = saved;
      }
    }
    if (!this.token || this.token.expires - this.now() < REFRESH_MARGIN_MS) {
      this.pending ??= this.renew().finally(() => {
        this.pending = null;
      });
      await this.pending;
    }
    return `${this.token.type} ${this.token.access}`;
  }

  /** The service refused the token (401): sign in again at the next request. */
  invalidate() {
    if (this.token) {
      this.token = { ...this.token, expires: 0 };
    }
  }

  async renew() {
    if (this.token?.refresh) {
      try {
        await this.grant({ grant_type: 'refresh_token', refresh_token: this.token.refresh });
        return;
      } catch (err) {
        if (err.kind !== ERROR_KINDS.AUTH) {
          throw err;
        }
        // An expired or revoked refresh token: sign in with the password.
      }
    }
    await this.grant({
      grant_type: 'password',
      scope: 'all',
      username: this.username,
      password: this.password,
    });
  }

  async grant(fields) {
    const body = new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      ...fields,
    }).toString();
    const response = await this.request(TOKEN_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body,
    });
    const kind = kindOfStatus(response.status);
    if (kind === ERROR_KINDS.RATE_LIMITED || response.status >= 500) {
      throw new HydrawiseError(kind, `Hydrawise sign-in: HTTP ${response.status}`, {
        status: response.status,
      });
    }
    const json = parseJson(response.body, 'Hydrawise sign-in');
    if (json?.error || kind) {
      this.token = null;
      await this.tokens?.save(null);
      // The service's own words ("Invalid username or password"), never ours.
      const reason = String(json?.message || json?.error || `HTTP ${response.status}`).slice(
        0,
        120,
      );
      throw new HydrawiseError(ERROR_KINDS.AUTH, `Hydrawise sign-in refused: ${reason}`, {
        status: response.status,
      });
    }
    if (!json.access_token || !Number.isFinite(Number(json.expires_in))) {
      throw new HydrawiseError(ERROR_KINDS.API, 'Hydrawise sign-in: no token in the answer');
    }
    this.token = {
      account: this.account,
      access: json.access_token,
      // A refresh grant may not hand out a new refresh token: keep the old one.
      refresh: json.refresh_token || this.token?.refresh || null,
      type: json.token_type || 'Bearer',
      expires: this.now() + Number(json.expires_in) * 1000,
    };
    await this.tokens?.save(this.token);
  }
}
