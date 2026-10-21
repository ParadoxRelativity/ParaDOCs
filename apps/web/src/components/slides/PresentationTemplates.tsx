import { useLayoutEffect, useRef, useState } from 'react';
import { fontStack, resolveSlideColor, type PresentationTemplateSummary, type TemplatePreview as Preview } from '@paradocs/shared';
import { usePresentationTemplateActions, usePresentationTemplates, useUploadFile, useWorkspaces } from '../../api/hooks';
import { useIsMobile } from '../../lib/mobile';
import { canFrom } from '../../lib/permissions';
import { importTemplateFile } from '../../lib/slideTemplates';
import { TEMPLATE_IMPORT_ACCEPT, describeReportItem, templateNameOf, type ImportReport } from '../../lib/slideImportTypes';
import { cx } from '../../lib/util';
import Icon from '../Icon';
import { ConfirmDialog, Modal } from '../Modal';
import { FIELD } from '../SettingsParts';
import { useToast } from '../Toast';
import { Button, IconButton, Spinner } from '../ui';
import SlideView from './SlideView';

/**
 * Presentation templates (PARA-110) in the Slides UI: a template's thumbnail,
 * the grid of a workspace's templates that New presentation and the Design
 * window pick from, and the windows to save a deck as one, import one from a
 * PowerPoint file, and rename or delete them.
 */

/** A template's Title slide, drawn at the width of whatever holds it, with sample text where the title and subtitle go. */
export function TemplatePreview({ preview, className }: { preview: Preview | null; className?: string }) {
  const box = useRef<HTMLSpanElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setWidth(el.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const size = preview?.size ?? { width: 16, height: 9 };
  return (
    <span ref={box} className={cx('relative block w-full overflow-hidden bg-[var(--color-canvas)]', className)} style={{ aspectRatio: `${size.width} / ${size.height}` }} aria-hidden>
      {preview && width > 0 && (
        <>
          <SlideView slide={preview.slide} size={preview.size} theme={preview.theme} width={width} />
          <span className="absolute left-0 top-0 origin-top-left" style={{ width: size.width, height: size.height, transform: `scale(${width / size.width})` }}>
            {preview.samples.map((sample) => (
              <span
                key={sample.text}
                className="absolute flex overflow-hidden"
                style={{
                  left: sample.x,
                  top: sample.y,
                  width: sample.width,
                  height: sample.height,
                  alignItems: sample.style.verticalAlign === 'bottom' ? 'flex-end' : sample.style.verticalAlign === 'middle' ? 'center' : 'flex-start',
                  justifyContent: sample.style.align === 'right' ? 'flex-end' : sample.style.align === 'center' ? 'center' : 'flex-start',
                  padding: '12px',
                  fontFamily: fontStack(sample.style.fontFamily ?? preview.theme.fonts.body),
                  fontSize: sample.style.fontSize ?? 32,
                  fontWeight: sample.style.bold ? 700 : 400,
                  fontStyle: sample.style.italic ? 'italic' : 'normal',
                  color: resolveSlideColor(sample.style.color ?? 'theme:text1', preview.theme),
                  lineHeight: 1.1,
                }}
              >
                {sample.text}
              </span>
            ))}
          </span>
        </>
      )}
    </span>
  );
}

/** The workspace's templates as cards to pick one from; nothing at all while there are none. */
export function TemplateGrid({
  workspaceId,
  selectedId,
  disabled,
  role,
  onPick,
  className,
}: {
  workspaceId: string;
  selectedId?: string | null;
  disabled?: boolean;
  /** `menuitem` inside the New presentation menu. */
  role?: 'menuitem';
  onPick: (template: PresentationTemplateSummary) => void;
  className?: string;
}) {
  const templates = usePresentationTemplates(workspaceId).data ?? [];
  if (templates.length === 0) return null;
  return (
    <div className={cx('grid grid-cols-2 gap-2', className)}>
      {templates.map((template) => (
        <button
          key={template.id}
          type="button"
          role={role}
          disabled={disabled}
          aria-pressed={role ? undefined : selectedId === template.id}
          title={template.description || template.name}
          onClick={() => onPick(template)}
          className={cx(
            'overflow-hidden rounded-md border text-left hover:border-[var(--color-accent)] disabled:opacity-60',
            selectedId === template.id ? 'border-[var(--color-accent)] ring-1 ring-[var(--color-accent)]' : 'border-[var(--color-line)]',
          )}
        >
          <TemplatePreview preview={template.preview} />
          <span className="block truncate px-2 py-1.5 text-xs font-medium">{template.name}</span>
        </button>
      ))}
    </div>
  );
}

function NameFields({
  name,
  description,
  onName,
  onDescription,
  onSubmit,
}: {
  name: string;
  description: string;
  onName: (value: string) => void;
  onDescription: (value: string) => void;
  onSubmit: () => void;
}) {
  return (
    <div className="space-y-3">
      <label className="block text-xs text-[var(--color-muted)]">
        Name
        <input autoFocus value={name} maxLength={100} onChange={(e) => onName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && onSubmit()} className={cx(FIELD, 'mt-1')} />
      </label>
      <label className="block text-xs text-[var(--color-muted)]">
        Description
        <textarea
          value={description}
          maxLength={500}
          rows={2}
          onChange={(e) => onDescription(e.target.value)}
          placeholder="What it suits"
          className={cx(FIELD, 'mt-1 resize-y')}
        />
      </label>
    </div>
  );
}

/** Saves a deck's look (theme, master and layouts, not its slides) as a template for the workspace. */
export function SaveTemplateDialog({
  workspaceId,
  presentationId,
  defaultName,
  onClose,
}: {
  workspaceId: string;
  presentationId: string;
  defaultName: string;
  onClose: () => void;
}) {
  const actions = usePresentationTemplateActions(workspaceId);
  const toast = useToast();
  const mobile = useIsMobile();
  const [name, setName] = useState(defaultName.slice(0, 100));
  const [description, setDescription] = useState('');
  const submit = () => {
    if (!name.trim() || actions.save.isPending) return;
    actions.save.mutate(
      { presentationId, name: name.trim(), description: description.trim() },
      {
        onSuccess: (template) => {
          onClose();
          toast(`Saved ${template.name}. Anyone in the workspace can start a presentation from it.`);
        },
        onError: (err) => toast(err instanceof Error ? err.message : 'Could not save the template', 'error'),
      },
    );
  };
  return (
    <Modal
      title="Save as template"
      description="Keeps this presentation's theme, master and layouts for anyone in the workspace to start from. Its slides are not saved."
      onClose={onClose}
      fullScreen={mobile}
      footer={
        <>
          <Button variant="subtle" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!name.trim() || actions.save.isPending} onClick={submit}>
            {actions.save.isPending ? 'Saving…' : 'Save template'}
          </Button>
        </>
      }
    >
      <NameFields name={name} description={description} onName={setName} onDescription={setDescription} onSubmit={submit} />
    </Modal>
  );
}

