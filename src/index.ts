import express from 'express';
import { apiRouter } from './api';
import { authMiddleware } from './auth';
import { startReplication, replicationRouter } from './replication';
import http from 'http';

export function createApp() {
  const app = express();

  app.use(express.json());
  app.use(authMiddleware);

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.use('/api', apiRouter);
  app.use('/replicate', replicationRouter);

  app.use(
    (err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      // eslint-disable-next-line no-console
      console.error(err);
      res.status(500).json({ error: 'Internal Server Error' });
    },
  );

  return app;
}

export function startServer(port = Number(process.env.PORT || 3000)) {
  const app = createApp();
  const server = http.createServer(app);
  server.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`PotDB listening on http://localhost:${port}`);
    startReplication();
  });
  return server;
}

if (require.main === module) {
  startServer();
}
