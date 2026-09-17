import { useState } from 'react';
import {
  useDeleteWorkspace,
  useSetWorkspaceAvatar,
  useUpdateWorkspace,
  type WorkspaceSummary,
} from '../api/hooks';
import { squareImage } from '../lib/images';
import { cx } from '../lib/util';
import { ConfirmDialog } from './Modal';
import { FIELD, PictureField, Section } from './SettingsParts';
import { useToast } from './Toast';
import { Button } from './ui';
import WorkspaceIcon from './WorkspaceIcon';

/**
 * The workspace's name, icon and picture, its details, and deleting it. In the
 * Access app, beside who is in the workspace and which apps it uses.
 */
export default function WorkspaceSettings({
  workspace,
  canManage,
  onDeleted,
}: {
  workspace: WorkspaceSummary;
  canManage: boolean;
  onDeleted: () => void;
}) {
  const updateWorkspace = useUpdateWorkspace(workspace.id);
  const deleteWorkspace = useDeleteWorkspace();
  const setPicture = useSetWorkspaceAvatar(workspace.id);
  const toast = useToast();

  const [name, setName] = useState(workspace.name);
  const [icon, setIcon] = useState(workspace.icon ?? '');
  const [confirming, setConfirming] = useState(false);

  const dirty = name.trim() !== workspace.name || icon.trim() !== (workspace.icon ?? '');

  async function savePicture(file: File | null) {
    try {
      await setPicture.mutateAsync(file ? await squareImage(file) : null);
      toast(file ? 'Workspace picture updated' : 'Workspace picture removed');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not update the workspace picture', 'error');
    }
  }

  function save(e: React.FormEvent) {
    e.preventDefault();
    updateWorkspace.mutate(
      { name: name.trim(), icon: icon.trim() || null },
      {
        onSuccess: () => toast('Workspace updated'),
        onError: (err) =>
          toast(err instanceof Error ? err.message : 'Could not update workspace', 'error'),
      },
    );
  }

  return (
    <>
      <Section
        title="General"
        hint={canManage ? undefined : 'Only an owner or admin can change these.'}
      >
        <div className="mb-3">
          <PictureField
            preview={
              <WorkspaceIcon
                name={name || workspace.name}
                icon={icon.trim() || null}
                avatarUrl={workspace.avatarUrl}
                size="lg"
              />
            }
            hasPicture={Boolean(workspace.avatarUrl)}
            pending={setPicture.isPending}
            disabled={!canManage}
            onPick={(file) => void savePicture(file)}
            onRemove={() => void savePicture(null)}
          />
        </div>
        <form onSubmit={save} className="space-y-2">
          <div className="flex gap-2">
            <label className="block w-16">
              <span className="mb-1 block text-xs text-[var(--color-muted)]">Icon</span>
              <input
                className={cx(FIELD, 'text-center')}
                value={icon}
                maxLength={2}
                disabled={!canManage}
                onChange={(e) => setIcon(e.target.value)}
                placeholder="—"
                aria-label="Workspace icon (optional)"
              />
            </label>
            <label className="block min-w-0 flex-1">
              <span className="mb-1 block text-xs text-[var(--color-muted)]">Name</span>
              <input
                className={FIELD}
                value={name}
                disabled={!canManage}
                onChange={(e) => setName(e.target.value)}
                required
              />
            </label>
          </div>
          {canManage && (
            <div className="flex items-center gap-2">
              <Button
                variant="primary"
                type="submit"
                className="text-xs"
                disabled={!dirty || updateWorkspace.isPending}
              >
                {updateWorkspace.isPending ? 'Saving…' : 'Save workspace'}
              </Button>
              {icon.trim() && (
                <Button variant="ghost" type="button" className="text-xs" onClick={() => setIcon('')}>
                  Remove icon
                </Button>
              )}
            </div>
          )}
        </form>
      </Section>

      <Section title="Details">
        <dl className="space-y-1 text-xs">
          <Row label="Your role" value={workspace.role} />
          <Row label="Documents" value={String(workspace.documentCount)} />
          <Row label="Members" value={String(workspace.memberCount)} />
          <Row label="Slug" value={workspace.slug} />
        </dl>
      </Section>

      {/* Deleting is owner-only, and the API refuses your last workspace. */}
      {workspace.role === 'owner' && (
        <Section title="Danger zone">
          <Button variant="danger" className="text-xs" onClick={() => setConfirming(true)}>
            Delete this workspace
          </Button>
        </Section>
      )}

      {confirming && (
        <ConfirmDialog
          title={`Delete "${workspace.name}"?`}
          description={`This permanently removes ${workspace.documentCount} document(s), every folder and tag, and revokes access for all ${workspace.memberCount} member(s). It cannot be undone.`}
          confirmLabel="Delete workspace"
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false);
            deleteWorkspace.mutate(workspace.id, {
              onSuccess: () => {
                toast(`Deleted "${workspace.name}"`);
                onDeleted();
              },
              onError: (err) =>
                toast(err instanceof Error ? err.message : 'Could not delete workspace', 'error'),
            });
          }}
        />
      )}
    </>
  );
}

const Row = ({ label, value }: { label: string; value: string }) => (
  <div className="flex justify-between gap-2">
    <dt className="text-[var(--color-muted)]">{label}</dt>
    <dd className="truncate">{value}</dd>
  </div>
);
