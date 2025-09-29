import { Request, Response, NextFunction } from 'express';
import fs from 'fs';
import path from 'path';

// Load valid bearer tokens from environment and/or file once at startup.
// - POTDB_TOKENS: comma-separated list of tokens
// - POTDB_TOKEN: single token (for convenience)
// - POTDB_TOKENS_FILE: path to a file containing one token per line ("#" comments allowed)

function loadTokens(): Set<string> {
  const tokens = new Set<string>();

  const envList = process.env.POTDB_TOKENS || '';
  envList
    .split(',')
    .map((s) => s.trim())
    .filter((s) => !!s)
    .forEach((t) => tokens.add(t));

  const single = (process.env.POTDB_TOKEN || '').trim();
  if (single) tokens.add(single);

  const filePath = (process.env.POTDB_TOKENS_FILE || '').trim();
  if (filePath) {
    try {
      const resolved = path.isAbsolute(filePath)
        ? filePath
        : path.join(process.cwd(), filePath);
      const contents = fs.readFileSync(resolved, 'utf8');
      contents
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => !!l && !l.startsWith('#'))
        .forEach((l) => tokens.add(l));
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(`Auth: failed to read tokens file at ${filePath}:`, (e as Error).message);
    }
  }

  return tokens;
}

const TOKENS = loadTokens();

export function getLocalAuthToken(): string | undefined {
  // Return the first available token (stable order not guaranteed)
  for (const t of TOKENS) return t;
  return undefined;
}

export function authMiddleware(req: Request, res: Response, next: NextFunction) {
  const header = req.headers['authorization'] || '';
  const parts = Array.isArray(header) ? header[0] : header;
  const prefix = 'bearer ';
  const value = parts.toLowerCase().startsWith(prefix)
    ? (parts as string).slice(prefix.length)
    : parts.startsWith('Bearer ')
    ? (parts as string).slice('Bearer '.length)
    : undefined;

  const token = value?.trim();
  if (!token || !TOKENS.has(token)) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  (req as any).user = { id: 'token', token };
  next();
}
