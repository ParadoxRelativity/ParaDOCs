import { memo, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import {
  isWebUrl,
  toEmbedUrl,
  type AudioElement,
  type EmbedElement,
  type SlideImageElement,
  type VideoElement,
} from '@paradocs/shared';
import { assetUrl } from '../../lib/server';
import { imageSize, uploadSlideFile } from '../../lib/slideUploads';
import { Button } from '../ui';
import { Field, Group, NumberInput, SelectInput } from './inspectorParts';
import {
  registerSlideElementRenderer,
  registerSlideFileHandler,
  registerSlideInsertTool,
  registerSlideInspectorSection,
  type SlideEditorContext,
  type SlideElementRendererProps,
} from './slideExtensions';

/** A shown element at least this wide on screen is being watched (the slideshow, the stage), not a thumbnail. */
const WATCHED_PX = 240;
const MAX_INSERT = { width: 1280, height: 720 };

function Placeholder({ label }: { label: string }) {
  return (
    <div className="grid h-full w-full place-items-center rounded-lg border border-dashed border-[var(--color-line)] text-xs text-[var(--color-muted)]">
      {label}
    </div>
  );
}

/**
 * Whether the element is drawn big enough to be used. Thumbnails in the rail
 * draw the same read-only renderer a few dozen pixels wide, and a tiny video
 * with controls, or one that swallows the click meant to open its slide, would
 * be worse than a still frame.
 */
export function useWatched<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [watched, setWatched] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setWatched(el.getBoundingClientRect().width >= WATCHED_PX);
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(el);
    return () => observer?.disconnect();
  }, []);
  return [ref, watched] as const;
}

// ---------------------------------------------------------------------------
// Image
// ---------------------------------------------------------------------------

const ImageRenderer = memo(function ImageRenderer({ element, readOnly }: SlideElementRendererProps) {
  const image = element as unknown as SlideImageElement;
  // An empty picture placeholder shows its prompt to people editing and nothing on a thumbnail or in the show.
  if (!image.url) return readOnly ? null : <Placeholder label={image.prompt ?? 'Image'} />;
  const crop = image.crop;
  const fit = image.fit ?? 'cover';
  return (
    <div className="relative h-full w-full overflow-hidden" style={{ opacity: image.opacity ?? 1 }}>
      <img
        src={assetUrl(image.url)}
        alt={image.alt ?? ''}
        draggable={false}
        style={
          crop
            ? {
                // Showing part of the picture: stretch it so that part fills the box.
                position: 'absolute',
                width: `${100 / crop.width}%`,
                height: `${100 / crop.height}%`,
                left: `${(-crop.x / crop.width) * 100}%`,
                top: `${(-crop.y / crop.height) * 100}%`,
                maxWidth: 'none',
                objectFit: 'fill',
              }
            : { width: '100%', height: '100%', objectFit: fit }
        }
      />
    </div>
  );
});
registerSlideElementRenderer('image', ImageRenderer);

// ---------------------------------------------------------------------------
// Video and audio
// ---------------------------------------------------------------------------

/**
 * Video plays on the stage once selected, and in the slideshow on a click
 * that does not also advance the slide. Where the slide is being read, the
 * element takes pointer events back from the read-only slide around it.
 */
const VideoRenderer = memo(function VideoRenderer({ element, selected, readOnly }: SlideElementRendererProps) {
  const video = element as unknown as VideoElement;
  const [ref, watched] = useWatched<HTMLVideoElement>();
  if (!video.url) return <Placeholder label="Video" />;
  const usable = readOnly ? watched : selected;
  const keepClick = (e: ReactPointerEvent) => {
    if (readOnly && watched) e.stopPropagation();
  };
  return (
    <video
      ref={ref}
      src={assetUrl(video.url)}
      title={video.title}
      controls={usable}
      playsInline
      preload="metadata"
      draggable={false}
      className="h-full w-full rounded-lg bg-black object-contain"
      style={{ pointerEvents: usable ? 'auto' : readOnly ? 'none' : undefined }}
      onPointerDown={keepClick}
      onPointerUp={keepClick}
      onClick={(e) => {
        if (!readOnly || !watched) return;
        e.stopPropagation();
        const el = e.currentTarget;
        if (el.paused) void el.play();
        else el.pause();
      }}
    />
  );
});
registerSlideElementRenderer('video', VideoRenderer);

