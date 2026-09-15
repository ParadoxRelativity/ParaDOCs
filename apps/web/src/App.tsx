import { useCallback, useEffect, useRef, useState } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { parseMentionHref, type Channel, type PresenceStatus, type User } from '@paradocs/shared';
import {
  useDeleteDocument,
  useDocument,
  useJournal,
  useLogout,
  useMe,
  useUpdateDocument,
  useWorkspaces,
  useChannels,
  useDirectConversations,
  useMarkMentionsRead,
  useNotifications,
  useOpenDirect,
  usePresence,
  useSpreadsheet,
  usePresenceSettings,
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
import { desktop, usePoppedOut } from './lib/desktop';
import { useTheme } from './lib/theme';
import ModeSwitch from './components/ModeSwitch';
import TabBar from './components/TabBar';
import NotificationsMenu from './components/NotificationsMenu';
import SearchPalette from './components/SearchPalette';
import { ChatView } from './components/chat/ChatView';
import { useChatEvents } from './lib/chatEvents';
import { VoiceRoom } from './components/chat/VoiceRoom';
import { CallStage } from './components/chat/CallStage';
import { MemberList } from './components/chat/MemberList';
import { IncomingCallCard } from './components/chat/IncomingCall';
import { DirectCallActions, DirectTitle } from './components/chat/DirectHeader';
import { useCall } from './lib/call';
import { useDirectCalls } from './lib/directCalls';
import { effectiveStatus, useIdle } from './lib/idle';
import { getOpenBehaviour } from './lib/openBehaviour';
import {
  activeTab,
  describePath,
  ensureTabFor,
  openTab,
  updateActiveTab,
  useTabState,
  type TabKind,
} from './lib/tabs';
import { useToast } from './components/Toast';
import PopoutWindow from './components/PopoutWindow';
import SpreadsheetView from './components/sheet/SpreadsheetView';
import PeopleApp, { isPeopleSection } from './components/PeopleApp';
import { Button, EmptyState, IconButton, Spinner } from './components/ui';
import Icon from './components/Icon';

export default function App() {
  const me = useMe();
  // A popped-out channel is this same client on the same session, with only
  // the one conversation in it. It has no menu to be steered from, so the
  // command listener that follows the desktop menu stays out of its way.
  const popout = useLocation().pathname.startsWith('/popout/');

  if (me.isLoading) return <Spinner />;
  if (!me.data?.user) {
    return (
      <AuthScreen
        allowRegistration={me.data?.allowRegistration ?? false}
        oidc={me.data?.oidc ?? { enabled: false, configured: false, providerName: 'SSO' }}
      />
    );
  }

  // A popped-out channel is one conversation in a window of its own; a row of
  // tabs above it would be offering to turn it back into the whole app.
  return (
    <div className="flex h-full flex-col overflow-hidden">
      {desktop && !popout && <DesktopNavigation />}
      {!popout && <TabStrip />}
      <div className="min-h-0 flex-1">
        <Routes>
          <Route path="/popout/:workspaceId/:channelId" element={<PopoutWindow user={me.data.user} />} />
          <Route path="/invite/:token" element={<AcceptInvite />} />
          <Route path="/w/:workspaceId/d/:documentId" element={<Workspace user={me.data.user} />} />
          <Route path="/w/:workspaceId/all" element={<Workspace user={me.data.user} allDocuments />} />
          <Route path="/w/:workspaceId/c/:channelId" element={<Workspace user={me.data.user} chat />} />
          <Route path="/w/:workspaceId/s/:sheetId" element={<Workspace user={me.data.user} sheets />} />
          <Route path="/w/:workspaceId/s" element={<Workspace user={me.data.user} sheets />} />
          <Route path="/w/:workspaceId/people/:peopleSection" element={<Workspace user={me.data.user} people />} />
          <Route path="/w/:workspaceId/people" element={<Workspace user={me.data.user} people />} />
          <Route path="/w/:workspaceId" element={<Workspace user={me.data.user} />} />
          <Route path="*" element={<FirstWorkspaceRedirect />} />
        </Routes>
      </div>
    </div>
  );
}

/**
 * The tab bar, and the two halves of keeping it honest.
 *
 * Navigating anywhere — a link, the sidebar, a redirect — writes that path into
 * the tab in front, so a tab always describes where it actually is without
 * every call site having to say so. Activating a tab navigates to its path.
 * The two cannot chase each other: the second only fires when the chosen tab
 * changes, and by then the first has nothing new to write.
 */
function TabStrip() {
  const location = useLocation();
  const navigate = useNavigate();
  const workspaces = useWorkspaces();
  const { tabs, activeId } = useTabState();
  const lastActivated = useRef<string | null>(activeId);

  // There is always somewhere the app is, so there is always at least one tab.
  useEffect(() => {
    if (describePath(location.pathname)) ensureTabFor(location.pathname);
  }, [location.pathname]);

  useEffect(() => {
    if (describePath(location.pathname)) updateActiveTab({ path: location.pathname });
  }, [location.pathname]);

  useEffect(() => {
    if (activeId === lastActivated.current) return;
    lastActivated.current = activeId;
    const tab = activeTab();
    if (tab && tab.path !== location.pathname) navigate(tab.path);
    // Following the chosen tab is the whole job here; the location is read for
    // the comparison, not depended on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, navigate]);

  // Nothing to put tabs above until the app is somewhere tabbable.
  if (!describePath(location.pathname) || tabs.length === 0) return null;

  return (
    <TabBar
      workspaces={workspaces.data ?? []}
      onNewTab={() => {
        // A new tab opens on the workspace you are in, at its front door.
        const workspaceId = activeTab()?.workspaceId ?? workspaces.data?.[0]?.id;
        if (workspaceId) openTab(`/w/${workspaceId}`, '');
      }}
    />
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

/** A channel's name, or for a direct conversation, the other person's. */
function conversationName(channel: Channel): string {
  return channel.kind === 'direct' ? (channel.peer?.name ?? 'Deleted account') : channel.name;
}

function Workspace({
  user,
  allDocuments = false,
  chat = false,
  sheets = false,
  people = false,
}: {
  user: User;
  allDocuments?: boolean;
  chat?: boolean;
  /** The Sheets app: a list of spreadsheets, or one open. */
  sheets?: boolean;
  /** The People app: the workspace's members, and the teams they are on. */
  people?: boolean;
}) {
  const userId = user.id;
  const { workspaceId = '', documentId, channelId, sheetId, peopleSection: peopleParam } = useParams();
  const peopleSection = isPeopleSection(peopleParam) ? peopleParam : 'members';
  // Spreadsheets are their own records, fetched here only to name the header
  // and the tab; the grid itself loads inside the Sheets view.
  const openSheet = useSpreadsheet(sheets ? sheetId : undefined);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();

  const workspaces = useWorkspaces();
  const workspace = workspaces.data?.find((w) => w.id === workspaceId);
  // Viewers get the whole app read-only; editors and above can write.
  const canEdit = workspace ? workspace.role !== 'viewer' : false;
  // Owners and admins manage channels; everyone else just reads and posts.
  const canManageChannels = workspace ? workspace.role === 'owner' || workspace.role === 'admin' : false;
  const channels = useChannels(workspaceId);
  const channelList = channels.data ?? [];
  // Direct conversations are channels too, listed apart and only to the people in them.
  const directs = useDirectConversations(workspaceId);
  const directList = directs.data ?? [];
  const findConversation = (id: string | null | undefined) =>
    id ? (channelList.find((c) => c.id === id) ?? directList.find((c) => c.id === id)) : undefined;
  const activeChannel = findConversation(channelId);
  const directUnread = directList.reduce((total, c) => total + (c.unread ?? 0), 0);
  const unreadTotal = channelList.reduce((total, c) => total + (c.unread ?? 0), 0) + directUnread;
  // Everything said in a direct conversation is said to you, so it counts the
  // way a mention does.
  const mentionTotal = channelList.reduce((total, c) => total + (c.mentions ?? 0), 0) + directUnread;
  const voice = useVoiceConfig();
  const voiceEnabled = voice.data?.enabled ?? false;
  // The call belongs to the session, not to the view: clicking a voice channel
  // joins it, and it keeps running while you read a document or move around.
  const call = useCall();
  const callChannel = findConversation(call.channelId);
  // Only polled while chat is open; a document reader has no use for it.
  const voiceParticipants = useVoiceParticipants(workspaceId, chat && voiceEnabled);
  // Conversations the desktop app has in windows of their own. They are still
  // this app's: they share the session, and they close when it does.
  const poppedOut = usePoppedOut();
  const poppedOutIds = poppedOut.map((entry) => entry.channelId);
  const isPoppedOut = (id: string | null | undefined) => Boolean(id) && poppedOutIds.includes(id!);
  // A call runs in one window at a time, so when it is not this one it is in
  // one of these — and the sidebar has to say so, or a call simply disappears
  // from the app that started it.
  const callElsewhere = poppedOut.find((entry) => entry.inCall);

  const presence = usePresence(workspaceId);
  const presenceMap = presence.data ?? {};
  const presenceSettings = usePresenceSettings();
  const chosenStatus = presenceSettings.data?.status ?? 'online';
  const idle = useIdle(presenceSettings.data?.awayAfterMinutes ?? 10, call.status === 'joined');
  const selfStatus = effectiveStatus(chosenStatus, idle);
  const statusOf = (id: string | undefined): PresenceStatus =>
    !id ? 'offline' : id === userId ? selfStatus : (presenceMap[id] ?? 'offline');
  // Busy mutes what would otherwise interrupt: notifications and ringing.
  const quiet = chosenStatus === 'busy';

  const elsewhereChannel = findConversation(callElsewhere?.channelId);

  const directCalls = useDirectCalls({
    call,
    muted: quiet,
    onAccepted: (incoming) => navigate(`/w/${incoming.workspaceId}/c/${incoming.channelId}`),
  });

  // Chat's socket lives here, not in the chat view: a mention has to reach you
  // while you are reading a document or sitting in another channel.
  const chatEvents = useChatEvents({
    workspaceId,
    channels: channelList,
    selfId: userId,
    activeChannelId: chat ? (channelId ?? null) : null,
    idle,
    quiet,
    onNotifyClick: (targetWorkspaceId, id) => {
      // Clicking a mention should land on the conversation wherever it is
      // being read, which may be a window of its own rather than this one.
      if (isPoppedOut(id)) void desktop?.popouts.focus(id).catch(() => {});
      else navigate(`/w/${targetWorkspaceId}/c/${id}`);
    },
    onCallEvent: (event) => {
      // A call can be the first anyone hears of a conversation.
      if (event.type === 'call.ringing') void queryClient.invalidateQueries({ queryKey: ['directs'] });
      directCalls.handleEvent(event);
    },
  });

  const openDirect = useOpenDirect(workspaceId);

  const document = useDocument(documentId);
  const updateDocument = useUpdateDocument(workspaceId, documentId ?? '');
  const deleteDocument = useDeleteDocument(workspaceId);
  const logout = useLogout();

  const [leftOpen, setLeftOpen] = useLocalStorage('paradocs.leftOpen', true);
  const [rightOpen, setRightOpen] = useLocalStorage('paradocs.rightOpen', true);
  const [membersOpen, setMembersOpen] = useLocalStorage('paradocs.membersOpen', true);
  const [rightTab, setRightTab] = useLocalStorage<RightTab>('paradocs.rightTab', 'toc');
  const [theme, setTheme] = useTheme();
  const [searchOpen, setSearchOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection | null>(null);
  const [activeTagIds, setActiveTagIds] = useState<string[]>([]);
  const [liveBlocks, setLiveBlocks] = useState<unknown[]>([]);
  const [journalDate, setJournalDate] = useState<string | null>(null);
  const [connectOpen, setConnectOpen] = useState(false);

  const journal = useJournal(workspaceId, journalDate ?? todayISO(), journalDate !== null);

  /**
   * Opening a document you were tagged in answers the tag, however you got
   * there — the bell, a link, or the sidebar. Only documents actually carrying
   * one are cleared, so this costs nothing on an ordinary open.
   */
  const notifications = useNotifications();
  const markMentionsRead = useMarkMentionsRead();
  const taggedHere = notifications.data?.mentions?.some((m) => m.documentId === documentId) ?? false;
  useEffect(() => {
    if (documentId && taggedHere) markMentionsRead.mutate([documentId]);
    // The mutation object is stable; including it would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documentId, taggedHere]);

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

  // The desktop menu reaches into the page to open Settings or add a server,
  // and a pop-out reaches into it to give a conversation back. Both arrive on
  // the same channel; the handler is re-read from a ref so that taking a call
  // back does not depend on when this effect last ran.
  const latest = useRef({ call, navigate, workspaceId });
  latest.current = { call, navigate, workspaceId };
  useEffect(
    () =>
      desktop?.onCommand((command) => {
        if (command.type === 'open-settings' && isSettingsSection(command.section)) {
          setSettingsSection(command.section);
        } else if (command.type === 'connect-server') {
          setConnectOpen(true);
        } else if (command.type === 'take-call') {
          // The window that had it has already left, so this joins rather than
          // moving anyone: showing the channel without rejoining would look
          // like the call had simply been dropped.
          const current = latest.current;
          current.navigate(`/w/${command.workspaceId}/c/${command.channelId}`);
          if (command.join) current.call.join(command.channelId);
        }
      }),
    [],
  );

  const patch = useCallback((p: DocumentPatch) => updateDocument.mutate(p), [updateDocument]);

  /**
   * Names the tab this view is filling. The path says which workspace and
   * roughly what, but only the view knows the document's title, whether it is a
   * page or a canvas, and which conversation a channel id is.
   */
  const openDoc = document.data;
  const tabLabel = chat
    ? activeChannel
      ? activeChannel.kind === 'direct'
        ? conversationName(activeChannel)
        : `#${activeChannel.name}`
      : 'Chat'
    : sheets
      ? sheetId
        ? (openSheet.data?.title ?? '')
        : 'Spreadsheets'
      : people
        ? 'People'
        : allDocuments
          ? 'All documents'
          : documentId
            ? (openDoc?.title ?? '')
            : (workspace?.name ?? '');
  const tabKind: TabKind = chat
    ? 'chat'
    : sheets
      ? 'sheet'
      : people
        ? 'people'
        : allDocuments
          ? 'all'
          : documentId
            ? (openDoc?.mode === 'canvas' ? 'canvas' : 'page')
            : 'home';
  const tabEmoji = sheets
    ? (openSheet.data?.icon ?? undefined)
    : !chat && !allDocuments && documentId
      ? (openDoc?.icon ?? undefined)
      : undefined;
  useEffect(() => {
    updateActiveTab({ label: tabLabel, kind: tabKind, emoji: tabEmoji, workspaceId });
  }, [tabLabel, tabKind, tabEmoji, workspaceId]);

  /**
   * Moves a conversation into a window of its own.
   *
   * A call goes with it rather than being copied into it: audio and video
   * belong to the page playing them, so this window leaves the room and the new
   * one joins as it opens. Everything else — messages, typing, who is around —
   * genuinely is shared, because both windows are the same client on the same
   * session talking to the same server.
   *
   * Leaving first is what keeps the room from seeing one person arrive twice,
   * but it also means a window that never opens would have cost you the call.
   * So the leave is provisional: if there turns out to be nowhere for the call
   * to go, it comes back here.
   */
  function popOut(target: Channel, withCall: boolean) {
    if (!desktop) return;
    if (withCall) call.leave();

    /**
     * Rejoins what the leave above gave up, and only if the call is still
     * where it was left. Between the two there is a trip through the desktop
     * app, and in that time someone may have answered a call or joined another
     * room — that call is the one they want, not this one.
     */
    const restoreCall = () => {
      const current = latest.current.call;
      if (withCall && current.channelId === null && current.status === 'idle') current.join(target.id);
    };

    const failed = (message: string) => {
      toast(message, 'error');
      restoreCall();
    };

    void desktop.popouts
      .open({
        workspaceId,
        channelId: target.id,
        kind: target.kind === 'voice' || withCall ? 'voice' : 'text',
        title:
          target.kind === 'text' ? `#${target.name}` : conversationName(target),
        withCall,
      })
      .then((result) => {
        if (!result.ok) failed(result.error);
      })
      .catch(() => failed('Could not open that window'));
  }

  /** Asks a window for its conversation back; a call in it comes back too. */
  const recall = (id: string) => void desktop?.popouts.recall(id).catch(() => {});

  const popOutButton = (target: Channel, withCall: boolean) => (
    <IconButton
      label={withCall ? 'Move this call to its own window' : 'Open this in its own window'}
      onClick={() => popOut(target, withCall)}
    >
      <Icon name="box-arrow-up-right" />
    </IconButton>
  );

  /** Opens the conversation with someone, starting it if need be. */
  async function messageMember(memberId: string): Promise<Channel | null> {
    try {
      const conversation = await openDirect.mutateAsync(memberId);
      navigate(`/w/${workspaceId}/c/${conversation.id}`);
      return conversation;
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not open the conversation', 'error');
      return null;
    }
  }

  async function callMember(memberId: string, video: boolean) {
    const conversation = await messageMember(memberId);
    if (conversation) directCalls.start(conversation.id, video);
  }

  // Where the chat tab lands when the URL names no channel.
  const firstChannelPath = channelList[0] ? `/w/${workspaceId}/c/${channelList[0].id}` : `/w/${workspaceId}`;

  if (workspaces.isLoading) return <Spinner />;
  if (workspaces.data && !workspaces.data.some((w) => w.id === workspaceId)) {
    return <Navigate to="/" replace />;
  }

  const direct = activeChannel?.kind === 'direct' ? activeChannel : null;
  const inDirectCall = direct !== null && call.channelId === direct.id;
  const peerName = direct?.peer?.name ?? 'them';

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
            canEdit={canEdit}
            canManageAccess={canManageChannels}
            onDocumentDeleted={(id) => {
              // Deleting the document you are reading has to move you off it,
              // or the page sits on something the server no longer has.
              if (id === documentId) navigate(`/w/${workspaceId}`);
            }}
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
            section={chat ? 'chat' : sheets ? 'sheets' : people ? 'people' : 'docs'}
            onSelectSection={(next) => {
              if (next === 'docs') navigate(`/w/${workspaceId}`);
              else if (next === 'sheets') navigate(sheetId ? `/w/${workspaceId}/s/${sheetId}` : `/w/${workspaceId}/s`);
              else if (next === 'people') navigate(`/w/${workspaceId}/people`);
              else navigate(channelId ? `/w/${workspaceId}/c/${channelId}` : firstChannelPath);
            }}
            activePeopleSection={peopleSection}
            onSelectPeopleSection={(next) => navigate(`/w/${workspaceId}/people/${next}`)}
            activeSheetId={sheetId ?? null}
            onSelectSheet={(id) => navigate(`/w/${workspaceId}/s/${id}`)}
            onSheetDeleted={(id) => {
              if (id === sheetId) navigate(`/w/${workspaceId}/s`);
            }}
            channels={channelList}
            directs={directList}
            presence={presenceMap}
            selfStatus={selfStatus}
            activeChannelId={channelId ?? null}
            onSelectChannel={(id) => {
              // Clicking a voice channel joins it, the way it works elsewhere;
              // a text channel or direct conversation is only ever opened. One
              // already in a window of its own is brought forward instead:
              // joining here would take the call away from where it is running.
              if (isPoppedOut(id)) void desktop?.popouts.focus(id).catch(() => {});
              else if (channelList.find((c) => c.id === id)?.kind === 'voice') call.join(id);
              navigate(`/w/${workspaceId}/c/${id}`);
            }}
            canManageChannels={canManageChannels}
            unreadTotal={unreadTotal}
            mentionTotal={mentionTotal}
            voiceEnabled={voiceEnabled}
            voiceOccupancy={voiceParticipants.data ?? {}}
            // A call in a window of its own is still your call, so the
            // channel is marked the same way wherever it is running.
            connectedChannelId={call.channelId ?? callElsewhere?.channelId ?? null}
            poppedOutChannelIds={poppedOutIds}
            callBar={
              call.channelId
                ? {
                    channelName: callChannel ? conversationName(callChannel) : 'call',
                    direct: callChannel?.kind === 'direct',
                    connecting: call.status === 'joining',
                    mic: call.mic,
                    onToggleMic: () => call.toggle('mic'),
                    onLeave: call.leave,
                    onOpen: () => navigate(`/w/${workspaceId}/c/${call.channelId}`),
                    onPopOut: desktop && callChannel ? () => popOut(callChannel, true) : undefined,
                  }
                : callElsewhere
                  ? {
                      // Its own title is the fallback: a direct conversation
                      // this window has never listed has no channel to name.
                      channelName: elsewhereChannel
                        ? conversationName(elsewhereChannel)
                        : callElsewhere.title,
                      direct: elsewhereChannel?.kind === 'direct',
                      connecting: false,
                      mic: false,
                      // Muting and hanging up belong to the window actually in
                      // the call; from here the useful thing is finding it.
                      onOpen: () => void desktop?.popouts.focus(callElsewhere.channelId).catch(() => {}),
                      onShowWindow: () => void desktop?.popouts.focus(callElsewhere.channelId).catch(() => {}),
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
                ? activeChannel.kind === 'direct'
                  ? conversationName(activeChannel)
                  : `#${activeChannel.name}`
                : 'Chat'
              : sheets
                ? sheetId
                  ? (openSheet.data?.title ?? '')
                  : 'Spreadsheets'
                : people
                  ? 'People'
                  : allDocuments
                    ? 'All documents'
                    : (document.data?.title ?? '')}
          </span>
          {/* Writing and drawing are two views of one document, so moving
              between them belongs beside the document rather than inside a
              panel. A journal entry is a dated page and has nowhere to slide. */}
          {!chat && !sheets && !people && !allDocuments && document.data && !document.data.isJournal && (
            <ModeSwitch
              mode={document.data.mode}
              disabled={!canEdit || document.data.permission !== 'edit'}
              onChange={(mode) => patch({ mode })}
            />
          )}
          <NotificationsMenu />
          {chat ? (
            <IconButton
              label={membersOpen ? 'Hide members' : 'Show members'}
              aria-pressed={membersOpen}
              onClick={() => setMembersOpen(!membersOpen)}
              className={cx(membersOpen && 'text-[var(--color-ink)]')}
            >
              <Icon name="people" />
            </IconButton>
          ) : sheets || people ? null : (
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
            ) : activeChannel && isPoppedOut(activeChannel.id) ? (
              <InItsOwnWindow
                name={activeChannel.kind === 'text' ? `#${activeChannel.name}` : conversationName(activeChannel)}
                onShow={() => void desktop?.popouts.focus(activeChannel.id).catch(() => {})}
                onBringBack={() => recall(activeChannel.id)}
              />
            ) : activeChannel?.kind === 'voice' ? (
              <VoiceRoom
                key={activeChannel.id}
                channel={activeChannel}
                config={voice.data}
                call={call}
                selfName={user.name}
                actions={desktop && popOutButton(activeChannel, call.channelId === activeChannel.id)}
              />
            ) : activeChannel ? (
              <ChatView
                key={activeChannel.id}
                workspaceId={workspaceId}
                channel={activeChannel}
                channels={channelList}
                selfId={userId}
                // A lock can leave a channel readable but not writable.
                canPost={Boolean(workspace) && activeChannel.permission !== 'view'}
                // No one moderates a conversation they are not part of.
                canModerate={canManageChannels && !direct}
                canEditChannel={canManageChannels && activeChannel.kind === 'text'}
                title={direct ? <DirectTitle channel={direct} status={statusOf(direct.peer?.id)} /> : undefined}
                actions={
                  <>
                    {direct?.peer && voiceEnabled && !inDirectCall && (
                      <DirectCallActions
                        name={direct.peer.name}
                        onCall={(video) => directCalls.start(direct.id, video)}
                      />
                    )}
                    {desktop && popOutButton(activeChannel, inDirectCall)}
                  </>
                }
                stage={
                  inDirectCall ? (
                    <div className="h-[45%] min-h-60 shrink-0 border-b border-[var(--color-line)]">
                      <CallStage
                        call={call}
                        selfName={user.name}
                        notice={
                          directCalls.ringingOut === direct.id
                            ? `Calling ${peerName}…`
                            : call.participants.length <= 1
                              ? `${peerName} is not in the call`
                              : null
                        }
                      />
                    </div>
                  ) : undefined
                }
                status={chatEvents.status}
                notifications={chatEvents.permission}
                onEnableNotifications={chatEvents.requestPermission}
                onTyping={chatEvents.sendTyping}
                onOpenDocument={(id) => navigate(`/w/${workspaceId}/d/${id}`)}
                onOpenSpreadsheet={(id) => navigate(`/w/${workspaceId}/s/${id}`)}
                onOpenChannel={(id) => navigate(`/w/${workspaceId}/c/${id}`)}
              />
            ) : channelId && directs.isLoading ? (
              <Spinner />
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
          ) : people ? (
            workspace ? (
              <PeopleApp workspace={workspace} section={peopleSection} />
            ) : (
              <Spinner />
            )
          ) : sheets ? (
            sheetId ? (
              <SpreadsheetView
                key={sheetId}
                workspaceId={workspaceId}
                sheetId={sheetId}
                self={{ id: user.id, name: user.name, avatarUrl: user.avatarUrl }}
                canEdit={canEdit}
              />
            ) : (
              <EmptyState
                icon="table"
                title="No spreadsheet open"
                hint={canEdit ? 'Pick one on the left, or create one with +.' : 'Pick a spreadsheet on the left.'}
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
                // The workspace role, and then any lock on this document.
                canEdit={canEdit && document.data.permission === 'edit'}
                self={{ id: user.id, name: user.name, avatarUrl: user.avatarUrl }}
                onPatch={patch}
                onBlocksChange={setLiveBlocks}
                onOpenDocument={(id) => navigate(`/w/${workspaceId}/d/${id}`)}
                onOpenInternalLink={(path) => {
                  // A tag is a link to a person, and a person is not a page:
                  // following one opens the conversation with them.
                  const mention = parseMentionHref(path);
                  if (mention) void messageMember(mention.userId);
                  else navigate(path);
                }}
              />
            </ErrorBoundary>
          ) : null}
        </div>
      </main>

      {/* Chat has no document details to show; who is around takes that side
          instead. A spreadsheet has neither, and wants the width for columns. */}
      {chat ? (
        <aside
          className={cx(
            'shrink-0 overflow-hidden border-l border-[var(--color-line)] transition-[width] duration-200',
            membersOpen ? 'w-60' : 'w-0',
          )}
        >
          <div className="h-full w-60">
            <MemberList
              workspaceId={workspaceId}
              presence={presenceMap}
              selfStatus={selfStatus}
              voiceEnabled={voiceEnabled}
              onMessage={(id) => void messageMember(id)}
              onCall={(id, video) => void callMember(id, video)}
            />
          </div>
        </aside>
      ) : sheets || people ? null : (
        <aside
          className={cx(
            'shrink-0 overflow-hidden border-l border-[var(--color-line)] transition-[width] duration-200',
            rightOpen ? 'w-72' : 'w-0',
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
      )}

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
          onSelectSheet={(id) => navigate(`/w/${workspaceId}/s/${id}`)}
        />
      )}

      {directCalls.incoming && (
        <IncomingCallCard
          incoming={directCalls.incoming}
          inCall={call.channelId !== null}
          onAccept={directCalls.accept}
          onDecline={directCalls.decline}
        />
      )}
    </div>
  );
}

/**
 * What the main window shows where a conversation would be when that
 * conversation is being read in a window of its own. Two live copies of one
 * channel is not twice as useful — it is two places for the same unread badge
 * to be cleared from — so this points at the window that has it instead.
 */
function InItsOwnWindow({
  name,
  onShow,
  onBringBack,
}: {
  name: string;
  onShow: () => void;
  onBringBack: () => void;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
      <div className="text-3xl opacity-40">
        <Icon name="window-stack" />
      </div>
      <p className="text-sm font-medium">{name} is in its own window</p>
      <p className="max-w-xs text-xs text-[var(--color-muted)]">
        It is still part of this app — it shares your session, and it closes when this window does.
      </p>
      <div className="flex gap-2">
        <Button variant="subtle" onClick={onShow}>
          Show that window
        </Button>
        <Button variant="subtle" onClick={onBringBack}>
          Bring it back here
        </Button>
      </div>
    </div>
  );
}

/** Kept out of the component body so the DOM name is not shadowed by the `document` query. */
function document_setTheme(dark: boolean) {
  window.document.documentElement.classList.toggle('dark', dark);
}
