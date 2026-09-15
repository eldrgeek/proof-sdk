import {
  createLibraryMember,
  createLibrarySigninLink,
  getLibraryMemberByEmail,
  listLibraryMembers,
  removeLibraryMember,
} from './auth.js';
import { getDb } from '../db.js';

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

  throw new Error(`Unknown command: ${command}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
