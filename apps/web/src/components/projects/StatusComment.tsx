import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';
import type { Project } from '@paradocs/shared';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import { keys } from '../../api/hooks';
import { Modal } from '../Modal';
import { useToast } from '../Toast';
import { Button } from '../ui';
import ReferenceEditor from './ReferenceEditor';

/**
 * What someone said when they moved work: a comment to post on each item
 * moved, nothing (they skipped it), or `false` when they called the move off.
 */
export type StatusAnswer = string | null | false;

interface Asking {
  project: Project;
  /** The keys of what is moving, for the dialog to name. */
  keys: string[];
  from: string | null;
  to: string;
  resolve: (answer: StatusAnswer) => void;
}

type Ask = (asking: Omit<Asking, 'resolve'>) => Promise<StatusAnswer>;

const AskContext = createContext<Ask | null>(null);

/**
 * Holds the dialog that asks why work is being moved, for every way of moving
 * it inside one project's view: the board, the backlog, the list and the
 * item's own panel.
 */
export function StatusCommentProvider({ workspaceId, children }: { workspaceId: string; children: ReactNode }) {
  const [asking, setAsking] = useState<Asking | null>(null);
  const ask = useCallback<Ask>((next) => new Promise((resolve) => setAsking({ ...next, resolve })), []);

  function answer(value: StatusAnswer) {
    asking?.resolve(value);
    setAsking(null);
  }

  return (
    <AskContext.Provider value={ask}>
      {children}
      {asking && <StatusCommentDialog workspaceId={workspaceId} asking={asking} onAnswer={answer} />}
    </AskContext.Provider>
  );
}

function StatusCommentDialog({
  workspaceId,
  asking,
  onAnswer,
}: {
  workspaceId: string;
  asking: Asking;
  onAnswer: (answer: StatusAnswer) => void;
}) {
  const { keys, from, to } = asking;
  const what = keys.length === 1 ? keys[0] : `${keys.length} items`;
  return (
    <Modal
      title="Say why it is moving"
      description={`${what} · ${from ? `${from} → ` : ''}${to}`}
      onClose={() => onAnswer(false)}
      footer={
        <>
          <Button variant="subtle" className="text-xs" onClick={() => onAnswer(false)}>
            Cancel
          </Button>
          <Button variant="subtle" className="text-xs" onClick={() => onAnswer(null)}>
            Skip
          </Button>
        </>
      }
    >
      <p className="mb-2 text-xs text-[var(--color-muted)]">
        {keys.length === 1
          ? 'The comment is posted on the item with the move.'
          : 'The comment is posted on each item moved.'}{' '}
        Cancel leaves {keys.length === 1 ? 'it' : 'them'} where {keys.length === 1 ? 'it was' : 'they were'}.
      </p>
      <ReferenceEditor
        workspaceId={workspaceId}
        autoFocus
        minRows={3}
        placeholder="Ready for review, waiting on design, …"
        submitLabel="Comment"
        onSubmit={(body) => onAnswer(body.trim() ? body : null)}
      />
    </Modal>
  );
}

/**
 * Asks why work is being moved, when its project asks for that, before the
 * move is made. A move inside the same status — reordering — never asks.
 * Resolves to what to post, null for nothing, or false to call the move off.
 *
 * `comment` posts the answer on the items the move went through for, once
 * the move has been saved, so the history reads the move and then why.
 */
export function useStatusComment(project: Project) {
  const ask = useContext(AskContext);
  const toast = useToast();
  const qc = useQueryClient();
  const projectRef = useRef(project);
  projectRef.current = project;

  /** Each item with the status it is going to, which a bulk move can give each its own. */
  const confirm = useCallback(
    async (moving: { key: string; statusId: string; toStatusId: string | null }[]): Promise<StatusAnswer> => {
      const current = projectRef.current;
      const changing = moving.filter((item) => item.toStatusId !== null && item.statusId !== item.toStatusId);
      if (!ask || !current.askStatusComment || changing.length === 0) return null;
      const name = (id: string) => current.statuses.find((s) => s.id === id)?.name ?? 'another status';
      const froms = [...new Set(changing.map((item) => item.statusId))];
      const tos = [...new Set(changing.map((item) => item.toStatusId!))];
      return ask({
        project: current,
        keys: changing.map((item) => item.key),
        from: froms.length === 1 ? name(froms[0]) : null,
        to: tos.map(name).join(', '),
      });
    },
    [ask],
  );

  const comment = useCallback(
    async (itemIds: string[], body: StatusAnswer) => {
      if (!body || itemIds.length === 0) return;
      const results = await Promise.allSettled(itemIds.map((id) => api.post(`/work-items/${id}/comments`, { body })));
      for (const id of itemIds) void qc.invalidateQueries({ queryKey: keys.workItemTimeline(id) });
      void qc.invalidateQueries({ queryKey: keys.workItems(projectRef.current.id) });
      if (results.some((r) => r.status === 'rejected')) toast('The move was made, but the comment could not be posted everywhere', 'error');
    },
    [toast, qc],
  );

  return { confirm, comment };
}
