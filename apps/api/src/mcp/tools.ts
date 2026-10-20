import type { FastifyInstance } from 'fastify';
import * as Y from 'yjs';
import {
  COLLAB_FRAGMENT,
  MAX_ARCHIVE_PAGE_SIZE,
  MAX_OUTLINE_SLIDES,
  WORK_ITEM_PRIORITIES,
  addOutlineSlides,
  deckMarkdown,
  deleteSlide,
  formatMinutes,
  isEpicType,
  parseMessage,
  parseOutline,
  readSlideOrder,
  type ArchivePage,
  type Channel,
  type ContentsPage,
  type DeckSnapshot,
  type Message,
  type MessageReferences,
  type MyShift,
  type PresentationSummary,
  type Project,
  type ProjectSummary,
  type ResponseTime,
  type Schedule,
  type ScheduleRequest,
  type ScheduleShifts,
  type ScheduleSummary,
  type WorkItem,
  type WorkItemActivity,
  type WorkItemListing,
  type WorkItemSummary,
  type WorkItemTimeline,
} from '@paradocs/shared';
import { DateTime } from 'luxon';
import { query } from '../db/pool.js';
import { UUID } from '../lib/access.js';
import { INTERNAL_CALL_HEADER, internalCallSecret, type AiCaller } from '../lib/aiTokens.js';
import { editDeck } from '../lib/deckWrite.js';
import { editLiveDocument, liveDocument } from '../lib/liveDocuments.js';
import { serverEditor } from '../collab/serverEditor.js';
import { documentAccessForUser } from '../plugins/session.js';

/**
 * What an assistant can do through the MCP server.
 *
 * Every tool does its work through the app's own routes, called in-process as
 * the connection's person, so an assistant is checked exactly as they would be
 * — roles, locks, apps turned off — and nothing here has to repeat those rules.
 * What this layer adds is what a connection may do beyond its person: stay in
 * its one workspace, and change nothing when it is read-only.
 *
 * Tools take what a person would say — a workspace's name, a project's key, an
 * item's key such as ENG-12, a status's name — rather than ids, and answer in
 * compact text, since what reads them is a language model.
 */

/** A failure to tell the assistant about, rather than a fault in the server. */
export class ToolError extends Error {}

export interface ToolContext {
  app: FastifyInstance;
  /** The Authorization header the assistant called with, passed on to the routes the tools call. */
  authorization: string;
  userId: string;
  ai: AiCaller;
  /** The server's public address, for links back into the app. */
  origin: string;
}

// --- arguments ----------------------------------------------------------------

interface Param {
  type: 'string' | 'integer' | 'boolean';
  description: string;
  enum?: readonly string[];
  required?: boolean;
}

type Params = Record<string, Param>;
type Args = Record<string, string | number | boolean | undefined>;

function inputSchema(params: Params) {
  return {
    type: 'object',
    properties: Object.fromEntries(
      Object.entries(params).map(([name, p]) => [
        name,
        { type: p.type, description: p.description, ...(p.enum ? { enum: p.enum } : {}) },
      ]),
    ),
    required: Object.entries(params)
      .filter(([, p]) => p.required)
      .map(([name]) => name),
    additionalProperties: false,
  };
}

/** Checks what the assistant sent against a tool's parameters. */
function readArgs(params: Params, raw: unknown): Args {
  const given = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const args: Args = {};
  for (const [name, p] of Object.entries(params)) {
    const value = given[name];
    if (value === undefined || value === null) {
      if (p.required) throw new ToolError(`${name} is required`);
      continue;
    }
    const ok =
      p.type === 'string'
        ? typeof value === 'string'
        : p.type === 'boolean'
          ? typeof value === 'boolean'
          : typeof value === 'number' && Number.isInteger(value);
    if (!ok) throw new ToolError(`${name} must be ${p.type === 'integer' ? 'a whole number' : `a ${p.type}`}`);
    if (p.enum && !p.enum.includes(value as string)) throw new ToolError(`${name} must be one of ${p.enum.join(', ')}`);
    args[name] = value as string | number | boolean;
  }
  return args;
}

const str = (args: Args, name: string) => (typeof args[name] === 'string' ? (args[name] as string) : undefined);
const num = (args: Args, name: string) => (typeof args[name] === 'number' ? (args[name] as number) : undefined);
const bool = (args: Args, name: string) => (typeof args[name] === 'boolean' ? (args[name] as boolean) : undefined);

// --- calling the app's own routes ---------------------------------------------

async function call<T>(ctx: ToolContext, method: 'GET' | 'POST' | 'PATCH' | 'PUT', path: string, body?: unknown): Promise<T> {
  const res = await ctx.app.inject({
    method,
    url: `/api${path}`,
    headers: {
      authorization: ctx.authorization,
      [INTERNAL_CALL_HEADER]: internalCallSecret,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    payload: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.statusCode === 204) return undefined as T;
  const json = String(res.headers['content-type'] ?? '').includes('application/json');
  const payload: unknown = json ? res.json() : res.body;
  if (res.statusCode >= 400) {
    const message =
      payload && typeof payload === 'object' && 'error' in payload ? String((payload as { error: unknown }).error) : '';
    throw new ToolError(message || `Request failed (${res.statusCode})`);
  }
  return payload as T;
}

function qs(params: Record<string, string | number | boolean | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== '') search.set(key, String(value));
  const out = search.toString();
  return out ? `?${out}` : '';
}

// --- what a connection may reach ----------------------------------------------

function inScope(ctx: ToolContext, workspaceId: string): boolean {
  return !ctx.ai.workspaceId || ctx.ai.workspaceId === workspaceId;
}

type Owned = 'documents' | 'spreadsheets' | 'presentations' | 'projects' | 'work_items' | 'channels';

/**
 * The workspace something is in, refused as not found when it is outside the
 * connection's one workspace. Whether the person may see it at all is for the
 * route that is called next.
 */
async function workspaceOf(ctx: ToolContext, table: Owned, id: string, what: string): Promise<string> {
  const { rows } = UUID.test(id)
    ? await query<{ workspace_id: string }>(`SELECT workspace_id FROM ${table} WHERE id = $1`, [id])
    : { rows: [] };
  if (!rows[0] || !inScope(ctx, rows[0].workspace_id)) throw new ToolError(`${what} not found`);
  return rows[0].workspace_id;
}

interface WorkspaceRow {
  id: string;
  name: string;
  slug: string;
  apps: string[];
  role: string;
}

async function workspaces(ctx: ToolContext): Promise<WorkspaceRow[]> {
  return (await call<WorkspaceRow[]>(ctx, 'GET', '/workspaces')).filter((w) => inScope(ctx, w.id));
}

/** A workspace by id, name or slug; left out, the only one there is. */
async function workspaceArg(ctx: ToolContext, arg: string | undefined): Promise<WorkspaceRow> {
  const list = await workspaces(ctx);
  const names = list.map((w) => `"${w.name}"`).join(', ');
  if (!arg) {
    if (list.length === 1) return list[0];
    throw new ToolError(list.length ? `Say which workspace: ${names}` : 'You are not in any workspace this connection can reach');
  }
  const want = arg.trim().toLowerCase();
  const found = list.find((w) => w.id === want || w.slug.toLowerCase() === want || w.name.toLowerCase() === want);
  if (!found) throw new ToolError(`No workspace "${arg}". Workspaces: ${names || 'none'}`);
  return found;
}

/** The workspaces to look through: the one named, or every one with `app` turned on. */
async function workspacesFor(ctx: ToolContext, arg: string | undefined, app: string): Promise<WorkspaceRow[]> {
  if (arg) return [await workspaceArg(ctx, arg)];
  return (await workspaces(ctx)).filter((w) => w.apps.includes(app));
}

/** Somewhere a key or name matched in more than one workspace: say which, so the assistant can name one. */
async function ambiguous(rows: { workspace_id: string }[], what: string, arg: string): Promise<never> {
  const { rows: named } = await query<{ name: string }>(
    'SELECT name FROM workspaces WHERE id = ANY($1::uuid[]) ORDER BY lower(name)',
    [[...new Set(rows.map((r) => r.workspace_id))]],
  );
  throw new ToolError(
    `More than one ${what} is "${arg}", in the workspaces ${named.map((w) => `"${w.name}"`).join(' and ')}. Pass workspace to say which.`,
  );
}

async function projectArg(ctx: ToolContext, arg: string, workspace?: string): Promise<Project> {
  let id = arg.trim();
  if (!UUID.test(id)) {
    const scope = workspace ? (await workspaceArg(ctx, workspace)).id : ctx.ai.workspaceId;
    const { rows: found } = await query<{ id: string; workspace_id: string; by_key: boolean }>(
      `SELECT p.id, p.workspace_id, upper(p.key) = upper($2) AS by_key FROM projects p
         JOIN workspace_members m ON m.workspace_id = p.workspace_id AND m.user_id = $1
        WHERE (upper(p.key) = upper($2) OR lower(p.name) = lower($2))
          AND ($3::uuid IS NULL OR p.workspace_id = $3) AND p.archived_at IS NULL`,
      [ctx.userId, id, scope],
    );
    // A key is what people mean by ENG; a project that happens to be named "eng" does not compete with it.
    const byKey = found.filter((r) => r.by_key);
    const rows = byKey.length > 0 ? byKey : found;
    if (rows.length === 0) throw new ToolError(`No project or queue "${arg}". list_projects shows them.`);
    if (rows.length > 1) await ambiguous(rows, 'project', arg);
    id = rows[0].id;
  }
  await workspaceOf(ctx, 'projects', id, 'Project');
  return call<Project>(ctx, 'GET', `/projects/${id}`);
}

const ITEM_KEY = /^([A-Za-z][A-Za-z0-9]*)-(\d+)$/;

/** A work item by its key, such as ENG-12, or its id. */
async function itemIdArg(ctx: ToolContext, arg: string, workspace?: string): Promise<string> {
  const text = arg.trim();
  if (UUID.test(text)) {
    await workspaceOf(ctx, 'work_items', text, 'Work item');
    return text;
  }
  const key = ITEM_KEY.exec(text);
  if (!key) throw new ToolError('Name a work item by its key, such as ENG-12');
  const scope = workspace ? (await workspaceArg(ctx, workspace)).id : ctx.ai.workspaceId;
  const { rows } = await query<{ id: string; workspace_id: string }>(
    `SELECT i.id, i.workspace_id FROM work_items i
       JOIN projects p ON p.id = i.project_id
       JOIN workspace_members m ON m.workspace_id = i.workspace_id AND m.user_id = $1
      WHERE upper(p.key) = upper($2) AND i.number = $3 AND ($4::uuid IS NULL OR i.workspace_id = $4)`,
    [ctx.userId, key[1], Number(key[2]), scope],
  );
  if (rows.length === 0) throw new ToolError(`No work item ${text.toUpperCase()}`);
  if (rows.length > 1) await ambiguous(rows, 'work item', text);
  return rows[0].id;
}

/** An epic by its key or id, read as the person, so one they cannot see is not found. */
async function epicArg(ctx: ToolContext, arg: string, workspace?: string): Promise<WorkItem> {
  const item = await call<WorkItem>(ctx, 'GET', `/work-items/${await itemIdArg(ctx, arg, workspace)}`);
  const project = await call<Project>(ctx, 'GET', `/projects/${item.projectId}`);
  if (!isEpicType(project, item.typeId)) throw new ToolError(`${item.key} is not an epic`);
  return item;
}

/**
 * The keys of the epics work is under, by id. An epic is always in the same
 * project as the work under it, so whoever can see the work can see its epic.
 */
async function epicKeys(ids: (string | null)[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((id): id is string => id !== null))];
  if (wanted.length === 0) return new Map();
  const { rows } = await query<{ id: string; key: string }>(
    `SELECT i.id, p.key || '-' || i.number AS key FROM work_items i JOIN projects p ON p.id = i.project_id
      WHERE i.id = ANY($1::uuid[])`,
    [wanted],
  );
  return new Map(rows.map((r) => [r.id, r.key]));
}

