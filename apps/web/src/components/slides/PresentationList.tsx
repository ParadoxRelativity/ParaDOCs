import { useCallback, useRef, useState } from 'react';
import type { PresentationSummary, SlideFolderNode } from '@paradocs/shared';
import {
  useArchivedPresentations,
  useCreateFolder,
  useCreatePresentation,
  useDeleteFolder,
  useDeletePresentation,
  useDuplicatePresentation,
  useFolderPresentations,
  useSlideTree,
  useUnfiledPresentations,
  useUpdateFolder,
  useUpdatePresentation,
  useUploadFile,
} from '../../api/hooks';
import { importSlideFile } from '../../lib/slideImportClient';
import { SLIDE_IMPORT_ACCEPT, isSlideImportFile } from '../../lib/slideImportTypes';
import { rememberImport, resolveMedia, uploadImportMedia } from '../../lib/slideImport';
import type { Can } from '../../lib/permissions';
import { MODIFIER, asksForNewTab, openTab } from '../../lib/tabs';
import { cx, formatRelative, useLocalStorage } from '../../lib/util';
import { AccessDialog, LockMark, type NamedAccessTarget } from '../AccessDialog';
import DeleteFolderDialog, { PRESENTATION_NOUN } from '../DeleteFolderDialog';
import { ConfirmDialog, Modal } from '../Modal';
import { FIELD } from '../SettingsParts';
import { useToast } from '../Toast';
import { Button, IconButton, InlineIconNameForm, LoadMore, Spinner } from '../ui';
import Icon from '../Icon';
import NewPresentationMenu from './NewPresentationMenu';
import SheetContextMenu, { type SheetMenuItem } from '../sheet/SheetContextMenu';

/** What a dragged presentation carries, so only a presentation can be dropped on a folder. */
const DRAG_TYPE = 'application/x-paradocs-presentation';

/** How many presentations are in this folder and every folder nested beneath it. */
function presentationCountDeep(folder: SlideFolderNode): number {
  return folder.presentationCount + folder.children.reduce((total, child) => total + presentationCountDeep(child), 0);
}

/** A presentation being moved, and the folder it is moving from. */
type MovingPresentation = Pick<PresentationSummary, 'id' | 'folderId'>;

/**
 * The presentation a drag carries, with the folder it came from: the sidebar
 * loads folders' contents only as they are opened, so the drag itself says
 * where the presentation was rather than it being looked up.
 */
function draggedPresentation(event: React.DragEvent): MovingPresentation | null {
  try {
    const value: unknown = JSON.parse(event.dataTransfer.getData(DRAG_TYPE));
    if (value && typeof value === 'object' && 'id' in value && typeof value.id === 'string') {
      const folderId = 'folderId' in value && typeof value.folderId === 'string' ? value.folderId : null;
      return { id: value.id, folderId };
    }
  } catch {
    // Not one of ours.
  }
  return null;
}

/** Every folder, parents before children, with how deep each one sits. */
function flattenFolders(folders: SlideFolderNode[], depth = 0): { folder: SlideFolderNode; depth: number }[] {
  return folders.flatMap((folder) => [{ folder, depth }, ...flattenFolders(folder.children, depth + 1)]);
}

/** Whether a drag is carrying a presentation, which is all a folder accepts. */
function carriesPresentation(event: React.DragEvent): boolean {
  return event.dataTransfer.types.includes(DRAG_TYPE);
}

/**
 * The Slides app's side of the sidebar: folders of presentations, and below
 * them the presentations filed nowhere, most recently touched first.
 *
 * The folders are the Slides app's own, not the documents tree: the two apps
 * are shown one at a time, and a workspace may have only one of them on. They
 * lock the way document folders do, and a presentation inherits from its folder
 * the way a document does.
 */
