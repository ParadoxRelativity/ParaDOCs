import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  NOTES_SIZE_DEFAULT,
  clampNotesSize,
  formatDuration,
  nextPreview,
  pauseTimer,
  recordTiming,
  resetTimer,
  resumeTimer,
  showCommandForKey,
  startTimer,
  timerElapsed,
  totalTiming,
  type SlideTimings,
} from '@paradocs/shared';
import { useBackHandler } from '../../lib/back';
import { desktop } from '../../lib/desktop';
import { isNativeApp } from '../../lib/server';
import { cx } from '../../lib/util';
import Icon from '../Icon';
import SlideNotesView from './SlideNotesView';
import SlideView from './SlideView';
import { SlideShowStepContext, registerSlideShowAddon, type SlideShowAddonContext } from './slideShowExtensions';

/**
 * The presenter view (PARA-94): the current slide, the next slide or build,
 * speaker notes, a timer, the clock and a grid of slides to jump to.
 *
 * It is an add-on of the running show, so it reads and drives the same
 * SlideShowController the audience's screen is drawn from; nothing needs
 * syncing, and notes a collaborator types appear live. It opens
 *   - in a window of its own (`window.open`, drawn into with a portal) to be
 *     dragged to the laptop screen while the show fills the projector, and on
 *     desktop placed on the right display by the app, or
 *   - over the show, on one screen, with a button back to the audience view.
 *     Phones only have this one, and Android back closes it before the show.
 * Closing either one ends the show; hiding the inline view does not.
 */

const NOTES_SIZE_KEY = 'paradocs.slides.notesSize';
const FRAME = 'paradocs-presenter';

type Mode = 'closed' | 'inline' | 'window';

function readNotesSize(): number {
  try {
    return clampNotesSize(Number(localStorage.getItem(NOTES_SIZE_KEY) ?? NOTES_SIZE_DEFAULT));
  } catch {
    return NOTES_SIZE_DEFAULT;
  }
}

function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(id);
  }, [ms]);
  return now;
}

