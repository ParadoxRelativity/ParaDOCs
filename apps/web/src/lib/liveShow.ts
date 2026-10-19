import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { LiveShowEvent, LiveShowInfo, ShowState } from '@paradocs/shared';
import { api } from '../api/client';

/**
 * Live slideshows on the client (PARA-99). The chat socket belongs to the
 * workspace shell, far from the slideshow and the people following it, so this
 * is the seam between them: the shell attaches the socket's `send` and hands
 * over the `show.*` events, and the presenter and follower hooks use those.
 */

type Listener = (event: LiveShowEvent) => void;

const listeners = new Set<Listener>();
const connectionListeners = new Set<() => void>();
let sender: ((message: object) => void) | null = null;

export const liveShowBus = {
  /** The shell calls this with the socket's send while it is connected, and null when it is not. */
  attach(send: ((message: object) => void) | null) {
    if (sender === send) return;
    sender = send;
    connectionListeners.forEach((l) => l());
  },
  send(message: object) {
    sender?.(message);
  },
  emit(event: LiveShowEvent) {
    listeners.forEach((l) => l(event));
  },
  on(listener: Listener) {
    listeners.add(listener);
    return () => void listeners.delete(listener);
  },
};

/** Whether the socket is up. Presenters and followers say it all again when it comes back. */
function useConnected(): boolean {
  return useSyncExternalStore(
    (notify) => {
      connectionListeners.add(notify);
      return () => void connectionListeners.delete(notify);
    },
    () => sender !== null,
  );
}

export const liveShowKeys = {
  list: (workspaceId: string) => ['liveShows', workspaceId] as const,
};

/** The shows running in a workspace that this person may follow. */
export function useLiveShows(workspaceId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: liveShowKeys.list(workspaceId ?? ''),
    queryFn: () => api.get<LiveShowInfo[]>(`/workspaces/${workspaceId}/live-shows`),
    enabled: Boolean(workspaceId) && enabled,
    retry: false,
  });
}

// ---- which show this window is following ----------------------------------

let followTarget: string | null = null;
const followListeners = new Set<() => void>();

/** Opens the follower view for a presentation that is live. */
export function followLiveShow(presentationId: string | null) {
  if (followTarget === presentationId) return;
  followTarget = presentationId;
  followListeners.forEach((l) => l());
}

export function useFollowTarget(): string | null {
  return useSyncExternalStore(
    (notify) => {
      followListeners.add(notify);
      return () => void followListeners.delete(notify);
    },
    () => followTarget,
  );
}

// ---- presenter ------------------------------------------------------------

export type PresenterStatus = 'off' | 'starting' | 'live';

export interface LivePresenter {
  status: PresenterStatus;
  viewers: number;
  error: string | null;
  channelId: string | null;
  /** Begins the live session, announced in `channelId` if given. */
  start: (channelId: string | null) => void;
  stop: () => void;
}

/**
 * Runs the presenting side: starts and ends the session and sends the show's
 * position whenever it changes. Leaving (the hook unmounting) ends the session,
 * which is what ends it for the audience.
 */
export function useLivePresenter(presentationId: string, state: ShowState): LivePresenter {
  const connected = useConnected();
  const [status, setStatus] = useState<PresenterStatus>('off');
  const [viewers, setViewers] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [channelId, setChannelId] = useState<string | null>(null);
  const latest = useRef({ state, status, channelId });
  latest.current = { state, status, channelId };

  const begin = useCallback(
    (channel: string | null) => liveShowBus.send({ type: 'show.start', presentationId, channelId: channel }),
    [presentationId],
  );

  useEffect(
    () =>
      liveShowBus.on((event) => {
        if (!('presentationId' in event) || event.presentationId !== presentationId) return;
        switch (event.type) {
          case 'show.started':
            setStatus('live');
            setViewers(event.show.viewers);
            setError(null);
            // The audience starts from where the presenter is, not from the first slide.
            liveShowBus.send({ type: 'show.state', presentationId, state: latest.current.state });
            return;
          case 'show.viewers':
            setViewers(event.viewers);
            return;
          case 'show.ended':
            setStatus('off');
            setViewers(0);
            return;
          case 'show.refused':
            // Joining is the follower's business; a refusal here is of starting.
            if (latest.current.status === 'starting' || latest.current.status === 'live') {
              setStatus('off');
              setError(event.message);
            }
            return;
        }
      }),
    [presentationId],
  );

  // The server drops a session with its socket, so a reconnect starts it again.
  useEffect(() => {
    if (connected && latest.current.status === 'live') begin(latest.current.channelId);
  }, [connected, begin]);

  const { slideId, step, blank } = state;
  useEffect(() => {
    if (status === 'live') liveShowBus.send({ type: 'show.state', presentationId, state: latest.current.state });
  }, [status, presentationId, slideId, step, blank]);

  // Exiting the show ends the session.
  useEffect(
    () => () => {
      if (latest.current.status !== 'off') liveShowBus.send({ type: 'show.end', presentationId });
    },
    [presentationId],
  );

  const start = useCallback(
    (channel: string | null) => {
      setError(null);
      setChannelId(channel);
      setStatus('starting');
      begin(channel);
    },
    [begin],
  );
  const stop = useCallback(() => {
    liveShowBus.send({ type: 'show.end', presentationId });
    setStatus('off');
    setViewers(0);
  }, [presentationId]);

  return { status, viewers, error, channelId, start, stop };
}

// ---- follower -------------------------------------------------------------

export type FollowerStatus = 'joining' | 'following' | 'ended' | 'refused';

export interface LiveFollower {
  status: FollowerStatus;
  show: LiveShowInfo | null;
  /** Where the presenter is. */
  state: ShowState | null;
  message: string | null;
}

/** Follows a live show: joins on mount (and again after a reconnect), leaves on unmount. */
export function useLiveFollower(presentationId: string): LiveFollower {
  const connected = useConnected();
  const [follower, setFollower] = useState<LiveFollower>({ status: 'joining', show: null, state: null, message: null });
  // Updates may arrive out of order only across a reconnect; within one connection they are ordered.
  const seq = useRef(0);

  useEffect(
    () =>
      liveShowBus.on((event) => {
        if (!('presentationId' in event) || event.presentationId !== presentationId) return;
        switch (event.type) {
          case 'show.joined':
            seq.current = event.seq;
            setFollower({ status: 'following', show: event.show, state: event.state, message: null });
            return;
          case 'show.state':
            if (event.seq <= seq.current) return;
            seq.current = event.seq;
            setFollower((f) => ({ ...f, state: event.state }));
            return;
          case 'show.viewers':
            setFollower((f) => (f.show ? { ...f, show: { ...f.show, viewers: event.viewers } } : f));
            return;
          case 'show.ended':
            setFollower((f) => ({ ...f, status: 'ended' }));
            return;
          case 'show.refused':
            setFollower((f) => (f.status === 'following' ? f : { ...f, status: 'refused', message: event.message }));
            return;
        }
      }),
    [presentationId],
  );

  useEffect(() => {
    if (connected) liveShowBus.send({ type: 'show.join', presentationId });
  }, [connected, presentationId]);

  useEffect(() => () => liveShowBus.send({ type: 'show.leave', presentationId }), [presentationId]);

  return follower;
}
