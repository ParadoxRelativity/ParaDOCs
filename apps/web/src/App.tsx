import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import {
  directName,
  directPeople,
  isGroupDirect,
  parseMentionHref,
  projectPath,
  type Channel,
  type PresenceStatus,
  type User,
  type WorkspaceApp,
} from '@paradocs/shared';
import {
  useDeleteDocument,
  useDocument,
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
  useProject,
  useSpreadsheet,
  useWorkItemListing,
  usePresenceSettings,
  useVoiceConfig,
  useVoiceParticipants,
  type DocumentPatch,
} from './api/hooks';
import { ApiError } from './api/client';
import { cx, useLocalStorage } from './lib/util';
import { canFrom } from './lib/permissions';
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
import { DirectPeopleButton } from './components/chat/DirectPeople';
import { useCall } from './lib/call';
import { useDirectCalls } from './lib/directCalls';
import { effectiveStatus, useIdle } from './lib/idle';
import { getOpenBehaviour } from './lib/openBehaviour';
import { setMobilePane, useIsMobile, useMobilePane } from './lib/mobile';
import {
  activeTab,
  describePath,
  ensureTabFor,
  openNewTab,
  updateActiveTab,
  useTabState,
  type TabKind,
} from './lib/tabs';
import { useToast } from './components/Toast';
import PopoutWindow from './components/PopoutWindow';
import SpreadsheetView from './components/sheet/SpreadsheetView';
import AccessApp, { isAccessSection } from './components/AccessApp';
import ProjectsApp from './components/projects/ProjectsApp';
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
        passwordSignIn={me.data?.passwordSignIn ?? true}
        oidc={me.data?.oidc ?? { providers: [] }}
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
          <Route path="/w/:workspaceId/c" element={<Workspace user={me.data.user} chat />} />
          <Route path="/w/:workspaceId/s/:sheetId" element={<Workspace user={me.data.user} sheets />} />
          <Route path="/w/:workspaceId/s" element={<Workspace user={me.data.user} sheets />} />
          <Route path="/w/:workspaceId/p/:projectId/:itemId" element={<Workspace user={me.data.user} projects />} />
          <Route path="/w/:workspaceId/p/:projectId" element={<Workspace user={me.data.user} projects />} />
          <Route path="/w/:workspaceId/p" element={<Workspace user={me.data.user} projects />} />
          <Route path="/w/:workspaceId/access/:accessSection" element={<Workspace user={me.data.user} access />} />
          <Route path="/w/:workspaceId/access" element={<Workspace user={me.data.user} access />} />
          {/* Access was once called People; links and tabs from then still land. */}
          <Route path="/w/:workspaceId/people/*" element={<RenamedToAccess />} />
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
  const mobile = useIsMobile();

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

  // Nothing to put tabs above until the app is somewhere tabbable. A phone has
  // no room for a row of them; the effects above still run, so the tab in
  // front keeps following you and the app reopens where you left it.
  if (mobile || !describePath(location.pathname) || tabs.length === 0) return null;

  return (
    <TabBar
      workspaces={workspaces.data ?? []}
      onNewTab={() => {
        // A new tab opens on the workspace you are in, at its front door.
        const workspaceId = activeTab()?.workspaceId ?? workspaces.data?.[0]?.id;
        if (workspaceId) openNewTab(`/w/${workspaceId}`);
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

/**
 * Where the app opens: back to the tab that was in front when it was last
 * used, and the first workspace only when there is no such tab. The tab has to
 * be in a workspace this account still has, or a workspace that is gone would
 * send it back here in a loop.
 */
function FirstWorkspaceRedirect() {
  const workspaces = useWorkspaces();
  if (workspaces.isLoading) return <Spinner />;
  const last = activeTab();
  if (last && workspaces.data?.some((w) => w.id === last.workspaceId)) {
    return <Navigate to={last.path} replace />;
  }
  const first = workspaces.data?.[0];
  if (!first) {
    return <EmptyState icon="exclamation-triangle" title="No workspaces" hint="Your account has no workspace. Try signing out and back in." />;
  }
  return <Navigate to={`/w/${first.id}`} replace />;
}

/** What the server says for anything this reader cannot have: deleted, or not shared with them. */
const isNotFound = (error: unknown) => error instanceof ApiError && error.status === 404;

function RenamedToAccess() {
  const { workspaceId = '', '*': rest = '' } = useParams();
  return <Navigate to={`/w/${workspaceId}/access${rest ? `/${rest}` : ''}`} replace />;
}

/**
 * Where an app starts. Docs has the workspace's front door; Chat lands on its
 * first channel once it knows which that is.
 */
function appHome(workspaceId: string, app: WorkspaceApp): string {
  return app === 'sheets'
    ? `/w/${workspaceId}/s`
    : app === 'chat'
      ? `/w/${workspaceId}/c`
      : app === 'projects'
        ? `/w/${workspaceId}/p`
        : `/w/${workspaceId}`;
}

/** A channel's name, or for a direct conversation, the other people's. */
function conversationName(channel: Channel): string {
  return channel.kind === 'direct' ? directName(channel) : channel.name;
}

function Workspace({
  user,
  allDocuments = false,
  chat = false,
  sheets = false,
  projects = false,
  access = false,
}: {
  user: User;
  allDocuments?: boolean;
  chat?: boolean;
  /** The Sheets app: a list of spreadsheets, or one open. */
  sheets?: boolean;
  /** The Projects app: your work, or a project and perhaps one of its items. */
  projects?: boolean;
  /** The Access app: the workspace's members and teams, and its own settings. */
  access?: boolean;
}) {
  const userId = user.id;
  const { workspaceId = '', documentId, channelId, sheetId, projectId, itemId, accessSection: accessParam } = useParams();
  const accessSection = isAccessSection(accessParam) ? accessParam : 'members';
  // Spreadsheets are their own records, fetched here only to name the header
  // and the tab; the grid itself loads inside the Sheets view.
  const openSheet = useSpreadsheet(sheets ? sheetId : undefined);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();
  // A phone shows the sidebar as a menu or one thing from it, never both.
  const mobile = useIsMobile();
  const mobilePane = useMobilePane();
  /** Goes somewhere to be looked at, which on a phone means leaving the menu for it. */
  const show = useCallback(
    (path: string) => {
      navigate(path);
      setMobilePane('content');
    },
    [navigate],
  );

  const workspaces = useWorkspaces();
  const workspace = workspaces.data?.find((w) => w.id === workspaceId);
  // What this person's role lets them do here. A lock on one thing can take
  // more away, which each thing's own `permission` says.
  const can = canFrom(workspace?.permissions);
  // Owners and admins decide who can see what, and no lock keeps them out.
  const managesAccess = workspace ? workspace.role === 'owner' || workspace.role === 'admin' : false;
  // The apps this workspace has on that this person's role reaches. Nothing
  // belonging to any other is asked for, since the server would refuse it.
  const appOn = (app: WorkspaceApp) => workspace?.visibleApps.includes(app) ?? false;
  const section: WorkspaceApp | 'access' = chat
    ? 'chat'
    : sheets
      ? 'sheets'
      : projects
        ? 'projects'
        : access
          ? 'access'
          : 'docs';
  const openProject = useProject(projects ? projectId : undefined);
  // Counted for the sidebar while Projects is open, and only then.
  const myWork = useWorkItemListing(projects && appOn('projects') ? workspaceId : undefined, { mine: true, open: true, limit: 200 });
  const channels = useChannels(appOn('chat') ? workspaceId : undefined);
  const channelList = channels.data ?? [];
  // Direct conversations are channels too, listed apart and only to the people in them.
  const directs = useDirectConversations(appOn('chat') ? workspaceId : undefined);
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
    selfId: userId,
    muted: quiet,
    onAccepted: (incoming) => show(`/w/${incoming.workspaceId}/c/${incoming.channelId}`),
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
      else show(`/w/${targetWorkspaceId}/c/${id}`);
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
  // On a phone the members and details panels cover the page rather than
  // sharing it, so they start closed and are not the desktop's remembered
  // choice; they close again whenever you move somewhere.
  const [mobileMembersOpen, setMobileMembersOpen] = useState(false);
  const [mobileRightOpen, setMobileRightOpen] = useState(false);
  const pathname = useLocation().pathname;
  useEffect(() => {
    setMobileMembersOpen(false);
    setMobileRightOpen(false);
  }, [pathname, mobilePane]);
  const membersShown = mobile ? mobileMembersOpen : membersOpen;
  const setMembersShown = mobile ? setMobileMembersOpen : setMembersOpen;
  const rightShown = mobile ? mobileRightOpen : rightOpen;
  const setRightShown = mobile ? setMobileRightOpen : setRightOpen;
  const [theme, setTheme] = useTheme();
  const [searchOpen, setSearchOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection | null>(null);
  const [activeTagIds, setActiveTagIds] = useState<string[]>([]);
  const [liveBlocks, setLiveBlocks] = useState<unknown[]>([]);
  const [connectOpen, setConnectOpen] = useState(false);

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
          setMobilePane('content');
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
      : projects
        ? projectId
          ? (openProject.data?.name ?? '')
          : 'My work'
        : access
          ? 'Access'
          : allDocuments
            ? 'All documents'
            : documentId
              ? (openDoc?.title ?? '')
              : (workspace?.name ?? '');
  const tabKind: TabKind = chat
    ? 'chat'
    : sheets
      ? 'sheet'
      : projects
        ? 'project'
        : access
          ? 'access'
        : allDocuments
          ? 'all'
          : documentId
            ? (openDoc?.mode === 'canvas' ? 'canvas' : 'page')
            : 'home';
  const tabEmoji = sheets
    ? (openSheet.data?.icon ?? undefined)
    : projects
      ? (openProject.data?.icon ?? undefined)
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
      const conversation = await openDirect.mutateAsync([memberId]);
      navigate(`/w/${workspaceId}/c/${conversation.id}`);
      return conversation;
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not open the conversation', 'error');
      return null;
    }
  }

  async function callMember(memberId: string, video: boolean) {
    const conversation = await messageMember(memberId);
    if (conversation) directCalls.start(conversation.id, video, directPeople(conversation).length);
  }

  // Where the chat tab lands when the URL names no channel.
  const firstChannelPath = channelList[0] ? `/w/${workspaceId}/c/${channelList[0].id}` : `/w/${workspaceId}/c`;

  // Chat with no channel named opens the first one, once the list says which.
  const firstChannelId = channelList[0]?.id;
  useEffect(() => {
    if (chat && !channelId && firstChannelId) navigate(`/w/${workspaceId}/c/${firstChannelId}`, { replace: true });
  }, [chat, channelId, firstChannelId, workspaceId, navigate]);

  // A channel this visit has already shown. Deleting or leaving one refreshes
  // the list a moment before whoever did it moves on, so its going missing
  // then is theirs to handle, not something to report as unavailable.
  const shownChannel = useRef<string | null>(null);
  useEffect(() => {
    if (activeChannel) shownChannel.current = activeChannel.id;
  }, [activeChannel]);

  // Something no longer there — deleted, or locked away from this reader since
  // the tab or link was made — gives way to the workspace's front door rather
  // than an error about a page nobody just asked for. The server answers both
  // with 404 and nothing else does, so an outage still shows as one.
  const unavailable = isNotFound(document.error)
    ? 'document'
    : isNotFound(openSheet.error)
      ? 'spreadsheet'
      : isNotFound(openProject.error)
        ? 'project'
        : chat && channelId && channels.isSuccess && directs.isSuccess && !activeChannel && shownChannel.current !== channelId
          ? 'conversation'
          : null;
  useEffect(() => {
    if (!unavailable) return;
    toast(`That ${unavailable} is no longer available`);
    navigate(`/w/${workspaceId}`, { replace: true });
    setMobilePane('menu');
    // The toast is stable; including it would change nothing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unavailable, workspaceId, navigate]);

  if (workspaces.isLoading) return <Spinner />;
  if (workspaces.data && !workspace) {
    return <Navigate to="/" replace />;
  }
  // An app turned off — while someone was in it, or in a tab or link from
  // before — gives way to the first one still on.
  if (workspace && section !== 'access' && !appOn(section)) {
    const first = workspace.visibleApps[0];
    return <Navigate to={first ? appHome(workspaceId, first) : `/w/${workspaceId}/access`} replace />;
  }

  const direct = activeChannel?.kind === 'direct' ? activeChannel : null;
  const inDirectCall = direct !== null && call.channelId === direct.id;
  const peerName = direct ? directName(direct) : 'them';
  const group = direct !== null && isGroupDirect(direct);

  return (
    <div className="flex h-full overflow-hidden">
      <aside
        className={cx(
          'shrink-0 overflow-hidden',
          mobile
            ? mobilePane === 'menu'
              ? 'w-full'
              : 'hidden'
            : cx('border-r border-[var(--color-line)] transition-[width] duration-200', leftOpen ? 'w-64' : 'w-0'),
        )}
      >
        <div className={cx('h-full', mobile ? 'w-full' : 'w-64')}>
          <LeftSidebar
            user={user}
            workspaces={workspaces.data ?? []}
            workspaceId={workspaceId}
            onSelectWorkspace={(id) => navigate(`/w/${id}`)}
            documentId={documentId ?? null}
            onSelectDocument={(id) => show(`/w/${workspaceId}/d/${id}`)}
            can={can}
            canManageAccess={managesAccess}
            onDocumentDeleted={(id) => {
              // Deleting the document you are reading has to move you off it,
              // or the page sits on something the server no longer has.
              if (id === documentId) {
                navigate(`/w/${workspaceId}`);
                setMobilePane('menu');
              }
            }}
            onOpenSearch={() => setSearchOpen(true)}
            onOpenAllDocuments={() => show(`/w/${workspaceId}/all`)}
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
            section={section}
            onSelectSection={(next) => {
              if (next === 'docs') navigate(`/w/${workspaceId}`);
              else if (next === 'sheets') navigate(sheetId ? `/w/${workspaceId}/s/${sheetId}` : `/w/${workspaceId}/s`);
              else if (next === 'projects') navigate(projectId ? `/w/${workspaceId}/p/${projectId}` : `/w/${workspaceId}/p`);
              else if (next === 'access') navigate(`/w/${workspaceId}/access`);
              else navigate(channelId ? `/w/${workspaceId}/c/${channelId}` : firstChannelPath);
            }}
            activeProjectId={projects ? (projectId ?? null) : null}
            onSelectProject={(id) => show(`/w/${workspaceId}/p/${id}`)}
            onOpenMyWork={() => show(`/w/${workspaceId}/p`)}
            myWorkCount={myWork.data?.length}
            activeAccessSection={accessSection}
            onSelectAccessSection={(next) => show(`/w/${workspaceId}/access/${next}`)}
            activeSheetId={sheetId ?? null}
            onSelectSheet={(id) => show(`/w/${workspaceId}/s/${id}`)}
            onSheetDeleted={(id) => {
              if (id === sheetId) {
                navigate(`/w/${workspaceId}/s`);
                setMobilePane('menu');
              }
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
              show(`/w/${workspaceId}/c/${id}`);
            }}
            canManageChannels={can('chat.channels')}
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
                    onOpen: () => show(`/w/${workspaceId}/c/${call.channelId}`),
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

      <main className={cx('min-w-0 flex-1 flex-col', mobile && mobilePane === 'menu' ? 'hidden' : 'flex')}>
        <header className="flex h-11 shrink-0 items-center gap-1 border-b border-[var(--color-line)] px-2">
          {mobile ? (
            <IconButton label="Back to menu" onClick={() => setMobilePane('menu')}>
              <Icon name="chevron-left" />
            </IconButton>
          ) : (
            <IconButton label={leftOpen ? 'Hide sidebar' : 'Show sidebar'} onClick={() => setLeftOpen(!leftOpen)}>
              <Icon name={leftOpen ? 'layout-sidebar-inset' : 'layout-sidebar'} />
            </IconButton>
          )}
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
                : projects
                  ? projectId
                    ? `Projects / ${openProject.data?.name ?? ''}`
                    : 'Projects'
                  : access
                  ? 'Access'
                  : allDocuments
                    ? 'All documents'
                    : (document.data?.title ?? '')}
          </span>
          {/* Writing and drawing are two views of one document, so moving
              between them belongs beside the document rather than inside a
              panel. */}
          {!chat && !sheets && !projects && !access && !allDocuments && document.data && (
            <ModeSwitch
              mode={document.data.mode}
              disabled={document.data.permission !== 'edit'}
              onChange={(mode) => patch({ mode })}
            />
          )}
          <NotificationsMenu />
          {chat ? (
            <IconButton
              label={membersShown ? 'Hide members' : 'Show members'}
              aria-pressed={membersShown}
              onClick={() => setMembersShown(!membersShown)}
              className={cx(membersShown && 'text-[var(--color-ink)]')}
            >
              <Icon name="people" />
            </IconButton>
          ) : sheets || projects || access ? null : (
            <>
              <IconButton label="Search (⌘K)" onClick={() => setSearchOpen(true)}>
                <Icon name="search" />
              </IconButton>
              <IconButton
                label={rightShown ? 'Hide details' : 'Show details'}
                onClick={() => setRightShown(!rightShown)}
              >
                <Icon name={rightShown ? 'layout-sidebar-inset-reverse' : 'layout-sidebar-reverse'} />
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
                canModerate={can('chat.moderate') && !direct}
                canEditChannel={can('chat.channels') && activeChannel.kind === 'text'}
                title={direct ? <DirectTitle channel={direct} status={statusOf(direct.peer?.id)} /> : undefined}
                actions={
                  <>
                    {direct?.peer && voiceEnabled && !inDirectCall && (
                      <DirectCallActions
                        name={peerName}
                        onCall={(video) => directCalls.start(direct.id, video, directPeople(direct).length)}
                      />
                    )}
                    {direct && (
                      <DirectPeopleButton
                        workspaceId={workspaceId}
                        channel={direct}
                        self={{ id: user.id, name: user.name, avatarUrl: user.avatarUrl }}
                        presence={presenceMap}
                        onOpenConversation={(id) => navigate(`/w/${workspaceId}/c/${id}`)}
                        onLeft={() => navigate(firstChannelPath)}
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
                              ? group
                                ? 'No one else is in the call'
                                : `${peerName} is not in the call`
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
                onOpenWorkItem={(item) => navigate(`/w/${workspaceId}/p/${item.projectId}/${item.id}`)}
                onOpenProject={(project) => navigate(projectPath(workspaceId, project.id, project.kind))}
              />
            ) : channelId && directs.isLoading ? (
              <Spinner />
            ) : (
              <EmptyState icon="chat-dots" title="No channel open" />
            )
          ) : projects ? (
            workspace ? (
              <ProjectsApp
                workspace={workspace}
                user={user}
                projectId={projectId ?? null}
                itemId={itemId ?? null}
                navigation={{
                  onOpenDocument: (id) => navigate(`/w/${workspaceId}/d/${id}`),
                  onOpenSpreadsheet: (id) => navigate(`/w/${workspaceId}/s/${id}`),
                  onOpenChannel: (id) => navigate(`/w/${workspaceId}/c/${id}`),
                  onOpenWorkItem: (item) => navigate(`/w/${workspaceId}/p/${item.projectId}/${item.id}`),
                  onOpenProject: (project) => navigate(projectPath(workspaceId, project.id, project.kind)),
                }}
                onOpenProject={(id) => navigate(`/w/${workspaceId}/p/${id}`)}
                onOpenItem={(project, item) => navigate(`/w/${workspaceId}/p/${project}/${item}`)}
                onCloseItem={() => navigate(`/w/${workspaceId}/p/${projectId}`)}
                onProjectDeleted={() => navigate(`/w/${workspaceId}/p`)}
              />
            ) : (
              <Spinner />
            )
          ) : access ? (
            workspace ? (
              <AccessApp
                workspace={workspace}
                section={accessSection}
                onWorkspaceDeleted={() => navigate('/')}
                onOpenDocument={(id) => navigate(`/w/${workspaceId}/d/${id}`)}
              />
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
                // The workspace role, and then any lock on this spreadsheet,
                // which the server has already weighed together.
                canEdit={openSheet.data?.permission === 'edit'}
              />
            ) : (
              <EmptyState icon="table" title="No spreadsheet open" />
            )
          ) : allDocuments ? (
            <AllDocuments
              workspaceId={workspaceId}
              onOpen={(id) => navigate(`/w/${workspaceId}/d/${id}`)}
            />
          ) : !documentId ? (
            <EmptyState icon="file-earmark-text" title="Nothing open" />
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
                // The workspace role, and then any lock on this document,
                // which the server has already weighed together.
                canEdit={document.data.permission === 'edit'}
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
        <SidePanel open={membersShown} width="w-60" mobile={mobile} onClose={() => setMembersShown(false)}>
          <MemberList
            workspaceId={workspaceId}
            presence={presenceMap}
            selfStatus={selfStatus}
            voiceEnabled={voiceEnabled}
            onMessage={(id) => void messageMember(id)}
            onCall={(id, video) => void callMember(id, video)}
          />
        </SidePanel>
      ) : sheets || projects || access ? null : (
        <SidePanel open={rightShown} width="w-72" mobile={mobile} onClose={() => setRightShown(false)}>
          <RightSidebar
            tab={rightTab}
            onTabChange={setRightTab}
            doc={document.data}
            liveBlocks={liveBlocks}
            workspaceId={workspaceId}
            currentUserId={userId}
            can={can}
            onPatch={patch}
            onDelete={() => {
              if (!documentId) return;
              deleteDocument.mutate(documentId);
              navigate(`/w/${workspaceId}`);
              setMobilePane('menu');
            }}
          />
        </SidePanel>
      )}

      {settingsSection && (
        <SettingsDialog
          section={settingsSection}
          onSectionChange={setSettingsSection}
          user={user}
          theme={theme}
          onThemeChange={setTheme}
          onClose={() => setSettingsSection(null)}
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
          onSelect={(id) => show(`/w/${workspaceId}/d/${id}`)}
          onSelectSheet={(id) => show(`/w/${workspaceId}/s/${id}`)}
          onSelectWorkItem={
            appOn('projects') ? (hit) => show(`/w/${workspaceId}/p/${hit.projectId}/${hit.id}`) : undefined
          }
        />
      )}

      {directCalls.incoming && (
        <IncomingCallCard
          incoming={directCalls.incoming}
          group={(() => {
            const conversation = directList.find((c) => c.id === directCalls.incoming?.channelId);
            return conversation && isGroupDirect(conversation) ? directName(conversation) : undefined;
          })()}
          inCall={call.channelId !== null}
          onAccept={directCalls.accept}
          onDecline={directCalls.decline}
        />
      )}
    </div>
  );
}

/**
 * A panel on the right of the page: members beside a conversation, details
 * beside a document. On a desktop it takes its width from the page and slides
 * shut; a phone has no width to give, so there it covers the page from the
 * right with a scrim behind it that closes it when tapped.
 */
function SidePanel({
  open,
  width,
  mobile,
  onClose,
  children,
}: {
  open: boolean;
  width: 'w-60' | 'w-72';
  mobile: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  if (mobile) {
    if (!open) return null;
    return (
      <>
        <div className="fixed inset-0 z-30 bg-black/40" onClick={onClose} aria-hidden />
        <aside className="fixed inset-y-0 right-0 z-40 w-[85vw] max-w-80 border-l border-[var(--color-line)] bg-[var(--color-canvas)] pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] shadow-xl">
          {children}
        </aside>
      </>
    );
  }
  return (
    <aside
      className={cx(
        'shrink-0 overflow-hidden border-l border-[var(--color-line)] transition-[width] duration-200',
        open ? width : 'w-0',
      )}
    >
      <div className={cx('h-full', width)}>{children}</div>
    </aside>
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
