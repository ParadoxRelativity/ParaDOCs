import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import {
  DEFAULT_THEME,
  fitScale,
  showCommandForKey,
  showPlaylist,
  showReducer,
  swipeDirection,
  type ShowAction,
  type ShowState,
} from '@paradocs/shared';
import { usePresentationDeck } from '../../api/hooks';
import { useBackHandler } from '../../lib/back';
import { followLiveShow, useFollowTarget, useLiveFollower } from '../../lib/liveShow';
import { cx } from '../../lib/util';
import Icon from '../Icon';
import SlideView from './SlideView';
import { SlideLinkContext, SlideLinkPeek, type SlideLinkTarget } from './slideLinks';
import { SlideShowStepContext, slideShowSteps } from './slideShowExtensions';

/** Mounted once in the workspace shell: shows the follower view whenever a live show has been opened. */
export function LiveShowHost() {
  const target = useFollowTarget();
  if (!target) return null;
  return <LiveFollower key={target} presentationId={target} onClose={() => followLiveShow(null)} />;
}

/**
 * Follows a presenter's slideshow. The slide and build step shown are the
 * presenter's, as they send them; swiping or pressing the arrows browses the
 * deck on this screen only, and "Jump to presenter" comes back. Nothing here
 * is ever sent: the presenter's position is theirs alone.
 *
 * It draws from the deck's read-only snapshot, so the people following see
 * what SlideView draws everywhere else, at their own screen's size.
 */
