import { useRef, useState } from 'react';
import type { SheetFolderNode, SpreadsheetSummary } from '@paradocs/shared';
import {
  useCreateFolder,
  useCreateSpreadsheet,
  useDeleteFolder,
  useDeleteSpreadsheet,
  useSheetTree,
  useUpdateFolder,
  useUpdateSpreadsheet,
} from '../../api/hooks';
import { MODIFIER, asksForNewTab, openTab } from '../../lib/tabs';
import { rememberImport } from '../../lib/sheetImport';
import { cx, formatRelative, useLocalStorage } from '../../lib/util';
import { AccessDialog, LockMark, type NamedAccessTarget } from '../AccessDialog';
import DeleteFolderDialog, { SPREADSHEET_NOUN } from '../DeleteFolderDialog';
import { ConfirmDialog, Modal } from '../Modal';
import { FIELD } from '../SettingsParts';
import { useToast } from '../Toast';
import { Button, IconButton, InlineIconNameForm, Spinner } from '../ui';
import Icon from '../Icon';
import SheetContextMenu, { type SheetMenuItem } from './SheetContextMenu';

/** What a dragged spreadsheet carries, so only a spreadsheet can be dropped on a folder. */
const DRAG_TYPE = 'application/x-paradocs-spreadsheet';

/** Spreadsheets in this folder and every folder nested beneath it. */
function sheetIdsDeep(folder: SheetFolderNode): string[] {
  return [...folder.spreadsheets.map((s) => s.id), ...folder.children.flatMap(sheetIdsDeep)];
}

/** Every folder, parents before children, with how deep each one sits. */
function flattenFolders(folders: SheetFolderNode[], depth = 0): { folder: SheetFolderNode; depth: number }[] {
  return folders.flatMap((folder) => [{ folder, depth }, ...flattenFolders(folder.children, depth + 1)]);
}

/** Whether a drag is carrying a spreadsheet, which is all a folder accepts. */
function carriesSheet(event: React.DragEvent): boolean {
  return event.dataTransfer.types.includes(DRAG_TYPE);
}

/**
 * The Sheets app's side of the sidebar: folders of spreadsheets, and below
 * them the spreadsheets filed nowhere, most recently touched first.
 *
 * The folders are the Sheets app's own, not the documents tree: the two apps
 * are shown one at a time, and a workspace may have only one of them on. They
 * lock the way document folders do, and a spreadsheet inherits from its folder
 * the way a document does.
 */
