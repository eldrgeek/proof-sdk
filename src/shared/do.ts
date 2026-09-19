/**
 * Proof Documents — `{do}` action lines, SAFE SLICE (pure code, shared by the browser and server).
 *
 * Authorship: direction by Mike Wolf ("marks like hyperlinks take action … they incorporate the
 * ideas in Pulse Zero", 18 Sept 2026); design by Claude (Fable 5.1, do-design.md); adversarial
 * critique by Astra (OpenAI Sol, do-critique-astra.md), which wins where they conflict; built by
 * Claude Opus 5 (worker proof-do), 2026-09-18, while Mike slept. Rules marked POLICY are
 * Claude's decisions where neither document decides; each is a one-line change.
 *
 * A `{do}` turns one line of a document into one typed action (the Pulse Zero `payload.actions`
 * v1 shape). THIS SLICE NEVER EXECUTES ANYTHING: `DO_POLICY.executionEnabled` is false, the Run
 * button is disabled, and the only executor is a NullExecutor that refuses. What exists:
 *   - the v1 validator (`actionErrors`, ported from pulse-zero/public/pulse-actions.js) plus an
 *     operation table (`DO_OPERATIONS`) that OWNS each operation's consequence text, verified
 *     predicate, blast radius, required params and gate rules (critique 6, 7);
 *   - an immutable canonical action digest (operation + params + account + gate + consequence +
 *     permitted presser + retry budget, plus the line text and revision) that an approval binds
 *     (critique 4);
 *   - the state machine: proposed → approved → queued → running → (needs-finger →) verifying →
 *     done | failed, plus `stalled` (a timeout is "unknown", never "failed": critique 5) and
 *     `withdrawn`;
 *   - run authorization (`authorizeRun`): approval exists, is not revoked, matches the current
 *     digest, is not used up (single use by default), the presser is permitted, the presser is a
 *     Mac principal, and no earlier run is unresolved;
 *   - receipt mapping from the bridge's real row semantics (row status `open` + `result.state`,
 *     `human_gate.target_ready`: critique 7). Receipts are kept apart from agreement: nothing here
 *     writes a line mark (critique 6).
 */
import { actorKey, actorLabel, isAiActor, resolveLineAnchor, type DocLine, type LineAnchor } from './line-marks.js';
import { isVerifiedHumanActor } from './identity.js';

// ============================================================================
// POLICY
// ============================================================================

export const DO_POLICY = {
  /**
   * THE switch. False: no `{do}` runs, from any route, whatever else is true. Turning it on is
   * an attended decision with Mike, after the checklist in docs/agent-docs.md (§ {do}).
   */
  executionEnabled: false,
  /** What the disabled Run button says. */
  executionDisabledLabel: 'Execution not enabled yet',
  /** An approval allows one run (plus `retryBudget` retries, 0 by default). Critique 4. */
  approvalSingleUse: true,
  defaultRetryBudget: 0,
  maxRetryBudget: 3,
  /** An active run with no receipt for this long is `stalled` (unknown), never `failed`. Critique 5. */
  stallAfterMs: 15 * 60 * 1000,
  /** A run waiting on the human's click (needs-finger) does not stall: it waits for a person. */
  needsFingerStalls: false,
  /**
   * Who may approve: only a person signed in to this server (a verified session, human:<email>),
   * never a guest, an agent key, a share token or the owner credential (scripts). Critique 1.
   * Enforced by the routes; recorded here so the rule is visible in one place.
   */
  approverSources: ['session'] as const,
  /** An approver must be named in the `{do}`'s `to` list ... */
  approverMustBeInTo: true,
  /** ... and hold Owner rights on the document (creator or Documents admin). */
  approverMustBeOwner: true,
  /** An approve / revoke request must carry this site's Origin header (CSRF; critique 1). */
  approveRequiresOriginHeader: true,
  /**
   * Document identity is not Mac authority (critique 1). Running needs the presser to be one of
   * these people as well. Checked by authorizeRun; nothing runs in this slice anyway.
   */
  macPrincipals: ['human:mw@mike-wolf.com'] as readonly string[],
  /** Who may press Run after approval: 'approver' = only the person who approved. In the digest. */
  defaultPresser: 'approver' as const,
  /** Who may propose a `{do}`: AIs and verified people; a guest cannot (like objections). */
  guestsMayPropose: false,
  /** A verified receipt never marks the line Agreed (critique 6). Tests assert this stays false. */
  receiptMarksLineAgreed: false,
  /** One `{do}` per line: a second returns 409 DO_EXISTS. */
  oneDoPerLine: true,
  /** A `{do}` whose line was deleted is listed but is not an Issue. */
  orphanedIsIssue: false,
  maxTo: 5,
  maxParamString: 200,
  maxParams: 12,
} as const;