function PresenterAddon(ctx: SlideShowAddonContext) {
  const { controller, exit } = ctx;
  const [mode, setMode] = useState<Mode>('closed');
  const [target, setTarget] = useState<HTMLElement | null>(null);
  const popup = useRef<Window | null>(null);
  const swapped = useRef(false);
  const [timer, setTimer] = useState(() => startTimer(Date.now()));
  const [timings, setTimings] = useState<SlideTimings>({});
  const last = useRef({ id: controller.state.slideId, at: Date.now() });
  const exitRef = useRef(exit);
  exitRef.current = exit;
  const modeRef = useRef(mode);
  modeRef.current = mode;

  // Time on each slide, kept for the rehearsal summary: charged to the slide being left.
  const slideId = controller.state.slideId;
  useEffect(() => {
    const now = Date.now();
    const before = last.current;
    if (before.id !== slideId) {
      setTimings((t) => recordTiming(t, before.id, now - before.at));
      last.current = { id: slideId, at: now };
    }
  }, [slideId]);
  // What the current slide has accrued so far, so its row is live without waiting to leave it.
  const liveTimings = recordTiming(timings, last.current.id, Date.now() - last.current.at);

  const closeWindow = useCallback(() => {
    const w = popup.current;
    popup.current = null;
    setTarget(null);
    if (w && !w.closed) w.close();
  }, []);

  // The show going away takes the presenter's window with it.
  useEffect(() => closeWindow, [closeWindow]);

  // Closing the presenter's window ends the show. There is no reliable close event across browsers, so it is watched.
  useEffect(() => {
    if (mode !== 'window') return;
    const id = window.setInterval(() => {
      if (!popup.current || popup.current.closed) {
        popup.current = null;
        setTarget(null);
        setMode('closed');
        exitRef.current();
      }
    }, 400);
    return () => window.clearInterval(id);
  }, [mode]);

  /** Puts the slides on the other display and this one's presenter view here, on the desktop app. */
  const arrange = useCallback(
    async (swap: boolean) => {
      if (!desktop) return;
      const wasFull = Boolean(document.fullscreenElement);
      // A full-screen window cannot change display, so the show leaves it (by choice, which keeps it going) and comes back.
      if (wasFull) ctx.toggleFullscreen();
      const result = await desktop.presenter.arrange(swap).catch(() => null);
      if (wasFull) window.setTimeout(() => ctx.toggleFullscreen(), 350);
      return result;
    },
    // The context is rebuilt every render; only its toggle is used, and it acts on the newest state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const openWindow = useCallback(() => {
    const w = !isNativeApp ? window.open('', FRAME, 'popup,width=1280,height=800') : null;
    if (!w) return setMode('inline');
    popup.current = w;
    w.document.title = 'Presenter view';
    for (const node of Array.from(document.head.querySelectorAll('link[rel="stylesheet"], style'))) {
      w.document.head.appendChild(node.cloneNode(true));
    }
    w.document.documentElement.className = document.documentElement.className;
    w.document.body.className = 'h-screen bg-[var(--color-canvas)] text-[var(--color-ink)]';
    const root = w.document.createElement('div');
    root.className = 'h-full';
    w.document.body.appendChild(root);
    setTarget(root);
    setMode('window');
    void arrange(swapped.current);
  }, [arrange]);

  const swap = () => {
    swapped.current = !swapped.current;
    void arrange(swapped.current);
  };

  // Keys pressed in the presenter's window drive the show as they do in the audience's.
  useEffect(() => {
    const w = popup.current;
    if (mode !== 'window' || !w) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const command = showCommandForKey(e.key, { shift: e.shiftKey, jumping: controller.state.jump !== '' });
      if (!command || command.type === 'laser' || command.type === 'fullscreen') return;
      e.preventDefault();
      if (command.type === 'exit') exitRef.current();
      else controller.dispatch(command);
    };
    w.addEventListener('keydown', onKey);
    return () => w.removeEventListener('keydown', onKey);
  }, [mode, target, controller]);

  // The launcher's own key; the show leaves letters it does not use alone.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.key.toLowerCase() !== 's') return;
      e.preventDefault();
      if (modeRef.current !== 'closed') return;
      if (isNativeApp) setMode('inline');
      else openWindow();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openWindow]);

  const body = (inline: boolean) => (
    <PresenterBody
      {...ctx}
      inline={inline}
      timer={timer}
      onTimer={setTimer}
      timings={liveTimings}
      onResetTimings={() => {
        setTimings({});
        last.current = { id: controller.state.slideId, at: Date.now() };
      }}
      onAudience={() => setMode('closed')}
      onSwap={desktop ? swap : undefined}
    />
  );

  return (
    <>
      {mode === 'closed' && (
        <button
          type="button"
          onClick={() => (isNativeApp ? setMode('inline') : openWindow())}
          onPointerUp={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          aria-label="Presenter view (S)"
          title="Presenter view (S)"
          className="absolute right-3 top-14 z-20 flex items-center gap-1.5 rounded-full bg-white/15 px-3 py-1.5 text-xs text-white opacity-0 transition-opacity hover:bg-white/25 focus-visible:opacity-100 [@media(hover:none)]:opacity-60"
        >
          <Icon name="person-video3" /> Presenter view
        </button>
      )}
      {mode === 'inline' && <InlineFrame onBack={() => setMode('closed')}>{body(true)}</InlineFrame>}
      {mode === 'window' && target && createPortal(body(false), target)}
    </>
  );
}

