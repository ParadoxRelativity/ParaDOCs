import { useState, type CSSProperties } from 'react';
import { colorFromString, cx } from '../lib/util';

const SIZES = {
  xs: 'h-4 w-4 text-[9px]',
  sm: 'h-5 w-5 text-[10px]',
  md: 'h-6 w-6 text-[10px]',
  lg: 'h-8 w-8 text-xs',
  xl: 'h-16 w-16 text-2xl',
} as const;

/**
 * A person's profile picture, or a colored initial when they have none. The
 * color is drawn from `seed` — their id, where it is known — so it stays put
 * when someone renames themselves.
 */
export default function Avatar({
  name,
  url,
  seed,
  size = 'md',
  title,
  className,
  style,
}: {
  name: string;
  url?: string | null;
  seed?: string;
  size?: keyof typeof SIZES;
  title?: string;
  className?: string;
  style?: CSSProperties;
}) {
  // A picture that will not load (removed from disk, say) falls back to the initial.
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const base = cx('grid shrink-0 select-none place-items-center overflow-hidden rounded-full', SIZES[size], className);

  if (url && url !== failedUrl) {
    return (
      <img
        src={url}
        alt=""
        title={title}
        draggable={false}
        onError={() => setFailedUrl(url)}
        className={cx(base, 'object-cover')}
        style={style}
      />
    );
  }

  return (
    <span
      aria-hidden
      title={title}
      className={cx(base, 'font-semibold text-white')}
      style={{ background: colorFromString(seed ?? name), ...style }}
    >
      {name.trim().slice(0, 1).toUpperCase() || '?'}
    </span>
  );
}