// ============================================================================
// The v1 action (Pulse Zero payload.actions contract_version 1)
// ============================================================================

export const DO_CONTRACT_VERSION = 1;
export type DoExecutorKind = 'workflow' | 'web' | 'mac';
const EXECUTORS = new Set<string>(['workflow', 'web', 'mac']);
const ACTION_ID_RE = /^[a-z][a-z0-9-]{0,63}$/;
const TARGET_REF_RE = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/;

export interface DoHumanGate {
  instruction: string;
  target: { url: string; ref: string; label: string };
}

export interface DoAction {
  id: string;
  revision: number;
  executor: DoExecutorKind;
  label: string;
  description?: string;
  operation: string;
  params: Record<string, unknown>;
  human_gate?: DoHumanGate;
  completion: { mode: 'verified'; success_message: string; close_card?: boolean };
  verification: { kind: string; params?: Record<string, unknown> };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isAbsoluteHttpsUrl(value: unknown): boolean {
  if (!nonEmptyString(value)) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && !!parsed.hostname;
  } catch {
    return false;
  }
}

/**
 * Port of `actionErrors(action, index)` from pulse-zero/public/pulse-actions.js (contract v1),
 * message for message, so a `{do}` and a Pulse card accept the same actions.
 */
export function actionErrors(action: unknown, index = 0): string[] {
  const at = `actions[${index}]`;
  const errors: string[] = [];
  if (!isObject(action)) return [`${at} must be an object`];
  if (!ACTION_ID_RE.test(String(action.id || ''))) {
    errors.push(`${at}.id must be a lowercase slug (letters, numbers, hyphens)`);
  }
  if (!Number.isInteger(action.revision) || (action.revision as number) < 1) {
    errors.push(`${at}.revision must be a positive integer`);
  }
  if (!EXECUTORS.has(action.executor as string)) {
    errors.push(`${at}.executor must be workflow, web, or mac`);
  }
  if (!nonEmptyString(action.label)) errors.push(`${at}.label is required`);
  if ('description' in action && !nonEmptyString(action.description)) {
    errors.push(`${at}.description must be a non-empty string when present`);
  }
  if (!nonEmptyString(action.operation)) errors.push(`${at}.operation is required`);
  if (!isObject(action.params)) errors.push(`${at}.params must be an object`);

  const completion = action.completion;
  if (!isObject(completion) || completion.mode !== 'verified') {
    errors.push(`${at}.completion.mode must be verified`);
  }
  if (!isObject(completion) || !nonEmptyString(completion.success_message)) {
    errors.push(`${at}.completion.success_message is required`);
  }
  if (isObject(completion) && 'close_card' in completion && typeof completion.close_card !== 'boolean') {
    errors.push(`${at}.completion.close_card must be a boolean when present`);
  }

  const verification = action.verification;
  if (!isObject(verification) || !nonEmptyString(verification.kind)) {
    errors.push(`${at}.verification.kind is required`);
  }
  if (isObject(verification) && 'params' in verification && !isObject(verification.params)) {
    errors.push(`${at}.verification.params must be an object when present`);
  }

  if ('human_gate' in action) {
    if (!['workflow', 'web'].includes(action.executor as string)) {
      errors.push(`${at}.human_gate is only valid for workflow or web executors`);
    }
    const gate = action.human_gate;
    if (!isObject(gate) || !nonEmptyString(gate.instruction)) {
      errors.push(`${at}.human_gate.instruction is required`);
    }
    const target = isObject(gate) ? gate.target : null;
    if (!isObject(target)) {
      errors.push(`${at}.human_gate.target must be an object`);
    } else {
      if (!isAbsoluteHttpsUrl(target.url)) {
        errors.push(`${at}.human_gate.target.url must be an absolute https URL`);
      }
      if (!TARGET_REF_RE.test(String(target.ref || ''))) {
        errors.push(`${at}.human_gate.target.ref must name a Yeshie abstract target`);
      }
      if (!nonEmptyString(target.label)) {
        errors.push(`${at}.human_gate.target.label is required`);
      }
    }
  }
  return errors;
}

