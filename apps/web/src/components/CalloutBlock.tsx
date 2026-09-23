import { useEffect, useRef, useState } from 'react';
import { CALLOUT_VARIANTS, type CalloutVariant } from '@paradocs/shared';
import Icon, { type IconName } from './Icon';
import { cx } from '../lib/util';

export const CALLOUT_STYLES: Record<CalloutVariant, { label: string; icon: IconName; box: string; tint: string }> = {
  note: {
    label: 'Note',
    icon: 'info-circle',
    box: 'border-sky-500 bg-sky-50 dark:bg-sky-950/40',
    tint: 'text-sky-600 dark:text-sky-400',
  },
  tip: {
    label: 'Tip',
    icon: 'lightbulb',
    box: 'border-emerald-500 bg-emerald-50 dark:bg-emerald-950/40',
    tint: 'text-emerald-600 dark:text-emerald-400',
  },
  important: {
    label: 'Important',
    icon: 'exclamation-square',
    box: 'border-violet-500 bg-violet-50 dark:bg-violet-950/40',
    tint: 'text-violet-600 dark:text-violet-400',
  },
  warning: {
    label: 'Warning',
    icon: 'exclamation-triangle',
    box: 'border-amber-500 bg-amber-50 dark:bg-amber-950/40',
    tint: 'text-amber-600 dark:text-amber-400',
  },
  caution: {
    label: 'Caution',
    icon: 'exclamation-octagon',
    box: 'border-red-500 bg-red-50 dark:bg-red-950/40',
    tint: 'text-red-600 dark:text-red-400',
  },
};

/**
 * A callout as the editor draws it: its kind's icon, then its text. Anyone who
 * can edit changes the kind from the icon.
 */
export function CalloutView({
  variant,
  editable,
  onVariant,
  contentRef,
}: {
  variant: CalloutVariant;
  editable: boolean;
  onVariant: (variant: CalloutVariant) => void;
  contentRef: (node: HTMLElement | null) => void;
}) {
  const style = CALLOUT_STYLES[variant] ?? CALLOUT_STYLES.note;
  const [open, setOpen] = useState(false);
  const menu = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className={cx('flex w-full gap-2.5 rounded-md border-l-4 px-3 py-2', style.box)}>
      <div ref={menu} contentEditable={false} className="relative shrink-0 select-none">
        <button
          type="button"
          disabled={!editable}
          aria-label={editable ? `${style.label} callout — change kind` : `${style.label} callout`}
          onClick={() => setOpen((value) => !value)}
          className={cx('grid h-6 w-6 place-items-center rounded', style.tint, editable && 'hover:bg-black/5 dark:hover:bg-white/10')}
        >
          <Icon name={style.icon} />
        </button>
        {open && (
          <div
            role="menu"
            className="absolute left-0 top-7 z-50 min-w-36 overflow-hidden rounded-lg border border-[var(--color-line)] bg-[var(--color-raised)] py-1 text-xs shadow-xl"
          >
            {CALLOUT_VARIANTS.map((option) => (
              <button
                key={option}
                type="button"
                role="menuitemradio"
                aria-checked={option === variant}
                onClick={() => {
                  setOpen(false);
                  if (option !== variant) onVariant(option);
                }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[var(--color-ink)] hover:bg-[var(--color-surface)]"
              >
                <Icon name={CALLOUT_STYLES[option].icon} className={CALLOUT_STYLES[option].tint} />
                <span className="flex-1">{CALLOUT_STYLES[option].label}</span>
                {option === variant && <Icon name="check" className="text-[var(--color-muted)]" />}
              </button>
            ))}
          </div>
        )}
      </div>
      <div ref={contentRef} className="min-w-0 flex-1 leading-6" />
    </div>
  );
}
