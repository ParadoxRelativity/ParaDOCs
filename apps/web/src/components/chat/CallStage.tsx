import { useEffect, useRef, useState } from 'react';
import { LocalParticipant, Track, type Participant } from 'livekit-client';
import type { Call } from '../../lib/call';
import { useCallLayout } from '../../lib/callLayout';
import { cx } from '../../lib/util';
import Avatar from '../Avatar';
import Icon from '../Icon';

/**
 * One video in a call: a person's camera — their picture while it is off — or
 * a screen they are sharing. A share is a feed of its own rather than taking
 * over the person's tile, so their camera and their screen can both be watched.
 */
interface Feed {
  key: string;
  participant: Participant;
  source: 'camera' | 'screen';
}

function feedsOf(participants: Participant[]): Feed[] {
  return participants.flatMap((participant) => {
    const feeds: Feed[] = [{ key: `${participant.identity}:camera`, participant, source: 'camera' }];
    if (participant.getTrackPublication(Track.Source.ScreenShare)?.track) {
      feeds.push({ key: `${participant.identity}:screen`, participant, source: 'screen' });
    }
    return feeds;
  });
}

/**
 * The inside of a call — everyone's video or picture, shared screens, and the
 * controls — used by voice channels and by calls in a direct conversation.
 *
 * It owns nothing: the call lives above it so that walking off to read a
 * document does not hang up.
 */
