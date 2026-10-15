// -----------------------------------------------------------------------------
// Small persistence under /data (the only writable path of the container): the
// Hydrawise session token, so a restart refreshes it instead of sending the
// password again. Losing the file is harmless: the next start signs in.
// The file is written with mode 600; it never holds the password nor the
// e-mail (src/hydrawise/auth.js keeps a hash of it).
// (Adapted from guim31/gladys-pihole.)
// -----------------------------------------------------------------------------

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createLogger } from '@gladysassistant/integration-sdk';

const logger = createLogger({ name: 'hydrawise-store' });
const FILE_NAME = 'hydrawise-session.json';

export class Store {
  constructor(directory = process.env.HYDRAWISE_DATA_DIR || '/data') {
    this.directory = directory;
    this.path = join(directory, FILE_NAME);
    this.latest = {};
    this.pending = null;
    this.writing = null;
  }

  async load() {
    try {
      const data = JSON.parse(await readFile(this.path, 'utf8'));
      this.latest = data && typeof data === 'object' ? data : {};
    } catch (err) {
      if (err.code !== 'ENOENT') {
        logger.warn(`Cannot read ${this.path}: ${err.message}`);
      }
      this.latest = {};
    }
    return this.latest;
  }

  /** The token persistence of src/hydrawise/auth.js. */
  tokens() {
    return {
      load: async () => (await this.load()).token ?? null,
      save: (token) => this.save({ ...this.latest, token }),
    };
  }

  // Writes are coalesced and atomic (temporary file + rename): a crash never
  // leaves half a JSON file behind.
  save(data) {
    this.latest = data;
    if (!this.pending) {
      // Chained after the write in progress, if any: one writer at a time.
      this.pending = (this.writing ?? Promise.resolve()).then(async () => {
        const snapshot = this.latest;
        this.pending = null;
        try {
          await mkdir(this.directory, { recursive: true });
          const temporary = `${this.path}.tmp`;
          await writeFile(temporary, JSON.stringify(snapshot), { mode: 0o600 });
          await rename(temporary, this.path);
        } catch (err) {
          logger.warn(`Cannot write ${this.path}: ${err.message}`);
        }
      });
      this.writing = this.pending;
    }
    return this.pending;
  }

  /** Resolves once every write requested so far is on disk. */
  flush() {
    return this.writing ?? Promise.resolve();
  }
}
