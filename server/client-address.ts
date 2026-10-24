import type { Request } from 'express';

export function trustProxyHeaders(): boolean {
  const value = (process.env.PROOF_TRUST_PROXY_HEADERS || '').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}


export function getClientIp(req: Request): string {
  if (trustProxyHeaders()) {
    const realIp = req.header('x-real-ip')?.trim();
    if (realIp) return realIp;
    const forwardedFor = req.header('x-forwarded-for');
    if (typeof forwardedFor === 'string' && forwardedFor.trim()) {
      // The trusted proxy appends the last entry; leading entries are visitor input.
      const last = forwardedFor.split(',').at(-1)?.trim();
      if (last) return last;
    }
  }
  if (req.ip && req.ip.trim()) return req.ip;
  if (req.socket?.remoteAddress) return req.socket.remoteAddress;
  return 'unknown';
}
