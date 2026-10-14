import { useState } from 'react';
import type { Project, ProjectTemplateSummary } from '@paradocs/shared';
import { useProjectTemplates, useTemplateActions } from '../../api/hooks';
import { cx } from '../../lib/util';
import Icon from '../Icon';
import { ConfirmDialog, Modal } from '../Modal';
import { FIELD, Section } from '../SettingsParts';
import { useToast } from '../Toast';
import { Button, IconButton } from '../ui';
import { PROJECT_KIND } from './projectUi';

/** A template's name and description, for one being saved or renamed. */
function TemplateDialog({
  title,
  initial,
  saving,
  onSave,
  onClose,
}: {
  title: string;
  initial: { name: string; description: string };
  saving: boolean;
  onSave: (value: { name: string; description: string }) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description);
  const submit = () => name.trim() && onSave({ name: name.trim(), description: description.trim() });
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <Button variant="subtle" className="text-xs" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" className="text-xs" disabled={!name.trim() || saving} onClick={submit}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <label className="block text-xs text-[var(--color-muted)]">
          Name
          <input
            autoFocus
            value={name}
            maxLength={80}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
            className={cx(FIELD, 'mt-1')}
          />
        </label>
        <label className="block text-xs text-[var(--color-muted)]">
          Description
          <textarea
            value={description}
            maxLength={500}
            rows={2}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What it suits"
            className={cx(FIELD, 'mt-1 resize-y')}
          />
        </label>
      </div>
    </Modal>
  );
}

/**
 * Saves how a project is set up — statuses, roles, workflows, types, board,
 * rules and switches — as a template others can start from. Its work, sprints
 * and who can reach it are left behind.
 */
export function SaveTemplateSection({ project }: { project: Project }) {
  const actions = useTemplateActions(project.workspaceId);
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const noun = PROJECT_KIND[project.kind].label.toLowerCase();
  return (
    <Section
      title="Template"
      hint={`Save how this ${noun} is set up — its statuses, roles, workflows, types, board, rules and switches — to start new ones from. Its work, sprints and permissions are not saved.`}
    >
      <Button variant="subtle" className="text-xs" onClick={() => setSaving(true)}>
        <Icon name="files" /> Save as template
      </Button>
      {saving && (
        <TemplateDialog
          title="Save as template"
          initial={{ name: project.name, description: '' }}
          saving={actions.save.isPending}
          onClose={() => setSaving(false)}
          onSave={(value) =>
            actions.save.mutate(
              { projectId: project.id, ...value },
              {
                onSuccess: () => {
                  setSaving(false);
                  toast(`Saved ${value.name}. Pick it when starting a new ${noun}.`);
                },
                onError: (err) => toast(err instanceof Error ? err.message : 'Could not save the template', 'error'),
              },
            )
          }
        />
      )}
    </Section>
  );
}

/** The templates a workspace has saved, to rename or delete. Projects made from one are not touched. */
export function TemplateList({ workspaceId }: { workspaceId: string }) {
  const templates = (useProjectTemplates(workspaceId).data ?? []).filter((t) => !t.builtIn);
  const actions = useTemplateActions(workspaceId);
  const toast = useToast();
  const [renaming, setRenaming] = useState<ProjectTemplateSummary | null>(null);
  const [removing, setRemoving] = useState<ProjectTemplateSummary | null>(null);
  if (templates.length === 0) return null;

  return (
    <>
      <h2 className="mb-1.5 mt-8 text-xs font-semibold uppercase tracking-wide text-[var(--color-muted)]">Saved templates</h2>
      <ul className="divide-y divide-[var(--color-line)] rounded-xl border border-[var(--color-line)]">
        {templates.map((t) => (
          <li key={t.id} className="flex items-center gap-2 px-3 py-2">
            <Icon name={PROJECT_KIND[t.kind].icon} className="text-[var(--color-muted)]" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{t.name}</span>
              {t.description && <span className="block truncate text-xs text-[var(--color-muted)]">{t.description}</span>}
            </span>
            {t.canManage && (
              <>
                <IconButton label={`Rename ${t.name}`} onClick={() => setRenaming(t)}>
                  <Icon name="pencil" />
                </IconButton>
                <IconButton label={`Delete ${t.name}`} onClick={() => setRemoving(t)}>
                  <Icon name="trash3" />
                </IconButton>
              </>
            )}
          </li>
        ))}
      </ul>
      {renaming && (
        <TemplateDialog
          title="Rename template"
          initial={{ name: renaming.name, description: renaming.description }}
          saving={actions.update.isPending}
          onClose={() => setRenaming(null)}
          onSave={(value) =>
            actions.update.mutate(
              { id: renaming.id, ...value },
              {
                onSuccess: () => setRenaming(null),
                onError: (err) => toast(err instanceof Error ? err.message : 'Could not rename the template', 'error'),
              },
            )
          }
        />
      )}
      {removing && (
        <ConfirmDialog
          title={`Delete ${removing.name}?`}
          description="Projects already started from it keep their setup."
          onConfirm={() => {
            actions.remove.mutate(removing.id, {
              onError: (err) => toast(err instanceof Error ? err.message : 'Could not delete the template', 'error'),
            });
            setRemoving(null);
          }}
          onCancel={() => setRemoving(null)}
        />
      )}
    </>
  );
}
