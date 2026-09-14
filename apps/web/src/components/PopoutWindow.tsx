import { useEffect, useRef } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import type { User } from '@paradocs/shared';
import {
  useChannels,
  useDirectConversations,
  usePresence,
  usePresenceSettings,
  useVoiceConfig,
  useWorkspaces,
} from '../api/hooks';
import { desktop } from '../lib/desktop';
import { useCall } from '../lib/call';
import { useDirectCalls } from '../lib/directCalls';
import { useChatEvents } from '../lib/chatEvents';
import { useIdle } from '../lib/idle';
import { useTheme } from '../lib/theme';
import { ChatView } from './chat/ChatView';
import { VoiceRoom } from './chat/VoiceRoom';
import { CallStage } from './chat/CallStage';
import { DirectCallActions, DirectTitle } from './chat/DirectHeader';
import { EmptyState, IconButton, Spinner } from './ui';
import Icon from './Icon';

/**
 * One conversation, in a window of its own.
 *
 * This is the whole app minus the app: the same page, the same session and the
 * same server, with everything that is about moving around — the sidebars, the
 * search, the document half — left out, because a window opened to watch one
 * channel is not a place to go wandering. What it keeps is what makes the
 * channel live: its own chat socket, so messages and typing arrive here
 * directly, and its own call, because audio and video belong to the page
 * playing them and cannot be watched from another window.
 *
 * A call therefore moves rather than copies. The window that had it leaves as
 * this one joins, and handing it back reverses that, which is why the controls
 * below speak of taking the call with you.
 */
export default function PopoutWindow({ user }: { user: User }) {
  const { workspaceId = '', channelId = '' } = useParams();
  const [search] = useSearchParams();
  const queryClient = useQueryClient();
  const [theme] = useTheme();

  const workspaces = useWorkspaces();
  const workspace = workspaces.data?.find((w) => w.id === workspaceId);
  const channels = useChannels(workspaceId);
  const channelList = channels.data ?? [];
  const directs = useDirectConversations(workspaceId);
  const directList = directs.data ?? [];
  const channel =
    channelList.find((c) => c.id === channelId) ?? directList.find((c) => c.id === channelId);

  const voice = useVoiceConfig();
  const voiceEnabled = voice.data?.enabled ?? false;
  const presence = usePresence(workspaceId);
  const presenceSettings = usePresenceSettings();

  const call = useCall();
  const inCall = call.channelId === channelId;
  const idle = useIdle(presenceSettings.data?.awayAfterMinutes ?? 10, call.status === 'joined');

  const directCalls = useDirectCalls({
    call,
    // The main window rings and shows the card for an incoming call; this one
    // would only be a second copy of a sound that is already playing.
    muted: true,
    onAccepted: () => {},
  });

  const chatEvents = useChatEvents({
    workspaceId,
    channels: channelList,
    selfId: user.id,
    activeChannelId: channelId,
    idle,
    quiet: presenceSettings.data?.status === 'busy',
    // The main window announces mentions for every channel, this one included.
    // Two windows on one socket would otherwise announce each of them twice.
    notify: false,
    onNotifyClick: () => {},
    onCallEvent: (event) => {
      if (event.type === 'call.ringing') void queryClient.invalidateQueries({ queryKey: ['directs'] });
      directCalls.handleEvent(event);
    },
  });

  const dark = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  useEffect(() => {
    window.document.documentElement.classList.toggle('dark', dark);
  }, [dark]);

  // The call came with the window: the main one has already left the room, so
  // joining is the second half of a handover rather than a fresh join.
  const joined = useRef(false);
  useEffect(() => {
    if (joined.current || search.get('call') !== '1' || !channel) return;
    joined.current = true;
    call.join(channelId);
    // `call` is rebuilt every render; joining depends only on the channel being known.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel, channelId, search]);

  // The main window can hand a call over to a window that is already open.
  const latest = useRef({ call, channelId });
  latest.current = { call, channelId };
  useEffect(
    () =>
      desktop?.onCommand((command) => {
        const { call: current, channelId: id } = latest.current;
        if (command.type !== 'take-call' && command.type !== 'hand-back') return;
        if (command.channelId !== id) return;
        if (command.type === 'take-call') {
          joined.current = true;
          if (command.join && current.channelId !== id) current.join(id);
        } else if (command.type === 'hand-back') {
          void desktop?.popouts.handBack(id, current.channelId === id).catch(() => {});
        }
      }),
    [],
  );

  // The main window cannot see into this one, so it is told where the call is:
  // otherwise moving a call here makes it vanish from the app that opened it.
  useEffect(() => {
    void desktop?.popouts.callState(channelId, inCall).catch(() => {});
  }, [channelId, inCall]);

  /** Gives the conversation back to the main window, call and all, and closes this one. */
  const handBack = () => void desktop?.popouts.handBack(channelId, inCall).catch(() => {});
  /** Anything this window links to but has no room for opens in the main one. */
  const showInMain = (path: string) => void desktop?.popouts.showInMain(path).catch(() => {});

  const popIn = (
    <IconButton
      label="Put this back in the main window"
      onClick={handBack}
      className="text-[var(--color-muted)]"
    >
      <Icon name="box-arrow-in-down-left" />
    </IconButton>
  );

  if (channels.isLoading || directs.isLoading || workspaces.isLoading) return <Spinner />;
  if (!channel) {
    return (
      <EmptyState
        icon="exclamation-triangle"
        title="This conversation is no longer here"
        hint="It may have been deleted, or you may no longer be in it. Closing this window is safe."
      />
    );
  }

  if (channel.kind === 'voice') {
    return (
      <div className="h-full">
        <VoiceRoom channel={channel} config={voice.data} call={call} selfName={user.name} actions={popIn} />
      </div>
    );
  }

  const direct = channel.kind === 'direct' ? channel : null;
  const peerName = direct?.peer?.name ?? 'them';
  const canManage = workspace?.role === 'owner' || workspace?.role === 'admin';

  return (
    <div className="h-full">
      <ChatView
        workspaceId={workspaceId}
        channel={channel}
        channels={channelList}
        selfId={user.id}
        canPost={Boolean(workspace)}
        canModerate={Boolean(canManage) && !direct}
        canEditChannel={Boolean(canManage) && channel.kind === 'text'}
        title={
          direct ? (
            <DirectTitle
              channel={direct}
              status={(direct.peer && presence.data?.[direct.peer.id]) ?? 'offline'}
            />
          ) : undefined
        }
        actions={
          <>
            {direct?.peer && voiceEnabled && !inCall && (
              <DirectCallActions name={direct.peer.name} onCall={(video) => directCalls.start(direct.id, video)} />
            )}
            {popIn}
          </>
        }
        stage={
          inCall ? (
            <div className="h-[45%] min-h-52 shrink-0 border-b border-[var(--color-line)]">
              <CallStage
                call={call}
                selfName={user.name}
                notice={
                  directCalls.ringingOut === channel.id
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
        onOpenDocument={(id) => showInMain(`/w/${workspaceId}/d/${id}`)}
        onOpenChannel={(id) => showInMain(`/w/${workspaceId}/c/${id}`)}
      />
    </div>
  );
}
