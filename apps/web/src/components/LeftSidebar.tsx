import { useState } from 'react';
import type {
  Channel,
  DocumentMode,
  DocumentSummary,
  FolderNode,
  PresenceStatus,
  Tag,
  User,
  VoiceOccupant,
  WorkspaceApp,
} from '@paradocs/shared';
import { AppLauncher, type AppEntry } from './AppLauncher';
import { Popover } from './Popover';
import { PresenceAvatar, STATUS_LABEL, StatusMenu } from './Presence';
import {
  useAppEnabled,
  useCreateDocument,
  useCreateFolder,
  useCreateWorkspace,
  useDeleteDocument,
  useDeleteFolder,
  useUpdateFolder,
  useTags,
  useTeams,
  useTree,
  type WorkspaceSummary,
} from '../api/hooks';
import { cx, useLocalStorage } from '../lib/util';
import {
  desktop,
  requireDesktop,
  useDesktopConnections,
  useDesktopWorkspaces,
  type DesktopConnection,
} from '../lib/desktop';
import { Button, IconButton, InlineIconNameForm, InlineInput, TagChip } from './ui';
import Icon, { DocumentIcon, type IconName } from './Icon';
import Avatar from './Avatar';
import { ConfirmDialog, Modal } from './Modal';
import type { SettingsSection } from './SettingsDialog';
import type { AccessSection } from './AccessApp';
import type { Can } from '../lib/permissions';
import WorkspaceIcon from './WorkspaceIcon';
import { MODIFIER, asksForNewTab, openTab } from '../lib/tabs';
import { useToast } from './Toast';
import { useDocumentImport } from './ImportDocument';
import { ChannelList } from './chat/ChannelList';
import { SheetList } from './sheet/SheetList';
import { ProjectList } from './projects/ProjectList';
import { AccessDialog, LockMark, type NamedAccessTarget } from './AccessDialog';
import SheetContextMenu, { type SheetMenuItem } from './sheet/SheetContextMenu';
import DeleteFolderDialog, { DOCUMENT_NOUN } from './DeleteFolderDialog';
import ManageTagsDialog from './ManageTagsDialog';

/** The apps a workspace offers, each with its own half of the sidebar. */
export type SidebarSection = 'docs' | 'chat' | 'sheets' | 'projects' | 'access';

interface Props {
  /** The signed-in account, shown at the foot of the sidebar. */
  user: User;
  workspaces: WorkspaceSummary[];
  workspaceId: string;
  onSelectWorkspace: (id: string) => void;
  documentId: string | null;
  onSelectDocument: (id: string) => void;
  /** What this person's role lets them do, so nothing is offered that would be refused. */
  can: Can;
  /** Owners and admins, who decide who can see each folder, document and channel. */
  canManageAccess: boolean;
  /** A document was deleted from the tree, so anything showing it must move off. */
  onDocumentDeleted: (id: string) => void;
  onOpenSearch: () => void;
  onOpenAllDocuments: () => void;
  allDocumentsActive: boolean;
  documentCount: number;
  activeTagIds: string[];
  onToggleTag: (id: string) => void;
  onSignOut: () => void;
  onOpenSettings: (section: SettingsSection) => void;
  /** Desktop app only: opens the dialog for adding a server. */
  onConnectServer?: () => void;
  /** Which app the sidebar is showing: the knowledge base, chat, spreadsheets, or the workspace's access and settings. */
  section: SidebarSection;
  onSelectSection: (section: SidebarSection) => void;
  /** The spreadsheet open in the Sheets app, if any. */
  activeSheetId: string | null;
  onSelectSheet: (id: string) => void;
  /** A spreadsheet was deleted from the list, so anything showing it must move off. */
  onSheetDeleted: (id: string) => void;
  /** The project open in the Projects app, or null for My work. */
  activeProjectId: string | null;
  onSelectProject: (id: string) => void;
  onOpenMyWork: () => void;
  /** Open work items the signed-in person holds a role on. */
  myWorkCount?: number;
  /** The page open in the Access app. */
  activeAccessSection: AccessSection;
  onSelectAccessSection: (section: AccessSection) => void;
  channels: Channel[];
  /** The signed-in person's direct conversations, most recent first. */
  directs: Channel[];
  /** Who is around, keyed by user id. */
  presence: Record<string, PresenceStatus>;
  /** Your own status, shown on your picture at the foot of the sidebar. */
  selfStatus: PresenceStatus;
  activeChannelId: string | null;
  onSelectChannel: (id: string) => void;
  canManageChannels: boolean;
  unreadTotal: number;
  mentionTotal: number;
  voiceEnabled: boolean;
  voiceOccupancy: Record<string, VoiceOccupant[]>;
  connectedChannelId: string | null;
  /** Conversations the desktop app is showing in windows of their own. */
  poppedOutChannelIds?: string[];
  /** The call in progress, shown as a bar above the footer. Null when idle. */
  callBar: {
    /** The voice channel's name, or the person in a direct call. */
    channelName: string;
    direct: boolean;
    connecting: boolean;
    mic: boolean;
    /**
     * Muting, leaving and moving the call belong to the window holding it, so
     * they are absent when the call is running in one of its own. What is left
     * is where to find it.
     */
    onToggleMic?: () => void;
    onLeave?: () => void;
    onOpen: () => void;
    /** Desktop app only: moves the call into a window of its own. */
    onPopOut?: () => void;
    /** Desktop app only: raises the window the call is running in. */
    onShowWindow?: () => void;
  } | null;
}

