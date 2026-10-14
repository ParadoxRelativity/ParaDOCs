/**
 * Templates: how a project is set up, without its work, to start another
 * from. A template holds the statuses, roles, workflows, types, board layout,
 * rules and switches; not the work, sprints or who can reach the project.
 *
 * Everything in a template refers to the rest by a local key ("s1", "r2"), not
 * by id, since the ids are the project's own; making a project from one gives
 * every part a new id and points each reference at it. Every project is made
 * from one: with none chosen, the built-in Basic project or Basic queue,
 * which are how projects and queues have always started.
 */

import { z } from 'zod';
import type { RuleAction } from './projectRules.js';
import {
  DEFAULT_ARCHIVE_DAYS,
  MAX_ARCHIVE_DAYS,
  STANDARD_ITEM_TYPES,
  WORK_ITEM_PRIORITIES,
  type Project,
  type ProjectKind,
  type StatusCategory,
  type WorkItemPriority,
} from './projects.js';

export const TEMPLATE_VERSION = 1;

/** A rule action with roles named by key. A member stays an id: it is a person, not part of the setup. */
export type TemplateRuleAction = RuleAction;

export interface ProjectTemplateConfig {
  version: typeof TEMPLATE_VERSION;
  kind: ProjectKind;
  /** In board order. */
  statuses: { key: string; name: string; category: StatusCategory; color: string }[];
  roles: { key: string; name: string; multiple: boolean; freeForm: boolean; fillWithCreator: boolean }[];
  /** `transitions` by status key, as a workflow's are by status id. */
  workflows: { key: string; name: string; transitions: Record<string, string[]> }[];
  itemTypes: { key: string; name: string; icon: string; color: string; epic: boolean; workflow: string | null; roles: string[] }[];
  /** The key of the type new work starts as. */
  defaultType: string;
  /** Cells name statuses by key. Empty: one lane per status. */
  boardLayout: { lanes: { cells: { statusIds: string[]; name: string | null }[] }[] };
  sprintsEnabled: boolean;
  archiveAfterDays: number | null;
  askStatusComment: boolean;
  /** `status` and `types` by key; actions name roles by key. */
  rules: { name: string; enabled: boolean; status: string; types: string[] | null; actions: TemplateRuleAction[] }[];
}

const key = z.string().min(1).max(64);
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const templateSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('member'), userId: z.string().uuid() }),
  z.object({ kind: z.literal('mover') }),
  z.object({ kind: z.literal('role'), roleId: key }),
]);
const templateActionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('role'), roleId: key, op: z.enum(['set', 'add', 'clear']), source: templateSourceSchema.optional() }),
  z.object({ kind: z.literal('priority'), priority: z.enum(WORK_ITEM_PRIORITIES as [WorkItemPriority, ...WorkItemPriority[]]) }),
]);

