import { useNavigate, useParams } from 'react-router-dom';
import { useAcceptInvite, useInvitePreview } from '../api/hooks';
import { Button, EmptyState, Spinner } from './ui';
import WorkspaceIcon from './WorkspaceIcon';
import { useToast } from './Toast';

/** Landing page for an invite link. The user is already signed in by this point. */
export default function AcceptInvite() {
  const { token = '' } = useParams();
  const navigate = useNavigate();
  const preview = useInvitePreview(token);
  const accept = useAcceptInvite();
  const toast = useToast();

  if (preview.isLoading) return <Spinner />;
  if (preview.error) {
    return (
      <EmptyState
        icon="link-45deg"
        title="This invite is not valid"
        hint={(preview.error as Error).message}
      />
    );
  }

  const invite = preview.data!;

  return (
    <div className="flex h-full items-center justify-center bg-[var(--color-surface)] p-6">
      <div className="w-full max-w-sm rounded-xl border border-[var(--color-line)] bg-[var(--color-raised)] p-6 text-center shadow-sm">
        <div className="flex justify-center">
          <WorkspaceIcon
            name={invite.workspaceName}
            icon={invite.workspaceIcon}
            avatarUrl={invite.workspaceAvatarUrl}
            size="lg"
          />
        </div>
        <h1 className="mt-2 text-lg font-semibold">{invite.workspaceName}</h1>
        <p className="mt-1 text-sm text-[var(--color-muted)]">
          {invite.alreadyMember
            ? 'You are already a member of this workspace.'
            : `${invite.invitedBy ?? 'Someone'} invited you to join as ${invite.role}.`}
        </p>

        <div className="mt-5 flex gap-2">
          <Button variant="subtle" className="flex-1 justify-center text-xs" onClick={() => navigate('/')}>
            Not now
          </Button>
          <Button
            variant="primary"
            className="flex-1 justify-center text-xs"
            disabled={accept.isPending}
            onClick={() =>
              accept.mutate(token, {
                onSuccess: (result) => {
                  toast(result.alreadyMember ? 'Opening workspace' : `Joined ${invite.workspaceName}`);
                  navigate(`/w/${result.workspaceId}`);
                },
                onError: (err) =>
                  toast(err instanceof Error ? err.message : 'Could not accept invite', 'error'),
              })
            }
          >
            {invite.alreadyMember ? 'Open workspace' : 'Join workspace'}
          </Button>
        </div>
      </div>
    </div>
  );
}
