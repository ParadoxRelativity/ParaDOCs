import crypto from 'node:crypto';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import {
  createIntakeTokenSchema,
  updateIntakeTokenSchema,
  WORK_ITEM_PRIORITIES,
  type CreatedIntakeToken,
  type IntakeSettings,
  type IntakeToken,
  type WorkItemPriority,
} from '@paradocs/shared';
import { query, transaction } from '../db/pool.js';
import { assertProjectAccess, UUID } from '../lib/access.js';
import { appEnabled } from '../lib/apps.js';
import { HttpError, badRequest, forbidden, notFound, parse, unauthorized } from '../lib/http.js';
import { intakeLimits } from '../lib/rateLimit.js';
import { getServerSettings } from '../lib/serverSettings.js';
import { projectChanged } from '../lib/workItems.js';
import { endOfStatus, insertRoleHolders, logActivity } from './projects.js';

/**
 * The intake webhook: work sent in from outside, filed in a queue.
 *
 * There is one address for the whole server, `POST /api/intake`. What is sent
 * there carries a token, and the token is what says which queue it goes to and
 * what type it is filed as, so a queue can have one per form or sender and
 * revoke each alone. Tokens are made in the queue's settings by whoever may
 * configure it; the webhook itself is off until a server administrator turns on
 * `intakeWebhooks`.
 *
 * A sender may be a server with the token in an `Authorization: Bearer` header,
 * or a plain HTML form on another site, which cannot set headers and so sends
 * it as a `token` field. JSON and form-encoded bodies are both taken, and any
 * field the webhook does not understand is kept, listed under the description,
 * so a form's other questions are not lost.
 */

const TOKEN_PREFIX = 'pdi_';

const TOKEN_COLUMNS = `t.id, t.name, t.hint, t.type_id AS "typeId", t.created_by AS "createdBy",
  t.created_at AS "createdAt", t.last_used_at AS "lastUsedAt", t.use_count AS "useCount"`;

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/** Where tokens can be made: a queue, not a project. */
async function assertQueue(projectId: string): Promise<void> {
  const { rows } = await query<{ kind: string }>('SELECT kind FROM projects WHERE id = $1', [projectId]);
  if (rows[0]?.kind !== 'queue') throw badRequest('Only a queue takes in work from outside');
}

async function assertTypeOf(projectId: string, typeId: string | null | undefined): Promise<void> {
  if (!typeId) return;
  const { rows } = await query<{ name: string; epic: boolean }>(
    'SELECT name, epic FROM project_item_types WHERE id = $1 AND project_id = $2',
    [typeId, projectId],
  );
  if (!rows[0]) throw badRequest('That type is not in this queue');
  if (rows[0].epic) throw badRequest(`Work cannot come in as ${rows[0].name}: it holds other work, as epics do`);
}

async function tokenProject(tokenId: string): Promise<string> {
  if (!UUID.test(tokenId)) throw notFound('Token not found');
  const { rows } = await query<{ project_id: string }>('SELECT project_id FROM intake_tokens WHERE id = $1', [tokenId]);
  if (!rows[0]) throw notFound('Token not found');
  return rows[0].project_id;
}

async function fetchToken(tokenId: string): Promise<IntakeToken> {
  const { rows } = await query<IntakeToken>(`SELECT ${TOKEN_COLUMNS} FROM intake_tokens t WHERE t.id = $1`, [tokenId]);
  if (!rows[0]) throw notFound('Token not found');
  return rows[0];
}

// --- reading what was sent ---------------------------------------------------

type Fields = Record<string, unknown>;

/** The first of `names` given a value, taken out of `fields` so it is not listed again. */
function take(fields: Fields, ...names: string[]): string | undefined {
  let found: string | undefined;
  for (const name of names) {
    const key = Object.keys(fields).find((k) => k.toLowerCase() === name.toLowerCase());
    if (key === undefined) continue;
    const text = asText(fields[key]);
    delete fields[key];
    if (found === undefined && text) found = text;
  }
  return found;
}

function asText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.map(asText).filter(Boolean).join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value).trim();
}

/**
 * Text from outside, made safe to keep as a description. Descriptions are
 * written the way chat messages are, so `<@…>` or `<doc:…>` in what a stranger
 * sends would otherwise turn into a mention or a link; a space after the `<`
 * leaves it as the text it was.
 */
