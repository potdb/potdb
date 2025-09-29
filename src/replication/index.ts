import { Router, Request, Response } from 'express';
import * as store from '../storage';
import { getLocalAuthToken } from '../auth';
import { getPeers } from '../config';

export type ReplicatePut = {
  op: 'put';
  _id: string;
  prevRev?: string;
  rev: string; // revision of the incoming doc
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  doc: any; // full doc including _id and _rev=rev
};

export type ReplicateDel = {
  op: 'del';
  _id: string;
  prevRev?: string;
};

export type ReplicateMsg = ReplicatePut | ReplicateDel;

const DEFAULT_TIMEOUT = Number(process.env.POTDB_HTTP_TIMEOUT_MS || 3000);


function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = setTimeout(() => reject(new Error('timeout')), ms);
    p.then((v) => {
      clearTimeout(id);
      resolve(v);
    }).catch((e) => {
      clearTimeout(id);
      reject(e);
    });
  });
}

export async function pushToPeers(change: ReplicateMsg): Promise<{
  acks: string[]; // peers that acked 200
  conflicts: string[]; // peers that returned 409
  failures: string[]; // peers unreachable or 5xx
}> {
  const peers = getPeers();
  const urlPath = '/replicate';
  // eslint-disable-next-line no-console
  console.log('[replication] pushing change to peers:', JSON.stringify(change));
  const results = await Promise.all(
    peers.map(async (base) => {
      try {
        const url = base.endsWith('/') ? `${base.slice(0, -1)}${urlPath}` : `${base}${urlPath}`;
        const token = getLocalAuthToken();
        const headers: Record<string, string> = { 'content-type': 'application/json' };
        if (token) headers['authorization'] = `Bearer ${token}`;
        const res = await withTimeout(
          fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(change),
          }),
          DEFAULT_TIMEOUT,
        );
        if (res.status === 200) return { peer: base, type: 'ack' as const };
        if (res.status === 409) return { peer: base, type: 'conflict' as const };
        return { peer: base, type: 'failure' as const };
      } catch {
        return { peer: base, type: 'failure' as const };
      }
    }),
  );

  const acks = results.filter((r) => r.type === 'ack').map((r) => r.peer);
  const conflicts = results.filter((r) => r.type === 'conflict').map((r) => r.peer);
  const failures = results.filter((r) => r.type === 'failure').map((r) => r.peer);
  // eslint-disable-next-line no-console
  console.log('[replication] results:', { acks, conflicts, failures });
  if (conflicts.length > 0) {
    // eslint-disable-next-line no-console
    console.warn('[replication] conflicts with peers:', conflicts);
  }
  if (failures.length > 0) {
    // eslint-disable-next-line no-console
    console.warn('[replication] failed to reach peers:', failures);
  }
  return { acks, conflicts, failures };
}

export const replicationRouter = Router();

// Receiver endpoint for replication
replicationRouter.post('/', async (req: Request, res: Response) => {
  const body = req.body as ReplicateMsg;
  if (!body || !body.op || !body._id) {
    return res.status(400).json({ error: 'invalid payload' });
  }
  try {
    if (body.op === 'put') {
      const { doc, prevRev } = body;
      if (!doc || doc._id !== body._id || doc._rev !== body.rev) {
        return res.status(400).json({ error: 'invalid put payload' });
      }
      await store.applyRemotePut(doc, prevRev);
      // eslint-disable-next-line no-console
      console.log('[replication] received put', { _id: body._id, prevRev, rev: body.rev });
      return res.status(200).json({ ok: true });
    }

    if (body.op === 'del') {
      await store.applyRemoteDel(body._id, body.prevRev);
      // eslint-disable-next-line no-console
      console.log('[replication] received del', { _id: body._id, prevRev: body.prevRev });
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: 'invalid op' });
  } catch (e: any) {
    const status = e?.status || 500;
    // eslint-disable-next-line no-console
    console.warn('[replication] error applying change', { status, message: e?.message });
    return res.status(status).json({ error: e?.message || 'error' });
  }
});

export function startReplication() {
  // No background tasks for push-only replication.
}
