import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { authHeaders, serverUrl } from './server';
import { SLIDE_IMPORT_ACCEPT, isSlideImportFile } from './slideImportTypes';

/**
 * Importing formats a browser cannot read itself: older PowerPoint (.ppt,
 * .pps, .pot) and Keynote (.key). The server hands them to its optional
 * converter, which returns a .pptx, and that goes through the same importer as
 * any other .pptx. PDFs need no converter and are read in the browser.
 */

export const LEGACY_EXTENSIONS = ['.ppt', '.pps', '.pot', '.key'];

/** Every file the Import button and the drop target take. */
export const ALL_IMPORT_ACCEPT = [SLIDE_IMPORT_ACCEPT, ...LEGACY_EXTENSIONS, '.pdf', 'application/pdf'].join(',');

export type ImportKind = 'native' | 'legacy' | 'pdf';

/** How a file will be imported; null for one that is not a presentation. */
export function classifyImportFile(name: string): ImportKind | null {
  const lower = name.toLowerCase();
  if (isSlideImportFile(lower)) return 'native';
  if (LEGACY_EXTENSIONS.some((ext) => lower.endsWith(ext))) return 'legacy';
  if (lower.endsWith('.pdf')) return 'pdf';
  return null;
}

export const isKeynoteFile = (name: string): boolean => name.toLowerCase().endsWith('.key');

export const KEYNOTE_ADVICE = 'Keynote files convert only in part. For the best result, export to PowerPoint (.pptx) from Keynote and import that.';

export interface ConverterStatus {
  enabled: boolean;
  maxBytes: number;
}

/** Whether this server can convert older formats. A server that cannot say (an old one, a local workspace) cannot. */
export function useSlideConverter(workspaceId: string) {
  return useQuery({
    queryKey: ['slideConverter', workspaceId],
    queryFn: () => api.get<ConverterStatus>(`/workspaces/${workspaceId}/presentations/converter`).catch((): ConverterStatus => ({ enabled: false, maxBytes: 0 })),
    // A deployment fact, like the voice service.
    staleTime: 5 * 60_000,
  });
}

/** The server has no converter, or the person's file is one it cannot use; the page explains, rather than showing an error. */
export class ConverterUnavailableError extends Error {
  constructor() {
    super('This server cannot convert .ppt or Keynote files.');
  }
}

/** Sends a legacy file to the server's converter and returns the .pptx it makes. */
export async function convertLegacyFile(workspaceId: string, file: File): Promise<File> {
  const body = new FormData();
  body.append('file', file);
  const res = await fetch(serverUrl(`/api/workspaces/${workspaceId}/presentations/convert`), {
    method: 'POST',
    credentials: 'include',
    headers: authHeaders(),
    body,
  });
  if (res.ok) {
    return new File([await res.blob()], file.name.replace(/\.[^.]+$/, '') + '.pptx', {
      type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    });
  }
  const detail = await res.json().catch(() => null);
  if (detail?.code === 'converter_disabled') throw new ConverterUnavailableError();
  throw new Error(detail?.error ?? `Could not convert ${file.name} (${res.status})`);
}
