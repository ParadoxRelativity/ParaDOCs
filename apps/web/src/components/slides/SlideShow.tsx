import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import type * as Y from 'yjs';
import {
  fitScale,
  showCommandForKey,
  swipeDirection,
  transitionDuration,
  transitionFrames,
  type ShowCommand,
  type SlideSize,
  type SlideSnapshot,
  type Theme,
} from '@paradocs/shared';
import { useBackHandler } from '../../lib/back';
import { useSlideShow, type SlideShowController } from '../../lib/slideShow';
import { assetUrl, isNativeApp } from '../../lib/server';
import { cx } from '../../lib/util';
import Icon from '../Icon';
import SlideView from './SlideView';
import './slideBuildBuiltins';
import { SlideShowStepContext, slideShowAddons, slideShowSteps } from './slideShowExtensions';

interface Props {
  slides: SlideSnapshot[];
  size: SlideSize;
  theme: Theme;
  presentationId: string;
  workspaceId: string;
  ydoc: Y.Doc;
  /** The slide to begin on; the first shown slide when null or hidden. */
  startId: string | null;
  onExit: () => void;
}

/** How long the controls and the pointer stay out after the last movement. */
const CONTROLS_IDLE_MS = 2800;
/** A press that moves less than this is a tap rather than the start of a swipe. */
const TAP_SLOP = 10;

interface Leaving {
  key: number;
  slide: SlideSnapshot;
  kind: Parameters<typeof transitionFrames>[0];
  direction: 1 | -1;
  ms: number;
}

/**
 * The full-screen slideshow, generalising canvas/PresentMode: the Fullscreen
 * API, the slide scaled to fit with letterboxing, read-only rendering through
 * SlideView, and focus, Escape and Android back to leave.
 *
 * It only reads the deck, so presenting changes nothing for anyone else.
 * Its state lives in a SlideShowController (lib/slideShow), which add-ons
 * registered in slideShowExtensions.tsx receive: the presenter view, build
 * animations and live following all hang off that.
 */
