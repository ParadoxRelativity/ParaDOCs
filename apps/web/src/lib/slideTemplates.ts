import type { PresentationTemplateSummary } from '@paradocs/shared';
import { api } from '../api/client';
import { importSlideFile } from './slideImportClient';
import { encodeTemplateImport, resolveMedia, uploadImportMedia } from './slideImport';
import { isTemplateImportFile, type ImportProgress, type ImportReport } from './slideImportTypes';

/**
 * Importing a presentation template (PARA-110) from a PowerPoint template
 * (.potx), presentation (.pptx) or theme (.thmx).
 *
 * The file is read in the import worker, keeping only its look: the theme,
 * the main master and its layouts, and none of its slides. A draft template is
 * made on the server, the master's and layouts' pictures are uploaded to it,
 * and then the template's deck is stored, which shows it to the workspace. A
 * file that will not open leaves nothing behind; one that fails partway has
 * its draft deleted.
 */

export async function importTemplateFile(
  workspaceId: string,
  file: File,
  input: { name: string; description?: string },
  upload: (file: File, templateId: string) => Promise<{ url: string }>,
  onProgress?: (progress: ImportProgress) => void,
): Promise<{ template: PresentationTemplateSummary; report: ImportReport }> {
  if (!isTemplateImportFile(file.name)) throw new Error(`${file.name} is not a template Slides can import (.potx, .pptx or .thmx)`);
  const deck = await importSlideFile(file, onProgress, undefined, true);
  const { id } = await api.post<{ id: string }>(`/workspaces/${workspaceId}/presentation-templates`, input);
  try {
    const { urls, failed } = await uploadImportMedia(deck, (picture) => upload(picture, id), onProgress);
    const resolved = resolveMedia(deck, urls, failed);
    onProgress?.({ stage: 'applying', done: 0, total: 1, message: 'Saving the template…' });
    const update = encodeTemplateImport(resolved);
    const template = await api.upload<PresentationTemplateSummary>('PUT', `/presentation-templates/${id}/content`, new Blob([update as BlobPart]));
    return { template, report: resolved.report };
  } catch (err) {
    await api.delete(`/presentation-templates/${id}`).catch(() => undefined);
    throw err;
  }
}
