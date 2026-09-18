import type { Doc } from '@paradocs/shared';
import type { DocumentPatch } from '../api/hooks';
import { cx } from '../lib/util';
import { EmptyState } from './ui';
import Icon, { type IconName } from './Icon';
import TableOfContents from './panels/TableOfContents';
import CalendarPanel from './panels/CalendarPanel';
import PropertiesPanel from './panels/PropertiesPanel';
import CommentsPanel from './panels/CommentsPanel';

export type RightTab = 'toc' | 'calendar' | 'properties' | 'comments';

const TABS: { id: RightTab; label: string; icon: IconName }[] = [
  { id: 'toc', label: 'Contents', icon: 'list-nested' },
  { id: 'calendar', label: 'Calendar', icon: 'calendar3' },
  { id: 'properties', label: 'Properties', icon: 'sliders' },
  { id: 'comments', label: 'Comments', icon: 'chat-left-text' },
];

interface Props {
  tab: RightTab;
  onTabChange: (tab: RightTab) => void;
  doc: Doc | undefined;
  /** Live blocks from the editor, so the outline updates as the user types. */
  liveBlocks: unknown[];
  workspaceId: string;
  currentUserId: string;
  onPatch: (patch: DocumentPatch) => void;
  onDelete: () => void;
}

export default function RightSidebar(props: Props) {
  return (
    <div className="flex h-full flex-col bg-[var(--color-surface)]">
      <div className="flex border-b border-[var(--color-line)]">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => props.onTabChange(tab.id)}
            title={tab.label}
            className={cx(
              'flex-1 border-b-2 py-2 text-xs transition-colors',
              props.tab === tab.id
                ? 'border-[var(--color-accent)] text-[var(--color-ink)]'
                : 'border-transparent text-[var(--color-muted)] hover:text-[var(--color-ink)]',
            )}
          >
            <Icon name={tab.icon} className="block" />
            <span className="mt-0.5 block text-[10px]">{tab.label}</span>
          </button>
        ))}
      </div>

      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        {props.tab === 'calendar' ? (
          <CalendarPanel workspaceId={props.workspaceId} documentId={props.doc?.id ?? null} />
        ) : !props.doc ? (
          <EmptyState icon="file-earmark-text" title="No document open" />
        ) : props.tab === 'toc' ? (
          <TableOfContents blocks={props.liveBlocks} />
        ) : props.tab === 'properties' ? (
          <PropertiesPanel
            doc={props.doc}
            workspaceId={props.workspaceId}
            onPatch={props.onPatch}
            onDelete={props.onDelete}
          />
        ) : (
          <CommentsPanel documentId={props.doc.id} currentUserId={props.currentUserId} />
        )}
      </div>
    </div>
  );
}
