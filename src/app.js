import path from 'node:path';
import fs from 'node:fs';
import { Store } from './store.js';
import { Launcher } from './launcher.js';
import { ProfileService } from './profiles.js';
import { createServer } from './server.js';

export const DEFAULT_PORT = 50325; // same port as AdsPower's local API

/** Wires store, launcher, profile service and HTTP server together. */
export function createApp({ dataDir, port = DEFAULT_PORT, host = '127.0.0.1', debug = false } = {}) {
  fs.mkdirSync(dataDir, { recursive: true });
  const store = new Store(path.join(dataDir, 'db.json'));
  let baseUrl = `http://${host}:${port}`;
  const launcher = new Launcher({ store, dataDir, getServerUrl: () => baseUrl, debug });
  const profiles = new ProfileService(store, launcher);
  const server = createServer({ store, launcher, profiles, getBaseUrl: () => baseUrl });

  return {
    store,
    launcher,
    profiles,
    server,
    get baseUrl() {
      return baseUrl;
    },
    listen(listenPort = port) {
      return new Promise((resolve, reject) => {
        const onError = (e) => {
          server.off('listening', onListening);
          reject(e);
        };
        const onListening = () => {
          server.off('error', onError);
          baseUrl = `http://${host}:${server.address().port}`;
          resolve(baseUrl);
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(listenPort, host);
      });
    },
    async close() {
      await launcher.stopAll();
      await new Promise((r) => {
        server.close(() => r());
        server.closeAllConnections();
      });
    },
  };
}
