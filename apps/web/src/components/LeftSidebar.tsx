import { useState } from 'react';
import type { Channel, DocumentSummary, FolderNode, Tag } from '@paradocs/shared';
import {
  useCreateDocument,
  useCreateFolder,
  useCreateWorkspace,
  useDeleteFolder,
  useUpdateFolder,
  useTags,
  useTree,
  type WorkspaceSummary,
} from '../api/hooks';
import { cx, useLocalStorage } from '../lib/util';
import { Button, IconButton, InlineIconNameForm, InlineInput, TagChip } from './ui';
import { ConfirmDialog, Modal } from './Modal';
import type { SettingsSection } from './SettingsDialog';
import WorkspaceIcon from './WorkspaceIcon';
import { useToast } from './Toast';
import { ChannelList } from './chat/ChannelList';

interface Props {
  workspaces: WorkspaceSummary[];
  workspaceId: string;
  onSelectWorkspace: (id: string) => void;
  documentId: string | null;
  onSelectDocument: (id: string) => void;
  onOpenJournal: () => void;
  onOpenSearch: () => void;
  onOpenAllDocuments: () => void;
  allDocumentsActive: boolean;
  documentCount: number;
  activeTagIds: string[];
  onToggleTag: (id: string) => void;
  onSignOut: () => void;
  onOpenSettings: (section: SettingsSection) => void;
  /** Which half of the workspace is showing: the knowledge base, or chat. */
  section: 'docs' | 'chat';
  onSelectSection: (section: 'docs' | 'chat') => void;
  channels: Channel[];
  activeChannelId: string | null;
  onSelectChannel: (id: string) => void;
  canManageChannels: boolean;
  unreadTotal: number;
  mentionTotal: number;
  voiceEnabled: boolean;
  voiceOccupancy: Record<string, string[]>;
  connectedChannelId: string | null;
  /** The call in progress, shown as a bar above the footer. Null when idle. */
  callBar: {
    channelName: string;
    connecting: boolean;
    mic: boolean;
    onToggleMic: () => void;
    onLeave: () => void;
    onOpen: () => void;
  } | null;
}

