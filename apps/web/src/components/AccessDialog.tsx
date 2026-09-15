import { useEffect, useRef, useState } from 'react';
import type { AccessMode, Permission } from '@paradocs/shared';
import { useAccessSettings, useMembers, useTeams, useUpdateAccess, type AccessTarget } from '../api/hooks';
import { cx } from '../lib/util';
import Avatar from './Avatar';
import Icon from './Icon';
import { Modal } from './Modal';
import { FIELD } from './SettingsParts';
import { useToast } from './Toast';
import { Button, IconButton, Spinner } from './ui';

export interface NamedAccessTarget extends AccessTarget {
  /** How the thing is shown in the dialog's title: a document's title, `#general`. */
  name: string;
  /** Voice channels speak and listen rather than post and read. */
  channelKind?: 'text' | 'voice';
}

interface Line {
  kind: 'team' | 'user';
  id: string;
  permission: Permission;
}

/** Whether a setting keeps anyone out, which is what earns something a lock. */
function isLocked(access: AccessMode | undefined): access is 'allow' | 'deny' {
  return access === 'allow' || access === 'deny';
}

/** Marks something locked, so it is plain at a glance that not everyone can see it. */
export function LockMark({ access }: { access: AccessMode | undefined }) {
  if (!isLocked(access)) return null;
  return (
    <span
      title={access === 'allow' ? 'Only some people can see this' : 'Some people cannot see this'}
      className="shrink-0 text-[10px] text-[var(--color-muted)]"
    >
      <Icon name="lock-fill" />
    </span>
  );
}

/** What each permission is called for this kind of thing, on each kind of list. */
function permissionLabels(target: NamedAccessTarget, mode: 'allow' | 'deny'): { value: Permission; label: string }[] {
  const [view, edit] =
    target.kind !== 'channel'
      ? ['Can view', 'Can edit']
      : target.channelKind === 'voice'
        ? ['Listen only', 'Can speak']
        : ['Read only', 'Can post'];
  return mode === 'allow'
    ? [
        { value: 'edit', label: edit },
        { value: 'view', label: view },
      ]
    : [
        { value: 'none', label: 'No access' },
        { value: 'view', label: view },
      ];
}

/** A permission that means something on the new kind of list, keeping what it can. */
function fitPermission(permission: Permission, mode: 'allow' | 'deny'): Permission {
  if (mode === 'allow') return permission === 'none' ? 'view' : permission;
  return permission === 'edit' ? 'none' : permission;
}

const KIND_NOUN = { folder: 'folder', document: 'document', channel: 'channel' } as const;

/**
 * Who can reach a folder, document or channel. Owners and admins set it here;
 * nobody else sees the controls.
 *
 * The choice is between leaving it open, following its folder, or keeping a
 * list — of who is let in, or of who is kept out — where each line says how
 * much that team or person gets.
 */
