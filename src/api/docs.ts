import { Router, Request, Response } from 'express';
import * as store from '../storage';
import { pushToPeers, type ReplicateMsg } from '../replication';
import { v4 as uuidv4 } from 'uuid';

export const docsRouter = Router();

// List document IDs
// GET /api/docs
docsRouter.get('/', async (_req: Request, res: Response) => {
  const ids = await store.listIds(1000);
  res.json({ ids });
});

// Create or update a document
// POST /api/docs { _id?: string, _rev?: string, ...json }
docsRouter.post('/', async (req: Request, res: Response) => {
  const incoming = req.body || {};
  const desiredId: string = incoming._id || uuidv4();
  try {
    let result: any;
    await store.withDocTransaction(desiredId, async (tx) => {
      const prev = await tx.get();
      const saved = await tx.put({ ...incoming, _id: desiredId });

      const change: ReplicateMsg = {
        op: 'put',
        _id: saved._id,
        prevRev: prev?._rev,
        rev: saved._rev!,
        doc: saved,
      };

      const { conflicts } = await pushToPeers(change);
      if (conflicts.length > 0) {
        // Roll back local change while still holding the lock
        if (prev) {
          await tx.replaceExact(prev, saved._rev);
        } else {
          await tx.del(saved._rev);
        }
        const err: any = new Error('replication conflict');
        err.status = 409;
        throw err;
      }

      result = saved;
    });

    res.status(201).json(result);
  } catch (e: any) {
    const status = e?.status || 500;
    res.status(status).json({ error: e?.message || 'Internal Error' });
  }
});

// Fetch a document by ID
// GET /api/docs/:id
docsRouter.get('/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  const doc = await store.get(id);
  if (!doc) return res.status(404).json({ error: 'Not found' });
  res.json(doc);
});

// Delete a document by ID
// DELETE /api/docs/:id
docsRouter.delete('/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  try {
    await store.withDocTransaction(id, async (tx) => {
      const prev = await tx.get();
      await tx.del();

      const change: ReplicateMsg = { op: 'del', _id: id, prevRev: prev?._rev };
      const { conflicts } = await pushToPeers(change);
      if (conflicts.length > 0) {
        if (prev) {
          // Restore previous doc only if it existed; expect current to be deleted (prevRev undefined)
          await tx.replaceExact(prev, undefined);
        }
        const err: any = new Error('replication conflict');
        err.status = 409;
        throw err;
      }
    });

    res.status(204).send();
  } catch (e: any) {
    const status = e?.status || 500;
    res.status(status).json({ error: e?.message || 'Internal Error' });
  }
});
