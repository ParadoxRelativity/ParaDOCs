import { PRIVACY_POLICY_URL } from '@paradocs/shared';
import { isNativeApp } from '../lib/server';
import { cx } from '../lib/util';

/**
 * The apps' privacy policy, which both app stores want reachable from inside
 * the app. The mobile app opens it in an in-app browser sheet, the same way
 * single sign-on opens, rather than following the link out of its own page.
 * Elsewhere it is a new tab, which the desktop app hands to the system browser.
 */
export default function PrivacyLink({ className }: { className?: string }) {
  return (
    <a
      href={PRIVACY_POLICY_URL}
      target="_blank"
      rel="noreferrer"
      className={cx('text-xs text-[var(--color-muted)] hover:text-[var(--color-ink)] hover:underline', className)}
      onClick={(e) => {
        if (!isNativeApp) return;
        e.preventDefault();
        void import('@capacitor/browser').then(({ Browser }) => Browser.open({ url: PRIVACY_POLICY_URL }));
      }}
    >
      Privacy policy
    </a>
  );
}
