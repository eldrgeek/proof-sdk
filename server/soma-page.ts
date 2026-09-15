import type { LibraryMember } from './library/auth.js';
import { isFeedbackEnabled } from './soma-feedback.js';

export function injectSomaFeedback(html: string, area: 'library' | 'editor' | 'sign-in', member?: LibraryMember): string {
  if (!isFeedbackEnabled()) return html;
  const identity = JSON.stringify(member ? { name: member.name, email: member.email } : null).replace(/</g, '\\u003c');
  const tags = `<script>window.somaFeedbackIdentity=${identity};</script>
<link rel="stylesheet" href="/vendor/soma-feedback/soma-feedback.css">
<script src="/vendor/soma-feedback/soma-feedback.js" data-endpoint="/api/soma-feedback" data-site="proof-plus" data-area="${area}" data-no-google defer></script>`;
  return html.replace(/<head\b[^>]*>/i, (head) => `${head}\n${tags}`);
}