export default function SlideShow({ slides, size, theme, presentationId, workspaceId, ydoc, startId, onExit }: Props) {
  const controller = useSlideShow(slides, startId, slideShowSteps);
  const { slide, blank, state } = controller;
  const root = useRef<HTMLDivElement>(null);
  const laserDot = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ width: window.innerWidth, height: window.innerHeight });
  const [controlsVisible, setControlsVisible] = useState(true);
  const [laser, setLaser] = useState(false);
  const [leaving, setLeaving] = useState<Leaving | null>(null);
  const idle = useRef<number | undefined>(undefined);
  const enteredFullscreen = useRef(false);
  const swipe = useRef<{ x: number; y: number } | null>(null);
  const previous = useRef<{ slide: SlideSnapshot; index: number } | null>(null);
  const leavingKey = useRef(0);
  const exitRef = useRef(onExit);
  exitRef.current = onExit;

  useBackHandler(onExit);

  // Focus moves into the show, as PresentMode does, so keys are not aimed at the button behind it. It goes back on exit.
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    root.current?.focus();
    return () => before?.focus?.();
  }, []);

  // Full screen where the browser allows it (it will not without a user gesture, and phones may refuse), landscape on phones.
  useEffect(() => {
    const el = root.current;
    if (el?.requestFullscreen && !document.fullscreenElement) {
      el.requestFullscreen().then(
        () => {
          enteredFullscreen.current = true;
        },
        () => {},
      );
    }
    const orientation = typeof screen !== 'undefined' ? (screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> }) : undefined;
    const coarse = isNativeApp || window.matchMedia?.('(pointer: coarse)').matches;
    if (coarse) orientation?.lock?.('landscape').catch(() => {});
    // The browser's own Escape leaves full screen without a key event reaching the page, so full screen ending ends the show.
    const onFullscreen = () => {
      if (!document.fullscreenElement && enteredFullscreen.current) exitRef.current();
    };
    document.addEventListener('fullscreenchange', onFullscreen);
    return () => {
      document.removeEventListener('fullscreenchange', onFullscreen);
      enteredFullscreen.current = false;
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
      if (coarse) orientation?.unlock?.();
    };
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

  const wake = useCallback(() => {
    setControlsVisible(true);
    window.clearTimeout(idle.current);
    idle.current = window.setTimeout(() => setControlsVisible(false), CONTROLS_IDLE_MS);
  }, []);
  useEffect(() => {
    wake();
    return () => window.clearTimeout(idle.current);
  }, [wake]);

  const run = useCallback(
    (command: ShowCommand) => {
      if (command.type === 'exit') return onExit();
      if (command.type === 'laser') return setLaser((on) => !on);
      if (command.type === 'fullscreen') {
        const el = root.current;
        if (document.fullscreenElement) {
          // Leaving full screen by choice keeps the show going in the window.
          enteredFullscreen.current = false;
          void document.exitFullscreen().catch(() => {});
        } else {
          void el?.requestFullscreen?.().then(() => (enteredFullscreen.current = true)).catch(() => {});
        }
        return;
      }
      controller.dispatch(command);
    },
    [controller, onExit],
  );
  // Keys are bound once but must act on the newest controller.
  const latest = useRef({ run, jumping: state.jump !== '' });
  latest.current = { run, jumping: state.jump !== '' };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Browser and OS shortcuts (reload, devtools, switching apps) are not the show's.
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const command = showCommandForKey(e.key, { shift: e.shiftKey, jumping: latest.current.jumping });
      if (!command) return;
      // The show claims its keys before the editor underneath can act on them.
      e.preventDefault();
      e.stopPropagation();
      latest.current.run(command);
      wake();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [wake]);

  // ---- transitions --------------------------------------------------------

  // When the slide changes, hand the old one to a layer that animates out beneath the new one.
  useLayoutEffect(() => {
    const last = previous.current;
    previous.current = slide ? { slide, index: controller.index } : null;
    if (!last || !slide || last.slide.id === slide.id) return;
    const direction = controller.index >= last.index ? 1 : -1;
    // Going forward the arriving slide's transition plays; going back, the one being left plays in reverse.
    const transition = direction === 1 ? slide.transition : last.slide.transition;
    const ms = transitionDuration(transition);
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (ms === 0 || reduced) return setLeaving(null);
    setLeaving({ key: ++leavingKey.current, slide: last.slide, kind: transition.kind, direction, ms });
  }, [slide, controller.index]);

  const outgoingLayer = useRef<HTMLDivElement>(null);
  const incomingLayer = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!leaving) return;
    const frames = transitionFrames(leaving.kind, leaving.direction);
    const options: KeyframeAnimationOptions = { duration: leaving.ms, easing: 'ease-in-out', fill: 'both' };
    const animations = [
      outgoingLayer.current?.animate?.(frames.outgoing, options),
      incomingLayer.current?.animate?.(frames.incoming, options),
    ].filter((a): a is Animation => !!a);
    const key = leaving.key;
    let live = true;
    void Promise.all(animations.map((a) => a.finished)).then(
      () => live && setLeaving((now) => (now?.key === key ? null : now)),
      () => {},
    );
    return () => {
      live = false;
      // Pressing on mid-transition snaps it to the end, as the next one starts from the new slide.
      animations.forEach((a) => a.cancel());
    };
  }, [leaving]);

  // ---- preload ------------------------------------------------------------

  const { nextSlide } = controller;
  useEffect(() => {
    if (!nextSlide) return;
    const urls = nextSlide.elements.filter((el) => el.type === 'image' && (el as { url?: string }).url).map((el) => (el as unknown as { url: string }).url);
    if (nextSlide.background?.kind === 'image') urls.push(nextSlide.background.url);
    for (const url of urls) {
      const image = new Image();
      image.decoding = 'async';
      image.src = assetUrl(url);
    }
  }, [nextSlide]);

  // ---- pointer ------------------------------------------------------------

  const onPointerDown = (e: ReactPointerEvent) => {
    swipe.current = { x: e.clientX, y: e.clientY };
  };
  const onPointerMove = (e: ReactPointerEvent) => {
    if (laser && laserDot.current) laserDot.current.style.transform = `translate(${e.clientX}px, ${e.clientY}px)`;
    if (e.pointerType === 'mouse') wake();
  };
  const onPointerUp = (e: ReactPointerEvent) => {
    const start = swipe.current;
    swipe.current = null;
    if (!start || e.button > 0) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    const direction = swipeDirection(dx, dy);
    if (direction !== 0) run({ type: direction === 1 ? 'next' : 'prev' });
    else if (Math.abs(dx) < TAP_SLOP && Math.abs(dy) < TAP_SLOP) {
      // A tap on the left edge goes back on a touch screen; elsewhere, and any click, goes forward.
      const left = e.pointerType === 'touch' && e.clientX < box.width * 0.2;
      run({ type: left ? 'prev' : 'next' });
    }
    wake();
  };

  const scale = fitScale(size, box.width, box.height);
  const width = size.width * scale;
  const height = size.height * scale;
  const layerStyle = useMemo(() => ({ left: (box.width - width) / 2, top: (box.height - height) / 2, width, height }), [box, width, height]);

  const addons = slideShowAddons();
  const addonContext = { controller, theme, size, slides, presentationId, workspaceId, ydoc, toggleFullscreen: () => run({ type: 'fullscreen' }), exit: onExit };

  return createPortal(
    <div
      ref={root}
      role="dialog"
      aria-label="Slideshow"
      tabIndex={-1}
      // Keys and clipboard events the show does not take must not reach the editor it was opened from (React events bubble through portals).
      onKeyDown={(e) => e.stopPropagation()}
      onCopy={(e) => e.stopPropagation()}
      onCut={(e) => e.stopPropagation()}
      onPaste={(e) => e.stopPropagation()}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onContextMenu={(e) => {
        e.preventDefault();
        run({ type: 'prev' });
      }}
      className={cx('fixed inset-0 z-[70] touch-none select-none overflow-hidden bg-black text-white outline-none', (laser || !controlsVisible) && 'cursor-none')}
    >
      {!slide ? (
        <div className="grid h-full place-items-center text-center">
          <div>
            <p className="text-sm">There are no slides to show.</p>
            <p className="mt-1 text-xs opacity-70">Every slide is hidden, or the presentation is empty.</p>
            <button onClick={onExit} onPointerUp={(e) => e.stopPropagation()} className="mt-4 rounded-md bg-white/15 px-3 py-1.5 text-xs">
              Close
            </button>
          </div>
        </div>
      ) : (
        <>
          {leaving && (
            <div ref={outgoingLayer} className="absolute overflow-hidden" style={layerStyle}>
              {/* A slide on its way out shows complete, whatever step it was left on. */}
              <SlideShowStepContext.Provider value={{ slideId: leaving.slide.id, step: Number.POSITIVE_INFINITY }}>
                <SlideView slide={leaving.slide} size={size} theme={theme} width={width} />
              </SlideShowStepContext.Provider>
            </div>
          )}
          <div ref={incomingLayer} className="absolute overflow-hidden" style={layerStyle}>
            <SlideShowStepContext.Provider value={{ slideId: slide.id, step: state.step }}>
              <SlideView slide={slide} size={size} theme={theme} width={width} />
            </SlideShowStepContext.Provider>
          </div>
        </>
      )}

      {blank && <div aria-hidden className={cx('absolute inset-0', blank === 'black' ? 'bg-black' : 'bg-white')} />}

      {laser && <div ref={laserDot} aria-hidden className="pointer-events-none fixed left-0 top-0 z-10 -ml-2.5 -mt-2.5 h-5 w-5 rounded-full bg-red-500/90 shadow-[0_0_14px_6px_rgba(239,68,68,0.55)]" />}

      {state.jump && (
        <div className="pointer-events-none absolute right-4 top-4 rounded-md bg-black/70 px-3 py-1.5 text-sm tabular-nums">Go to slide {state.jump}</div>
      )}

      {controller.count > 0 && (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 bg-white/10" aria-hidden>
          <div className="h-full bg-white/60 transition-[width]" style={{ width: `${((controller.index + 1) / controller.count) * 100}%` }} />
        </div>
      )}

      <div role="status" aria-live="polite" className="sr-only">
        Slide {controller.index + 1} of {controller.count}
      </div>

      <div
        // Buttons are not taps on the slide.
        onPointerUp={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
        onContextMenu={(e) => e.stopPropagation()}
        className={cx(
          'absolute inset-x-0 bottom-0 flex items-center justify-center gap-2 bg-gradient-to-t from-black/60 to-transparent px-4 pb-3 pt-8 text-xs transition-opacity duration-300',
          controlsVisible ? 'opacity-100' : 'pointer-events-none opacity-0',
        )}
      >
        <ControlButton label="Previous" onClick={controller.prev} disabled={controller.index === 0 && controller.step === 0}>
          <Icon name="chevron-left" />
        </ControlButton>
        <span className="min-w-16 text-center tabular-nums">
          {controller.count === 0 ? 0 : controller.index + 1} / {controller.count}
        </span>
        <ControlButton label="Next" onClick={controller.next} disabled={controller.index >= controller.count - 1 && controller.step >= controller.steps}>
          <Icon name="chevron-right" />
        </ControlButton>
        <ControlButton label={laser ? 'Hide laser pointer (L)' : 'Laser pointer (L)'} onClick={() => run({ type: 'laser' })} pressed={laser}>
          <Icon name="record-circle" />
        </ControlButton>
        <ControlButton label="Toggle full screen (F)" onClick={() => run({ type: 'fullscreen' })}>
          <Icon name="fullscreen" />
        </ControlButton>
        <ControlButton label="Exit slideshow (Esc)" onClick={onExit}>
          <Icon name="x-lg" />
        </ControlButton>
      </div>

      {addons.map((addon) => (
        <div key={addon.id}>{addon.render(addonContext)}</div>
      ))}
    </div>,
    document.body,
  );
}

function ControlButton({ label, onClick, disabled, pressed, children }: { label: string; onClick: () => void; disabled?: boolean; pressed?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
      className={cx('grid h-9 w-9 place-items-center rounded-full bg-white/15 text-base hover:bg-white/25 disabled:opacity-40', pressed && 'bg-white/35')}
    >
      {children}
    </button>
  );
}

export type { SlideShowController };
