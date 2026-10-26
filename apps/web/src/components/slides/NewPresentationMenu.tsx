import { useRef, useState } from 'react';
import { STARTER_THEMES } from '@paradocs/shared';
import { usePresentationTemplates } from '../../api/hooks';
import Icon from '../Icon';
import { Popover } from '../Popover';
import { IconButton } from '../ui';
import { ImportTemplateDialog, ManageTemplatesDialog, TemplateGrid } from './PresentationTemplates';
import { ThemeSwatch } from './SlideDesignDialog';

/** What a new presentation starts from: nothing, a starter theme, or one of the workspace's saved templates. */
export type NewPresentationStart = { themeId?: string; templateId?: string };

const MENU_ITEM = 'flex min-h-10 w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-[var(--color-surface)]';

/**
 * The "New presentation" button: a menu of starter themes and the
 * workspace's saved templates (and an empty deck), so a new presentation can
 * begin already looking like something. Templates are imported and managed
 * from here too.
 */
export default function NewPresentationMenu({
  workspaceId,
  onCreate,
  disabled,
}: {
  workspaceId: string;
  onCreate: (start: NewPresentationStart) => void;
  disabled?: boolean;
}) {
  const anchor = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState<'import' | 'manage' | null>(null);
  const hasTemplates = (usePresentationTemplates(workspaceId).data ?? []).length > 0;
  const choose = (start: NewPresentationStart) => {
    setOpen(false);
    onCreate(start);
  };
  const openDialog = (which: 'import' | 'manage') => {
    setOpen(false);
    setDialog(which);
  };
  return (
    <span ref={anchor} className="inline-flex">
      <IconButton label="New presentation" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)} disabled={disabled}>
        <Icon name="plus-lg" />
      </IconButton>
      {open && anchor.current && (
        <Popover anchor={anchor.current} placement="below" onClose={() => setOpen(false)} className="scroll-thin max-h-[80vh] w-72 max-w-[calc(100vw-1rem)] overflow-y-auto p-2">
          <div role="menu" aria-label="New presentation" className="space-y-2">
            <button type="button" role="menuitem" onClick={() => choose({})} className={MENU_ITEM}>
              <Icon name="file-earmark" /> Empty presentation
            </button>
            <p className="px-2 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">Start from a theme</p>
            <div className="grid grid-cols-2 gap-2">
              {STARTER_THEMES.map((starter) => (
                <button
                  key={starter.theme.id}
                  type="button"
                  role="menuitem"
                  onClick={() => choose({ themeId: starter.theme.id })}
                  className="overflow-hidden rounded-md border border-[var(--color-line)] text-left hover:border-[var(--color-accent)]"
                >
                  <ThemeSwatch starter={starter} />
                  <span className="block px-2 py-1 text-xs font-medium">{starter.theme.name}</span>
                </button>
              ))}
            </div>
            {hasTemplates && <p className="px-2 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">Start from a template</p>}
            <TemplateGrid workspaceId={workspaceId} role="menuitem" onPick={(template) => choose({ templateId: template.id })} />
            <div className="border-t border-[var(--color-line)] pt-1">
              <button type="button" role="menuitem" onClick={() => openDialog('import')} className={MENU_ITEM}>
                <Icon name="box-arrow-in-down" /> Import a template…
              </button>
              {hasTemplates && (
                <button type="button" role="menuitem" onClick={() => openDialog('manage')} className={MENU_ITEM}>
                  <Icon name="collection" /> Manage templates…
                </button>
              )}
            </div>
          </div>
        </Popover>
      )}
      {dialog === 'import' && <ImportTemplateDialog workspaceId={workspaceId} onClose={() => setDialog(null)} />}
      {dialog === 'manage' && <ManageTemplatesDialog workspaceId={workspaceId} onClose={() => setDialog(null)} />}
    </span>
  );
}
