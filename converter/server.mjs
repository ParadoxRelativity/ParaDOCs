// The ParaDOCs presentation converter: LibreOffice behind a one-endpoint HTTP
// server, run as an optional sidecar container (see docs/slides-converter.md).
//
//   POST /convert?extension=.ppt   body: the file's bytes
//   200  the converted .pptx       4xx/5xx  an error, no body worth reading
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

const PORT = Number(process.env.PORT || 3000);
const MAX_BYTES = Math.floor(Number(process.env.MAX_MB || 50) * 1024 * 1024);
const TIMEOUT_MS = Math.floor(Number(process.env.TIMEOUT_SECONDS || 55) * 1000);
const MAX_QUEUE = Number(process.env.MAX_QUEUE || 2);
const SOFFICE = process.env.SOFFICE_BIN || 'soffice';
const EXTENSIONS = new Set(['.ppt', '.pps', '.pot', '.key', '.odp']);

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

async function convert(data, extension, signal) {
  const dir = await mkdtemp(join(tmpdir(), 'convert-'));
  try {
    const input = join(dir, `input${extension}`);
    await writeFile(input, data);
    await runSoffice([
      '--headless',
      '--norestore',
      '--nolockcheck',
      '--nodefault',
      '--nofirststartwizard',
      `-env:UserInstallation=file://${join(dir, 'profile')}`,
      '--convert-to',
      'pptx',
      '--outdir',
      dir,
      input,
    ], signal);
    return await readFile(join(dir, 'input.pptx'));
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
  if (!EXTENSIONS.has(extension)) return fail(400, 'unsupported extension');
  try {
    const data = await readBody(req);
    if (data.length === 0) return fail(400, 'empty body');
    // The app stops waiting after its own time limit; when it does, so does this.
    const gone = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) gone.abort();
    });
    const queued = exclusive(() => convert(data, extension, gone.signal), gone.signal);
    if (!queued) return fail(503, 'busy');
    const pptx = await queued;
    res.writeHead(200, {
      'content-type': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'content-length': pptx.length,
    });
    res.end(pptx);
  } catch (err) {
    fail(err?.status ?? 500, err?.status ? err.message : 'conversion failed');
  }
});

// A client that sends slowly must not hold a connection open for ever.
server.requestTimeout = 30_000;
server.headersTimeout = 10_000;
server.listen(PORT, '0.0.0.0', () => console.log(`converter listening on ${PORT}`));
