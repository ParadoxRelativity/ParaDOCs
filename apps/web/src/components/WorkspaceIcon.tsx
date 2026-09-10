import { useState } from 'react';
import { colorFromString, cx } from '../lib/util';

const SIZES = {
  sm: 'h-5 w-5 text-[10px] rounded',
  md: 'h-6 w-6 text-xs rounded-md',
  lg: 'h-12 w-12 text-lg rounded-xl',
} as const;

/**
 * A workspace's picture, else its icon, else a colored monogram from the name
 * — deliberate-looking, and distinguishable between workspaces, which a shared
 * fallback emoji was not.
 */
export default function WorkspaceIcon({
  name,
  icon,
  avatarUrl,
  size = 'md',
}: {
  name: string;
  icon: string | null | undefined;
  avatarUrl?: string | null;
  size?: keyof typeof SIZES;
}) {
  // A picture that will not load falls back to the icon or monogram.
  const [failedUrl, setFailedUrl] = useState<string | null>(null);

  if (avatarUrl && avatarUrl !== failedUrl) {
    return (
      <img
        src={avatarUrl}
        alt=""
        draggable={false}
        onError={() => setFailedUrl(avatarUrl)}
        className={cx('shrink-0 object-cover', SIZES[size])}
      />
    );
  }

  if (icon) {
    return (
      <span className={cx('grid shrink-0 place-items-center', SIZES[size])} aria-hidden>
        {icon}
      </span>
    );
  }

  const initial = name.trim().slice(0, 1).toUpperCase() || '?';
  return (
    <span
      aria-hidden
      className={cx('grid shrink-0 place-items-center font-semibold text-white', SIZES[size])}
      style={{ background: colorFromString(name) }}
    >
      {initial}
    </span>
  );
}
