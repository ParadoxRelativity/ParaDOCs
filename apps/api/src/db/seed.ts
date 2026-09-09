/**
 * Creates a demo account with sample content. Development convenience only —
 * refuses to touch a database that already has users.
 */
import { closeDb, query, transaction } from './pool.js';
import { hashPassword, slugify } from '../lib/auth.js';
import { blocksToMarkdown } from '../lib/blocksToMarkdown.js';

const EMAIL = process.env.SEED_EMAIL ?? 'demo@paradocs.local';
const PASSWORD = process.env.SEED_PASSWORD ?? 'paradocs-demo-1';

const text = (value: string) => [{ type: 'text', text: value, styles: {} }];

const sampleDocs = [
  {
    folder: 'Product',
    title: 'Backup strategy',
    tags: ['infrastructure', 'roadmap'],
    blocks: [
      { type: 'heading', props: { level: 2 }, content: text('Off-site backups') },
      {
        type: 'paragraph',
        content: text('Nightly restic snapshot of the Postgres cluster and the uploads directory to Backblaze B2.'),
      },
      { type: 'checkListItem', props: { checked: true }, content: text('Pick a bucket region') },
      { type: 'checkListItem', props: { checked: false }, content: text('Verify a restore onto the NAS') },
      { type: 'heading', props: { level: 2 }, content: text('Retention') },
      { type: 'bulletListItem', content: text('30 daily snapshots') },
      { type: 'bulletListItem', content: text('12 monthly snapshots') },
    ],
  },
  {
    folder: 'Notes',
    title: 'Why self-hosted',
    tags: ['roadmap'],
    blocks: [
      {
        type: 'paragraph',
        content: text('Owning the data means no vendor can change the terms underneath a team that depends on it.'),
      },
      { type: 'bulletListItem', content: text('Documents export to plain markdown at any time') },
      { type: 'bulletListItem', content: text('Backups are a Postgres dump plus an uploads directory') },
    ],
  },
];

async function main() {
  const { rows: existing } = await query<{ count: number }>('SELECT count(*)::int AS count FROM users');
  if (existing[0].count > 0) {
    console.log('Database already has users; leaving it alone.');
    return;
  }

  const passwordHash = await hashPassword(PASSWORD);

  await transaction(async (client) => {
    const { rows: users } = await client.query<{ id: string }>(
      'INSERT INTO users (email, password_hash, name) VALUES ($1, $2, $3) RETURNING id',
      [EMAIL, passwordHash, 'Demo User'],
    );
    const userId = users[0].id;

    const { rows: workspaces } = await client.query<{ id: string }>(
      'INSERT INTO workspaces (owner_id, name, slug, icon) VALUES ($1, $2, $3, $4) RETURNING id',
      [userId, 'Personal', slugify('Personal'), '🏠'],
    );
    const workspaceId = workspaces[0].id;

    const folderIds = new Map<string, string>();
    for (const [index, name] of ['Journal', 'Notes', 'Product'].entries()) {
      const { rows } = await client.query<{ id: string }>(
        'INSERT INTO folders (workspace_id, name, position) VALUES ($1, $2, $3) RETURNING id',
        [workspaceId, name, index],
      );
      folderIds.set(name, rows[0].id);
    }

    const tagIds = new Map<string, string>();
    for (const [index, name] of ['roadmap', 'infrastructure'].entries()) {
      const { rows } = await client.query<{ id: string }>(
        'INSERT INTO tags (workspace_id, name, color) VALUES ($1, $2, $3) RETURNING id',
        [workspaceId, name, ['#6366f1', '#0ea5e9'][index]],
      );
      tagIds.set(name, rows[0].id);
    }

    for (const doc of sampleDocs) {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO documents (workspace_id, folder_id, title, body, body_md, created_by)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6) RETURNING id`,
        [
          workspaceId,
          folderIds.get(doc.folder) ?? null,
          doc.title,
          JSON.stringify(doc.blocks),
          blocksToMarkdown(doc.blocks),
          userId,
        ],
      );
      for (const tag of doc.tags) {
        await client.query('INSERT INTO document_tags (document_id, tag_id) VALUES ($1, $2)', [
          rows[0].id,
          tagIds.get(tag),
        ]);
      }
    }

    const today = new Date().toISOString().slice(0, 10);
    await client.query(
      `INSERT INTO events (workspace_id, title, start_at, all_day)
       VALUES ($1, 'Backup dry run', ($2::date + time '10:00')::timestamptz, false)`,
      [workspaceId, today],
    );
  });

  console.log(`Seeded demo data.\n  email:    ${EMAIL}\n  password: ${PASSWORD}`);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
