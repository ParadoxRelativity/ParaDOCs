import { attachmentKind, type MessageAttachment } from '@paradocs/shared';
import { api } from '../api/client';

/**
 * The pixel size of an image or video, read locally before upload so the
 * message list can reserve the right space before the file loads for anyone.
 */
export async function measure(file: File): Promise<{ width: number; height: number } | null> {
  const kind = attachmentKind(file.name);
  try {
    if (kind === 'image') {
      const bitmap = await createImageBitmap(file);
      const size = { width: bitmap.width, height: bitmap.height };
      bitmap.close();
      return size;
    }
    if (kind === 'video') {
      return await new Promise((resolve) => {
        const url = URL.createObjectURL(file);
        const video = document.createElement('video');
        let settled = false;
        const finish = (size: { width: number; height: number } | null) => {
          if (settled) return;
          settled = true;
          URL.revokeObjectURL(url);
          resolve(size);
        };
        video.preload = 'metadata';
        video.muted = true;
        video.onloadedmetadata = () =>
          finish(video.videoWidth && video.videoHeight ? { width: video.videoWidth, height: video.videoHeight } : null);
        video.onerror = () => finish(null);
        // A format the browser cannot read never fires either event.
        setTimeout(() => finish(null), 5000);
        video.src = url;
      });
    }
  } catch {
    // An unreadable file is still worth sharing; it just gets no reserved size.
  }
  return null;
}

/** Uploads a file for a message that has not been sent yet. */
export async function uploadChatFile(
  channelId: string,
  file: File,
  options: { onProgress: (fraction: number) => void; signal: AbortSignal },
): Promise<MessageAttachment> {
  const size = await measure(file);
  const form = new FormData();
  // Fields must precede the file: the server reads those that arrived before it.
  if (size) {
    form.append('width', String(size.width));
    form.append('height', String(size.height));
  }
  form.append('file', file);
  return api.uploadWithProgress<MessageAttachment>(
    `/channels/${channelId}/attachments`,
    form,
    options.onProgress,
    options.signal,
  );
}
