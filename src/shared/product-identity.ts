/**
 * Product identity — the one place the product's user-facing names live.
 *
 * Mike ruled on 2026-09-19: "Accord it is, use it everywhere." The standard, the editor and each
 * document are Accord; a document is "an Accord"; a team is an Accord Team. The upstream
 * open-source project keeps its own name, **Proof SDK**, so sentences that need the engine's name
 * say "built on the open-source Proof SDK" (see TRADEMARKS.md).
 *
 * Every user-facing product string comes from here, so a later rename is a config change rather
 * than another sweep. Nothing machine-visible reads from this module: API paths, headers, field
 * names, event types, error codes, table names, slugs, tokens, routes, CSS classes and test
 * selectors are untouched by design.
 *
 * Overrides, highest precedence first:
 *   1. `globalThis.__PRODUCT_IDENTITY__` — a partial object; the browser bundle reads this.
 *   2. Environment variables `PRODUCT_NAME`, `PRODUCT_SHORT_NAME`, `PRODUCT_DOCUMENT_NOUN`,
 *      `PRODUCT_DOCUMENT_NOUN_PLURAL`, `PRODUCT_TEAM_NOUN`, `PRODUCT_TAGLINE`,
 *      `PRODUCT_EMAIL_FROM_NAME`, `PRODUCT_EMAIL_FROM_ADDRESS`, `PRODUCT_ENGINE_NAME`,
 *      `PRODUCT_HOME_URL` — the server reads these.
 *   3. The defaults below.
 *
 * Authorship: Claude Opus 5 (worker proof-rename), 2026-09-19, for Mike Wolf.
 */

export interface ProductIdentity {
  /** The product name, as a wordmark and in prose. */
  name: string;
  /** A shorter form for tight chrome. Same as `name` unless a deployment needs it shorter. */
  shortName: string;
  /** What one document is called: "an Accord". */
  documentNoun: string;
  /** Plural of `documentNoun`. */
  documentNounPlural: string;
  /** The indefinite article for `documentNoun` ("an" for Accord, "a" for most names). */
  documentNounArticle: string;
  /** What a document's group of people is called. */
  teamNoun: string;
  /** One line under the name, used on the home page and share cards. */
  tagline: string;
  /** The from-name on invitation email. */
  emailFromName: string;
  /** The from-address on invitation email. */
  emailFromAddress: string;
  /** The open-source engine this is built on. Not the product name; see TRADEMARKS.md. */
  engineName: string;
  /** Where the wordmark links. */
  homeUrl: string;
}

export const DEFAULT_PRODUCT_IDENTITY: ProductIdentity = {
  name: 'Accord',
  shortName: 'Accord',
  documentNoun: 'Accord',
  documentNounPlural: 'Accords',
  documentNounArticle: 'an',
  teamNoun: 'Accord Team',
  tagline: 'A collaborative editor for humans and AI',
  emailFromName: 'Accord',
  emailFromAddress: 'proof@mike-wolf.com',
  engineName: 'Proof SDK',
  homeUrl: 'https://vps.mike-wolf.com/',
};

/** Environment variable for each field. Server-side configuration. */
const ENV_KEYS: Record<keyof ProductIdentity, string> = {
  name: 'PRODUCT_NAME',
  shortName: 'PRODUCT_SHORT_NAME',
  documentNoun: 'PRODUCT_DOCUMENT_NOUN',
  documentNounPlural: 'PRODUCT_DOCUMENT_NOUN_PLURAL',
  documentNounArticle: 'PRODUCT_DOCUMENT_NOUN_ARTICLE',
  teamNoun: 'PRODUCT_TEAM_NOUN',
  tagline: 'PRODUCT_TAGLINE',
  emailFromName: 'PRODUCT_EMAIL_FROM_NAME',
  emailFromAddress: 'PRODUCT_EMAIL_FROM_ADDRESS',
  engineName: 'PRODUCT_ENGINE_NAME',
  homeUrl: 'PRODUCT_HOME_URL',
};

/** The global the browser bundle (and a test) can set before the editor boots. */
export const PRODUCT_IDENTITY_GLOBAL = '__PRODUCT_IDENTITY__';

function envOverrides(): Partial<ProductIdentity> {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  if (!env) return {};
  const out: Partial<ProductIdentity> = {};
  for (const [field, key] of Object.entries(ENV_KEYS) as [keyof ProductIdentity, string][]) {
    const value = env[key]?.trim();
    if (value) out[field] = value;
  }
  return out;
}

function globalOverrides(): Partial<ProductIdentity> {
  const raw = (globalThis as Record<string, unknown>)[PRODUCT_IDENTITY_GLOBAL];
  if (!raw || typeof raw !== 'object') return {};
  const out: Partial<ProductIdentity> = {};
  for (const field of Object.keys(ENV_KEYS) as (keyof ProductIdentity)[]) {
    const value = (raw as Record<string, unknown>)[field];
    if (typeof value === 'string' && value.trim()) out[field] = value.trim();
  }
  return out;
}

/** The resolved identity. Read it fresh so a test or a host can override before first use. */
export function productIdentity(): ProductIdentity {
  return { ...DEFAULT_PRODUCT_IDENTITY, ...envOverrides(), ...globalOverrides() };
}

/** The product name. The wordmark, page titles and most prose use this. */
export function productName(): string {
  return productIdentity().name;
}

/** "an Accord" / "a Ledger" — the document noun with its article. */
export function aDocument(): string {
  const id = productIdentity();
  return `${id.documentNounArticle} ${id.documentNoun}`;
}

/** The document noun, capitalised as configured: "Accord". */
export function documentNoun(): string {
  return productIdentity().documentNoun;
}

/** The document noun, plural: "Accords". */
export function documentNounPlural(): string {
  return productIdentity().documentNounPlural;
}

/** The phrase every sentence that must name the engine uses. */
export function builtOnEngine(): string {
  return `built on the open-source ${productIdentity().engineName}`;
}

/** `<title>` text: "Some doc · Accord", or just "Accord" with no leading part. */
export function pageTitle(leading?: string | null, separator = ' · '): string {
  const name = productName();
  const head = leading?.trim();
  return head ? `${head}${separator}${name}` : name;
}