interface LinkTargets {
  documents: { id: string; title: string }[];
  spreadsheets: { id: string; title: string }[];
  presentations?: { id: string; title: string }[];
}

const TITLED = {
  documents: { what: 'Document', app: 'docs' },
  spreadsheets: { what: 'Spreadsheet', app: 'sheets' },
  presentations: { what: 'Presentation', app: 'slides' },
} as const;

/** A document, spreadsheet or presentation by id, or by its title. */
async function titledArg(
  ctx: ToolContext,
  kind: keyof typeof TITLED,
  arg: string,
  workspace?: string,
): Promise<string> {
  const { what, app } = TITLED[kind];
  const text = arg.trim();
  if (UUID.test(text)) {
    await workspaceOf(ctx, kind, text, what);
    return text;
  }
  const matches: { id: string; title: string }[] = [];
  for (const w of await workspacesFor(ctx, workspace, app)) {
    const found = await call<LinkTargets>(ctx, 'GET', `/workspaces/${w.id}/link-targets${qs({ q: text, kinds: kind, limit: 20 })}`);
    matches.push(...(found[kind] ?? []));
  }
  const exact = matches.filter((m) => m.title.toLowerCase() === text.toLowerCase());
  const pick = exact.length > 0 ? exact : matches;
  if (pick.length === 1) return pick[0].id;
  if (pick.length === 0) throw new ToolError(`No ${what.toLowerCase()} titled "${arg}". Try search.`);
  throw new ToolError(
    `Several match "${arg}": ${pick.slice(0, 10).map((m) => `"${m.title}" (${m.id})`).join(', ')}. Pass the id.`,
  );
}

async function channelArg(ctx: ToolContext, arg: string, workspace?: string): Promise<Channel> {
  const text = arg.trim().replace(/^#/, '');
  if (UUID.test(text)) {
    const workspaceId = await workspaceOf(ctx, 'channels', text, 'Channel');
    const found = (await call<Channel[]>(ctx, 'GET', `/workspaces/${workspaceId}/channels`)).find((c) => c.id === text);
    if (!found) throw new ToolError('Channel not found');
    return found;
  }
  const matches: Channel[] = [];
  for (const w of await workspacesFor(ctx, workspace, 'chat')) {
    const channels = await call<Channel[]>(ctx, 'GET', `/workspaces/${w.id}/channels`);
    matches.push(...channels.filter((c) => c.name.toLowerCase() === text.toLowerCase()));
  }
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) throw new ToolError(`No channel "${arg}". list_channels shows them.`);
  throw new ToolError(`More than one channel is "${arg}". Name the workspace too.`);
}

// --- reading what comes back --------------------------------------------------

interface Member {
  userId: string;
  name: string;
  email: string;
}

async function members(ctx: ToolContext, workspaceId: string): Promise<Member[]> {
  return call<Member[]>(ctx, 'GET', `/workspaces/${workspaceId}/members`);
}

/** Someone by "me", their name or their email. */
function memberArg(ctx: ToolContext, people: Member[], arg: string): Member | undefined {
  const want = arg.trim().toLowerCase();
  if (want === 'me') return people.find((m) => m.userId === ctx.userId);
  return people.find((m) => m.email.toLowerCase() === want || m.name.toLowerCase() === want);
}

/** Text with reference tokens (`<@…>`, `<item:…>`), as descriptions and messages are written, made readable. */
function readable(text: string, refs: Partial<MessageReferences> | undefined): string {
  const byId = <T extends { id: string }>(list: T[] | undefined) => new Map((list ?? []).map((r) => [r.id, r]));
  const docs = byId(refs?.documents);
  const sheets = byId(refs?.spreadsheets);
  const channels = byId(refs?.channels);
  const people = byId(refs?.members);
  const items = byId(refs?.workItems);
  const projects = byId(refs?.projects);
  return parseMessage(text)
    .map((s) => {
      switch (s.type) {
        case 'text':
          return s.value;
        case 'document':
          return `[doc: ${docs.get(s.id)?.title ?? s.id}]`;
        case 'spreadsheet':
          return `[sheet: ${sheets.get(s.id)?.title ?? s.id}]`;
        case 'channel':
          return `#${channels.get(s.id)?.name ?? s.id}`;
        case 'member':
          return `@${people.get(s.id)?.name ?? 'someone'}`;
        case 'here':
          return '@here';
        case 'workItem': {
          const item = items.get(s.id);
          return item ? `${item.key} (${item.title})` : '[work item]';
        }
        case 'project':
          return `[${projects.get(s.id)?.name ?? 'project'}]`;
      }
    })
    .join('');
}

function roleSummary(item: WorkItemSummary, project: Project, people: Map<string, string>): string {
  return project.roles
    .map((role) => {
      const holders = [
        ...(item.roles[role.id] ?? []).map((id) => people.get(id) ?? 'someone'),
        ...(item.roleNames[role.id] ?? []),
      ];
      return holders.length ? `${role.name}: ${holders.join(', ')}` : '';
    })
    .filter(Boolean)
    .join(' · ');
}

function itemLine(
  item: WorkItemSummary,
  project: Project,
  people: Map<string, string>,
  epics: Map<string, string>,
): string {
  const type = project.itemTypes.find((t) => t.id === item.typeId)?.name;
  const roles = roleSummary(item, project, people);
  const epic = item.epicId && epics.get(item.epicId);
  const extra = [
    type,
    item.priority !== 'none' ? item.priority : '',
    item.dueDate ? `due ${item.dueDate}` : '',
    item.estimate !== null ? `est ${item.estimate}` : '',
    item.blockedBy ? 'blocked' : '',
    epic ? `epic ${epic}` : '',
    roles,
  ].filter(Boolean);
  return `- ${item.key}: ${item.title}${extra.length ? ` (${extra.join('; ')})` : ''}`;
}

function itemUrl(ctx: ToolContext, workspaceId: string, item: { projectId: string; id: string }): string {
  return `${ctx.origin}/w/${workspaceId}/p/${item.projectId}/${item.id}`;
}

function peopleMap(list: Member[]): Map<string, string> {
  return new Map(list.map((m) => [m.userId, m.name]));
}

