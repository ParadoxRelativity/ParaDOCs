import {
  fieldKey,
  sheetRefKey,
  workItemFieldText,
  workItemPercent,
  type ResolvedSheetRef,
  type SheetRef,
  type SlideElement,
  type SlideField,
  type WorkItemReference,
  type WorkspaceMember,
} from '@paradocs/shared';
import { api } from '../../api/client';
import { assetUrl } from '../server';
import { fetchWorkItemDetails } from '../workItemRefs';
import { sniffImage } from './imageInfo';
import type { ExportAssets, LiveSnapshot, LoadedImage, LoadedMedia } from './pptx';

/**
 * Everything an export fetches, as the person exporting. Pictures and media are
 * read from the server with their own session, and live content goes through
 * the same lookups the slides use to draw it, so someone who may not see a
 * sheet, work item or document gets nothing of it in their file.
 */

/** Media larger than this is linked rather than embedded, so one export cannot run a tab out of memory. */
const MAX_EMBEDDED_MEDIA_BYTES = 48 * 1024 * 1024;
const MAX_IMAGE_BYTES = 40 * 1024 * 1024;
const EXCERPT_CHARS = 1500;

async function fetchBlob(url: string, limit: number): Promise<Blob | null> {
  try {
    const res = await fetch(assetUrl(url), { credentials: 'include' });
    if (!res.ok) return null;
    const length = Number(res.headers.get('content-length'));
    if (Number.isFinite(length) && length > limit) return null;
    const blob = await res.blob();
    return blob.size > limit ? null : blob;
  } catch {
    return null;
  }
}

/** Draws any picture the browser can show onto a canvas and keeps it as PNG: WebP, SVG and the rest become something PowerPoint opens. */
async function asPng(blob: Blob): Promise<LoadedImage | null> {
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.decoding = 'async';
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('undecodable'));
      image.src = url;
    });
    // An SVG with no size of its own is drawn at a size that stays sharp on a slide.
    const width = image.naturalWidth || 1600;
    const height = image.naturalHeight || 900;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d')?.drawImage(image, 0, 0, width, height);
    const png = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    return png ? { data: new Uint8Array(await png.arrayBuffer()), ext: 'png', width, height } : null;
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function loadImage(url: string): Promise<LoadedImage | null> {
  const blob = await fetchBlob(url, MAX_IMAGE_BYTES);
  if (!blob) return null;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const info = sniffImage(bytes);
  if (info && info.ext !== 'webp') return { data: bytes, ext: info.ext, width: info.width, height: info.height };
  return asPng(blob);
}

async function loadMedia(url: string): Promise<LoadedMedia | null> {
  const blob = await fetchBlob(url, MAX_EMBEDDED_MEDIA_BYTES);
  if (!blob) return null;
  const path = url.split('?')[0];
  const fromName = /\.([A-Za-z0-9]{2,4})$/.exec(path)?.[1]?.toLowerCase();
  const fromType = blob.type.split('/')[1]?.split(';')[0]?.toLowerCase();
  const ext = fromName ?? ({ mpeg: 'mp3', 'x-m4a': 'm4a', quicktime: 'mov', 'x-wav': 'wav' }[fromType ?? ''] ?? fromType ?? 'bin');
  return { data: new Uint8Array(await blob.arrayBuffer()), ext };
}

async function resolveRef(ref: SheetRef): Promise<ResolvedSheetRef | null> {
  try {
    const { results } = await api.post<{ results: Record<string, ResolvedSheetRef> }>('/sheet-refs/resolve', { refs: [ref] });
    return results[sheetRefKey(ref)] ?? null;
  } catch {
    return null;
  }
}