function inert(text: string): string {
  return text.replace(/<(?=(?:doc:|sheet:|item:|proj:|#|@|!here))/gi, '< ');
}

/** "favourite_colour" → "Favourite colour", for a form field listed under the description. */
function label(key: string): string {
  const words = key.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim();
  return words ? words[0].toUpperCase() + words.slice(1) : key;
}

const MAX_TITLE = 300;
const MAX_DESCRIPTION = 20_000;
const MAX_EXTRA_FIELDS = 50;

interface Submission {
  title: string;
  description: string;
  priority: WorkItemPriority;
  requester: string | undefined;
  type: string | undefined;
  dueDate: string | null;
  /** Everything else, labelled, to list under the description. */
  extras: [string, string][];
}

function readSubmission(body: unknown): Submission {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest('Send the work item as a JSON object or a form');
  const fields: Fields = { ...(body as Fields) };
  delete fields.token;

  const title = take(fields, 'title', 'subject', 'summary');
  if (!title) throw badRequest('title: give it a title');
  const description = take(fields, 'description', 'body', 'message', 'details') ?? '';

  const priorityText = take(fields, 'priority')?.toLowerCase();
  if (priorityText && !(WORK_ITEM_PRIORITIES as string[]).includes(priorityText)) {
    throw badRequest(`priority: must be one of ${WORK_ITEM_PRIORITIES.join(', ')}`);
  }

  const dueDate = take(fields, 'dueDate', 'due_date', 'due') ?? null;
  if (dueDate && (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate) || Number.isNaN(Date.parse(dueDate)))) {
    throw badRequest('dueDate: must be YYYY-MM-DD');
  }

  const name = take(fields, 'requester', 'name');
  const email = take(fields, 'email');
  const extras: [string, string][] = [];
  if (name && email) extras.push(['Email', email]);

  const type = take(fields, 'type');
  for (const [key, value] of Object.entries(fields)) {
    const text = asText(value);
    if (text && extras.length < MAX_EXTRA_FIELDS) extras.push([label(key), text]);
  }

  return {
    title: title.replace(/\s+/g, ' ').slice(0, MAX_TITLE),
    description,
    priority: (priorityText as WorkItemPriority | undefined) ?? 'none',
    requester: (name ?? email)?.slice(0, 200),
    type,
    dueDate,
    extras,
  };
}

// --- filing it ---------------------------------------------------------------

interface TokenRow {
  id: string;
  name: string;
  project_id: string;
  workspace_id: string;
  kind: string;
  archived: boolean;
  type_id: string | null;
}

async function tokenFrom(req: FastifyRequest): Promise<TokenRow> {
  const header = req.headers.authorization;
  const bearer = header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : undefined;
  const fromBody = req.body && typeof req.body === 'object' ? asText((req.body as Fields).token) : '';
  const token = bearer || fromBody;
  if (!token) throw unauthorized('Send the intake token as a Bearer token, or in a field named token');

  intakeLimits.checkAddress(req.ip);
  const { rows } = token.startsWith(TOKEN_PREFIX)
    ? await query<TokenRow>(
        `SELECT t.id, t.name, t.project_id, p.workspace_id, p.kind, p.archived_at IS NOT NULL AS archived, t.type_id
           FROM intake_tokens t JOIN projects p ON p.id = t.project_id
          WHERE t.token_hash = $1`,
        [hashToken(token)],
      )
    : { rows: [] };
  if (!rows[0]) {
    intakeLimits.failed(req.ip);
    throw unauthorized('That token is not valid');
  }
  return rows[0];
}

interface TypeRow {
  id: string;
  name: string;
  epic: boolean;
  role_ids: string[];
}

async function createFromSubmission(token: TokenRow, input: Submission): Promise<{ id: string; key: string }> {
  const { rows: types } = await query<TypeRow>(
    `SELECT t.id, t.name, t.epic,
            ARRAY(SELECT tr.role_id FROM project_item_type_roles tr WHERE tr.type_id = t.id) AS role_ids
       FROM project_item_types t WHERE t.project_id = $1 ORDER BY t.position, t.created_at`,
    [token.project_id],
  );
  const { rows: projectRows } = await query<{ default_type_id: string | null }>(
    'SELECT default_type_id FROM projects WHERE id = $1',
    [token.project_id],
  );
  const usable = types.filter((t) => !t.epic);
  let type: TypeRow | undefined;
  if (input.type) {
    type = usable.find((t) => t.name.toLowerCase() === input.type!.toLowerCase());
    if (!type) throw badRequest(`type: this queue takes ${usable.map((t) => t.name).join(', ')}`);
  }
  type ??=
    usable.find((t) => t.id === token.type_id) ??
    usable.find((t) => t.id === projectRows[0]?.default_type_id) ??
    usable[0];
  if (!type) throw badRequest('This queue has no type work can come in as');

  const { rows: statuses } = await query<{ id: string; category: string }>(
    'SELECT id, category FROM project_statuses WHERE project_id = $1 ORDER BY position, created_at LIMIT 1',
    [token.project_id],
  );
  const status = statuses[0];
  if (!status) throw badRequest('This queue has no statuses');

  // Who asked goes in the queue's free-form role — its Requester, as a queue
  // starts with — when the type has one. Otherwise it is listed with the rest.
  const { rows: roles } = await query<{ id: string; name: string }>(
    `SELECT id, name FROM project_roles WHERE project_id = $1 AND free_form AND id = ANY($2::uuid[])
      ORDER BY lower(name) = 'requester' DESC, position, created_at`,
    [token.project_id, type.role_ids],
  );
  const requesterRole = input.requester ? roles[0] : undefined;
  const extras = [...input.extras];
  if (input.requester && !requesterRole) extras.unshift(['Requester', input.requester]);

  let description = inert(input.description);
  if (extras.length > 0) {
    const listed = extras.map(([key, value]) => `${inert(key)}: ${inert(value)}`).join('\n');
    description = description ? `${description}\n\n${listed}` : listed;
  }
  description = description.slice(0, MAX_DESCRIPTION);

  return transaction(async (client) => {
    const { rows: numbered } = await client.query<{ number: number; key: string }>(
      `UPDATE projects SET next_number = next_number + 1, updated_at = now() WHERE id = $1
       RETURNING next_number - 1 AS number, key`,
      [token.project_id],
    );
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO work_items (project_id, workspace_id, number, title, description, type_id, priority, status_id,
                               position, due_date, created_by, completed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NULL, CASE WHEN $11 THEN now() END)
       RETURNING id`,
      [
        token.project_id,
        token.workspace_id,
        numbered[0].number,
        inert(input.title),
        description,
        type.id,
        input.priority,
        status.id,
        await endOfStatus(client, status.id),
        input.dueDate,
        status.category === 'done',
      ],
    );
    const itemId = rows[0].id;
    if (requesterRole) await insertRoleHolders(client, itemId, requesterRole.id, [], [input.requester!]);
    await logActivity(client, itemId, null, { kind: 'created', via: token.name });
    await client.query('UPDATE intake_tokens SET last_used_at = now(), use_count = use_count + 1 WHERE id = $1', [
      token.id,
    ]);
    return { id: itemId, key: `${numbered[0].key}-${numbered[0].number}` };
  });
}

/** A browser that posted a plain form gets a page to read rather than JSON. */
function wantsPage(req: FastifyRequest): boolean {
  const type = String(req.headers['content-type'] ?? '');
  return type.startsWith('application/x-www-form-urlencoded') && String(req.headers.accept ?? '').includes('text/html');
}

function page(reply: FastifyReply, status: number, heading: string, text: string) {
  const escape = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  reply
    .status(status)
    .type('text/html; charset=utf-8')
    .send(
      `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
        `<title>${escape(heading)}</title></head><body><h1>${escape(heading)}</h1><p>${escape(text)}</p></body></html>`,
    );
}

// --- routes ------------------------------------------------------------------

/**
 * A form on any site may post here, and a script on one may call it, so it
 * answers any origin — without credentials, since the token is what it trusts.
 */
const OPEN_CORS = { cors: { origin: '*', credentials: false } };

const webhookRoutes: FastifyPluginAsync = async (app) => {
  // Plain HTML forms send this. Repeated names — a group of checkboxes — become a list.
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
    const fields: Record<string, string | string[]> = {};
    for (const [key, value] of new URLSearchParams(body as string)) {
      const existing = fields[key];
      fields[key] = existing === undefined ? value : [...(Array.isArray(existing) ? existing : [existing]), value];
    }
    done(null, fields);
  });

  // Answers the preflight here, so the permissive CORS applies to it rather
  // than the app's own.
  app.options('/intake', { config: OPEN_CORS }, async (_req, reply) => reply.status(204).send());

  app.post('/intake', { config: OPEN_CORS, bodyLimit: 256 * 1024 }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      // Off looks the same as an address that does not exist.
      if (!(await getServerSettings()).intakeWebhooks) throw notFound();
      const token = await tokenFrom(req);
      intakeLimits.checkToken(token.id);
      if (token.kind !== 'queue') throw forbidden('That token is not for a queue');
      if (token.archived) throw forbidden('The queue this token is for is archived');
      if (!(await appEnabled(token.workspace_id, 'projects'))) throw forbidden('Projects is turned off in that workspace');

      const created = await createFromSubmission(token, readSubmission(req.body));
      projectChanged(token.workspace_id, token.project_id, created.id);
      if (wantsPage(req)) return page(reply, 201, 'Thank you', `Your request was received as ${created.key}.`);
      reply.status(201);
      return { id: created.id, key: created.key };
    } catch (err) {
      if (err instanceof HttpError && wantsPage(req)) {
        if (err.retryAfter) reply.header('Retry-After', String(err.retryAfter));
        return page(reply, err.statusCode, 'Not sent', err.message);
      }
      throw err;
    }
  });
};

