import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { startApi, type Api, type TestUser } from './harness.js';

/**
 * Converting a legacy presentation to .pptx: the route in front of the
 * optional converter sidecar. The sidecar is a local HTTP server standing in
 * for it, so the route's real fetch, limits and timeout are exercised.
 */
describe('presentation converter route', () => {
  let api: Api;
  let editor: TestUser;
  let viewer: TestUser;
  let ws: string;
  let sidecar: http.Server;
  let sidecarUrl: string;
  let config: typeof import('../src/config.js').config;
  const received: { extension: string | null; bytes: number }[] = [];
  let behaviour: (req: http.IncomingMessage, res: http.ServerResponse) => void;

  /** What a real .pptx starts with: a zip's local file header. */
  const PPTX = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('converted')]);

  const multipart = (name: string, data: Buffer) => {
    const boundary = '----convert-test';
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
      data,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    return { body, contentType: `multipart/form-data; boundary=${boundary}` };
  };
  const convert = async (user: TestUser | null, name: string, data: Buffer) => {
    const { body, contentType } = multipart(name, data);
    return api.app.inject({
      method: 'POST',
      url: `/api/workspaces/${ws}/presentations/convert`,
      headers: { ...(user ? { authorization: `Bearer ${user.token}` } : {}), 'content-type': contentType },
      payload: body,
    });
  };

  beforeAll(async () => {
    api = await startApi();
    config = (await import('../src/config.js')).config;
    editor = await api.register('Editor');
    viewer = await api.register('Viewer');
    ws = editor.workspaceId;
    await api.join(viewer, ws, 'Viewer');
    sidecar = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        received.push({ extension: new URL(req.url ?? '', 'http://x').searchParams.get('extension'), bytes: Buffer.concat(chunks).length });
        behaviour(req, res);
      });
    });
    await new Promise<void>((resolve) => sidecar.listen(0, '127.0.0.1', resolve));
    sidecarUrl = `http://127.0.0.1:${(sidecar.address() as AddressInfo).port}`;
  });

  afterEach(() => {
    received.length = 0;
    Object.assign(config.converter, { enabled: false, url: '', maxBytes: 50 * 1024 * 1024, timeoutMs: 60_000, concurrency: 2 });
  });

  afterAll(async () => {
    sidecar.closeAllConnections();
    await new Promise((resolve) => sidecar.close(resolve));
    await api.close();
  });

  const enable = (overrides: Partial<typeof config.converter> = {}) => {
    Object.assign(config.converter, { enabled: true, url: sidecarUrl, ...overrides });
    behaviour = (_req, res) => res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(PPTX);
  };

  it('is off by default: a clear error, and the status says so', async () => {
    const res = await convert(editor, 'old.ppt', Buffer.from('legacy'));
    expect(res.statusCode).toBe(501);
    expect(res.json()).toMatchObject({ code: 'converter_disabled' });
    expect(res.json().error).toMatch(/no converter/i);
    const status = await api.call(editor, 'GET', `/workspaces/${ws}/presentations/converter`);
    expect(status.body).toMatchObject({ enabled: false });
    expect(received).toHaveLength(0);
  });

  it('forwards the file to the sidecar and returns the .pptx it makes', async () => {
    enable();
    const res = await convert(editor, 'Old Deck.PPT', Buffer.from('legacy bytes'));
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('presentationml.presentation');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(Buffer.compare(res.rawPayload, PPTX)).toBe(0);
    expect(received).toEqual([{ extension: '.ppt', bytes: 12 }]);
    expect((await api.call(editor, 'GET', `/workspaces/${ws}/presentations/converter`)).body).toMatchObject({ enabled: true });
  });

  it('accepts the other legacy formats and refuses everything else', async () => {
    enable();
    for (const name of ['a.pps', 'a.pot', 'a.key', 'a.odp']) expect((await convert(editor, name, Buffer.from('x'))).statusCode).toBe(200);
    const refused = await convert(editor, 'notes.docx', Buffer.from('x'));
    expect(refused.statusCode).toBe(400);
    expect(received.map((r) => r.extension)).toEqual(['.pps', '.pot', '.key', '.odp']);
  });

  it('needs slides.create, and sign-in', async () => {
    enable();
    expect((await convert(viewer, 'old.ppt', Buffer.from('x'))).statusCode).toBe(403);
    expect((await convert(null, 'old.ppt', Buffer.from('x'))).statusCode).toBe(401);
    expect((await api.call(viewer, 'GET', `/workspaces/${ws}/presentations/converter`)).status).toBe(403);
    expect(received).toHaveLength(0);
  });

  it('refuses a file over the size limit without sending it on', async () => {
    enable({ maxBytes: 1024 });
    const res = await convert(editor, 'big.ppt', Buffer.alloc(4096, 1));
    expect(res.statusCode).toBe(413);
    expect(res.json().code).toBe('file_too_large');
    expect(received).toHaveLength(0);
  });

  it('stops a conversion that takes too long, and keeps serving afterwards', async () => {
    enable({ timeoutMs: 150 });
    behaviour = () => undefined; // never answers
    const res = await convert(editor, 'hang.ppt', Buffer.from('x'));
    expect(res.statusCode).toBe(504);
    expect(res.json().code).toBe('conversion_timeout');
    enable();
    expect((await convert(editor, 'fine.ppt', Buffer.from('x'))).statusCode).toBe(200);
    expect((await api.call(editor, 'GET', '/health')).status).toBeLessThan(500);
  });

  it('waits for a conversion queued behind another instead of giving up on it', async () => {
    enable({ timeoutMs: 250, concurrency: 2 });
    // Like the sidecar: one file at a time, each taking most of the time limit.
    let free = Promise.resolve();
    behaviour = (_req, res) => {
      free = free.then(
        () => new Promise<void>((resolve) => setTimeout(() => (res.writeHead(200).end(PPTX), resolve()), 200)),
      );
    };
    const [first, second] = await Promise.all([convert(editor, 'a.ppt', Buffer.from('x')), convert(editor, 'b.ppt', Buffer.from('y'))]);
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
  });

  it('rejects a file the converter cannot read, or answers with something that is not a presentation', async () => {
    enable();
    behaviour = (_req, res) => res.writeHead(500).end('boom');
    expect((await convert(editor, 'bad.ppt', Buffer.from('x'))).json().code).toBe('conversion_failed');
    behaviour = (_req, res) => res.writeHead(200).end('<html>not a zip</html>');
    expect((await convert(editor, 'bad.ppt', Buffer.from('x'))).statusCode).toBe(422);
  });

  it('says so when the converter is not reachable', async () => {
    enable({ url: 'http://127.0.0.1:1' });
    const res = await convert(editor, 'old.ppt', Buffer.from('x'));
    expect(res.statusCode).toBe(502);
    expect(res.json().code).toBe('converter_unavailable');
  });

  it('answers busy rather than queueing past its concurrency', async () => {
    enable({ concurrency: 1 });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    behaviour = (_req, res) => void gate.then(() => res.writeHead(200).end(PPTX));
    const first = convert(editor, 'one.ppt', Buffer.from('x'));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const second = await convert(editor, 'two.ppt', Buffer.from('x'));
    expect(second.statusCode).toBe(503);
    release();
    expect((await first).statusCode).toBe(200);
  });
});