function LiveFollower({ presentationId, onClose }: { presentationId: string; onClose: () => void }) {
  const follower = useLiveFollower(presentationId);
  const deck = usePresentationDeck(presentationId);
  const root = useRef<HTMLDivElement>(null);
  const swipe = useRef<{ x: number; y: number } | null>(null);
  const [box, setBox] = useState({ width: window.innerWidth, height: window.innerHeight });
  // Where this viewer has browsed to; null while they are with the presenter.
  const [away, setAway] = useState<ShowState | null>(null);
  // What this viewer has opened from the slide, over it; the presenter goes on regardless.
  const [peek, setPeek] = useState<SlideLinkTarget | null>(null);

  useBackHandler(onClose);
  useBackHandler(() => setPeek(null), { active: peek !== null });
  // The show is over: back to the deck.
  useEffect(() => {
    if (follower.status === 'ended') onClose();
  }, [follower.status, onClose]);

  useEffect(() => {
    root.current?.focus();
  }, []);
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const measure = () => setBox({ width: el.clientWidth || window.innerWidth, height: el.clientHeight || window.innerHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const slides = deck.data?.slides;
  const playlist = useMemo(() => showPlaylist(slides ?? [], slideShowSteps), [slides]);
  const presenter = follower.state;
  const shown = away ?? presenter;
  const slide = slides?.find((s) => s.id === shown?.slideId) ?? null;

  // The presenter may have gone to a slide added since this copy of the deck was read.
  const refetch = deck.refetch;
  const missing = presenter?.slideId && slides && !slides.some((s) => s.id === presenter.slideId) ? presenter.slideId : null;
  useEffect(() => {
    if (missing) void refetch();
  }, [missing, refetch]);

  const browse = useCallback(
    (action: ShowAction) => {
      if (!shown || playlist.length === 0) return;
      const next = showReducer(shown, action, playlist);
      // Arriving back where the presenter is is following again.
      if (presenter && next.slideId === presenter.slideId && next.step === presenter.step && !next.blank) setAway(null);
      else setAway({ ...next, blank: null });
    },
    [shown, playlist, presenter],
  );
  const latest = useRef({ browse, onClose, peeking: peek !== null });
  latest.current = { browse, onClose, peeking: peek !== null };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (latest.current.peeking) {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          setPeek(null);
        }
        return;
      }
      const command = showCommandForKey(e.key, { shift: e.shiftKey });
      if (!command) return;
      if (command.type === 'exit') {
        e.preventDefault();
        return latest.current.onClose();
      }
      if (command.type === 'next' || command.type === 'prev' || command.type === 'first' || command.type === 'last') {
        e.preventDefault();
        e.stopPropagation();
        latest.current.browse(command);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  const onPointerDown = (e: ReactPointerEvent) => {
    swipe.current = { x: e.clientX, y: e.clientY };
  };
  const onPointerUp = (e: ReactPointerEvent) => {
    const start = swipe.current;
    swipe.current = null;
    if (!start) return;
    const direction = swipeDirection(e.clientX - start.x, e.clientY - start.y);
    if (direction !== 0) browse({ type: direction === 1 ? 'next' : 'prev' });
  };

  const size = deck.data?.settings.size;
  const theme = deck.data?.themes.find((t) => t.id === deck.data?.settings.themeId) ?? deck.data?.themes[0] ?? DEFAULT_THEME;
  // Leave room for the bars above and below the slide.
  const stage = { width: box.width, height: Math.max(box.height - 96, 80) };
  const scale = size ? fitScale(size, stage.width, stage.height) : 1;
  const index = playlist.findIndex((s) => s.id === shown?.slideId);
  const blanked = !away && presenter?.blank;
  const presenterName = follower.show?.presenter.name ?? 'the presenter';

  return createPortal(
    <div
      ref={root}
      role="dialog"
      aria-label="Live presentation"
      tabIndex={-1}
      onKeyDown={(e) => e.stopPropagation()}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      className="fixed inset-0 z-[70] flex touch-pan-y select-none flex-col overflow-hidden bg-black text-white outline-none"
    >
      <div
        onPointerDown={(e) => e.stopPropagation()}
        onPointerUp={(e) => e.stopPropagation()}
        className="flex h-12 shrink-0 items-center gap-2 px-3 text-sm"
      >
        <Icon name="broadcast" className={cx(follower.status === 'following' && 'text-red-400')} />
        <span className="min-w-0 flex-1 truncate">
          {follower.status === 'following'
            ? `${presenterName} is presenting${follower.show ? ` · ${follower.show.title}` : ''}`
            : follower.status === 'refused'
              ? 'Cannot follow this presentation'
              : 'Joining…'}
        </span>
        {away && (
          <button
            type="button"
            onClick={() => setAway(null)}
            className="shrink-0 rounded-full bg-[var(--color-accent)] px-3 py-1.5 text-xs font-medium"
          >
            Jump to presenter
          </button>
        )}
        <button type="button" aria-label="Leave live presentation" title="Leave" onClick={onClose} className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-white/15 hover:bg-white/25">
          <Icon name="x-lg" />
        </button>
      </div>

      <div className="relative min-h-0 flex-1">
        {follower.status === 'refused' ? (
          <div className="grid h-full place-items-center p-6 text-center text-sm">{follower.message ?? 'You do not have access to this presentation.'}</div>
        ) : size && slide ? (
          <div className="absolute overflow-hidden" style={{ width: size.width * scale, height: size.height * scale, left: (stage.width - size.width * scale) / 2, top: (stage.height - size.height * scale) / 2 }}>
            <SlideShowStepContext.Provider value={{ slideId: slide.id, step: shown?.step ?? 0 }}>
              <SlideLinkContext.Provider value={setPeek}>
                <SlideView slide={slide} size={size} theme={theme} width={size.width * scale} />
              </SlideLinkContext.Provider>
            </SlideShowStepContext.Provider>
            {blanked && <div aria-hidden className={cx('absolute inset-0', presenter?.blank === 'black' ? 'bg-black' : 'bg-white')} />}
          </div>
        ) : (
          <div className="grid h-full place-items-center text-sm opacity-70">{deck.isError ? 'Could not load the slides.' : follower.state?.slideId === null && follower.status === 'following' ? 'Waiting for the presenter…' : 'Loading…'}</div>
        )}
        {peek && <SlideLinkPeek target={peek} onClose={() => setPeek(null)} />}
      </div>

      <div
        onPointerDown={(e) => e.stopPropagation()}
        onPointerUp={(e) => e.stopPropagation()}
        className="flex h-12 shrink-0 items-center justify-center gap-3 text-xs"
      >
        <button type="button" aria-label="Previous slide" onClick={() => browse({ type: 'prev' })} className="grid h-9 w-9 place-items-center rounded-full bg-white/15 hover:bg-white/25">
          <Icon name="chevron-left" />
        </button>
        <span className="min-w-16 text-center tabular-nums">
          {index >= 0 ? index + 1 : 0} / {playlist.length}
        </span>
        <button type="button" aria-label="Next slide" onClick={() => browse({ type: 'next' })} className="grid h-9 w-9 place-items-center rounded-full bg-white/15 hover:bg-white/25">
          <Icon name="chevron-right" />
        </button>
      </div>

      <div role="status" aria-live="polite" className="sr-only">
        {away ? 'Browsing on your own' : `Slide ${index + 1} of ${playlist.length}, following ${presenterName}`}
      </div>
    </div>,
    document.body,
  );
}
