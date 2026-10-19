import { useEffect } from 'react';
import { slidesCollabName } from '@paradocs/shared';
import { useMarkMentionsRead, useNotifications, usePresentation } from '../../api/hooks';
import { useCollaboration } from '../../lib/collaboration';
import { EmptyState, Spinner } from '../ui';
import SlidesEditor from './SlidesEditor';

/**
 * One open presentation: its record from the API, and its slides over the
 * collaboration socket.
 *
 * The session is named `slides:<id>`, which is how the collaboration server
 * knows to load and save it from the presentations table.
 */
export default function PresentationView({
  workspaceId,
  presentationId,
  self,
  canEdit,
}: {
  workspaceId: string;
  presentationId: string;
  self: { id: string; name: string; avatarUrl: string | null };
  canEdit: boolean;
}) {
  const record = usePresentation(presentationId);
  const { session, peers, status } = useCollaboration(slidesCollabName(presentationId), self);

  // Opening a deck you were tagged in answers the tag, however you got here.
  const notifications = useNotifications();
  const markMentionsRead = useMarkMentionsRead();
  const taggedHere = notifications.data?.mentions?.some((m) => m.documentId === presentationId) ?? false;
  useEffect(() => {
    if (taggedHere) markMentionsRead.mutate([presentationId]);
    // The mutation object is stable; including it would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presentationId, taggedHere]);

  if (record.isLoading) return <Spinner />;
  if (record.error || !record.data) {
    return (
      <EmptyState
        icon="exclamation-triangle"
        title="Could not open that presentation"
        hint={record.error instanceof Error ? record.error.message : 'It may have been deleted.'}
      />
    );
  }
  // The stage cannot be drawn before its Y.Doc exists.
  if (!session) return <Spinner />;

  return (
    <SlidesEditor
      // Rebuilt per presentation, so selection and an open text edit never carry over from the last one.
      key={presentationId}
      presentation={record.data}
      workspaceId={workspaceId}
      canEdit={canEdit}
      session={session}
      peers={peers}
      status={status}
    />
  );
}
