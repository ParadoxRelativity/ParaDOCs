import { useEffect, useRef, useState } from 'react';
import { BlockNoteView } from '@blocknote/mantine';
import { SuggestionMenuController, getDefaultReactSlashMenuItems, useCreateBlockNote } from '@blocknote/react';
import { filterSuggestionItems } from '@blocknote/core';
import { withCollaboration } from '@blocknote/core/yjs';
import { syntaxHighlighter } from '@blocknote/code-block';
import { mentionHref, mentionLabel, projectPath, type Doc } from '@paradocs/shared';
import { useAppEnabled, useChannels, useMembers, useUploadFile, type DocumentPatch } from '../api/hooks';
import { cx, useAutosave } from '../lib/util';
import { claimNewDocument } from '../lib/newDocuments';
import { applyDocumentImport, claimDocumentImport } from '../lib/documentImport';
import { useToast } from './Toast';
import { useCollaboration, type CollabSession, type Peer } from '../lib/collaboration';
import DocumentMeta from './DocumentMeta';
import CanvasEditor from './canvas/CanvasEditor';
import { Spinner } from './ui';
import Avatar from './Avatar';
import { documentSchema } from './documentSchema';
import SheetRefPicker, { type PickedSheetRef } from './sheet/SheetRefPicker';
import { ProjectPicker, WorkItemPicker } from './projects/WorkItemRefs';
import { copyEditorSelection } from '../lib/documentClipboard';
import { suggestionMenuPosition } from '../lib/suggestionMenuPosition';
import { assetUrl, serverPath } from '../lib/server';

interface Props {
  doc: Doc;
  workspaceId: string;
  dark: boolean;
  canEdit: boolean;
  self: { id: string; name: string; avatarUrl: string | null };
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
  const upload = useUploadFile(workspaceId);

  // With collaboration on, the body is never passed as initialContent and never
  // PATCHed: the Y.Doc is the source of truth and the server persists it and
  // re-derives blocks and markdown for search.
  const editor = useCreateBlockNote(
    withCollaboration({
      // Adds spreadsheet cells and charts; the server's schema matches it.
      schema: documentSchema,
      // BlockNote reads only the provider's awareness, for cursors. Hocuspocus
      // types it as nullable where BlockNote expects undefined.
      collaboration: {
        provider: { awareness: session.provider.awareness ?? undefined },
        fragment: session.fragment,
        user: collabUser,
      },
      extensions: [syntaxHighlighter],
      // Image, video, audio and file blocks, and files dropped or pasted into
      // the page, upload to the workspace under the server's size limit.
      // The page keeps the server's path, not this client's address for it;
      // see lib/server.ts.
      uploadFile: async (file: File) => serverPath((await upload.mutateAsync({ file, documentId: doc.id })).url),
      resolveFileUrl: async (url: string) => assetUrl(url),
    }),
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
  // does in chat, and inserts a link that opens the channel in place. `@` does
  // the same for people.
  // Only where the workspace has those apps on.
  const chatOn = useAppEnabled(workspaceId, 'chat');
  const sheetsOn = useAppEnabled(workspaceId, 'sheets');
  const projectsOn = useAppEnabled(workspaceId, 'projects');
  const [itemPicker, setItemPicker] = useState(false);
  const [projectPicker, setProjectPicker] = useState(false);
  const channels = useChannels(chatOn ? workspaceId : undefined);
  const members = useMembers(workspaceId);

  // The slash menu's spreadsheet items ask which cell or chart first.
  const [sheetPicker, setSheetPicker] = useState<'cell' | 'chart' | null>(null);

  function insertSheetRef(ref: PickedSheetRef) {
    setSheetPicker(null);
    editor.focus();
    if (ref.kind === 'cell') {
      editor.insertInlineContent([
        { type: 'sheetCell', props: { spreadsheetId: ref.spreadsheetId, sheetId: ref.sheetId, cell: ref.cell, label: ref.label } },
        ' ',
      ]);
      return;
    }
    const chart = {
      type: 'sheetChart' as const,
      props: { spreadsheetId: ref.spreadsheetId, sheetId: ref.sheetId, chartId: ref.chartId, label: ref.label },
    };
    // The slash menu leaves an empty paragraph behind; the chart takes its place.
    const current = editor.getTextCursorPosition().block;
    const empty = Array.isArray(current.content) && current.content.length === 0 && current.type === 'paragraph';
    if (empty) editor.replaceBlocks([current], [chart]);
    else editor.insertBlocks([chart], current, 'after');
  }

  // Copy and cut are handled here rather than by BlockNote, whose handler is
  // broken against the installed prosemirror-view (see documentClipboard.ts).
  // The view is read when the event fires, since it only exists once mounted.
  useEffect(() => {
    const onCopy = (event: ClipboardEvent) => copyEditorSelection(editor.prosemirrorView, event, false);
    const onCut = (event: ClipboardEvent) => copyEditorSelection(editor.prosemirrorView, event, true);
    document.addEventListener('copy', onCopy, true);
    document.addEventListener('cut', onCut, true);
    return () => {
      document.removeEventListener('copy', onCopy, true);
      document.removeEventListener('cut', onCut, true);
    };
  }, [editor]);

  const titleRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = titleRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [title]);

