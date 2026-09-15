import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  LocalAudioTrack,
  RemoteAudioTrack,
  Room,
  RoomEvent,
  Track,
  type Participant,
  type RemoteTrack,
  type RoomOptions,
} from 'livekit-client';
import { api } from '../api/client';
import type { CallCredentials } from '../api/hooks';
import { useToast } from '../components/Toast';
import { InputGainProcessor } from './inputGain';
import { explainJoinFailure, sameOriginSignallingUrl } from './signalling';
import {
  canChooseSpeaker,
  connectedDeviceId,
  getMediaPreferences,
  subscribeMediaPreferences,
} from './mediaPreferences';

export type CallStatus = 'idle' | 'joining' | 'joined';

export interface JoinOptions {
  /** Turns the camera on once connected, for a video call. */
  video?: boolean;
  /** Runs once the room is joined, such as ringing the person being called. */
  onJoined?: () => void;
}

export interface Call {
  /** The voice channel or direct conversation currently connected to, or being connected to. */
  channelId: string | null;
  status: CallStatus;
  participants: Participant[];
  mic: boolean;
  camera: boolean;
  screen: boolean;
  join: (channelId: string, options?: JoinOptions) => void;
  leave: () => void;
  toggle: (kind: 'mic' | 'camera' | 'screen') => void;
}

/**
 * Plays a remote participant's audio. It belongs to the call rather than to
 * the room view: that view unmounts when you go and read a document, and the
 * people you are talking to must not go quiet when it does. The room applies
 * the chosen speaker to each element as it is attached.
 */
function playRemoteAudio(track: RemoteTrack, elements: Set<HTMLMediaElement>) {
  if (!(track instanceof RemoteAudioTrack)) return;
  const element = track.attach();
  document.body.appendChild(element);
  elements.add(element);
  track.setVolume(getMediaPreferences().outputVolume / 100);
}

function stopRemoteAudio(track: RemoteTrack, elements: Set<HTMLMediaElement>) {
  if (!(track instanceof RemoteAudioTrack)) return;
  for (const element of track.detach()) {
    element.remove();
    elements.delete(element);
  }
}

function applyOutputVolume(room: Room) {
  const volume = getMediaPreferences().outputVolume / 100;
  for (const participant of room.remoteParticipants.values()) {
    for (const publication of participant.audioTrackPublications.values()) {
      if (publication.track instanceof RemoteAudioTrack) publication.track.setVolume(volume);
    }
  }
}

