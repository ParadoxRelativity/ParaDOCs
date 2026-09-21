import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  WORK_ITEM_PRIORITIES,
  WORK_ITEM_LINK_LABELS,
  WORK_ITEM_LINK_OPTIONS,
  canHaveEpic,
  isEpicType,
  itemTypeOf,
  rolesForType,
  canMoveTo,
  usesSprints,
  type MessageReferences,
  type Project,
  type ProjectKind,
  type ProjectRole,
  type UpdateWorkItemInput,
  type WorkItem,
  type WorkItemActivity,
  type WorkItemComment,
  type WorkItemLink,
  type WorkItemLinkDirection,
  type WorkItemLinkType,
  type WorkItemPriority,
  type WorkItemSummary,
  type WorkspaceMember,
} from '@paradocs/shared';
import {
  useDeleteWorkItem,
  useSetWorkItemRole,
  useUpdateWorkItem,
  useWorkItem,
  useWorkItemBacklinks,
  useWorkItemComments,
  useWorkItemLinking,
  useWorkItemLinks,
  useWorkItemListing,
  useWorkItemTimeline,
  useWorkItems,
} from '../../api/hooks';
import { cx, formatDateTime, formatRelative } from '../../lib/util';
import { shareOrigin } from '../../lib/server';
import Avatar from '../Avatar';
import { MessageBody } from '../chat/MessageBody';
import Icon, { DocumentIcon } from '../Icon';
import { ConfirmDialog } from '../Modal';
import { useToast } from '../Toast';
import { EmptyState, IconButton, Spinner } from '../ui';
import ReferenceEditor from './ReferenceEditor';
import {
  DueDatePicker,
  EpicProgressBar,
  PRIORITY,
  PeoplePicker,
  PeopleStack,
  PriorityIcon,
  StatusPill,
  TypeIcon,
  holderLabel,
  isOverdue,
  useMemberMap,
} from './projectUi';

export interface ProjectNavigation {
  onOpenDocument: (id: string) => void;
  onOpenSpreadsheet: (id: string) => void;
  onOpenChannel: (id: string) => void;
  onOpenWorkItem: (item: { id: string; projectId: string }) => void;
  onOpenProject?: (project: { id: string; kind: ProjectKind }) => void;
}

const FIELD =
  'w-full rounded-md border border-transparent bg-transparent px-2 py-1 text-sm outline-none ' +
  'hover:border-[var(--color-line)] focus:border-[var(--color-accent)] disabled:hover:border-transparent';

/** Tells an account apart from a name typed into a free-form role. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * One work item, open beside the board or list it was chosen from: what it is,
 * who is on it, what it says, where it is mentioned, and what has happened to
 * it. Everything that can be changed is changed where it is shown.
 */
export default function WorkItemPanel({
  workspaceId,
  itemId,
  project,
  members,
  selfId,
  canEdit,
  onClose,
  navigation,
}: {
  workspaceId: string;
  itemId: string;
  project: Project;
  members: WorkspaceMember[];
  selfId: string;
  canEdit: boolean;
  onClose: () => void;
  navigation: ProjectNavigation;
}) {
  const item = useWorkItem(itemId);
  const memberMap = useMemberMap(members);

  if (item.isLoading) return <Spinner />;
  if (item.error || !item.data) {
    return (
      <div className="relative h-full">
        <div className="absolute right-2 top-2">
          <IconButton label="Close" onClick={onClose}>
            <Icon name="x-lg" />
          </IconButton>
        </div>
        <EmptyState
          icon="exclamation-triangle"
          title="This work item cannot be opened"
          hint="It may have been deleted, or be in a project that is not shared with you."
        />
      </div>
    );
  }
  // A key per item, so switching items drops half-typed edits of the last one.
  return (
    <ItemDetail
      key={item.data.id}
      workspaceId={workspaceId}
      item={item.data}
      project={project}
      members={members}
      memberMap={memberMap}
      selfId={selfId}
      canEdit={canEdit}
      onClose={onClose}
      navigation={navigation}
    />
  );
}