/** A work item in full: what it is, where it has got to, and what has been said about it. */
async function describeItem(ctx: ToolContext, itemId: string): Promise<string> {
  const item = await call<WorkItem>(ctx, 'GET', `/work-items/${itemId}`);
  const project = await call<Project>(ctx, 'GET', `/projects/${item.projectId}`);
  const isEpic = isEpicType(project, item.typeId);
  const [timeline, people, epic, current, archived] = await Promise.all([
    call<WorkItemTimeline>(ctx, 'GET', `/work-items/${itemId}/timeline`),
    members(ctx, project.workspaceId),
    item.epicId
      ? query<{ key: string; title: string }>(
          `SELECT p.key || '-' || i.number AS key, i.title FROM work_items i JOIN projects p ON p.id = i.project_id WHERE i.id = $1`,
          [item.epicId],
        )
      : null,
    // An epic's work is all in its own project: what is current, and what has been archived.
    isEpic ? call<WorkItemSummary[]>(ctx, 'GET', `/projects/${project.id}/items`) : null,
    isEpic
      ? call<ArchivePage>(ctx, 'GET', `/projects/${project.id}/archive${qs({ epic: item.id, limit: MAX_ARCHIVE_PAGE_SIZE })}`)
      : null,
  ]);
  const names = peopleMap(people);
  const status = project.statuses.find((s) => s.id === item.statusId);
  const type = project.itemTypes.find((t) => t.id === item.typeId);
  const sprint = project.sprints.find((s) => s.id === item.sprintId);
  const facts = [
    `Project: ${project.name} (${project.key})`,
    `Status: ${status?.name ?? '?'} [${status?.category ?? '?'}]`,
    `Type: ${type?.name ?? '?'}`,
    `Priority: ${item.priority}`,
    item.dueDate && `Due: ${item.dueDate}`,
    item.estimate !== null && `Estimate: ${item.estimate}`,
    sprint && `Sprint: ${sprint.name} (${sprint.state})`,
    epic?.rows[0] && `Epic: ${epic.rows[0].key} ${epic.rows[0].title}`,
    item.blockedBy && `Blocked by ${item.blockedBy} unfinished item(s)`,
    item.archivedAt && 'Archived',
  ].filter(Boolean);
  const roles = roleSummary(item, project, names);
  const refs = timeline.references;
  const escalations = timeline.activity.flatMap((a) =>
    a.kind === 'escalated'
      ? [`- ${a.createdAt.slice(0, 16).replace('T', ' ')}: ${escalationLine(a, names)}`]
      : [],
  );
  const comments = timeline.comments.map(
    (c) => `- ${c.author?.name ?? 'Someone'}, ${c.createdAt.slice(0, 10)}: ${readable(c.body, refs)}`,
  );
  const header = [`# ${item.key}: ${item.title}`, facts.join(' · '), roles, `Link: ${itemUrl(ctx, project.workspaceId, item)}`];
  return [
    header.filter(Boolean).join('\n'),
    `## Description\n${item.description.trim() ? readable(item.description, item.references) : '(none)'}`,
    current && archived && childList(project, names, current.filter((i) => i.epicId === item.id), archived),
    escalations.length > 0 && `## Escalations\n${escalations.join('\n')}`,
    `## Comments (${comments.length})\n${comments.length ? comments.join('\n') : '(none)'}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** What a queue's response time does, in a line: who it waits on, and where work goes and when. */
function responseTimeSummary(project: Project, responseTime: ResponseTime): string {
  const role = (id: string | null) => project.roles.find((r) => r.id === id)?.name ?? 'a role';
  const steps = responseTime.steps.map((step, n) =>
    n === 0
      ? `after ${formatMinutes(step.afterMinutes)} without a response, escalated to ${role(step.roleId)}`
      : `${formatMinutes(step.afterMinutes)} later to ${role(step.roleId)}`,
  );
  const waiting = responseTime.roleId ? `waits on ${role(responseTime.roleId)}; ` : '';
  return `${waiting}${steps.join(', then ')}. A comment from anyone but the filer, a status change or finishing it is a response.`;
}

/** An escalation in an item's history, as its history in the app tells it. */
function escalationLine(entry: Extract<WorkItemActivity, { kind: 'escalated' }>, names: Map<string, string>): string {
  const who = [...entry.added, ...entry.held].map((id) => names.get(id) ?? 'someone');
  const after = `after ${formatMinutes(entry.minutes)} without a response, by the queue's response time`;
  return who.length > 0 ? `Escalated to ${who.join(', ')} (${entry.role}) ${after}` : `Nobody was in ${entry.role} to escalate to ${after}`;
}

/** The work under an epic, current in board order and then archived, each with its type, status and assignee. */
function childList(project: Project, people: Map<string, string>, current: WorkItemSummary[], archived: ArchivePage): string {
  const order = new Map(project.statuses.map((s, n) => [s.id, n]));
  const done = new Set(project.statuses.filter((s) => s.category === 'done').map((s) => s.id));
  const sorted = [...current].sort(
    (a, b) => (order.get(a.statusId) ?? 0) - (order.get(b.statusId) ?? 0) || a.position - b.position,
  );
  const role = findAssigneeRole(project);
  const line = (child: WorkItemSummary, isArchived: boolean) => {
    const holders = role ? [...(child.roles[role.id] ?? []).map((id) => people.get(id) ?? 'someone'), ...(child.roleNames[role.id] ?? [])] : [];
    const extra = [
      project.itemTypes.find((t) => t.id === child.typeId)?.name,
      project.statuses.find((s) => s.id === child.statusId)?.name,
      role && `${role.name}: ${holders.length ? holders.join(', ') : 'nobody'}`,
      isArchived && 'archived',
    ].filter(Boolean);
    return `- ${child.key}: ${child.title} (${extra.join('; ')})`;
  };
  const total = current.length + archived.total;
  const finished = current.filter((i) => done.has(i.statusId)).length + archived.total;
  const lines = [...sorted.map((c) => line(c, false)), ...archived.items.map((c) => line(c, true))];
  if (archived.total > archived.items.length) lines.push(`…and ${archived.total - archived.items.length} more archived.`);
  return `## Work under it (${total}, ${finished} done)\n${lines.length ? lines.join('\n') : '(none)'}`;
}

function statusArg(project: Project, arg: string) {
  const want = arg.trim().toLowerCase();
  const status = project.statuses.find((s) => s.id === arg || s.name.toLowerCase() === want);
  if (!status) throw new ToolError(`No status "${arg}" in ${project.key}. Statuses: ${project.statuses.map((s) => s.name).join(', ')}`);
  return status;
}

function typeArg(project: Project, arg: string) {
  const want = arg.trim().toLowerCase();
  const type = project.itemTypes.find((t) => t.id === arg || t.name.toLowerCase() === want);
  if (!type) throw new ToolError(`No type "${arg}" in ${project.key}. Types: ${project.itemTypes.map((t) => t.name).join(', ')}`);
  return type;
}

/** The role "assignee" means: one called Assignee, or else the project's first role. */
function findAssigneeRole(project: Project) {
  return project.roles.find((r) => r.name.toLowerCase() === 'assignee') ?? project.roles[0];
}

function assigneeRole(project: Project) {
  const role = findAssigneeRole(project);
  if (!role) throw new ToolError(`${project.key} has no roles to assign anyone to`);
  return role;
}

/** Who to put in the assignee role: a member, or for a free-form role any name. Empty clears it. */
function holdersFor(ctx: ToolContext, project: Project, people: Member[], arg: string) {
  const role = assigneeRole(project);
  if (!arg.trim()) return { role, userIds: [] as string[], names: [] as string[] };
  const member = memberArg(ctx, people, arg);
  if (member) return { role, userIds: [member.userId], names: [] as string[] };
  if (role.freeForm) return { role, userIds: [] as string[], names: [arg.trim()] };
  throw new ToolError(`No member "${arg}" in this workspace. Use "me", a member's name, or their email.`);
}

// --- documents ----------------------------------------------------------------

type Blocks = Awaited<ReturnType<typeof serverEditor.tryParseMarkdownToBlocks>>;

/**
 * Replaces a document's body with blocks, in its Y.Doc. Used for a document
 * someone has open in the editor, whose open copy is the one that counts: the
 * change goes into it, and reaches everyone editing as their own would.
 */
function replaceBody(doc: Y.Doc, blocks: Blocks): void {
  // Through an update rather than handed over directly: the Y.Doc BlockNote
  // makes may come from another copy of yjs than the one the server runs.
  const fresh = new Y.Doc();
  Y.applyUpdate(fresh, Y.encodeStateAsUpdate(serverEditor.blocksToYDoc(blocks, COLLAB_FRAGMENT)));
  const source = fresh.getXmlFragment(COLLAB_FRAGMENT);
  const target = doc.getXmlFragment(COLLAB_FRAGMENT);
  target.delete(0, target.length);
  // BlockNote writes elements and text, never hooks.
  target.insert(0, source.toArray().map((node) => node.clone() as Y.XmlElement | Y.XmlText));
  fresh.destroy();
}

async function writeDocument(
  ctx: ToolContext,
  documentId: string,
  input: { title?: string; markdown?: string; append: boolean },
): Promise<void> {
  const { rows } = await query<{ mode: string }>('SELECT mode FROM documents WHERE id = $1', [documentId]);
  if (rows[0]?.mode === 'canvas' && input.markdown !== undefined) {
    throw new ToolError('That document is a canvas, which has no text body to write. Only its title can change.');
  }
  // The title goes through the route, which also checks the person may edit it.
  const patch: Record<string, unknown> = {};
  if (input.title !== undefined) patch.title = input.title;

  if (input.markdown !== undefined) {
    const added = await serverEditor.tryParseMarkdownToBlocks(input.markdown);
    const live = liveDocument(documentId);
    if (live) {
      const access = await documentAccessForUser(ctx.userId, documentId);
      if (!access?.canEdit) throw new ToolError('You can view this document but not change it');
      if (Object.keys(patch).length) await call(ctx, 'PATCH', `/documents/${documentId}`, patch);
      const written = await editLiveDocument(documentId, ctx.userId, (doc) => {
        let blocks = added;
        if (input.append) {
          // Read from a copy: converting binds the document it is given, and the open one must not be touched.
          const snapshot = new Y.Doc();
          Y.applyUpdate(snapshot, Y.encodeStateAsUpdate(doc));
          blocks = [...(serverEditor.yDocToBlocks(snapshot, COLLAB_FRAGMENT) as Blocks), ...added];
          snapshot.destroy();
        }
        replaceBody(doc, blocks);
      });
      if (written) return;
    }
    let blocks = added;
    if (input.append) {
      const current = await call<{ body: unknown[] }>(ctx, 'GET', `/documents/${documentId}`);
      blocks = [...((current.body ?? []) as Blocks), ...added];
    }
    patch.body = blocks;
    patch.bodyMd = await serverEditor.blocksToMarkdownLossy(blocks);
  }
  if (Object.keys(patch).length === 0) throw new ToolError('Give a title or markdown to write');
  await call(ctx, 'PATCH', `/documents/${documentId}`, patch);
}

/** An outline's slides, or a refusal that says what an outline looks like. */
function outlineArg(text: string) {
  const slides = parseOutline(text);
  if (slides.length === 0) throw new ToolError('The outline has no slides. Start each slide with a heading, such as "# Title".');
  if (slides.length > MAX_OUTLINE_SLIDES) throw new ToolError(`An outline can have up to ${MAX_OUTLINE_SLIDES} slides`);
  return slides;
}

function stripMarks(text: string | null | undefined): string {
  return (text ?? '').replace(/<\/?mark>/g, '').replace(/\s+/g, ' ').trim();
}


// --- schedules ------------------------------------------------------------------

/** A schedule by name or id, among those the person can see. */
async function scheduleArg(ctx: ToolContext, arg: string, workspace?: string): Promise<Schedule> {
  const want = arg.trim().toLowerCase();
  const found: ScheduleSummary[] = [];
  for (const w of await workspacesFor(ctx, workspace, 'schedules')) {
    const list = await call<ScheduleSummary[]>(ctx, 'GET', `/workspaces/${w.id}/schedules`);
    found.push(...list.filter((s) => s.id === want || s.name.toLowerCase() === want));
  }
  if (found.length === 0) {
    // A name partly given is fine when only one schedule fits it.
    for (const w of await workspacesFor(ctx, workspace, 'schedules')) {
      const list = await call<ScheduleSummary[]>(ctx, 'GET', `/workspaces/${w.id}/schedules`);
      found.push(...list.filter((s) => s.name.toLowerCase().includes(want)));
    }
  }
  if (found.length === 0) throw new ToolError(`No schedule "${arg}". list_schedules shows them.`);
  if (found.length > 1) {
    throw new ToolError(`More than one schedule matches "${arg}": ${found.map((s) => `"${s.name}"`).join(', ')}. Name one exactly.`);
  }
  return call<Schedule>(ctx, 'GET', `/schedules/${found[0].id}`);
}

/** A time as the assistant gave it, or now: ISO, or a date and time read in `zone`. */
function timeArg(value: string | undefined, zone: string, what: string): DateTime {
  if (!value) return DateTime.now();
  const parsed = DateTime.fromISO(value.trim().replace(' ', 'T'), { zone });
  if (!parsed.isValid) throw new ToolError(`${what} must be a date and time such as 2026-03-01T09:00 or 2026-03-01T09:00Z`);
  return parsed;
}

/** A moment in a schedule's own zone, readably. */
function zoned(iso: string, zone: string): string {
  return DateTime.fromISO(iso).setZone(zone).toFormat("ccc d LLL yyyy HH:mm");
}

async function memberNames(ctx: ToolContext, workspaceId: string): Promise<Map<string, string>> {
  const members = await call<{ userId: string; name: string }[]>(ctx, 'GET', `/workspaces/${workspaceId}/members`);
  return new Map(members.map((m) => [m.userId, m.name]));
}

// --- the tools ----------------------------------------------------------------

export interface Tool {
  name: string;
  title: string;
  description: string;
  params: Params;
  /** Changes something, so a read-only connection is neither offered it nor allowed it. */
  writes: boolean;
  run: (ctx: ToolContext, args: Args) => Promise<string>;
}

const WORKSPACE: Param = {
  type: 'string',
  description: 'Workspace name or id. Can be left out when there is only one.',
};

const PRIORITIES = WORK_ITEM_PRIORITIES as readonly string[];

export const TOOLS: Tool[] = [
  {
    name: 'list_workspaces',
    title: 'List workspaces',
    description: 'The ParaDOCs workspaces you can reach, with the apps each has turned on.',
    params: {},
    writes: false,
    async run(ctx) {
      const list = await workspaces(ctx);
      if (list.length === 0) return 'No workspaces.';
      return list.map((w) => `- ${w.name} (id ${w.id}; your role: ${w.role}; apps: ${w.apps.join(', ')})`).join('\n');
    },
  },
  {
    name: 'search',
    title: 'Search',
    description:
      'Full-text search across documents, spreadsheets, presentations (slide text and speaker notes), work items and schedules. Returns titles, ids and snippets; read one with read_document, read_spreadsheet, read_presentation, get_work_item or who_is_on.',
    params: {
      query: { type: 'string', description: 'What to look for', required: true },
      workspace: { ...WORKSPACE, description: 'Workspace name or id. Left out, every workspace is searched.' },
    },
    writes: false,
    async run(ctx, args) {
      const out: string[] = [];
      const list = str(args, 'workspace') ? [await workspaceArg(ctx, str(args, 'workspace'))] : await workspaces(ctx);
      for (const w of list) {
        const found = await call<{
          hits: { id: string; title: string; snippet: string | null }[];
          sheets: { id: string; title: string; snippet: string | null }[];
          presentations?: { id: string; title: string; snippet: string | null; slide: number | null; inNotes: boolean }[];
          workItems: { key: string; title: string; statusName: string; projectName: string }[];
          schedules?: { id: string; name: string; description: string }[];
        }>(ctx, 'GET', `/workspaces/${w.id}/search${qs({ q: str(args, 'query'), limit: 20 })}`);
        const lines = [
          ...found.hits.map((d) => `- document "${d.title}" (id ${d.id}): ${stripMarks(d.snippet)}`),
          ...found.sheets.map((s) => `- spreadsheet "${s.title}" (id ${s.id}): ${stripMarks(s.snippet)}`),
          ...(found.presentations ?? []).map(
            (p) =>
              `- presentation "${p.title}" (id ${p.id})${p.slide ? `, slide ${p.slide}${p.inNotes ? ' notes' : ''}` : ''}: ${stripMarks(p.snippet)}`,
          ),
          ...found.workItems.map((i) => `- work item ${i.key}: ${i.title} [${i.statusName}] in ${i.projectName}`),
          ...(found.schedules ?? []).map((s) => `- schedule "${s.name}" (id ${s.id})${s.description ? `: ${s.description.slice(0, 160)}` : ''}`),
        ];
        if (lines.length) out.push(list.length > 1 ? `## ${w.name}\n${lines.join('\n')}` : lines.join('\n'));
      }
      return out.length ? out.join('\n\n') : 'Nothing found.';
    },
  },

  // --- documents ---------------------------------------------------------------
  {
    name: 'list_documents',
    title: 'List documents',
    description: 'Documents in a workspace, most recently updated first.',
    params: {
      workspace: WORKSPACE,
      limit: { type: 'integer', description: 'How many, up to 200. Default 50.' },
      offset: { type: 'integer', description: 'How many to skip, for the next page' },
    },
    writes: false,
    async run(ctx, args) {
      const w = await workspaceArg(ctx, str(args, 'workspace'));
      const limit = Math.min(Math.max(num(args, 'limit') ?? 50, 1), 200);
      const page = await call<{ documents: { id: string; title: string; mode: string; updatedAt: string }[]; hasMore: boolean }>(
        ctx,
        'GET',
        `/workspaces/${w.id}/documents${qs({ limit, offset: num(args, 'offset') })}`,
      );
      if (page.documents.length === 0) return 'No documents.';
      const lines = page.documents.map(
        (d) => `- "${d.title || 'Untitled'}" (id ${d.id}${d.mode === 'canvas' ? ', canvas' : ''}; updated ${d.updatedAt.slice(0, 10)})`,
      );
      if (page.hasMore) lines.push(`More: pass offset ${(num(args, 'offset') ?? 0) + limit}.`);
      return lines.join('\n');
    },
  },
  {
    name: 'read_document',
    title: 'Read a document',
    description: 'A document as markdown, with its title and tags.',
    params: {
      document: { type: 'string', description: 'Document id, or its exact title', required: true },
      workspace: WORKSPACE,
    },
    writes: false,
    async run(ctx, args) {
      const id = await titledArg(ctx, 'documents', str(args, 'document')!, str(args, 'workspace'));
      const markdown = await call<string>(ctx, 'GET', `/documents/${id}/markdown`);
      const workspaceId = await workspaceOf(ctx, 'documents', id, 'Document');
      return `Link: ${ctx.origin}/w/${workspaceId}/d/${id}\n\n${markdown}`;
    },
  },
  {
    name: 'create_document',
    title: 'Create a document',
    description: 'Makes a new document from markdown. It starts unfiled, under All Documents, unless a folder id is given.',
    params: {
      title: { type: 'string', description: 'The title', required: true },
      markdown: { type: 'string', description: 'The body, as markdown', required: true },
      workspace: WORKSPACE,
      folderId: { type: 'string', description: 'The folder to file it in' },
    },
    writes: true,
    async run(ctx, args) {
      const w = await workspaceArg(ctx, str(args, 'workspace'));
      const body = await serverEditor.tryParseMarkdownToBlocks(str(args, 'markdown')!);
      const doc = await call<{ id: string; title: string }>(ctx, 'POST', `/workspaces/${w.id}/documents`, {
        title: str(args, 'title'),
        body,
        folderId: str(args, 'folderId') ?? null,
      });
      return `Created "${doc.title}" (id ${doc.id}).\nLink: ${ctx.origin}/w/${w.id}/d/${doc.id}`;
    },
  },
  {
    name: 'update_document',
    title: 'Update a document',
    description:
      'Changes a document\'s title, or writes markdown into it: replacing its body, or with append added at the end. Someone editing it at the time sees the change live.',
    params: {
      document: { type: 'string', description: 'Document id, or its exact title', required: true },
      title: { type: 'string', description: 'A new title' },
      markdown: { type: 'string', description: 'Markdown to write' },
      append: { type: 'boolean', description: 'Add the markdown after what is there instead of replacing it. Default false.' },
      workspace: WORKSPACE,
    },
    writes: true,
    async run(ctx, args) {
      const id = await titledArg(ctx, 'documents', str(args, 'document')!, str(args, 'workspace'));
      await writeDocument(ctx, id, {
        title: str(args, 'title'),
        markdown: str(args, 'markdown'),
        append: bool(args, 'append') ?? false,
      });
      return `Updated document ${id}.`;
    },
  },
  {
    name: 'read_spreadsheet',
    title: 'Read a spreadsheet',
    description: "A spreadsheet's cells as text, sheet by sheet. Formulas are given as written, not as their results.",
    params: {
      spreadsheet: { type: 'string', description: 'Spreadsheet id, or its exact title', required: true },
      workspace: WORKSPACE,
    },
    writes: false,
    async run(ctx, args) {
      const id = await titledArg(ctx, 'spreadsheets', str(args, 'spreadsheet')!, str(args, 'workspace'));
      const text = await call<string>(ctx, 'GET', `/spreadsheets/${id}/text`);
      return text.trim() || '(empty)';
    },
  },

  // --- presentations -----------------------------------------------------------
  {
    name: 'list_presentations',
    title: 'List presentations',
    description: 'Presentations (slide decks) in a workspace, most recently updated first.',
    params: {
      workspace: WORKSPACE,
      limit: { type: 'integer', description: 'How many, up to 100. Default 50.' },
      cursor: { type: 'string', description: 'The cursor a previous page gave, for the next page' },
    },
    writes: false,
    async run(ctx, args) {
      const w = await workspaceArg(ctx, str(args, 'workspace'));
      const limit = Math.min(Math.max(num(args, 'limit') ?? 50, 1), 100);
      const page = await call<ContentsPage<PresentationSummary>>(
        ctx,
        'GET',
        `/workspaces/${w.id}/presentations${qs({ limit, cursor: str(args, 'cursor') })}`,
      );
      if (page.items.length === 0) return 'No presentations.';
      const lines = page.items.map((p) => `- "${p.title || 'Untitled'}" (id ${p.id}; updated ${p.updatedAt.slice(0, 10)})`);
      if (page.nextCursor) lines.push(`More: pass cursor ${page.nextCursor}.`);
      return lines.join('\n');
    },
  },
  {
    name: 'read_presentation',
    title: 'Read a presentation',
    description:
      'A presentation as markdown: a heading per slide with its text, then its speaker notes after "Notes:". Text in a body placeholder is listed as bullets.',
    params: {
      presentation: { type: 'string', description: 'Presentation id, or its exact title', required: true },
      workspace: WORKSPACE,
    },
    writes: false,
    async run(ctx, args) {
      const id = await titledArg(ctx, 'presentations', str(args, 'presentation')!, str(args, 'workspace'));
      const deck = await call<DeckSnapshot & { title: string; workspaceId: string }>(ctx, 'GET', `/presentations/${id}/deck`);
      return `Link: ${ctx.origin}/w/${deck.workspaceId}/sl/${id}\n\n${deckMarkdown(deck.title, deck)}`;
    },
  },
  {
    name: 'create_presentation',
    title: 'Create a presentation',
    description:
      "Makes a new presentation from an outline in markdown. Each heading (#) is a slide title; lines under it are its bullets (- item, indented two spaces per level) or plain text; a \"Notes:\" line starts that slide's speaker notes. Slides use the deck's own layouts: a title-only slide is a Title slide, the rest Title and content. It starts unfiled unless a folder id is given.",
    params: {
      title: { type: 'string', description: "The presentation's title", required: true },
      outline: { type: 'string', description: 'The slides, as a markdown outline', required: true },
      workspace: WORKSPACE,
      folderId: { type: 'string', description: 'The Slides folder to file it in' },
    },
    writes: true,
    async run(ctx, args) {
      const slides = outlineArg(str(args, 'outline')!);
      const w = await workspaceArg(ctx, str(args, 'workspace'));
      const deck = await call<PresentationSummary>(ctx, 'POST', `/workspaces/${w.id}/presentations`, {
        title: str(args, 'title'),
        folderId: str(args, 'folderId') ?? null,
      });
      await editDeck(ctx.userId, deck.id, (doc) => void addOutlineSlides(doc, slides));
      return `Created "${deck.title}" (id ${deck.id}) with ${slides.length} slide${slides.length === 1 ? '' : 's'}.\nLink: ${ctx.origin}/w/${w.id}/sl/${deck.id}`;
    },
  },
  {
    name: 'update_presentation',
    title: 'Update a presentation',
    description:
      "Changes a presentation's title, or adds or replaces slides from a markdown outline (see create_presentation for the format). mode \"append\" (the default) adds them at the end; \"insert\" puts them before slide number `slide`; \"replace_slide\" replaces slide number `slide` with them; \"replace_all\" replaces every slide. Someone editing it at the time sees the change live.",
    params: {
      presentation: { type: 'string', description: 'Presentation id, or its exact title', required: true },
      title: { type: 'string', description: 'A new title' },
      outline: { type: 'string', description: 'Slides to write, as a markdown outline' },
      mode: {
        type: 'string',
        description: 'How the outline is applied. Default append.',
        enum: ['append', 'insert', 'replace_slide', 'replace_all'],
      },
      slide: { type: 'integer', description: 'Slide number, counted from 1, for insert and replace_slide' },
      workspace: WORKSPACE,
    },
    writes: true,
    async run(ctx, args) {
      const id = await titledArg(ctx, 'presentations', str(args, 'presentation')!, str(args, 'workspace'));
      const outline = str(args, 'outline');
      const title = str(args, 'title');
      if (outline === undefined && title === undefined) throw new ToolError('Give a title or an outline to write');
      const mode = str(args, 'mode') ?? 'append';
      const at = num(args, 'slide');
      if ((mode === 'insert' || mode === 'replace_slide') && (at === undefined || at < 1)) {
        throw new ToolError(`${mode} needs slide, the number of a slide counted from 1`);
      }
      const slides = outline === undefined ? [] : outlineArg(outline);

      // Checked as the person, so a deck they may only view is refused before anything changes.
      const current = await call<PresentationSummary>(ctx, 'GET', `/presentations/${id}`);
      if (current.permission !== 'edit') throw new ToolError('You can view this presentation but not change it');
      if (title !== undefined) await call(ctx, 'PATCH', `/presentations/${id}`, { title });
      if (outline === undefined) return `Retitled presentation ${id}.`;

      let replaced = 0;
      await editDeck(ctx.userId, id, (doc) => {
        const order = readSlideOrder(doc);
        if ((mode === 'insert' || mode === 'replace_slide') && at! > order.length + (mode === 'insert' ? 1 : 0)) {
          throw new ToolError(`The deck has ${order.length} slide${order.length === 1 ? '' : 's'}`);
        }
        if (mode === 'replace_all') {
          for (const slideId of order) deleteSlide(doc, slideId);
          replaced = order.length;
          addOutlineSlides(doc, slides);
        } else if (mode === 'replace_slide') {
          deleteSlide(doc, order[at! - 1]);
          replaced = 1;
          addOutlineSlides(doc, slides, at! - 1);
        } else {
          addOutlineSlides(doc, slides, mode === 'insert' ? at! - 1 : undefined);
        }
      });
      return `Updated presentation ${id}: wrote ${slides.length} slide${slides.length === 1 ? '' : 's'}${replaced ? `, replacing ${replaced}` : ''}.`;
    },
  },

  // --- projects and queues -----------------------------------------------------
  {
    name: 'list_projects',
    title: 'List projects',
    description: 'Project boards and queues in a workspace, with their keys. Work item keys start with them (ENG-12).',
    params: { workspace: WORKSPACE },
    writes: false,
    async run(ctx, args) {
      const out: string[] = [];
      const list = await workspacesFor(ctx, str(args, 'workspace'), 'projects');
      for (const w of list) {
        const projects = await call<ProjectSummary[]>(ctx, 'GET', `/workspaces/${w.id}/projects`);
        const lines = projects.map(
          (p) => `- ${p.key}: ${p.name} (${p.kind}; id ${p.id})${p.description ? ` — ${p.description.slice(0, 160)}` : ''}`,
        );
        if (lines.length) out.push(list.length > 1 ? `## ${w.name}\n${lines.join('\n')}` : lines.join('\n'));
      }
      return out.length ? out.join('\n\n') : 'No projects.';
    },
  },
  {
    name: 'get_project',
    title: 'Get a project',
    description: "A project or queue's setup: its statuses in board order, item types, roles and sprints. Use the names these give when creating or moving work.",
    params: {
      project: { type: 'string', description: 'Project key (such as ENG), name or id', required: true },
      workspace: WORKSPACE,
    },
    writes: false,
    async run(ctx, args) {
      const p = await projectArg(ctx, str(args, 'project')!, str(args, 'workspace'));
      const sprints = p.sprints.filter((s) => s.state !== 'completed');
      return [
        `# ${p.key}: ${p.name} (${p.kind})`,
        p.description,
        `Link: ${ctx.origin}/w/${p.workspaceId}/p/${p.id}`,
        `Statuses, in order: ${p.statuses.map((s) => `${s.name} [${s.category}]`).join(', ')}`,
        `Types: ${p.itemTypes.map((t) => `${t.name}${t.epic ? ' (epic)' : ''}${t.id === p.defaultTypeId ? ' (default)' : ''}`).join(', ')}`,
        `Roles: ${p.roles.map((r) => `${r.name}${r.multiple ? ' (several)' : ''}${r.freeForm ? ' (any name)' : ''}${r.fillWithCreator ? ' (filled by creator)' : ''}${r.scheduleId ? ' (filled from a schedule)' : ''}`).join(', ')}`,
        p.responseTime ? `Response time: ${responseTimeSummary(p, p.responseTime)}` : '',
        p.sprintsEnabled
          ? `Sprints: ${sprints.map((s) => `${s.name} [${s.state}${s.endDate ? `, ends ${s.endDate}` : ''}]${s.goal ? ` — ${s.goal}` : ''}`).join('; ') || 'none planned'}`
          : '',
      ]
        .filter(Boolean)
        .join('\n');
    },
  },
  {
    name: 'list_work_items',
    title: 'List work items',
    description:
      "A project's or queue's current work, grouped by status in board order, with the epic each item is under. Finished work is left out unless includeDone is set.",
    params: {
      project: { type: 'string', description: 'Project key (such as ENG), name or id', required: true },
      status: { type: 'string', description: 'Only this status, by name' },
      type: { type: 'string', description: 'Only this type, by name' },
      epic: { type: 'string', description: 'Only work under this epic, by its key such as ENG-3' },
      assignee: { type: 'string', description: 'Only work this person holds any role on: "me", a name or an email' },
      query: { type: 'string', description: 'Only titles containing this' },
      includeDone: { type: 'boolean', description: 'Include finished work. Default false.' },
      limit: { type: 'integer', description: 'The most to list. Default 100.' },
      workspace: WORKSPACE,
    },
    writes: false,
    async run(ctx, args) {
      const p = await projectArg(ctx, str(args, 'project')!, str(args, 'workspace'));
      const [items, people] = await Promise.all([
        call<WorkItemSummary[]>(ctx, 'GET', `/projects/${p.id}/items`),
        members(ctx, p.workspaceId),
      ]);
      const status = str(args, 'status') ? statusArg(p, str(args, 'status')!) : null;
      const type = str(args, 'type') ? typeArg(p, str(args, 'type')!) : null;
      const person = str(args, 'assignee') ? memberArg(ctx, people, str(args, 'assignee')!) : null;
      if (str(args, 'assignee') && !person) throw new ToolError(`No member "${str(args, 'assignee')}"`);
      const epic = str(args, 'epic') ? await epicArg(ctx, str(args, 'epic')!, p.workspaceId) : null;
      if (epic && epic.projectId !== p.id) throw new ToolError(`${epic.key} is not in ${p.key}`);
      const q = str(args, 'query')?.toLowerCase();
      const done = new Set(p.statuses.filter((s) => s.category === 'done').map((s) => s.id));
      const limit = Math.max(num(args, 'limit') ?? 100, 1);

      const picked = items.filter(
        (i) =>
          (status ? i.statusId === status.id : bool(args, 'includeDone') || !done.has(i.statusId)) &&
          (!type || i.typeId === type.id) &&
          (!epic || i.epicId === epic.id) &&
          (!person || Object.values(i.roles).some((ids) => ids.includes(person.userId))) &&
          (!q || i.title.toLowerCase().includes(q)),
      );
      if (picked.length === 0) return 'No work items match.';
      const names = peopleMap(people);
      const epics = await epicKeys(picked.map((i) => i.epicId));
      const out: string[] = [];
      let listed = 0;
      for (const s of p.statuses) {
        const here = picked.filter((i) => i.statusId === s.id);
        if (here.length === 0 || listed >= limit) continue;
        const shown = here.slice(0, limit - listed);
        listed += shown.length;
        out.push(`## ${s.name} (${here.length})`, ...shown.map((i) => itemLine(i, p, names, epics)));
      }
      if (picked.length > listed) out.push(`…and ${picked.length - listed} more. Narrow it down or raise limit.`);
      return out.join('\n');
    },
  },
  {
    name: 'find_work_items',
    title: 'Find work items',
    description:
      'Work items across every project: your own with mine, those under an epic, or those matching a query by title, key or description. Open work comes first.',
    params: {
      query: { type: 'string', description: 'Words from the title or description, or a key' },
      mine: { type: 'boolean', description: 'Only work you hold a role on' },
      open: { type: 'boolean', description: 'Leave out finished work' },
      epic: { type: 'string', description: 'Only work under this epic, by its key such as ENG-3' },
      workspace: { ...WORKSPACE, description: 'Workspace name or id. Left out, every workspace is looked through.' },
    },
    writes: false,
    async run(ctx, args) {
      if (!str(args, 'query') && !bool(args, 'mine') && !str(args, 'epic')) throw new ToolError('Give a query or an epic, or set mine');
      const epic = str(args, 'epic') ? await epicArg(ctx, str(args, 'epic')!, str(args, 'workspace')) : null;
      const out: string[] = [];
      // An epic's work is all in the epic's own workspace.
      const list = epic
        ? [await workspaceArg(ctx, await workspaceOf(ctx, 'work_items', epic.id, 'Work item'))]
        : await workspacesFor(ctx, str(args, 'workspace'), 'projects');
      for (const w of list) {
        // The same key can be in two workspaces; said where each is, they can be told apart.
        const where = list.length > 1 ? ` (${w.name})` : '';
        const items = await call<WorkItemListing[]>(
          ctx,
          'GET',
          `/workspaces/${w.id}/work-items${qs({
            q: str(args, 'query'),
            mine: bool(args, 'mine'),
            open: bool(args, 'open'),
            epic: epic?.id,
            limit: 50,
          })}`,
        );
        const epics = await epicKeys(items.map((i) => i.epicId));
        out.push(
          ...items.map((i) => {
            const extra = [
              i.itemType.name,
              i.priority !== 'none' ? i.priority : '',
              i.epicId && epics.has(i.epicId) ? `epic ${epics.get(i.epicId)}` : '',
              i.myRoles.length ? `you: ${i.myRoles.join(', ')}` : '',
            ].filter(Boolean);
            return `- ${i.key}: ${i.title} [${i.status.name}] (${extra.join('; ')}) in ${i.project.name}${where}`;
          }),
        );
      }
      return out.length ? out.join('\n') : 'No work items match.';
    },
  },
  {
    name: 'get_work_item',
    title: 'Get a work item',
    description:
      'A work item in full: status, type, people, dates, the epic it is under, description, every comment, and when its queue escalated it for want of a response. For an epic, also all the work under it, finished and archived included.',
    params: {
      item: { type: 'string', description: 'The key, such as ENG-12, or the id', required: true },
      workspace: WORKSPACE,
    },
    writes: false,
    async run(ctx, args) {
      return describeItem(ctx, await itemIdArg(ctx, str(args, 'item')!, str(args, 'workspace')));
    },
  },
  {
    name: 'create_work_item',
    title: 'Create a work item',
    description:
      "Adds work to a project or queue. Type and status are by name, as get_project lists them; left out, the project's default type and first status are used. Whoever creates it fills the roles set to be filled by the creator, such as Reporter and Watcher.",
    params: {
      project: { type: 'string', description: 'Project key (such as ENG), name or id', required: true },
      title: { type: 'string', description: 'The title', required: true },
      description: { type: 'string', description: 'What the work is. Plain text.' },
      type: { type: 'string', description: 'Type name, such as Bug or Task' },
      status: { type: 'string', description: 'Status name' },
      priority: { type: 'string', description: 'Priority', enum: PRIORITIES },
      dueDate: { type: 'string', description: 'YYYY-MM-DD' },
      estimate: { type: 'integer', description: 'In whatever unit the team estimates in' },
      assignee: { type: 'string', description: '"me", a member\'s name or email' },
      epic: { type: 'string', description: 'Key of the epic to put it under' },
      workspace: WORKSPACE,
    },
    writes: true,
    async run(ctx, args) {
      const p = await projectArg(ctx, str(args, 'project')!, str(args, 'workspace'));
      const body: Record<string, unknown> = {
        title: str(args, 'title'),
        description: str(args, 'description') ?? '',
        priority: str(args, 'priority') ?? 'none',
      };
      if (str(args, 'type')) body.typeId = typeArg(p, str(args, 'type')!).id;
      if (str(args, 'status')) body.statusId = statusArg(p, str(args, 'status')!).id;
      if (str(args, 'dueDate')) body.dueDate = str(args, 'dueDate');
      if (num(args, 'estimate') !== undefined) body.estimate = num(args, 'estimate');
      if (str(args, 'epic')) body.epicId = await itemIdArg(ctx, str(args, 'epic')!, p.workspaceId);
      if (str(args, 'assignee')) {
        const { role, userIds, names } = holdersFor(ctx, p, await members(ctx, p.workspaceId), str(args, 'assignee')!);
        if (userIds.length) body.roles = { [role.id]: userIds };
        if (names.length) body.roleNames = { [role.id]: names };
      }
      const item = await call<WorkItem>(ctx, 'POST', `/projects/${p.id}/items`, body);
      return `Created ${item.key}: ${item.title}\nLink: ${itemUrl(ctx, p.workspaceId, item)}`;
    },
  },
  {
    name: 'update_work_item',
    title: 'Update a work item',
    description:
      'Changes a work item: move it to another status, retitle it, rewrite its description, reprioritise, reassign it, put it under another epic. Only what is given changes. Returns the item as it now is.',
    params: {
      item: { type: 'string', description: 'The key, such as ENG-12, or the id', required: true },
      status: { type: 'string', description: 'Status name to move it to' },
      title: { type: 'string', description: 'A new title' },
      description: { type: 'string', description: 'A new description, replacing the old. Plain text.' },
      type: { type: 'string', description: 'Type name' },
      priority: { type: 'string', description: 'Priority', enum: PRIORITIES },
      dueDate: { type: 'string', description: 'YYYY-MM-DD, or an empty string to clear it' },
      estimate: { type: 'integer', description: 'In whatever unit the team estimates in' },
      assignee: { type: 'string', description: '"me", a member\'s name or email, or an empty string to unassign' },
      epic: { type: 'string', description: 'Key of the epic to put it under, or an empty string to take it out of its epic' },
      workspace: WORKSPACE,
    },
    writes: true,
    async run(ctx, args) {
      const id = await itemIdArg(ctx, str(args, 'item')!, str(args, 'workspace'));
      const item = await call<WorkItem>(ctx, 'GET', `/work-items/${id}`);
      const p = await call<Project>(ctx, 'GET', `/projects/${item.projectId}`);
      const patch: Record<string, unknown> = {};
      if (str(args, 'status')) patch.statusId = statusArg(p, str(args, 'status')!).id;
      if (str(args, 'title')) patch.title = str(args, 'title');
      if (str(args, 'description') !== undefined) patch.description = str(args, 'description');
      if (str(args, 'type')) patch.typeId = typeArg(p, str(args, 'type')!).id;
      if (str(args, 'priority')) patch.priority = str(args, 'priority');
      if (str(args, 'dueDate') !== undefined) patch.dueDate = str(args, 'dueDate') || null;
      if (num(args, 'estimate') !== undefined) patch.estimate = num(args, 'estimate');
      const epic = str(args, 'epic');
      if (epic !== undefined) patch.epicId = epic.trim() ? (await epicArg(ctx, epic, p.workspaceId)).id : null;
      const assignee = str(args, 'assignee');
      if (Object.keys(patch).length === 0 && assignee === undefined) throw new ToolError('Nothing to change');

      if (Object.keys(patch).length) await call(ctx, 'PATCH', `/work-items/${id}`, patch);
      if (assignee !== undefined) {
        const { role, userIds, names } = holdersFor(ctx, p, await members(ctx, p.workspaceId), assignee);
        await call(ctx, 'PUT', `/work-items/${id}/roles/${role.id}`, { userIds, names });
      }
      return describeItem(ctx, id);
    },
  },
  {
    name: 'comment_on_work_item',
    title: 'Comment on a work item',
    description: "Adds a comment to a work item's history, as you. Good for saying what was done and where.",
    params: {
      item: { type: 'string', description: 'The key, such as ENG-12, or the id', required: true },
      body: { type: 'string', description: 'The comment. Plain text.', required: true },
      workspace: WORKSPACE,
    },
    writes: true,
    async run(ctx, args) {
      const id = await itemIdArg(ctx, str(args, 'item')!, str(args, 'workspace'));
      await call(ctx, 'POST', `/work-items/${id}/comments`, { body: str(args, 'body') });
      return 'Comment added.';
    },
  },

  // --- chat --------------------------------------------------------------------
  {
    name: 'list_channels',
    title: 'List channels',
    description: 'Chat channels in a workspace, with their topics and how many messages you have not read.',
    params: { workspace: WORKSPACE },
    writes: false,
    async run(ctx, args) {
      const out: string[] = [];
      const list = await workspacesFor(ctx, str(args, 'workspace'), 'chat');
      for (const w of list) {
        const channels = await call<Channel[]>(ctx, 'GET', `/workspaces/${w.id}/channels`);
        const lines = channels.map(
          (c) => `- #${c.name} (${c.kind}; id ${c.id}${c.unread ? `; ${c.unread} unread` : ''})${c.topic ? ` — ${c.topic}` : ''}`,
        );
        if (lines.length) out.push(list.length > 1 ? `## ${w.name}\n${lines.join('\n')}` : lines.join('\n'));
      }
      return out.length ? out.join('\n\n') : 'No channels.';
    },
  },
  {
    name: 'read_channel',
    title: 'Read a channel',
    description: "A chat channel's latest messages, oldest first.",
    params: {
      channel: { type: 'string', description: 'Channel name or id', required: true },
      limit: { type: 'integer', description: 'How many messages, up to 100. Default 30.' },
      workspace: WORKSPACE,
    },
    writes: false,
    async run(ctx, args) {
      const channel = await channelArg(ctx, str(args, 'channel')!, str(args, 'workspace'));
      const limit = Math.min(Math.max(num(args, 'limit') ?? 30, 1), 100);
      const page = await call<{ messages: Message[]; references: MessageReferences }>(
        ctx,
        'GET',
        `/channels/${channel.id}/messages${qs({ limit })}`,
      );
      const lines = page.messages
        .filter((m) => !m.deletedAt)
        .map((m) => {
          const files = m.attachments.length ? ` [${m.attachments.map((a) => a.filename).join(', ')}]` : '';
          return `- ${m.author?.name ?? 'Someone'}, ${m.createdAt.slice(0, 16).replace('T', ' ')}: ${readable(m.body, page.references)}${files}`;
        });
      return lines.length ? `#${channel.name}\n${lines.join('\n')}` : `#${channel.name} has no messages.`;
    },
  },
  {
    name: 'post_message',
    title: 'Post a message',
    description: 'Posts a message to a chat channel, as you.',
    params: {
      channel: { type: 'string', description: 'Channel name or id', required: true },
      text: { type: 'string', description: 'The message', required: true },
      workspace: WORKSPACE,
    },
    writes: true,
    async run(ctx, args) {
      const channel = await channelArg(ctx, str(args, 'channel')!, str(args, 'workspace'));
      await call(ctx, 'POST', `/channels/${channel.id}/messages`, { body: str(args, 'text') });
      return `Posted to #${channel.name}.`;
    },
  },

  // --- schedules -----------------------------------------------------------------
  {
    name: 'list_schedules',
    title: 'List schedules',
    description: 'On-call rotations, shift patterns and work schedules in a workspace, and whether you are on each.',
    params: { workspace: WORKSPACE },
    writes: false,
    async run(ctx, args) {
      const out: string[] = [];
      const list = await workspacesFor(ctx, str(args, 'workspace'), 'schedules');
      for (const w of list) {
        const schedules = await call<ScheduleSummary[]>(ctx, 'GET', `/workspaces/${w.id}/schedules`);
        const lines = schedules.map(
          (s) =>
            `- ${s.name} (id ${s.id}; ${s.timeZone}; ${s.memberCount} people${s.isMember ? '; you are on it' : ''}${s.isManager ? ', as a manager' : ''})${s.description ? ` — ${s.description.slice(0, 160)}` : ''}`,
        );
        if (lines.length) out.push(list.length > 1 ? `## ${w.name}\n${lines.join('\n')}` : lines.join('\n'));
      }
      return out.length ? out.join('\n\n') : 'No schedules.';
    },
  },
  {
    name: 'who_is_on',
    title: 'Who is on',
    description: 'Who is on a schedule now, or at a given time, and until when, overall and on each of its layers.',
    params: {
      schedule: { type: 'string', description: 'Schedule name or id', required: true },
      at: { type: 'string', description: "A date and time, in the schedule's zone unless it says otherwise. Now, when left out." },
      workspace: WORKSPACE,
    },
    writes: false,
    async run(ctx, args) {
      const schedule = await scheduleArg(ctx, str(args, 'schedule')!, str(args, 'workspace'));
      const at = timeArg(str(args, 'at'), schedule.timeZone, 'at');
      const from = at.toUTC().toISO()!;
      const to = at.plus({ minutes: 1 }).toUTC().toISO()!;
      const result = await call<ScheduleShifts>(ctx, 'GET', `/schedules/${schedule.id}/shifts${qs({ from, to })}`);
      const names = await memberNames(ctx, schedule.workspaceId);
      const t = at.toMillis();
      const running = (list: ScheduleShifts['shifts']) => list.filter((x) => Date.parse(x.start) <= t && Date.parse(x.end) > t);
      const person = (id: string | null | undefined) => (id ? (names.get(id) ?? 'a former member') : '');
      const describe = (shift: ScheduleShifts['shifts'][number]) =>
        `${person(shift.userId)}${shift.overriddenFrom ? ` (covering for ${person(shift.overriddenFrom)})` : ''}${shift.label ? ` · ${shift.label}` : ''}, until ${zoned(shift.end, schedule.timeZone)}`;
      const on = running(result.shifts);
      const lines = [
        `${schedule.name}, at ${zoned(from, schedule.timeZone)} (${schedule.timeZone}):`,
        on.length ? on.map((s) => `- ${describe(s)}`).join('\n') : '- Nobody is on.',
      ];
      if (result.layers.length > 1) {
        lines.push('By layer:');
        for (const layer of result.layers) {
          const here = running(layer.shifts);
          lines.push(`- ${layer.name}: ${here.length ? here.map((s) => person(s.userId)).join(', ') : 'nobody'}`);
        }
      }
      lines.push(`${ctx.origin}/w/${schedule.workspaceId}/sc/${schedule.id}`);
      return lines.join('\n');
    },
  },
  {
    name: 'my_shifts',
    title: 'My shifts',
    description: 'Your own shifts across every schedule, from now for two weeks unless a range is given.',
    params: {
      from: { type: 'string', description: 'Start, as an ISO date and time. Now, when left out.' },
      to: { type: 'string', description: 'End, as an ISO date and time. Up to 100 days after the start.' },
      workspace: WORKSPACE,
    },
    writes: false,
    async run(ctx, args) {
      const from = timeArg(str(args, 'from'), 'UTC', 'from');
      const to = str(args, 'to') ? timeArg(str(args, 'to'), 'UTC', 'to') : from.plus({ days: 14 });
      const out: string[] = [];
      const list = await workspacesFor(ctx, str(args, 'workspace'), 'schedules');
      for (const w of list) {
        const mine = await call<{ shifts: MyShift[] }>(
          ctx,
          'GET',
          `/workspaces/${w.id}/my-shifts${qs({ from: from.toUTC().toISO()!, to: to.toUTC().toISO()! })}`,
        );
        const lines = mine.shifts.map(
          (s) =>
            `- ${s.scheduleName}: ${zoned(s.start, s.timeZone)} to ${zoned(s.end, s.timeZone)} (${s.timeZone})${s.label ? ` · ${s.label}` : ''}${s.overriddenFrom ? ' (covering)' : ''} [schedule id ${s.scheduleId}; start ${s.start}; end ${s.end}]`,
        );
        if (lines.length) out.push(list.length > 1 ? `## ${w.name}\n${lines.join('\n')}` : lines.join('\n'));
      }
      return out.length ? out.join('\n\n') : 'No shifts in that time.';
    },
  },
  {
    name: 'request_replacement',
    title: 'Request a replacement',
    description:
      'Asks others on the same schedule to cover one of your shifts, or part of it, or to swap it. Only people on that schedule can be asked. my_shifts gives the start and end of your shifts.',
    params: {
      schedule: { type: 'string', description: 'Schedule name or id', required: true },
      start: { type: 'string', description: "Start of the time to cover, in the schedule's zone unless it says otherwise", required: true },
      end: { type: 'string', description: 'End of the time to cover', required: true },
      kind: { type: 'string', description: 'cover (someone takes it) or swap (you take one of theirs). Default cover.', enum: ['cover', 'swap'] },
      people: { type: 'string', description: 'Names of people on the schedule to ask, comma-separated. Everyone on it, when left out.' },
      note: { type: 'string', description: 'Why, for the people asked' },
      workspace: WORKSPACE,
    },
    writes: true,
    async run(ctx, args) {
      const schedule = await scheduleArg(ctx, str(args, 'schedule')!, str(args, 'workspace'));
      const start = timeArg(str(args, 'start'), schedule.timeZone, 'start');
      const end = timeArg(str(args, 'end'), schedule.timeZone, 'end');
      const asked = (str(args, 'people') ?? '')
        .split(',')
        .map((n) => n.trim().toLowerCase())
        .filter(Boolean);
      const askUserIds = asked.map((name) => {
        const member = schedule.members.find((m) => m.name.toLowerCase() === name);
        if (!member) {
          throw new ToolError(
            `"${name}" is not on ${schedule.name}, and only people on it can be asked. On it: ${schedule.members.map((m) => m.name).join(', ')}.`,
          );
        }
        return member.userId;
      });
      const request = await call<ScheduleRequest>(ctx, 'POST', `/schedules/${schedule.id}/requests`, {
        kind: str(args, 'kind') ?? 'cover',
        startsAt: start.toUTC().toISO(),
        endsAt: end.toUTC().toISO(),
        note: str(args, 'note'),
        askUserIds: askUserIds.length ? askUserIds : undefined,
      });
      const who = request.askEveryone ? `everyone on ${schedule.name}` : request.candidates.map((c) => c.name).join(', ');
      return `Asked ${who} to ${request.kind === 'swap' ? 'swap' : 'cover'} ${zoned(request.startsAt, schedule.timeZone)} to ${zoned(request.endsAt, schedule.timeZone)} (${schedule.timeZone}). ${ctx.origin}/w/${schedule.workspaceId}/sc/${schedule.id}`;
    },
  },
];

/** The tools a connection is offered: all of them, or those that only read. */
export function toolsFor(ai: AiCaller): Tool[] {
  return TOOLS.filter((t) => ai.canWrite || !t.writes);
}

export function describeTool(tool: Tool) {
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: inputSchema(tool.params),
    annotations: {
      title: tool.title,
      readOnlyHint: !tool.writes,
      destructiveHint: false,
      openWorldHint: false,
    },
  };
}