  /**
   * A document that has just been made opens on its own title, selected. It
   * arrives called "Untitled", which is a prompt rather than a name, so the
   * first thing typed should replace it instead of landing after it.
   */
  useEffect(() => {
    if (!canEdit || !claimNewDocument(doc.id)) return;
    const el = titleRef.current;
    el?.focus();
    el?.select();
  }, [doc.id, canEdit]);

  // A document made by importing a file arrives empty, with the file's contents
  // waiting to be written in. That waits for the server's copy to arrive, so
  // the import replaces it rather than landing beside it.
  const toast = useToast();
  useEffect(() => {
    const imported = claimDocumentImport(doc.id);
    if (!imported || !canEdit) return;
    const { provider } = session;
    const write = () => {
      provider.off('synced', write);
      applyDocumentImport(editor, imported, async (file) =>
        serverPath((await upload.mutateAsync({ file, documentId: doc.id })).url),
      )
        .then(({ missingMedia }) =>
          toast(
            missingMedia > 0
              ? `Imported ${imported.fileName}. ${missingMedia} image(s) or file(s) could not be brought in.`
              : `Imported ${imported.fileName}`,
          ),
        )
        .catch((err) => toast(err instanceof Error ? err.message : 'Could not import that file', 'error'));
    };
    if (provider.isSynced) write();
    else provider.on('synced', write);
    // Claiming consumes it, so this runs once per imported document. Not undone
    // on cleanup: StrictMode's second run finds nothing left to claim.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.id]);

  return (
    <div className="scroll-thin h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl px-12 py-10">
        <div className="mb-1 flex items-center gap-2 text-xs text-[var(--color-muted)]">
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
          className="mt-6"
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
            slashMenu={false}
            onChange={() => onBlocksChange(editor.document)}
          >
            <SuggestionMenuController
              floatingUIOptions={suggestionMenuPosition}
              triggerCharacter="/"
              getItems={async (queryText) =>
                filterSuggestionItems(
                  [
                    ...getDefaultReactSlashMenuItems(editor),
                    // Nothing to point at in a workspace with Sheets off.
                    ...(sheetsOn
                      ? [
                          {
                            title: 'Spreadsheet cell',
                            subtext: 'Show a cell’s current value from a spreadsheet',
                            aliases: ['sheet', 'cell', 'value', 'spreadsheet', 'number'],
                            group: 'Spreadsheets',
                            icon: <span aria-hidden>▦</span>,
                            onItemClick: () => setSheetPicker('cell'),
                          },
                          {
                            title: 'Spreadsheet chart',
                            subtext: 'Show a chart from a spreadsheet, kept up to date',
                            aliases: ['sheet', 'chart', 'graph', 'spreadsheet', 'plot'],
                            group: 'Spreadsheets',
                            icon: <span aria-hidden>📊</span>,
                            onItemClick: () => setSheetPicker('chart'),
                          },
                        ]
                      : []),
                    ...(projectsOn
                      ? [
                          {
                            title: 'Work item',
                            subtext: 'Link a work item, showing where it stands',
                            aliases: ['issue', 'task', 'ticket', 'item', 'project', 'bug', 'jira'],
                            group: 'Projects',
                            icon: <span aria-hidden>▤</span>,
                            onItemClick: () => setItemPicker(true),
                          },
                          {
                            title: 'Board or queue',
                            subtext: 'Link a project’s board or a queue',
                            aliases: ['board', 'queue', 'project', 'kanban', 'sprint', 'backlog'],
                            group: 'Projects',
                            icon: <span aria-hidden>▥</span>,
                            onItemClick: () => setProjectPicker(true),
                          },
                        ]
                      : []),
                  ],
                  queryText,
                )
              }
            />
            {/* Tagging someone writes an ordinary link, the way `#` writes one
                for a channel: BlockNote's own schema round-trips it, the
                markdown derived for search reads "@Ada Lovelace", and the
                server reads the id out of the href to tell them. */}
            <SuggestionMenuController
              floatingUIOptions={suggestionMenuPosition}
              triggerCharacter="@"
              getItems={async (queryText) => {
                const needle = queryText.toLowerCase();
                return (members.data ?? [])
                  .filter((member) => member.name.toLowerCase().includes(needle))
                  .slice(0, 8)
                  .map((member) => ({
                    title: mentionLabel(member.name),
                    subtext: member.isSelf ? 'You' : member.email,
                    group: 'People',
                    onItemClick: () => {
                      editor.insertInlineContent([
                        {
                          type: 'link',
                          href: mentionHref(workspaceId, member.userId),
                          content: mentionLabel(member.name),
                        },
                        ' ',
                      ]);
                    },
                  }));
              }}
            />
            <SuggestionMenuController
              floatingUIOptions={suggestionMenuPosition}
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
        {itemPicker && (
          <WorkItemPicker
            workspaceId={workspaceId}
            confirmLabel="Insert"
            onCancel={() => {
              setItemPicker(false);
              editor.focus();
            }}
            onPick={(item) => {
              setItemPicker(false);
              editor.focus();
              editor.insertInlineContent([
                { type: 'workItem', props: { itemId: item.id, label: `${item.key} ${item.title}` } },
                ' ',
              ]);
            }}
          />
        )}
        {projectPicker && (
          <ProjectPicker
            workspaceId={workspaceId}
            confirmLabel="Insert"
            onCancel={() => {
              setProjectPicker(false);
              editor.focus();
            }}
            onPick={(project) => {
              setProjectPicker(false);
              editor.focus();
              // An ordinary link, as a channel is: it follows in place like one,
              // and the markdown derived for search reads the name.
              editor.insertInlineContent([
                { type: 'link', href: projectPath(workspaceId, project.id, project.kind), content: project.name },
                ' ',
              ]);
            }}
          />
        )}
        {sheetPicker && (
          <SheetRefPicker
            kind={sheetPicker}
            workspaceId={workspaceId}
            confirmLabel="Insert"
            onInsert={insertSheetRef}
            onCancel={() => {
              setSheetPicker(null);
              editor.focus();
            }}
          />
        )}
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
        <Avatar
          key={peer.clientId}
          name={peer.name}
          url={peer.avatarUrl}
          className="border-2 border-[var(--color-canvas)]"
          style={{ background: peer.color }}
        />
      ))}
      {peers.length > 5 && (
        <span className="pl-2.5 text-[10px] text-[var(--color-muted)]">+{peers.length - 5}</span>
      )}
    </div>
  );
}
