import type { FastifyPluginAsync } from 'fastify';
import {
  createTeamSchema,
  updateAccessSchema,
  updateMemberTeamsSchema,
  updateTeamSchema,
  type AccessEntry,
  type AccessMode,
  type AccessSettings,
  type Team,
} from '@paradocs/shared';
import { query, transaction, type DbClient } from '../db/pool.js';
import { badRequest, conflict, notFound, parse } from '../lib/http.js';
import { UUID, levelOf, permissionOf } from '../lib/access.js';
import { accessChanged } from '../lib/accessEvents.js';
import { uploadUrlSql } from '../lib/storage.js';
import { assertWorkspaceAccess } from '../plugins/session.js';

/**
 * Teams, and the locks on folders, documents and channels.
 *
 * Anyone in a workspace can see its teams, since they are how access is
 * described. Changing a team or a lock is for owners and admins, who no lock
 * keeps out — so whatever they set up, they can always see and undo.
 */

/** The three kinds of thing that can be locked, and where each keeps its setting. */
const TARGETS = {
  folders: { table: 'folders', column: 'folder_id', parent: 'parent_id', label: 'Folder' },
  documents: { table: 'documents', column: 'document_id', parent: 'folder_id', label: 'Document' },
  // A channel has no folder, so nothing for it to inherit from.
  channels: { table: 'channels', column: 'channel_id', parent: null, label: 'Channel' },
} as const;

type TargetKind = keyof typeof TARGETS;

interface Target {
  id: string;
  workspaceId: string;
  access: AccessMode;
  /** The folder this sits in, whose setting it takes when it inherits. */
  parentFolderId: string | null;
}

const TEAM_COLUMNS = `t.id, t.workspace_id AS "workspaceId", t.name, t.created_at AS "createdAt",
  COALESCE((SELECT json_agg(tm.user_id ORDER BY tm.created_at)
              FROM team_members tm WHERE tm.team_id = t.id), '[]'::json) AS "memberIds"`;

async function fetchTeam(id: string): Promise<Team> {
  const { rows } = await query<Team>(`SELECT ${TEAM_COLUMNS} FROM teams t WHERE t.id = $1`, [id]);
  if (!rows[0]) throw notFound('Team not found');
  return rows[0];
}

async function teamWorkspace(teamId: string): Promise<string> {
  if (!UUID.test(teamId)) throw notFound('Team not found');
  const { rows } = await query<{ workspace_id: string }>('SELECT workspace_id FROM teams WHERE id = $1', [teamId]);
  if (!rows[0]) throw notFound('Team not found');
  return rows[0].workspace_id;
}

async function assertTeamNameFree(workspaceId: string, name: string, exceptId?: string): Promise<void> {
  const { rows } = await query(
    'SELECT 1 FROM teams WHERE workspace_id = $1 AND lower(name) = lower($2) AND id IS DISTINCT FROM $3',
    [workspaceId, name, exceptId ?? null],
  );
  if (rows.length) throw conflict(`There is already a team called ${name}`);
}

/** Only members of the workspace can be on its teams or its lists. */
async function assertMembers(workspaceId: string, userIds: string[]): Promise<void> {
  const unique = [...new Set(userIds)];
  if (unique.length === 0) return;
  const { rows } = await query<{ count: number }>(
    'SELECT count(*)::int AS count FROM workspace_members WHERE workspace_id = $1 AND user_id = ANY($2::uuid[])',
    [workspaceId, unique],
  );
  if (rows[0].count !== unique.length) throw badRequest('Everyone listed must be a member of this workspace');
}

async function assertTeams(workspaceId: string, teamIds: string[]): Promise<void> {
  const unique = [...new Set(teamIds)];
  if (unique.length === 0) return;
  const { rows } = await query<{ count: number }>(
    'SELECT count(*)::int AS count FROM teams WHERE workspace_id = $1 AND id = ANY($2::uuid[])',
    [workspaceId, unique],
  );
  if (rows[0].count !== unique.length) throw badRequest('Every team listed must belong to this workspace');
}

async function replaceTeamMembers(client: DbClient, teamId: string, userIds: string[]): Promise<void> {
  await client.query('DELETE FROM team_members WHERE team_id = $1', [teamId]);
  const unique = [...new Set(userIds)];
  if (unique.length === 0) return;
  await client.query('INSERT INTO team_members (team_id, user_id) SELECT $1, unnest($2::uuid[])', [teamId, unique]);
}