export function SheetList({
  workspaceId,
  activeSheetId,
  canEdit,
  canManageAccess,
  onSelect,
  onDeleted,
}: {
  workspaceId: string;
  activeSheetId: string | null;
  canEdit: boolean;
  /** Owners and admins, who decide who can see each folder and spreadsheet. */
  canManageAccess: boolean;
  onSelect: (id: string) => void;
  /** So whatever is showing the spreadsheet can move off it once it is gone. */
  onDeleted: (id: string) => void;
}) {
  const tree = useSheetTree(workspaceId);
  const create = useCreateSpreadsheet(workspaceId);
  const createFolder = useCreateFolder(workspaceId, 'sheets');
  const move = useUpdateSpreadsheet(workspaceId);
  const toast = useToast();
  const [importing, setImporting] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  /**
   * Where a new folder is being named: `null` for the top level, a folder id for
   * a subfolder, `undefined` when nothing is being created.
   */
  const [creatingIn, setCreatingIn] = useState<string | null | undefined>(undefined);
  const [securing, setSecuring] = useState<NamedAccessTarget | null>(null);
  const [moving, setMoving] = useState<SpreadsheetSummary | null>(null);
  const [unfiledDrop, setUnfiledDrop] = useState(false);

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

  async function newSheet(folderId: string | null = null) {
    try {
      const sheet = await create.mutateAsync({ folderId });
      onSelect(sheet.id);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not create the spreadsheet', 'error');
    }
  }

  function commitFolder(name: string, icon: string | null, parentId: string | null) {
    createFolder.mutate(
      { name, icon, parentId },
      { onError: (err) => toast(err instanceof Error ? err.message : 'Could not create the folder', 'error') },
    );
    setCreatingIn(undefined);
  }

  function moveSheet(sheetId: string, folderId: string | null) {
    const filed = flattenFolders(tree.data?.folders ?? []).flatMap(({ folder }) => folder.spreadsheets);
    const sheet = [...filed, ...(tree.data?.unfiled ?? [])].find((s) => s.id === sheetId);
    // Dropped back where it already was.
    if (!sheet || sheet.folderId === folderId) return;
    move.mutate(
      { id: sheetId, folderId },
      { onError: (err) => toast(err instanceof Error ? err.message : 'Could not move the spreadsheet', 'error') },
    );
  }

  const shared = {
    workspaceId,
    activeSheetId,
    canEdit,
    canManageAccess,
    onSelect,
    onDeleted,
    onManageAccess: setSecuring,
    onMove: setMoving,
    onDropSheet: moveSheet,
    onNewSheet: (folderId: string) => void newSheet(folderId),
    creatingIn,
    onStartCreate: setCreatingIn,
    onCommitCreate: commitFolder,
  };

  const folders = tree.data?.folders ?? [];
  const unfiled = tree.data?.unfiled ?? [];
  const empty = folders.length === 0 && unfiled.length === 0;

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
            <IconButton label="New folder" onClick={() => setCreatingIn(null)}>
              <Icon name="folder-plus" />
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

      {creatingIn === null && (
        <div className="mb-1 pl-2 pr-1">
          <InlineIconNameForm
            namePlaceholder="Folder name"
            onCommit={(name, icon) => commitFolder(name, icon, null)}
            onCancel={() => setCreatingIn(undefined)}
          />
        </div>
      )}

      {tree.isLoading ? (
        <Spinner />
      ) : tree.error ? (
        <p className="px-2 py-6 text-center text-xs text-[var(--color-muted)]">
          {tree.error instanceof Error ? tree.error.message : 'Could not load spreadsheets'}
        </p>
      ) : empty && creatingIn === undefined ? (
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
        <>
          {folders.map((folder) => (
            <SheetFolderRow key={folder.id} folder={folder} depth={0} {...shared} />
          ))}

          {/* Dropping a spreadsheet here takes it out of its folder. */}
          <div
            className={cx('mt-1 min-h-6 rounded-md', unfiledDrop && 'bg-[var(--color-accent-soft)]')}
            onDragOver={(event) => {
              if (!canEdit || !carriesSheet(event)) return;
              event.preventDefault();
              setUnfiledDrop(true);
            }}
            onDragLeave={() => setUnfiledDrop(false)}
            onDrop={(event) => {
              setUnfiledDrop(false);
              const id = event.dataTransfer.getData(DRAG_TYPE);
              if (id) moveSheet(id, null);
            }}
          >
            {folders.length > 0 && unfiled.length > 0 && (
              <div className="px-2 pb-0.5 pt-2 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">
                Not in a folder
              </div>
            )}
            {unfiled.map((sheet) => (
              <SheetRow key={sheet.id} sheet={sheet} depth={0} {...shared} />
            ))}
          </div>
        </>
      )}

      {securing && (
        <AccessDialog
          // A fresh dialog per target, so one's draft never carries into the next.
          key={`${securing.kind}:${securing.id}`}
          workspaceId={workspaceId}
          target={securing}
          onClose={() => setSecuring(null)}
        />
      )}

      {moving && (
        <MoveSheetDialog
          sheet={moving}
          folders={folders}
          onCancel={() => setMoving(null)}
          onMove={(folderId) => {
            setMoving(null);
            moveSheet(moving.id, folderId);
          }}
        />
      )}
    </div>
  );
}

interface RowProps {
  workspaceId: string;
  activeSheetId: string | null;
  canEdit: boolean;
  canManageAccess: boolean;
  onSelect: (id: string) => void;
  onDeleted: (id: string) => void;
  onManageAccess: (target: NamedAccessTarget) => void;
  onMove: (sheet: SpreadsheetSummary) => void;
  onDropSheet: (sheetId: string, folderId: string | null) => void;
  onNewSheet: (folderId: string) => void;
  creatingIn: string | null | undefined;
  /** Pass a parent id (or null for top level) to start naming; undefined cancels. */
  onStartCreate: (parentId: string | null | undefined) => void;
  onCommitCreate: (name: string, icon: string | null, parentId: string | null) => void;
}

