import { v4 as uuidv4 } from 'uuid';
import { db } from './db';

export type Doc = {
  _id: string;
  _rev?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
};

// Simple per-document mutex to serialize writes to the same _id
class Mutex {
  private queue: Array<() => void> = [];
  private locked = false;

  async acquire(): Promise<() => void> {
    return new Promise<() => void>((resolve) => {
      const release = () => {
        const next = this.queue.shift();
        if (next) {
          next();
        } else {
          this.locked = false;
        }
      };

      if (!this.locked) {
        this.locked = true;
        resolve(release);
      } else {
        this.queue.push(() => resolve(release));
      }
    });
  }

  isLocked(): boolean {
    return this.locked;
  }
}

const mutexes = new Map<string, Mutex>();
function getMutex(id: string): Mutex {
  let m = mutexes.get(id);
  if (!m) {
    m = new Mutex();
    mutexes.set(id, m);
  }
  return m;
}

function parseJSON<T>(str: string): T | undefined {
  try {
    return JSON.parse(str) as T;
  } catch {
    return undefined;
  }
}

function nextRev(prev?: string): string {
  if (!prev) return `1-${uuidv4().slice(0, 8)}`;
  const dash = prev.indexOf('-');
  let n = 0;
  if (dash > 0) {
    const num = Number(prev.slice(0, dash));
    if (Number.isFinite(num)) n = num as number;
  }
  const next = (n || 0) + 1;
  return `${next}-${uuidv4().slice(0, 8)}`;
}

export async function get(_id: string): Promise<Doc | undefined> {
  try {
    const str = await db.get(_id);
    return parseJSON<Doc>(str);
  } catch (err: any) {
    if (err && err.notFound) return undefined;
    throw err;
  }
}

export async function put(input: Partial<Doc>): Promise<Doc> {
  const _id = input._id || uuidv4();
  const release = await getMutex(_id).acquire();
  try {
    let existing: Doc | undefined;
    try {
      const str = await db.get(_id);
      existing = parseJSON<Doc>(str);
    } catch (err: any) {
      if (!(err && err.notFound)) throw err;
    }

    if (existing) {
      if (!input._rev || input._rev !== existing._rev) {
        const e: any = new Error('conflict: revision mismatch');
        e.status = 409;
        throw e;
      }
    } else {
      // If creating new doc and _rev was provided, require it to be absent to avoid accidental overwrite
      if (input._rev) {
        const e: any = new Error('conflict: document does not exist');
        e.status = 409;
        throw e;
      }
    }

    const next = { ...existing, ...input, _id } as Doc;
    next._rev = nextRev(existing?._rev);

    await db.put(_id, JSON.stringify(next));
    return next;
  } finally {
    release();
  }
}

export async function del(_id: string): Promise<void> {
  const release = await getMutex(_id).acquire();
  try {
    try {
      await db.del(_id);
    } catch (err: any) {
      if (err && err.notFound) return; // idempotent
      throw err;
    }
  } finally {
    release();
  }
}

export async function listIds(limit = 100): Promise<string[]> {
  const ids: string[] = [];
  for await (const k of db.keys({ limit })) {
    ids.push(k);
  }
  return ids;
}

// Transaction context for operations under a single per-document lock
export type DocTransaction = {
  get(): Promise<Doc | undefined>;
  // CAS put that merges input with existing and generates next _rev
  put(input: Partial<Doc>): Promise<Doc>;
  // Idempotent delete. If prevRev provided, enforces CAS.
  del(prevRev?: string): Promise<void>;
  // Replace exactly with provided doc, enforcing that current _rev === expectedPrevRev
  replaceExact(doc: Doc, expectedPrevRev?: string): Promise<void>;
};

export async function withDocTransaction
  <T>(_id: string, fn: (tx: DocTransaction) => Promise<T>): Promise<T> {
  const release = await getMutex(_id).acquire();
  try {
    async function load(): Promise<Doc | undefined> {
      try {
        const str = await db.get(_id);
        return parseJSON<Doc>(str);
      } catch (err: any) {
        if (err && err.notFound) return undefined;
        throw err;
      }
    }

    async function casReplace(doc: Doc, expectedPrevRev?: string): Promise<void> {
      const existing = await load();
      const currentRev = existing?._rev;
      if ((currentRev || undefined) !== (expectedPrevRev || undefined)) {
        const e: any = new Error('conflict: revision mismatch');
        e.status = 409;
        throw e;
      }
      await db.put(_id, JSON.stringify({ ...doc, _id }));
    }

    async function casDelete(prevRev?: string): Promise<void> {
      const existing = await load();
      const currentRev = existing?._rev;
      if (prevRev !== undefined) {
        if ((currentRev || undefined) !== (prevRev || undefined)) {
          const e: any = new Error('conflict: revision mismatch');
          e.status = 409;
          throw e;
        }
      }
      if (existing) {
        await db.del(_id);
      }
    }

    async function casPut(input: Partial<Doc>): Promise<Doc> {
      const existing = await load();
      if (existing) {
        if (!input._rev || input._rev !== existing._rev) {
          const e: any = new Error('conflict: revision mismatch');
          e.status = 409;
          throw e;
        }
      } else {
        if (input._rev) {
          const e: any = new Error('conflict: document does not exist');
          e.status = 409;
          throw e;
        }
      }
      const next: Doc = { ...existing, ...input, _id } as Doc;
      next._rev = nextRev(existing?._rev);
      await db.put(_id, JSON.stringify(next));
      return next;
    }

    const tx: DocTransaction = {
      get: load,
      put: casPut,
      del: casDelete,
      replaceExact: casReplace,
    };

    const result = await fn(tx);
    // eslint-disable-next-line no-console
    console.log('[tx] commit', { _id });
    return result;
  } finally {
    release();
  }
}

// Apply a remote upsert with explicit revision, enforcing CAS on prevRev.
export async function applyRemotePut(doc: Doc, prevRev?: string): Promise<Doc> {
  const _id = doc._id;
  if (!doc._rev) {
    const e: any = new Error('invalid: missing _rev for remote put');
    e.status = 400;
    throw e;
  }
  const release = await getMutex(_id).acquire();
  try {
    let existing: Doc | undefined;
    try {
      const str = await db.get(_id);
      existing = parseJSON<Doc>(str);
    } catch (err: any) {
      if (!(err && err.notFound)) throw err;
    }

    const currentRev = existing?._rev;
    if ((currentRev || undefined) !== (prevRev || undefined)) {
      const e: any = new Error('conflict: revision mismatch');
      e.status = 409;
      throw e;
    }

    const toStore: Doc = { ...doc, _id };
    await db.put(_id, JSON.stringify(toStore));
    return toStore;
  } finally {
    release();
  }
}

// Apply a remote delete with explicit expected previous revision.
export async function applyRemoteDel(_id: string, prevRev?: string): Promise<void> {
  const release = await getMutex(_id).acquire();
  try {
    let existing: Doc | undefined;
    try {
      const str = await db.get(_id);
      existing = parseJSON<Doc>(str);
    } catch (err: any) {
      if (err && err.notFound) existing = undefined;
      else throw err;
    }

    const currentRev = existing?._rev;
    if ((currentRev || undefined) !== (prevRev || undefined)) {
      const e: any = new Error('conflict: revision mismatch');
      e.status = 409;
      throw e;
    }

    if (existing) {
      await db.del(_id);
    }
  } finally {
    release();
  }
}