export const intakeRoutes: FastifyPluginAsync = async (app) => {
  // The webhook in a context of its own, so the form parser it needs reaches
  // nothing else: a form on another site must not be able to post to the
  // routes below, which trust the session cookie.
  await app.register(webhookRoutes);

  // --- a queue's tokens, for whoever may configure it ------------------------

  app.get<{ Params: { id: string } }>('/projects/:id/intake', { preHandler: app.requireAuth }, async (req) => {
    await assertProjectAccess(req, req.params.id, 'configure');
    const { rows } = await query<IntakeToken>(
      `SELECT ${TOKEN_COLUMNS} FROM intake_tokens t WHERE t.project_id = $1 ORDER BY t.created_at`,
      [req.params.id],
    );
    const settings: IntakeSettings = { enabled: (await getServerSettings()).intakeWebhooks, tokens: rows };
    return settings;
  });

  app.post<{ Params: { id: string } }>(
    '/projects/:id/intake-tokens',
    { preHandler: app.requireAuth },
    async (req, reply): Promise<CreatedIntakeToken> => {
      await assertProjectAccess(req, req.params.id, 'configure');
      await assertQueue(req.params.id);
      if (!(await getServerSettings()).intakeWebhooks) {
        throw forbidden('Taking in work from outside is turned off on this server. A server administrator can turn it on.');
      }
      const input = parse(createIntakeTokenSchema, req.body ?? {});
      await assertTypeOf(req.params.id, input.typeId);

      const token = TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
      const { rows } = await query<{ id: string }>(
        `INSERT INTO intake_tokens (project_id, name, token_hash, hint, type_id, created_by)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [req.params.id, input.name, hashToken(token), token.slice(-4), input.typeId ?? null, req.user!.id],
      );
      reply.status(201);
      return { ...(await fetchToken(rows[0].id)), token };
    },
  );

  app.patch<{ Params: { id: string } }>('/intake-tokens/:id', { preHandler: app.requireAuth }, async (req) => {
    const projectId = await tokenProject(req.params.id);
    await assertProjectAccess(req, projectId, 'configure');
    const input = parse(updateIntakeTokenSchema, req.body ?? {});
    await assertTypeOf(projectId, input.typeId);
    await query(
      `UPDATE intake_tokens
          SET name = COALESCE($2, name),
              type_id = CASE WHEN $3::boolean THEN $4::uuid ELSE type_id END
        WHERE id = $1`,
      [req.params.id, input.name ?? null, input.typeId !== undefined, input.typeId ?? null],
    );
    return fetchToken(req.params.id);
  });

  app.delete<{ Params: { id: string } }>('/intake-tokens/:id', { preHandler: app.requireAuth }, async (req, reply) => {
    const projectId = await tokenProject(req.params.id);
    await assertProjectAccess(req, projectId, 'configure');
    await query('DELETE FROM intake_tokens WHERE id = $1', [req.params.id]);
    reply.status(204);
  });
};
