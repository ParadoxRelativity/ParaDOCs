import { useState, type KeyboardEvent } from 'react';
import { TAG_COLORS, type Tag } from '@paradocs/shared';
import { useDeleteTag, useTags, useUpdateTag } from '../api/hooks';
import { cx } from '../lib/util';
import Icon from './Icon';
import { Modal } from './Modal';
import { useToast } from './Toast';
import { Button, IconButton, InlineInput, TagChip } from './ui';

/**
 * Renaming, recolouring and deleting a workspace's tags. Adding one happens
 * where it is used, on a document, so there is no "new tag" here.
 */
export default function ManageTagsDialog({
  workspaceId,
  onClose,
}: {
  workspaceId: string;
  onClose: () => void;
}) {
  const tags = useTags(workspaceId);
  const list = tags.data ?? [];

  return (
    <Modal
      title="Manage tags"
      description="Renaming or recolouring a tag changes it on every document that has it."
      onClose={onClose}
      footer={
        <Button variant="subtle" className="text-xs" onClick={onClose}>
          Done
        </Button>
      }
    >
      {tags.data && list.length === 0 ? (
        <p className="py-6 text-center text-xs text-[var(--color-muted)]">
          No tags yet. Add one from a document's details.
        </p>
      ) : (
        <ul className="scroll-thin -mx-1 max-h-80 overflow-y-auto">
          {list.map((tag) => (
            <TagRow key={tag.id} tag={tag} workspaceId={workspaceId} />
          ))}
        </ul>
      )}
    </Modal>
  );
}

/**
 * Escape inside a row cancels what the row is doing. The dialog listens for
 * Escape on the window, so it has to be kept from getting there too.
 */
function swallowEscape(e: KeyboardEvent, cancel: () => void) {
  if (e.key !== 'Escape') return;
  e.preventDefault();
  e.nativeEvent.stopPropagation();
  cancel();
}

function TagRow({ tag, workspaceId }: { tag: Tag; workspaceId: string }) {
  const updateTag = useUpdateTag(workspaceId);
  const deleteTag = useDeleteTag(workspaceId);
  const toast = useToast();
  const [mode, setMode] = useState<'view' | 'rename' | 'color' | 'delete'>('view');
  const count = tag.documentCount ?? 0;

  function update(patch: { name?: string; color?: string }) {
    updateTag.mutate(
      { id: tag.id, ...patch },
      { onError: (err) => toast(err instanceof Error ? err.message : 'Could not update tag', 'error') },
    );
  }

  function rename(name: string) {
    setMode('view');
    if (name !== tag.name) update({ name });
  }

  function remove() {
    deleteTag.mutate(tag.id, {
      onSuccess: () => toast(`Deleted tag "${tag.name}"`),
      onError: (err) => toast(err instanceof Error ? err.message : 'Could not delete tag', 'error'),
    });
  }

  if (mode === 'delete') {
    return (
      <li className="rounded-md bg-red-500/10 px-2 py-2">
        <p className="text-sm">
          Delete <span className="font-medium">{tag.name}</span>?
        </p>
        <p className="mt-0.5 text-xs text-[var(--color-muted)]">
          {count
            ? `It comes off ${count} ${count === 1 ? 'document' : 'documents'}; the documents themselves stay.`
            : 'No documents you can see have it.'}
        </p>
        <div className="mt-2 flex justify-end gap-2" onKeyDown={(e) => swallowEscape(e, () => setMode('view'))}>
          <Button variant="subtle" className="text-xs" onClick={() => setMode('view')}>
            Cancel
          </Button>
          <button
            autoFocus
            onClick={remove}
            disabled={deleteTag.isPending}
            className="rounded-md bg-red-600 px-3 py-1 text-xs font-medium text-white hover:bg-red-500 disabled:opacity-50"
          >
            Delete tag
          </button>
        </div>
      </li>
    );
  }

  return (
    <li className="group rounded-md px-1 py-1 hover:bg-[var(--color-surface)]">
      <div className="flex items-center gap-2">
        <button
          onClick={() => setMode(mode === 'color' ? 'view' : 'color')}
          aria-label={`Change colour of ${tag.name}`}
          title="Change colour"
          className="grid h-7 w-7 shrink-0 place-items-center rounded-md hover:bg-[var(--color-line)]"
        >
          <span className="h-3 w-3 rounded-full" style={{ background: tag.color }} />
        </button>

        <div className="min-w-0 flex-1">
          {mode === 'rename' ? (
            <div onKeyDown={(e) => swallowEscape(e, () => {})}>
              <InlineInput
                defaultValue={tag.name}
                onCommit={rename}
                onCancel={() => setMode('view')}
                className="py-0.5"
              />
            </div>
          ) : (
            <button onClick={() => setMode('rename')} className="max-w-full truncate text-left" title="Rename">
              <TagChip name={tag.name} color={tag.color} />
            </button>
          )}
        </div>

        <span className="shrink-0 text-xs tabular-nums text-[var(--color-muted)]" title="Documents with this tag">
          {count}
        </span>
        <IconButton label={`Rename ${tag.name}`} onClick={() => setMode('rename')}>
          <Icon name="pencil" />
        </IconButton>
        <IconButton
          label={`Delete ${tag.name}`}
          onClick={() => setMode('delete')}
          className="hover:text-red-500"
        >
          <Icon name="trash" />
        </IconButton>
      </div>

      {mode === 'color' && (
        <div
          className="mt-1 flex flex-wrap gap-1.5 pb-1 pl-9"
          onKeyDown={(e) => swallowEscape(e, () => setMode('view'))}
        >
          {TAG_COLORS.map((color) => (
            <button
              key={color}
              onClick={() => {
                setMode('view');
                if (color !== tag.color) update({ color });
              }}
              aria-label={`Colour ${color}`}
              aria-pressed={color === tag.color}
              className={cx(
                'h-5 w-5 rounded-full ring-offset-2 ring-offset-[var(--color-raised)]',
                color === tag.color && 'ring-2',
              )}
              style={{ background: color, ['--tw-ring-color' as string]: color }}
            />
          ))}
        </div>
      )}
    </li>
  );
}