// ============================================================================
// The operation table: consequence text is OWNED by the operation (critique 6, 7)
// ============================================================================

export type BlastRadius = 'read-only' | 'reversible' | 'irreversible';

export interface DoOperationSpec {
  executor: DoExecutorKind;
  operation: string;
  /** What running it does, shown above Approve. `{param}` fills in a validated param. */
  consequence: string;
  /** What "done" will mean: the exact predicate the executor verifies. */
  verifiedPredicate: string;
  blastRadius: BlastRadius;
  requiredParams: readonly string[];
  /** The param that names the account the action acts on (part of the digest), or null. */
  accountParam: string | null;
  humanGate: 'required' | 'forbidden';
  gateUrlPrefix?: string;
  gateRefs?: readonly string[];
  verificationKinds: readonly string[];
}

/**
 * Mirrors pulse-mac-bridge's allowlist (ACTION_OPERATIONS + HUMAN_GATE_SELECTORS, read
 * 2026-09-18). The bridge stays the real boundary; this table decides what a page may even show.
 * Irreversible operations are not allowed in the table until Mike rules (design Q4).
 */
export const DO_OPERATIONS: Readonly<Record<string, DoOperationSpec>> = Object.freeze({
  'workflow/gdoc_bridge_authorize': {
    executor: 'workflow',
    operation: 'gdoc_bridge_authorize',
    consequence: 'Opens Google’s consent page on Mike’s Mac to authorize the Google Docs bridge (Cloud project {project_id}) for {account}. Nothing is granted until a person clicks Allow there.',
    verifiedPredicate: 'Google Drive answers an "about" request as {account}.',
    blastRadius: 'reversible',
    requiredParams: ['project_id', 'account'],
    accountParam: 'account',
    humanGate: 'required',
    gateUrlPrefix: 'https://accounts.google.com/',
    gateRefs: ['google.oauth.consent.primary'],
    verificationKinds: ['google_drive_about'],
  },
});

export function operationKey(action: Pick<DoAction, 'executor' | 'operation'>): string {
  return `${action.executor}/${action.operation}`;
}

export function operationSpec(action: Pick<DoAction, 'executor' | 'operation'> | null | undefined): DoOperationSpec | null {
  if (!action) return null;
  return DO_OPERATIONS[operationKey(action)] ?? null;
}

