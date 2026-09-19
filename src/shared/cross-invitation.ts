/**
 * Cross invitation (Mike Wolf, 2026-09-19): "if a human is invited, they should be able to invite
 * their AI and the reverse. … when you invite an AI the identity test may be far more stringent
 * than when a human is invited. And an invited AI becomes an IDP for humans."
 *
 * Four moves, and the rule for each is a named constant here so a later ruling is one line:
 *   1. An invited person may add their own AI. Every agent key has a **sponsor**: the verified
 *      human who created it. The AI is shown as "<name> — added by <sponsor>" everywhere.
 *   2. Admission for an AI is stricter than for a person: a name, the sponsor's live session
 *      (never a share token), a declared runtime, a rate limit, and the existing revocation.
 *      An AI may not create another agent key (the depth cap).
 *   3. An AI may **nominate** a person: nothing is emailed and the person gets no access until a
 *      human owner confirms. An owner may grant one AI standing permission to invite directly.
 *   4. An AI may **attest** to a person's identity: presence, not authority. The attested email,
 *      once signed in with it, reads and comments like a guest. Their marks never count until a
 *      human-grade factor lands (an owner-confirmed invitation, or an invited address signing in).
 *
 * Authorship: brief by the COS from Mike Wolf's ruling of 2026-09-19; built by Claude Opus 5
 * (worker proof-crossinvite), 2026-09-19.
 */

export type NominationStatus = 'pending' | 'confirmed' | 'declined' | 'withdrawn';
export type AttestationConfidence = 'low' | 'medium' | 'high';

/** How a member of a document's team got in (the provenance chain, exported in /state). */
export type ProvenanceKind =
  | 'owner'        // created the document, or a Documents admin
  | 'invited'      // an owner invited this email
  | 'nominated'    // an AI nominated them and an owner confirmed
  | 'attested'     // an AI attested to them: read and comment only, marks do not count
  | 'sponsored'    // an AI, added by the human named as its sponsor
  | 'admin';       // the owner credential (scripts)

export interface Provenance {
  /** The actor this row is about ("human:eric@example.test", "ai:izzy"). */
  actor: string;
  kind: ProvenanceKind;
  /** Who admitted them (an actor, or null for the document's creator). */
  by: string | null;
  /** For a confirmed nomination: the human who confirmed what the AI proposed. */
  confirmedBy?: string | null;
  /** The AI's declared runtime (model / operator), free text, shown as given. */
  runtime?: string | null;
  /** What the AI said (a nomination's "why", an attestation's "basis"). */
  basis?: string | null;
  confidence?: AttestationConfidence | null;
  at: string;
  /** False while the row grants nothing that counts (an attestation). */
  counts: boolean;
  /** One line a person can read: "Izzy — added by Eric". */
  label: string;
}

export const CROSS_INVITE_POLICY = {
  // ---- 1. An invited person may add their own AI -------------------------------------------
  /** A person invited to this document (not only an Owner) may create an agent key on it. */
  invitedPeopleMayAddAgents: true,
  /** Every agent key is bound to the verified human who created it. */
  sponsorRequired: true,
  /**
   * Guest settings in which a key needs no sponsor. On an "edit" document anyone with the link is
   * an editor, so there is no identity to bind — the same reasoning as guest marks counting there.
   * A bare SDK server (no sign-in at all) also lands here through its "edit" default.
   */
  sponsorNotRequiredInGuestModes: ['edit'] as readonly string[],
  /** Keys that existed before this step are read as sponsored by the document's owner. */
  legacySponsorIsDocumentOwner: true,
  /** An AI whose sponsor loses access to the document is suspended with them. */
  suspendAgentsWithSponsor: true,

  // ---- 2. Stricter admission for an AI -------------------------------------------------------
  /** The sponsor types or picks what is running the AI (model / operator). Free text, displayed. */
  runtimeRequired: true,
  maxRuntimeLength: 120,
  /** Suggestions in the dialog; any other text is accepted. */
  runtimeSuggestions: ['Claude Opus 5 (Anthropic)', 'ChatGPT (OpenAI)', 'Gemini (Google)', 'Grok (xAI)', 'A local model'] as readonly string[],
  /** The depth cap: only humans admit AIs. An agent key creating a key is 403 AI_CANNOT_ADMIT_AI. */
  aiMayAdmitAi: false,
  /** Agent keys one sponsor may create on one document per hour. */
  keysPerSponsorPerHour: 6,
  /** Agent keys one document may gain per hour, whoever sponsors them. */
  keysPerDocumentPerHour: 20,

  // ---- 3. An AI may nominate a person ---------------------------------------------------------
  /** A nomination emails nobody and grants nothing until a human owner confirms it. */
  nominationSendsNothing: true,
  /** An open nomination is an Issue of type "nomination" for the document's human owners. */
  nominationIsIssue: true,
  nominationsPerAiPerHour: 6,
  nominationsPerDocumentPerHour: 20,
  /** The AI says why in its own words; the confirming human reads it. */
  whyRequired: true,
  maxWhyLength: 600,
  /** Standing permission for one AI to invite directly on one document. Off unless an Owner says so. */
  allowDirectInviteDefault: false,

  // ---- 4. An AI may attest to a person's identity ---------------------------------------------
  /** What an attestation grants once that email signs in: the same as a guest, and no more. */
  attestedRole: 'commenter' as const,
  /** An attestation never gives countable marks, editing, Approve or key creation. */
  attestedMarksCount: false,
  /** The AI's sponsor must still be a member of the document for its attestations to grant anything. */
  attestationNeedsLiveSponsor: true,
  basisRequired: true,
  maxBasisLength: 600,
  confidences: ['low', 'medium', 'high'] as readonly AttestationConfidence[],
  attestationsPerAiPerHour: 6,
  attestationsPerDocumentPerHour: 20,

  // ---- Wording ---------------------------------------------------------------------------------
  labels: {
    sponsored: (ai: string, sponsor: string) => `${ai} — added by ${sponsor}`,
    nominated: (who: string, ai: string, confirmer: string) => `${who} — nominated by ${ai}, confirmed by ${confirmer}`,
    attested: (who: string, ai: string) => `${who} — attested by ${ai} (read and comment only)`,
    invited: (who: string, by: string) => `${who} — invited by ${by}`,
    owner: (who: string) => `${who} — created this document`,
    admin: (who: string) => `${who} — added by the owner credential`,
  },
  /** What an attested person is told when they try to mark. */
  notVerifiedMessage: 'An AI vouched for you, so you can read and comment. Marks, answers, picks and approvals need a person to invite you.',
} as const;

export function isAttestationConfidence(value: unknown): value is AttestationConfidence {
  return typeof value === 'string' && (CROSS_INVITE_POLICY.confidences as readonly string[]).includes(value);
}

/** The one line shown next to a row wherever provenance is displayed. */
export function provenanceLabel(input: {
  kind: ProvenanceKind;
  name: string;
  byName?: string | null;
  confirmedByName?: string | null;
}): string {
  const L = CROSS_INVITE_POLICY.labels;
  const by = input.byName ?? 'someone';
  switch (input.kind) {
    case 'sponsored': return L.sponsored(input.name, by);
    case 'nominated': return L.nominated(input.name, by, input.confirmedByName ?? 'an owner');
    case 'attested': return L.attested(input.name, by);
    case 'invited': return L.invited(input.name, by);
    case 'owner': return L.owner(input.name);
    case 'admin': return L.admin(input.name);
    default: return input.name;
  }
}
