import type { WorkspaceSummary } from '../api/hooks';
import MembersPanel from './MembersPanel';
import TeamsPanel from './TeamsPanel';

/** The pages of the People app, each under its own name in the path. */
export type PeopleSection = 'members' | 'teams';

export function isPeopleSection(value: string | undefined): value is PeopleSection {
  return value === 'members' || value === 'teams';
}

const TITLES: Record<PeopleSection, string> = {
  members: 'Members',
  teams: 'Teams',
};

/**
 * The People app: who is in the workspace, what each person may do, and the
 * teams they are on. It is named for what it shows rather than for who may
 * change it — everyone can look, and owners and admins make the changes, which
 * the server holds them to.
 */
export default function PeopleApp({ workspace, section }: { workspace: WorkspaceSummary; section: PeopleSection }) {
  return (
    <div className="scroll-thin h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-6 py-6">
        <h1 className="mb-4 text-lg font-semibold">{TITLES[section]}</h1>
        {section === 'members' ? (
          <MembersPanel workspaceId={workspace.id} myRole={workspace.role} />
        ) : (
          <TeamsPanel workspaceId={workspace.id} myRole={workspace.role} />
        )}
      </div>
    </div>
  );
}