/** Values that look like credentials never belong in params (they are references only). */
const CREDENTIAL_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /\b(ghp|gho|ghs|github_pat)_[A-Za-z0-9_]{16,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{30,}/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./,
  /\bsb_(secret|publishable)_[A-Za-z0-9_-]{10,}/,
];
const SECRET_KEY_NAME = /(pass(word)?|secret|token|api[_-]?key|private[_-]?key|credential|cookie|session)/i;
const SAFE_PARAM_VALUE = /^[\p{L}\p{N} @._:/+=,#()-]*$/u;

export function looksLikeCredential(value: string): boolean {
  return CREDENTIAL_PATTERNS.some(pattern => pattern.test(value));
}

/**
 * The `{do}` checks on top of the v1 validator: the operation is in the table, its params are
 * present, flat, short and not secret, its gate and verification match the table.
 */
export function doActionErrors(action: unknown): string[] {
  const errors = actionErrors(action, 0).map(error => error.replace(/^actions\[0\]/, 'action'));
  if (errors.length) return errors;
  const a = action as DoAction;
  const spec = operationSpec(a);
  if (!spec) {
    return [`action ${operationKey(a)} is not an allowed operation (allowed: ${Object.keys(DO_OPERATIONS).join(', ')})`];
  }
  if (spec.blastRadius === 'irreversible') errors.push('irreversible operations are not allowed yet');
  const params = a.params;
  const keys = Object.keys(params);
  if (keys.length > DO_POLICY.maxParams) errors.push(`action.params may have at most ${DO_POLICY.maxParams} entries`);
  for (const key of keys) {
    const value = params[key];
    if (SECRET_KEY_NAME.test(key)) errors.push(`action.params.${key}: params are references, never secrets`);
    if (typeof value === 'string') {
      if (value.length > DO_POLICY.maxParamString) errors.push(`action.params.${key} is too long`);
      if (looksLikeCredential(value)) errors.push(`action.params.${key} looks like a credential; params are references, never secrets`);
      else if (!SAFE_PARAM_VALUE.test(value)) errors.push(`action.params.${key} has characters a param may not carry`);
    } else if (typeof value !== 'number' && typeof value !== 'boolean') {
      errors.push(`action.params.${key} must be a string, number or boolean`);
    }
  }
  for (const key of spec.requiredParams) {
    if (!nonEmptyString(params[key])) errors.push(`${operationKey(a)} requires action.params.${key}`);
  }
  if (!spec.verificationKinds.includes(a.verification.kind)) {
    errors.push(`${operationKey(a)} requires verification.kind ${spec.verificationKinds.join(' or ')}`);
  }
  if (spec.humanGate === 'required' && !a.human_gate) errors.push(`${operationKey(a)} requires action.human_gate`);
  if (spec.humanGate === 'forbidden' && a.human_gate) errors.push(`${operationKey(a)} takes no human_gate`);
  if (a.human_gate) {
    if (spec.gateUrlPrefix && !a.human_gate.target.url.startsWith(spec.gateUrlPrefix)) {
      errors.push(`action.human_gate.target.url must start with ${spec.gateUrlPrefix}`);
    }
    if (spec.gateRefs && !spec.gateRefs.includes(a.human_gate.target.ref)) {
      errors.push(`action.human_gate.target.ref must be one of ${spec.gateRefs.join(', ')}`);
    }
  }
  for (const text of [a.label, a.description ?? '', a.completion.success_message, a.human_gate?.instruction ?? '']) {
    if (looksLikeCredential(text)) errors.push('the action text looks like it carries a credential');
  }
  return errors;
}

function fill(template: string, params: Record<string, unknown>): string {
  return template.replace(/\{([a-z_][a-z0-9_]*)\}/gi, (_, key: string) => {
    const value = params[key];
    return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value) : `{${key}}`;
  });
}

/** The operation's own words for what running it does (never the author's). */
export function consequenceText(action: DoAction | null): string {
  const spec = operationSpec(action);
  if (!action || !spec) return 'Unknown operation: this cannot run.';
  return fill(spec.consequence, action.params);
}

/** The operation's own words for what a verified receipt will mean. */
export function verifiedPredicateText(action: DoAction | null): string {
  const spec = operationSpec(action);
  if (!action || !spec) return '';
  return fill(spec.verifiedPredicate, action.params);
}

export function accountOf(action: DoAction | null): string | null {
  const spec = operationSpec(action);
  if (!action || !spec || !spec.accountParam) return null;
  const value = action.params[spec.accountParam];
  return typeof value === 'string' ? value : null;
}

// ============================================================================
// Records
// ============================================================================

export interface DoApproval {
  id: string;
  by: string;
  at: string;
  /** The canonical action digest the person approved. */
  digest: string;
  /** Where the identity came from: only 'session' is ever accepted. */
  source: string;
  revokedAt: string | null;
  revokedBy: string | null;
}

/** A receipt from the executor, in the bridge's own row terms (critique 7). */
export interface DoReceipt {
  at: string;
  /** mac_commands.status: open | done | failed (the bridge keeps active runs at `open`). */
  rowStatus: string;
  /** result.state while active: queued | running | waiting_human | verifying. */
  state?: string | null;
  verified?: boolean;
  /** result.human_gate.target_ready: Yeshie has the control on screen. */
  targetReady?: boolean;
  /** result.safe_message (display only; never raw output). */
  safeMessage?: string | null;
  verificationKind?: string | null;
  /** The digest the executor ran: a receipt for another digest certifies nothing. */
  digest: string;
}

export interface DoRun {
  id: string;
  attempt: number;
  approvalId: string;
  digest: string;
  presser: string;
  startedAt: string;
  receipts: DoReceipt[];
}

export interface ProofDo {
  id: string;
  /** Who proposed it (an AI or a verified person). */
  by: string;
  /** Who may approve: verified people (human:<email>). */
  to: string[];
  /** Who may press Run after approval: 'approver' or one actor. Part of the digest. */
  presser: string;
  /** Retries one approval allows after a failed run (0 = single use). Part of the digest. */
  retryBudget: number;
  action: DoAction;
  anchor: LineAnchor;
  createdAt: string;
  withdrawnAt: string | null;
  /** Every approval, oldest first (revoked ones stay: the audit trail). */
  approvals: DoApproval[];
  runs: DoRun[];
}

