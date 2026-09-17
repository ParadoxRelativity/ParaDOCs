import { useState } from 'react';
import { cx } from '../lib/util';
import { Modal } from './Modal';
import { Button } from './ui';

/** What a folder holds, in words: documents in Docs, spreadsheets in Sheets. */
export interface FolderContentsNoun {
  one: string;
  many: string;
  /** Where kept items end up, for the hint on keeping them. */
  keptWhere: string;
  /** What else goes when one is deleted, for the hint on deleting them. */
  alsoLost: string;
}

export const DOCUMENT_NOUN: FolderContentsNoun = {
  one: 'document',
  many: 'documents',
  keptWhere: 'They move to All Documents, unfiled, and keep who can see them.',
  alsoLost: ', with their comments and history',
};

export const SPREADSHEET_NOUN: FolderContentsNoun = {
  one: 'spreadsheet',
  many: 'spreadsheets',
  keptWhere: 'They move out of any folder, and keep who can see them.',
  alsoLost: ' and everything in them',
};

/**
 * Deleting a folder always takes its subfolders with it. What becomes of what
 * is filed inside is asked each time: keeping it is the safe answer, and
 * deleting it is the one that cannot be taken back, so keeping is selected.
 */
export default function DeleteFolderDialog({
  name,
  count,
  noun,
  onCancel,
  onConfirm,
}: {
  name: string;
  /** How many items are filed in the folder and every folder beneath it. */
  count: number;
  noun: FolderContentsNoun;
  onCancel: () => void;
  onConfirm: (deleteContents: boolean) => void;
}) {
  const items = `${count} ${count === 1 ? noun.one : noun.many}`;
  const [deleteContents, setDeleteContents] = useState(false);
  const deleting = count > 0 && deleteContents;

  const options = [
    { value: false, label: `Keep the ${noun.many}`, hint: noun.keptWhere },
    {
      value: true,
      label: `Delete the ${noun.many} too`,
      hint: `Permanently removes ${items}${noun.alsoLost}. This cannot be undone.`,
    },
  ];

  return (
    <Modal
      title={`Delete "${name}"?`}
      description={
        count > 0
          ? `The folder and any subfolders are deleted. They hold ${items}.`
          : `The folder and any subfolders are deleted. There are no ${noun.many} in it.`
      }
      onClose={onCancel}
      footer={
        <>
          <Button variant="subtle" className="text-xs" onClick={onCancel}>
            Cancel
          </Button>
          <button
            autoFocus
            onClick={() => onConfirm(deleting)}
            className="rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-500"
          >
            {deleting ? `Delete folder and ${items}` : 'Delete folder'}
          </button>
        </>
      }
    >
      {count > 0 && (
        <div role="radiogroup" aria-label={`The ${noun.many} inside`} className="space-y-2">
          {options.map((option) => {
            const selected = deleteContents === option.value;
            return (
              <button
                key={option.label}
                role="radio"
                aria-checked={selected}
                onClick={() => setDeleteContents(option.value)}
                className={cx(
                  'block w-full rounded-lg border px-3 py-2 text-left transition-colors',
                  selected
                    ? option.value
                      ? 'border-red-500 bg-red-500/10'
                      : 'border-[var(--color-accent)] bg-[var(--color-accent-soft)]'
                    : 'border-[var(--color-line)] hover:bg-[var(--color-surface)]',
                )}
              >
                <span className={cx('block text-sm font-medium', selected && option.value && 'text-red-500')}>
                  {option.label}
                </span>
                <span className="mt-0.5 block text-xs text-[var(--color-muted)]">{option.hint}</span>
              </button>
            );
          })}
        </div>
      )}
    </Modal>
  );
}
