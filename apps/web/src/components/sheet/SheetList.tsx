import { useRef, useState } from 'react';
import type { SpreadsheetSummary } from '@paradocs/shared';
import { useCreateSpreadsheet, useDeleteSpreadsheet, useSpreadsheets } from '../../api/hooks';
import { MODIFIER, asksForNewTab, openTab } from '../../lib/tabs';
import { rememberImport } from '../../lib/sheetImport';
import { cx, formatRelative } from '../../lib/util';
import { ConfirmDialog } from '../Modal';
import { useToast } from '../Toast';
import { IconButton, Spinner } from '../ui';
import Icon from '../Icon';

/**
 * The Sheets app's side of the sidebar: every spreadsheet in the workspace,
 * most recently touched first.
 *
 * A flat list on purpose. Documents have folders because a knowledge base
 * grows into a shape; a workspace's spreadsheets are usually few and are found
 * by name, and a folder tree to maintain would be structure nobody asked for.
 */
export function SheetList({
  workspaceId,
  activeSheetId,
  canEdit,
  onSelect,
  onDeleted,
}: {
  workspaceId: string;
  activeSheetId: string | null;
  canEdit: boolean;
  onSelect: (id: string) => void;
  /** So whatever is showing the spreadsheet can move off it once it is gone. */
  onDeleted: (id: string) => void;
}) {
  const sheets = useSpreadsheets(workspaceId);
  const create = useCreateSpreadsheet(workspaceId);
  const remove = useDeleteSpreadsheet(workspaceId);
  const toast = useToast();
  const [confirming, setConfirming] = useState<SpreadsheetSummary | null>(null);
  const [importing, setImporting] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  /**
   * Makes a spreadsheet from an Excel file. The file is read first, so a file
   * that will not open never leaves an empty spreadsheet behind; its contents
   * then wait for the new spreadsheet's grid to open and claim them.
   */
  async function importFile(file: File) {
    setImporting(true);
    try {
      const { importXlsx } = await import('../../lib/xlsx');
      const workbook = await importXlsx(file);
      const sheet = await create.mutateAsync({ title: workbook.title });
      rememberImport(sheet.id, workbook);
      onSelect(sheet.id);
      if (workbook.flattenedFormulas > 0) {
        toast(`${workbook.flattenedFormulas} formula(s) came in as their last value, because the file did not include their text.`);
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not import that file', 'error');
    } finally {
      setImporting(false);
    }
  }

  async function newSheet() {
    try {
      const sheet = await create.mutateAsync({});
      onSelect(sheet.id);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not create the spreadsheet', 'error');
    }
  }

  const list = sheets.data ?? [];

  return (
    <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-2 pb-2">
      <div className="mb-1 flex items-center justify-between px-2 pt-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">
          Spreadsheets
        </span>
        {canEdit && (
          <span className="flex items-center">
            <IconButton
              label={importing ? 'Importing…' : 'Import from Excel (.xlsx)'}
              onClick={() => fileInput.current?.click()}
              disabled={importing}
            >
              <Icon name="upload" />
            </IconButton>
            <IconButton label="New spreadsheet" onClick={() => void newSheet()} disabled={create.isPending}>
              <Icon name="plus-lg" />
            </IconButton>
            <input
              ref={fileInput}
              type="file"
              accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              className="hidden"
              aria-label="Excel file to import"
              onChange={(event) => {
                const file = event.target.files?.[0];
                // Cleared so choosing the same file again still fires a change.
                event.target.value = '';
                if (file) void importFile(file);
              }}
            />
          </span>
        )}
      </div>

      {sheets.isLoading ? (
        <Spinner />
      ) : list.length === 0 ? (
        <div className="px-2 py-6 text-center">
          <p className="text-xs text-[var(--color-muted)]">No spreadsheets yet.</p>
          {canEdit && (
            <button
              onClick={() => void newSheet()}
              className="mt-2 text-xs font-medium text-[var(--color-accent)] hover:underline"
            >
              Create one
            </button>
          )}
        </div>
      ) : (
        list.map((sheet) => {
          const active = sheet.id === activeSheetId;
          const path = `/w/${workspaceId}/s/${sheet.id}`;
          return (
            <div
              key={sheet.id}
              className={cx(
                'group flex items-center gap-1 rounded-md pr-1',
                active ? 'bg-[var(--color-accent-soft)]' : 'hover:bg-[var(--color-line)]/50',
              )}
            >
              <button
                title={`${sheet.title} — hold ${MODIFIER} to open in a new tab`}
                onClick={(event) => {
                  if (asksForNewTab(event)) openTab(path, sheet.title);
                  else onSelect(sheet.id);
                }}
                onAuxClick={(event) => {
                  if (event.button !== 1) return;
                  event.preventDefault();
                  openTab(path, sheet.title, { background: true });
                }}
                className={cx(
                  'flex min-w-0 flex-1 items-center gap-2 py-1.5 pl-2 text-left text-sm',
                  active && 'font-medium text-[var(--color-accent)]',
                )}
              >
                <span className="text-xs">{sheet.icon ?? <Icon name="table" />}</span>
                <span className="min-w-0 flex-1 truncate">{sheet.title}</span>
                <span className="shrink-0 text-[10px] text-[var(--color-muted)] group-hover:hidden">
                  {formatRelative(sheet.updatedAt)}
                </span>
              </button>
              {canEdit && (
                <div className="hidden items-center group-hover:flex">
                  <IconButton label={`Delete ${sheet.title}`} onClick={() => setConfirming(sheet)}>
                    <Icon name="trash3" />
                  </IconButton>
                </div>
              )}
            </div>
          );
        })
      )}

      {confirming && (
        <ConfirmDialog
          title={`Delete "${confirming.title}"?`}
          description="This permanently removes the spreadsheet and everything in it. It cannot be undone."
          confirmLabel="Delete permanently"
          onCancel={() => setConfirming(null)}
          onConfirm={() => {
            const target = confirming;
            setConfirming(null);
            remove.mutate(target.id, {
              onSuccess: () => {
                toast(`Deleted "${target.title}"`);
                onDeleted(target.id);
              },
              onError: (err) =>
                toast(err instanceof Error ? err.message : 'Could not delete the spreadsheet', 'error'),
            });
          }}
        />
      )}
    </div>
  );
}
