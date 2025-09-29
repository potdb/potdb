import { Router } from 'express';
import { docsRouter } from './docs';

export const apiRouter = Router();

apiRouter.use('/docs', docsRouter);