async function resolveTarget(kind: TargetKind, id: string): Promise<Target> {
  const { table, parent, label } = TARGETS[kind];
  if (!UUID.test(id)) throw notFound(`${label} not found`);
  // A direct conversation is only ever its two people; there is nothing to lock.
  const { rows } = await query<{ workspace_id: string; access: AccessMode; parent: string | null }>(
    `SELECT workspace_id, access, ${parent ?? 'NULL::uuid'} AS parent
       FROM ${table}
      WHERE id = $1${kind === 'channels' ? ` AND kind <> 'direct'` : ''}`,
    [id],
  );
  if (!rows[0]) throw notFound(`${label} not found`);
  return { id, workspaceId: rows[0].workspace_id, access: rows[0].access, parentFolderId: rows[0].parent };
}

async function readSettings(target: Target): Promise<AccessSettings> {
  const { rows } = await query<{
    level: number;
    team_id: string | null;
    team_name: string | null;
    user_id: string | null;
    user_name: string | null;
    avatar_url: string | null;
  }>(
    `SELECT e.level, t.id AS team_id, t.name AS team_name, u.id AS user_id, u.name AS user_name,
            ${uploadUrlSql('u.avatar_key')} AS avatar_url
       FROM access_entries e
       LEFT JOIN teams t ON t.id = e.team_id
       LEFT JOIN users u ON u.id = e.user_id
      WHERE e.target = $1
      ORDER BY e.team_id IS NULL, lower(COALESCE(t.name, u.name))`,
    [target.id],
  );

  let inheritedFrom: AccessSettings['inheritedFrom'] = null;
  if (target.access === 'inherit' && target.parentFolderId) {
    const { rows: governor } = await query<{ id: string; name: string; access: AccessMode }>(
      'SELECT id, name, access FROM folders WHERE id = access_folder_governor($1::uuid)',
      [target.parentFolderId],
    );
    inheritedFrom = governor[0] ?? null;
  }

  return {
    access: target.access,
    entries: rows.map(
      (row): AccessEntry => ({
        subject: row.team_id
          ? { kind: 'team', id: row.team_id, name: row.team_name ?? '' }
          : { kind: 'user', id: row.user_id!, name: row.user_name ?? '', avatarUrl: row.avatar_url },
        permission: permissionOf(row.level),
      }),
    ),
    inheritedFrom,
  };
}