export default function LeftSidebar(props: Props) {
  const { workspaceId, workspaces, onSelectWorkspace } = props;
  const tree = useTree(workspaceId);
  const tags = useTags(workspaceId);
  const createFolder = useCreateFolder(workspaceId);
  const createDocument = useCreateDocument(workspaceId);
  const createWorkspace = useCreateWorkspace();
  const [switcherOpen, setSwitcherOpen] = useState(false);
  /**
   * Where a new folder is being named: `null` for the top level, a folder id for
   * a subfolder, `undefined` when nothing is being created.
   */
  const [creatingIn, setCreatingIn] = useState<string | null | undefined>(undefined);
  const [workspaceDialogOpen, setWorkspaceDialogOpen] = useState(false);
  const toast = useToast();

  const current = workspaces.find((w) => w.id === workspaceId);

  async function addWorkspace(name: string, icon: string | null) {
    try {
      const created = await createWorkspace.mutateAsync({ name, icon });
      setWorkspaceDialogOpen(false);
      onSelectWorkspace(created.id);
      toast(`Workspace "${created.name}" created`);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not create workspace', 'error');
    }
  }

  function commitFolder(name: string, icon: string | null, parentId: string | null) {
    createFolder.mutate({ name, icon, parentId });
    setCreatingIn(undefined);
  }

  async function addDocument(folderId: string | null, mode: 'page' | 'canvas' = 'page') {
    const doc = await createDocument.mutateAsync({ folderId, mode });
    props.onSelectDocument(doc.id);
  }


  return (
    <div className="flex h-full flex-col bg-[var(--color-surface)]">
      {/* Workspace switcher */}
      <div className="relative border-b border-[var(--color-line)] p-2">
        <button
          onClick={() => setSwitcherOpen((v) => !v)}
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-[var(--color-line)]/50"
        >
          <WorkspaceIcon name={current?.name ?? 'Workspace'} icon={current?.icon} />
          <span className="min-w-0 flex-1 truncate text-sm font-semibold">{current?.name ?? 'Workspace'}</span>
          <span className="text-xs text-[var(--color-muted)]">▾</span>
        </button>

        {switcherOpen && (
          <div className="absolute left-2 right-2 top-full z-20 mt-1 overflow-hidden rounded-lg border border-[var(--color-line)] bg-[var(--color-raised)] shadow-lg">
            {workspaces.map((w) => (
              <button
                key={w.id}
                onClick={() => {
                  onSelectWorkspace(w.id);
                  setSwitcherOpen(false);
                }}
                className={cx(
                  'flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-[var(--color-surface)]',
                  w.id === workspaceId && 'bg-[var(--color-surface)]',
                )}
              >
                <WorkspaceIcon name={w.name} icon={w.icon} size="sm" />
                <span className="min-w-0 flex-1 truncate">{w.name}</span>
                <span className="text-xs text-[var(--color-muted)]">{w.documentCount}</span>
              </button>
            ))}
            <button
              onClick={() => {
                setSwitcherOpen(false);
                setWorkspaceDialogOpen(true);
              }}
              className="w-full border-t border-[var(--color-line)] px-3 py-2 text-left text-sm text-[var(--color-accent)] hover:bg-[var(--color-surface)]"
            >
              + New workspace
            </button>
          </div>
        )}
      </div>

      {/* Knowledge base / chat */}
      <div className="flex gap-1 border-b border-[var(--color-line)] p-2">
        <SectionTab
          active={props.section === 'docs'}
          label="Docs"
          icon="📚"
          onClick={() => props.onSelectSection('docs')}
        />
        <SectionTab
          active={props.section === 'chat'}
          label="Chat"
          icon="💬"
          badge={props.unreadTotal}
          mentions={props.mentionTotal}
          onClick={() => props.onSelectSection('chat')}
        />
      </div>

      {props.section === 'chat' ? (
        <ChannelList
          workspaceId={workspaceId}
          channels={props.channels}
          activeChannelId={props.activeChannelId}
          canManage={props.canManageChannels}
          voiceEnabled={props.voiceEnabled}
          occupancy={props.voiceOccupancy}
          connectedChannelId={props.connectedChannelId}
          onSelect={props.onSelectChannel}
        />
      ) : (
        <>
      {/* Quick actions */}
      <div className="space-y-0.5 p-2">
        <SidebarAction icon="🔍" label="Search" hint="⌘K" onClick={props.onOpenSearch} />
        <SidebarAction
          icon="🗄"
          label="All documents"
          hint={String(props.documentCount)}
          active={props.allDocumentsActive}
          onClick={props.onOpenAllDocuments}
        />
        <SidebarAction icon="📔" label="Today's journal" onClick={props.onOpenJournal} />
        <SidebarAction icon="📄" label="New document" onClick={() => addDocument(null)} />
        <SidebarAction icon="🎨" label="New canvas" onClick={() => addDocument(null, 'canvas')} />
        <SidebarAction
          icon="👥"
          label="Members"
          hint={current ? String(current.memberCount) : undefined}
          onClick={() => props.onOpenSettings('members')}
        />
      </div>

      {/* Tree */}
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        <div className="mb-1 flex items-center justify-between px-2 pt-2">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">
            Folders
          </span>
          <IconButton label="New folder" onClick={() => setCreatingIn(null)}>
            +
          </IconButton>
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

        {tree.data?.folders.map((folder) => (
          <FolderRow
            key={folder.id}
            folder={folder}
            depth={0}
            workspaceId={workspaceId}
            activeDocumentId={props.documentId}
            onSelectDocument={props.onSelectDocument}
            onAddDocument={addDocument}
            creatingIn={creatingIn}
            onStartCreate={setCreatingIn}
            onCommitCreate={commitFolder}
          />
        ))}

        {tree.data && tree.data.folders.length === 0 && (
          <p className="px-2 py-6 text-center text-xs text-[var(--color-muted)]">
            No folders yet. Create one to organize your documents.
          </p>
        )}

        {/* Tags */}
        {tags.data && tags.data.length > 0 && (
          <div className="mt-4">
            <div className="mb-1.5 px-2 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">
              Tags
            </div>
            <div className="flex flex-wrap gap-1 px-2">
              {tags.data.map((tag: Tag) => (
                <TagChip
                  key={tag.id}
                  name={`${tag.name}${tag.documentCount ? ` ${tag.documentCount}` : ''}`}
                  color={tag.color}
                  active={props.activeTagIds.includes(tag.id)}
                  onClick={() => props.onToggleTag(tag.id)}
                />
              ))}
            </div>
          </div>
        )}
      </div>
        </>
      )}

      {/* A call outlives the view it started in, so it needs somewhere
          permanent to live: this stays put while you read documents or move
          between channels. */}
      {props.callBar && (
        <div className="flex items-center gap-1.5 border-t border-[var(--color-line)] bg-[var(--color-surface)] px-2 py-1.5">
          <span className="h-2 w-2 shrink-0 rounded-full bg-emerald-500" />
          <button
            onClick={props.callBar.onOpen}
            className="min-w-0 flex-1 truncate text-left text-xs"
            title={`Open ${props.callBar.channelName}`}
          >
            <span className="font-medium">{props.callBar.connecting ? 'Connecting…' : 'In call'}</span>
            <span className="text-[var(--color-muted)]"> · 🔊 {props.callBar.channelName}</span>
          </button>
          <IconButton
            label={props.callBar.mic ? 'Mute' : 'Unmute'}
            onClick={props.callBar.onToggleMic}
          >
            {props.callBar.mic ? '🎙' : '🔇'}
          </IconButton>
          <IconButton label="Leave call" onClick={props.callBar.onLeave}>
            📴
          </IconButton>
        </div>
      )}

      {/* Footer */}
      <div className="flex items-center gap-1 border-t border-[var(--color-line)] p-2">
        <Button
          variant="ghost"
          className="flex-1 justify-start text-xs"
          onClick={() => props.onOpenSettings('account')}
        >
          ⚙️ Settings
        </Button>
        <IconButton label="Sign out" onClick={props.onSignOut}>
          ⏻
        </IconButton>
      </div>

      {workspaceDialogOpen && (
        <NewWorkspaceDialog
          pending={createWorkspace.isPending}
          onCreate={addWorkspace}
          onClose={() => setWorkspaceDialogOpen(false)}
        />
      )}
    </div>
  );
}