export async function runTool(ctx: ToolContext, name: string, raw: unknown): Promise<string> {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) throw new ToolError(`There is no tool called ${name}`);
  if (tool.writes && !ctx.ai.canWrite) throw new ToolError('This connection can only read. Its owner can make one that can write.');
  return tool.run(ctx, readArgs(tool.params, raw));
}

// --- prompts ------------------------------------------------------------------

/**
 * Starting points a client can offer as commands. Claude Code shows them as
 * slash commands, so `/mcp__paradocs__work_on_item ENG-12` pulls an item off
 * the board into a coding session.
 */
export const PROMPTS = [
  {
    name: 'work_on_item',
    title: 'Work on a ParaDOCs item',
    description: 'Pull a work item off a ParaDOCs board and work on it here, keeping the board up to date.',
    arguments: [
      { name: 'item', description: 'The key, such as ENG-12', required: true },
      { name: 'workspace', description: 'Workspace name, when the key is used in more than one', required: false },
    ],
  },
  {
    name: 'next_up',
    title: "What's next on a board",
    description: "Look over a project's open work and suggest what to pick up next.",
    arguments: [
      { name: 'project', description: 'Project key, such as ENG', required: true },
      { name: 'workspace', description: 'Workspace name, when the key is used in more than one', required: false },
    ],
  },
];

