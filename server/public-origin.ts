import type { Request } from 'express';
import { resolvePublicOrigin } from './share-preview.js';

export function isSecureRequest(req: Request): boolean {
  if (req.secure) return true;
  const proto = (req.header('x-forwarded-proto') || '').split(',')[0]?.trim().toLowerCase();
  return proto === 'https';
}

export function getPublicOrigin(req: Request): string {
  const configured = process.env.PROOF_PUBLIC_ORIGIN?.trim();
  if (configured) return resolvePublicOrigin(configured);
  const host = req.get('host') || '';
  if (!host) return resolvePublicOrigin(null);
  return `${isSecureRequest(req) ? 'https' : 'http'}://${host}`;
}
