// -----------------------------------------------------------------------------
// A request budget over a sliding window: "at most N requests per W". The
// Hydrawise cloud publishes no quota; the GraphQL one of this integration is
// pydrawise's (5 requests per 30 minutes, the HybridClient default Home
// Assistant runs with since Hydrawise started refusing frequent GraphQL
// polling). See CLAUDE.md, "Hydrawise".
// -----------------------------------------------------------------------------

export class Budget {
  /**
   * @param {object} options
   * @param {number} options.tokens requests allowed per window
   * @param {number} options.windowMs
   * @param {() => number} [options.now]
   */
  constructor({ tokens, windowMs, now = () => Date.now() }) {
    this.tokens = tokens;
    this.windowMs = windowMs;
    this.now = now;
    this.spent = [];
  }

  prune() {
    const since = this.now() - this.windowMs;
    while (this.spent.length > 0 && this.spent[0] <= since) {
      this.spent.shift();
    }
  }

  /** Requests still allowed now. */
  available() {
    this.prune();
    return this.tokens - this.spent.length;
  }

  /** Spend one request if the budget allows it; false otherwise. */
  trySpend() {
    if (this.available() <= 0) {
      return false;
    }
    this.spent.push(this.now());
    return true;
  }

  /** When the next request will be allowed (now if it already is). */
  nextAt() {
    this.prune();
    return this.spent.length < this.tokens ? this.now() : this.spent[0] + this.windowMs;
  }
}