export function PresentationList({
  workspaceId,
  activePresentationId,
  can,
  canManageAccess,
  onSelect,
  onDeleted,
}: {
  workspaceId: string;
  activePresentationId: string | null;
  /** What this person's role lets them do, so nothing is offered that would be refused. */
  can: Can;
  /** Owners and admins, who decide who can see each folder and presentation. */
  canManageAccess: boolean;
  onSelect: (id: string) => void;
  /** So whatever is showing the presentation can move off it once it is gone. */
  onDeleted: (id: string) => void;
}) {
  const tree = useSlideTree(workspaceId);
  const create = useCreatePresentation(workspaceId);
  const createFolder = useCreateFolder(workspaceId, 'slides');
  const move = useUpdatePresentation(workspaceId);
  const upload = useUploadFile(workspaceId);
  const toast = useToast();
  /** What an import in progress is doing, for the status line; null when none is. */
  const [importStatus, setImportStatus] = useState<string | null>(null);
  const [fileDrag, setFileDrag] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  /**
   * Where a new folder is being named: `null` for the top level, a folder id for
   * a subfolder, `undefined` when nothing is being created.
   */
  const [creatingIn, setCreatingIn] = useState<string | null | undefined>(undefined);
  const [securing, setSecuring] = useState<NamedAccessTarget | null>(null);
  const [moving, setMoving] = useState<PresentationSummary | null>(null);
  const [unfiledDrop, setUnfiledDrop] = useState(false);

  async function newPresentation(folderId: string | null = null, themeId?: string) {
    try {
      const deck = await create.mutateAsync({ folderId, ...(themeId ? { themeId } : {}) });
      onSelect(deck.id);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not create the presentation', 'error');
    }
  }

  /**
   * Makes a presentation from a .pptx or .odp. The file is read first (in a
   * worker), so one that will not open never leaves an empty presentation
   * behind; its pictures are uploaded to the new presentation, and the rest
   * waits for the editor to open and write it in.
   */
  async function importFile(file: File, folderId: string | null = null): Promise<string | null> {
    if (!isSlideImportFile(file.name)) {
      toast(`${file.name} is not a PowerPoint (.pptx) or OpenDocument (.odp) presentation`, 'error');
      return null;
    }
    try {
      const deck = await importSlideFile(file, (progress) => setImportStatus(progress.message));
      setImportStatus('Creating the presentation…');
      const created = await create.mutateAsync({ title: deck.title.slice(0, 200), folderId });
      const { urls, failed } = await uploadImportMedia(
        deck,
        (picture) => upload.mutateAsync({ file: picture, presentationId: created.id }),
        (progress) => setImportStatus(progress.message),
      );
      rememberImport(created.id, resolveMedia(deck, urls, failed));
      return created.id;
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not import that file', 'error');
      return null;
    }
  }

  async function importFiles(files: File[]) {
    let last: string | null = null;
    for (const file of files) last = (await importFile(file)) ?? last;
    setImportStatus(null);
    if (last) onSelect(last);
  }

  function commitFolder(name: string, icon: string | null, parentId: string | null) {
    createFolder.mutate(
      { name, icon, parentId },
      { onError: (err) => toast(err instanceof Error ? err.message : 'Could not create the folder', 'error') },
    );
    setCreatingIn(undefined);
  }

  function movePresentation(deck: MovingPresentation, folderId: string | null) {
    // Dropped back where it already was.
    if (deck.folderId === folderId) return;
    move.mutate(
      { id: deck.id, folderId },
      { onError: (err) => toast(err instanceof Error ? err.message : 'Could not move the presentation', 'error') },
    );
  }

  const shared = {
    workspaceId,
    activePresentationId,
    can,
    canManageAccess,
    onSelect,
    onDeleted,
    onManageAccess: setSecuring,
    onMove: setMoving,
    onDropPresentation: movePresentation,
    onNewPresentation: (folderId: string) => void newPresentation(folderId),
    creatingIn,
    onStartCreate: setCreatingIn,
    onCommitCreate: commitFolder,
  };

  const folders = tree.data?.folders ?? [];
  // Those in no folder are read a page at a time too, most recently touched first.
  const unfiledCount = tree.data?.unfiledCount ?? 0;
  const unfiledPages = useUnfiledPresentations(workspaceId, unfiledCount > 0);
  const unfiled = unfiledCount > 0 ? (unfiledPages.data?.pages.flatMap((page) => page.items) ?? []) : [];
  const { fetchNextPage: fetchMoreUnfiled } = unfiledPages;
  const loadMoreUnfiled = useCallback(() => void fetchMoreUnfiled(), [fetchMoreUnfiled]);
  const empty = folders.length === 0 && unfiledCount === 0;
  const [showArchived, setShowArchived] = useLocalStorage('paradocs.slideArchived', false);
  const archivedPages = useArchivedPresentations(workspaceId, showArchived);
  const archived = archivedPages.data?.pages.flatMap((page) => page.items) ?? [];
  const { fetchNextPage: fetchMoreArchived } = archivedPages;
  const loadMoreArchived = useCallback(() => void fetchMoreArchived(), [fetchMoreArchived]);

  return (
    <div
      className={cx('scroll-thin min-h-0 flex-1 overflow-y-auto px-2 pb-2', fileDrag && 'outline outline-2 -outline-offset-2 outline-[var(--color-accent)]')}
      onDragOver={(e) => {
        // A file dragged in from the desktop, not a presentation being filed.
        if (!can('slides.create') || !e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        setFileDrag(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFileDrag(false);
      }}
      onDrop={(e) => {
        setFileDrag(false);
        if (!can('slides.create') || e.dataTransfer.files.length === 0) return;
        e.preventDefault();
        void importFiles([...e.dataTransfer.files]);
      }}
    >
      <div className="mb-1 flex items-center justify-between px-2 pt-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">
          Presentations
        </span>
        {can('slides.create') && (
          <span className="flex items-center">
            <IconButton
              label={importStatus ? 'Importing…' : 'Import PowerPoint or OpenDocument (.pptx, .odp)'}
              onClick={() => fileInput.current?.click()}
              disabled={importStatus !== null}
            >
              <Icon name="box-arrow-in-down" />
            </IconButton>
            <IconButton label="New folder" onClick={() => setCreatingIn(null)}>
              <Icon name="folder-plus" />
            </IconButton>
            <NewPresentationMenu onCreate={(themeId) => void newPresentation(null, themeId)} disabled={create.isPending} />
          </span>
        )}
      </div>

      <input
        ref={fileInput}
        type="file"
        multiple
        accept={SLIDE_IMPORT_ACCEPT}
        className="hidden"
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = '';
          if (files.length > 0) void importFiles(files);
        }}
      />
      {importStatus && (
        <p role="status" aria-live="polite" className="mb-1 flex items-center gap-2 px-2 text-xs text-[var(--color-muted)]">
          <span aria-hidden className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-[var(--color-line)] border-t-[var(--color-accent)]" /> {importStatus}
        </p>
      )}

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
          {tree.error instanceof Error ? tree.error.message : 'Could not load presentations'}
        </p>
      ) : empty && creatingIn === undefined ? (
        <div className="px-2 py-6 text-center">
          <p className="text-xs text-[var(--color-muted)]">No presentations yet.</p>
          {can('slides.create') && (
            <button
              onClick={() => void newPresentation()}
              className="mt-2 text-xs font-medium text-[var(--color-accent)] hover:underline"
            >
              Create one
            </button>
          )}
        </div>
      ) : (
        <>
          {folders.map((folder) => (
            <PresentationFolderRow key={folder.id} folder={folder} depth={0} {...shared} />
          ))}

          {/* Dropping a presentation here takes it out of its folder. */}
          <div
            className={cx('mt-1 min-h-6 rounded-md', unfiledDrop && 'bg-[var(--color-accent-soft)]')}
            onDragOver={(event) => {
              if (!can('slides.edit') || !carriesPresentation(event)) return;
              event.preventDefault();
              setUnfiledDrop(true);
            }}
            onDragLeave={() => setUnfiledDrop(false)}
            onDrop={(event) => {
              setUnfiledDrop(false);
              const deck = draggedPresentation(event);
              if (deck) movePresentation(deck, null);
            }}
          >
            {folders.length > 0 && unfiledCount > 0 && (
              <div className="px-2 pb-0.5 pt-2 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">
                Not in a folder
              </div>
            )}
            {unfiled.map((deck) => (
              <PresentationRow key={deck.id} deck={deck} depth={0} {...shared} />
            ))}
            {unfiledCount > 0 && (
              <LoadMore
                hasMore={unfiledPages.hasNextPage}
                loading={unfiledPages.isLoading || unfiledPages.isFetchingNextPage}
                failed={unfiledPages.isError}
                onLoadMore={loadMoreUnfiled}
                label="Show more"
              />
            )}
          </div>
        </>
      )}

      {/* Archived decks are hidden from everything above, not deleted; this is the way back to them. */}
      {!tree.isLoading && !tree.error && (
        <div className="mt-2">
          <button
            onClick={() => setShowArchived(!showArchived)}
            aria-expanded={showArchived}
            className="flex w-full items-center gap-1.5 px-2 py-1 text-left text-[10px] font-semibold uppercase tracking-wide text-[var(--color-muted)]"
          >
            <span className={cx('transition-transform', showArchived && 'rotate-90')}>
              <Icon name="chevron-right" />
            </span>
            Archived
          </button>
          {showArchived && (
            <>
              {archived.map((deck) => (
                <PresentationRow key={deck.id} deck={deck} depth={0} {...shared} />
              ))}
              {archivedPages.isLoading ? (
                <Spinner />
              ) : (
                archived.length === 0 && <p className="px-2 py-1 text-[11px] text-[var(--color-muted)]">Nothing archived</p>
              )}
              <LoadMore
                hasMore={archivedPages.hasNextPage}
                loading={archivedPages.isFetchingNextPage}
                failed={archivedPages.isError}
                onLoadMore={loadMoreArchived}
                label="Show more"
              />
            </>
          )}
        </div>
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
        <MovePresentationDialog
          deck={moving}
          folders={folders}
          onCancel={() => setMoving(null)}
          onMove={(folderId) => {
            setMoving(null);
            movePresentation(moving, folderId);
          }}
        />
      )}
    </div>
  );
}

