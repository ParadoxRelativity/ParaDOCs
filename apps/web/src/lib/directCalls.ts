import { useCallback, useEffect, useRef, useState } from 'react';
import { RING_TIMEOUT_MS, type CallCaller, type CallEvent } from '@paradocs/shared';
import { api } from '../api/client';
import { useToast } from '../components/Toast';
import type { Call } from './call';
import { startRingtone } from './ringtone';

export interface IncomingCall {
  workspaceId: string;
  channelId: string;
  caller: CallCaller;
  video: boolean;
}

export interface DirectCalls {
  incoming: IncomingCall | null;
  /** The direct conversation this window is ringing out from, until someone answers. */
  ringingOut: string | null;
  start: (channelId: string, video: boolean) => void;
  accept: (video: boolean) => void;
  decline: () => void;
  handleEvent: (event: CallEvent) => void;
}

function ring(channelId: string, action: 'start' | 'cancel' | 'answer' | 'decline', video = false): Promise<void> {
  return api.post<void>(`/channels/${channelId}/ring`, { action, video }).catch(() => {
    // A ring that does not get through leaves the other side to time out on
    // its own; it is not worth an error on top of the call itself.
  });
}

/**
 * Calling someone directly, on top of the session's call.
 *
 * Starting a call joins the conversation's room first and rings once
 * connected, so the person answering never lands in an empty room. The ring
 * stops when they appear in the room, decline, or it times out — and hanging
 * up or moving to another call while it rings cancels it.
 */
export function useDirectCalls({
  call,
  muted,
  onAccepted,
}: {
  call: Call;
  /** Busy: calls still arrive, but without a sound. */
  muted: boolean;
  onAccepted: (incoming: IncomingCall) => void;
}): DirectCalls {
  const toast = useToast();
  const [incoming, setIncoming] = useState<IncomingCall | null>(null);
  const [ringingOut, setRingingOut] = useState<string | null>(null);

  // Read from socket handlers and timers, which outlive the render that made them.
  const callRef = useRef(call);
  callRef.current = call;
  const incomingRef = useRef(incoming);
  incomingRef.current = incoming;
  const ringingOutRef = useRef(ringingOut);
  ringingOutRef.current = ringingOut;
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const acceptedRef = useRef(onAccepted);
  acceptedRef.current = onAccepted;

  const start = useCallback((channelId: string, video: boolean) => {
    const current = callRef.current;
    const begin = () => {
      setRingingOut(channelId);
      void ring(channelId, 'start', video);
    };
    // Already sitting in the conversation's room, say after a declined call:
    // joining again would do nothing, so ring from where you are.
    if (current.channelId === channelId && current.status === 'joined') {
      if (video && !current.camera) current.toggle('camera');
      begin();
      return;
    }
    current.join(channelId, { video, onJoined: begin });
  }, []);

  const remoteCount = call.channelId !== null && call.channelId === ringingOut ? call.participants.length - 1 : 0;

  useEffect(() => {
    if (!ringingOut) return;
    // Hung up, or moved to another call, before anyone answered.
    if (call.channelId !== ringingOut) {
      void ring(ringingOut, 'cancel');
      setRingingOut(null);
      return;
    }
    // Someone else is in the room: answered.
    if (remoteCount > 0) {
      setRingingOut(null);
      return;
    }
    const timer = setTimeout(() => {
      void ring(ringingOut, 'cancel');
      setRingingOut(null);
      const current = callRef.current;
      if (current.channelId === ringingOut && current.participants.length <= 1) current.leave();
      toastRef.current('No answer');
    }, RING_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [ringingOut, call.channelId, remoteCount]);

  useEffect(() => {
    if (!incoming) return;
    const stop = muted ? () => {} : startRingtone();
    // The caller gives up at the same point, so an unanswered card does not linger.
    const timer = setTimeout(() => setIncoming(null), RING_TIMEOUT_MS);
    return () => {
      stop();
      clearTimeout(timer);
    };
  }, [incoming, muted]);

  const handleEvent = useCallback((event: CallEvent) => {
    if (event.type === 'call.ringing') {
      // Both rang at once and are already in the room together.
      if (callRef.current.channelId === event.channelId) return;
      setIncoming({
        workspaceId: event.workspaceId,
        channelId: event.channelId,
        caller: event.caller,
        video: event.video,
      });
      return;
    }

    // Settled somewhere — possibly in another of this person's windows.
    if (incomingRef.current?.channelId === event.channelId) setIncoming(null);

    if (event.reason === 'declined' && ringingOutRef.current === event.channelId) {
      setRingingOut(null);
      const current = callRef.current;
      if (current.channelId === event.channelId && current.participants.length <= 1) current.leave();
      toastRef.current('Call declined');
    }
  }, []);

  const accept = useCallback((video: boolean) => {
    const answering = incomingRef.current;
    if (!answering) return;
    setIncoming(null);
    void ring(answering.channelId, 'answer');
    callRef.current.join(answering.channelId, { video });
    acceptedRef.current(answering);
  }, []);

  const decline = useCallback(() => {
    const declining = incomingRef.current;
    if (!declining) return;
    setIncoming(null);
    void ring(declining.channelId, 'decline');
  }, []);

  return { incoming, ringingOut, start, accept, decline, handleEvent };
}
