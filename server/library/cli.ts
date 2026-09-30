import {
  createLibraryMember,
  createLibrarySigninLink,
  isSomaAuthEnabled,
  getLibraryMemberByEmail,
  listLibraryMembers,
  removeLibraryMember,
} from './auth.js';
import { getDb } from '../db.js';
import { listDocumentActors, listMerges, mergeIdentity, unmergeIdentity } from '../identity.js';

function readOption(args: string[], name: string): string | null {
  const index = args.indexOf(name);
  return index >= 0 && typeof args[index + 1] === 'string' ? args[index + 1] : null;
}

function requireOption(args: string[], name: string): string {
  const value = readOption(args, name)?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function setArchived(slug: string, archived: boolean): boolean {
  const now = new Date().toISOString();
  const result = getDb().prepare(`
    INSERT INTO library_document_meta (slug, created_by_member_id, archived_at, archived_by)
    SELECT slug, NULL, ?, 'operator' FROM documents WHERE slug = ?
    ON CONFLICT(slug) DO UPDATE SET
      archived_at = excluded.archived_at,
      archived_by = excluded.archived_by
  `).run(archived ? now : null, slug);
  return result.changes > 0;
}

async function main(): Promise<void> {
  const [, , command, ...args] = process.argv;
  if (!command) throw new Error('A library command is required');

  if (command === 'add-member') {
    const member = createLibraryMember({
      name: requireOption(args, '--name'),
      email: requireOption(args, '--email'),
      isOwner: args.includes('--owner'),
    });
    console.log(`${member.name}\t${member.email}\t${member.isOwner ? 'owner' : 'member'}`);
    return;
  }

  if (command === 'list-members') {
    for (const member of listLibraryMembers()) {
      console.log([
        member.name,
        member.email ?? '',
        member.isOwner ? 'owner' : 'member',
        member.removedAt ? 'removed' : 'active',
      ].join('\t'));
    }
    return;
  }

  if (command === 'remove-member') {
    const email = requireOption(args, '--email');
    const member = getLibraryMemberByEmail(email);
    if (!member || !removeLibraryMember(member.id)) throw new Error('Member not found');
    console.log(`Removed ${member.name}`);
    return;
  }

  if (command === 'signin-link') {
    if (isSomaAuthEnabled()) throw new Error('Sign in with SOMA Auth; signin-link is disabled.');
    const email = requireOption(args, '--email');
    const member = getLibraryMemberByEmail(email);
    if (!member || member.removedAt) throw new Error('Member not found');
    const origin = readOption(args, '--origin')?.trim() || process.env.PROOF_PUBLIC_ORIGIN?.trim();
    if (!origin) throw new Error('Pass --origin or set PROOF_PUBLIC_ORIGIN');
    const rawHours = readOption(args, '--hours');
    const hours = rawHours ? Number.parseInt(rawHours, 10) : 24;
    if (!Number.isFinite(hours) || hours < 1) throw new Error('--hours must be a positive integer');
    const { link } = createLibrarySigninLink({
      memberId: member.id,
      purpose: 'operator',
      createdBy: 'operator',
      origin,
      hours,
    });
    console.log(link);
    return;
  }

  if (command === 'archive') {
    const slug = readOption(args, '--slug')?.trim();
    const titlePrefix = readOption(args, '--title-prefix')?.trim();
    if (slug) {
      if (!setArchived(slug, true)) throw new Error('Document not found');
      console.log('Archived 1 document');
      return;
    }
    if (!titlePrefix) throw new Error('Pass --slug or --title-prefix');
    const rows = getDb().prepare(`
      SELECT slug FROM documents WHERE title LIKE ? ESCAPE '\\'
    `).all(`${titlePrefix.replace(/[\\%_]/g, '\\$&')}%`) as Array<{ slug: string }>;
    let count = 0;
    for (const row of rows) {
      if (setArchived(row.slug, true)) count += 1;
    }
    console.log(`Archived ${count} document${count === 1 ? '' : 's'}`);
    return;
  }

  if (command === 'unarchive') {
    const slug = requireOption(args, '--slug');
    if (!setArchived(slug, false)) throw new Error('Document not found');
    console.log('Unarchived 1 document');
    return;
  }

  // Proof Documents Step B6: identity merges. The COS runs these only on an explicit request,
  // e.g. merge-identity --from "Mike" --into human:mw@mike-wolf.com --slug abc123 (or --all-documents).
  // A merge covers what the typed name wrote up to now; stored rows are not rewritten.
  if (command === 'merge-identity') {
    const from = requireOption(args, '--from');
    const into = requireOption(args, '--into');
    const slug = readOption(args, '--slug')?.trim();
    const all = args.includes('--all-documents');
    if (Boolean(slug) === all) throw new Error('Pass exactly one of --slug <slug> or --all-documents');
    if (slug && !getDb().prepare('SELECT 1 FROM documents WHERE slug = ?').get(slug)) throw new Error('Document not found');
    const merged = mergeIdentity({ from, into, scope: slug || '*', createdBy: readOption(args, '--by') || 'operator', note: readOption(args, '--note') });
    console.log(`Merged ${merged.fromKey} into ${merged.intoActor} (${merged.scope === '*' ? 'all documents' : merged.scope})`);
    return;
  }

  if (command === 'unmerge-identity') {
    const from = requireOption(args, '--from');
    const slug = readOption(args, '--slug')?.trim();
    const all = args.includes('--all-documents');
    if (Boolean(slug) === all) throw new Error('Pass exactly one of --slug <slug> or --all-documents');
    if (!unmergeIdentity({ from, scope: slug || '*' })) throw new Error('No such merge');
    console.log('Removed 1 merge');
    return;
  }

  if (command === 'list-merges') {
    for (const merge of listMerges(readOption(args, '--slug')?.trim() || null)) {
      console.log([merge.scope, merge.fromKey, merge.intoActor, merge.createdAt, merge.createdBy ?? ''].join('\t'));
    }
    return;
  }

  if (command === 'actors') {
    const slug = requireOption(args, '--slug');
    for (const row of listDocumentActors(slug)) {
      console.log([row.actor, row.canonical, `marks=${row.lineMarks}`, `asks=${row.asks}`, `answers=${row.answers}`].join('\t'));
    }
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