function ItemDetail({
  workspaceId,
  item,
  project,
  members,
  memberMap,
  selfId,
  canEdit,
  onClose,
  navigation,
}: {
  workspaceId: string;
  item: WorkItem;
  project: Project;
  members: WorkspaceMember[];
  memberMap: Map<string, WorkspaceMember>;
  selfId: string;
  canEdit: boolean;
  onClose: () => void;
  navigation: ProjectNavigation;
}) {
  const update = useUpdateWorkItem(project.id);
  const remove = useDeleteWorkItem(project.id);
  const siblings = useWorkItems(project.id);
  const toast = useToast();
  const [title, setTitle] = useState(item.title);
  const [editingDescription, setEditingDescription] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [confirmingType, setConfirmingType] = useState<{ typeId: string; losing: string[] } | null>(null);
  const titleRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => setTitle(item.title), [item.title]);
  useEffect(() => {
    const el = titleRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [title]);

  const status = project.statuses.find((s) => s.id === item.statusId);
  const done = status?.category === 'done';

  function patch(changes: UpdateWorkItemInput) {
    update.mutate(
      { id: item.id, ...changes },
      { onError: (err) => toast(err instanceof Error ? err.message : 'Could not change the work item', 'error') },
    );
  }

  /**
   * Changes the type, first asking when the new one does not offer a role
   * someone holds here, since changing takes them off it.
   */
  function changeType(typeId: string) {
    const offered = new Set(itemTypeOf(project, typeId)?.roleIds ?? []);
    const losing = project.roles.filter(
      (role) => !offered.has(role.id) && ((item.roles[role.id]?.length ?? 0) > 0 || (item.roleNames[role.id]?.length ?? 0) > 0),
    );
    if (losing.length > 0) setConfirmingType({ typeId, losing: losing.map((role) => role.name) });
    else patch({ typeId });
  }

  function commitTitle() {
    const trimmed = title.trim();
    if (!trimmed) setTitle(item.title);
    else if (trimmed !== item.title) patch({ title: trimmed });
  }

  function copyLink() {
    const url = `${shareOrigin()}/w/${workspaceId}/p/${project.id}/${item.id}`;
    void navigator.clipboard?.writeText(url).then(
      () => toast(`Link to ${item.key} copied`),
      () => toast('Could not copy the link', 'error'),
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-11 shrink-0 items-center gap-1 border-b border-[var(--color-line)] px-3">
        <TypeIcon type={itemTypeOf(project, item.typeId)} />
        <span className="ml-1 text-sm font-medium text-[var(--color-muted)]">{item.key}</span>
        {item.blockedBy > 0 && !done && (
          <span
            className="ml-1 flex items-center gap-1 rounded bg-red-500/10 px-1.5 py-0.5 text-[11px] font-medium text-red-600 dark:text-red-400"
            title={`${item.blockedBy} open ${item.blockedBy === 1 ? 'item blocks' : 'items block'} this`}
          >
            <Icon name="slash-circle" /> Blocked
          </span>
        )}
        <span className="flex-1" />
        <IconButton label="Copy link" onClick={copyLink}>
          <Icon name="link-45deg" />
        </IconButton>
        {canEdit && (
          <IconButton label="Delete work item" onClick={() => setConfirmingDelete(true)}>
            <Icon name="trash3" />
          </IconButton>
        )}
        <IconButton label="Close" onClick={onClose}>
          <Icon name="x-lg" />
        </IconButton>
      </div>

      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-5 pb-8 pt-4">
        <textarea
          ref={titleRef}
          value={title}
          rows={1}
          readOnly={!canEdit}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={commitTitle}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              e.currentTarget.blur();
            }
            if (e.key === 'Escape') {
              setTitle(item.title);
              e.currentTarget.blur();
            }
          }}
          className={cx(
            '-mx-1 w-full resize-none overflow-hidden rounded border border-transparent bg-transparent px-1 text-xl font-semibold leading-snug outline-none',
            canEdit && 'hover:border-[var(--color-line)] focus:border-[var(--color-accent)]',
            done && 'text-[var(--color-muted)]',
          )}
        />

        <dl className="mt-3 grid grid-cols-[7rem_minmax(0,1fr)] items-center gap-x-2 gap-y-1 text-sm">
          <Property label="Status">
            <select
              value={item.statusId}
              disabled={!canEdit}
              onChange={(e) => patch({ statusId: e.target.value })}
              className={cx(FIELD, 'cursor-pointer disabled:cursor-default')}
              aria-label="Status"
            >
              {/* Where it is, and wherever its workflow lets it go from there. */}
              {project.statuses
                .filter((s) => canMoveTo(project, item.typeId, item.statusId, s.id))
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
            </select>
          </Property>
          <Property label="Priority">
            <div className="flex items-center gap-1">
              <PriorityIcon priority={item.priority} className="pl-2" />
              <select
                value={item.priority}
                disabled={!canEdit}
                onChange={(e) => patch({ priority: e.target.value as WorkItemPriority })}
                className={cx(FIELD, 'cursor-pointer disabled:cursor-default')}
                aria-label="Priority"
              >
                {WORK_ITEM_PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {PRIORITY[p].label}
                  </option>
                ))}
              </select>
            </div>
          </Property>
          <Property label="Type">
            <div className="flex items-center gap-1">
              <TypeIcon type={itemTypeOf(project, item.typeId)} className="pl-2" />
              <select
                value={item.typeId}
                disabled={!canEdit}
                onChange={(e) => changeType(e.target.value)}
                className={cx(FIELD, 'cursor-pointer disabled:cursor-default')}
                aria-label="Type"
              >
                {project.itemTypes.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </div>
          </Property>
          {rolesForType(project, item.typeId).map((role) => (
            <RoleProperty
              key={role.id}
              item={item}
              role={role}
              projectId={project.id}
              members={members}
              memberMap={memberMap}
              selfId={selfId}
              canEdit={canEdit}
            />
          ))}
          {project.kind === 'project' && canHaveEpic(project, item.typeId) && (
            <Property label="Epic">
              <select
                value={item.epicId ?? ''}
                disabled={!canEdit}
                onChange={(e) => patch({ epicId: e.target.value || null })}
                className={cx(FIELD, 'cursor-pointer disabled:cursor-default')}
                aria-label="Epic"
              >
                <option value="">None</option>
                {(siblings.data ?? [])
                  .filter((other) => isEpicType(project, other.typeId))
                  .map((epic) => (
                    <option key={epic.id} value={epic.id}>
                      {epic.key} {epic.title}
                    </option>
                  ))}
              </select>
            </Property>
          )}
          {/* Epics are not planned in sprints; the work under them is. */}
          {usesSprints(project) && !isEpicType(project, item.typeId) && (
            <Property label="Sprint">
              <select
                value={item.sprintId ?? ''}
                disabled={!canEdit}
                onChange={(e) => patch({ sprintId: e.target.value || null })}
                className={cx(FIELD, 'cursor-pointer disabled:cursor-default')}
                aria-label="Sprint"
              >
                <option value="">Backlog</option>
                {/* Running and planned sprints, and a completed one only where it already is. */}
                {project.sprints
                  .filter((s) => s.state !== 'completed' || s.id === item.sprintId)
                  .map((s) => (
                    <option key={s.id} value={s.id} disabled={s.state === 'completed'}>
                      {s.name}
                      {s.state === 'active' ? ' (running)' : s.state === 'completed' ? ' (complete)' : ''}
                    </option>
                  ))}
              </select>
            </Property>
          )}
          <Property label="Due date">
            <DueDatePicker
              value={item.dueDate}
              disabled={!canEdit}
              overdue={isOverdue(item.dueDate, done)}
              placeholder={canEdit ? 'mm/dd/yyyy' : 'None'}
              onChange={(dueDate) => patch({ dueDate })}
              className={FIELD}
            />
          </Property>
          <Property label="Estimate">
            <EstimateField value={item.estimate} disabled={!canEdit} onCommit={(estimate) => patch({ estimate })} />
          </Property>
        </dl>

        <Heading>Description</Heading>
        {editingDescription ? (
          <ReferenceEditor
            workspaceId={workspaceId}
            initialBody={item.description}
            references={item.references}
            autoFocus
            minRows={5}
            placeholder="What needs doing, and why. Mention people with @, link documents with [[ and other work items with \\"
            submitLabel="Save"
            onCancel={() => setEditingDescription(false)}
            onSubmit={async (description) => {
              try {
                await update.mutateAsync({ id: item.id, description });
                setEditingDescription(false);
              } catch (err) {
                toast(err instanceof Error ? err.message : 'Could not save the description', 'error');
              }
            }}
          />
        ) : item.description ? (
          <div
            role={canEdit ? 'button' : undefined}
            tabIndex={canEdit ? 0 : undefined}
            onClick={(e) => {
              // A click on a link inside follows it rather than starting an edit.
              if (canEdit && !(e.target as HTMLElement).closest('button')) setEditingDescription(true);
            }}
            onKeyDown={(e) => {
              if (canEdit && e.key === 'Enter') setEditingDescription(true);
            }}
            className={cx('-mx-2 rounded-md px-2 py-1.5 text-sm leading-relaxed', canEdit && 'cursor-text hover:bg-[var(--color-surface)]')}
          >
            <MessageBody
              body={item.description}
              references={item.references}
              selfId={selfId}
              {...navigation}
            />
          </div>
        ) : canEdit ? (
          <button
            onClick={() => setEditingDescription(true)}
            className="-mx-2 w-full rounded-md px-2 py-1.5 text-left text-sm text-[var(--color-muted)] hover:bg-[var(--color-surface)]"
          >
            Add a description…
          </button>
        ) : (
          <p className="text-sm text-[var(--color-muted)]">No description.</p>
        )}

        <Links workspaceId={workspaceId} item={item} canEdit={canEdit} navigation={navigation} />

        {isEpicType(project, item.typeId) && (
          <EpicChildren
            project={project}
            epicId={item.id}
            items={siblings.data ?? []}
            onOpen={(id) => navigation.onOpenWorkItem({ id, projectId: project.id })}
          />
        )}

        <Backlinks itemId={item.id} navigation={navigation} />

        <Timeline
          workspaceId={workspaceId}
          item={item}
          memberMap={memberMap}
          selfId={selfId}
          canEdit={canEdit}
          navigation={navigation}
        />

        <History item={item} memberMap={memberMap} />
      </div>

      {confirmingType && (
        <ConfirmDialog
          title={`Make ${item.key} a ${itemTypeOf(project, confirmingType.typeId)?.name ?? 'different type'}?`}
          description={`${confirmingType.losing.join(', ')} ${confirmingType.losing.length === 1 ? 'is not a role' : 'are not roles'} on that type, so whoever holds ${confirmingType.losing.length === 1 ? 'it' : 'them'} here will be taken off.`}
          confirmLabel="Change type"
          onCancel={() => setConfirmingType(null)}
          onConfirm={() => {
            patch({ typeId: confirmingType.typeId });
            setConfirmingType(null);
          }}
        />
      )}
      {confirmingDelete && (
        <ConfirmDialog
          title={`Delete ${item.key}?`}
          description={`"${item.title}" and its comments and history will be deleted for everyone. Links to it will stop working.`}
          onCancel={() => setConfirmingDelete(false)}
          onConfirm={() => {
            setConfirmingDelete(false);
            remove.mutate(item.id, {
              onSuccess: () => {
                toast(`Deleted ${item.key}`);
                onClose();
              },
              onError: (err) => toast(err instanceof Error ? err.message : 'Could not delete the work item', 'error'),
            });
          }}
        />
      )}
    </div>
  );
}

