import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

// AGENTS.md is what Codex and Cursor are given; CLAUDE.md is what Claude is given. The estate
// rule is that the two carry the same guidance. Byte identity is the only "same" a machine can
// check, so in this repo that is the rule. Added 2026-09-23 with the first AGENTS.md.
const root = process.cwd();
const agents = readFileSync(resolve(root, 'AGENTS.md'), 'utf8');
const claude = readFileSync(resolve(root, 'CLAUDE.md'), 'utf8');
assert.equal(agents, claude, 'AGENTS.md and CLAUDE.md differ; change both in one commit');
console.log('AGENTS.md and CLAUDE.md are identical');