const AudioRenderer = memo(function AudioRenderer({ element, selected, readOnly }: SlideElementRendererProps) {
  const audio = element as unknown as AudioElement;
  const [ref, watched] = useWatched<HTMLDivElement>();
  const usable = readOnly ? watched : selected;
  return (
    <div
      ref={ref}
      className="flex h-full w-full flex-col justify-center gap-1 rounded-lg border border-[var(--color-line)] bg-[var(--color-raised)] px-3"
      style={{ pointerEvents: usable ? 'auto' : readOnly ? 'none' : undefined }}
      onPointerDown={(e) => readOnly && watched && e.stopPropagation()}
      onPointerUp={(e) => readOnly && watched && e.stopPropagation()}
    >
      {audio.title && <span className="truncate text-xs font-medium">{audio.title}</span>}
      <audio src={assetUrl(audio.url)} controls={usable} preload="metadata" className="w-full" />
    </div>
  );
});
registerSlideElementRenderer('audio', AudioRenderer);

// ---------------------------------------------------------------------------
// Web embed
// ---------------------------------------------------------------------------

const EmbedRenderer = memo(function EmbedRenderer({ element, selected, readOnly }: SlideElementRendererProps) {
  const embed = element as unknown as EmbedElement;
  const [ref, watched] = useWatched<HTMLDivElement>();
  if (!embed.url) return <Placeholder label="Embed" />;
  const src = toEmbedUrl(embed.url);
  // Only a web page is framed; anything else could run script as this app.
  if (!src) return <Placeholder label="This embed is not a web address" />;
  const usable = readOnly ? watched : selected;
  return (
    <div
      ref={ref}
      className="relative h-full w-full overflow-hidden rounded-lg border border-[var(--color-line)] bg-black"
      style={{ pointerEvents: usable && readOnly ? 'auto' : undefined }}
      onPointerDown={(e) => readOnly && watched && e.stopPropagation()}
      onPointerUp={(e) => readOnly && watched && e.stopPropagation()}
    >
      <iframe
        src={readOnly && !watched ? undefined : src}
        title={embed.title ?? embed.url}
        className="h-full w-full"
        allow="accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen"
        sandbox="allow-scripts allow-same-origin allow-popups allow-presentation allow-forms"
        referrerPolicy="no-referrer"
      />
      {/* On the stage an unselected embed is inert, so a press selects and drags it rather than going to the page. */}
      {!usable && <div className="absolute inset-0" aria-hidden />}
    </div>
  );
});
registerSlideElementRenderer('embed', EmbedRenderer);

// ---------------------------------------------------------------------------
// Inserting, pasting and dropping
// ---------------------------------------------------------------------------

const isMedia = (file: File) => /^(image|video|audio)\//.test(file.type);

/** Puts a file on the current slide: a picture sized to its shape, a video, or a sound. */
async function insertFile(ctx: SlideEditorContext, file: File, at?: { x: number; y: number }, nudge = 0) {
  const slide = ctx.slide;
  if (!slide || !isMedia(file)) return null;
  const upload = await uploadSlideFile(ctx.workspaceId, ctx.presentationId, file);
  const type = file.type.startsWith('image/') ? 'image' : file.type.startsWith('video/') ? 'video' : 'audio';
  let width = type === 'audio' ? 640 : MAX_INSERT.width;
  let height = type === 'audio' ? 90 : MAX_INSERT.height;
  if (type === 'image') {
    const natural = await imageSize(file);
    if (natural) {
      const scale = Math.min(MAX_INSERT.width / natural.width, MAX_INSERT.height / natural.height, 1);
      width = Math.max(40, Math.round(natural.width * scale));
      height = Math.max(40, Math.round(natural.height * scale));
    }
  }
  const centre = at ?? ctx.center;
  return ctx.actions.createElement(slide.id, {
    type,
    url: upload.url,
    ...(type === 'image' ? { alt: file.name.replace(/\.[^.]+$/, '') } : { title: file.name }),
    width,
    height,
    x: Math.round(centre.x - width / 2 + nudge),
    y: Math.round(centre.y - height / 2 + nudge),
  });
}

async function insertFiles(ctx: SlideEditorContext, files: File[], at?: { x: number; y: number }) {
  const created: string[] = [];
  try {
    for (const file of files.filter(isMedia)) {
      const id = await insertFile(ctx, file, at, created.length * 32);
      if (id) created.push(id);
    }
  } catch (err) {
    window.alert(err instanceof Error ? err.message : 'Could not upload that file.');
  }
  if (created.length) ctx.select(created);
}

/** Opens the system file picker and hands back what was chosen. */
function pick(accept: string, multiple = true): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.onchange = () => resolve([...(input.files ?? [])]);
    input.oncancel = () => resolve([]);
    input.click();
  });
}

