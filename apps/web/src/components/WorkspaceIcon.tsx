import { colorFromString, cx } from '../lib/util';

const SIZES = {
  sm: 'h-5 w-5 text-[10px] rounded',
  md: 'h-6 w-6 text-xs rounded-md',
  lg: 'h-12 w-12 text-lg rounded-xl',
} as const;

/**
 * A workspace icon is optional. Without one, a colored monogram from the name
 * stands in — deliberate-looking, and distinguishable between workspaces, which
 * a shared fallback emoji was not.
 */
export default function WorkspaceIcon({
  name,
  icon,
  size = 'md',
}: {
  name: string;
  icon: string | null | undefined;
  size?: keyof typeof SIZES;
}) {
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