/** The presenter view over the show on one screen. Back (Android's included) shows the audience view again. */
function InlineFrame({ onBack, children }: { onBack: () => void; children: ReactNode }) {
  // Registered after the show's own, so back closes this before it leaves the show.
  useBackHandler(onBack);
  return (
    <div
      role="dialog"
      aria-label="Presenter view"
      className="absolute inset-0 z-30 bg-[var(--color-canvas)] text-[var(--color-ink)]"
      onPointerDown={(e) => e.stopPropagation()}
      onPointerUp={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
    >
      {children}
    </div>
  );
}

interface BodyProps extends SlideShowAddonContext {
  inline: boolean;
  timer: ReturnType<typeof startTimer>;
  onTimer: (t: ReturnType<typeof startTimer>) => void;
  timings: SlideTimings;
  onResetTimings: () => void;
  onAudience: () => void;
  onSwap?: () => void;
}

function PresenterBody({ controller, theme, size: slideSize, slides, ydoc, exit, inline, timer, onTimer, timings, onResetTimings, onAudience, onSwap }: BodyProps) {
  const { slide, nextSlide, index, count, step, steps, playlist } = controller;
  const [fontSize, setFontSize] = useState(readNotesSize);
  const [rehearse, setRehearse] = useState(false);
  const now = useNow(1000);

  const setSize = (px: number) => {
    const next = clampNotesSize(px);
    setFontSize(next);
    try {
      localStorage.setItem(NOTES_SIZE_KEY, String(next));
    } catch {
      // Not remembered; the size still applies.
    }
  };

  const upcoming = nextPreview(step, steps, nextSlide !== null);

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-3 text-sm">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex items-center gap-2">
          <span className="text-2xl font-semibold tabular-nums" aria-label="Elapsed time">
            {formatDuration(timerElapsed(timer, now))}
          </span>
          <button
            type="button"
            aria-label={timer.running ? 'Pause timer' : 'Resume timer'}
            title={timer.running ? 'Pause timer' : 'Resume timer'}
            onClick={() => onTimer(timer.running ? pauseTimer(timer, Date.now()) : resumeTimer(timer, Date.now()))}
            className="grid h-8 w-8 place-items-center rounded-full bg-[var(--color-surface)] hover:bg-[var(--color-line)]"
          >
            <Icon name={timer.running ? 'pause-fill' : 'play-fill'} />
          </button>
          <button
            type="button"
            aria-label="Reset timer"
            title="Reset timer"
            onClick={() => {
              onTimer(resetTimer(timer, Date.now()));
              onResetTimings();
            }}
            className="grid h-8 w-8 place-items-center rounded-full bg-[var(--color-surface)] hover:bg-[var(--color-line)]"
          >
            <Icon name="arrow-counterclockwise" />
          </button>
        </div>
        <span className="text-[var(--color-muted)] tabular-nums" aria-label="Time of day">
          {new Date(now).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
        </span>
        <span className="tabular-nums" role="status" aria-live="polite">
          Slide {count === 0 ? 0 : index + 1} of {count}
          {steps > 0 && <span className="ml-2 text-[var(--color-muted)]">Step {step} of {steps}</span>}
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          <PanelButton label="Smaller notes" onClick={() => setSize(fontSize - 2)}>
            A&minus;
          </PanelButton>
          <PanelButton label="Larger notes" onClick={() => setSize(fontSize + 2)}>
            A+
          </PanelButton>
          <PanelButton label="Rehearse with timings" pressed={rehearse} onClick={() => setRehearse((r) => !r)}>
            <Icon name="stopwatch" /> Rehearse
          </PanelButton>
          {onSwap && (
            <PanelButton label="Swap displays" onClick={onSwap}>
              <Icon name="arrow-left-right" /> Swap displays
            </PanelButton>
          )}
          {inline && (
            <PanelButton label="Show audience view" onClick={onAudience}>
              <Icon name="easel2" /> Audience view
            </PanelButton>
          )}
          <PanelButton label="End show" onClick={exit}>
            <Icon name="x-lg" /> End show
          </PanelButton>
        </div>
      </header>

      <div className="grid min-h-0 flex-1 gap-3 md:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="flex min-h-0 flex-col gap-3">
          <div className="min-h-0 flex-1 overflow-y-auto">
            <Preview label="Current slide" aspect={slideSize}>
              {(width) =>
                slide ? (
                  <SlideShowStepContext.Provider value={{ slideId: slide.id, step: controller.state.step }}>
                    <SlideView slide={slide} size={slideSize} theme={theme} width={width} />
                  </SlideShowStepContext.Provider>
                ) : null
              }
            </Preview>
          </div>
          <div style={{ fontSize }} className="min-h-0 flex-1 overflow-y-auto rounded-md border border-[var(--color-line)] p-3" aria-label="Speaker notes">
            {slide ? (
              <SlideNotesView ydoc={ydoc} slideId={slide.id} emptyText="No notes for this slide." className="leading-snug" />
            ) : null}
          </div>
        </div>

        <div className="flex min-h-0 flex-col gap-3">
          <div>
            <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-[var(--color-muted)]">
              {upcoming === 'build' ? 'Next build' : upcoming === 'slide' ? 'Next slide' : 'End of show'}
            </p>
            {upcoming === 'end' ? (
              <p className="rounded-md border border-dashed border-[var(--color-line)] p-4 text-center text-[var(--color-muted)]">This is the last slide.</p>
            ) : (
              <Preview label="Next" aspect={slideSize} small>
                {(width) =>
                  upcoming === 'build' && slide ? (
                    <SlideShowStepContext.Provider value={{ slideId: slide.id, step: step + 1 }}>
                      <SlideView slide={slide} size={slideSize} theme={theme} width={width} />
                    </SlideShowStepContext.Provider>
                  ) : nextSlide ? (
                    // A slide not yet reached is shown whole, so the presenter sees what is coming.
                    <SlideShowStepContext.Provider value={{ slideId: nextSlide.id, step: Number.POSITIVE_INFINITY }}>
                      <SlideView slide={nextSlide} size={slideSize} theme={theme} width={width} />
                    </SlideShowStepContext.Provider>
                  ) : null
                }
              </Preview>
            )}
          </div>

          <div className="flex min-h-0 flex-1 flex-col">
            <p className="mb-1 flex items-center justify-between text-xs font-semibold uppercase tracking-wide text-[var(--color-muted)]">
              <span>Slides</span>
              {rehearse && <span className="normal-case tabular-nums">Total {formatDuration(totalTiming(timings))}</span>}
            </p>
            <ol className="grid min-h-0 flex-1 grid-cols-2 content-start gap-2 overflow-y-auto sm:grid-cols-3" aria-label="Jump to slide">
              {playlist.map((entry, i) => {
                const s = slides.find((x) => x.id === entry.id);
                return (
                  <li key={entry.id}>
                    <button
                      type="button"
                      aria-label={`Go to slide ${i + 1}`}
                      aria-current={i === index ? 'true' : undefined}
                      onClick={() => controller.goToId(entry.id)}
                      className={cx(
                        'block w-full overflow-hidden rounded-md border-2 text-left',
                        i === index ? 'border-[var(--color-accent)]' : 'border-transparent hover:border-[var(--color-line)]',
                      )}
                    >
                      <Preview label={`Slide ${i + 1}`} aspect={slideSize} small>
                        {(width) =>
                          s ? (
                            <SlideShowStepContext.Provider value={{ slideId: s.id, step: Number.POSITIVE_INFINITY }}>
                              <SlideView slide={s} size={slideSize} theme={theme} width={width} />
                            </SlideShowStepContext.Provider>
                          ) : null
                        }
                      </Preview>
                      <span className="flex justify-between px-1 text-[11px] tabular-nums text-[var(--color-muted)]">
                        <span>{i + 1}</span>
                        {rehearse && <span>{formatDuration(timings[entry.id] ?? 0)}</span>}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ol>
          </div>
        </div>
      </div>
    </div>
  );
}

function PanelButton({ label, onClick, pressed, children }: { label: string; onClick: () => void; pressed?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      onClick={onClick}
      className={cx(
        'inline-flex h-8 items-center gap-1 rounded-md border border-[var(--color-line)] px-2 text-xs hover:bg-[var(--color-surface)]',
        pressed && 'bg-[var(--color-surface)]',
      )}
    >
      {children}
    </button>
  );
}

/** A box at a slide's aspect ratio, measured so the slide inside is drawn at its width. */
function Preview({
  aspect,
  label,
  small,
  children,
}: {
  aspect: { width: number; height: number };
  label: string;
  small?: boolean;
  children: (width: number) => ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(small ? 240 : 640);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setWidth(Math.max(1, el.clientWidth));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return (
    <div
      ref={box}
      role="img"
      aria-label={label}
      style={{ aspectRatio: `${aspect.width} / ${aspect.height}` }}
      className="relative w-full overflow-hidden rounded-md bg-black/80"
    >
      {children(width)}
    </div>
  );
}

registerSlideShowAddon({ id: 'presenter-view', order: 10, render: (ctx) => <PresenterAddon {...ctx} /> });