// ============================================================================
// The canonical action digest (critique 4)
// ============================================================================

/** JSON with sorted keys at every level, so one action has exactly one serialization. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter(key => obj[key] !== undefined).sort();
  return `{${keys.map(key => `${JSON.stringify(key)}:${stableStringify(obj[key])}`).join(',')}}`;
}

/**
 * Everything an approval binds. Any change here voids an approval: the operation, its params and
 * account, the gate, the verification, the operation's consequence and predicate text (so a new
 * table wording needs a new approval), the permitted presser, the retry budget, the action's
 * revision and the line's text (the imperative title the approver read).
 */
export function digestInput(record: Pick<ProofDo, 'id' | 'action' | 'presser' | 'retryBudget'>, lineHash: string | null, slug: string): string {
  const a = record.action;
  return stableStringify({
    v: DO_CONTRACT_VERSION,
    document: slug,
    do: record.id,
    line: lineHash,
    action: { id: a.id, revision: a.revision },
    operation: operationKey(a),
    params: a.params,
    account: accountOf(a),
    gate: a.human_gate ?? null,
    verification: a.verification,
    consequence: consequenceText(a),
    predicate: verifiedPredicateText(a),
    presser: record.presser,
    retryBudget: record.retryBudget,
  });
}

// Compact SHA-256 (FIPS 180-4) so the browser and server compute the same digest synchronously.
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export function sha256Hex(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const bitLength = bytes.length * 8;
  const padded = new Uint8Array(((bytes.length + 9 + 63) >> 6) << 6);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bitLength / 0x100000000));
  view.setUint32(padded.length - 4, bitLength >>> 0);
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i += 1) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0; h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
  }
  return [...h].map(x => x.toString(16).padStart(8, '0')).join('');
}

export function actionDigest(record: Pick<ProofDo, 'id' | 'action' | 'presser' | 'retryBudget'>, lineHash: string | null, slug: string): string {
  return `sha256:${sha256Hex(digestInput(record, lineHash, slug))}`;
}

// ============================================================================
// The state machine
// ============================================================================

export type DoState =
  | 'proposed' | 'approved' | 'queued' | 'running' | 'needs-finger' | 'verifying'
  | 'done' | 'failed' | 'stalled' | 'withdrawn';

export const DO_STATE_LABEL: Record<DoState, string> = {
  proposed: 'Waiting for approval',
  approved: 'Approved',
  queued: 'Queued',
  running: 'Running',
  'needs-finger': 'Needs your click on the Mac',
  verifying: 'Verifying',
  done: 'Done (verified)',
  failed: 'Failed',
  stalled: 'Stalled: result unknown',
  withdrawn: 'Withdrawn',
};

const ACTIVE_PHASES = new Set<DoState>(['queued', 'running', 'needs-finger', 'verifying']);

export function isActivePhase(state: DoState): boolean {
  return ACTIVE_PHASES.has(state);
}

/**
 * One receipt in the bridge's terms -> a state. The bridge keeps queued, running and waiting runs
 * at row status `open` and reports the phase in `result.state`; only `done` + `verified: true`
 * for the run's own digest is Done. A waiting run is `needs-finger` only once the control is on
 * screen (`target_ready`); before that the Mac is still getting it ready (running).
 */
export function receiptPhase(receipt: DoReceipt, runDigest: string): DoState {
  const status = String(receipt.rowStatus ?? '');
  if (status === 'done') return receipt.verified === true && receipt.digest === runDigest ? 'done' : 'failed';
  if (status === 'failed') return 'failed';
  if (status === 'open' || status === 'running' || status === 'waiting_human') {
    const state = receipt.state ?? (status === 'open' ? 'queued' : status);
    if (state === 'queued') return 'queued';
    if (state === 'running') return 'running';
    if (state === 'verifying') return 'verifying';
    if (state === 'waiting_human') return receipt.targetReady === true ? 'needs-finger' : 'running';
    return 'stalled'; // an active row with a state we do not know: unknown, not failed
  }
  return 'stalled'; // a row status we do not know: unknown, not failed
}

