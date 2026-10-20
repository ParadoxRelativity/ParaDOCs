import type { FastifyPluginAsync } from 'fastify';
import { config } from '../config.js';
import { HttpError, badRequest } from '../lib/http.js';
import { assertWorkspaceAccess } from '../plugins/session.js';

/**
 * Converting a legacy presentation to .pptx, for Slides' import.
 *
 * Browsers read .pptx and .odp themselves. .ppt, .pps, .pot and Keynote files
 * need LibreOffice, which runs in an optional sidecar container (see
 * docs/slides-converter.md). This route only passes a file along: the
 * sidecar converts it and the browser then imports the .pptx it gets back
 * exactly as if the person had chosen one, so there is one mapping path.
 *
 * Nothing is stored here. The file is held in memory for the length of the
 * request, and the sidecar keeps nothing either.
 */

/** Formats the converter is offered, as lower-case extensions. .odp is a fallback for ones the browser parser cannot read. */
export const CONVERTIBLE_EXTENSIONS = ['.ppt', '.pps', '.pot', '.key', '.odp'];

export const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

const extensionOf = (name: string) => {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot).toLowerCase();
};

let running = 0;

/** Reads a response body, giving up once it passes `limit` bytes. */
async function readLimited(res: Response, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  const reader = res.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      throw new HttpError(502, 'The converter returned more than expected', 'converter_failed');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

export const slideConvertRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.requireAuth);

  /** Whether this server can convert, so the page can say what a legacy file needs before anything is sent. */
  app.get<{ Params: { id: string } }>('/workspaces/:id/presentations/converter', async (req) => {
    await assertWorkspaceAccess(req, req.params.id, 'slides.create', 'slides');
    return {
      enabled: config.converter.enabled,
      maxBytes: config.converter.maxBytes,
      extensions: CONVERTIBLE_EXTENSIONS,
    };
  });

  app.post<{ Params: { id: string } }>('/workspaces/:id/presentations/convert', async (req, reply) => {
    await assertWorkspaceAccess(req, req.params.id, 'slides.create', 'slides');
    const settings = config.converter;
    if (!settings.enabled) {
      throw new HttpError(
        501,
        'This server has no converter for older presentation formats. Export the file to .pptx, or import it as a PDF.',
        'converter_disabled',
      );
    }
    const file = await req.file({ limits: { fileSize: settings.maxBytes, files: 1 } });
    if (!file) throw badRequest('No file was uploaded');
    const extension = extensionOf(file.filename);
    if (!CONVERTIBLE_EXTENSIONS.includes(extension)) {
      file.file.resume();
      throw badRequest(`${file.filename} is not a format the converter reads (${CONVERTIBLE_EXTENSIONS.join(', ')})`);
    }
    const tooLarge = () =>
      new HttpError(413, `That file is larger than the converter accepts (${Math.floor(settings.maxBytes / 1024 / 1024)} MB)`, 'file_too_large');
    let data: Buffer;
    try {
      data = await file.toBuffer();
    } catch (err) {
      if ((err as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') throw tooLarge();
      throw err;
    }
    if (file.file.truncated) throw tooLarge();
    if (data.length === 0) throw badRequest('That file is empty');

    // LibreOffice is heavy: past the limit, ask people to try again rather than queueing without end.
    if (running >= settings.concurrency) {
      throw new HttpError(503, 'The converter is busy. Try again in a moment.', 'converter_busy', 10);
    }
    running += 1;
    try {
      const res = await fetch(`${settings.url}/convert?extension=${encodeURIComponent(extension)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: new Uint8Array(data),
        signal: AbortSignal.timeout(settings.timeoutMs),
      });
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        throw new HttpError(
          422,
          'The converter could not read that file. If it came from Keynote, export it to .pptx from Keynote, or import it as a PDF.',
          'conversion_failed',
        );
      }
      const converted = await readLimited(res, settings.maxBytes * 2);
      // A .pptx is a zip; anything else means the converter did not do its job.
      if (converted.length < 4 || converted.readUInt32LE(0) !== 0x04034b50) {
        throw new HttpError(422, 'The converter did not produce a presentation from that file', 'conversion_failed');
      }
      return reply.header('Cache-Control', 'no-store').type(PPTX_MIME).send(converted);
    } catch (err) {
      if (err instanceof HttpError) throw err;
      const name = (err as { name?: string }).name;
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new HttpError(504, 'Converting that file took too long, so it was stopped. Try exporting it to .pptx or a PDF instead.', 'conversion_timeout');
      }
      req.log.warn({ err }, 'presentation converter unreachable');
      throw new HttpError(502, 'The converter did not answer. Ask whoever runs this server to check it.', 'converter_unavailable');
    } finally {
      running -= 1;
    }
  });
};
