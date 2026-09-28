import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { AI_KEY_PREFIX, createAiKeySchema, type AiConnection, type AiConnections, type CreatedAiKey } from '@paradocs/shared';
import { query } from '../db/pool.js';
import { UUID } from '../lib/access.js';
import { hashSecret, newSecret } from '../lib/aiTokens.js';
import { forbidden, notFound, parse } from '../lib/http.js';
import { getServerSettings } from '../lib/serverSettings.js';
import { workspaceMembership } from '../plugins/session.js';

/**
 * Someone's own AI connections, from Settings: the keys they have made and the
 * assistants they have signed in, each revocable on its own. Only a person in
 * their browser manages these; an assistant can never make itself more keys.
 */

export const CONNECTION_COLUMNS = `c.id, c.kind, c.name, c.hint, c.can_write AS "canWrite",
  c.created_at AS "createdAt", c.last_used_at AS "lastUsedAt",
  CASE WHEN w.id IS NULL THEN NULL ELSE json_build_object('id', w.id, 'name', w.name) END AS workspace`;

function assertPerson(req: FastifyRequest): void {
  if (req.ai) throw forbidden('An AI connection cannot manage AI connections');
}

/** Refuses a workspace the person is not in, as though it did not exist. */
export async function assertMemberOf(userId: string, workspaceId: string | null | undefined): Promise<void> {
  if (workspaceId && !(await workspaceMembership(userId, workspaceId))) throw notFound('Workspace not found');
}

async function fetchConnection(id: string): Promise<AiConnection> {
  const { rows } = await query<AiConnection>(
    `SELECT ${CONNECTION_COLUMNS} FROM ai_connections c LEFT JOIN workspaces w ON w.id = c.workspace_id WHERE c.id = $1`,
    [id],
  );
  if (!rows[0]) throw notFound('Connection not found');
  return rows[0];
}

export const aiConnectionRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.requireAuth);
  app.addHook('preHandler', async (req) => assertPerson(req));

  app.get('/ai-connections', async (req): Promise<AiConnections> => {
    const { rows } = await query<AiConnection>(
      `SELECT ${CONNECTION_COLUMNS}
         FROM ai_connections c LEFT JOIN workspaces w ON w.id = c.workspace_id
        WHERE c.user_id = $1
        ORDER BY c.created_at`,
      [req.user!.id],
    );
    return { enabled: (await getServerSettings()).aiConnections, connections: rows };
  });

  app.post('/ai-keys', async (req, reply): Promise<CreatedAiKey> => {
    if (!(await getServerSettings()).aiConnections) {
      throw forbidden('AI connections are turned off on this server. A server administrator can turn them on.');
    }
    const input = parse(createAiKeySchema, req.body ?? {});
    await assertMemberOf(req.user!.id, input.workspaceId);
    const key = newSecret(AI_KEY_PREFIX);
    const { rows } = await query<{ id: string }>(
      `INSERT INTO ai_connections (user_id, kind, name, workspace_id, can_write, token_hash, hint)
       VALUES ($1, 'key', $2, $3, $4, $5, $6) RETURNING id`,
      [req.user!.id, input.name, input.workspaceId ?? null, input.canWrite, hashSecret(key), key.slice(-4)],
    );
    reply.status(201);
    return { ...(await fetchConnection(rows[0].id)), key };
  });

  app.delete<{ Params: { id: string } }>('/ai-connections/:id', async (req, reply) => {
    if (!UUID.test(req.params.id)) throw notFound('Connection not found');
    const { rowCount } = await query('DELETE FROM ai_connections WHERE id = $1 AND user_id = $2', [
      req.params.id,
      req.user!.id,
    ]);
    if (!rowCount) throw notFound('Connection not found');
    reply.status(204);
  });
};