/** A run's state now: its latest receipt, or `stalled` when an active run went quiet too long. */
export function runPhase(run: DoRun, now: number, policy: { stallAfterMs: number; needsFingerStalls: boolean } = DO_POLICY): DoState {
  const receipts = [...run.receipts].sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const last = receipts[receipts.length - 1];
  const phase = last ? receiptPhase(last, run.digest) : 'queued';
  if (!isActivePhase(phase)) return phase;
  if (phase === 'needs-finger' && !policy.needsFingerStalls) return phase;
  const since = Date.parse(last ? last.at : run.startedAt);
  if (Number.isFinite(since) && now - since > policy.stallAfterMs) return 'stalled';
  return phase;
}

/** The latest approval that is not revoked, or null. */
export function currentApproval(record: ProofDo): DoApproval | null {
  const live = record.approvals.filter(approval => !approval.revokedAt);
  if (!live.length) return null;
  return [...live].sort((a, b) => String(a.at).localeCompare(String(b.at)))[live.length - 1];
}

/** Runs made under one approval. */
export function runsUnder(record: ProofDo, approvalId: string): DoRun[] {
  return record.runs.filter(run => run.approvalId === approvalId);
}

/** Is this approval still good for the action as it is now (not revoked, same digest)? */
export function approvalMatches(approval: DoApproval | null, digest: string): boolean {
  return Boolean(approval && !approval.revokedAt && approval.digest === digest);
}

/** How many more runs an approval allows (single use + retry budget). */
export function runsLeft(record: ProofDo, approval: DoApproval): number {
  const allowed = DO_POLICY.approvalSingleUse ? 1 + record.retryBudget : Number.POSITIVE_INFINITY;
  return Math.max(0, allowed - runsUnder(record, approval.id).length);
}

export interface DoView {
  record: ProofDo;
  lineIndex: number | null;
  lineHash: string | null;
  digest: string;
  state: DoState;
  approval: DoApproval | null;
  /** The live approval matches the action as it is now. */
  approvalCurrent: boolean;
  /** An approval exists but the action or its line changed since: shown, and it no longer counts. */
  approvalStale: boolean;
  latestRun: DoRun | null;
  consequence: string;
  predicate: string;
  account: string | null;
  blastRadius: BlastRadius | null;
  /** Who the `{do}` waits on now (for Issues). */
  openFor: string[];
}

export function evaluateDo(record: ProofDo, lines: DocLine[], slug: string, now: number = Date.now()): DoView {
  const resolved = resolveLineAnchor(lines, record.anchor);
  const line = resolved ? lines[resolved.lineIndex] : null;
  const lineHash = line ? line.hash : null;
  const digest = actionDigest(record, lineHash, slug);
  const approval = currentApproval(record);
  const approvalCurrent = approvalMatches(approval, digest);
  const runs = [...record.runs].sort((a, b) => (a.attempt - b.attempt) || String(a.startedAt).localeCompare(String(b.startedAt)));
  const latestRun = runs[runs.length - 1] ?? null;
  const lastPhase = latestRun ? runPhase(latestRun, now) : null;
  let state: DoState;
  if (record.withdrawnAt) state = 'withdrawn';
  // A run in flight (or one whose effect is unknown) is what is true, whatever happened to the
  // approval since: revoking an approval does not stop a run the executor already holds.
  else if (lastPhase && (isActivePhase(lastPhase) || lastPhase === 'stalled')) state = lastPhase;
  else if (latestRun && lastPhase && approval && latestRun.approvalId === approval.id && approvalCurrent && (lastPhase === 'done' || runsLeft(record, approval) === 0)) state = lastPhase;
  else if (approvalCurrent && approval && runsLeft(record, approval) > 0) state = latestRun && latestRun.approvalId === approval.id && lastPhase === 'failed' ? 'failed' : 'approved';
  // A verified run of exactly this action stays done even if its approval was revoked later.
  else if (latestRun && lastPhase === 'done' && latestRun.digest === digest) state = 'done';
  else state = 'proposed';
  const spec = operationSpec(record.action);
  let openFor: string[] = [];
  if (state === 'proposed') openFor = [...record.to];
  else if (state === 'needs-finger') openFor = latestRun ? [latestRun.presser] : [...record.to];
  else if (state === 'failed' || state === 'stalled') openFor = [...new Set([record.by, ...record.to])];
  else if (state === 'approved') openFor = DO_POLICY.executionEnabled && approval ? [presserFor(record, approval)] : [];
  return {
    record,
    lineIndex: line ? line.index : null,
    lineHash,
    digest,
    state,
    approval,
    approvalCurrent,
    approvalStale: Boolean(approval && !approvalCurrent),
    latestRun,
    consequence: consequenceText(record.action),
    predicate: verifiedPredicateText(record.action),
    account: accountOf(record.action),
    blastRadius: spec ? spec.blastRadius : null,
    openFor,
  };
}

