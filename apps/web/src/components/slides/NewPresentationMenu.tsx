import { useRef, useState } from 'react';
import { STARTER_THEMES } from '@paradocs/shared';
import Icon from '../Icon';
import { Popover } from '../Popover';
import { IconButton } from '../ui';
import { ThemeSwatch } from './SlideDesignDialog';

/**
 * The "New presentation" button: a menu of starter themes (and an empty
 * deck), so a new presentation can begin already looking like something.
 */
export default function NewPresentationMenu({ onCreate, disabled }: { onCreate: (themeId: string | undefined) => void; disabled?: boolean }) {
  const anchor = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const choose = (themeId: string | undefined) => {
    setOpen(false);
    onCreate(themeId);
  };
  return (
    <span ref={anchor} className="inline-flex">
      <IconButton label="New presentation" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)} disabled={disabled}>
        <Icon name="plus-lg" />
      </IconButton>
      {open && anchor.current && (
        <Popover anchor={anchor.current} placement="below" onClose={() => setOpen(false)} className="w-72 max-w-[calc(100vw-1rem)] p-2">
          <div role="menu" aria-label="New presentation" className="space-y-2">
            <button
              type="button"
              role="menuitem"
              onClick={() => choose(undefined)}
              className="flex w-full items-center gap-2 rounded-md px-2 py-2.5 text-left text-sm hover:bg-[var(--color-surface)]"
            >
              <Icon name="file-earmark" /> Empty presentation
            </button>
            <p className="px-2 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">Start from a theme</p>
            <div className="grid grid-cols-2 gap-2">
              {STARTER_THEMES.map((starter) => (
                <button
                  key={starter.theme.id}
                  type="button"
                  role="menuitem"
                  onClick={() => choose(starter.theme.id)}
                  className="overflow-hidden rounded-md border border-[var(--color-line)] text-left hover:border-[var(--color-accent)]"
                >
                  <ThemeSwatch starter={starter} />
                  <span className="block px-2 py-1 text-xs font-medium">{starter.theme.name}</span>
                </button>
              ))}
            </div>
          </div>
        </Popover>
      )}
    </span>
  );
}