function NewWorkspaceDialog({
  pending,
  onCreate,
  onClose,
}: {
  pending: boolean;
  onCreate: (name: string, icon: string | null) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState('');
  const [icon, setIcon] = useState('');

  const field =
    'w-full rounded-md border border-[var(--color-line)] bg-[var(--color-canvas)] px-2 py-1.5 text-sm ' +
    'outline-none focus:border-[var(--color-accent)]';

  function submit(e?: React.FormEvent) {
    e?.preventDefault();
    if (name.trim() && !pending) onCreate(name.trim(), icon.trim() || null);
  }

  // The dialog's buttons live outside this form, so Enter would not submit on
  // its own with more than one field.
  function onEnter(e: React.KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      submit();
    }
  }

  return (
    <Modal
      title="New workspace"
      description="Workspaces keep separate sets of documents, folders and tags."
      onClose={onClose}
      footer={
        <>
          <Button variant="subtle" className="text-xs" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" className="text-xs" onClick={submit} disabled={!name.trim() || pending}>
            {pending ? 'Creating…' : 'Create workspace'}
          </Button>
        </>
      }
    >
      <form onSubmit={submit} className="flex gap-2">
        <input
          className={cx(field, 'w-14 text-center')}
          value={icon}
          onChange={(e) => setIcon(e.target.value)}
          onKeyDown={onEnter}
          placeholder="—"
          maxLength={2}
          aria-label="Workspace icon (optional)"
          title="Optional"
        />
        <input
          autoFocus
          className={field}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={onEnter}
          placeholder="Workspace name"
          aria-label="Workspace name"
        />
      </form>
    </Modal>
  );
}

