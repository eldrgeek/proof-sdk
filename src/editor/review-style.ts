export type ReviewStyle = 'proof' | 'playmaker';
export const REVIEW_STYLE_KEY = 'proof:review-style';
export const REVIEW_WALK_KEY = 'proof:review-walk';
export const REVIEW_STYLE_EVENT = 'proof:review-style-changed';
let runtimeReviewStyle: ReviewStyle | null = null;

export function normalizeReviewStyle(value: unknown): ReviewStyle {
  return typeof value === 'string' && value.trim().toLowerCase() === 'playmaker' ? 'playmaker' : 'proof';
}

export function getReviewStyle(): ReviewStyle {
  if (runtimeReviewStyle) return runtimeReviewStyle;
  let saved: string | null = null;
  try { saved = window.localStorage.getItem(REVIEW_STYLE_KEY); } catch { /* Storage is optional. */ }
  const config = (window as Window & { __PROOF_CONFIG__?: { defaultReviewStyle?: string } }).__PROOF_CONFIG__;
  return normalizeReviewStyle(saved === 'proof' || saved === 'playmaker' ? saved : config?.defaultReviewStyle);
}

export function setReviewStyle(style: ReviewStyle): void {
  runtimeReviewStyle = style;
  try { window.localStorage.setItem(REVIEW_STYLE_KEY, style); } catch { /* Storage is optional. */ }
  // The runtime value also makes switching immediate when storage is unavailable.
  const target = window as Window & { __PROOF_CONFIG__?: { defaultReviewStyle?: string } };
  target.__PROOF_CONFIG__ = { ...target.__PROOF_CONFIG__, defaultReviewStyle: style };
  window.dispatchEvent(new CustomEvent(REVIEW_STYLE_EVENT, { detail: style }));
}

export function getReviewWalk(): boolean {
  try { return window.localStorage.getItem(REVIEW_WALK_KEY) !== 'false'; } catch { return true; }
}
export function setReviewWalk(enabled: boolean): void {
  try { window.localStorage.setItem(REVIEW_WALK_KEY, String(enabled)); } catch { /* Storage is optional. */ }
}