function SheetFolderRow({ folder, depth, ...props }: RowProps & { folder: SheetFolderNode; depth: number }) {
  const { workspaceId, canEdit, canManageAccess, creatingIn } = props;
  const [open, setOpen] = useLocalStorage(`paradocs.sheetFolder.${folder.id}`, depth === 0);
  const [renaming, setRenaming] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [dropping, setDropping] = useState(false);
  /** Where the folder's menu is open, from its button or a right-click. */
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const updateFolder = useUpdateFolder(workspaceId, 'sheets');
  const remove = useDeleteFolder(workspaceId, 'sheets');
  const toast = useToast();

  const count = folder.spreadsheets.length + folder.children.length;
  // A subfolder being named here forces the parent open so the field is visible.
  const creatingHere = creatingIn === folder.id;
  const expanded = open || creatingHere;
  // A lock can leave someone able to see a folder without changing what is in
  // it, or shown it only as the way to something inside.
  const canChange = canEdit && folder.permission === 'edit';
  const pathOnly = folder.permission === 'none';

  const menuItems: SheetMenuItem[] = [];
  if (canChange) {
    menuItems.push(
      { label: 'New spreadsheet', icon: 'table', onSelect: () => props.onNewSheet(folder.id) },
      {
        label: 'New subfolder',
        icon: 'folder-plus',
        onSelect: () => {
          setOpen(true);
          props.onStartCreate(folder.id);
        },
      },
      { label: 'Rename or change icon', icon: 'pencil', onSelect: () => setRenaming(true) },
    );
  }
  if (canManageAccess) {
    if (menuItems.length > 0) menuItems.push('divider');
    menuItems.push({
      label: 'Permissions',
      icon: 'shield-lock',
      onSelect: () => props.onManageAccess({ kind: 'folder', id: folder.id, name: folder.name }),
    });
  }
  if (canChange) {
    menuItems.push('divider', {
      label: 'Delete folder…',
      icon: 'trash3',
      danger: true,
      onSelect: () => setConfirmingDelete(true),
    });
  }

  return (
    <div>
      <div
        className={cx(
          'group flex items-center gap-1 rounded-md pr-1',
          dropping ? 'bg-[var(--color-accent-soft)] ring-1 ring-[var(--color-accent)]' : 'hover:bg-[var(--color-line)]/50',
        )}
        style={{ paddingLeft: depth * 12 }}
        onContextMenu={(event) => {
          if (menuItems.length === 0 || renaming) return;
          event.preventDefault();
          setMenu({ x: event.clientX, y: event.clientY });
        }}
        onDragOver={(event) => {
          if (!canChange || !carriesSheet(event)) return;
          event.preventDefault();
          event.stopPropagation();
          setDropping(true);
        }}
        onDragLeave={() => setDropping(false)}
        onDrop={(event) => {
          setDropping(false);
          const id = event.dataTransfer.getData(DRAG_TYPE);
          if (!id) return;
          event.stopPropagation();
          setOpen(true);
          props.onDropSheet(id, folder.id);
        }}
      >
        {renaming ? (
          <div className="flex min-w-0 flex-1 items-center gap-1 py-1 pl-2">
            <span className="w-3 shrink-0" />
            <InlineIconNameForm
              defaultName={folder.name}
              defaultIcon={folder.icon ?? ''}
              namePlaceholder="Folder name"
              onCommit={(name, icon) => {
                setRenaming(false);
                if (name !== folder.name || icon !== (folder.icon ?? null)) {
                  updateFolder.mutate({ id: folder.id, name, icon });
                }
              }}
              onCancel={() => setRenaming(false)}
            />
          </div>
        ) : (
          <button
            onClick={() => setOpen(!expanded)}
            className="flex min-w-0 flex-1 items-center gap-1.5 py-1.5 pl-2 text-left"
          >
            <span
              className={cx('w-3 text-[10px] text-[var(--color-muted)] transition-transform', expanded && 'rotate-90')}
            >
              <Icon name="chevron-right" />
            </span>
            {folder.icon && <span className="shrink-0 text-xs">{folder.icon}</span>}
            <span
              className={cx('min-w-0 flex-1 truncate text-sm', pathOnly && 'text-[var(--color-muted)]')}
              title={pathOnly ? 'Shown because something inside it is shared with you' : undefined}
            >
              {folder.name}
            </span>
            <LockMark access={folder.access} />
            {!expanded && count > 0 && <span className="text-[10px] text-[var(--color-muted)]">{count}</span>}
          </button>
        )}

        {menuItems.length > 0 && (
          // Kept showing while the menu is open, so it stays anchored to something.
          <div className={cx('items-center', renaming ? 'hidden' : menu ? 'flex' : 'hidden group-hover:flex')}>
            {canChange && (
              <IconButton label="New spreadsheet here" onClick={() => props.onNewSheet(folder.id)}>
                <Icon name="plus-lg" />
              </IconButton>
            )}
            <IconButton
              label="Folder options"
              aria-haspopup="menu"
              aria-expanded={menu !== null}
              onClick={(event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                setMenu({ x: rect.left, y: rect.bottom + 4 });
              }}
            >
              <Icon name="list" />
            </IconButton>
          </div>
        )}
      </div>

      {expanded && (
        <>
          {creatingHere && (
            <div className="py-0.5 pr-1" style={{ paddingLeft: (depth + 1) * 12 + 8 }}>
              <InlineIconNameForm
                namePlaceholder="Subfolder name"
                onCommit={(name, icon) => props.onCommitCreate(name, icon, folder.id)}
                onCancel={() => props.onStartCreate(undefined)}
              />
            </div>
          )}
          {folder.children.map((child) => (
            <SheetFolderRow key={child.id} folder={child} depth={depth + 1} {...props} />
          ))}
          {folder.spreadsheets.map((sheet) => (
            <SheetRow key={sheet.id} sheet={sheet} depth={depth + 1} {...props} />
          ))}
          {count === 0 && !creatingHere && (
            <p className="py-1 text-[11px] text-[var(--color-muted)]" style={{ paddingLeft: (depth + 1) * 12 + 22 }}>
              Empty
            </p>
          )}
        </>
      )}

      {menu && <SheetContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />}

      {confirmingDelete && (
        <DeleteFolderDialog
          name={folder.name}
          count={sheetIdsDeep(folder).length}
          noun={SPREADSHEET_NOUN}
          onCancel={() => setConfirmingDelete(false)}
          onConfirm={(deleteContents) => {
            setConfirmingDelete(false);
            const sheetIds = sheetIdsDeep(folder);
            remove.mutate(
              { id: folder.id, deleteContents },
              {
                onSuccess: () => {
                  toast(deleteContents ? `Deleted "${folder.name}" and its spreadsheets` : `Deleted "${folder.name}"`);
                  // Whatever was showing one of them has to move off it.
                  if (deleteContents) for (const id of sheetIds) props.onDeleted(id);
                },
                onError: (err) => toast(err instanceof Error ? err.message : 'Could not delete folder', 'error'),
              },
            );
          }}
        />
      )}
    </div>
  );
}