export const projectTemplateConfigSchema = z
  .object({
    version: z.literal(TEMPLATE_VERSION),
    kind: z.enum(['project', 'queue']),
    statuses: z
      .array(z.object({ key, name: z.string().trim().min(1).max(40), category: z.enum(['backlog', 'todo', 'active', 'done']), color }))
      .min(1)
      .max(50),
    roles: z
      .array(
        z.object({ key, name: z.string().trim().min(1).max(40), multiple: z.boolean(), freeForm: z.boolean(), fillWithCreator: z.boolean() }),
      )
      .max(50),
    workflows: z.array(z.object({ key, name: z.string().trim().min(1).max(60), transitions: z.record(key, z.array(key).max(50)) })).max(50),
    itemTypes: z
      .array(
        z.object({
          key,
          name: z.string().trim().min(1).max(40),
          icon: z.string().max(40),
          color,
          epic: z.boolean(),
          workflow: key.nullable(),
          roles: z.array(key).max(50),
        }),
      )
      .min(1)
      .max(50),
    defaultType: key,
    boardLayout: z.object({
      lanes: z.array(z.object({ cells: z.array(z.object({ statusIds: z.array(key).min(1).max(20), name: z.string().max(40).nullable() })).min(1).max(20) })).max(50),
    }),
    sprintsEnabled: z.boolean(),
    archiveAfterDays: z.number().int().min(1).max(MAX_ARCHIVE_DAYS).nullable(),
    askStatusComment: z.boolean(),
    rules: z
      .array(z.object({ name: z.string().trim().min(1).max(80), enabled: z.boolean(), status: key, types: z.array(key).nullable(), actions: z.array(templateActionSchema).max(10) }))
      .max(50),
  })
  .superRefine((config, ctx) => {
    // Every key a part names must be one the template has.
    const statuses = new Set(config.statuses.map((s) => s.key));
    const roles = new Set(config.roles.map((r) => r.key));
    const workflows = new Set(config.workflows.map((w) => w.key));
    const types = new Set(config.itemTypes.map((t) => t.key));
    const fail = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    if (!config.itemTypes.some((t) => t.key === config.defaultType && !t.epic)) fail('The default type must be one of its types, and not an epic');
    for (const w of config.workflows) {
      for (const [from, tos] of Object.entries(w.transitions)) if (!statuses.has(from) || tos.some((to) => !statuses.has(to))) fail('A workflow names a status the template does not have');
    }
    for (const t of config.itemTypes) {
      if (t.workflow !== null && !workflows.has(t.workflow)) fail('A type follows a workflow the template does not have');
      if (t.roles.some((r) => !roles.has(r))) fail('A type offers a role the template does not have');
    }
    for (const lane of config.boardLayout.lanes) for (const cell of lane.cells) if (cell.statusIds.some((s) => !statuses.has(s))) fail('The board names a status the template does not have');
    for (const rule of config.rules) {
      if (!statuses.has(rule.status) || rule.types?.some((t) => !types.has(t))) fail('A rule names a status or type the template does not have');
      for (const a of rule.actions) {
        if (a.kind === 'role' && (!roles.has(a.roleId) || (a.source?.kind === 'role' && !roles.has(a.source.roleId)))) fail('A rule names a role the template does not have');
      }
    }
  });

/** A template as the picker lists it. A built-in's id is `builtin:<name>`; a saved one's is its uuid. */
export interface ProjectTemplateSummary {
  id: string;
  name: string;
  description: string;
  kind: ProjectKind;
  builtIn: boolean;
  createdBy: string | null;
  createdAt: string | null;
  /** Whether the reader may rename or delete it: its maker, an owner or an admin. Never for a built-in. */
  canManage: boolean;
}

export const saveTemplateSchema = z.object({
  name: z.string().trim().min(1, 'Name the template').max(80),
  description: z.string().trim().max(500).default(''),
});

export const updateTemplateSchema = z.object({
  name: z.string().trim().min(1, 'Name the template').max(80).optional(),
  description: z.string().trim().max(500).optional(),
});

/** A project's setup as a template: every id replaced by a key, and its work left behind. */
export function templateFromProject(project: Project): ProjectTemplateConfig {
  const keyOf = new Map<string, string>();
  project.statuses.forEach((s, i) => keyOf.set(s.id, `s${i + 1}`));
  project.roles.forEach((r, i) => keyOf.set(r.id, `r${i + 1}`));
  project.workflows.forEach((w, i) => keyOf.set(w.id, `w${i + 1}`));
  project.itemTypes.forEach((t, i) => keyOf.set(t.id, `t${i + 1}`));
  const k = (id: string) => keyOf.get(id)!;
  const known = (id: string) => keyOf.has(id);

  return {
    version: TEMPLATE_VERSION,
    kind: project.kind,
    statuses: project.statuses.map((s) => ({ key: k(s.id), name: s.name, category: s.category, color: s.color })),
    roles: project.roles.map((r) => ({ key: k(r.id), name: r.name, multiple: r.multiple, freeForm: r.freeForm, fillWithCreator: r.fillWithCreator })),
    workflows: project.workflows.map((w) => ({
      key: k(w.id),
      name: w.name,
      transitions: Object.fromEntries(
        Object.entries(w.transitions)
          .filter(([from]) => known(from))
          .map(([from, tos]) => [k(from), tos.filter(known).map(k)]),
      ),
    })),
    itemTypes: project.itemTypes.map((t) => ({
      key: k(t.id),
      name: t.name,
      icon: t.icon,
      color: t.color,
      epic: t.epic,
      workflow: t.workflowId && known(t.workflowId) ? k(t.workflowId) : null,
      roles: t.roleIds.filter(known).map(k),
    })),
    defaultType: k(project.defaultTypeId),
    boardLayout: {
      lanes: project.boardLayout.lanes
        .map((lane) => ({
          cells: lane.cells
            .map((cell) => ({ statusIds: cell.statusIds.filter(known).map(k), name: cell.name }))
            .filter((cell) => cell.statusIds.length > 0),
        }))
        .filter((lane) => lane.cells.length > 0),
    },
    sprintsEnabled: project.sprintsEnabled,
    archiveAfterDays: project.archiveAfterDays,
    askStatusComment: project.askStatusComment,
    rules: project.rules
      .filter((rule) => known(rule.statusId))
      .map((rule) => ({
        name: rule.name,
        enabled: rule.enabled,
        status: k(rule.statusId),
        types: rule.typeIds ? rule.typeIds.filter(known).map(k) : null,
        actions: rule.actions.map((a) =>
          a.kind === 'priority' ? a : { ...a, roleId: k(a.roleId), source: a.source?.kind === 'role' ? { kind: 'role', roleId: k(a.source.roleId) } : a.source },
        ),
      })),
  };
}

