/**
 * Rules: what a project fills in when work reaches a status. "When work enters
 * In review, set Assignee to whoever is Reviewer" hands the work over without
 * anyone remembering to.
 *
 * A rule is triggered by a move into its status, for every type or only some.
 * Its actions set, add to or clear a role, or set the priority. Rules run on
 * the server as part of the move, whoever made it and however — the board, a
 * bulk move, the API or an AI connection — in their order, a later one
 * overriding an earlier one on the same field. What they change does not set
 * off other rules, and creating an item sets off none.
 *
 * `applyRules` works out what changes; the server writes it and its history.
 */

import { z } from 'zod';
import { MAX_ROLE_HOLDERS, WORK_ITEM_PRIORITIES, type WorkItemPriority, type WorkItemSummary } from './projects.js';

/** Who a role action puts in the role. */
export type RuleSource =
  /** A member, by id. */
  | { kind: 'member'; userId: string }
  /** Whoever made the move. */
  | { kind: 'mover' }
  /** Whoever holds another role on the item, such as its reviewer. */
  | { kind: 'role'; roleId: string };

export type RuleAction =
  /** `set` replaces whoever holds the role, `add` joins them, `clear` empties it and takes no source. */
  | { kind: 'role'; roleId: string; op: 'set' | 'add' | 'clear'; source?: RuleSource }
  | { kind: 'priority'; priority: WorkItemPriority };

export interface ProjectRule {
  id: string;
  name: string;
  enabled: boolean;
  position: number;
  /** The status whose arrival sets it off. */
  statusId: string;
  /** The types it is for. Null: every type. */
  typeIds: string[] | null;
  actions: RuleAction[];
}

/** The most rules a project keeps, and actions a rule has. */
export const MAX_RULES = 50;
export const MAX_RULE_ACTIONS = 10;

const uuid = z.string().uuid();

const ruleSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('member'), userId: uuid }),
  z.object({ kind: z.literal('mover') }),
  z.object({ kind: z.literal('role'), roleId: uuid }),
]);

export const ruleActionSchema = z
  .discriminatedUnion('kind', [
    z.object({ kind: z.literal('role'), roleId: uuid, op: z.enum(['set', 'add', 'clear']), source: ruleSourceSchema.optional() }),
    z.object({ kind: z.literal('priority'), priority: z.enum(WORK_ITEM_PRIORITIES as [WorkItemPriority, ...WorkItemPriority[]]) }),
  ])
  .refine((action) => action.kind !== 'role' || action.op === 'clear' || action.source !== undefined, {
    message: 'Say who the role goes to',
  })
  .refine((action) => action.kind !== 'role' || action.source?.kind !== 'role' || action.source.roleId !== action.roleId, {
    message: 'A role cannot be filled from itself',
  });

export const createRuleSchema = z.object({
  name: z.string().trim().min(1, 'Name the rule').max(80),
  enabled: z.boolean().default(true),
  statusId: uuid,
  typeIds: z.array(uuid).min(1, 'Pick at least one type, or every type').max(50).nullable().default(null),
  actions: z.array(ruleActionSchema).min(1, 'Give the rule something to do').max(MAX_RULE_ACTIONS),
});

export const updateRuleSchema = z.object({
  name: z.string().trim().min(1, 'Name the rule').max(80).optional(),
  enabled: z.boolean().optional(),
  statusId: uuid.optional(),
  typeIds: z.array(uuid).min(1, 'Pick at least one type, or every type').max(50).nullable().optional(),
  actions: z.array(ruleActionSchema).min(1, 'Give the rule something to do').max(MAX_RULE_ACTIONS).optional(),
  position: z.number().finite().optional(),
});

/** One field a rule changed, and which rule, for the history. */
export type RuleChange =
  | { kind: 'role'; roleId: string; rule: string; userIds: string[]; names: string[] }
  | { kind: 'priority'; rule: string; priority: WorkItemPriority };

/**
 * What a project's rules change on an item moving into `toStatusId`. Rules run
 * in order on a working copy, so a later one overrides an earlier one, and one
 * copying a role reads it as the rules before it left it. Only what ends up
 * different from how the item was is returned, each with the last rule to
 * change it.
 *
 * An action is skipped when its role is not offered on the item's type, the
 * member it names has left (`members` holds who is in the workspace), or the
 * role it copies from is empty.
 */
export function applyRules(
  rules: ProjectRule[],
  item: Pick<WorkItemSummary, 'typeId' | 'priority' | 'roles' | 'roleNames'>,
  toStatusId: string,
  context: {
    moverId: string;
    members: Set<string>;
    /** The roles the item's type offers, with whether each takes several. */
    roles: Map<string, { multiple: boolean }>;
  },
): RuleChange[] {
  const working = new Map<string, { userIds: string[]; names: string[] }>();
  const holders = (roleId: string) =>
    working.get(roleId) ?? { userIds: item.roles[roleId] ?? [], names: item.roleNames[roleId] ?? [] };
  const changedBy = new Map<string, string>();
  let priority = item.priority;
  let priorityRule: string | null = null;

  const ordered = [...rules].sort((a, b) => a.position - b.position);
  for (const rule of ordered) {
    if (!rule.enabled || rule.statusId !== toStatusId) continue;
    if (rule.typeIds !== null && !rule.typeIds.includes(item.typeId)) continue;
    for (const action of rule.actions) {
      if (action.kind === 'priority') {
        priority = action.priority;
        priorityRule = rule.name;
        continue;
      }
      const role = context.roles.get(action.roleId);
      if (!role) continue;
      if (action.op === 'clear') {
        working.set(action.roleId, { userIds: [], names: [] });
        changedBy.set(action.roleId, rule.name);
        continue;
      }
      let incoming: { userIds: string[]; names: string[] };
      const source = action.source!;
      if (source.kind === 'member') {
        if (!context.members.has(source.userId)) continue;
        incoming = { userIds: [source.userId], names: [] };
      } else if (source.kind === 'mover') {
        incoming = { userIds: [context.moverId], names: [] };
      } else {
        const from = holders(source.roleId);
        if (from.userIds.length + from.names.length === 0) continue;
        incoming = from;
      }
      const current = holders(action.roleId);
      let next =
        action.op === 'add' && role.multiple
          ? {
              userIds: [...new Set([...current.userIds, ...incoming.userIds])],
              names: [...current.names, ...incoming.names.filter((n) => !current.names.some((c) => c.toLowerCase() === n.toLowerCase()))],
            }
          : { userIds: [...incoming.userIds], names: [...incoming.names] };
      // A role one person holds takes the first of several.
      if (!role.multiple) {
        next = next.userIds.length > 0 ? { userIds: next.userIds.slice(0, 1), names: [] } : { userIds: [], names: next.names.slice(0, 1) };
      }
      next = { userIds: next.userIds.slice(0, MAX_ROLE_HOLDERS), names: next.names.slice(0, MAX_ROLE_HOLDERS) };
      working.set(action.roleId, next);
      changedBy.set(action.roleId, rule.name);
    }
  }

  const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
  const changes: RuleChange[] = [];
  for (const [roleId, next] of working) {
    const was = { userIds: item.roles[roleId] ?? [], names: item.roleNames[roleId] ?? [] };
    if (same([...was.userIds].sort(), [...next.userIds].sort()) && same([...was.names].sort(), [...next.names].sort())) continue;
    changes.push({ kind: 'role', roleId, rule: changedBy.get(roleId)!, userIds: next.userIds, names: next.names });
  }
  if (priorityRule && priority !== item.priority) changes.push({ kind: 'priority', rule: priorityRule, priority });
  return changes;
}
