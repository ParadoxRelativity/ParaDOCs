// The ParaDOCs presentation converter: LibreOffice behind a one-endpoint HTTP
// server, run as an optional sidecar container (see docs/slides-converter.md).
//
//   POST /convert?extension=.ppt   body: the file's bytes
//   200  the converted .pptx       4xx/5xx  an error, no body worth reading
//   POST /convert?extension=.emf&width=1600&height=900
//   200  the picture as a PNG, that many pixels if given (.emf, .wmf); its
//        width and height should be in the picture's own proportions
//   GET  /health                   200 when it is up
//
// It treats every file as hostile. Each request gets its own throwaway
// directory and LibreOffice profile, deleted when the request ends however it
// ends; nothing is kept between requests. LibreOffice is killed (with whatever
// it started) if it runs past the time limit. Only one conversion runs at a
// time and only a short queue waits, so a flood of requests cannot pile up. A
// request whose client has gone (the app gave up on it) is dropped from the
// queue, or its LibreOffice killed, so abandoned work never delays the next.
//
// No dependencies: Node's standard library only.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';

const PORT = Number(process.env.PORT || 3000);
const MAX_BYTES = Math.floor(Number(process.env.MAX_MB || 50) * 1024 * 1024);
const TIMEOUT_MS = Math.floor(Number(process.env.TIMEOUT_SECONDS || 55) * 1000);
const MAX_QUEUE = Number(process.env.MAX_QUEUE || 2);
const SOFFICE = process.env.SOFFICE_BIN || 'soffice';
// What each extension becomes: presentations a .pptx, Windows metafile pictures a PNG.
const TARGETS = new Map([
  ['.ppt', 'pptx'],
  ['.pps', 'pptx'],
  ['.pot', 'pptx'],
  ['.key', 'pptx'],
  ['.odp', 'pptx'],
  ['.emf', 'png'],
  ['.wmf', 'png'],
]);

/** A requested PNG side in pixels, or undefined when it is not a whole number from 1 to 4000. */
const pixelSide = (value) => {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 4000 ? n : undefined;
};

let busy = false;
const waiting = [];

/** Runs `task` when no other conversion is running; null if too many are already waiting. */
function exclusive(task, signal) {
  if (busy && waiting.length >= MAX_QUEUE) return null;
  return new Promise((resolve, reject) => {
    const run = () => {
      // Its client left while it waited: skip it and let the next one go.
      if (signal.aborted) {
        reject(Object.assign(new Error('client gone'), { status: 499 }));
        waiting.shift()?.();
        return;
      }
      busy = true;
      task()
        .then(resolve, reject)
        .finally(() => {
          busy = false;
          waiting.shift()?.();
        });
    };
    if (busy) waiting.push(run);
    else run();
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (declared > MAX_BYTES) return reject(Object.assign(new Error('too large'), { status: 413 }));
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > MAX_BYTES) {
        req.destroy();
        reject(Object.assign(new Error('too large'), { status: 413 }));
      } else chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Runs LibreOffice and kills its whole process group once the time is up or the client has gone. */
function runSoffice(args, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(SOFFICE, args, { stdio: 'ignore', detached: true });
    const stop = (error) => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
      reject(error);
    };
    const timer = setTimeout(() => stop(Object.assign(new Error('timed out'), { status: 504 })), TIMEOUT_MS);
    const onAbort = () => stop(Object.assign(new Error('client gone'), { status: 499 }));
    signal.addEventListener('abort', onAbort, { once: true });
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    };
    child.on('error', (err) => {
      done();
      reject(err);
    });
    child.on('exit', (code) => {
      done();
      if (code === 0) resolve();
      else reject(Object.assign(new Error(`soffice exited with ${code}`), { status: 422 }));
    });
  });
}