/**
 * Imports a template from a PowerPoint template (.potx), presentation (.pptx)
 * or theme (.thmx): its look, not its slides. What could not be brought in is
 * listed once it is saved.
 */
export function ImportTemplateDialog({ workspaceId, onClose }: { workspaceId: string; onClose: () => void }) {
  const upload = useUploadFile(workspaceId);
  const actions = usePresentationTemplateActions(workspaceId);
  const toast = useToast();
  const mobile = useIsMobile();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [done, setDone] = useState<{ name: string; report: ImportReport } | null>(null);

  const choose = (picked: File | undefined) => {
    if (!picked) return;
    setFile(picked);
    if (!name.trim() || name === templateNameOf(file?.name ?? '')) setName(templateNameOf(picked.name));
  };

  const submit = async () => {
    if (!file || !name.trim() || status) return;
    setStatus(`Opening ${file.name}…`);
    try {
      const result = await importTemplateFile(
        workspaceId,
        file,
        { name: name.trim(), description: description.trim() },
        (picture, templateId) => upload.mutateAsync({ file: picture, templateId }),
        (progress) => setStatus(progress.message),
      );
      actions.imported();
      if (result.report.items.length === 0) {
        onClose();
        toast(`Imported ${result.template.name}. Anyone in the workspace can start a presentation from it.`);
      } else {
        setDone({ name: result.template.name, report: result.report });
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not import that template', 'error');
    } finally {
      setStatus(null);
    }
  };

  if (done) {
    return (
      <Modal
        title={`Imported ${done.name}`}
        description="Some of it could not be brought in exactly:"
        onClose={onClose}
        fullScreen={mobile}
        footer={
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        }
      >
        <ul className={cx('scroll-thin list-disc space-y-1 overflow-y-auto pl-5 text-sm', mobile ? 'min-h-0 flex-1' : 'max-h-64')}>
          {done.report.items.map((item) => (
            <li key={`${item.kind}:${item.feature}`}>{describeReportItem(item)}</li>
          ))}
        </ul>
      </Modal>
    );
  }

  return (
    <Modal
      title="Import a template"
      description="Brings in a PowerPoint template's theme, master and layouts for anyone in the workspace to start from. Its slides are left out."
      onClose={() => !status && onClose()}
      fullScreen={mobile}
      footer={
        <>
          <Button variant="subtle" disabled={status !== null} onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!file || !name.trim() || status !== null} onClick={() => void submit()}>
            {status ? 'Importing…' : 'Import'}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <input
          ref={input}
          type="file"
          accept={TEMPLATE_IMPORT_ACCEPT}
          className="hidden"
          onChange={(e) => {
            choose(e.target.files?.[0]);
            e.target.value = '';
          }}
        />
        <Button variant="subtle" className="min-h-11 w-full justify-center" disabled={status !== null} onClick={() => input.current?.click()}>
          <Icon name="box-arrow-in-down" /> {file ? file.name : 'Choose a .potx, .pptx or .thmx file'}
        </Button>
        {file && <NameFields name={name} description={description} onName={setName} onDescription={setDescription} onSubmit={() => void submit()} />}
        {status && (
          <p role="status" aria-live="polite" className="flex items-center gap-2 text-xs text-[var(--color-muted)]">
            <span aria-hidden className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-[var(--color-line)] border-t-[var(--color-accent)]" /> {status}
          </p>
        )}
      </div>
    </Modal>
  );
}

/** Renames a template and changes what it says it suits. */
function RenameTemplateDialog({ workspaceId, template, onClose }: { workspaceId: string; template: PresentationTemplateSummary; onClose: () => void }) {
  const actions = usePresentationTemplateActions(workspaceId);
  const toast = useToast();
  const mobile = useIsMobile();
  const [name, setName] = useState(template.name);
  const [description, setDescription] = useState(template.description);
  const submit = () => {
    if (!name.trim() || actions.update.isPending) return;
    actions.update.mutate(
      { id: template.id, name: name.trim(), description: description.trim() },
      { onSuccess: onClose, onError: (err) => toast(err instanceof Error ? err.message : 'Could not rename the template', 'error') },
    );
  };
  return (
    <Modal
      title="Rename template"
      onClose={onClose}
      fullScreen={mobile}
      footer={
        <>
          <Button variant="subtle" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!name.trim() || actions.update.isPending} onClick={submit}>
            Save
          </Button>
        </>
      }
    >
      <NameFields name={name} description={description} onName={setName} onDescription={setDescription} onSubmit={submit} />
    </Modal>
  );
}

