import { afterEach, describe, expect, it, vi } from 'vitest';
import { convertingWindowsPictures, metafileSize } from '../src/lib/windowsPictures';

vi.mock('../src/lib/server', () => ({
  serverUrl: (path: string) => path,
  authHeaders: () => ({}),
}));

/** An EMF header: its frame in hundredths of a millimetre, on a 1920 × 1080 px, 508 × 285.75 mm reference device. */
function emfHeader(frame: [number, number, number, number]): Uint8Array {
  const data = new Uint8Array(108);
  const view = new DataView(data.buffer);
  view.setUint32(0, 1, true);
  view.setUint32(4, 108, true);
  frame.forEach((v, i) => view.setInt32(24 + i * 4, v, true));
  view.setUint32(40, 0x464d4520, true);
  [1920, 1080, 508, 286].forEach((v, i) => view.setInt32(72 + i * 4, v, true));
  return data;
}

/** A placeable WMF header: its bounding box, at `inch` units to the inch. */
function wmfHeader(box: [number, number, number, number], inch: number): Uint8Array {
  const data = new Uint8Array(40);
  const view = new DataView(data.buffer);
  view.setUint32(0, 0x9ac6cdd7, true);
  box.forEach((v, i) => view.setInt16(6 + i * 2, v, true));
  view.setUint16(14, inch, true);
  return data;
}

describe('metafileSize', () => {
  it('reads an EMF frame in device units and asks for a PNG twice its printed size', () => {
    // 127 mm by 63.5 mm: 5 by 2.5 inches.
    const size = metafileSize(emfHeader([0, 0, 12700, 6350]), 'image/emf')!;
    expect(size.width).toBeCloseTo(480);
    expect(size.pixelWidth).toBe(960);
    expect(size.pixelHeight).toBe(480);
  });

  it('keeps a large picture within the largest PNG side', () => {
    const size = metafileSize(emfHeader([0, 0, 50800, 25400]), 'image/emf')!;
    expect([size.pixelWidth, size.pixelHeight]).toEqual([2400, 1200]);
  });

  it('reads a placeable WMF box', () => {
    const size = metafileSize(wmfHeader([100, 50, 1540, 770], 1440), 'image/wmf')!;
    expect(size).toEqual({
      width: 1440,
      height: 720,
      pixelWidth: 192,
      pixelHeight: 96,
    });
  });

  it('gives up on a header that does not say', () => {
    expect(metafileSize(new Uint8Array([1, 0, 0, 0, 32, 69, 77, 70]), 'image/emf')).toBeNull();
    expect(metafileSize(new Uint8Array(40), 'image/wmf')).toBeNull();
  });
});

describe('convertingWindowsPictures', () => {
  afterEach(() => vi.unstubAllGlobals());

  const emf = () =>
    new File([emfHeader([0, 0, 12700, 6350]) as BlobPart], 'image1.emf', {
      type: 'image/emf',
    });

  it('uploads the PNG the server makes, asking for its size', async () => {
    const fetch = vi.fn(async () => new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const uploaded: File[] = [];
    await convertingWindowsPictures('ws-convert', async (file) => uploaded.push(file))(emf());
    expect(String((fetch.mock.calls[0] as unknown[])[0])).toContain('/presentations/convert-picture?width=960&height=480');
    expect(uploaded.map((f) => [f.name, f.type])).toEqual([['image1.png', 'image/png']]);
  });

  it('passes other files straight through', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const png = new File([new Uint8Array(4)], 'a.png', { type: 'image/png' });
    const uploaded: File[] = [];
    await convertingWindowsPictures('ws-plain', async (file) => uploaded.push(file))(png);
    expect(uploaded).toEqual([png]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('fails the upload when there is no converter and no browser to draw it', async () => {
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ code: 'converter_disabled' }), {
          status: 501,
        }),
    );
    vi.stubGlobal('fetch', fetch);
    const upload = vi.fn();
    const convert = convertingWindowsPictures('ws-none', upload);
    await expect(convert(emf())).rejects.toThrow('Could not turn image1.emf into a picture');
    // The server said it has no converter, so it is not asked again.
    await expect(convert(emf())).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(upload).not.toHaveBeenCalled();
  });

  it('sends pictures to the converter one at a time, as an import uploads several at once', async () => {
    let running = 0;
    let most = 0;
    const fetch = vi.fn(async () => {
      running += 1;
      most = Math.max(most, running);
      await new Promise((resolve) => setTimeout(resolve, 10));
      running -= 1;
      return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), { status: 200 });
    });
    vi.stubGlobal('fetch', fetch);
    const uploaded: string[] = [];
    const convert = convertingWindowsPictures('ws-queue', async (file) => uploaded.push(file.type));
    await Promise.all([convert(emf()), convert(emf()), convert(emf())]);
    expect(most).toBe(1);
    expect(uploaded).toEqual(['image/png', 'image/png', 'image/png']);
  });

  it('offers a picture again when the converter is busy, rather than drawing it in the browser', async () => {
    const answers = [503, 503, 200];
    const fetch = vi.fn(async () => {
      const status = answers.shift()!;
      return status === 200
        ? new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), { status })
        : new Response(JSON.stringify({ code: 'converter_busy' }), { status, headers: { 'retry-after': '0.01' } });
    });
    vi.stubGlobal('fetch', fetch);
    const uploaded: File[] = [];
    await convertingWindowsPictures('ws-busy', async (file) => uploaded.push(file))(emf());
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(uploaded.map((f) => f.type)).toEqual(['image/png']);
  });
});