// --- built-in templates ----------------------------------------------------------

const STANDARD_TYPES = (roles: string[]) =>
  STANDARD_ITEM_TYPES.map((t) => ({ key: t.key, name: t.name, icon: t.icon, color: t.color, epic: t.epic, workflow: null, roles }));

const PROJECT_ROLES: ProjectTemplateConfig['roles'] = [
  { key: 'assignee', name: 'Assignee', multiple: false, freeForm: false, fillWithCreator: false },
  { key: 'reviewer', name: 'Reviewer', multiple: true, freeForm: false, fillWithCreator: false },
  { key: 'reporter', name: 'Reporter', multiple: false, freeForm: false, fillWithCreator: true },
  { key: 'watcher', name: 'Watcher', multiple: true, freeForm: false, fillWithCreator: true },
];

const QUEUE_ROLES: ProjectTemplateConfig['roles'] = [
  { key: 'assignee', name: 'Assignee', multiple: false, freeForm: false, fillWithCreator: false },
  // Whoever asked is often a customer rather than a colleague, so the name can
  // be typed in when there is no account to point at.
  { key: 'requester', name: 'Requester', multiple: false, freeForm: true, fillWithCreator: true },
  { key: 'watcher', name: 'Watcher', multiple: true, freeForm: false, fillWithCreator: true },
];

const base = (
  kind: ProjectKind,
): Pick<ProjectTemplateConfig, 'version' | 'kind' | 'workflows' | 'boardLayout' | 'sprintsEnabled' | 'archiveAfterDays' | 'askStatusComment' | 'rules'> => ({
  version: TEMPLATE_VERSION,
  kind,
  workflows: [],
  boardLayout: { lanes: [] },
  sprintsEnabled: false,
  archiveAfterDays: DEFAULT_ARCHIVE_DAYS[kind],
  askStatusComment: false,
  rules: [],
});

