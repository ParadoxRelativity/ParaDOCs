import { useEffect, useRef, useState } from 'react';
import { attachmentKind, type WorkItem, type WorkItemAttachment } from '@paradocs/shared';
import { useWorkItemAttachments, useWorkItemAttaching } from '../../api/hooks';
import { cx, formatBytes, formatRelative } from '../../lib/util';
import { fileIcon } from '../chat/MessageAttachments';
import { MediaViewer, type ViewerItem } from '../chat/MediaViewer';
import Icon from '../Icon';
import { ConfirmDialog } from '../Modal';
import { useToast } from '../Toast';

/** How much of a text file is shown in place; the rest is a download away. */
const PREVIEW_BYTES = 64 * 1024;

const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'log', 'csv', 'tsv', 'json', 'xml', 'yml', 'yaml', 'ini', 'toml', 'conf', 'cfg',
  'env', 'sql', 'sh', 'js', 'jsx', 'ts', 'tsx', 'py', 'rb', 'go', 'rs', 'java', 'c', 'h', 'cpp', 'cs', 'css',
  'html', 'diff', 'patch',
]);

/** A phone or tablet: nothing hovers, and nothing is dropped. */
const TOUCH = typeof window !== 'undefined' && window.matchMedia?.('(hover: none)').matches;

/** Whether a file can be read as plain text in place. */
function isText(attachment: WorkItemAttachment): boolean {
  if (attachment.mimeType.startsWith('text/')) return true;
  const extension = /\.([a-z0-9]+)$/i.exec(attachment.filename)?.[1]?.toLowerCase() ?? '';
  return TEXT_EXTENSIONS.has(extension);
}

interface Pending {
  key: number;
  name: string;
  progress: number;
}

/**
 * The files on a work item. Pictures and videos show as tiles that open
 * full-window; text files can be read in place; anything else downloads.
 * Files are added with the button or by dropping them on the section.
 */