registerSlideInsertTool({
  id: 'image',
  label: 'Picture',
  icon: 'image',
  order: 30,
  run: async (ctx) => insertFiles(ctx, await pick('image/*')),
});
registerSlideInsertTool({
  id: 'media',
  label: 'Video or audio',
  icon: 'camera-video',
  order: 31,
  run: async (ctx) => insertFiles(ctx, await pick('video/*,audio/*')),
});
registerSlideInsertTool({
  id: 'embed',
  label: 'Web page',
  icon: 'globe2',
  order: 32,
  run: (ctx) => {
    if (!ctx.slide) return;
    const raw = window.prompt('Address of the web page or video to embed (https://...)')?.trim();
    if (!raw) return;
    const url = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;
    if (!isWebUrl(url) || !toEmbedUrl(url)) return void window.alert('That is not a web address that can be embedded.');
    const id = ctx.actions.createElement(ctx.slide.id, {
      type: 'embed',
      url,
      width: 1280,
      height: 720,
      x: Math.round(ctx.center.x - 640),
      y: Math.round(ctx.center.y - 360),
    });
    ctx.select([id]);
  },
});

registerSlideFileHandler({ id: 'media', accepts: isMedia, run: (ctx, files, at) => insertFiles(ctx, files, at) });

// ---------------------------------------------------------------------------
// Inspector
// ---------------------------------------------------------------------------

function ImageInspector({ ctx }: { ctx: SlideEditorContext }) {
  const { slide, selection, actions, canEdit } = ctx;
  const images = selection.filter((el): el is SlideImageElement & { id: string } => el.type === 'image');
  if (!slide || images.length === 0) return null;
  const first = images[0];
  const crop = first.crop ?? { x: 0, y: 0, width: 1, height: 1 };
  const patch = (changes: Record<string, unknown>) => actions.updateElements(slide.id, images.map((i) => ({ id: i.id, patch: changes })));
  // Cropping is shown as the percent trimmed from each side, which is how it is thought of.
  const trim = {
    left: Math.round(crop.x * 100),
    top: Math.round(crop.y * 100),
    right: Math.round((1 - crop.x - crop.width) * 100),
    bottom: Math.round((1 - crop.y - crop.height) * 100),
  };
  const setTrim = (side: keyof typeof trim, value: number) => {
    const next = { ...trim, [side]: Math.min(Math.max(value, 0), 90) };
    const width = 1 - (next.left + next.right) / 100;
    const height = 1 - (next.top + next.bottom) / 100;
    if (width < 0.1 || height < 0.1) return;
    const none = next.left + next.right + next.top + next.bottom === 0;
    patch({ crop: none ? undefined : { x: next.left / 100, y: next.top / 100, width, height } });
  };
  return (
    <Group title="Picture">
      <Field label="Fit">
        <SelectInput<'cover' | 'contain'>
          label="Picture fit"
          value={first.fit ?? 'cover'}
          disabled={!canEdit || !!first.crop}
          options={[
            { value: 'cover', label: 'Fill (crop to box)' },
            { value: 'contain', label: 'Fit (whole picture)' },
          ]}
          onChange={(value) => value && patch({ fit: value === 'cover' ? undefined : value })}
        />
      </Field>
      <Field label="Opacity">
        <input
          type="range"
          aria-label="Picture opacity"
          min={0.1}
          max={1}
          step={0.05}
          value={first.opacity ?? 1}
          disabled={!canEdit}
          onChange={(e) => patch({ opacity: Number(e.target.value) >= 1 ? undefined : Number(e.target.value) })}
          className="w-24"
        />
      </Field>
      <div className="grid grid-cols-2 gap-x-2 gap-y-1">
        {(['left', 'right', 'top', 'bottom'] as const).map((side) => (
          <Field key={side} label={`Crop ${side}`}>
            <NumberInput label={`Crop ${side} (percent)`} value={trim[side]} min={0} max={90} disabled={!canEdit} onCommit={(value) => setTrim(side, value)} />
          </Field>
        ))}
      </div>
      {first.crop && (
        <Button variant="subtle" className="!px-2 !py-1 text-xs" disabled={!canEdit} onClick={() => patch({ crop: undefined })}>
          Reset crop
        </Button>
      )}
      <label className="block">
        <span className="text-[var(--color-muted)]">Description for screen readers</span>
        <input
          defaultValue={first.alt ?? ''}
          key={first.id}
          disabled={!canEdit}
          onBlur={(e) => e.target.value !== (first.alt ?? '') && patch({ alt: e.target.value || undefined })}
          onKeyDown={(e) => e.stopPropagation()}
          className="mt-1 w-full rounded border border-[var(--color-line)] bg-[var(--color-canvas)] px-1.5 py-1 text-xs outline-none focus:border-[var(--color-accent)]"
        />
      </label>
    </Group>
  );
}

registerSlideInspectorSection({
  id: 'image',
  order: 20,
  applies: (ctx, scope) => scope === 'elements' && ctx.selection.some((el) => el.type === 'image'),
  render: (ctx) => <ImageInspector ctx={ctx} />,
});
