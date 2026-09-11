import { useState } from 'react';
import { attachmentKind, type MessageAttachment } from '@paradocs/shared';
import { cx, formatBytes } from '../../lib/util';
import Icon, { type IconName } from '../Icon';
import type { ViewerItem } from './MediaViewer';

/** Largest box a lone picture or video is shown in, before it is opened. */
const MAX_WIDTH = 400;
const MAX_HEIGHT = 300;

/**
 * The files in a message. Pictures and videos are shown in place and open
 * full-window; audio gets a player; anything else is a card to download.
 */
export function MessageAttachments({
  attachments,
  onOpen,
  onLoad,
  className,
}: {
  attachments: MessageAttachment[];
  onOpen: (items: ViewerItem[], index: number) => void;
  /** A picture or video finished loading and may have changed the message's height. */
  onLoad: () => void;
  className?: string;
}) {
  const visual = attachments.filter((a) => {
    const kind = attachmentKind(a.url);
    return kind === 'image' || kind === 'video';
  });
  const audio = attachments.filter((a) => attachmentKind(a.url) === 'audio');
  const files = attachments.filter((a) => attachmentKind(a.url) === 'file');

  const items: ViewerItem[] = visual.map((a) => ({
    url: a.url,
    filename: a.filename,
    kind: attachmentKind(a.url) as ViewerItem['kind'],
  }));

  return (
    <div className={cx('space-y-1.5', className)}>
      {visual.length === 1 && (
        <Visual attachment={visual[0]} single onOpen={() => onOpen(items, 0)} onLoad={onLoad} />
      )}
      {visual.length > 1 && (
        <div className="grid max-w-lg grid-cols-2 gap-1.5 sm:grid-cols-3">
          {visual.map((attachment, index) => (
            <Visual
              key={attachment.id}
              attachment={attachment}
              onOpen={() => onOpen(items, index)}
              onLoad={onLoad}
            />
          ))}
        </div>
      )}
      {audio.map((attachment) => (
        <div
          key={attachment.id}
          className="max-w-sm rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2"
        >
          <FileLine attachment={attachment} icon="file-earmark-music" />
          <audio controls preload="metadata" src={attachment.url} className="mt-2 h-9 w-full" />
        </div>
      ))}
      {files.map((attachment) => (
        <FileCard key={attachment.id} attachment={attachment} />
      ))}
    </div>
  );
}

