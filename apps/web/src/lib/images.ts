/**
 * Centre-crops an image to a square and scales it down, so a profile picture
 * uploads as a small file and displays the same in every circle it fills.
 *
 * WebP where the browser can encode it; others fall back to PNG, which the
 * server accepts just the same. Animated GIFs keep only their first frame.
 */
export async function squareImage(file: File, size = 256): Promise<Blob> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error('That file is not an image this browser can read.');
  }

  const side = Math.min(bitmap.width, bitmap.height);
  const target = Math.min(size, side);
  const canvas = document.createElement('canvas');
  canvas.width = target;
  canvas.height = target;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Could not process that image.');
  context.imageSmoothingQuality = 'high';
  context.drawImage(
    bitmap,
    (bitmap.width - side) / 2,
    (bitmap.height - side) / 2,
    side,
    side,
    0,
    0,
    target,
    target,
  );
  bitmap.close();

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Could not process that image.'))),
      'image/webp',
      0.9,
    );
  });
}
