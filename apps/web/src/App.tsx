import { useCallback, useEffect, useState } from 'react';
import { Navigate, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import type { User } from '@paradocs/shared';
import {
  useDeleteDocument,
  useDocument,
  useJournal,
  useLogout,
  useMe,
  useUpdateDocument,
  useWorkspaces,
  useChannels,
  useVoiceConfig,
  useVoiceParticipants,
  type DocumentPatch,
} from './api/hooks';
import { cx, todayISO, useLocalStorage } from './lib/util';
import AuthScreen from './components/AuthScreen';
import LeftSidebar from './components/LeftSidebar';
import RightSidebar, { type RightTab } from './components/RightSidebar';
import DocumentEditor from './components/DocumentEditor';
import ErrorBoundary from './components/ErrorBoundary';
import AllDocuments from './components/AllDocuments';
import AcceptInvite from './components/AcceptInvite';
import SettingsDialog, { isSettingsSection, type SettingsSection, type Theme } from './components/SettingsDialog';
import ConnectServerDialog from './components/ConnectServerDialog';
import { desktop } from './lib/desktop';
import { useTheme } from './lib/theme';
import NotificationsMenu from './components/NotificationsMenu';
import SearchPalette from './components/SearchPalette';
import { ChatView } from './components/chat/ChatView';
import { useChatEvents } from './lib/chatEvents';
import { VoiceRoom } from './components/chat/VoiceRoom';
import { useCall } from './lib/call';
import { EmptyState, IconButton, Spinner } from './components/ui';
import Icon from './components/Icon';

export default function App() {
  const me = useMe();

  if (me.isLoading) return <Spinner />;
  if (!me.data?.user) {
    return (
      <AuthScreen
        allowRegistration={me.data?.allowRegistration ?? false}
        oidc={me.data?.oidc ?? { enabled: false, configured: false, providerName: 'SSO' }}
      />
    );
  }

  return (
    <>
      {desktop && <DesktopNavigation />}
      <Routes>
        <Route path="/invite/:token" element={<AcceptInvite />} />
        <Route path="/w/:workspaceId/d/:documentId" element={<Workspace user={me.data.user} />} />
        <Route path="/w/:workspaceId/all" element={<Workspace user={me.data.user} allDocuments />} />
        <Route path="/w/:workspaceId/c/:channelId" element={<Workspace user={me.data.user} chat />} />
        <Route path="/w/:workspaceId" element={<Workspace user={me.data.user} />} />
        <Route path="*" element={<FirstWorkspaceRedirect />} />
      </Routes>
    </>
  );
}

/**
 * Lands where the desktop app was asked to take this page: a workspace chosen
 * from another connection's menu, or a channel or invitation from the
 * notifications panel. Only the app's own routes are followed.
 */
function DesktopNavigation() {
  const navigate = useNavigate();
  useEffect(
    () =>
      desktop?.onCommand((command) => {
        if (command.type === 'navigate' && /^\/(w|invite)\//.test(command.path)) navigate(command.path);
      }),
    [navigate],
  );
  return null;
}

function FirstWorkspaceRedirect() {
  const workspaces = useWorkspaces();
  if (workspaces.isLoading) return <Spinner />;
  const first = workspaces.data?.[0];
  if (!first) {
    return <EmptyState icon="exclamation-triangle" title="No workspaces" hint="Your account has no workspace. Try signing out and back in." />;
  }
  return <Navigate to={`/w/${first.id}`} replace />;
}

function Workspace({
  user,
  allDocuments = false,
  chat = false,
}: {
  user: User;
  allDocuments?: boolean;
  chat?: boolean;
}) {
  const userId = user.id;
  const { workspaceId = '', documentId, channelId } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const workspaces = useWorkspaces();
  const workspace = workspaces.data?.find((w) => w.id === workspaceId);
  // Viewers get the whole app read-only; editors and above can write.
  const canEdit = workspace ? workspace.role !== 'viewer' : false;
  // Owners and admins manage channels; everyone else just reads and posts.
  const canManageChannels = workspace ? workspace.role === 'owner' || workspace.role === 'admin' : false;
  const channels = useChannels(workspaceId);
  const channelList = channels.data ?? [];
  const activeChannel = channelList.find((c) => c.id === channelId);
  const unreadTotal = channelList.reduce((total, c) => total + (c.unread ?? 0), 0);
  const mentionTotal = channelList.reduce((total, c) => total + (c.mentions ?? 0), 0);
  const voice = useVoiceConfig();
  // The call belongs to the session, not to the view: clicking a voice channel
  // joins it, and it keeps running while you read a document or move around.
  const call = useCall();
  const callChannel = channelList.find((c) => c.id === call.channelId);
  // Only polled while chat is open; a document reader has no use for it.
  const voiceParticipants = useVoiceParticipants(workspaceId, chat && (voice.data?.enabled ?? false));
  // Chat's socket lives here, not in the chat view: a mention has to reach you
  // while you are reading a document or sitting in another channel.
  const chatEvents = useChatEvents({
    workspaceId,
    channels: channelList,
    selfId: userId,
    activeChannelId: chat ? (channelId ?? null) : null,
    onNotifyClick: (id) => navigate(`/w/${workspaceId}/c/${id}`),
  });

  const document = useDocument(documentId);
  const updateDocument = useUpdateDocument(workspaceId, documentId ?? '');
  const deleteDocument = useDeleteDocument(workspaceId);
  const logout = useLogout();

  const [leftOpen, setLeftOpen] = useLocalStorage('paradocs.leftOpen', true);
  const [rightOpen, setRightOpen] = useLocalStorage('paradocs.rightOpen', true);
  const [rightTab, setRightTab] = useLocalStorage<RightTab>('paradocs.rightTab', 'toc');
  const [theme, setTheme] = useTheme();
  const [searchOpen, setSearchOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection | null>(null);
  const [activeTagIds, setActiveTagIds] = useState<string[]>([]);
  const [liveBlocks, setLiveBlocks] = useState<unknown[]>([]);
  const [journalDate, setJournalDate] = useState<string | null>(null);
  const [connectOpen, setConnectOpen] = useState(false);

  const journal = useJournal(workspaceId, journalDate ?? todayISO(), journalDate !== null);

  // Opening a journal is a fetch-then-navigate, since the id is assigned server side.
  useEffect(() => {
    if (journalDate && journal.data) {
      navigate(`/w/${workspaceId}/d/${journal.data.id}`);
      setJournalDate(null);
      queryClient.invalidateQueries({ queryKey: ['tree', workspaceId] });
    }
  }, [journalDate, journal.data, workspaceId, navigate, queryClient]);

  const dark =
    theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);

  useEffect(() => {
    document_setTheme(dark);
  }, [dark]);

  // Clear the outline while switching documents; the editor republishes its own
  // normalized blocks as soon as it mounts.
  useEffect(() => {
    setLiveBlocks([]);
  }, [documentId]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearchOpen(true);
      }
      if (meta && e.key === '\\') {
        e.preventDefault();
        if (e.shiftKey) setRightOpen((v) => !v);
        else setLeftOpen((v) => !v);
      }
      if (meta && e.key.toLowerCase() === 'j' && e.shiftKey) {
        e.preventDefault();
        setJournalDate(todayISO());
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setLeftOpen, setRightOpen]);

  // The desktop menu reaches into the page to open Settings or add a server.
  useEffect(
    () =>
      desktop?.onCommand((command) => {
        if (command.type === 'open-settings' && isSettingsSection(command.section)) {
          setSettingsSection(command.section);
        } else if (command.type === 'connect-server') {
          setConnectOpen(true);
        }
      }),
    [],
  );

  const patch = useCallback((p: DocumentPatch) => updateDocument.mutate(p), [updateDocument]);

  // Where the chat tab lands when the URL names no channel.
  const firstChannelPath = channelList[0] ? `/w/${workspaceId}/c/${channelList[0].id}` : `/w/${workspaceId}`;

  if (workspaces.isLoading) return <Spinner />;
  if (workspaces.data && !workspaces.data.some((w) => w.id === workspaceId)) {
    return <Navigate to="/" replace />;
  }

  return (
    <div className="flex h-full overflow-hidden">
      <aside
        className={cx(
          'shrink-0 overflow-hidden border-r border-[var(--color-line)] transition-[width] duration-200',
          leftOpen ? 'w-64' : 'w-0',
        )}
      >
        <div className="h-full w-64">
          <LeftSidebar
            user={user}
            workspaces={workspaces.data ?? []}
            workspaceId={workspaceId}
            onSelectWorkspace={(id) => navigate(`/w/${id}`)}
            documentId={documentId ?? null}
            onSelectDocument={(id) => navigate(`/w/${workspaceId}/d/${id}`)}
            onOpenJournal={() => setJournalDate(todayISO())}
            onOpenSearch={() => setSearchOpen(true)}
            onOpenAllDocuments={() => navigate(`/w/${workspaceId}/all`)}
            allDocumentsActive={allDocuments}
            documentCount={workspace?.documentCount ?? 0}
            activeTagIds={activeTagIds}
            onToggleTag={(id) => {
              setActiveTagIds([id]);
              setSearchOpen(true);
            }}
            onSignOut={() => logout.mutate()}
            onOpenSettings={setSettingsSection}
            onConnectServer={desktop ? () => setConnectOpen(true) : undefined}
            section={chat ? 'chat' : 'docs'}
            onSelectSection={(next) => {
              if (next === 'docs') navigate(`/w/${workspaceId}`);
              else navigate(channelId ? `/w/${workspaceId}/c/${channelId}` : firstChannelPath);
            }}
            channels={channelList}
            activeChannelId={channelId ?? null}
            onSelectChannel={(id) => {
              // Clicking a voice channel joins it, the way it works elsewhere;
              // a text channel is only ever opened.
              const target = channelList.find((c) => c.id === id);
              if (target?.kind === 'voice') call.join(id);
              navigate(`/w/${workspaceId}/c/${id}`);
            }}
            canManageChannels={canManageChannels}
            unreadTotal={unreadTotal}
            mentionTotal={mentionTotal}
            voiceEnabled={voice.data?.enabled ?? false}
            voiceOccupancy={voiceParticipants.data ?? {}}
            connectedChannelId={call.channelId}
            callBar={
              call.channelId
                ? {
                    channelName: callChannel?.name ?? 'call',
                    connecting: call.status === 'joining',
                    mic: call.mic,
                    onToggleMic: () => call.toggle('mic'),
                    onLeave: call.leave,
                    onOpen: () => navigate(`/w/${workspaceId}/c/${call.channelId}`),
                  }
                : null
            }
          />
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-11 shrink-0 items-center gap-1 border-b border-[var(--color-line)] px-2">
          <IconButton label={leftOpen ? 'Hide sidebar' : 'Show sidebar'} onClick={() => setLeftOpen(!leftOpen)}>
            <Icon name={leftOpen ? 'layout-sidebar-inset' : 'layout-sidebar'} />
          </IconButton>
          <span className="min-w-0 flex-1 truncate px-2 text-sm text-[var(--color-muted)]">
            {chat
              ? activeChannel
                ? `#${activeChannel.name}`
                : 'Chat'
              : allDocuments
                ? 'All documents'
                : (document.data?.title ?? '')}
          </span>
          <NotificationsMenu />
          {!chat && (
            <>
              <IconButton label="Search (⌘K)" onClick={() => setSearchOpen(true)}>
                <Icon name="search" />
              </IconButton>
              <IconButton
                label={rightOpen ? 'Hide details' : 'Show details'}
                onClick={() => setRightOpen(!rightOpen)}
              >
                <Icon name={rightOpen ? 'layout-sidebar-inset-reverse' : 'layout-sidebar-reverse'} />
              </IconButton>
            </>
          )}
        </header>

        <div className="min-h-0 flex-1">
          {chat ? (
            channels.isLoading ? (
              <Spinner />
            ) : activeChannel?.kind === 'voice' ? (
              <VoiceRoom
                key={activeChannel.id}
                channel={activeChannel}
                config={voice.data}
                call={call}
                selfName={user.name}
              />
            ) : activeChannel ? (
              <ChatView
                key={activeChannel.id}
                workspaceId={workspaceId}
                channel={activeChannel}
                channels={channelList}
                selfId={userId}
                canPost={Boolean(workspace)}
                canModerate={canManageChannels}
                status={chatEvents.status}
                notifications={chatEvents.permission}
                onEnableNotifications={chatEvents.requestPermission}
                onOpenDocument={(id) => navigate(`/w/${workspaceId}/d/${id}`)}
                onOpenChannel={(id) => navigate(`/w/${workspaceId}/c/${id}`)}
              />
            ) : (
              <EmptyState
                icon="chat-dots"
                title="No channel open"
                hint={
                  canManageChannels
                    ? 'Pick a channel on the left, or create one with +.'
                    : 'Pick a channel on the left.'
                }
              />
            )
          ) : allDocuments ? (
            <AllDocuments
              workspaceId={workspaceId}
              onOpen={(id) => navigate(`/w/${workspaceId}/d/${id}`)}
            />
          ) : !documentId ? (
            <EmptyState
              icon="file-earmark-text"
              title="Nothing open"
              hint="Pick a document from the sidebar, press ⌘K to search, or open today's journal."
            />
          ) : document.isLoading ? (
            <Spinner />
          ) : document.error ? (
            <EmptyState icon="exclamation-triangle" title="Could not open that document" hint={(document.error as Error).message} />
          ) : document.data ? (
            <ErrorBoundary resetKey={document.data.id}>
              <DocumentEditor
                doc={document.data}
                workspaceId={workspaceId}
                dark={dark}
                canEdit={canEdit}
                self={{ id: user.id, name: user.name, avatarUrl: user.avatarUrl }}
                onPatch={patch}
                onBlocksChange={setLiveBlocks}
                onOpenDocument={(id) => navigate(`/w/${workspaceId}/d/${id}`)}
                onOpenInternalLink={(path) => navigate(path)}
              />
            </ErrorBoundary>
          ) : null}
        </div>
      </main>

      <aside
        className={cx(
          'shrink-0 overflow-hidden border-l border-[var(--color-line)] transition-[width] duration-200',
          rightOpen && !chat ? 'w-72' : 'w-0',
        )}
      >
        <div className="h-full w-72">
          <RightSidebar
            tab={rightTab}
            onTabChange={setRightTab}
            doc={document.data}
            liveBlocks={liveBlocks}
            workspaceId={workspaceId}
            currentUserId={userId}
            onPatch={patch}
            onDelete={() => {
              if (!documentId) return;
              deleteDocument.mutate(documentId);
              navigate(`/w/${workspaceId}`);
            }}
            onOpenJournal={(date) => setJournalDate(date)}
          />
        </div>
      </aside>

      {settingsSection && workspace && (
        <SettingsDialog
          section={settingsSection}
          onSectionChange={setSettingsSection}
          user={user}
          workspace={workspace}
          theme={theme}
          onThemeChange={setTheme}
          onClose={() => setSettingsSection(null)}
          onWorkspaceDeleted={() => {
            setSettingsSection(null);
            navigate('/');
          }}
          onOpenDocument={(id) => {
            setSettingsSection(null);
            navigate(`/w/${workspaceId}/d/${id}`);
          }}
        />
      )}

      {connectOpen && <ConnectServerDialog onClose={() => setConnectOpen(false)} />}

      {searchOpen && (
        <SearchPalette
          workspaceId={workspaceId}
          initialTagIds={activeTagIds}
          onClose={() => {
            setSearchOpen(false);
            setActiveTagIds([]);
          }}
          onSelect={(id) => navigate(`/w/${workspaceId}/d/${id}`)}
        />
      )}
    </div>
  );
}

/** Kept out of the component body so the DOM name is not shadowed by the `document` query. */
function document_setTheme(dark: boolean) {
  window.document.documentElement.classList.toggle('dark', dark);
}