export const BUILT_IN_TEMPLATES: { id: string; name: string; description: string; config: ProjectTemplateConfig }[] = [
  {
    id: 'builtin:basic-project',
    name: 'Basic project',
    description: 'A backlog, a board from To do to Done, and the standard types and roles.',
    config: {
      ...base('project'),
      // New work lands in the backlog, and goes on the board once someone plans it.
      statuses: [
        { key: 'backlog', name: 'Backlog', category: 'backlog', color: '#8f8f9c' },
        { key: 'todo', name: 'To do', category: 'todo', color: '#6366f1' },
        { key: 'doing', name: 'In progress', category: 'active', color: '#0ea5e9' },
        { key: 'review', name: 'In review', category: 'active', color: '#8b5cf6' },
        { key: 'done', name: 'Done', category: 'done', color: '#10b981' },
      ],
      roles: PROJECT_ROLES,
      itemTypes: STANDARD_TYPES(PROJECT_ROLES.map((r) => r.key)),
      defaultType: 'task',
    },
  },
  {
    id: 'builtin:kanban',
    name: 'Kanban',
    description: 'Continuous flow: a backlog, then Ready, Doing, Review and Done, with no sprints.',
    config: {
      ...base('project'),
      statuses: [
        { key: 'backlog', name: 'Backlog', category: 'backlog', color: '#8f8f9c' },
        { key: 'ready', name: 'Ready', category: 'todo', color: '#6366f1' },
        { key: 'doing', name: 'Doing', category: 'active', color: '#0ea5e9' },
        { key: 'review', name: 'Review', category: 'active', color: '#8b5cf6' },
        { key: 'done', name: 'Done', category: 'done', color: '#10b981' },
      ],
      roles: PROJECT_ROLES,
      itemTypes: STANDARD_TYPES(PROJECT_ROLES.map((r) => r.key)),
      defaultType: 'task',
      rules: [
        {
          name: 'Whoever starts it takes it',
          enabled: true,
          status: 'doing',
          types: null,
          actions: [{ kind: 'role', roleId: 'assignee', op: 'set', source: { kind: 'mover' } }],
        },
      ],
    },
  },
  {
    id: 'builtin:scrum',
    name: 'Scrum',
    description: 'Sprints on: plan work into a sprint from the backlog, then run it on the board.',
    config: {
      ...base('project'),
      statuses: [
        { key: 'backlog', name: 'Backlog', category: 'backlog', color: '#8f8f9c' },
        { key: 'todo', name: 'To do', category: 'todo', color: '#6366f1' },
        { key: 'doing', name: 'In progress', category: 'active', color: '#0ea5e9' },
        { key: 'review', name: 'In review', category: 'active', color: '#8b5cf6' },
        { key: 'done', name: 'Done', category: 'done', color: '#10b981' },
      ],
      roles: PROJECT_ROLES,
      itemTypes: STANDARD_TYPES(PROJECT_ROLES.map((r) => r.key)),
      defaultType: 'story',
      sprintsEnabled: true,
    },
  },
  {
    id: 'builtin:basic-queue',
    name: 'Basic queue',
    description: 'Requests worked through oldest first: Open, In progress, Waiting and Resolved.',
    config: {
      ...base('queue'),
      statuses: [
        { key: 'open', name: 'Open', category: 'todo', color: '#f59e0b' },
        { key: 'doing', name: 'In progress', category: 'active', color: '#0ea5e9' },
        { key: 'waiting', name: 'Waiting', category: 'active', color: '#8f8f9c' },
        { key: 'resolved', name: 'Resolved', category: 'done', color: '#10b981' },
      ],
      roles: QUEUE_ROLES,
      itemTypes: STANDARD_TYPES(QUEUE_ROLES.map((r) => r.key)),
      defaultType: 'request',
    },
  },
  {
    id: 'builtin:service-desk',
    name: 'Service desk',
    description: 'Triage, then work and wait on the customer. Whoever picks a request up takes it, and moves ask why.',
    config: {
      ...base('queue'),
      statuses: [
        { key: 'new', name: 'New', category: 'todo', color: '#f59e0b' },
        { key: 'doing', name: 'In progress', category: 'active', color: '#0ea5e9' },
        { key: 'customer', name: 'Waiting on customer', category: 'active', color: '#8f8f9c' },
        { key: 'resolved', name: 'Resolved', category: 'done', color: '#10b981' },
        { key: 'closed', name: 'Closed', category: 'done', color: '#64748b' },
      ],
      roles: QUEUE_ROLES,
      itemTypes: STANDARD_TYPES(QUEUE_ROLES.map((r) => r.key)),
      defaultType: 'request',
      askStatusComment: true,
      rules: [
        {
          name: 'Whoever picks it up takes it',
          enabled: true,
          status: 'doing',
          types: null,
          actions: [{ kind: 'role', roleId: 'assignee', op: 'set', source: { kind: 'mover' } }],
        },
      ],
    },
  },
];

/** The built-in a project or queue starts from when none is chosen. */
export function defaultTemplateId(kind: ProjectKind): string {
  return kind === 'queue' ? 'builtin:basic-queue' : 'builtin:basic-project';
}