function SheetRow({ sheet, depth, ...props }: RowProps & { sheet: SpreadsheetSummary; depth: number }) {
  const { workspaceId, canEdit, canManageAccess } = props;
  const [confirming, setConfirming] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const remove = useDeleteSpreadsheet(workspaceId);
  const toast = useToast();

  const active = sheet.id === props.activeSheetId;
  const path = `/w/${workspaceId}/s/${sheet.id}`;
  const canChange = canEdit && sheet.permission === 'edit';

  const menuItems: SheetMenuItem[] = [];
  if (canChange) menuItems.push({ label: 'Move to folder…', icon: 'folder-symlink', onSelect: () => props.onMove(sheet) });
  if (canManageAccess) {
    menuItems.push({
      label: 'Permissions',
      icon: 'shield-lock',
      onSelect: () => props.onManageAccess({ kind: 'spreadsheet', id: sheet.id, name: sheet.title }),
    });
  }
  if (canChange) {
    menuItems.push('divider', { label: 'Delete…', icon: 'trash3', danger: true, onSelect: () => setConfirming(true) });
  }

  return (
    <div
      className={cx(
        'group flex items-center gap-1 rounded-md pr-1',
        active ? 'bg-[var(--color-accent-soft)]' : 'hover:bg-[var(--color-line)]/50',
      )}
      draggable={canChange}
      onDragStart={(event) => {
        event.dataTransfer.setData(DRAG_TYPE, sheet.id);
        event.dataTransfer.effectAllowed = 'move';
      }}
      onContextMenu={(event) => {
        if (menuItems.length === 0) return;
        event.preventDefault();
        setMenu({ x: event.clientX, y: event.clientY });
      }}
    >
      <button
        title={`${sheet.title} — hold ${MODIFIER} to open in a new tab`}
        onClick={(event) => {
          if (asksForNewTab(event)) openTab(path, sheet.title);
          else props.onSelect(sheet.id);
        }}
        onAuxClick={(event) => {
          if (event.button !== 1) return;
          event.preventDefault();
          openTab(path, sheet.title, { background: true });
        }}
        className={cx(
          'flex min-w-0 flex-1 items-center gap-2 py-1.5 text-left text-sm',
          active && 'font-medium text-[var(--color-accent)]',
        )}
        // Filed spreadsheets line up under their folder's name, past its chevron.
        style={{ paddingLeft: depth === 0 ? 8 : depth * 12 + 22 }}
      >
        <span className="text-xs">{sheet.icon ?? <Icon name="table" />}</span>
        <span className="min-w-0 flex-1 truncate">{sheet.title}</span>
        <LockMark access={sheet.access} />
        <span className={cx('shrink-0 text-[10px] text-[var(--color-muted)]', menuItems.length > 0 && 'group-hover:hidden')}>
          {formatRelative(sheet.updatedAt)}
        </span>
      </button>
      {menuItems.length > 0 && (
        <div className={cx('items-center', menu ? 'flex' : 'hidden group-hover:flex')}>
          <IconButton
            label={`Options for ${sheet.title}`}
            aria-haspopup="menu"
            aria-expanded={menu !== null}
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              setMenu({ x: rect.left, y: rect.bottom + 4 });
            }}
          >
            <Icon name="three-dots" />
          </IconButton>
        </div>
      )}

      {menu && <SheetContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />}

      {confirming && (
        <ConfirmDialog
          title={`Delete "${sheet.title}"?`}
          description="This permanently removes the spreadsheet and everything in it. It cannot be undone."
          confirmLabel="Delete permanently"
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false);
            remove.mutate(sheet.id, {
              onSuccess: () => {
                toast(`Deleted "${sheet.title}"`);
                props.onDeleted(sheet.id);
              },
              onError: (err) => toast(err instanceof Error ? err.message : 'Could not delete the spreadsheet', 'error'),
            });
          }}
        />
      )}
    </div>
  );
}

