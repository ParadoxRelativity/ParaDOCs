import { useEffect, useRef, useState } from 'react';
import { BlockNoteView } from '@blocknote/mantine';
import { SuggestionMenuController, useCreateBlockNote } from '@blocknote/react';
import type { Block } from '@blocknote/core';
import type { Doc } from '@paradocs/shared';
import { useChannels, type DocumentPatch } from '../api/hooks';
import { cx, useAutosave } from '../lib/util';
import { useCollaboration, type CollabSession, type Peer } from '../lib/collaboration';
import DocumentMeta from './DocumentMeta';
import CanvasEditor from './canvas/CanvasEditor';
import { Spinner } from './ui';

interface Props {
  doc: Doc;
  workspaceId: string;
  dark: boolean;
  canEdit: boolean;
  self: { id: string; name: string };
  onPatch: (patch: DocumentPatch) => void;
  onBlocksChange: (blocks: unknown[]) => void;
  onOpenDocument: (documentId: string) => void;
  /** Follows an in-app link (a channel or document) from inside the editor. */
  onOpenInternalLink: (path: string) => void;
}

export default function DocumentEditor(props: Props) {
  const { session, user, status, peers } = useCollaboration(props.doc.id, props.self);

  // The editor cannot be built before the session exists, and it must be rebuilt
  // if the session is replaced, so the surface is keyed on the document.
  if (!session) return <Spinner />;

  // A canvas shares the document's Y.Doc, so collaboration, auth and
  // persistence are identical; only the surface differs.
  if (props.doc.mode === 'canvas') {
    return (
      <CanvasEditor
        key={props.doc.id}
        doc={props.doc}
        workspaceId={props.workspaceId}
        canEdit={props.canEdit}
        dark={props.dark}
        session={session}
        peers={peers}
        onPatch={props.onPatch}
        onOpenDocument={props.onOpenDocument}
      />
    );
  }

  return (
    <EditorSurface
      key={props.doc.id}
      {...props}
      session={session}
      collabUser={user}
      status={status}
      peers={peers}
    />
  );
}

function EditorSurface({
  doc,
  workspaceId,
  dark,
  canEdit,
  onPatch,
  onBlocksChange,
  onOpenInternalLink,
  session,
  collabUser,
  status,
  peers,
}: Props & {
  session: CollabSession;
  collabUser: { name: string; color: string };
  status: 'connecting' | 'connected' | 'disconnected';
  peers: Peer[];
}) {
  const [title, setTitle] = useState(doc.title);

  // With collaboration on, the body is never passed as initialContent and never
  // PATCHed: the Y.Doc is the source of truth and the server persists it and
  // re-derives blocks and markdown for search.
  const editor = useCreateBlockNote(
    { collaboration: { provider: session.provider, fragment: session.fragment, user: collabUser } },
    [session],
  );

  useEffect(() => {
    setTitle(doc.title);
  }, [doc.id, doc.title]);

  // The title lives outside the Y.Doc, so it still autosaves over REST.
  const titleSave = useAutosave<string>((value) => {
    const trimmed = value.trim();
    if (trimmed && trimmed !== doc.title) onPatch({ title: trimmed });
  }, 600);

  // Typing `#` in a document offers the workspace's channels, the same way it
  // does in chat, and inserts a link that opens the channel in place.
  const channels = useChannels(workspaceId);

  const titleRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = titleRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [title]);

  return (
    <div className="scroll-thin h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl px-12 py-10">
        <div className="mb-1 flex items-center gap-2 text-xs text-[var(--color-muted)]">
          {doc.isJournal && (
            <span className="rounded bg-[var(--color-accent-soft)] px-1.5 py-0.5 text-[var(--color-accent)]">
              Journal
            </span>
          )}
          {doc.archivedAt && (
            <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-amber-600">Archived</span>
          )}
          {!canEdit && (
            <span className="rounded bg-[var(--color-surface)] px-1.5 py-0.5">Read only</span>
          )}
          <ConnectionBadge status={status} />
          <div className="ml-auto">
            <Presence peers={peers} />
          </div>
        </div>

        <textarea
          ref={titleRef}
          value={title}
          rows={1}
          readOnly={!canEdit}
          placeholder="Untitled"
          onChange={(e) => {
            setTitle(e.target.value);
            titleSave.schedule(e.target.value);
          }}
          onBlur={() => titleSave.flush()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              titleSave.flush();
              editor.focus();
            }
          }}
          className="w-full resize-none overflow-hidden border-0 bg-transparent text-3xl font-bold tracking-tight outline-none placeholder:text-[var(--color-line)]"
        />

        <DocumentMeta doc={doc} workspaceId={workspaceId} onPatch={onPatch} readOnly={!canEdit} />

        <div
          className="-mx-12 mt-6"
          onClick={(e) => {
            // A channel or document link inside the editor is an in-app route;
            // letting the browser follow it would reload the whole client.
            const anchor = (e.target as HTMLElement).closest('a');
            const href = anchor?.getAttribute('href');
            if (!href?.startsWith('/w/')) return;
            e.preventDefault();
            onOpenInternalLink(href);
          }}
        >
          <BlockNoteView
            editor={editor}
            editable={canEdit}
            theme={dark ? 'dark' : 'light'}
            onChange={() => onBlocksChange(editor.document as Block[])}
          >
            <SuggestionMenuController
              triggerCharacter="#"
              getItems={async (queryText) => {
                const needle = queryText.toLowerCase();
                return (channels.data ?? [])
                  .filter((channel) => channel.name.includes(needle))
                  .slice(0, 8)
                  .map((channel) => ({
                    title: `#${channel.name}`,
                    subtext: channel.topic ?? undefined,
                    group: 'Channels',
                    onItemClick: () => {
                      editor.insertInlineContent([
                        {
                          type: 'link',
                          href: `/w/${workspaceId}/c/${channel.id}`,
                          content: `#${channel.name}`,
                        },
                        ' ',
                      ]);
                    },
                  }));
              }}
            />
          </BlockNoteView>
        </div>
      </div>
    </div>
  );
}

function ConnectionBadge({ status }: { status: 'connecting' | 'connected' | 'disconnected' }) {
  if (status === 'connected') return null; // the quiet, normal case
  return (
    <span
      className={cx(
        'rounded px-1.5 py-0.5',
        status === 'connecting' ? 'bg-[var(--color-surface)]' : 'bg-amber-500/15 text-amber-600',
      )}
    >
      {status === 'connecting' ? 'Connecting…' : 'Reconnecting — edits are saved locally'}
    </span>
  );
}

function Presence({ peers }: { peers: Peer[] }) {
  if (peers.length === 0) return null;
  return (
    <div className="flex items-center -space-x-1.5" title={peers.map((p) => p.name).join(', ')}>
      {peers.slice(0, 5).map((peer) => (
        <span
          key={peer.clientId}
          className="grid h-6 w-6 place-items-center rounded-full border-2 border-[var(--color-canvas)] text-[10px] font-semibold text-white"
          style={{ background: peer.color }}
        >
          {peer.name.slice(0, 1).toUpperCase()}
        </span>
      ))}
      {peers.length > 5 && (
        <span className="pl-2.5 text-[10px] text-[var(--color-muted)]">+{peers.length - 5}</span>
      )}
    </div>
  );
}
