import fs from 'fs';
import path from 'path';

export type AppConfig = {
  peers: string[];
};

function parsePeers(raw: string | string[] | undefined): string[] {
  if (!raw) return [];
  const arr = Array.isArray(raw) ? raw : String(raw).split(',');
  return arr
    .map((s) => (s ?? '').toString().trim())
    .filter((s) => !!s);
}

function loadFromFile(filePath: string): Partial<AppConfig> | undefined {
  try {
    const resolved = path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath);
    const json = fs.readFileSync(resolved, 'utf8');
    const data = JSON.parse(json) as Partial<AppConfig>;
    return data;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(`Config: failed to read config file at ${filePath}:`, (e as Error).message);
    return undefined;
  }
}

function loadConfig(): AppConfig {
  // Start with env peers
  let peers = parsePeers(process.env.POTDB_PEERS);

  // If a JSON config file is provided, allow it to override peers
  const cfgPath = (process.env.POTDB_CONFIG_FILE || '').trim();
  if (cfgPath) {
    const cfg = loadFromFile(cfgPath);
    if (cfg && cfg.peers) {
      peers = parsePeers(cfg.peers as unknown as string[]);
    }
  }

  // If no peers configured explicitly, attempt Kubernetes StatefulSet autodiscovery
  if (!peers || peers.length === 0) {
    const hostname = (process.env.HOSTNAME || '').trim();
    // Expect something like "potdb-2" → baseName="potdb", myIndex=2
    const m = hostname.match(/^(.*)-(\d+)$/);
    if (m) {
      const baseName = m[1];
      const myIndex = Number(m[2]);
      if (Number.isFinite(myIndex) && myIndex > 0) {
        const scheme = (process.env.POTDB_SCHEME || process.env.POTDB_PEER_SCHEME || 'http').replace(/:\/\/$/, '');
        const port = Number(process.env.PORT || process.env.POTDB_PORT || 3000);
        const headlessSvc = (process.env.POTDB_K8S_HEADLESS_SERVICE || '').trim();
        const buildHost = (i: number) => (headlessSvc ? `${baseName}-${i}.${headlessSvc}` : `${baseName}-${i}`);
        const urls: string[] = [];
        for (let i = 0; i < myIndex; i += 1) {
          urls.push(`${scheme}://${buildHost(i)}:${port}`);
        }
        peers = urls;
        // eslint-disable-next-line no-console
        console.log('[config] Kubernetes autodiscovery enabled from HOSTNAME', {
          hostname,
          baseName,
          myIndex,
          peers,
        });
      }
    }
  }

  return { peers };
}

const CONFIG: AppConfig = loadConfig();

export function getPeers(): string[] {
  return CONFIG.peers;
}

export { CONFIG };
