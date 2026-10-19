import type { UploadedFile } from '../api/hooks';
import { authHeaders, serverUrl } from './server';

/**
 * Uploads a picture, video or sound for a slide and returns its served URL.
 *
 * The file is recorded against the presentation, so it is served only to
 * people who may open the deck, exactly as a document's images are served to
 * people who may open the document. (The same endpoint as every other upload;
 * this is the version an insert tool can call, as it is not a React hook.)
 */
export async function uploadSlideFile(workspaceId: string, presentationId: string, file: File): Promise<UploadedFile> {
  const body = new FormData();
  // Fields precede the file: the server reads those that arrived before it.
  body.append('presentationId', presentationId);
  body.append('file', file);
  const res = await fetch(serverUrl(`/api/workspaces/${workspaceId}/uploads`), {
    method: 'POST',
    credentials: 'include',
    headers: authHeaders(),
    body,
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new Error(detail?.error ?? `Upload failed (${res.status})`);
  }
  // The address stays the server's own path: that is what a slide stores, and renderers add the origin with assetUrl.
  return (await res.json()) as UploadedFile;
}

/** A picture's natural size, or null if the browser cannot read it. */
export async function imageSize(file: File): Promise<{ width: number; height: number } | null> {
  try {
    const bitmap = await createImageBitmap(file);
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return size;
  } catch {
    return null;
  }
}
