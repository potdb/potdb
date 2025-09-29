import path from 'path';
import { Level } from 'level';

// Simple LevelDB instance for documents. Keys are doc IDs, values are JSON strings.
const DATA_DIR = process.env.POTDB_DATA_DIR || path.join(process.cwd(), 'data');

export type Doc = Record<string, unknown> & { id: string };

// Create/open a Level database at DATA_DIR
export const db = new Level<string, string>(path.join(DATA_DIR, 'docs'), {
  valueEncoding: 'utf8',
});

export async function closeDb(): Promise<void> {
  try {
    await db.close();
  } catch (e) {
    // ignore close errors
  }
}

export async function put(id: string, value: unknown): Promise<void> {
  const toStore = JSON.stringify(value);
  await db.put(id, toStore);
}

export async function get(id: string): Promise<unknown | undefined> {
  try {
    const str = await db.get(id);
    return JSON.parse(str);
  } catch (err: any) {
    if (err && err.notFound) return undefined;
    throw err;
  }
}

export async function del(id: string): Promise<void> {
  try {
    await db.del(id);
  } catch (err: any) {
    if (err && err.notFound) return; // idempotent
    throw err;
  }
}

export async function listKeys(limit = 100): Promise<string[]> {
  const keys: string[] = [];
  for await (const k of db.keys({ limit })) {
    keys.push(k);
  }
  return keys;
}