/** Room options from the saved device choices, skipping any no longer plugged in. */
async function roomOptions(): Promise<RoomOptions> {
  const preferences = getMediaPreferences();
  const [microphone, camera, speaker] = await Promise.all([
    connectedDeviceId('audioinput', preferences.microphoneId),
    connectedDeviceId('videoinput', preferences.cameraId),
    canChooseSpeaker ? connectedDeviceId('audiooutput', preferences.speakerId) : undefined,
  ]);
  return {
    adaptiveStream: true,
    dynacast: true,
    ...(microphone ? { audioCaptureDefaults: { deviceId: microphone } } : {}),
    ...(camera ? { videoCaptureDefaults: { deviceId: camera } } : {}),
    ...(speaker ? { audioOutput: { deviceId: speaker } } : {}),
  };
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
  /** Elements playing remote audio, removed from the page when the call ends. */
  const audioElements = useRef(new Set<HTMLMediaElement>());
  /** Runs the input volume's audio graph; closed when the call ends. */
  const audioContextRef = useRef<AudioContext | null>(null);
  const gainRef = useRef<InputGainProcessor | null>(null);
  /**
   * Device changes run one at a time. Dragging a slider fires many, and two
   * overlapping processor installs on one track would each keep their own.
   */
  const deviceQueue = useRef<Promise<unknown>>(Promise.resolve());
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
    for (const element of audioElements.current) element.remove();
    audioElements.current.clear();
    void audioContextRef.current?.close().catch(() => {});
    audioContextRef.current = null;
    gainRef.current = null;
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

  /**
   * React's cleanup does not run when the window itself goes, which is exactly
   * what closing a popped-out call is. Without this the room keeps the
   * participant until the server times them out, and everyone else watches a
   * frozen tile in the meantime.
   */
  useEffect(() => {
    const hangUp = () => void roomRef.current?.disconnect().catch(() => {});
    window.addEventListener('pagehide', hangUp);
    return () => window.removeEventListener('pagehide', hangUp);
  }, []);

  const enqueue = useCallback(
    (task: () => Promise<unknown>) => {
      deviceQueue.current = deviceQueue.current.then(task).catch((err) => {
        toast(err instanceof Error ? err.message : 'Could not apply your device settings', 'error');
      });
    },
    [toast],
  );

  /**
   * Puts the input volume on the microphone. At 100% there is nothing to
   * scale, so no processor is installed and the track is sent untouched.
   */
  const applyInputGain = useCallback(async (room: Room) => {
    const track = room.localParticipant.getTrackPublication(Track.Source.Microphone)?.track;
    if (!(track instanceof LocalAudioTrack)) return;
    const level = getMediaPreferences().inputVolume / 100;
    const installed = gainRef.current && track.getProcessor() === gainRef.current ? gainRef.current : null;

    if (level === 1) {
      if (installed) await track.stopProcessor();
      gainRef.current = null;
      return;
    }
    if (installed) {
      installed.setLevel(level);
      return;
    }
    audioContextRef.current ??= new AudioContext();
    track.setAudioContext(audioContextRef.current);
    const processor = new InputGainProcessor(level);
    await track.setProcessor(processor);
    gainRef.current = processor;
  }, []);

  // Settings can change mid-call; each change is applied to the call in
  // progress rather than waiting for the next one.
  useEffect(() => {
    let previous = getMediaPreferences();
    return subscribeMediaPreferences(() => {
      const next = getMediaPreferences();
      const before = previous;
      previous = next;
      const room = roomRef.current;
      if (!room) return;
      enqueue(async () => {
        // An empty choice is the system default, which Chromium calls
        // "default". It is asked for loosely so a browser without one still
        // picks a device rather than failing.
        if (next.microphoneId !== before.microphoneId) {
          await room.switchActiveDevice('audioinput', next.microphoneId || 'default', Boolean(next.microphoneId));
        }
        if (next.cameraId !== before.cameraId) {
          await room.switchActiveDevice('videoinput', next.cameraId || 'default', Boolean(next.cameraId));
        }
        if (canChooseSpeaker && next.speakerId !== before.speakerId) {
          await room.switchActiveDevice('audiooutput', next.speakerId || 'default');
        }
        if (next.inputVolume !== before.inputVolume) await applyInputGain(room);
        if (next.outputVolume !== before.outputVolume) applyOutputVolume(room);
      });
    });
  }, [applyInputGain, enqueue]);

  const join = useCallback(
    (nextChannelId: string, options: JoinOptions = {}) => {
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
          const room = new Room(await roomOptions());
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
            .on(RoomEvent.TrackSubscribed, (track) => {
              playRemoteAudio(track, audioElements.current);
              refresh();
            })
            .on(RoomEvent.TrackUnsubscribed, (track) => {
              stopRemoteAudio(track, audioElements.current);
              refresh();
            })
            .on(RoomEvent.TrackMuted, refresh)
            .on(RoomEvent.TrackUnmuted, refresh)
            .on(RoomEvent.LocalTrackPublished, (publication) => {
              if (publication.source === Track.Source.Microphone) enqueue(() => applyInputGain(room));
              refresh();
            })
            .on(RoomEvent.LocalTrackUnpublished, refresh)
            .on(RoomEvent.ActiveSpeakersChanged, refresh)
            // A room that has already been replaced still says goodbye on its
            // way out, and that arrives after whatever replaced it. Acting on
            // it then would clear the call that is actually running and leave
            // the app showing nobody in a room it is still connected to.
            .on(RoomEvent.Disconnected, () => {
              if (roomRef.current === room) reset();
            });

          // No address from the server means it relays signalling on the
          // address this page came from.
          const signalling = credentials.url ?? sameOriginSignallingUrl();
          await room.connect(signalling, credentials.token).catch((err: unknown) => {
            throw explainJoinFailure(err, signalling);
          });
          setStatus('joined');

          if (credentials.canSpeak === false) {
            // A lock lets this person listen here but not speak. The token
            // already refuses their microphone, so it is not asked for.
            setMic(false);
            toast('You can listen in this channel, but not speak.');
          } else {
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
          }
          // The same goes for a camera on a video call: better to be heard
          // without it than kept out.
          if (options.video && credentials.canSpeak !== false) {
            try {
              await room.localParticipant.setCameraEnabled(true);
              setCamera(true);
            } catch {
              setCamera(false);
              toast('Joined without your camera. Check the permission to use it.', 'error');
            }
          }
          refresh();
          refreshOccupancy();
          options.onJoined?.();
        } catch (err) {
          // The room may already be connected when something later fails, so
          // it is torn down explicitly rather than left to be collected.
          await roomRef.current?.disconnect().catch(() => {});
          reset();
          toast(err instanceof Error ? err.message : 'Could not join the call', 'error');
        }
      })();
    },
    [channelId, status, disconnect, refresh, refreshOccupancy, reset, toast, enqueue, applyInputGain],
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
          // about the state afterwards. Closing the screen picker without
          // choosing arrives as the same refusal, but it is a choice, not a
          // failure, so it goes unremarked. The operating system blocking
          // capture still says so.
          const pickerClosed =
            kind === 'screen' &&
            err instanceof Error &&
            err.name === 'NotAllowedError' &&
            !/system/i.test(err.message);
          if (!pickerClosed) toast(err instanceof Error ? err.message : `Could not switch ${kind}`, 'error');
          refresh();
        }
      })();
    },
    [mic, camera, screen, refresh, toast],
  );

  const leave = useCallback(() => void disconnect(), [disconnect]);

  return { channelId, status, participants, mic, camera, screen, join, leave, toggle };
}
