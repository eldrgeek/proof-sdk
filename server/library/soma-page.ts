import { isSomaAuthEnabled } from './auth.js';

export function somaAuthHead(): string {
  if (!isSomaAuthEnabled()) return '';
  const config = JSON.stringify({ url: process.env.SOMA_AUTH_URL || '', anonKey: process.env.SOMA_AUTH_ANON_KEY || '' }).replace(/</g, '\\u003c');
  return `<script>window.PROOF_SOMA_CONFIG=${config};</script>
<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.57.4/dist/umd/supabase.js" defer></script>
<script src="/vendor/soma-auth/soma-auth-config.js" defer></script>
<script src="/vendor/soma-auth/soma-auth.js" defer></script>
<script src="/vendor/soma-auth/proof-session.js" defer></script>`;
}
