import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Room, RoomEvent, type Participant } from 'livekit-client';
import { api } from '../api/client';
import type { CallCredentials } from '../api/hooks';
import { useToast } from '../components/Toast';

export type CallStatus = 'idle' | 'joining' | 'joined';

export interface Call {
  /** The voice channel currently connected to, or being connected to. */
  channelId: string | null;
  status: CallStatus;
  participants: Participant[];
  mic: boolean;
  camera: boolean;
  screen: boolean;
  join: (channelId: string) => void;
  leave: () => void;
  toggle: (kind: 'mic' | 'camera' | 'screen') => void;
}

/**
 * The call, owned above the views so it outlives them.
 *
 * Joining is a click on a channel in the sidebar, and from that moment the call
 * belongs to the session rather than to whatever is on screen: reading a
 * document or switching to another channel must not hang up on people. The
 * LiveKit Room is held in a ref because it is a long-lived object with its own
 * event emitter; React state holds only what is drawn.
 */
export function useCall(): Call {
  const toast = useToast();
  const qc = useQueryClient();
  /**
   * Who is in which voice channel is otherwise polled, so joining or leaving
   * would take up to a poll interval to show in the sidebar — including your
   * own name, which is the one people notice being wrong.
   */
  const refreshOccupancy = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ['voiceParticipants'] });
  }, [qc]);
  const roomRef = useRef<Room | null>(null);
  const [channelId, setChannelId] = useState<string | null>(null);
  const [status, setStatus] = useState<CallStatus>('idle');
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [mic, setMic] = useState(false);
  const [camera, setCamera] = useState(false);
  const [screen, setScreen] = useState(false);
  // Bumped on every track change so tiles re-read the room.
  const [, setRevision] = useState(0);

  const refresh = useCallback(() => {
    const room = roomRef.current;
    if (!room) return;
    setParticipants([room.localParticipant, ...Array.from(room.remoteParticipants.values())]);
    setRevision((n) => n + 1);
  }, []);

  const reset = useCallback(() => {
    roomRef.current = null;
    setChannelId(null);
    setStatus('idle');
    setParticipants([]);
    setMic(false);
    setCamera(false);
    setScreen(false);
    refreshOccupancy();
  }, [refreshOccupancy]);

  const disconnect = useCallback(async () => {
    const room = roomRef.current;
    reset();
    await room?.disconnect().catch(() => {});
  }, [reset]);

  // Closing the tab, or leaving the workspace, must not leave a ghost in a room.
  useEffect(() => () => void roomRef.current?.disconnect().catch(() => {}), []);

  const join = useCallback(
    (nextChannelId: string) => {
      void (async () => {
        // Clicking the channel you are already in is not a request to rejoin.
        if (roomRef.current && channelId === nextChannelId) return;
        if (status === 'joining') return;
        // Moving between voice channels leaves the old one first, the way
        // walking into another room works.
        if (roomRef.current) await disconnect();

        setChannelId(nextChannelId);
        setStatus('joining');
        try {
          const credentials = await api.post<CallCredentials>(`/channels/${nextChannelId}/call`);
          const room = new Room({ adaptiveStream: true, dynacast: true });
          roomRef.current = room;

          room
            .on(RoomEvent.ParticipantConnected, () => {
              refresh();
              refreshOccupancy();
            })
            .on(RoomEvent.ParticipantDisconnected, () => {
              refresh();
              refreshOccupancy();
            })
            .on(RoomEvent.TrackSubscribed, refresh)
            .on(RoomEvent.TrackUnsubscribed, refresh)
            .on(RoomEvent.TrackMuted, refresh)
            .on(RoomEvent.TrackUnmuted, refresh)
            .on(RoomEvent.LocalTrackPublished, refresh)
            .on(RoomEvent.LocalTrackUnpublished, refresh)
            .on(RoomEvent.ActiveSpeakersChanged, refresh)
            .on(RoomEvent.Disconnected, reset);

          await room.connect(credentials.url, credentials.token);
          setStatus('joined');

          // No microphone, or permission refused, is not a reason to be kept
          // out: listening in is a legitimate way to attend. The join stands
          // and the button honestly shows the mic as off.
          try {
            await room.localParticipant.setMicrophoneEnabled(true);
            setMic(true);
          } catch {
            setMic(false);
            toast('Joined without a microphone. Check the permission to speak.', 'error');
          }
          refresh();
          refreshOccupancy();
        } catch (err) {
          // The room may already be connected when something later fails, so
          // it is torn down explicitly rather than left to be collected.
          await roomRef.current?.disconnect().catch(() => {});
          reset();
          toast(err instanceof Error ? err.message : 'Could not join the call', 'error');
        }
      })();
    },
    [channelId, status, disconnect, refresh, refreshOccupancy, reset, toast],
  );

  const toggle = useCallback(
    (kind: 'mic' | 'camera' | 'screen') => {
      void (async () => {
        const local = roomRef.current?.localParticipant;
        if (!local) return;
        try {
          if (kind === 'mic') {
            await local.setMicrophoneEnabled(!mic);
            setMic(!mic);
          } else if (kind === 'camera') {
            await local.setCameraEnabled(!camera);
            setCamera(!camera);
          } else {
            await local.setScreenShareEnabled(!screen, { audio: true });
            setScreen(!screen);
          }
          refresh();
        } catch (err) {
          // Denying the permission prompt lands here; the button must not lie
          // about the state afterwards.
          toast(err instanceof Error ? err.message : `Could not switch ${kind}`, 'error');
          refresh();
        }
      })();
    },
    [mic, camera, screen, refresh, toast],
  );

  const leave = useCallback(() => void disconnect(), [disconnect]);

  return { channelId, status, participants, mic, camera, screen, join, leave, toggle };
}
