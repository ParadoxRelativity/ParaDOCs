import { useEffect, useRef } from 'react';
import { LocalParticipant, RemoteParticipant, Track, type Participant, type TrackPublication } from 'livekit-client';
import type { Channel } from '@paradocs/shared';
import type { VoiceConfig } from '../../api/hooks';
import type { Call } from '../../lib/call';
import { cx } from '../../lib/util';
import { EmptyState } from '../ui';

/**
 * The view of a voice channel.
 *
 * It owns nothing: the call lives above it so that walking off to read a
 * document does not hang up. This renders whichever call is running when you
 * are looking at its channel, and offers to move you when you are looking at a
 * different one.
 */
export function VoiceRoom({
  channel,
  config,
  call,
  selfName,
}: {
  channel: Channel;
  config: VoiceConfig | undefined;
  call: Call;
  selfName: string;
}) {
  const here = call.channelId === channel.id;
  const joined = here && call.status === 'joined';

  if (config && !config.enabled) {
    return (
      <EmptyState
        icon="🔇"
        title="Voice is not configured on this server"
        hint="Set LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET, or run the livekit service from docker-compose."
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--color-line)] px-4">
        <span className="text-sm font-semibold">🔊 {channel.name}</span>
        {channel.topic && (
          <span className="min-w-0 flex-1 truncate text-xs text-[var(--color-muted)]">{channel.topic}</span>
        )}
        {joined && (
          <span className="ml-auto text-xs text-[var(--color-muted)]">
            {call.participants.length} {call.participants.length === 1 ? 'person' : 'people'}
          </span>
        )}
      </header>

      {!joined ? (
        <div className="grid min-h-0 flex-1 place-items-center">
          <div className="text-center">
            <div className="mb-3 text-4xl">🔊</div>
            <h2 className="mb-1 text-lg font-semibold">{channel.name}</h2>
            <p className="mb-5 text-sm text-[var(--color-muted)]">
              {here && call.status === 'joining'
                ? 'Connecting…'
                : call.channelId
                  ? 'You are in another call. Joining here will leave it.'
                  : 'Click the channel in the sidebar to join, or use the button below.'}
            </p>
            <button
              onClick={() => call.join(channel.id)}
              disabled={here && call.status === 'joining'}
              className="rounded-lg bg-[var(--color-accent)] px-5 py-2 text-sm font-semibold text-white hover:brightness-110 disabled:opacity-60"
            >
              {here && call.status === 'joining' ? 'Joining…' : 'Join call'}
            </button>
          </div>
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 auto-rows-fr grid-cols-[repeat(auto-fit,minmax(260px,1fr))] gap-2 overflow-y-auto p-3">
          {call.participants.map((participant) => (
            <Tile key={participant.sid} participant={participant} selfName={selfName} />
          ))}
        </div>
      )}

      {joined && (
        <div className="flex shrink-0 items-center justify-center gap-2 border-t border-[var(--color-line)] p-3">
          <Control active={call.mic} onClick={() => call.toggle('mic')} label={call.mic ? 'Mute' : 'Unmute'}>
            {call.mic ? '🎙' : '🔇'}
          </Control>
          <Control
            active={call.camera}
            onClick={() => call.toggle('camera')}
            label={call.camera ? 'Stop video' : 'Start video'}
          >
            {call.camera ? '📹' : '📷'}
          </Control>
          <Control
            active={call.screen}
            onClick={() => call.toggle('screen')}
            label={call.screen ? 'Stop sharing' : 'Share screen'}
          >
            🖥
          </Control>
          <button
            onClick={call.leave}
            className="ml-2 rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:brightness-110"
          >
            Leave
          </button>
        </div>
      )}
    </div>
  );
}

function Control({
  active,
  label,
  onClick,
  children,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      className={cx(
        'grid h-11 w-11 place-items-center rounded-lg text-lg',
        active
          ? 'bg-[var(--color-accent)] text-white'
          : 'bg-[var(--color-surface)] text-[var(--color-ink)] hover:bg-[var(--color-line)]',
      )}
    >
      {children}
    </button>
  );
}

/** Prefers a screen share over the camera: it is the thing people are looking at. */
function videoPublication(participant: Participant): TrackPublication | undefined {
  const screen = participant.getTrackPublication(Track.Source.ScreenShare);
  if (screen?.track) return screen;
  const camera = participant.getTrackPublication(Track.Source.Camera);
  return camera?.track && !camera.isMuted ? camera : undefined;
}

function Tile({ participant, selfName }: { participant: Participant; selfName: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const isLocal = participant instanceof LocalParticipant;
  const video = videoPublication(participant);
  const sharing = Boolean(participant.getTrackPublication(Track.Source.ScreenShare)?.track);
  const micPublication = participant.getTrackPublication(Track.Source.Microphone);
  const muted = !micPublication || micPublication.isMuted;

  useEffect(() => {
    const element = videoRef.current;
    const track = video?.track;
    if (!element || !track) return;
    track.attach(element);
    return () => {
      track.detach(element);
    };
  }, [video?.trackSid, video?.track]);

  useEffect(() => {
    // Your own microphone is never played back; that is an echo.
    const element = audioRef.current;
    if (!element || isLocal) return;
    const track = (participant as RemoteParticipant).getTrackPublication(Track.Source.Microphone)?.track;
    if (!track) return;
    track.attach(element);
    return () => {
      track.detach(element);
    };
  }, [participant, micPublication?.trackSid, micPublication?.track, isLocal]);

  const name = isLocal ? `${selfName} (you)` : (participant.name || participant.identity);

  return (
    <div
      className={cx(
        'relative flex min-h-[150px] items-center justify-center overflow-hidden rounded-xl bg-[var(--color-surface)]',
        participant.isSpeaking && 'ring-2 ring-[var(--color-accent)]',
      )}
    >
      {video ? (
        <video
          ref={videoRef}
          autoPlay
          playsInline
          // Local camera is mirrored, as people expect of their own image; a
          // shared screen is not, because text would read backwards.
          muted={isLocal}
          className={cx('h-full w-full object-contain', isLocal && !sharing && 'scale-x-[-1]')}
        />
      ) : (
        <div className="grid h-16 w-16 place-items-center rounded-full bg-[var(--color-accent)] text-xl font-semibold text-white">
          {name.slice(0, 1).toUpperCase()}
        </div>
      )}
      {!isLocal && <audio ref={audioRef} autoPlay />}

      <div className="absolute bottom-2 left-2 flex items-center gap-1.5 rounded-md bg-black/60 px-2 py-1 text-xs text-white">
        {muted && <span title="Muted">🔇</span>}
        {sharing && <span title="Sharing screen">🖥</span>}
        <span className="max-w-[220px] truncate">{name}</span>
      </div>
    </div>
  );
}
