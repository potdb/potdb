import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';

const TOKEN = 'replica-token';
const PORT_A = 3211;
const PORT_B = 3212;

function wait(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForHealth(baseUrl: string, token: string, timeoutMs = 5000) {
  const start = Date.now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const res = await fetch(baseUrl + '/health', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) return;
    } catch {}
    if (Date.now() - start > timeoutMs) throw new Error('timeout waiting for health: ' + baseUrl);
    await wait(100);
  }
}

describe('push replication and eventual consistency', () => {
  const tmpRoot = path.join(process.cwd(), 'tmp-it');
  const dataA = path.join(tmpRoot, 'dataA');
  const dataB = path.join(tmpRoot, 'dataB');
  let procA: any;
  let procB: any;

  beforeAll(async () => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    fs.mkdirSync(dataA, { recursive: true });
    fs.mkdirSync(dataB, { recursive: true });

    const startPath = path.join(process.cwd(), 'start.js');

    procA = spawn(process.execPath, [startPath], {
      env: {
        ...process.env,
        PORT: String(PORT_A),
        POTDB_DATA_DIR: dataA,
        POTDB_TOKEN: TOKEN,
        POTDB_PEERS: `http://127.0.0.1:${PORT_B}`,
        POTDB_HTTP_TIMEOUT_MS: '2000',
      },
      stdio: 'ignore',
    });

    procB = spawn(process.execPath, [startPath], {
      env: {
        ...process.env,
        PORT: String(PORT_B),
        POTDB_DATA_DIR: dataB,
        POTDB_TOKEN: TOKEN,
        POTDB_PEERS: `http://127.0.0.1:${PORT_A}`,
        POTDB_HTTP_TIMEOUT_MS: '2000',
      },
      stdio: 'ignore',
    });

    await Promise.all([
      waitForHealth(`http://127.0.0.1:${PORT_A}`, TOKEN),
      waitForHealth(`http://127.0.0.1:${PORT_B}`, TOKEN),
    ]);
  }, 20000);

  afterAll(async () => {
    if (procA && !procA.killed) procA.kill('SIGTERM');
    if (procB && !procB.killed) procB.kill('SIGTERM');
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  test(
    'write to A replicates to B and delete propagates',
    async () => {
      const baseA = `http://127.0.0.1:${PORT_A}`;
      const baseB = `http://127.0.0.1:${PORT_B}`;

      // Create on A
      const createRes = await fetch(baseA + '/api/docs', {
        method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ title: 'rtest' }),
      });
      expect(createRes.status).toBe(201);
      const doc = (await createRes.json()) as any;
      expect(doc._id).toBeTruthy();
      expect(doc._rev).toBeTruthy();

      // Immediately query B (should already have acked before 201)
      const getB = await fetch(`${baseB}/api/docs/${doc._id}`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      });

      // If not yet present (due to timing), poll for a short while
      let bodyB: any;
      if (getB.status === 200) {
        bodyB = await getB.json();
      } else {
        const start = Date.now();
        while (Date.now() - start < 3000) {
          await wait(100);
          const r = await fetch(`${baseB}/api/docs/${doc._id}`, {
            headers: { Authorization: `Bearer ${TOKEN}` },
          });
          if (r.status === 200) {
            bodyB = await r.json();
            break;
          }
        }
      }

      expect(bodyB).toBeDefined();
      expect(bodyB._id).toBe(doc._id);
      expect(bodyB._rev).toBe(doc._rev);

      // Delete on A
      const delRes = await fetch(`${baseA}/api/docs/${doc._id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      expect(delRes.status).toBe(204);

      // Verify deleted on B
      const afterDelB = await fetch(`${baseB}/api/docs/${doc._id}`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      expect(afterDelB.status === 404 || afterDelB.status === 200).toBeTruthy();
      if (afterDelB.status === 200) {
        // allow a brief delay then it should be gone
        const start = Date.now();
        let ok = false;
        while (Date.now() - start < 3000) {
          await wait(100);
          const r = await fetch(`${baseB}/api/docs/${doc._id}`, {
            headers: { Authorization: `Bearer ${TOKEN}` },
          });
          if (r.status === 404) {
            ok = true;
            break;
          }
        }
        expect(ok).toBe(true);
      }
    },
    30000,
  );
});
