import type { ReactNode } from 'react';
import type { Channel } from '@paradocs/shared';
import type { VoiceConfig } from '../../api/hooks';
import type { Call } from '../../lib/call';
import { EmptyState } from '../ui';
import Icon from '../Icon';
import { CallStage } from './CallStage';

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
  actions,
}: {
  channel: Channel;
  config: VoiceConfig | undefined;
  call: Call;
  selfName: string;
  /** Controls at the end of the header, such as moving the room to its own window. */
  actions?: ReactNode;
}) {
  const here = call.channelId === channel.id;
  const joined = here && call.status === 'joined';

  if (config && !config.enabled) {
    return (
      <EmptyState
        icon="volume-mute"
        title="Voice is off on this server"
        hint="The Docker deployment runs voice unless VOICE_ENABLED is false. Elsewhere, set LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET."
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--color-line)] px-4">
        <span className="shrink-0 text-sm font-semibold">
          <Icon name="volume-up" /> {channel.name}
        </span>
        {channel.topic && (
          <span className="min-w-0 flex-1 truncate text-xs text-[var(--color-muted)]">{channel.topic}</span>
        )}
        {actions && <span className="ml-auto flex shrink-0 items-center gap-2">{actions}</span>}
      </header>

      {!joined ? (
        <div className="grid min-h-0 flex-1 place-items-center">
          <div className="text-center">
            <div className="mb-3 text-4xl">
              <Icon name="volume-up" />
            </div>
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
        <div className="min-h-0 flex-1">
          <CallStage call={call} selfName={selfName} />
        </div>
      )}
    </div>
  );
}
