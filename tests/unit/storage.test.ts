import fs from 'fs';
import path from 'path';

describe('storage: basic operations and transactions', () => {
  const tmpRoot = path.join(process.cwd(), 'tmp-test-storage');
  const dataDir = path.join(tmpRoot, 'data1');

  let store: any;

  beforeAll(async () => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    fs.mkdirSync(dataDir, { recursive: true });
    jest.resetModules();
    process.env.POTDB_DATA_DIR = dataDir;
    store = await import('../../src/storage/docs');
  });

  afterAll(async () => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  test('put/get/delete with _rev CAS', async () => {
    // create new doc
    const created = await store.put({ title: 'hello' });
    expect(created._id).toBeTruthy();
    expect(created._rev).toBeTruthy();

    // get returns same doc
    const got = await store.get(created._id);
    expect(got).toBeDefined();
    expect(got!._rev).toBe(created._rev);
    expect(got!.title).toBe('hello');

    // update with correct _rev
    const updated = await store.put({ _id: created._id, _rev: created._rev, title: 'world' });
    expect(updated._rev).not.toBe(created._rev);
    expect(updated.title).toBe('world');

    // update with stale _rev should fail
    await expect(
      store.put({ _id: created._id, _rev: created._rev, title: 'again' }),
    ).rejects.toHaveProperty('status', 409);

    // delete
    await store.del(created._id);
    const afterDel = await store.get(created._id);
    expect(afterDel).toBeUndefined();
  });

  test('withDocTransaction serializes operations on the same _id', async () => {
    const id = 'txn-1';
    // Start a long transaction that holds the lock
    const started: string[] = [];
    const finished: string[] = [];

    const p1 = store.withDocTransaction(id, async (tx: any) => {
      started.push('p1');
      const d = await tx.put({ _id: id });
      // hold the lock for 200ms
      await new Promise((r) => setTimeout(r, 200));
      finished.push('p1');
      return d;
    });

    // Kick off a concurrent operation that should wait until p1 releases
    const p2 = (async () => {
      started.push('p2');
      // small delay to ensure p1 acquires first
      await new Promise((r) => setTimeout(r, 20));
      const before = Date.now();
      const res = await store.withDocTransaction(id, async (tx: any) => {
        started.push('p2-inner');
        const cur = await tx.get();
        // This should see result of p1
        expect(cur).toBeDefined();
        return cur;
      });
      const waited = Date.now() - before;
      // Should have waited at least ~150ms because p1 held lock ~200ms
      expect(waited).toBeGreaterThanOrEqual(150);
      finished.push('p2');
      return res;
    })();

    const [d1, d2] = await Promise.all([p1, p2]);
    expect(d1._id).toBe(id);
    expect(d2._id).toBe(id);
    // First finished should be p1 (it held the lock first)
    expect(finished[0]).toBe('p1');
  });
});