export function AccessDialog({
  workspaceId,
  target,
  onClose,
}: {
  workspaceId: string;
  target: NamedAccessTarget;
  onClose: () => void;
}) {
  const settings = useAccessSettings(target);
  const teams = useTeams(workspaceId);
  const members = useMembers(workspaceId);
  const update = useUpdateAccess(target);
  const toast = useToast();

  const [mode, setMode] = useState<AccessMode>(target.kind === 'channel' ? 'open' : 'inherit');
  const [lines, setLines] = useState<Line[]>([]);
  // Filled from the server once; after that the dialog holds the draft.
  const loaded = useRef(false);
  useEffect(() => {
    if (loaded.current || !settings.data) return;
    loaded.current = true;
    setMode(settings.data.access);
    setLines(
      settings.data.entries.map((entry) => ({
        kind: entry.subject.kind,
        id: entry.subject.id,
        permission: entry.permission,
      })),
    );
  }, [settings.data]);

  const noun = KIND_NOUN[target.kind];
  const listing = isLocked(mode);
  const inherited = settings.data?.inheritedFrom ?? null;

  const modes: { id: AccessMode; label: string; hint: string }[] = [
    ...(target.kind === 'channel'
      ? []
      : [
          {
            id: 'inherit' as const,
            label: 'Same as its folder',
            hint: inherited
              ? `Follows "${inherited.name}", which ${
                  inherited.access === 'allow'
                    ? 'only lets in who it lists'
                    : inherited.access === 'deny'
                      ? 'keeps out who it lists'
                      : 'is open to everyone'
                }.`
              : 'No folder above it has a setting, so everyone in the workspace can reach it.',
          },
        ]),
    {
      id: 'open',
      label: 'Everyone in the workspace',
      hint:
        target.kind === 'folder'
          ? 'Whatever is inside follows this, unless it has a setting of its own.'
          : `Anyone in the workspace can ${target.kind === 'channel' ? 'join' : 'open'} it.`,
    },
    {
      id: 'allow',
      label: 'Only who is listed',
      hint: `Nobody else can see this ${noun} at all.`,
    },
    {
      id: 'deny',
      label: 'Everyone except who is listed',
      hint: `Those listed lose access, or can only ${target.kind === 'channel' ? (target.channelKind === 'voice' ? 'listen' : 'read') : 'view'}.`,
    },
  ];

  function chooseMode(next: AccessMode) {
    setMode(next);
    if (isLocked(next)) setLines((current) => current.map((line) => ({ ...line, permission: fitPermission(line.permission, next) })));
  }

  function add(value: string) {
    if (!isLocked(mode)) return;
    const [kind, id] = value.split(':') as ['team' | 'user', string];
    if (!id || lines.some((line) => line.id === id)) return;
    setLines((current) => [...current, { kind, id, permission: mode === 'allow' ? 'edit' : 'none' }]);
  }

  async function save() {
    try {
      await update.mutateAsync({
        access: mode,
        entries: listing
          ? lines.map((line) =>
              line.kind === 'team'
                ? { teamId: line.id, permission: line.permission }
                : { userId: line.id, permission: line.permission },
            )
          : [],
      });
      toast(`Access to ${target.name} updated`);
      onClose();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not update access', 'error');
    }
  }

  const teamList = teams.data ?? [];
  // Owners and admins are never kept out, so listing them would change nothing.
  const people = (members.data ?? []).filter((m) => m.role !== 'owner' && m.role !== 'admin');
  const teamName = (id: string) => teamList.find((t) => t.id === id)?.name ?? 'Deleted team';
  const person = (id: string) => (members.data ?? []).find((m) => m.userId === id);
  const unlistedTeams = teamList.filter((t) => !lines.some((line) => line.id === t.id));
  const unlistedPeople = people.filter((m) => !lines.some((line) => line.id === m.userId));

  return (
    <Modal
      title={`Who can see ${target.name}`}
      onClose={onClose}
      wide
      footer={
        <>
          <Button variant="subtle" className="text-xs" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            className="text-xs"
            onClick={() => void save()}
            disabled={!settings.data || update.isPending}
          >
            {update.isPending ? 'Saving…' : 'Save'}
          </Button>
        </>
      }
    >
      {settings.isLoading ? (
        <Spinner />
      ) : settings.error ? (
        <p className="text-sm text-red-500">{(settings.error as Error).message}</p>
      ) : (
        <div className="space-y-4">
          <div role="radiogroup" aria-label="Access" className="grid grid-cols-2 gap-2">
            {modes.map((option) => (
              <button
                key={option.id}
                role="radio"
                aria-checked={mode === option.id}
                onClick={() => chooseMode(option.id)}
                className={cx(
                  'rounded-lg border px-3 py-2 text-left transition-colors',
                  mode === option.id
                    ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)]'
                    : 'border-[var(--color-line)] hover:bg-[var(--color-surface)]',
                )}
              >
                <span className="block text-sm font-medium">
                  {isLocked(option.id) && <Icon name="lock-fill" className="mr-1 text-xs" />}
                  {option.label}
                </span>
                <span className="mt-0.5 block text-xs text-[var(--color-muted)]">{option.hint}</span>
              </button>
            ))}
          </div>

          {listing && (
            <section>
              <div className="mb-1.5 flex items-center justify-between gap-2">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--color-muted)]">
                  {mode === 'allow' ? 'Let in' : 'Kept out'}
                </h3>
                <select
                  className={cx(FIELD, 'w-60 py-1 text-xs')}
                  value=""
                  onChange={(e) => add(e.target.value)}
                  aria-label="Add a team or person"
                >
                  <option value="">Add a team or person…</option>
                  {unlistedTeams.length > 0 && (
                    <optgroup label="Teams">
                      {unlistedTeams.map((team) => (
                        <option key={team.id} value={`team:${team.id}`}>
                          {team.name} ({team.memberIds.length})
                        </option>
                      ))}
                    </optgroup>
                  )}
                  {unlistedPeople.length > 0 && (
                    <optgroup label="People">
                      {unlistedPeople.map((member) => (
                        <option key={member.userId} value={`user:${member.userId}`}>
                          {member.name}
                        </option>
                      ))}
                    </optgroup>
                  )}
                </select>
              </div>

              {lines.length === 0 ? (
                <p className="rounded-md border border-dashed border-[var(--color-line)] px-3 py-3 text-center text-xs text-[var(--color-muted)]">
                  {mode === 'allow'
                    ? 'Nobody listed yet, so only owners and admins could see it.'
                    : 'Nobody listed yet, so it stays open to everyone.'}
                </p>
              ) : (
                <ul className="space-y-1">
                  {lines.map((line) => {
                    const member = line.kind === 'user' ? person(line.id) : undefined;
                    return (
                      <li key={line.id} className="flex items-center gap-2">
                        {line.kind === 'team' ? (
                          <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-[var(--color-surface)] text-xs text-[var(--color-muted)]">
                            <Icon name="people-fill" />
                          </span>
                        ) : (
                          <Avatar name={member?.name ?? '?'} url={member?.avatarUrl} seed={line.id} size="lg" />
                        )}
                        <span className="min-w-0 flex-1 truncate text-sm">
                          {line.kind === 'team' ? teamName(line.id) : (member?.name ?? 'Former member')}
                          {line.kind === 'team' && <span className="text-xs text-[var(--color-muted)]"> · team</span>}
                        </span>
                        <select
                          className={cx(FIELD, 'w-32 py-1 text-xs')}
                          value={line.permission}
                          onChange={(e) =>
                            setLines((current) =>
                              current.map((l) => (l.id === line.id ? { ...l, permission: e.target.value as Permission } : l)),
                            )
                          }
                          aria-label="What they may do"
                        >
                          {permissionLabels(target, mode).map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                        <IconButton
                          label="Remove from the list"
                          onClick={() => setLines((current) => current.filter((l) => l.id !== line.id))}
                        >
                          <Icon name="x-lg" />
                        </IconButton>
                      </li>
                    );
                  })}
                </ul>
              )}
              <p className="mt-2 text-xs text-[var(--color-muted)]">
                Someone listed by name gets exactly what their line says. Otherwise they get the most any of their teams
                is given.
              </p>
            </section>
          )}

          <p className="border-t border-[var(--color-line)] pt-3 text-xs text-[var(--color-muted)]">
            Owners and admins can always see and change everything.
            {target.kind !== 'channel' && ' A workspace viewer can only ever view, whatever a list gives them.'}
          </p>
        </div>
      )}
    </Modal>
  );
}