function SidebarAction({
  icon,
  label,
  hint,
  onClick,
  active,
}: {
  icon: string;
  label: string;
  hint?: string;
  onClick: () => void;
  active?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={cx(
        'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm',
        active
          ? 'bg-[var(--color-accent-soft)] font-medium text-[var(--color-accent)]'
          : 'hover:bg-[var(--color-line)]/50',
      )}
    >
      <span className="w-4 text-center text-xs">{icon}</span>
      <span className="flex-1 text-left">{label}</span>
      {hint && <span className="text-[10px] text-[var(--color-muted)]">{hint}</span>}
    </button>
  );
}

/** Documents in this folder and every folder nested beneath it. */
function countDocumentsDeep(folder: FolderNode): number {
  return folder.documents.length + folder.children.reduce((sum, c) => sum + countDocumentsDeep(c), 0);
}

function FolderRow({
  folder,
  depth,
  workspaceId,
  activeDocumentId,
  onSelectDocument,
  onAddDocument,
  creatingIn,
  onStartCreate,
  onCommitCreate,
}: {
  folder: FolderNode;
  depth: number;
  workspaceId: string;
  activeDocumentId: string | null;
  onSelectDocument: (id: string) => void;
  onAddDocument: (folderId: string | null) => void;
  creatingIn: string | null | undefined;
  /** Pass a parent id (or null for top level) to start naming; undefined cancels. */
  onStartCreate: (parentId: string | null | undefined) => void;
  onCommitCreate: (name: string, icon: string | null, parentId: string | null) => void;
}) {
  const [open, setOpen] = useLocalStorage(`paradocs.folder.${folder.id}`, depth === 0);
  const [renaming, setRenaming] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const updateFolder = useUpdateFolder(workspaceId);
  const remove = useDeleteFolder(workspaceId);
  const toast = useToast();

  const count = folder.documents.length + folder.children.length;
  // A subfolder being named here forces the parent open so the field is visible.
  const creatingHere = creatingIn === folder.id;
  const expanded = open || creatingHere;

  return (
    <div>
      <div
        className="group flex items-center gap-1 rounded-md pr-1 hover:bg-[var(--color-line)]/50"
        style={{ paddingLeft: depth * 12 }}
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
          <button onClick={() => setOpen(!expanded)} className="flex min-w-0 flex-1 items-center gap-1.5 py-1.5 pl-2 text-left">
            <span
              className={cx('w-3 text-[10px] text-[var(--color-muted)] transition-transform', expanded && 'rotate-90')}
            >
              ▶
            </span>
            {/* Folder icons are optional; without one the name simply sits closer in. */}
            {folder.icon && <span className="shrink-0 text-xs">{folder.icon}</span>}
            <span className="min-w-0 flex-1 truncate text-sm">{folder.name}</span>
            {!expanded && count > 0 && <span className="text-[10px] text-[var(--color-muted)]">{count}</span>}
          </button>
        )}

        <div className={cx('items-center', renaming ? 'hidden' : 'hidden group-hover:flex')}>
          <IconButton label="New document here" onClick={() => onAddDocument(folder.id)}>
            +
          </IconButton>
          <IconButton
            label="New subfolder"
            onClick={() => {
              setOpen(true);
              onStartCreate(folder.id);
            }}
          >
            📁
          </IconButton>
          <IconButton label="Rename folder or change its icon" onClick={() => setRenaming(true)}>
            ✎
          </IconButton>
          <IconButton label="Delete folder" onClick={() => setConfirmingDelete(true)}>
            ×
          </IconButton>
        </div>
      </div>

      {expanded && (
        <>
          {creatingHere && (
            <div className="py-0.5 pr-1" style={{ paddingLeft: (depth + 1) * 12 + 8 }}>
              <InlineIconNameForm
                namePlaceholder="Subfolder name"
                onCommit={(name, icon) => onCommitCreate(name, icon, folder.id)}
                onCancel={() => onStartCreate(undefined)}
              />
            </div>
          )}
          {folder.children.map((child) => (
            <FolderRow
              key={child.id}
              folder={child}
              depth={depth + 1}
              workspaceId={workspaceId}
              activeDocumentId={activeDocumentId}
              onSelectDocument={onSelectDocument}
              onAddDocument={onAddDocument}
              creatingIn={creatingIn}
              onStartCreate={onStartCreate}
              onCommitCreate={onCommitCreate}
            />
          ))}
          {folder.documents.map((doc) => (
            <DocumentRow
              key={doc.id}
              doc={doc}
              depth={depth + 1}
              active={doc.id === activeDocumentId}
              onSelect={onSelectDocument}
            />
          ))}
          {count === 0 && !creatingHere && (
            <p
              className="py-1 text-[11px] text-[var(--color-muted)]"
              style={{ paddingLeft: (depth + 1) * 12 + 22 }}
            >
              Empty
            </p>
          )}
        </>
      )}

      {confirmingDelete && (
        <ConfirmDialog
          title={`Delete "${folder.name}"?`}
          // Documents survive: only the folder and its subfolders go away.
          description={
            countDocumentsDeep(folder) > 0
              ? `The folder and any subfolders are deleted. ${countDocumentsDeep(folder)} document(s) inside are kept and become unfiled in All Documents.`
              : 'The folder and any subfolders are deleted. No documents are affected.'
          }
          confirmLabel="Delete folder"
          onCancel={() => setConfirmingDelete(false)}
          onConfirm={() => {
            setConfirmingDelete(false);
            remove.mutate(folder.id, {
              onSuccess: () => toast(`Deleted "${folder.name}"`),
              onError: (err) =>
                toast(err instanceof Error ? err.message : 'Could not delete folder', 'error'),
            });
          }}
        />
      )}
    </div>
  );
}

