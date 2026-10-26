import { useMe } from '../../api/hooks';
import { followLiveShow, useFollowTarget, useLiveShows } from '../../lib/liveShow';
import Icon from '../Icon';

/**
 * Tells people a deck is being presented live and lets them follow it. It is
 * how a show is joined: from the deck itself (a link in chat opens it),
 * or from the voice channel the presenter announced it in. Shows nothing when
 * nothing matching is live, and never to the presenter.
 */
export default function LiveShowBanner({
  workspaceId,
  presentationId,
  channelId,
}: {
  workspaceId: string;
  /** Only this deck's show. */
  presentationId?: string;
  /** Only shows announced in this channel. */
  channelId?: string;
}) {
  const me = useMe();
  const shows = useLiveShows(workspaceId);
  const following = useFollowTarget();
  const selfId = me.data?.user?.id;
  const live = (shows.data ?? []).filter(
    (s) =>
      s.presenter.id !== selfId &&
      s.presentationId !== following &&
      (!presentationId || s.presentationId === presentationId) &&
      (!channelId || s.channelId === channelId),
  );
  if (live.length === 0) return null;

  return (
    <div className="flex shrink-0 flex-col gap-px">
      {live.map((show) => (
        <div key={show.presentationId} role="status" className="flex items-center gap-2 bg-[var(--color-accent)] px-4 py-2 text-sm text-white">
          <Icon name="broadcast" />
          <span className="min-w-0 flex-1 truncate">
            <strong>{show.presenter.name}</strong> is presenting {show.title} live
            {show.viewers > 0 && <span className="opacity-80"> · {show.viewers} following</span>}
          </span>
          <button
            type="button"
            onClick={() => followLiveShow(show.presentationId)}
            className="shrink-0 rounded-md bg-white/20 px-3 py-1 text-xs font-medium hover:bg-white/30"
          >
            Follow
          </button>
        </div>
      ))}
    </div>
  );
}