export const accessRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.requireAuth);

  // --- teams -----------------------------------------------------------------

  app.get<{ Params: { id: string } }>('/workspaces/:id/teams', async (req) => {
    await assertWorkspaceAccess(req, req.params.id);
    const { rows } = await query<Team>(
      `SELECT ${TEAM_COLUMNS} FROM teams t WHERE t.workspace_id = $1 ORDER BY lower(t.name)`,
      [req.params.id],
    );
    return rows;
  });

  app.post<{ Params: { id: string } }>('/workspaces/:id/teams', async (req, reply) => {
    await assertWorkspaceAccess(req, req.params.id, 'admin');
    const input = parse(createTeamSchema, req.body);
    const memberIds = input.memberIds ?? [];
    await assertTeamNameFree(req.params.id, input.name);
    await assertMembers(req.params.id, memberIds);

    const id = await transaction(async (client) => {
      const { rows } = await client.query<{ id: string }>(
        'INSERT INTO teams (workspace_id, name) VALUES ($1, $2) RETURNING id',
        [req.params.id, input.name],
      );
      await replaceTeamMembers(client, rows[0].id, memberIds);
      return rows[0].id;
    });
    reply.status(201);
    return fetchTeam(id);
  });

  app.patch<{ Params: { id: string } }>('/teams/:id', async (req) => {
    const workspaceId = await teamWorkspace(req.params.id);
    await assertWorkspaceAccess(req, workspaceId, 'admin');
    const input = parse(updateTeamSchema, req.body);
    if (input.name) await assertTeamNameFree(workspaceId, input.name, req.params.id);
    if (input.memberIds) await assertMembers(workspaceId, input.memberIds);

    await transaction(async (client) => {
      if (input.name) await client.query('UPDATE teams SET name = $2 WHERE id = $1', [req.params.id, input.name]);
      if (input.memberIds) await replaceTeamMembers(client, req.params.id, input.memberIds);
    });
    // Who is on a team is who every list naming it lets in, or keeps out.
    if (input.memberIds) accessChanged(workspaceId);
    return fetchTeam(req.params.id);
  });

  app.delete<{ Params: { id: string } }>('/teams/:id', async (req, reply) => {
    const workspaceId = await teamWorkspace(req.params.id);
    await assertWorkspaceAccess(req, workspaceId, 'admin');
    // Its lines on every list go with it: on an allow list that takes access
    // away from its members, and on a deny list it gives it back.
    await query('DELETE FROM teams WHERE id = $1', [req.params.id]);
    accessChanged(workspaceId);
    reply.status(204);
  });

  // Every team one person is on, set from their line in the member list rather
  // than from each team in turn. Teams left as they were keep their place.
  app.put<{ Params: { id: string; userId: string } }>('/workspaces/:id/members/:userId/teams', async (req) => {
    const workspaceId = req.params.id;
    await assertWorkspaceAccess(req, workspaceId, 'admin');
    const teamIds = [...new Set(parse(updateMemberTeamsSchema, req.body).teamIds)];
    const { userId } = req.params;
    if (!UUID.test(userId)) throw notFound('That person is not a member of this workspace');
    const { rows } = await query('SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND user_id = $2', [
      workspaceId,
      userId,
    ]);
    if (!rows.length) throw notFound('That person is not a member of this workspace');
    await assertTeams(workspaceId, teamIds);

    await transaction(async (client) => {
      await client.query(
        `DELETE FROM team_members tm USING teams t
          WHERE t.id = tm.team_id AND t.workspace_id = $1 AND tm.user_id = $2
            AND NOT (tm.team_id = ANY($3::uuid[]))`,
        [workspaceId, userId, teamIds],
      );
      await client.query(
        `INSERT INTO team_members (team_id, user_id)
         SELECT picked.team_id, $2 FROM unnest($1::uuid[]) AS picked(team_id)
          WHERE NOT EXISTS (SELECT 1 FROM team_members tm WHERE tm.team_id = picked.team_id AND tm.user_id = $2)`,
        [teamIds, userId],
      );
    });
    // Who is on a team is who every list naming it lets in, or keeps out.
    accessChanged(workspaceId);
    return { userId, teamIds };
  });

  // --- locks -------------------------------------------------------------------

  for (const kind of Object.keys(TARGETS) as TargetKind[]) {
    app.get<{ Params: { id: string } }>(`/${kind}/:id/access`, async (req) => {
      const target = await resolveTarget(kind, req.params.id);
      await assertWorkspaceAccess(req, target.workspaceId, 'admin');
      return readSettings(target);
    });

    app.put<{ Params: { id: string } }>(`/${kind}/:id/access`, async (req) => {
      const target = await resolveTarget(kind, req.params.id);
      await assertWorkspaceAccess(req, target.workspaceId, 'admin');
      const input = parse(updateAccessSchema, req.body);
      const { table, column, parent } = TARGETS[kind];
      if (!parent && input.access === 'inherit') throw badRequest('A channel has no folder to inherit from');

      const listed = input.access === 'allow' || input.access === 'deny' ? (input.entries ?? []) : [];
      await assertTeams(target.workspaceId, listed.flatMap((e) => (e.teamId ? [e.teamId] : [])));
      await assertMembers(target.workspaceId, listed.flatMap((e) => (e.userId ? [e.userId] : [])));

      await transaction(async (client) => {
        await client.query(`UPDATE ${table} SET access = $2 WHERE id = $1`, [target.id, input.access]);
        await client.query(`DELETE FROM access_entries WHERE ${column} = $1`, [target.id]);
        if (listed.length === 0) return;
        await client.query(
          `INSERT INTO access_entries (${column}, team_id, user_id, level)
           SELECT $1, x.team_id, x.user_id, x.level
             FROM unnest($2::uuid[], $3::uuid[], $4::smallint[]) AS x(team_id, user_id, level)`,
          [
            target.id,
            listed.map((e) => e.teamId ?? null),
            listed.map((e) => e.userId ?? null),
            listed.map((e) => levelOf(e.permission)),
          ],
        );
      });

      accessChanged(target.workspaceId);
      return readSettings({ ...target, access: input.access });
    });
  }
};
