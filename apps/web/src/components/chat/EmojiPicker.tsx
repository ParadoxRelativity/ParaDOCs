import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { loadEmojiData } from '../../lib/emoji';
import { useTheme } from '../../lib/theme';

/** emoji-mart's picker at its default size, used to place it before it renders. */
const WIDTH = 352;
const HEIGHT = 435;
const MARGIN = 8;

function placeNear(anchor: HTMLElement): { left: number; top: number } {
  const rect = anchor.getBoundingClientRect();
  const left = Math.min(Math.max(rect.right - WIDTH, MARGIN), window.innerWidth - WIDTH - MARGIN);
  // Above the anchor when there is room, since the message box sits at the
  // bottom of the window; below it otherwise.
  const above = rect.top - HEIGHT - MARGIN;
  const top = above >= MARGIN ? above : Math.min(rect.bottom + MARGIN, window.innerHeight - HEIGHT - MARGIN);
  return { left: Math.max(MARGIN, left), top: Math.max(MARGIN, top) };
}

type PickerConstructor = new (options: Record<string, unknown>) => HTMLElement;

/**
 * The emoji picker, floating beside whatever opened it. emoji-mart and its
 * catalogue load on first open, so they cost nothing until someone wants them.
 */
export function EmojiPicker({
  anchor,
  onSelect,
  onClose,
}: {
  anchor: HTMLElement;
  onSelect: (emoji: string) => void;
  onClose: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [theme] = useTheme();
  const [ready, setReady] = useState(false);
  const [position, setPosition] = useState(() => placeNear(anchor));

  // The picker is built once per theme; these keep its callbacks current.
  const select = useRef(onSelect);
  select.current = onSelect;
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    let cancelled = false;
    let picker: HTMLElement | null = null;
    void Promise.all([import('emoji-mart'), loadEmojiData()]).then(([module, data]) => {
      if (cancelled || !host.current) return;
      const Picker = module.Picker as unknown as PickerConstructor;
      picker = new Picker({
        data,
        theme: theme === 'system' ? 'auto' : theme,
        onEmojiSelect: (emoji: { native: string }) => select.current(emoji.native),
        previewPosition: 'none',
        skinTonePosition: 'search',
        maxFrequentRows: 2,
        autoFocus: true,
      });
      host.current.replaceChildren(picker);
      setReady(true);
    });
    return () => {
      cancelled = true;
      picker?.remove();
    };
  }, [theme]);

  useEffect(() => {
    function onPointerDown(e: MouseEvent) {
      const target = e.target as Node;
      // Clicks inside the picker's shadow root arrive retargeted to its host.
      if (host.current?.contains(target) || anchor.contains(target)) return;
      close.current();
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      close.current();
    }
    function onResize() {
      setPosition(placeNear(anchor));
    }
    window.addEventListener('mousedown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('mousedown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('resize', onResize);
    };
  }, [anchor]);

  return createPortal(
    <div
      className="fixed z-[60] overflow-hidden rounded-xl shadow-2xl"
      style={{ left: position.left, top: position.top }}
    >
      {!ready && (
        <div
          className="grid place-items-center rounded-xl border border-[var(--color-line)] bg-[var(--color-raised)] text-xs text-[var(--color-muted)]"
          style={{ width: WIDTH, height: HEIGHT }}
        >
          Loading emoji…
        </div>
      )}
      <div ref={host} />
    </div>,
    document.body,
  );
}
