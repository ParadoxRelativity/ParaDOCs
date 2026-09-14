import { sheetCollabName } from '@paradocs/shared';
import { useSpreadsheet, useUpdateSpreadsheet } from '../../api/hooks';
import { useCollaboration } from '../../lib/collaboration';
import { EmptyState, Spinner } from '../ui';
import SheetEditor from './SheetEditor';

/**
 * One open spreadsheet: its record from the API, and its grid over the
 * collaboration socket.
 *
 * The session is named `sheet:<id>`, which is how the collaboration server
 * knows to load and save it from the spreadsheets table rather than from
 * documents. That prefix is the only thing this app and the documents app
 * agree on.
 */
export default function SpreadsheetView({
  workspaceId,
  sheetId,
  self,
  canEdit,
}: {
  workspaceId: string;
  sheetId: string;
  self: { id: string; name: string; avatarUrl: string | null };
  canEdit: boolean;
}) {
  const record = useSpreadsheet(sheetId);
  const rename = useUpdateSpreadsheet(workspaceId);
  const { session, peers } = useCollaboration(sheetCollabName(sheetId), self);

  if (record.isLoading) return <Spinner />;
  if (record.error || !record.data) {
    return (
      <EmptyState
        icon="exclamation-triangle"
        title="Could not open that spreadsheet"
        hint={record.error instanceof Error ? record.error.message : 'It may have been deleted.'}
      />
    );
  }
  // The grid cannot be drawn before its Y.Doc exists.
  if (!session) return <Spinner />;

  return (
    <SheetEditor
      // Rebuilt per spreadsheet, so selection and an open cell editor never
      // carry over from the last one.
      key={sheetId}
      sheet={record.data}
      canEdit={canEdit}
      session={session}
      peers={peers}
      onRename={(title) => rename.mutate({ id: sheetId, title })}
    />
  );
}