/**
 * The workspace's templates, to import more and to rename or delete those
 * this person may. Presentations already made from one are not touched.
 */
export function ManageTemplatesDialog({ workspaceId, onClose }: { workspaceId: string; onClose: () => void }) {
  const query = usePresentationTemplates(workspaceId);
  const workspaces = useWorkspaces();
  const canCreate = canFrom(workspaces.data?.find((w) => w.id === workspaceId)?.permissions)('slides.create');
  const actions = usePresentationTemplateActions(workspaceId);
  const toast = useToast();
  const mobile = useIsMobile();
  const [importing, setImporting] = useState(false);
  const [renaming, setRenaming] = useState<PresentationTemplateSummary | null>(null);
  const [removing, setRemoving] = useState<PresentationTemplateSummary | null>(null);
  const templates = query.data ?? [];

  // One window at a time, so Escape and the back button close the one on top.
  if (importing) return <ImportTemplateDialog workspaceId={workspaceId} onClose={() => setImporting(false)} />;
  if (renaming) return <RenameTemplateDialog workspaceId={workspaceId} template={renaming} onClose={() => setRenaming(null)} />;
  if (removing) {
    return (
      <ConfirmDialog
        title={`Delete ${removing.name}?`}
        description="Presentations already started from it keep their look."
        onConfirm={() => {
          actions.remove.mutate(removing.id, {
            onSuccess: () => toast(`Deleted ${removing.name}`),
            onError: (err) => toast(err instanceof Error ? err.message : 'Could not delete the template', 'error'),
          });
          setRemoving(null);
        }}
        onCancel={() => setRemoving(null)}
      />
    );
  }

  return (
    <Modal
      title="Presentation templates"
      description="Everyone in the workspace can start a presentation from these, or put one's look on a presentation in Design."
      onClose={onClose}
      wide
      fullScreen={mobile}
      footer={
        <>
          {canCreate && (
            <Button variant="subtle" onClick={() => setImporting(true)}>
              <Icon name="box-arrow-in-down" /> Import a template…
            </Button>
          )}
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        </>
      }
    >
      <div className={cx('scroll-thin overflow-y-auto', mobile ? 'min-h-0 flex-1' : 'max-h-[60vh]')}>
        {query.isLoading ? (
          <Spinner />
        ) : templates.length === 0 ? (
          <p className="py-6 text-center text-sm text-[var(--color-muted)]">
            No templates yet. Import one from PowerPoint, or save a presentation&apos;s look with Save as template.
          </p>
        ) : (
          <ul className="divide-y divide-[var(--color-line)] rounded-xl border border-[var(--color-line)]">
            {templates.map((t) => (
              <li key={t.id} className="flex items-center gap-3 px-3 py-2">
                <TemplatePreview preview={t.preview} className="!w-24 shrink-0 rounded-sm border border-[var(--color-line)]" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{t.name}</span>
                  {t.description && <span className="block truncate text-xs text-[var(--color-muted)]">{t.description}</span>}
                  {t.createdByName && <span className="block truncate text-[11px] text-[var(--color-muted)]">Saved by {t.createdByName}</span>}
                </span>
                {t.canManage && (
                  <>
                    <IconButton label={`Rename ${t.name}`} onClick={() => setRenaming(t)}>
                      <Icon name="pencil" />
                    </IconButton>
                    <IconButton label={`Delete ${t.name}`} onClick={() => setRemoving(t)}>
                      <Icon name="trash3" />
                    </IconButton>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}