export function evaluateDos(records: ProofDo[], lines: DocLine[], slug: string, now: number = Date.now()): DoView[] {
  return records.map(record => evaluateDo(record, lines, slug, now));
}

function presserFor(record: ProofDo, approval: DoApproval): string {
  return record.presser === 'approver' ? approval.by : record.presser;
}

// ============================================================================
// Who may approve, and run authorization
// ============================================================================

export type DoRefusal = { ok: false; status: number; code: string; error: string };

function refuse(status: number, code: string, error: string): DoRefusal {
  return { ok: false, status, code, error };
}

/**
 * May `actor` (whose identity came from `source`) approve this `{do}` now?
 * `isOwner`: the caller holds Owner rights on the document (creator or Documents admin).
 */
export function checkApprover(view: DoView, input: { actor: string; source: string; isOwner: boolean }): { ok: true } | DoRefusal {
  if (view.state === 'withdrawn') return refuse(409, 'DO_WITHDRAWN', 'This {do} was withdrawn');
  if (!(DO_POLICY.approverSources as readonly string[]).includes(input.source) || !isVerifiedHumanActor(input.actor)) {
    return refuse(403, 'SIGNED_IN_PERSON_REQUIRED', 'Only a person signed in to this site can approve a {do} (not a guest, an agent key, a share link or a script credential)');
  }
  if (isAiActor(input.actor)) return refuse(403, 'SIGNED_IN_PERSON_REQUIRED', 'An AI never approves a {do}');
  if (DO_POLICY.approverMustBeInTo && !view.record.to.some(member => actorKey(member) === actorKey(input.actor))) {
    return refuse(403, 'NOT_AN_APPROVER', `This {do} can be approved by ${view.record.to.map(actorLabel).join(', ') || 'nobody yet'}`);
  }
  if (DO_POLICY.approverMustBeOwner && !input.isOwner) return refuse(403, 'OWNER_REQUIRED', 'Approving a {do} needs Owner rights on this document');
  if (view.lineIndex === null) return refuse(409, 'LINE_NOT_FOUND', 'The {do} line is not in the document any more');
  if (!operationSpec(view.record.action)) return refuse(409, 'UNKNOWN_OPERATION', 'This operation is not allowed');
  if (view.state === 'approved' || (view.state === 'failed' && view.approvalCurrent)) {
    return refuse(409, 'ALREADY_APPROVED', 'Already approved for the action as it stands');
  }
  if (isActivePhase(view.state)) return refuse(409, 'RUN_ACTIVE', 'A run is in progress');
  if (view.state === 'stalled') return refuse(409, 'RUN_UNRESOLVED', 'An earlier run stalled and its effect is unknown; reconcile it first');
  if (view.state === 'done') return refuse(409, 'ALREADY_DONE', 'Already done (verified)');
  return { ok: true };
}

export interface RunPolicy {
  executionEnabled: boolean;
  macPrincipals: readonly string[];
  stallAfterMs: number;
  needsFingerStalls: boolean;
}

/**
 * Everything that must hold before an executor may be asked to run this `{do}`, checked in this
 * order: execution is enabled; the presser is a signed-in person; an approval exists, is not
 * revoked and matches the action as it is now (digest); the presser is the permitted presser and
 * a Mac principal; no earlier run is unresolved (a stalled run blocks: its effect is unknown);
 * the approval has runs left (single use). Pure: the caller records the run only after the
 * executor accepts it. `policy` exists so tests can exercise the checks behind the switch.
 */
