import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
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
 * The same converter also draws a deck's Windows metafile pictures (.emf,
 * .wmf) to PNGs for the browser's import (apps/web/src/lib/windowsPictures.ts).
 *
 * Nothing is stored here. The file is held in memory for the length of the
 * request, and the sidecar keeps nothing either.
 */

/** Formats the converter is offered, as lower-case extensions. .odp is a fallback for ones the browser parser cannot read. */
export const CONVERTIBLE_EXTENSIONS = ['.ppt', '.pps', '.pot', '.key', '.odp'];

/** Windows metafile pictures (.emf, .wmf) in an imported deck, which the converter draws to PNGs, as browsers cannot show them. */
export const PICTURE_EXTENSIONS = ['.emf', '.wmf'];

export const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

/** A requested PNG side in pixels: a whole number from 1 to 4000, else none. */
const pixelSide = (value: unknown): number | undefined => {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 4000 ? n : undefined;
};

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

  /**
   * Reads the one uploaded file, checks it has an extension in `extensions`,
   * passes it to the converter and returns what comes back. `fail` is the
   * message for a file the converter could not read; `valid` checks its output.
   */
  async function convertUpload(
    req: FastifyRequest,
    extensions: string[],
    options: { query?: string; fail: string; valid: (out: Buffer) => boolean; invalid: string },
  ): Promise<Buffer> {
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
    if (!extensions.includes(extension)) {
      file.file.resume();
      throw badRequest(`${file.filename} is not a format the converter reads (${extensions.join(', ')})`);
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
      const res = await fetch(`${settings.url}/convert?extension=${encodeURIComponent(extension)}${options.query ?? ''}`, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: new Uint8Array(data),
        // The converter runs one file at a time, so a request may first wait for
        // those ahead of it: allow a conversion's time for each that can be.
        signal: AbortSignal.timeout(settings.timeoutMs * settings.concurrency),
      });
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        throw new HttpError(422, options.fail, 'conversion_failed');
      }
      const converted = await readLimited(res, settings.maxBytes * 2);
      if (!options.valid(converted)) throw new HttpError(422, options.invalid, 'conversion_failed');
      return converted;
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
  }

  app.post<{ Params: { id: string } }>('/workspaces/:id/presentations/convert', async (req, reply) => {
    await assertWorkspaceAccess(req, req.params.id, 'slides.create', 'slides');
    const converted = await convertUpload(req, CONVERTIBLE_EXTENSIONS, {
      fail: 'The converter could not read that file. If it came from Keynote, export it to .pptx from Keynote, or import it as a PDF.',
      // A .pptx is a zip; anything else means the converter did not do its job.
      valid: (out) => out.length >= 4 && out.readUInt32LE(0) === 0x04034b50,
      invalid: 'The converter did not produce a presentation from that file',
    });
    return reply.header('Cache-Control', 'no-store').type(PPTX_MIME).send(converted);
  });

  /**
   * A Windows metafile picture from an imported deck, drawn to a PNG. The
   * browser asks for the size it wants (`width`, `height` in pixels), from the
   * picture's own header, so a chart is not imported at its tiny printed size.
   */
  app.post<{ Params: { id: string }; Querystring: { width?: string; height?: string } }>(
    '/workspaces/:id/presentations/convert-picture',
    async (req, reply) => {
      await assertWorkspaceAccess(req, req.params.id, 'slides.create', 'slides');
      const width = pixelSide(req.query.width);
      const height = pixelSide(req.query.height);
      const converted = await convertUpload(req, PICTURE_EXTENSIONS, {
        query: width && height ? `&width=${width}&height=${height}` : '',
        fail: 'The converter could not read that picture',
        valid: (out) => out.subarray(0, 4).equals(PNG_SIGNATURE),
        invalid: 'The converter did not produce a picture from that file',
      });
      return reply.header('Cache-Control', 'no-store').type('image/png').send(converted);
    },
  );
};
