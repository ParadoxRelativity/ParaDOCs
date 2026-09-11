import type { IncomingCall } from '../../lib/directCalls';
import Avatar from '../Avatar';
import Icon from '../Icon';

/**
 * Someone calling, in the corner of whatever is on screen. It rings from
 * anywhere in the app — a document, another workspace — because being called
 * is the one thing that cannot wait for you to open chat.
 */
export function IncomingCallCard({
  incoming,
  inCall,
  onAccept,
  onDecline,
}: {
  incoming: IncomingCall;
  /** Answering leaves the call you are in, which is worth saying. */
  inCall: boolean;
  onAccept: (video: boolean) => void;
  onDecline: () => void;
}) {
  const { caller } = incoming;
  return (
    <div
      role="alertdialog"
      aria-label={`Incoming call from ${caller.name}`}
      className="fixed bottom-4 right-4 z-[60] w-80 rounded-xl border border-[var(--color-line)] bg-[var(--color-raised)] p-4 shadow-2xl"
    >
      <div className="flex items-center gap-3">
        <span className="relative grid place-items-center">
          <span aria-hidden className="absolute inset-0 animate-ping rounded-full bg-emerald-500/30" />
          <Avatar name={caller.name} url={caller.avatarUrl} seed={caller.id} size="lg" className="relative" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{caller.name}</p>
          <p className="text-xs text-[var(--color-muted)]">
            {incoming.video ? 'Incoming video call' : 'Incoming voice call'}
            {inCall && ' · answering leaves your current call'}
          </p>
        </div>
      </div>
      <div className="mt-3 flex gap-2">
        <button
          onClick={onDecline}
          className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-red-600 px-3 py-2 text-sm font-semibold text-white hover:brightness-110"
        >
          <Icon name="telephone-x" /> Decline
        </button>
        <button
          autoFocus
          onClick={() => onAccept(incoming.video)}
          className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-2 text-sm font-semibold text-white hover:brightness-110"
        >
          <Icon name={incoming.video ? 'camera-video' : 'telephone'} /> Accept
        </button>
        {/* The other way of answering: audio only for a video call, or with
            your camera on for a voice one. */}
        <button
          onClick={() => onAccept(!incoming.video)}
          title={incoming.video ? 'Answer with audio only' : 'Answer with video'}
          aria-label={incoming.video ? 'Answer with audio only' : 'Answer with video'}
          className="grid w-10 place-items-center rounded-lg bg-[var(--color-surface)] text-[var(--color-ink)] hover:bg-[var(--color-line)]"
        >
          <Icon name={incoming.video ? 'telephone' : 'camera-video'} />
        </button>
      </div>
    </div>
  );
}