export function authorizeRun(view: DoView, input: { presser: string; source: string; now?: number; policy?: RunPolicy }):
  { ok: true; approval: DoApproval; attempt: number } | DoRefusal {
  const policy = input.policy ?? DO_POLICY;
  const now = input.now ?? Date.now();
  if (!policy.executionEnabled) return refuse(409, 'EXECUTION_NOT_ENABLED', DO_POLICY.executionDisabledLabel);
  if (view.state === 'withdrawn') return refuse(409, 'DO_WITHDRAWN', 'This {do} was withdrawn');
  if (input.source !== 'session' || !isVerifiedHumanActor(input.presser)) {
    return refuse(403, 'SIGNED_IN_PERSON_REQUIRED', 'Only a signed-in person can press Run');
  }
  const approval = view.approval;
  if (!approval) {
    const revoked = view.record.approvals.some(a => a.revokedAt);
    return revoked ? refuse(403, 'APPROVAL_REVOKED', 'The approval was revoked') : refuse(403, 'APPROVAL_REQUIRED', 'Approve it first');
  }
  if (approval.revokedAt) return refuse(403, 'APPROVAL_REVOKED', 'The approval was revoked');
  if (approval.digest !== view.digest) return refuse(409, 'APPROVAL_STALE', 'The action or its line changed after it was approved; approve it again');
  if (actorKey(presserFor(view.record, approval)) !== actorKey(input.presser)) {
    return refuse(403, 'PRESSER_NOT_PERMITTED', `Only ${actorLabel(presserFor(view.record, approval))} may press Run`);
  }
  if (!policy.macPrincipals.some(p => actorKey(p) === actorKey(input.presser))) {
    return refuse(403, 'MAC_PRINCIPAL_REQUIRED', 'Running on the Mac needs a Mac principal');
  }
  const mine = runsUnder(view.record, approval.id);
  for (const run of mine) {
    const phase = runPhase(run, now, policy);
    if (isActivePhase(phase)) return refuse(409, 'RUN_ACTIVE', 'A run is in progress');
    if (phase === 'stalled') return refuse(409, 'RUN_UNRESOLVED', 'An earlier run stalled and its effect is unknown; reconcile it before running again');
    if (phase === 'done') return refuse(409, 'ALREADY_DONE', 'Already done (verified)');
  }
  if (runsLeft(view.record, approval) <= 0) return refuse(409, 'APPROVAL_USED', 'This approval was used; approve it again to run again');
  return { ok: true, approval, attempt: view.record.runs.length + 1 };
}

// ============================================================================
// Issues
// ============================================================================

export interface DoIssueInput {
  id: string;
  lineIndex: number;
  by: string;
  state: DoState;
  openFor: string[];
  label: string;
}

/** Every unfinished `{do}` is an Issue (type 'do'): all but done, withdrawn and orphaned. */
export function doIssueInputs(views: DoView[]): DoIssueInput[] {
  const out: DoIssueInput[] = [];
  for (const view of views) {
    // Orphaned (line deleted): listed, never an Issue here (DO_POLICY.orphanedIsIssue is false;
    // an orphan has no line to anchor an Issue to).
    if (view.lineIndex === null) continue;
    if (view.state === 'done' || view.state === 'withdrawn') continue;
    out.push({ id: view.record.id, lineIndex: view.lineIndex, by: view.record.by, state: view.state, openFor: view.openFor, label: view.record.action.label });
  }
  return out;
}

/** Plain-language status line for the control and for AIs reading /state. */
export function describeDo(view: DoView): string {
  if (view.lineIndex === null) return 'The {do} line was deleted';
  const parts: string[] = [DO_STATE_LABEL[view.state]];
  if (view.state === 'proposed') {
    parts.push(view.approvalStale ? 'changed since it was approved; approve again' : `approval: ${view.record.to.map(actorLabel).join(', ') || 'nobody named'}`);
  }
  if (view.state === 'approved' && view.approval) {
    parts.push(`by ${actorLabel(view.approval.by)}`);
    if (!DO_POLICY.executionEnabled) parts.push(DO_POLICY.executionDisabledLabel.toLowerCase());
  }
  return parts.join(' · ');
}

// ============================================================================
// Input helpers
// ============================================================================

/** Normalizes the `to` list shape (the server resolves each entry to a verified person). */
export function parseRetryBudget(value: unknown): number | null {
  if (value === undefined || value === null) return DO_POLICY.defaultRetryBudget;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > DO_POLICY.maxRetryBudget) return null;
  return n;
}

export function doTeamActors(records: ProofDo[]): string[] {
  const out: string[] = [];
  for (const record of records) out.push(record.by, ...record.to);
  return out;
}