function DocumentRow({
  doc,
  depth,
  active,
  onSelect,
}: {
  doc: DocumentSummary;
  depth: number;
  active: boolean;
  onSelect: (id: string) => void;
}) {
  return (
    <button
      onClick={() => onSelect(doc.id)}
      className={cx(
        'flex w-full items-center gap-1.5 rounded-md py-1.5 pr-2 text-left text-sm',
        active ? 'bg-[var(--color-accent-soft)] font-medium text-[var(--color-accent)]' : 'hover:bg-[var(--color-line)]/50',
      )}
      style={{ paddingLeft: depth * 12 + 22 }}
    >
      <span className="text-xs">
        {doc.icon ?? (doc.isJournal ? '📔' : doc.mode === 'canvas' ? '🎨' : '📄')}
      </span>
      <span className="min-w-0 flex-1 truncate">{doc.title}</span>
      {doc.tags.slice(0, 2).map((tag) => (
        <span key={tag.id} className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: tag.color }} />
      ))}
    </button>
  );
}


function SectionTab({
  active,
  label,
  icon,
  badge,
  mentions = 0,
  onClick,
}: {
  active: boolean;
  label: string;
  icon: string;
  badge?: number;
  mentions?: number;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cx(
        'flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-sm',
        active ? 'bg-[var(--color-line)]/70 font-medium' : 'text-[var(--color-muted)] hover:bg-[var(--color-line)]/40',
      )}
    >
      <span>{icon}</span>
      <span>{label}</span>
      {/* Unread only matters when you are not already looking at chat, and a
          mention outranks it. */}
      {!active && mentions > 0 ? (
        <span className="rounded-full bg-amber-500 px-1.5 text-[11px] font-semibold text-white">
          @{mentions > 99 ? '99+' : mentions}
        </span>
      ) : (
        !active &&
        badge !== undefined &&
        badge > 0 && (
          <span className="rounded-full bg-[var(--color-accent)] px-1.5 text-[11px] font-semibold text-white">
            {badge > 99 ? '99+' : badge}
          </span>
        )
      )}
    </button>
  );
}