/** A picture or video. Alone it is shown at its own shape; in a group, as a square tile. */
function Visual({
  attachment,
  single,
  onOpen,
  onLoad,
}: {
  attachment: MessageAttachment;
  single?: boolean;
  onOpen: () => void;
  onLoad: () => void;
}) {
  const [broken, setBroken] = useState(false);
  const kind = attachmentKind(attachment.url);

  // A format this browser cannot decode is still a file someone can download.
  if (broken) return <FileCard attachment={attachment} />;

  const frame = single ? fitted(attachment) : undefined;
  const frameClass = cx(
    'relative overflow-hidden rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)]',
    !single && 'aspect-square',
  );

  if (kind === 'video' && single) {
    // Played in place with the browser's own controls, which include full
    // screen; the corner button opens it in the viewer instead.
    return (
      <div className={cx(frameClass, 'group/video bg-black')} style={frame}>
        <video
          src={attachment.url}
          controls
          preload="metadata"
          className="h-full w-full"
          onLoadedMetadata={onLoad}
          onError={() => setBroken(true)}
        />
        <button
          onClick={onOpen}
          title="Open"
          aria-label={`Open ${attachment.filename}`}
          className="absolute right-2 top-2 hidden h-7 w-7 place-items-center rounded-md bg-black/60 text-white hover:bg-black/80 group-hover/video:grid"
        >
          <Icon name="arrows-angle-expand" />
        </button>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={onOpen}
      title={attachment.filename}
      aria-label={`Open ${attachment.filename}`}
      className={cx(frameClass, 'block cursor-zoom-in')}
      style={frame}
    >
      {kind === 'image' ? (
        <img
          src={attachment.url}
          alt={attachment.filename}
          loading="lazy"
          className={cx('h-full w-full', single ? 'object-contain' : 'object-cover')}
          onLoad={onLoad}
          onError={() => setBroken(true)}
        />
      ) : (
        <>
          {/* The first frame stands in as the thumbnail. */}
          <video
            src={attachment.url}
            preload="metadata"
            muted
            className="h-full w-full object-cover"
            onLoadedMetadata={onLoad}
            onError={() => setBroken(true)}
          />
          <span className="absolute inset-0 grid place-items-center">
            <span className="grid h-10 w-10 place-items-center rounded-full bg-black/60 text-lg text-white">
              <Icon name="play-fill" />
            </span>
          </span>
        </>
      )}
    </button>
  );
}

/** The on-screen box for a lone picture or video: its own shape, scaled to fit. */
function fitted(attachment: MessageAttachment): React.CSSProperties {
  const { width, height } = attachment;
  if (!width || !height) return { width: MAX_WIDTH, maxWidth: '100%', aspectRatio: '4 / 3' };
  const scale = Math.min(1, MAX_WIDTH / width, MAX_HEIGHT / height);
  return {
    width: Math.max(48, Math.round(width * scale)),
    maxWidth: '100%',
    aspectRatio: `${width} / ${height}`,
  };
}

function FileCard({ attachment }: { attachment: MessageAttachment }) {
  return (
    <div className="flex max-w-sm items-center gap-3 rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2">
      <div className="min-w-0 flex-1">
        <FileLine attachment={attachment} icon={fileIcon(attachment.filename)} />
      </div>
      <a
        href={attachment.url}
        download={attachment.filename}
        title="Download"
        aria-label={`Download ${attachment.filename}`}
        className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-[var(--color-muted)] hover:bg-[var(--color-line)] hover:text-[var(--color-ink)]"
      >
        <Icon name="download" />
      </a>
    </div>
  );
}

function FileLine({ attachment, icon }: { attachment: MessageAttachment; icon: IconName }) {
  // PDFs open in a new tab; everything else is only ever a download.
  const opens = /\.pdf$/i.test(attachment.url);
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <Icon name={icon} className="shrink-0 text-2xl text-[var(--color-muted)]" />
      <div className="min-w-0">
        <a
          href={attachment.url}
          {...(opens ? { target: '_blank', rel: 'noopener noreferrer' } : { download: attachment.filename })}
          className="block truncate text-sm font-medium text-[var(--color-accent)] hover:underline"
        >
          {attachment.filename}
        </a>
        <div className="text-xs text-[var(--color-muted)]">{formatBytes(attachment.byteSize)}</div>
      </div>
    </div>
  );
}

const ICON_BY_EXTENSION: Record<string, IconName> = {
  pdf: 'file-earmark-pdf',
  zip: 'file-earmark-zip',
  gz: 'file-earmark-zip',
  tgz: 'file-earmark-zip',
  rar: 'file-earmark-zip',
  '7z': 'file-earmark-zip',
  doc: 'file-earmark-word',
  docx: 'file-earmark-word',
  odt: 'file-earmark-word',
  rtf: 'file-earmark-word',
  xls: 'file-earmark-spreadsheet',
  xlsx: 'file-earmark-spreadsheet',
  ods: 'file-earmark-spreadsheet',
  csv: 'file-earmark-spreadsheet',
  ppt: 'file-earmark-slides',
  pptx: 'file-earmark-slides',
  odp: 'file-earmark-slides',
  key: 'file-earmark-slides',
  txt: 'file-earmark-text',
  md: 'file-earmark-text',
  log: 'file-earmark-text',
  json: 'file-earmark-code',
  js: 'file-earmark-code',
  ts: 'file-earmark-code',
  html: 'file-earmark-code',
  css: 'file-earmark-code',
  py: 'file-earmark-code',
  sh: 'file-earmark-code',
  yml: 'file-earmark-code',
  yaml: 'file-earmark-code',
  sql: 'file-earmark-code',
  svg: 'file-earmark-image',
};

export function fileIcon(filename: string): IconName {
  const extension = /\.([a-z0-9]+)$/i.exec(filename)?.[1]?.toLowerCase() ?? '';
  if (ICON_BY_EXTENSION[extension]) return ICON_BY_EXTENSION[extension];
  const kind = attachmentKind(filename);
  if (kind === 'image') return 'file-earmark-image';
  if (kind === 'video') return 'file-earmark-play';
  if (kind === 'audio') return 'file-earmark-music';
  return 'file-earmark';
}