/** A zip of `files` ([name, bytes] in order), every entry stored uncompressed. */
function zip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of files) {
    const nameBytes = Buffer.from(name);
    const body = Buffer.from(content);
    const crc = crc32(body);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(body.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, body);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/**
 * A Draw document whose one page is exactly the picture, the picture filling
 * it. Opened directly, LibreOffice puts a metafile on a default page (Letter
 * or A4, by locale) and exports the whole page, so the picture came back
 * small, surrounded by paper, and stretched to the size asked for. The page's
 * shape is the size asked for, which the app takes from the picture's frame:
 * the part of the picture PowerPoint shows.
 */
function pictureDocument(data, extension, size) {
  const name = `Pictures/picture${extension}`;
  const mime = extension === '.emf' ? 'image/x-emf' : 'image/x-wmf';
  const w = `${size.width / 96}in`;
  const h = `${size.height / 96}in`;
  const ns =
    'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" ' +
    'xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" ' +
    'xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" xmlns:xlink="http://www.w3.org/1999/xlink"';
  const manifest =
    '<?xml version="1.0" encoding="UTF-8"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2">' +
    '<manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.graphics" manifest:version="1.2"/>' +
    '<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>' +
    '<manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/>' +
    `<manifest:file-entry manifest:full-path="${name}" manifest:media-type="${mime}"/></manifest:manifest>`;
  const styles =
    `<?xml version="1.0" encoding="UTF-8"?><office:document-styles ${ns} office:version="1.2">` +
    // An empty office:styles, without which LibreOffice ignores the page layout and uses its default page.
    '<office:styles/><office:automatic-styles>' +
    `<style:page-layout style:name="PM0"><style:page-layout-properties fo:margin-top="0in" fo:margin-bottom="0in" fo:margin-left="0in" fo:margin-right="0in" fo:page-width="${w}" fo:page-height="${h}"/></style:page-layout>` +
    '</office:automatic-styles><office:master-styles><style:master-page style:name="Default" style:page-layout-name="PM0"/></office:master-styles></office:document-styles>';
  const content =
    `<?xml version="1.0" encoding="UTF-8"?><office:document-content ${ns} office:version="1.2"><office:automatic-styles>` +
    '<style:style style:name="gr1" style:family="graphic"><style:graphic-properties draw:stroke="none" draw:fill="none"/></style:style>' +
    '</office:automatic-styles><office:body><office:drawing><draw:page draw:name="picture" draw:master-page-name="Default">' +
    `<draw:frame draw:style-name="gr1" svg:x="0in" svg:y="0in" svg:width="${w}" svg:height="${h}">` +
    `<draw:image xlink:href="${name}" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"/></draw:frame>` +
    '</draw:page></office:drawing></office:body></office:document-content>';
  // The mimetype comes first, stored, as OpenDocument requires.
  return zip([
    ['mimetype', 'application/vnd.oasis.opendocument.graphics'],
    ['META-INF/manifest.xml', manifest],
    ['styles.xml', styles],
    ['content.xml', content],
    [name, data],
  ]);
}

async function convert(data, extension, size, signal) {
  const target = TARGETS.get(extension);
  // A picture with a size goes on a page of exactly that shape, drawn at that many pixels.
  const fitted = target === 'png' && size;
  const format = fitted
    ? `png:draw_png_Export:${JSON.stringify({ PixelWidth: { type: 'long', value: String(size.width) }, PixelHeight: { type: 'long', value: String(size.height) } })}`
    : target;
  const dir = await mkdtemp(join(tmpdir(), 'convert-'));
  try {
    const input = join(dir, fitted ? 'input.odg' : `input${extension}`);
    await writeFile(input, fitted ? pictureDocument(data, extension, size) : data);
    await runSoffice([
      '--headless',
      '--norestore',
      '--nolockcheck',
      '--nodefault',
      '--nofirststartwizard',
      `-env:UserInstallation=file://${join(dir, 'profile')}`,
      '--convert-to',
      format,
      '--outdir',
      dir,
      input,
    ], signal);
    return await readFile(join(dir, `input.${target}`));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://converter');
  const fail = (status, message) => {
    if (!res.headersSent) res.writeHead(status, { 'content-type': 'text/plain' });
    res.end(message);
  };
  if (req.method === 'GET' && url.pathname === '/health') return fail(200, 'ok');
  if (req.method !== 'POST' || url.pathname !== '/convert') return fail(404, 'not found');
  const extension = (url.searchParams.get('extension') || '').toLowerCase();
  if (!TARGETS.has(extension)) return fail(400, 'unsupported extension');
  const width = pixelSide(url.searchParams.get('width'));
  const height = pixelSide(url.searchParams.get('height'));
  const size = width && height ? { width, height } : null;
  try {
    const data = await readBody(req);
    if (data.length === 0) return fail(400, 'empty body');
    // The app stops waiting after its own time limit; when it does, so does this.
    const gone = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) gone.abort();
    });
    const queued = exclusive(() => convert(data, extension, size, gone.signal), gone.signal);
    if (!queued) return fail(503, 'busy');
    const converted = await queued;
    res.writeHead(200, {
      'content-type': TARGETS.get(extension) === 'png' ? 'image/png' : 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'content-length': converted.length,
    });
    res.end(converted);
  } catch (err) {
    fail(err?.status ?? 500, err?.status ? err.message : 'conversion failed');
  }
});

// A client that sends slowly must not hold a connection open for ever.
server.requestTimeout = 30_000;
server.headersTimeout = 10_000;
server.listen(PORT, '0.0.0.0', () => console.log(`converter listening on ${PORT}`));
