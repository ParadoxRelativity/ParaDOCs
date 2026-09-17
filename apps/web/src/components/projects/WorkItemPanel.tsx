import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  WORK_ITEM_PRIORITIES,
  WORK_ITEM_TYPES,
  canMoveTo,
  type MessageReferences,
  type Project,
  type ProjectRole,
  type UpdateWorkItemInput,
  type WorkItem,
  type WorkItemActivity,
  type WorkItemComment,
  type WorkItemPriority,
  type WorkItemType,
  type WorkspaceMember,
} from '@paradocs/shared';
import {
  useDeleteWorkItem,
  useSetWorkItemRole,
  useUpdateWorkItem,
  useWorkItem,
  useWorkItemBacklinks,
  useWorkItemComments,
  useWorkItemTimeline,
} from '../../api/hooks';
import { cx, formatDateTime, formatRelative } from '../../lib/util';
import Avatar from '../Avatar';
import { MessageBody } from '../chat/MessageBody';
import Icon, { DocumentIcon } from '../Icon';
import { ConfirmDialog } from '../Modal';
import { useToast } from '../Toast';
import { EmptyState, IconButton, Spinner } from '../ui';
import ReferenceEditor from './ReferenceEditor';
import {
  DueDatePicker,
  ITEM_TYPE,
  PRIORITY,
  PeoplePicker,
  PeopleStack,
  PriorityIcon,
  TypeIcon,
  isOverdue,
  useMemberMap,
} from './projectUi';

export interface ProjectNavigation {
  onOpenDocument: (id: string) => void;
  onOpenSpreadsheet: (id: string) => void;
  onOpenChannel: (id: string) => void;
  onOpenWorkItem: (item: { id: string; projectId: string }) => void;
}

const FIELD =
  'w-full rounded-md border border-transparent bg-transparent px-2 py-1 text-sm outline-none ' +
  'hover:border-[var(--color-line)] focus:border-[var(--color-accent)] disabled:hover:border-transparent';

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
  const toast = useToast();
  const [title, setTitle] = useState(item.title);
  const [editingDescription, setEditingDescription] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
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

  function commitTitle() {
    const trimmed = title.trim();
    if (!trimmed) setTitle(item.title);
    else if (trimmed !== item.title) patch({ title: trimmed });
  }

  function copyLink() {
    const url = `${window.location.origin}/w/${workspaceId}/p/${project.id}/${item.id}`;
    void navigator.clipboard?.writeText(url).then(
      () => toast(`Link to ${item.key} copied`),
      () => toast('Could not copy the link', 'error'),
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-11 shrink-0 items-center gap-1 border-b border-[var(--color-line)] px-3">
        <TypeIcon type={item.type} />
        <span className="ml-1 text-sm font-medium text-[var(--color-muted)]">{item.key}</span>
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
                .filter((s) => canMoveTo(project, item.type, item.statusId, s.id))
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
            <select
              value={item.type}
              disabled={!canEdit}
              onChange={(e) => patch({ type: e.target.value as WorkItemType })}
              className={cx(FIELD, 'cursor-pointer disabled:cursor-default')}
              aria-label="Type"
            >
              {WORK_ITEM_TYPES.map((t) => (
                <option key={t} value={t}>
                  {ITEM_TYPE[t].label}
                </option>
              ))}
            </select>
          </Property>
          {project.roles.map((role) => (
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

        <Backlinks itemId={item.id} navigation={navigation} />

        <Timeline
          workspaceId={workspaceId}
          item={item}
          memberMap={memberMap}
          selfId={selfId}
          canEdit={canEdit}
          navigation={navigation}
        />

        <p className="mt-6 text-xs text-[var(--color-muted)]">
          Created by {item.createdBy?.name ?? 'someone'} {formatRelative(item.createdAt)}
          {item.completedAt && ` · done ${formatRelative(item.completedAt)}`}
        </p>
      </div>

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

  function change(userIds: string[]) {
    setRole.mutate(
      { itemId: item.id, roleId: role.id, userIds },
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
          {holders.length === 0 ? (
            <span className="text-[var(--color-muted)]">{canEdit ? 'Add someone' : 'Nobody'}</span>
          ) : holders.length === 1 ? (
            <>
              <PeopleStack userIds={holders} members={memberMap} />
              <span className="truncate">{memberMap.get(holders[0])?.name ?? 'Former member'}</span>
            </>
          ) : (
            <>
              <PeopleStack userIds={holders} members={memberMap} max={5} />
              <span className="truncate text-xs text-[var(--color-muted)]">{holders.length} people</span>
            </>
          )}
        </button>
        {canEdit && !holders.includes(selfId) && (
          <button
            onClick={() => change(role.multiple ? [...holders, selfId] : [selfId])}
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
          multiple={role.multiple}
          onChange={change}
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

type Entry = { kind: 'comment'; at: string; comment: WorkItemComment } | { kind: 'activity'; at: string; activity: WorkItemActivity };

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
  const entries: Entry[] = [
    ...(timeline.data?.comments ?? []).map((comment): Entry => ({ kind: 'comment', at: comment.createdAt, comment })),
    ...(timeline.data?.activity ?? []).map((activity): Entry => ({ kind: 'activity', at: activity.createdAt, activity })),
  ].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());

  const name = (id: string) => memberMap.get(id)?.name ?? references?.members.find((m) => m.id === id)?.name ?? 'someone';

  return (
    <>
      <Heading count={timeline.data?.comments.length}>Activity</Heading>
      {timeline.isLoading ? (
        <Spinner />
      ) : (
        <ol className="space-y-3">
          {entries.map((entry) =>
            entry.kind === 'activity' ? (
              <li key={entry.activity.id} className="flex items-start gap-2 pl-1 text-xs text-[var(--color-muted)]">
                <Icon name="clock-history" className="mt-0.5 shrink-0" />
                <span className="min-w-0 flex-1">
                  <span className="font-medium text-[var(--color-ink)]">{entry.activity.actor?.name ?? 'Someone'}</span>{' '}
                  {describeActivity(entry.activity, name)}
                </span>
                <span className="shrink-0" title={formatDateTime(entry.at)}>
                  {formatRelative(entry.at)}
                </span>
              </li>
            ) : (
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
            ),
          )}
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
    case 'role': {
      const parts: string[] = [];
      if (activity.added.length) parts.push(`made ${activity.added.map(name).join(', ')} ${activity.role}`);
      if (activity.removed.length) parts.push(`removed ${activity.removed.map(name).join(', ')} as ${activity.role}`);
      return parts.join(' and ');
    }
  }
}
