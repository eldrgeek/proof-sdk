/**
 * Proof Documents `{do}` — the executor boundary (STUB). Safe slice, 2026-09-18.
 *
 * Authorship: Claude Opus 5 (worker proof-do), per Astra's critique (do-critique-astra.md).
 *
 * THIS FILE HOLDS NO WAY TO RUN ANYTHING. There is no Supabase client, no mac_commands insert, no
 * credential and no network call here, on purpose. The only executor is NullExecutor, which
 * refuses every request. A real executor is built in an attended session with Mike, and only
 * after every item of the enablement checklist in docs/agent-docs.md (§ {do}) is done, starting
 * with a narrowly authorized enqueue RPC (never direct table inserts: the command bus also carries
 * shell-capable legacy commands, critique 2).
 */
import type { DoAction } from '../src/shared/do.js';

/** What an executor is handed: the approved, digest-bound action and who pressed Run. */
export interface DoExecutionRequest {
  slug: string;
  doId: string;
  runId: string;
  attempt: number;
  approvalId: string;
  /** The canonical action digest the approval bound; the executor must echo it on receipts. */
  digest: string;
  action: DoAction;
  presser: string;
  /** Stable per run; an executor must be idempotent on it. */
  idempotencyKey: string;
}

export type DoEnqueueResult =
  | { ok: true; executorRef: string }
  | { ok: false; code: string; error: string };

export interface DoExecutor {
  readonly name: string;
  /** Hand one run to the executor. Must not have side effects when it returns ok: false. */
  enqueue(request: DoExecutionRequest): Promise<DoEnqueueResult>;
}

/** Refuses everything. The only executor in this build. */
export class NullExecutor implements DoExecutor {
  readonly name = 'null';

  async enqueue(_request: DoExecutionRequest): Promise<DoEnqueueResult> {
    return { ok: false, code: 'EXECUTION_NOT_ENABLED', error: 'No executor is installed: {do} execution is not enabled yet' };
  }
}

const executor: DoExecutor = new NullExecutor();

/** The executor the run route hands an authorized run to. Always the NullExecutor in this build. */
export function getDoExecutor(): DoExecutor {
  return executor;
}