export async function getPrompt(ctx: ToolContext, name: string, args: Record<string, string>) {
  if (name === 'work_on_item') {
    if (!args.item) throw new ToolError('item is required');
    const id = await itemIdArg(ctx, args.item, args.workspace || undefined);
    const item = await describeItem(ctx, id);
    const steps = ctx.ai.canWrite
      ? [
          'Work on it here:',
          '1. Read the item and any documents it points at. Ask me about anything unclear before starting.',
          '2. Use update_work_item to assign it to "me" and move it to the project\'s in-progress status.',
          '3. Do the work.',
          '4. When it is done, use comment_on_work_item to say what changed and where (files, branch, PR), and move it to review or done as the project\'s statuses suggest.',
        ]
      : ['Work on it here. This connection can only read, so tell me when to update the board myself.'];
    return {
      description: `Work on ${args.item.toUpperCase()}`,
      messages: [{ role: 'user', content: { type: 'text', text: `${item}\n\n${steps.join('\n')}` } }],
    };
  }
  if (name === 'next_up') {
    if (!args.project) throw new ToolError('project is required');
    const board = await runTool(ctx, 'list_work_items', {
      project: args.project,
      limit: 60,
      ...(args.workspace ? { workspace: args.workspace } : {}),
    });
    return {
      description: `What's next in ${args.project.toUpperCase()}`,
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `Here is the open work in ${args.project.toUpperCase()}:\n\n${board}\n\nSuggest the three items most worth picking up next and why, weighing priority, due dates, what is blocked and what is already in progress. Use get_work_item for detail on any you need.`,
          },
        },
      ],
    };
  }
  throw new ToolError(`There is no prompt called ${name}`);
}