/** Picks the folder a spreadsheet goes in, from those the person may file into. */
function MoveSheetDialog({
  sheet,
  folders,
  onCancel,
  onMove,
}: {
  sheet: SpreadsheetSummary;
  folders: SheetFolderNode[];
  onCancel: () => void;
  onMove: (folderId: string | null) => void;
}) {
  const [target, setTarget] = useState(sheet.folderId ?? '');
  const choices = flattenFolders(folders).filter(({ folder }) => folder.permission === 'edit');

  return (
    <Modal
      title={`Move "${sheet.title}"`}
      description="A spreadsheet that follows its folder's permissions takes on the new folder's."
      onClose={onCancel}
      footer={
        <>
          <Button variant="subtle" className="text-xs" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            variant="primary"
            className="text-xs"
            disabled={target === (sheet.folderId ?? '')}
            onClick={() => onMove(target || null)}
          >
            Move
          </Button>
        </>
      }
    >
      <label className="block">
        <span className="mb-1 block text-xs text-[var(--color-muted)]">Folder</span>
        <select className={FIELD} value={target} onChange={(e) => setTarget(e.target.value)} autoFocus>
          <option value="">Not in a folder</option>
          {choices.map(({ folder, depth }) => (
            <option key={folder.id} value={folder.id}>
              {`${'   '.repeat(depth)}${folder.icon ? `${folder.icon} ` : ''}${folder.name}`}
            </option>
          ))}
        </select>
      </label>
      {choices.length === 0 && (
        <p className="mt-2 text-xs text-[var(--color-muted)]">There are no folders you can file spreadsheets in yet.</p>
      )}
    </Modal>
  );
}
