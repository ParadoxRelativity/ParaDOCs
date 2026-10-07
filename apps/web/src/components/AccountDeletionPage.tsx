import { useNavigate } from 'react-router-dom';
import AccountDeletion from './AccountDeletion';
import Banner from './Banner';
import Icon from './Icon';
import PrivacyLink from './PrivacyLink';
import { Button } from './ui';

/**
 * /account/delete: the address Google Play lists for deleting an account
 * without the app. Signed out, the sign-in screen explains what this is for
 * (see App.tsx); signed in, it is the same request settings offers.
 */
export default function AccountDeletionPage() {
  const navigate = useNavigate();
  return (
    <div className="flex h-full items-center justify-center overflow-y-auto bg-[var(--color-surface)] p-6">
      <div className="w-full max-w-md rounded-xl border border-[var(--color-line)] bg-[var(--color-raised)] p-6 shadow-sm">
        <Banner />
        <h1 className="mb-3 text-lg font-semibold">Delete your account</h1>
        <AccountDeletion />
        <p className="mt-4 text-xs text-[var(--color-muted)]">
          You can also do this in the ParaDOCs app, under Settings → Account → Delete account.
        </p>
        <div className="mt-4 flex items-center justify-between border-t border-[var(--color-line)] pt-4">
          <Button variant="subtle" className="text-xs" onClick={() => navigate('/')}>
            <Icon name="arrow-left" /> Back to ParaDOCs
          </Button>
          <PrivacyLink />
        </div>
      </div>
    </div>
  );
}