export default function LeftSidebar(props: Props) {
  const { workspaceId, workspaces, onSelectWorkspace } = props;
  const docsOn = useAppEnabled(workspaceId, 'docs');
  const tree = useTree(docsOn ? workspaceId : undefined);
  const tags = useTags(docsOn ? workspaceId : undefined);
  // Only counted for the Access app's navigation.
  const teams = useTeams(props.section === 'access' ? workspaceId : undefined);
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
  const [securing, setSecuring] = useState<NamedAccessTarget | null>(null);
  const [managingTags, setManagingTags] = useState(false);
  const toast = useToast();
  const documentImport = useDocumentImport(workspaceId, props.onSelectDocument);

  const current = workspaces.find((w) => w.id === workspaceId);
  // In the desktop app the workspace menu spans every connection, not just this server.
  const connections = useDesktopConnections();
  const here = connections.find((c) => c.active);
  const elsewhere = connections.filter((c) => !c.active);

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

  async function addDocument(folderId: string | null, mode: DocumentMode = 'page') {
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
          <WorkspaceIcon name={current?.name ?? 'Workspace'} icon={current?.icon} avatarUrl={current?.avatarUrl} />
          <span className="min-w-0 flex-1 truncate text-sm font-semibold">{current?.name ?? 'Workspace'}</span>
          <Icon name="chevron-down" className="text-xs text-[var(--color-muted)]" />
        </button>

        {switcherOpen && (
          <div className="scroll-thin absolute left-2 right-2 top-full z-20 mt-1 max-h-[70vh] overflow-y-auto rounded-lg border border-[var(--color-line)] bg-[var(--color-raised)] shadow-lg">
            {here && <ConnectionLabel connection={here} />}
            {workspaces.map((w) => (
              <button
                key={w.id}
                // Holding the modifier opens the workspace in a tab of its own,
                // which is how two workspaces end up side by side.
                title={`${w.name} — hold ${MODIFIER} to open in a new tab`}
                onClick={(event) => {
                  setSwitcherOpen(false);
                  if (asksForNewTab(event)) openTab(`/w/${w.id}`, w.name);
                  else onSelectWorkspace(w.id);
                }}
                onAuxClick={(event) => {
                  if (event.button !== 1) return;
                  event.preventDefault();
                  setSwitcherOpen(false);
                  openTab(`/w/${w.id}`, w.name, { background: true });
                }}
                className={cx(
                  'flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-[var(--color-surface)]',
                  w.id === workspaceId && 'bg-[var(--color-surface)]',
                )}
              >
                <WorkspaceIcon name={w.name} icon={w.icon} avatarUrl={w.avatarUrl} size="sm" />
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
              <Icon name="plus-lg" /> New workspace
            </button>
            {desktop && (
              <>
                {elsewhere.map((connection) => (
                  <OtherConnection
                    key={connection.id}
                    connection={connection}
                    onChosen={() => setSwitcherOpen(false)}
                  />
                ))}
                <button
                  onClick={() => {
                    setSwitcherOpen(false);
                    props.onConnectServer?.();
                  }}
                  className="w-full border-t border-[var(--color-line)] px-3 py-2 text-left text-sm text-[var(--color-accent)] hover:bg-[var(--color-surface)]"
                >
                  <Icon name="hdd-network" /> Connect to a server…
                </button>
              </>
            )}
          </div>
        )}
      </div>

      {/* Which app the sidebar is showing. Adding one to this list is all it
          takes: the launcher lays out however many there are. Apps the
          workspace has turned off are left out; Access is always there. */}
      <div className="border-b border-[var(--color-line)] p-2">
        <AppLauncher
          apps={(
            [
              { id: 'docs', label: 'Docs', icon: 'journals' },
              {
                id: 'chat',
                label: 'Chat',
                icon: 'chat-dots',
                badge: props.unreadTotal,
                mentions: props.mentionTotal,
              },
              { id: 'sheets', label: 'Sheets', icon: 'table' },
              { id: 'projects', label: 'Projects', icon: 'kanban' },
              { id: 'access', label: 'Access', icon: 'shield-lock' },
            ] satisfies AppEntry[]
          ).filter((app) => app.id === 'access' || (current?.visibleApps ?? []).includes(app.id as WorkspaceApp))}
          currentId={props.section}
          onSelect={(id) => props.onSelectSection(id as SidebarSection)}
        />
      </div>

      {props.section === 'chat' ? (
        <ChannelList
          workspaceId={workspaceId}
          channels={props.channels}
          directs={props.directs}
          presence={props.presence}
          activeChannelId={props.activeChannelId}
          canManage={props.canManageChannels}
          canManageAccess={props.canManageAccess}
          canStartDirect={props.can('chat.direct')}
          voiceEnabled={props.voiceEnabled}
          occupancy={props.voiceOccupancy}
          connectedChannelId={props.connectedChannelId}
          poppedOut={props.poppedOutChannelIds ?? []}
          onSelect={props.onSelectChannel}
          onManageAccess={setSecuring}
        />
      ) : props.section === 'access' ? (
        <div className="scroll-thin min-h-0 flex-1 space-y-0.5 overflow-y-auto p-2">
          <SidebarAction
            icon="person-lines-fill"
            label="Members"
            hint={current ? String(current.memberCount) : undefined}
            active={props.activeAccessSection === 'members'}
            onClick={() => props.onSelectAccessSection('members')}
          />
          <SidebarAction
            icon="diagram-3"
            label="Teams"
            hint={teams.data ? String(teams.data.length) : undefined}
            active={props.activeAccessSection === 'teams'}
            onClick={() => props.onSelectAccessSection('teams')}
          />
          <SidebarAction
            icon="person-badge"
            label="Roles"
            active={props.activeAccessSection === 'roles'}
            onClick={() => props.onSelectAccessSection('roles')}
          />
          <div className="px-2 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">
            Workspace
          </div>
          <SidebarAction
            icon="briefcase"
            label="General"
            active={props.activeAccessSection === 'workspace'}
            onClick={() => props.onSelectAccessSection('workspace')}
          />
          <SidebarAction
            icon="grid-3x3-gap"
            label="Apps"
            hint={current ? String(current.apps.length) : undefined}
            active={props.activeAccessSection === 'apps'}
            onClick={() => props.onSelectAccessSection('apps')}
          />
          {/* Storage housekeeping is for those whose role allows it, so nobody else sees it. */}
          {props.can('uploads.manage') && (
            <SidebarAction
              icon="paperclip"
              label="Uploads"
              active={props.activeAccessSection === 'uploads'}
              onClick={() => props.onSelectAccessSection('uploads')}
            />
          )}
        </div>
      ) : props.section === 'projects' ? (
        <ProjectList
          workspaceId={workspaceId}
          activeProjectId={props.activeProjectId}
          can={props.can}
          canManageAccess={props.canManageAccess}
          myWorkCount={props.myWorkCount}
          onOpenMyWork={props.onOpenMyWork}
          onSelect={props.onSelectProject}
        />
      ) : props.section === 'sheets' ? (
        <SheetList
          workspaceId={workspaceId}
          activeSheetId={props.activeSheetId}
          can={props.can}
          canManageAccess={props.canManageAccess}
          onSelect={props.onSelectSheet}
          onDeleted={props.onSheetDeleted}
        />
      ) : (
        <>
      {/* Quick actions */}
      <div className="space-y-0.5 p-2">
        <SidebarAction icon="search" label="Search" hint="⌘K" onClick={props.onOpenSearch} />
        <SidebarAction
          icon="collection"
          label="All documents"
          hint={String(props.documentCount)}
          active={props.allDocumentsActive}
          onClick={props.onOpenAllDocuments}
        />
        {props.can('docs.create') && (
          <>
            <SidebarAction icon="file-earmark-plus" label="New document" onClick={() => addDocument(null)} />
            <SidebarAction icon="easel" label="New canvas" onClick={() => addDocument(null, 'canvas')} />
            <SidebarAction
              icon="file-earmark-arrow-up"
              label={documentImport.importing ? 'Importing…' : 'Import document'}
              onClick={documentImport.choose}
            />
            {documentImport.input}
          </>
        )}
        <SidebarAction
          icon="people"
          label="Members"
          hint={current ? String(current.memberCount) : undefined}
          onClick={() => props.onSelectAccessSection('members')}
        />
      </div>

      {/* Tree */}
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        <div className="mb-1 flex items-center justify-between px-2 pt-2">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">
            Folders
          </span>
          {props.can('docs.create') && (
            <IconButton label="New folder" onClick={() => setCreatingIn(null)}>
              <Icon name="folder-plus" />
            </IconButton>
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

        {tree.data?.folders.map((folder) => (
          <FolderRow
            key={folder.id}
            folder={folder}
            depth={0}
            workspaceId={workspaceId}
            activeDocumentId={props.documentId}
            can={props.can}
            canManageAccess={props.canManageAccess}
            onManageAccess={setSecuring}
            onSelectDocument={props.onSelectDocument}
            onDocumentDeleted={props.onDocumentDeleted}
            onAddDocument={addDocument}
            creatingIn={creatingIn}
            onStartCreate={setCreatingIn}
            onCommitCreate={commitFolder}
          />
        ))}

        {tree.data && tree.data.folders.length === 0 && (
          <p className="px-2 py-6 text-center text-xs text-[var(--color-muted)]">
            No folders yet.
          </p>
        )}

        {/* Tags */}
        {tags.data && tags.data.length > 0 && (
          <div className="mt-4">
            <div className="mb-1 flex items-center justify-between px-2">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">
                Tags
              </span>
              {props.can('docs.tags') && (
                <IconButton label="Manage tags" onClick={() => setManagingTags(true)}>
                  <Icon name="pencil" />
                </IconButton>
              )}
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
            <span className="font-medium">
              {props.callBar.connecting ? 'Connecting…' : props.callBar.onShowWindow ? 'In call elsewhere' : 'In call'}
            </span>
            <span className="text-[var(--color-muted)]">
              {' · '}
              <Icon name={props.callBar.direct ? 'telephone' : 'volume-up'} /> {props.callBar.channelName}
            </span>
          </button>
          {props.callBar.onToggleMic && (
            <IconButton
              label={props.callBar.mic ? 'Mute' : 'Unmute'}
              onClick={props.callBar.onToggleMic}
            >
              <Icon name={props.callBar.mic ? 'mic' : 'mic-mute'} />
            </IconButton>
          )}
          {props.callBar.onPopOut && (
            <IconButton label="Move this call to its own window" onClick={props.callBar.onPopOut}>
              <Icon name="box-arrow-up-right" />
            </IconButton>
          )}
          {props.callBar.onShowWindow && (
            <IconButton label="Show the window this call is in" onClick={props.callBar.onShowWindow}>
              <Icon name="window-stack" />
            </IconButton>
          )}
          {props.callBar.onLeave && (
            <IconButton label="Leave call" onClick={props.callBar.onLeave}>
              <Icon name="telephone-x" />
            </IconButton>
          )}
        </div>
      )}

      <AccountFooter
        user={props.user}
        status={props.selfStatus}
        onOpenSettings={() => props.onOpenSettings('account')}
        onSignOut={props.onSignOut}
      />

      {workspaceDialogOpen && (
        <NewWorkspaceDialog
          pending={createWorkspace.isPending}
          onCreate={addWorkspace}
          onClose={() => setWorkspaceDialogOpen(false)}
        />
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

      {managingTags && <ManageTagsDialog workspaceId={workspaceId} onClose={() => setManagingTags(false)} />}
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
  icon: IconName;
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
      <span className="w-4 text-center text-xs">
        <Icon name={icon} />
      </span>
      <span className="flex-1 text-left">{label}</span>
      {hint && <span className="text-[10px] text-[var(--color-muted)]">{hint}</span>}
    </button>
  );
}

/** Documents in this folder and every folder nested beneath it. */
function documentIdsDeep(folder: FolderNode): string[] {
  return [...folder.documents.map((d) => d.id), ...folder.children.flatMap(documentIdsDeep)];
}

function FolderRow({
  folder,
  depth,
  workspaceId,
  activeDocumentId,
  can,
  canManageAccess,
  onManageAccess,
  onSelectDocument,
  onDocumentDeleted,
  onAddDocument,
  creatingIn,
  onStartCreate,
  onCommitCreate,
}: {
  folder: FolderNode;
  depth: number;
  workspaceId: string;
  activeDocumentId: string | null;
  can: Can;
  canManageAccess: boolean;
  onManageAccess: (target: NamedAccessTarget) => void;
  onSelectDocument: (id: string) => void;
  onDocumentDeleted: (id: string) => void;
  onAddDocument: (folderId: string | null, mode?: DocumentMode) => void;
  creatingIn: string | null | undefined;
  /** Pass a parent id (or null for top level) to start naming; undefined cancels. */
  onStartCreate: (parentId: string | null | undefined) => void;
  onCommitCreate: (name: string, icon: string | null, parentId: string | null) => void;
}) {
  const [open, setOpen] = useLocalStorage(`paradocs.folder.${folder.id}`, depth === 0);
  const [renaming, setRenaming] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  /** Where the folder's menu is open, from its button or a right-click. */
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const updateFolder = useUpdateFolder(workspaceId);
  const remove = useDeleteFolder(workspaceId);
  const toast = useToast();

  const count = folder.documents.length + folder.children.length;
  // A subfolder being named here forces the parent open so the field is visible.
  const creatingHere = creatingIn === folder.id;
  const expanded = open || creatingHere;
  // A lock can leave someone able to see a folder without changing what is in
  // it, or shown it only as the way to something inside. Their role has
  // already been weighed into `permission`; adding and deleting are asked of
  // it separately.
  const canChange = folder.permission === 'edit';
  const canAdd = canChange && can('docs.create');
  const pathOnly = folder.permission === 'none';

  // Everything but the most common action lives in one menu, so a row stays
  // readable however many things can be done to a folder.
  const menuItems: SheetMenuItem[] = [];
  if (canAdd) {
    menuItems.push(
      { label: 'New document', icon: 'file-earmark-plus', onSelect: () => onAddDocument(folder.id) },
      { label: 'New canvas', icon: 'easel', onSelect: () => onAddDocument(folder.id, 'canvas') },
      {
        label: 'New subfolder',
        icon: 'folder-plus',
        onSelect: () => {
          setOpen(true);
          onStartCreate(folder.id);
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
      onSelect: () => onManageAccess({ kind: 'folder', id: folder.id, name: folder.name }),
    });
  }
  if (canChange && can('docs.delete')) {
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
        className="group flex items-center gap-1 rounded-md pr-1 hover:bg-[var(--color-line)]/50"
        style={{ paddingLeft: depth * 12 }}
        onContextMenu={(event) => {
          if (menuItems.length === 0 || renaming) return;
          event.preventDefault();
          setMenu({ x: event.clientX, y: event.clientY });
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
          <button onClick={() => setOpen(!expanded)} className="flex min-w-0 flex-1 items-center gap-1.5 py-1.5 pl-2 text-left">
            <span
              className={cx('w-3 text-[10px] text-[var(--color-muted)] transition-transform', expanded && 'rotate-90')}
            >
              <Icon name="chevron-right" />
            </span>
            {/* Folder icons are optional; without one the name simply sits closer in. */}
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
            {canAdd && (
              <IconButton label="New document here" onClick={() => onAddDocument(folder.id)}>
                <Icon name="file-earmark-plus" />
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
              can={can}
              canManageAccess={canManageAccess}
              onManageAccess={onManageAccess}
              onSelectDocument={onSelectDocument}
              onDocumentDeleted={onDocumentDeleted}
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
              workspaceId={workspaceId}
              canDelete={doc.permission === 'edit' && can('docs.delete')}
              canManageAccess={canManageAccess}
              onManageAccess={onManageAccess}
              onSelect={onSelectDocument}
              onDeleted={onDocumentDeleted}
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

      {menu && <SheetContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />}

      {confirmingDelete && (
        <DeleteFolderDialog
          name={folder.name}
          count={documentIdsDeep(folder).length}
          noun={DOCUMENT_NOUN}
          onCancel={() => setConfirmingDelete(false)}
          onConfirm={(deleteDocuments) => {
            setConfirmingDelete(false);
            const documentIds = documentIdsDeep(folder);
            remove.mutate(
              { id: folder.id, deleteContents: deleteDocuments },
              {
                onSuccess: () => {
                  toast(deleteDocuments ? `Deleted "${folder.name}" and its documents` : `Deleted "${folder.name}"`);
                  // Whatever was showing one of them has to move off it.
                  if (deleteDocuments) for (const id of documentIds) onDocumentDeleted(id);
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

function DocumentRow({
  doc,
  depth,
  active,
  workspaceId,
  canDelete,
  canManageAccess,
  onManageAccess,
  onSelect,
  onDeleted,
}: {
  doc: DocumentSummary;
  depth: number;
  active: boolean;
  workspaceId: string;
  /** No delete button is shown that the server would refuse. */
  canDelete: boolean;
  canManageAccess: boolean;
  onManageAccess: (target: NamedAccessTarget) => void;
  onSelect: (id: string) => void;
  /** So whatever is showing the document can move off it once it is gone. */
  onDeleted: (id: string) => void;
}) {
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const remove = useDeleteDocument(workspaceId);
  const toast = useToast();

  return (
    // A row rather than one button: the delete control is a button of its own,
    // and one cannot sit inside another.
    <div
      className={cx(
        'group flex items-center gap-1 rounded-md pr-1',
        active ? 'bg-[var(--color-accent-soft)]' : 'hover:bg-[var(--color-line)]/50',
      )}
    >
      <button
        title={`${doc.title} — hold ${MODIFIER} to open in a new tab`}
        onClick={(event) => {
          if (asksForNewTab(event)) openTab(`/w/${workspaceId}/d/${doc.id}`, doc.title, { emoji: doc.icon ?? undefined });
          else onSelect(doc.id);
        }}
        onAuxClick={(event) => {
          if (event.button !== 1) return;
          event.preventDefault();
          openTab(`/w/${workspaceId}/d/${doc.id}`, doc.title, {
            background: true,
            emoji: doc.icon ?? undefined,
          });
        }}
        className={cx(
          'flex min-w-0 flex-1 items-center gap-1.5 py-1.5 pr-1 text-left text-sm',
          active && 'font-medium text-[var(--color-accent)]',
        )}
        style={{ paddingLeft: depth * 12 + 22 }}
      >
        <span className="text-xs">
          <DocumentIcon doc={doc} />
        </span>
        <span className="min-w-0 flex-1 truncate">{doc.title}</span>
        <LockMark access={doc.access} />
        {doc.tags.slice(0, 2).map((tag) => (
          <span key={tag.id} className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: tag.color }} />
        ))}
      </button>

      {(canDelete || canManageAccess) && (
        <div className="hidden items-center group-hover:flex">
          {canManageAccess && (
            <IconButton
              label={`Permissions for ${doc.title}`}
              onClick={() => onManageAccess({ kind: 'document', id: doc.id, name: doc.title })}
            >
              <Icon name="shield-lock" />
            </IconButton>
          )}
          {canDelete && (
            <IconButton label={`Delete ${doc.title}`} onClick={() => setConfirmingDelete(true)}>
              <Icon name="trash3" />
            </IconButton>
          )}
        </div>
      )}

      {confirmingDelete && (
        <ConfirmDialog
          title={`Delete "${doc.title}"?`}
          // The same warning the document's own properties panel gives, because
          // it is the same irreversible thing happening.
          description="This permanently removes the document, its comments and its history. It cannot be undone. Archive it instead if you only want it out of the way."
          confirmLabel="Delete permanently"
          onCancel={() => setConfirmingDelete(false)}
          onConfirm={() => {
            setConfirmingDelete(false);
            remove.mutate(doc.id, {
              onSuccess: () => {
                toast(`Deleted "${doc.title}"`);
                onDeleted(doc.id);
              },
              onError: (err) =>
                toast(err instanceof Error ? err.message : 'Could not delete document', 'error'),
            });
          }}
        />
      )}
    </div>
  );
}


function ConnectionLabel({ connection }: { connection: DesktopConnection }) {
  return (
    <div className="flex items-center gap-1.5 px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">
      <Icon name={connection.kind === 'local' ? 'laptop' : 'globe2'} />
      <span className="truncate">{connection.label}</span>
    </div>
  );
}

/**
 * Another connection's workspaces, in the workspace menu. Picking one switches
 * the window to that connection and lands on the workspace.
 */
function OtherConnection({ connection, onChosen }: { connection: DesktopConnection; onChosen: () => void }) {
  const listing = useDesktopWorkspaces(connection.id, true);
  const toast = useToast();

  async function open(workspaceId?: string) {
    onChosen();
    const result = await requireDesktop().connections.open(
      connection.id,
      workspaceId ? `/w/${workspaceId}` : undefined,
    );
    if (!result.ok) toast(result.error, 'error');
  }

  const data = listing.data;
  const workspaces = data && data.status !== 'signed-out' ? data.workspaces : [];
  const row = 'flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-[var(--color-surface)]';

  return (
    <div className="border-t border-[var(--color-line)]">
      <ConnectionLabel connection={connection} />
      {listing.isLoading && <p className="px-3 py-2 text-xs text-[var(--color-muted)]">Loading…</p>}
      {workspaces.map((w) => (
        <button key={w.id} onClick={() => void open(w.id)} className={row}>
          <WorkspaceIcon name={w.name} icon={w.icon} avatarUrl={w.picture} size="sm" />
          <span className="min-w-0 flex-1 truncate">{w.name}</span>
        </button>
      ))}
      {data?.status === 'signed-out' && (
        <button onClick={() => void open()} className={cx(row, 'text-[var(--color-muted)]')}>
          <Icon name="box-arrow-in-right" /> Sign in
        </button>
      )}
      {/* Nothing known about it yet — a server that could not be reached, say. */}
      {data?.status === 'unavailable' && workspaces.length === 0 && (
        <button onClick={() => void open()} className={cx(row, 'text-[var(--color-muted)]')}>
          <Icon name="box-arrow-in-right" /> Open {connection.label}
        </button>
      )}
    </div>
  );
}

/**
 * The signed-in account at the foot of the sidebar. The picture carries your
 * status and opens the menu to change it; the name opens Settings.
 */
function AccountFooter({
  user,
  status,
  onOpenSettings,
  onSignOut,
}: {
  user: User;
  status: PresenceStatus;
  onOpenSettings: () => void;
  onSignOut: () => void;
}) {
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);

  return (
    <div className="flex items-center gap-1 border-t border-[var(--color-line)] p-2">
      <button
        onClick={(e) => setMenuAnchor(menuAnchor ? null : e.currentTarget)}
        aria-expanded={menuAnchor !== null}
        aria-label={`Status: ${STATUS_LABEL[status]}. Change your status`}
        title="Set your status"
        className="grid shrink-0 place-items-center rounded-full p-1 hover:bg-[var(--color-line)]/50"
      >
        <PresenceAvatar name={user.name} url={user.avatarUrl} seed={user.id} size="md" status={status} />
      </button>
      <Button variant="ghost" className="min-w-0 flex-1 justify-start text-xs" title="Settings" onClick={onOpenSettings}>
        <span className="min-w-0 flex-1 text-left leading-tight">
          <span className="block truncate">{user.name}</span>
          <span className="block truncate text-[10px] text-[var(--color-muted)]">{STATUS_LABEL[status]}</span>
        </span>
        <Icon name="gear" className="text-[var(--color-muted)]" />
      </Button>
      <IconButton label="Sign out" onClick={onSignOut}>
        <Icon name="box-arrow-right" />
      </IconButton>

      {menuAnchor && (
        <Popover anchor={menuAnchor} placement="above" onClose={() => setMenuAnchor(null)} className="w-72 p-1.5">
          <StatusMenu onChosen={() => setMenuAnchor(null)} />
        </Popover>
      )}
    </div>
  );
}