export function CallStage({
  call,
  selfName,
  notice,
}: {
  call: Call;
  selfName: string;
  /** A line over the videos, such as who is being rung. */
  notice?: string | null;
}) {
  const joined = call.status === 'joined';
  const [layout] = useCallLayout();
  const [focusedKey, setFocusedKey] = useState<string | null>(null);

  const feeds = feedsOf(call.participants);
  // A focused feed that ends — a share stopped, someone left — gives the
  // stage back to everyone.
  const focused = feeds.find((feed) => feed.key === focusedKey) ?? null;
  const toggleFocus = (key: string) => setFocusedKey((current) => (current === key ? null : key));

  useEffect(() => {
    if (!focused) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setFocusedKey(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [focused]);

  const side = layout === 'side';

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="relative flex min-h-0 flex-1 flex-col">
        {!joined || feeds.length === 0 ? (
          <div className="grid min-h-0 flex-1 place-items-center text-sm text-[var(--color-muted)]">Connecting…</div>
        ) : focused ? (
          // One feed large; the rest in a strip beside or below it, as chosen in
          // Settings → Appearance.
          <div className={cx('flex min-h-0 flex-1 gap-2 p-3', side ? 'flex-row' : 'flex-col')}>
            <div className="min-h-0 min-w-0 flex-1">
              <FeedTile feed={focused} selfName={selfName} focused onToggleFocus={() => setFocusedKey(null)} />
            </div>
            {feeds.length > 1 && (
              <div
                className={cx(
                  // The padding keeps a speaker's highlight ring from being clipped
                  // by the scrolling strip.
                  'scroll-thin flex shrink-0 gap-2 p-0.5',
                  side ? 'w-56 flex-col overflow-y-auto' : 'h-32 flex-row overflow-x-auto',
                )}
              >
                {feeds
                  .filter((feed) => feed.key !== focused.key)
                  .map((feed) => (
                    <div key={feed.key} className={cx('aspect-video shrink-0', side ? 'w-full' : 'h-full')}>
                      <FeedTile
                        feed={feed}
                        selfName={selfName}
                        compact
                        onToggleFocus={() => toggleFocus(feed.key)}
                      />
                    </div>
                  ))}
              </div>
            )}
          </div>
        ) : (
          <div className="grid min-h-0 flex-1 auto-rows-fr grid-cols-[repeat(auto-fit,minmax(260px,1fr))] gap-2 overflow-y-auto p-3">
            {feeds.map((feed) => (
              <FeedTile key={feed.key} feed={feed} selfName={selfName} onToggleFocus={() => toggleFocus(feed.key)} />
            ))}
          </div>
        )}

        {joined && notice && (
          <span className="pointer-events-none absolute left-1/2 top-4 -translate-x-1/2 rounded-full bg-black/65 px-3 py-1 text-xs text-white">
            {notice}
          </span>
        )}
      </div>

      {joined && (
        <div className="flex shrink-0 items-center gap-2 border-t border-[var(--color-line)] px-3 py-2.5">
          <div className="flex min-w-0 flex-1 items-center gap-3 text-xs text-[var(--color-muted)]">
            <span className="truncate">
              {call.participants.length} {call.participants.length === 1 ? 'person' : 'people'}
            </span>
            {focused && (
              <button onClick={() => setFocusedKey(null)} className="truncate hover:text-[var(--color-ink)]">
                <Icon name="grid" /> Show everyone
              </button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Control active={call.mic} onClick={() => call.toggle('mic')} label={call.mic ? 'Mute' : 'Unmute'}>
              <Icon name={call.mic ? 'mic' : 'mic-mute'} />
            </Control>
            <Control
              active={call.camera}
              onClick={() => call.toggle('camera')}
              label={call.camera ? 'Stop video' : 'Start video'}
            >
              <Icon name={call.camera ? 'camera-video' : 'camera-video-off'} />
            </Control>
            <Control
              active={call.screen}
              onClick={() => call.toggle('screen')}
              label={call.screen ? 'Stop sharing' : 'Share screen'}
            >
              <Icon name="display" />
            </Control>
            <button
              onClick={call.leave}
              className="ml-2 rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:brightness-110"
            >
              Leave
            </button>
          </div>
          <div className="flex-1" />
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

function FeedTile({
  feed,
  selfName,
  focused = false,
  compact = false,
  onToggleFocus,
}: {
  feed: Feed;
  selfName: string;
  /** Shown as the large view. */
  focused?: boolean;
  /** Shown in the strip beside or below the large view. */
  compact?: boolean;
  onToggleFocus: () => void;
}) {
  const { participant, source } = feed;
  const videoRef = useRef<HTMLVideoElement>(null);
  const isLocal = participant instanceof LocalParticipant;
  const publication = participant.getTrackPublication(
    source === 'screen' ? Track.Source.ScreenShare : Track.Source.Camera,
  );
  // A camera that is turned off keeps its publication but shows nothing.
  const video = publication?.track && !(source === 'camera' && publication.isMuted) ? publication : undefined;
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

  // Audio is not played here. The call plays it, so it keeps going when this
  // view is closed.

  const person = isLocal ? `${selfName} (you)` : participant.name || participant.identity;
  const label =
    source === 'screen' ? (isLocal ? 'Your screen' : `${participant.name || participant.identity}’s screen`) : person;
  const action = focused ? `Stop focusing on ${label}` : `Focus on ${label}`;

  return (
    <button
      type="button"
      onClick={onToggleFocus}
      title={action}
      aria-label={action}
      aria-pressed={focused}
      className={cx(
        'group relative flex h-full w-full items-center justify-center overflow-hidden rounded-xl outline-none',
        'focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]',
        source === 'screen' ? 'bg-black' : 'bg-[var(--color-surface)]',
        !compact && !focused && 'min-h-[150px]',
        source === 'camera' && participant.isSpeaking && 'ring-2 ring-[var(--color-accent)]',
      )}
    >
      {video ? (
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          // Your own camera is mirrored, as people expect of their own image;
          // a shared screen is not, because its text would read backwards.
          className={cx('h-full w-full object-contain', isLocal && source === 'camera' && 'scale-x-[-1]')}
        />
      ) : (
        <Avatar
          name={person}
          url={participant.attributes.avatarUrl || null}
          seed={participant.identity}
          size={compact ? 'lg' : 'xl'}
        />
      )}

      <span
        className={cx(
          'absolute bottom-2 left-2 flex max-w-[calc(100%-1rem)] items-center gap-1.5 rounded-md bg-black/60 px-2 py-1 text-white',
          compact ? 'text-[11px]' : 'text-xs',
        )}
      >
        {source === 'screen' ? (
          <Icon name="display" />
        ) : (
          muted && (
            <span title="Muted">
              <Icon name="mic-mute" />
            </span>
          )
        )}
        <span className="truncate">{label}</span>
      </span>

      <span
        aria-hidden
        className="absolute right-2 top-2 rounded-md bg-black/60 px-1.5 py-1 text-xs text-white opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
      >
        <Icon name={focused ? 'fullscreen-exit' : 'fullscreen'} />
      </span>
    </button>
  );
}