interface RowProps {
  workspaceId: string;
  activePresentationId: string | null;
  can: Can;
  canManageAccess: boolean;
  onSelect: (id: string) => void;
  onDeleted: (id: string) => void;
  onManageAccess: (target: NamedAccessTarget) => void;
  onMove: (deck: PresentationSummary) => void;
  onDropPresentation: (deck: MovingPresentation, folderId: string | null) => void;
  onNewPresentation: (folderId: string) => void;
  creatingIn: string | null | undefined;
  /** Pass a parent id (or null for top level) to start naming; undefined cancels. */
  onStartCreate: (parentId: string | null | undefined) => void;
  onCommitCreate: (name: string, icon: string | null, parentId: string | null) => void;
}

function PresentationFolderRow({ folder, depth, ...props }: RowProps & { folder: SlideFolderNode; depth: number }) {
  const { workspaceId, can, canManageAccess, creatingIn } = props;
  const [open, setOpen] = useLocalStorage(`paradocs.slideFolder.${folder.id}`, depth === 0);
  const [renaming, setRenaming] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [dropping, setDropping] = useState(false);
  /** Where the folder's menu is open, from its button or a right-click. */
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const updateFolder = useUpdateFolder(workspaceId, 'slides');
  const remove = useDeleteFolder(workspaceId, 'slides');
  const toast = useToast();

  const count = folder.presentationCount + folder.children.length;
  // A subfolder being named here forces the parent open so the field is visible.
  const creatingHere = creatingIn === folder.id;
  const expanded = open || creatingHere;
  // A lock can leave someone able to see a folder without changing what is in
  // it, or shown it only as the way to something inside. Their role has
  // already been weighed into `permission`; adding and deleting are asked of
  // it separately.
  const canChange = folder.permission === 'edit';
  const pathOnly = folder.permission === 'none';

  const menuItems: SheetMenuItem[] = [];
  if (canChange && can('slides.create')) {
    menuItems.push(
      { label: 'New presentation', icon: 'easel2', onSelect: () => props.onNewPresentation(folder.id) },
      {
        label: 'New subfolder',
        icon: 'folder-plus',
        onSelect: () => {
          setOpen(true);
          props.onStartCreate(folder.id);
        },
      },
    );
  }
  if (canChange) {
    menuItems.push({ label: 'Rename or change icon', icon: 'pencil', onSelect: () => setRenaming(true) });
  }
  if (canManageAccess) {
    if (menuItems.length > 0) menuItems.push('divider');
    menuItems.push({
      label: 'Permissions',
      icon: 'shield-lock',
      onSelect: () => props.onManageAccess({ kind: 'folder', id: folder.id, name: folder.name }),
    });
  }
  if (canChange && can('slides.delete')) {
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
          if (!canChange || !carriesPresentation(event)) return;
          event.preventDefault();
          event.stopPropagation();
          setDropping(true);
        }}
        onDragLeave={() => setDropping(false)}
        onDrop={(event) => {
          setDropping(false);
          const deck = draggedPresentation(event);
          if (!deck) return;
          event.stopPropagation();
          setOpen(true);
          props.onDropPresentation(deck, folder.id);
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
            {canChange && can('slides.create') && (
              <IconButton label="New presentation here" onClick={() => props.onNewPresentation(folder.id)}>
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
            <PresentationFolderRow key={child.id} folder={child} depth={depth + 1} {...props} />
          ))}
          {folder.presentationCount > 0 && <FolderPresentations folderId={folder.id} depth={depth} {...props} />}
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
          count={presentationCountDeep(folder)}
          noun={PRESENTATION_NOUN}
          onCancel={() => setConfirmingDelete(false)}
          onConfirm={(deleteContents) => {
            setConfirmingDelete(false);
            remove.mutate(
              { id: folder.id, deleteContents },
              {
                onSuccess: (result) => {
                  toast(deleteContents ? `Deleted "${folder.name}" and its presentations` : `Deleted "${folder.name}"`);
                  // Whatever was showing one of them has to move off it. The
                  // server names them, since not all of them need be loaded here.
                  for (const id of result?.deleted ?? []) props.onDeleted(id);
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

/**
 * The presentations in an open folder, read a page at a time, since a folder
 * can hold more than the sidebar should load at once.
 */
function FolderPresentations({ folderId, depth, ...props }: RowProps & { folderId: string; depth: number }) {
  const decks = useFolderPresentations(props.workspaceId, folderId, true);
  const { fetchNextPage } = decks;
  const loadMore = useCallback(() => void fetchNextPage(), [fetchNextPage]);
  if (decks.isLoading) {
    return (
      <p className="py-1 text-[11px] text-[var(--color-muted)]" style={{ paddingLeft: (depth + 1) * 12 + 22 }}>
        Loading…
      </p>
    );
  }
  return (
    <>
      {(decks.data?.pages.flatMap((page) => page.items) ?? []).map((deck) => (
        <PresentationRow key={deck.id} deck={deck} depth={depth + 1} {...props} />
      ))}
      <div style={{ paddingLeft: (depth + 1) * 12 }}>
        <LoadMore
          hasMore={decks.hasNextPage}
          loading={decks.isFetchingNextPage}
          failed={decks.isError}
          onLoadMore={loadMore}
          label="Show more"
        />
      </div>
    </>
  );
}

function PresentationRow({ deck, depth, ...props }: RowProps & { deck: PresentationSummary; depth: number }) {
  const { workspaceId, can, canManageAccess } = props;
  const [confirming, setConfirming] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const remove = useDeletePresentation(workspaceId);
  const update = useUpdatePresentation(workspaceId);
  const duplicate = useDuplicatePresentation(workspaceId);
  const toast = useToast();

  const archived = deck.archivedAt !== null;
  const active = deck.id === props.activePresentationId;
  const path = `/w/${workspaceId}/sl/${deck.id}`;
  const canChange = deck.permission === 'edit';

  const menuItems: SheetMenuItem[] = [];
  if (can('slides.create')) {
    menuItems.push({
      label: 'Duplicate',
      icon: 'files',
      onSelect: () =>
        duplicate.mutate(
          { id: deck.id },
          {
            onSuccess: (copy) => props.onSelect(copy.id),
            onError: (err) => toast(err instanceof Error ? err.message : 'Could not duplicate the presentation', 'error'),
          },
        ),
    });
  }
  if (canChange && !archived) {
    menuItems.push({ label: 'Move to folder…', icon: 'folder-symlink', onSelect: () => props.onMove(deck) });
  }
  if (canChange) {
    menuItems.push({
      label: archived ? 'Restore from archive' : 'Archive',
      icon: archived ? 'arrow-counterclockwise' : 'archive',
      onSelect: () =>
        update.mutate(
          { id: deck.id, archived: !archived },
          {
            onSuccess: () => toast(archived ? `Restored "${deck.title}"` : `Archived "${deck.title}"`),
            onError: (err) => toast(err instanceof Error ? err.message : 'Could not change the presentation', 'error'),
          },
        ),
    });
  }
  if (canManageAccess) {
    menuItems.push({
      label: 'Permissions',
      icon: 'shield-lock',
      onSelect: () => props.onManageAccess({ kind: 'presentation', id: deck.id, name: deck.title }),
    });
  }
  if (canChange && can('slides.delete')) {
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
        event.dataTransfer.setData(DRAG_TYPE, JSON.stringify({ id: deck.id, folderId: deck.folderId }));
        event.dataTransfer.effectAllowed = 'move';
      }}
      onContextMenu={(event) => {
        if (menuItems.length === 0) return;
        event.preventDefault();
        setMenu({ x: event.clientX, y: event.clientY });
      }}
    >
      <button
        title={`${deck.title} — hold ${MODIFIER} to open in a new tab`}
        onClick={(event) => {
          if (asksForNewTab(event)) openTab(path, deck.title);
          else props.onSelect(deck.id);
        }}
        onAuxClick={(event) => {
          if (event.button !== 1) return;
          event.preventDefault();
          openTab(path, deck.title, { background: true });
        }}
        className={cx(
          'flex min-w-0 flex-1 items-center gap-2 py-1.5 text-left text-sm',
          active && 'font-medium text-[var(--color-accent)]',
        )}
        // Filed presentations line up under their folder's name, past its chevron.
        style={{ paddingLeft: depth === 0 ? 8 : depth * 12 + 22 }}
      >
        <span className="text-xs">{deck.icon ?? <Icon name="easel2" />}</span>
        <span className="min-w-0 flex-1 truncate">{deck.title}</span>
        <LockMark access={deck.access} />
        <span className={cx('shrink-0 text-[10px] text-[var(--color-muted)]', menuItems.length > 0 && 'group-hover:hidden')}>
          {formatRelative(deck.updatedAt)}
        </span>
      </button>
      {menuItems.length > 0 && (
        <div className={cx('items-center', menu ? 'flex' : 'hidden group-hover:flex')}>
          <IconButton
            label={`Options for ${deck.title}`}
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
          title={`Delete "${deck.title}"?`}
          description="This permanently removes the presentation and everything in it. It cannot be undone."
          confirmLabel="Delete permanently"
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false);
            remove.mutate(deck.id, {
              onSuccess: () => {
                toast(`Deleted "${deck.title}"`);
                props.onDeleted(deck.id);
              },
              onError: (err) => toast(err instanceof Error ? err.message : 'Could not delete the presentation', 'error'),
            });
          }}
        />
      )}
    </div>
  );
}

/** Picks the folder a presentation goes in, from those the person may file into. */
function MovePresentationDialog({
  deck,
  folders,
  onCancel,
  onMove,
}: {
  deck: PresentationSummary;
  folders: SlideFolderNode[];
  onCancel: () => void;
  onMove: (folderId: string | null) => void;
}) {
  const [target, setTarget] = useState(deck.folderId ?? '');
  const choices = flattenFolders(folders).filter(({ folder }) => folder.permission === 'edit');

  return (
    <Modal
      title={`Move "${deck.title}"`}
      description="A presentation that follows its folder's permissions takes on the new folder's."
      onClose={onCancel}
      footer={
        <>
          <Button variant="subtle" className="text-xs" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            variant="primary"
            className="text-xs"
            disabled={target === (deck.folderId ?? '')}
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
        <p className="mt-2 text-xs text-[var(--color-muted)]">There are no folders you can file presentations in yet.</p>
      )}
    </Modal>
  );
}