function plainExcerpt(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^[#>\s*+-]+/gm, '')
    .replace(/[*_`]/g, '')
    .trim()
    .slice(0, EXCERPT_CHARS);
}

async function liveSnapshot(element: SlideElement): Promise<LiveSnapshot | null> {
  switch (element.type) {
    case 'sheetCell': {
      const result = await resolveRef({ kind: 'cell', spreadsheetId: element.spreadsheetId, sheetId: element.sheetId, cell: element.cell });
      if (result?.status !== 'ok' || result.kind !== 'cell') return null;
      return {
        kind: 'cell',
        display: result.display,
        isError: result.isError,
        caption: `${element.label || result.cell} · ${result.spreadsheetTitle} › ${result.sheetName}`,
      };
    }
    case 'sheetChart': {
      const result = await resolveRef({ kind: 'chart', spreadsheetId: element.spreadsheetId, sheetId: element.sheetId, chartId: element.chartId });
      if (result?.status !== 'ok' || result.kind !== 'chart') return null;
      return {
        kind: 'chart',
        title: result.title || element.label || 'Chart',
        chartKind: result.chartKind,
        data: result.data,
        caption: `${result.spreadsheetTitle} › ${result.sheetName}`,
      };
    }
    case 'workItem': {
      try {
        const { items } = await api.post<{ items: WorkItemReference[] }>('/work-item-refs/resolve', { ids: [element.itemId.toLowerCase()] });
        const item = items[0];
        if (!item) return null;
        return { kind: 'workItem', key: item.key, title: item.title, statusName: item.statusName, statusColor: item.statusColor, done: item.statusCategory === 'done' };
      } catch {
        return null;
      }
    }
    case 'workItemProgress': {
      const item = (await fetchWorkItemDetails([element.itemId.toLowerCase()]).catch(() => []))[0];
      if (!item) return null;
      const progress = item.progress;
      return {
        kind: 'progress',
        key: item.key,
        title: item.title,
        statusName: item.statusName,
        statusColor: item.statusColor,
        percent: workItemPercent(item),
        caption: progress ? `${progress.done} of ${progress.total} done` : item.statusCategory === 'done' ? 'Done' : 'Not done',
        children: element.showChildren === false ? [] : item.children.map((c) => ({ key: c.key, title: c.title, statusName: c.statusName, done: c.statusCategory === 'done' })),
      };
    }
    case 'person': {
      // A person is shown to anyone in the workspace the deck is in, which is the one the page is in.
      const workspaceId = /^\/w\/([^/]+)/.exec(window.location.pathname)?.[1];
      if (!workspaceId) return null;
      const members = await api.get<WorkspaceMember[]>(`/workspaces/${workspaceId}/members`).catch(() => [] as WorkspaceMember[]);
      const member = members.find((m) => m.userId === element.userId);
      return member ? { kind: 'person', name: member.name, role: member.workspaceRole?.name ?? '', email: member.email } : null;
    }
    case 'link': {
      try {
        const doc = await api.get<{ title: string; mode?: string; bodyMd?: string }>(`/documents/${element.documentId}`);
        const text = doc.mode === 'canvas' ? 'A canvas.' : plainExcerpt(doc.bodyMd ?? '') || 'Empty document';
        return { kind: 'document', title: doc.title || 'Document', text };
      } catch {
        return null;
      }
    }
    default:
      return null;
  }
}

/** What a field in text reads now, or null where the exporter may not see its source. */
async function fieldText(field: SlideField): Promise<string | null> {
  switch (field.kind) {
    case 'cell': {
      const result = await resolveRef({ kind: 'cell', spreadsheetId: field.spreadsheetId, sheetId: field.sheetId, cell: field.cell });
      return result?.status === 'ok' && result.kind === 'cell' ? result.display : null;
    }
    case 'workItem': {
      const item = (await fetchWorkItemDetails([field.itemId]).catch(() => []))[0];
      return item ? workItemFieldText(field.part, item) : null;
    }
    case 'document': {
      const doc = await api.get<{ title: string }>(`/documents/${field.documentId}`).catch(() => null);
      return doc ? doc.title || 'Untitled' : null;
    }
  }
}

/** The loaders for one export. Pictures are fetched once even when several slides use them. */
export function browserAssets(): ExportAssets {
  const images = new Map<string, Promise<LoadedImage | null>>();
  const media = new Map<string, Promise<LoadedMedia | null>>();
  const live = new Map<string, Promise<LiveSnapshot | null>>();
  const fields = new Map<string, Promise<string | null>>();
  return {
    image: (url) => images.get(url) ?? images.set(url, loadImage(url)).get(url)!,
    media: (url) => media.get(url) ?? media.set(url, loadMedia(url)).get(url)!,
    // The same chart or cell on several slides is asked for once.
    live(element) {
      const { id: _id, x: _x, y: _y, width: _w, height: _h, z: _z, rotation: _r, animation: _a, ...source } = element as unknown as Record<string, unknown>;
      const key = JSON.stringify(source);
      return live.get(key) ?? live.set(key, liveSnapshot(element)).get(key)!;
    },
    field(field) {
      const key = fieldKey(field);
      return fields.get(key) ?? fields.set(key, fieldText(field)).get(key)!;
    },
  };
}