export default function WorkItemAttachments({ item, canEdit }: { item: WorkItem; canEdit: boolean }) {
  const attachments = useWorkItemAttachments(item.id);
  const { attach, detach } = useWorkItemAttaching(item.id);
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const nextKey = useRef(0);
  const [pending, setPending] = useState<Pending[]>([]);
  const [dragging, setDragging] = useState(false);
  const [viewer, setViewer] = useState<{ items: ViewerItem[]; index: number } | null>(null);
  const [removing, setRemoving] = useState<WorkItemAttachment | null>(null);

  const all = attachments.data ?? [];
  const visual = all.filter((a) => {
    const kind = attachmentKind(a.url);
    return kind === 'image' || kind === 'video';
  });
  const others = all.filter((a) => !visual.includes(a));
  const viewerItems: ViewerItem[] = visual.map((a) => ({
    url: a.url,
    filename: a.filename,
    kind: attachmentKind(a.url) as ViewerItem['kind'],
  }));

  function upload(files: File[]) {
    for (const file of files) {
      const key = nextKey.current++;
      setPending((current) => [...current, { key, name: file.name, progress: 0 }]);
      attach.mutate(
        {
          file,
          onProgress: (progress) =>
            setPending((current) => current.map((p) => (p.key === key ? { ...p, progress } : p))),
        },
        {
          onError: (err) => toast(err instanceof Error ? err.message : `Could not attach ${file.name}`, 'error'),
          onSettled: () => setPending((current) => current.filter((p) => p.key !== key)),
        },
      );
    }
  }

  if (all.length === 0 && pending.length === 0 && !canEdit) return null;

  return (
    <section
      onDragOver={(e) => {
        if (!canEdit || !e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={(e) => {
        if (!canEdit) return;
        const files = [...e.dataTransfer.files];
        setDragging(false);
        if (files.length === 0) return;
        e.preventDefault();
        upload(files);
      }}
      className={cx(
        '-mx-2 mt-6 rounded-lg px-2 pb-1',
        dragging && 'outline-dashed outline-2 outline-[var(--color-accent)] bg-[var(--color-accent)]/5',
      )}
    >
      <div className="flex items-center">
        <h3 className="flex flex-1 items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-[var(--color-muted)]">
          Attachments
          {all.length > 0 && <span className="font-normal normal-case">{all.length}</span>}
        </h3>
        {canEdit && (
          <button
            onClick={() => input.current?.click()}
            className="flex items-center gap-1 text-xs text-[var(--color-muted)] hover:text-[var(--color-ink)]"
          >
            <Icon name="paperclip" /> Attach file
          </button>
        )}
        <input
          ref={input}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            upload([...(e.target.files ?? [])]);
            e.target.value = '';
          }}
        />
      </div>

      {all.length === 0 && pending.length === 0 && canEdit && (
        <button
          onClick={() => input.current?.click()}
          className="mt-1.5 flex w-full items-center justify-center gap-2 rounded-md border border-dashed border-[var(--color-line)] px-3 py-3 text-xs text-[var(--color-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
        >
          <Icon name="cloud-arrow-up" />
          {TOUCH ? 'Add photos, videos or files' : 'Drop screenshots, videos or text files here, or choose them'}
        </button>
      )}

      {visual.length > 0 && (
        <div className="mt-1.5 grid grid-cols-2 gap-2 sm:grid-cols-3">
          {visual.map((attachment, index) => (
            <Tile
              key={attachment.id}
              attachment={attachment}
              canEdit={canEdit}
              onOpen={() => setViewer({ items: viewerItems, index })}
              onRemove={() => setRemoving(attachment)}
            />
          ))}
        </div>
      )}

      {others.length > 0 && (
        <ul className="mt-1.5 space-y-1.5">
          {others.map((attachment) => (
            <FileRow
              key={attachment.id}
              attachment={attachment}
              canEdit={canEdit}
              onRemove={() => setRemoving(attachment)}
            />
          ))}
        </ul>
      )}

      {pending.length > 0 && (
        <ul className="mt-1.5 space-y-1">
          {pending.map((p) => (
            <li key={p.key} className="flex items-center gap-2 text-xs text-[var(--color-muted)]">
              <Icon name={fileIcon(p.name)} />
              <span className="min-w-0 flex-1 truncate">{p.name}</span>
              <span className="h-1 w-24 shrink-0 overflow-hidden rounded-full bg-[var(--color-line)]">
                <span
                  className="block h-full bg-[var(--color-accent)] transition-[width]"
                  style={{ width: `${Math.round(p.progress * 100)}%` }}
                />
              </span>
            </li>
          ))}
        </ul>
      )}

      {viewer && (
        <MediaViewer
          items={viewer.items}
          index={viewer.index}
          onStep={(delta) =>
            setViewer((current) =>
              current
                ? { ...current, index: (current.index + delta + current.items.length) % current.items.length }
                : current,
            )
          }
          onClose={() => setViewer(null)}
        />
      )}

      {removing && (
        <ConfirmDialog
          title={`Remove ${removing.filename}?`}
          description="The file will be deleted for everyone. This cannot be undone."
          confirmLabel="Remove"
          onCancel={() => setRemoving(null)}
          onConfirm={() => {
            const target = removing;
            setRemoving(null);
            detach.mutate(target.id, {
              onError: (err) => toast(err instanceof Error ? err.message : 'Could not remove the file', 'error'),
            });
          }}
        />
      )}
    </section>
  );
}

/** A picture or video as a tile; the first frame of a video stands in for it. */
function Tile({
  attachment,
  canEdit,
  onOpen,
  onRemove,
}: {
  attachment: WorkItemAttachment;
  canEdit: boolean;
  onOpen: () => void;
  onRemove: () => void;
}) {
  const [broken, setBroken] = useState(false);
  const video = attachmentKind(attachment.url) === 'video';

  return (
    <div className="group relative aspect-video overflow-hidden rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)]">
      <button
        type="button"
        onClick={onOpen}
        title={attachment.filename}
        aria-label={`Open ${attachment.filename}`}
        className="block h-full w-full cursor-zoom-in"
      >
        {broken ? (
          // A format this browser cannot show is still named, and opens to download.
          <span className="grid h-full w-full place-items-center p-2 text-center text-xs text-[var(--color-muted)]">
            <Icon name={fileIcon(attachment.filename)} className="text-2xl" />
            <span className="w-full truncate">{attachment.filename}</span>
          </span>
        ) : video ? (
          <>
            <video
              // A moment in, so iOS draws the frame; it shows black for a bare metadata load.
              src={`${attachment.url}#t=0.1`}
              preload="metadata"
              muted
              playsInline
              className="h-full w-full object-cover"
              onError={() => setBroken(true)}
            />
            <span className="absolute inset-0 grid place-items-center">
              <span className="grid h-9 w-9 place-items-center rounded-full bg-black/60 text-lg text-white">
                <Icon name="play-fill" />
              </span>
            </span>
          </>
        ) : (
          <img
            src={attachment.url}
            alt={attachment.filename}
            loading="lazy"
            className="h-full w-full object-cover"
            onError={() => setBroken(true)}
          />
        )}
      </button>
      <div className="pointer-events-none absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-black/70 to-transparent px-2 pb-1 pt-4 text-[11px] text-white opacity-0 group-hover:opacity-100">
        {attachment.filename}
      </div>
      <div className="absolute right-1 top-1 hidden gap-1 group-focus-within:flex group-hover:flex [@media(hover:none)]:flex">
        <a
          href={attachment.url}
          download={attachment.filename}
          title="Download"
          aria-label={`Download ${attachment.filename}`}
          className="grid h-7 w-7 place-items-center rounded bg-black/60 text-xs text-white hover:bg-black/80"
        >
          <Icon name="download" />
        </a>
        {canEdit && (
          <button
            onClick={onRemove}
            title="Remove"
            aria-label={`Remove ${attachment.filename}`}
            className="grid h-7 w-7 place-items-center rounded bg-black/60 text-xs text-white hover:bg-black/80"
          >
            <Icon name="x-lg" />
          </button>
        )}
      </div>
    </div>
  );
}

/** A text, audio or other file: its name and size, with a preview for text and a player for audio. */
function FileRow({
  attachment,
  canEdit,
  onRemove,
}: {
  attachment: WorkItemAttachment;
  canEdit: boolean;
  onRemove: () => void;
}) {
  const [previewing, setPreviewing] = useState(false);
  const text = isText(attachment);
  const audio = attachmentKind(attachment.url) === 'audio';
  // PDFs open in a new tab; everything else downloads.
  const opens = /\.pdf$/i.test(attachment.url);

  return (
    <li className="group rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2">
      <div className="flex items-center gap-2.5">
        <Icon name={fileIcon(attachment.filename)} className="shrink-0 text-xl text-[var(--color-muted)]" />
        <div className="min-w-0 flex-1">
          <a
            href={attachment.url}
            {...(opens ? { target: '_blank', rel: 'noopener noreferrer' } : { download: attachment.filename })}
            className="block truncate text-sm font-medium text-[var(--color-accent)] hover:underline"
          >
            {attachment.filename}
          </a>
          <div className="truncate text-xs text-[var(--color-muted)]">
            {formatBytes(attachment.byteSize)}
            {attachment.uploader && ` · ${attachment.uploader.name}`} · {formatRelative(attachment.createdAt)}
          </div>
        </div>
        {text && (
          <button
            onClick={() => setPreviewing((v) => !v)}
            className="shrink-0 rounded px-1.5 py-0.5 text-xs text-[var(--color-muted)] hover:bg-[var(--color-line)] hover:text-[var(--color-ink)]"
            aria-expanded={previewing}
          >
            {previewing ? 'Hide' : 'Preview'}
          </button>
        )}
        <a
          href={attachment.url}
          download={attachment.filename}
          title="Download"
          aria-label={`Download ${attachment.filename}`}
          className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-[var(--color-muted)] hover:bg-[var(--color-line)] hover:text-[var(--color-ink)]"
        >
          <Icon name="download" />
        </a>
        {canEdit && (
          <button
            onClick={onRemove}
            title="Remove"
            aria-label={`Remove ${attachment.filename}`}
            className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-xs text-[var(--color-muted)] opacity-0 hover:bg-[var(--color-line)] hover:text-[var(--color-ink)] focus:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100"
          >
            <Icon name="x-lg" />
          </button>
        )}
      </div>
      {audio && <audio controls preload="metadata" src={attachment.url} className="mt-2 h-9 w-full" />}
      {previewing && <TextPreview url={attachment.url} truncated={attachment.byteSize > PREVIEW_BYTES} />}
    </li>
  );
}

/** The start of a text file, read as text: never rendered, so nothing in it can run. */
function TextPreview({ url, truncated }: { url: string; truncated: boolean }) {
  const [state, setState] = useState<{ text: string } | { error: true } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch(url, { credentials: 'include', signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));
        const blob = await res.blob();
        setState({ text: await blob.slice(0, PREVIEW_BYTES).text() });
      })
      .catch((err) => {
        if ((err as Error).name !== 'AbortError') setState({ error: true });
      });
    return () => controller.abort();
  }, [url]);

  if (!state) return <p className="mt-2 text-xs text-[var(--color-muted)]">Loading…</p>;
  if ('error' in state) return <p className="mt-2 text-xs text-[var(--color-muted)]">Could not load a preview. Download the file to read it.</p>;
  return (
    <>
      <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md border border-[var(--color-line)] bg-[var(--color-canvas)] p-2 font-mono text-xs leading-relaxed">
        {state.text}
      </pre>
      {truncated && <p className="mt-1 text-xs text-[var(--color-muted)]">Only the start of the file is shown. Download it to read the rest.</p>}
    </>
  );
}