function Property({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="truncate text-xs text-[var(--color-muted)]">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </>
  );
}

/**
 * The work items this one is linked to — what blocks it, what it blocks,
 * duplicates, caused, or is simply related to — grouped by how each reads from
 * here, with a search to link another.
 */
function Links({
  workspaceId,
  item,
  canEdit,
  navigation,
}: {
  workspaceId: string;
  item: WorkItem;
  canEdit: boolean;
  navigation: ProjectNavigation;
}) {
  const links = useWorkItemLinks(item.id);
  const { link, unlink } = useWorkItemLinking(item.id);
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const [choice, setChoice] = useState(() => optionKey('blocks', 'inward'));
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(search.trim()), 200);
    return () => clearTimeout(timer);
  }, [search]);
  const results = useWorkItemListing(adding && debounced ? workspaceId : undefined, { q: debounced, limit: 8 });

  const all = links.data ?? [];
  // Grouped by how the link reads from here, in the order the picker offers them.
  const groups = useMemo(() => {
    const byLabel = new Map<string, WorkItemLink[]>();
    for (const option of WORK_ITEM_LINK_OPTIONS) byLabel.set(option.label, []);
    for (const entry of all) byLabel.get(WORK_ITEM_LINK_LABELS[entry.type][entry.direction])?.push(entry);
    return [...byLabel].filter(([, entries]) => entries.length > 0);
  }, [all]);

  const [type, direction] = choice.split(':') as [WorkItemLinkType, WorkItemLinkDirection];
  const taken = new Set(all.filter((entry) => entry.type === type).map((entry) => entry.item.id));
  const candidates = (results.data ?? []).filter((other) => other.id !== item.id && !taken.has(other.id));

  function add(targetId: string, targetKey: string) {
    link.mutate(
      { type, direction, targetId },
      {
        onSuccess: () => {
          toast(`${item.key} ${WORK_ITEM_LINK_LABELS[type][direction]} ${targetKey}`);
          setSearch('');
          setAdding(false);
        },
        onError: (err) => toast(err instanceof Error ? err.message : 'Could not link the work items', 'error'),
      },
    );
  }

  if (all.length === 0 && !canEdit) return null;

  return (
    <>
      <div className="mt-6 flex items-center">
        <h3 className="flex flex-1 items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-[var(--color-muted)]">
          Links
          {all.length > 0 && <span className="font-normal normal-case">{all.length}</span>}
        </h3>
        {canEdit && !adding && (
          <button
            onClick={() => setAdding(true)}
            className="flex items-center gap-1 text-xs text-[var(--color-muted)] hover:text-[var(--color-ink)]"
          >
            <Icon name="link-45deg" /> Link work item
          </button>
        )}
      </div>

      {adding && (
        <div className="mt-1.5 rounded-lg border border-[var(--color-line)] p-2">
          <div className="flex gap-2">
            <select
              value={choice}
              onChange={(e) => setChoice(e.target.value)}
              className="shrink-0 rounded-md border border-[var(--color-line)] bg-[var(--color-canvas)] px-2 py-1 text-xs outline-none focus:border-[var(--color-accent)]"
              aria-label="How they are linked"
            >
              {WORK_ITEM_LINK_OPTIONS.map((option) => (
                <option key={optionKey(option.type, option.direction)} value={optionKey(option.type, option.direction)}>
                  {option.label}
                </option>
              ))}
            </select>
            <input
              autoFocus
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setAdding(false);
                if (e.key === 'Enter' && candidates[0]) add(candidates[0].id, candidates[0].key);
              }}
              placeholder="Search by key or title"
              className="min-w-0 flex-1 rounded-md border border-[var(--color-line)] bg-[var(--color-canvas)] px-2 py-1 text-xs outline-none focus:border-[var(--color-accent)]"
            />
            <IconButton label="Cancel" onClick={() => setAdding(false)}>
              <Icon name="x-lg" />
            </IconButton>
          </div>
          {debounced && (
            <ul className="mt-1.5">
              {results.isLoading ? (
                <li className="px-2 py-1 text-xs text-[var(--color-muted)]">Searching…</li>
              ) : candidates.length === 0 ? (
                <li className="px-2 py-1 text-xs text-[var(--color-muted)]">No work items match.</li>
              ) : (
                candidates.map((other) => (
                  <li key={other.id}>
                    <button
                      disabled={link.isPending}
                      onClick={() => add(other.id, other.key)}
                      className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-[var(--color-surface)] disabled:opacity-50"
                    >
                      <TypeIcon type={other.itemType} />
                      <span className="shrink-0 text-xs text-[var(--color-muted)]">{other.key}</span>
                      <span className="min-w-0 flex-1 truncate">{other.title}</span>
                      <StatusPill status={other.status} className="shrink-0" />
                    </button>
                  </li>
                ))
              )}
            </ul>
          )}
        </div>
      )}

      {groups.map(([label, entries]) => (
        <div key={label} className="mt-2">
          <p className="mb-0.5 text-xs text-[var(--color-muted)]">{label[0].toUpperCase() + label.slice(1)}</p>
          <ul className="-mx-2">
            {entries.map((entry) => {
              const done = entry.item.status.category === 'done';
              return (
                <li key={entry.id} className="group flex items-center gap-1">
                  <button
                    onClick={() => navigation.onOpenWorkItem(entry.item)}
                    className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-[var(--color-surface)]"
                  >
                    <TypeIcon type={entry.item.itemType} />
                    <span className="shrink-0 text-xs text-[var(--color-muted)]">{entry.item.key}</span>
                    <span className={cx('min-w-0 flex-1 truncate', done && 'text-[var(--color-muted)] line-through')}>
                      {entry.item.title}
                    </span>
                    <StatusPill status={entry.item.status} className="shrink-0" />
                  </button>
                  {canEdit && (
                    <button
                      onClick={() =>
                        unlink.mutate(entry.id, {
                          onError: (err) => toast(err instanceof Error ? err.message : 'Could not remove the link', 'error'),
                        })
                      }
                      title="Remove link"
                      aria-label={`Remove link to ${entry.item.key}`}
                      className="rounded p-1 text-xs text-[var(--color-muted)] opacity-0 hover:text-[var(--color-ink)] focus:opacity-100 group-hover:opacity-100"
                    >
                      <Icon name="x-lg" />
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </>
  );
}

function optionKey(type: WorkItemLinkType, direction: WorkItemLinkDirection): string {
  return `${type}:${direction}`;
}

/** The work organised under an epic, and how far along it is. */
function EpicChildren({
  project,
  epicId,
  items,
  onOpen,
}: {
  project: Project;
  epicId: string;
  items: WorkItemSummary[];
  onOpen: (itemId: string) => void;
}) {
  const children = items.filter((other) => other.epicId === epicId);
  const statuses = new Map(project.statuses.map((s) => [s.id, s]));
  return (
    <>
      <Heading count={children.length}>Work in this epic</Heading>
      {children.length === 0 ? (
        <p className="text-sm text-[var(--color-muted)]">
          Nothing yet. Choose this epic on a story, task or bug to organise it here.
        </p>
      ) : (
        <>
          <EpicProgressBar project={project} items={children} className="mb-2" />
          <ul className="-mx-2">
            {children.map((child) => {
              const status = statuses.get(child.statusId);
              return (
                <li key={child.id}>
                  <button
                    onClick={() => onOpen(child.id)}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-[var(--color-surface)]"
                  >
                    <TypeIcon type={itemTypeOf(project, child.typeId)} />
                    <span className="shrink-0 text-xs text-[var(--color-muted)]">{child.key}</span>
                    <span
                      className={cx(
                        'min-w-0 flex-1 truncate',
                        status?.category === 'done' && 'text-[var(--color-muted)] line-through',
                      )}
                    >
                      {child.title}
                    </span>
                    {status && <StatusPill status={status} className="shrink-0" />}
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </>
  );
}

function Heading({ children, count }: { children: ReactNode; count?: number }) {
  return (
    <h3 className="mb-1.5 mt-6 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-[var(--color-muted)]">
      {children}
      {count !== undefined && count > 0 && <span className="font-normal normal-case">{count}</span>}
    </h3>
  );
}

function EstimateField({
  value,
  disabled,
  onCommit,
}: {
  value: number | null;
  disabled: boolean;
  onCommit: (value: number | null) => void;
}) {
  const [text, setText] = useState(value === null ? '' : String(value));
  useEffect(() => setText(value === null ? '' : String(value)), [value]);
  function commit() {
    const trimmed = text.trim();
    const next = trimmed === '' ? null : Number(trimmed);
    if (next !== null && (!Number.isFinite(next) || next < 0)) {
      setText(value === null ? '' : String(value));
      return;
    }
    if (next !== value) onCommit(next);
  }
  return (
    <input
      type="number"
      min={0}
      step="any"
      value={text}
      disabled={disabled}
      placeholder="—"
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
      }}
      className={FIELD}
      aria-label="Estimate"
    />
  );
}

function RoleProperty({
  item,
  role,
  projectId,
  members,
  memberMap,
  selfId,
  canEdit,
}: {
  item: WorkItem;
  role: ProjectRole;
  projectId: string;
  members: WorkspaceMember[];
  memberMap: Map<string, WorkspaceMember>;
  selfId: string;
  canEdit: boolean;
}) {
  const setRole = useSetWorkItemRole(projectId);
  const toast = useToast();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const holders = item.roles[role.id] ?? [];
  const names = role.freeForm ? (item.roleNames[role.id] ?? []) : [];
  const count = holders.length + names.length;

  // Members and typed names are one field, so both go in every save: whichever
  // half the picker did not touch is sent back as it stands.
  function change(userIds: string[], nextNames: string[] = names) {
    setRole.mutate(
      { itemId: item.id, roleId: role.id, userIds, names: role.freeForm ? nextNames : [] },
      { onError: (err) => toast(err instanceof Error ? err.message : `Could not change ${role.name}`, 'error') },
    );
  }

  return (
    <Property label={role.name}>
      <div className="flex min-w-0 items-center gap-1">
        <button
          disabled={!canEdit}
          onClick={(e) => setAnchor(anchor ? null : e.currentTarget)}
          className={cx(
            'flex min-w-0 flex-1 items-center gap-1.5 rounded-md border border-transparent px-2 py-1 text-left',
            canEdit && 'hover:border-[var(--color-line)]',
          )}
        >
          {count === 0 ? (
            <span className="text-[var(--color-muted)]">
              {canEdit ? (role.freeForm ? 'Add someone, or type a name' : 'Add someone') : 'Nobody'}
            </span>
          ) : (
            <>
              <PeopleStack userIds={holders} names={names} members={memberMap} max={5} />
              <span className={cx('truncate', count > 1 && 'text-xs text-[var(--color-muted)]')}>
                {holderLabel(holders, names, memberMap)}
              </span>
            </>
          )}
        </button>
        {canEdit && !holders.includes(selfId) && (
          <button
            onClick={() => (role.multiple ? change([...holders, selfId]) : change([selfId], []))}
            className="shrink-0 rounded px-1.5 py-0.5 text-xs text-[var(--color-accent)] hover:bg-[var(--color-accent-soft)]"
          >
            {role.multiple ? 'Add me' : 'Take it'}
          </button>
        )}
      </div>
      {anchor && (
        <PeoplePicker
          anchor={anchor}
          members={members}
          selected={holders}
          names={names}
          multiple={role.multiple}
          freeForm={role.freeForm}
          onChange={(userIds) => change(userIds)}
          onNamesChange={(nextNames) => change(holders, nextNames)}
          onClose={() => setAnchor(null)}
        />
      )}
    </Property>
  );
}

/** Where this item is mentioned, so the conversation about it is one click away. */
function Backlinks({ itemId, navigation }: { itemId: string; navigation: ProjectNavigation }) {
  const backlinks = useWorkItemBacklinks(itemId);
  const data = backlinks.data;
  const count = data ? data.documents.length + data.channels.length + data.workItems.length : 0;
  if (!data || count === 0) return null;

  const row = 'flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-[var(--color-surface)]';
  return (
    <>
      <Heading count={count}>Mentioned in</Heading>
      <div className="-mx-2">
        {data.workItems.map((other) => (
          <button key={other.id} className={row} onClick={() => navigation.onOpenWorkItem(other)}>
            <Icon name="kanban" className="w-4 text-center text-xs text-[var(--color-muted)]" />
            <span className="shrink-0 text-xs text-[var(--color-muted)]">{other.key}</span>
            <span className="min-w-0 flex-1 truncate">{other.title}</span>
          </button>
        ))}
        {data.documents.map((doc) => (
          <button key={doc.id} className={row} onClick={() => navigation.onOpenDocument(doc.id)}>
            <DocumentIcon doc={doc} className="w-4 text-center text-xs text-[var(--color-muted)]" />
            <span className="min-w-0 flex-1 truncate">{doc.title || 'Untitled'}</span>
            <span className="shrink-0 text-xs text-[var(--color-muted)]">{doc.mode === 'canvas' ? 'Canvas' : 'Document'}</span>
          </button>
        ))}
        {data.channels.map((channel) => (
          <button key={channel.id} className={row} onClick={() => navigation.onOpenChannel(channel.id)}>
            <Icon name={channel.kind === 'direct' ? 'chat' : 'hash'} className="w-4 text-center text-xs text-[var(--color-muted)]" />
            <span className="min-w-0 flex-1 truncate">{channel.kind === 'direct' ? 'Direct conversation' : channel.name}</span>
            <span className="shrink-0 text-xs text-[var(--color-muted)]">
              {channel.mentions === 1 ? '1 message' : `${channel.mentions} messages`} · {formatRelative(channel.latestAt)}
            </span>
          </button>
        ))}
      </div>
    </>
  );
}

function Timeline({
  workspaceId,
  item,
  memberMap,
  selfId,
  canEdit,
  navigation,
}: {
  workspaceId: string;
  item: WorkItem;
  memberMap: Map<string, WorkspaceMember>;
  selfId: string;
  canEdit: boolean;
  navigation: ProjectNavigation;
}) {
  const timeline = useWorkItemTimeline(item.id);
  const comments = useWorkItemComments(item.id, item.projectId);
  const toast = useToast();
  const [editing, setEditing] = useState<string | null>(null);

  const references = timeline.data?.references;
  const entries = [...(timeline.data?.comments ?? [])]
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
    .map((comment) => ({ at: comment.createdAt, comment }));

  return (
    <>
      <Heading count={timeline.data?.comments.length}>Comments</Heading>
      {timeline.isLoading ? (
        <Spinner />
      ) : (
        <ol className="space-y-3">
          {entries.map((entry) => (
            <li key={entry.comment.id} className="group flex gap-2">
              <Avatar
                name={entry.comment.author?.name ?? '?'}
                url={entry.comment.author?.avatarUrl}
                seed={entry.comment.author?.id}
                size="lg"
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="text-sm font-semibold">{entry.comment.author?.name ?? 'Former member'}</span>
                  <span className="text-xs text-[var(--color-muted)]" title={formatDateTime(entry.at)}>
                    {formatRelative(entry.at)}
                    {entry.comment.editedAt && ' (edited)'}
                  </span>
                  <span className="flex-1" />
                  {canEdit && entry.comment.author?.id === selfId && editing !== entry.comment.id && (
                    <button
                      onClick={() => setEditing(entry.comment.id)}
                      className="hidden text-xs text-[var(--color-muted)] hover:text-[var(--color-ink)] group-hover:inline"
                    >
                      Edit
                    </button>
                  )}
                  {entry.comment.author?.id === selfId && (
                    <button
                      onClick={() =>
                        comments.remove.mutate(entry.comment.id, {
                          onError: (err) => toast(err instanceof Error ? err.message : 'Could not delete the comment', 'error'),
                        })
                      }
                      className="hidden text-xs text-[var(--color-muted)] hover:text-red-500 group-hover:inline"
                    >
                      Delete
                    </button>
                  )}
                </div>
                {editing === entry.comment.id ? (
                  <div className="mt-1">
                    <ReferenceEditor
                      workspaceId={workspaceId}
                      initialBody={entry.comment.body}
                      references={references}
                      autoFocus
                      minRows={2}
                      submitLabel="Save"
                      onCancel={() => setEditing(null)}
                      onSubmit={async (body) => {
                        if (!body) return;
                        try {
                          await comments.edit.mutateAsync({ id: entry.comment.id, body });
                          setEditing(null);
                        } catch (err) {
                          toast(err instanceof Error ? err.message : 'Could not save the comment', 'error');
                        }
                      }}
                    />
                  </div>
                ) : (
                  <div className="text-sm leading-relaxed">
                    <MessageBody
                      body={entry.comment.body}
                      references={references ?? EMPTY_REFERENCES}
                      selfId={selfId}
                      {...navigation}
                    />
                  </div>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}

      {canEdit && (
        <div className="mt-4">
          <ReferenceEditor
            workspaceId={workspaceId}
            minRows={2}
            placeholder="Add a comment…"
            submitLabel="Comment"
            onSubmit={async (body) => {
              if (!body) return;
              try {
                await comments.add.mutateAsync(body);
              } catch (err) {
                toast(err instanceof Error ? err.message : 'Could not add the comment', 'error');
                throw err;
              }
            }}
          />
        </div>
      )}
    </>
  );
}

/** Created and last-updated dates, with the change history behind a toggle. */
function History({ item, memberMap }: { item: WorkItem; memberMap: Map<string, WorkspaceMember> }) {
  const [open, setOpen] = useState(false);
  const timeline = useWorkItemTimeline(item.id);
  const references = timeline.data?.references;
  const activity = [...(timeline.data?.activity ?? [])].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );

  // A free-form role writes the name itself into the history, since no account
  // holds it; anything that is not an id is already what to show.
  const name = (id: string) =>
    UUID.test(id)
      ? (memberMap.get(id)?.name ?? references?.members.find((m) => m.id === id)?.name ?? 'someone')
      : id;

  return (
    <div className="mt-6 border-t border-[var(--color-line)] pt-3 text-xs text-[var(--color-muted)]">
      <div className="flex items-center gap-3">
        <span>Created {formatDateTime(item.createdAt)}</span>
        <span title={formatDateTime(item.updatedAt)}>Updated {formatRelative(item.updatedAt)}</span>
        <span className="flex-1" />
        <button
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-[var(--color-surface)] hover:text-[var(--color-ink)]"
        >
          <Icon name="clock-history" />
          {open ? 'Hide history' : 'History'}
        </button>
      </div>
      {open &&
        (timeline.isLoading ? (
          <Spinner />
        ) : activity.length === 0 ? (
          <p className="mt-3">No changes yet.</p>
        ) : (
          <ol className="mt-3 space-y-2">
            {activity.map((entry) => (
              <li key={entry.id} className="flex items-start gap-2">
                <span className="min-w-0 flex-1">
                  <span className="font-medium text-[var(--color-ink)]">{entry.actor?.name ?? 'Someone'}</span>{' '}
                  {describeActivity(entry, name)}
                </span>
                <span className="shrink-0" title={formatDateTime(entry.createdAt)}>
                  {formatRelative(entry.createdAt)}
                </span>
              </li>
            ))}
          </ol>
        ))}
    </div>
  );
}

const EMPTY_REFERENCES: MessageReferences = { documents: [], spreadsheets: [], channels: [], members: [], workItems: [] };

function describeActivity(activity: WorkItemActivity, name: (id: string) => string): string {
  switch (activity.kind) {
    case 'created':
      return 'created this';
    case 'status':
      return `moved this from ${activity.from} to ${activity.to}`;
    case 'priority':
      return `changed the priority from ${PRIORITY[activity.from].label.toLowerCase()} to ${PRIORITY[activity.to].label.toLowerCase()}`;
    case 'title':
      return `renamed this from "${activity.from}"`;
    case 'link':
      return activity.added
        ? `noted that this ${activity.label} ${activity.key} ${activity.title}`
        : `removed the link: this ${activity.label} ${activity.key} ${activity.title}`;
    case 'epic':
      if (!activity.to) return `took this out of the epic ${activity.from ?? ''}`.trimEnd();
      return activity.from ? `moved this from the epic ${activity.from} to ${activity.to}` : `put this under the epic ${activity.to}`;
    case 'sprint':
      if (!activity.to) return `took this out of ${activity.from ?? 'its sprint'}, back to the backlog`;
      return activity.from ? `moved this from ${activity.from} to ${activity.to}` : `added this to ${activity.to}`;
    case 'role': {
      const parts: string[] = [];
      if (activity.added.length) parts.push(`made ${activity.added.map(name).join(', ')} ${activity.role}`);
      if (activity.removed.length) parts.push(`removed ${activity.removed.map(name).join(', ')} as ${activity.role}`);
      return parts.join(' and ');
    }
  }
}
