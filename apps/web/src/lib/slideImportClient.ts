import type { ImportProgress, ImportedDeck } from './slideImportTypes';
import type { SlideImportResponse } from './slideImportWorker';

/**
 * Reading a presentation file from the page: the file goes to a Web Worker and
 * comes back as an {@link ImportedDeck}. The parsers are loaded only when
 * someone imports, so opening Slides never pays for them.
 *
 * `importSlideFile` is the entry point for every importer that has file bytes.
 * PARA-96 calls it with the .pptx a converter returns for a .ppt or Keynote
 * file (`importSlideFile(new File([converted], name))`); the result goes to the
 * same upload and `rememberImport` steps as a direct .pptx.
 */
export async function importSlideFile(file: File, onProgress?: (progress: ImportProgress) => void): Promise<ImportedDeck> {
  onProgress?.({ stage: 'reading', done: 0, total: 1, message: `Opening ${file.name}` });
  const data = await file.arrayBuffer();
  if (typeof Worker === 'undefined') return importOnThisThread(data, file.name, onProgress);

  return new Promise<ImportedDeck>((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL('./slideImportWorker.ts', import.meta.url), { type: 'module' });
    } catch {
      importOnThisThread(data, file.name, onProgress).then(resolve, reject);
      return;
    }
    worker.onmessage = (event: MessageEvent<SlideImportResponse>) => {
      const message = event.data;
      if (message.type === 'progress') onProgress?.(message.progress);
      else {
        worker.terminate();
        if (message.type === 'done') resolve(message.deck);
        else reject(new Error(message.message));
      }
    };
    worker.onerror = (event) => {
      worker.terminate();
      reject(new Error(event.message || 'Could not read that file'));
    };
    worker.postMessage({ data, fileName: file.name }, [data]);
  });
}

/** Where there is no worker: the same parse, on this thread, with the browser's own XML parser. */
async function importOnThisThread(data: ArrayBuffer, fileName: string, onProgress?: (progress: ImportProgress) => void): Promise<ImportedDeck> {
  const { parseSlideFile } = await import('./slideImportParse');
  return parseSlideFile(data, fileName, {
    parseXml: (text) => new DOMParser().parseFromString(text, 'text/xml'),
    onProgress,
  });
}
