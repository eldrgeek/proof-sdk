import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import { createVersoRoutes, type AnthropicClient } from './routes.js';

/** Only this key is imported, once during server startup. Tests inject a reader. */
export function loadVersoKey(files: string, read: (file: string) => string = file => readFileSync(file, 'utf8')): string {
  for (const file of files.split(':').filter(Boolean)) {
    let raw: string; try { raw = read(file); } catch { continue; }
    for (const line of raw.split(/\r?\n/)) {
      const match = line.match(/^\s*(?:export\s+)?ANTHROPIC_API_KEY\s*=\s*(.*?)\s*$/);
      if (match) { const key = match[1].replace(/^(['"])(.*)\1$/, '$2'); if (key) return key; }
    }
  }
  return '';
}
let configured = createVersoRoutes({ client: null, key: '', dataDir: '.' });
export const versoRoutes = Router();
versoRoutes.use((req, res, next) => configured(req, res, next));
export function initializeVerso(): void {
  const key = loadVersoKey(process.env.PROOF_VERSO_CRED_FILES ?? '/opt/soma-infer/.env');
  const client: AnthropicClient | null = key ? { messages: { create: async params => {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01', 'x-api-key': key },
      body: JSON.stringify(params), signal: AbortSignal.timeout(45000),
    });
    // Provider error bodies may contain request material. Never expose or log them.
    if (!response.ok) throw new Error('Verso unavailable');
    return response.json();
  } } } : null;
  configured = createVersoRoutes({ key, client,
    model: process.env.PROOF_VERSO_MODEL || 'claude-haiku-4-5',
    dailyCap: process.env.PROOF_VERSO_DAILY_CAP === undefined ? 300 : Number(process.env.PROOF_VERSO_DAILY_CAP),
    dataDir: process.env.PROOF_DATA_DIR || path.dirname(path.resolve(process.env.DATABASE_PATH || 'proof-share.db')),
  });
}
