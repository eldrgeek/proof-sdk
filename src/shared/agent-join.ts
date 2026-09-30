/**
 * Mike Wolf, 2026-09-25: an AI joins an Accord from its URL. It requests access;
 * a person admits it by code. Cross-invitation's human sponsor and depth cap stand.
 * Source: docs/accord/ai-join-brief-2026-09-25.md (ac-220).
 */
export const AGENT_JOIN_POLICY = {
  autoAdmit: false,
  expiresInMs: 15 * 60 * 1000,
  maxOpenPerDocument: 5,
  rateWindowMs: 60_000,
  requestsPerDocument: 10,
  requestsPerAddress: 30,
  maxNameLength: 80,
  secretBytes: 32,
  codeWords: ['KITE', 'MOON', 'PINE', 'LAKE', 'BIRD', 'STAR', 'LEAF', 'WAVE'],
  codeMin: 1000,
  codeMax: 10000,
  streamHeartbeatMs: 15_000,
} as const;

export interface AgentJoinRequest {
  requestId: string;
  name: string;
  runtime: string;
  code: string;
  expiresAt: string;
}

export function validAgentJoinName(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
    && value.trim().length <= AGENT_JOIN_POLICY.maxNameLength && !/[\x00-\x1f\x7f]/.test(value);
}

export function agentJoinPath(slug: string): string {
  return `/api/agent/${encodeURIComponent(slug)}/join`;
}

export function agentJoinInstructions(slug: string): string {
  return `To join, POST ${agentJoinPath(slug)} with JSON {"name":"Your name","runtime":"Your model or operator"}. Keep the returned pollToken private. Tell the person: "I asked to join. Admit code <code> in the Accord." Poll the returned pollUrl with x-join-token: <pollToken>. A person must click Admit. Requests expire after 15 minutes. An admitted poll returns the agent token once; use it as x-share-token on the agent API. Never put either token in a URL.`;
}
