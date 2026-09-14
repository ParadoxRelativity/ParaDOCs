import { useState } from 'react';
import type { SheetInfo } from '@paradocs/shared';
import { cx } from '../../lib/util';
import { ConfirmDialog } from '../Modal';
import Icon from '../Icon';

/**
 * The strip of sheet tabs under the grid, where Excel and Sheets both put it.
 *
 * Double-click a tab to rename it, right-click for the rest, drag to reorder.
 * Renaming and deleting are not cosmetic: every formula in the workbook that
 * names the sheet follows a rename, and shows #REF! after a delete, which is
 * why deleting asks first.
 */
export default function SheetTabs({
  sheets,
  activeId,
  canEdit,
  onSelect,
  onAdd,
  onRename,
  onDelete,
  onMove,
  onProblem,
}: {
  sheets: SheetInfo[];
  activeId: string;
  canEdit: boolean;
  onSelect: (id: string) => void;
  onAdd: () => void;
  /** Returns why the rename was refused, or null when it went through. */
  onRename: (id: string, name: string) => string | null;
  onDelete: (id: string) => void;
  onMove: (id: string, index: number) => void;
  onProblem: (message: string) => void;
}) {
  const [renaming, setRenaming] = useState<{ id: string; draft: string } | null>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<SheetInfo | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);

  function commitRename() {
    if (!renaming) return;
    const problem = onRename(renaming.id, renaming.draft);
    if (problem) {
      onProblem(problem);
      return;
    }
    setRenaming(null);
  }

  return (
    <div
      role="tablist"
      aria-label="Sheets"
      className="scroll-thin flex h-8 shrink-0 items-stretch gap-0.5 overflow-x-auto border-t border-[var(--color-line)] bg-[var(--color-surface)] px-1.5"
    >
      {canEdit && (
        <button
          onClick={onAdd}
          title="Add a sheet"
          aria-label="Add a sheet"
          className="my-1 grid w-7 shrink-0 place-items-center rounded text-[var(--color-muted)] hover:bg-[var(--color-line)]/60 hover:text-[var(--color-ink)]"
        >
          <Icon name="plus-lg" />
        </button>
      )}

      {sheets.map((entry, index) => {
        const active = entry.id === activeId;
        return (
          <div
            key={entry.id}
            className={cx('relative flex shrink-0 items-stretch', dragging === entry.id && 'opacity-40')}
            draggable={canEdit && !renaming}
            onDragStart={(event) => {
              event.dataTransfer.effectAllowed = 'move';
              event.dataTransfer.setData('text/plain', entry.id);
              setDragging(entry.id);
            }}
            onDragEnd={() => setDragging(null)}
            onDragOver={(event) => canEdit && event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              const id = event.dataTransfer.getData('text/plain');
              if (id && id !== entry.id) onMove(id, index);
              setDragging(null);
            }}
          >
            {renaming?.id === entry.id ? (
              <input
                autoFocus
                value={renaming.draft}
                onFocus={(event) => event.currentTarget.select()}
                onChange={(event) => setRenaming({ id: entry.id, draft: event.target.value })}
                onBlur={commitRename}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') commitRename();
                  if (event.key === 'Escape') setRenaming(null);
                }}
                aria-label="Sheet name"
                className="my-1 w-28 rounded border border-[var(--color-accent)] bg-[var(--color-canvas)] px-1.5 text-xs outline-none"
              />
            ) : (
              <button
                role="tab"
                aria-selected={active}
                onClick={() => onSelect(entry.id)}
                onDoubleClick={() => canEdit && setRenaming({ id: entry.id, draft: entry.name })}
                onContextMenu={(event) => {
                  if (!canEdit) return;
                  event.preventDefault();
                  setMenu(menu === entry.id ? null : entry.id);
                }}
                title={canEdit ? `${entry.name} — double-click to rename, right-click for more` : entry.name}
                className={cx(
                  'my-1 max-w-40 truncate rounded px-3 text-xs',
                  active
                    ? 'bg-[var(--color-canvas)] font-medium text-[var(--color-ink)] shadow-sm'
                    : 'text-[var(--color-muted)] hover:bg-[var(--color-line)]/50 hover:text-[var(--color-ink)]',
                )}
              >
                {entry.name}
              </button>
            )}

            {menu === entry.id && (
              <>
                <div className="fixed inset-0 z-30" onClick={() => setMenu(null)} />
                <div className="absolute bottom-full left-0 z-40 mb-1 w-40 overflow-hidden rounded-lg border border-[var(--color-line)] bg-[var(--color-raised)] py-1 text-xs shadow-xl">
                  <button
                    onClick={() => {
                      setMenu(null);
                      setRenaming({ id: entry.id, draft: entry.name });
                    }}
                    className="flex w-full px-3 py-1.5 text-left hover:bg-[var(--color-surface)]"
                  >
                    Rename
                  </button>
                  <button
                    disabled={sheets.length <= 1}
                    onClick={() => {
                      setMenu(null);
                      setConfirming(entry);
                    }}
                    className="flex w-full px-3 py-1.5 text-left text-red-500 hover:bg-[var(--color-surface)] disabled:opacity-40"
                  >
                    Delete sheet
                  </button>
                </div>
              </>
            )}
          </div>
        );
      })}

      {confirming && (
        <ConfirmDialog
          title={`Delete "${confirming.name}"?`}
          description="Everything on this sheet is removed. Formulas on other sheets that use it will show #REF!."
          confirmLabel="Delete sheet"
          onCancel={() => setConfirming(null)}
          onConfirm={() => {
            onDelete(confirming.id);
            setConfirming(null);
          }}
        />
      )}
    </div>
  );
}
