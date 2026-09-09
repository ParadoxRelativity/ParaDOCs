import { useCallback, useEffect, useState } from 'react';
import { Navigate, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import {
  useDeleteDocument,
  useDocument,
  useJournal,
  useLogout,
  useMe,
  useUpdateDocument,
  useWorkspaces,
  type DocumentPatch,
} from './api/hooks';
import { cx, todayISO, useLocalStorage } from './lib/util';
import AuthScreen from './components/AuthScreen';
import LeftSidebar from './components/LeftSidebar';
import RightSidebar, { type RightTab } from './components/RightSidebar';
import DocumentEditor from './components/DocumentEditor';
import ErrorBoundary from './components/ErrorBoundary';
import AllDocuments from './components/AllDocuments';
import AcceptInvite from './components/AcceptInvite';
import SettingsDialog, { type SettingsSection, type Theme } from './components/SettingsDialog';
import SearchPalette from './components/SearchPalette';
import { EmptyState, IconButton, Spinner } from './components/ui';

export default function App() {
  const me = useMe();

  if (me.isLoading) return <Spinner />;
  if (!me.data?.user) {
    return (
      <AuthScreen
        allowRegistration={me.data?.allowRegistration ?? false}
        oidc={me.data?.oidc ?? { enabled: false, configured: false, providerName: 'SSO' }}
      />
    );
  }

  return (
    <Routes>
      <Route path="/invite/:token" element={<AcceptInvite />} />
      <Route path="/w/:workspaceId/d/:documentId" element={<Workspace user={me.data.user} />} />
      <Route path="/w/:workspaceId/all" element={<Workspace user={me.data.user} allDocuments />} />
      <Route path="/w/:workspaceId" element={<Workspace user={me.data.user} />} />
      <Route path="*" element={<FirstWorkspaceRedirect />} />
    </Routes>
  );
}

function FirstWorkspaceRedirect() {
  const workspaces = useWorkspaces();
  if (workspaces.isLoading) return <Spinner />;
  const first = workspaces.data?.[0];
  if (!first) {
    return <EmptyState icon="⚠️" title="No workspaces" hint="Your account has no workspace. Try signing out and back in." />;
  }
  return <Navigate to={`/w/${first.id}`} replace />;
}

function Workspace({
  user,
  allDocuments = false,
}: {
  user: { id: string; email: string; name: string; createdAt: string };
  allDocuments?: boolean;
}) {
  const userId = user.id;
  const { workspaceId = '', documentId } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const workspaces = useWorkspaces();
  const workspace = workspaces.data?.find((w) => w.id === workspaceId);
  // Viewers get the whole app read-only; editors and above can write.
  const canEdit = workspace ? workspace.role !== 'viewer' : false;
  const document = useDocument(documentId);
  const updateDocument = useUpdateDocument(workspaceId, documentId ?? '');
  const deleteDocument = useDeleteDocument(workspaceId);
  const logout = useLogout();

  const [leftOpen, setLeftOpen] = useLocalStorage('paradocs.leftOpen', true);
  const [rightOpen, setRightOpen] = useLocalStorage('paradocs.rightOpen', true);
  const [rightTab, setRightTab] = useLocalStorage<RightTab>('paradocs.rightTab', 'toc');
  const [theme, setTheme] = useLocalStorage<Theme>('paradocs.theme', 'system');
  const [searchOpen, setSearchOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection | null>(null);
  const [activeTagIds, setActiveTagIds] = useState<string[]>([]);
  const [liveBlocks, setLiveBlocks] = useState<unknown[]>([]);
  const [journalDate, setJournalDate] = useState<string | null>(null);

  const journal = useJournal(workspaceId, journalDate ?? todayISO(), journalDate !== null);

  // Opening a journal is a fetch-then-navigate, since the id is assigned server side.
  useEffect(() => {
    if (journalDate && journal.data) {
      navigate(`/w/${workspaceId}/d/${journal.data.id}`);
      setJournalDate(null);
      queryClient.invalidateQueries({ queryKey: ['tree', workspaceId] });
    }
  }, [journalDate, journal.data, workspaceId, navigate, queryClient]);

  const dark =
    theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);

  useEffect(() => {
    document_setTheme(dark);
  }, [dark]);

  // Clear the outline while switching documents; the editor republishes its own
  // normalized blocks as soon as it mounts.
  useEffect(() => {
    setLiveBlocks([]);
  }, [documentId]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearchOpen(true);
      }
      if (meta && e.key === '\\') {
        e.preventDefault();
        if (e.shiftKey) setRightOpen((v) => !v);
        else setLeftOpen((v) => !v);
      }
      if (meta && e.key.toLowerCase() === 'j' && e.shiftKey) {
        e.preventDefault();
        setJournalDate(todayISO());
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setLeftOpen, setRightOpen]);

  const patch = useCallback((p: DocumentPatch) => updateDocument.mutate(p), [updateDocument]);

  if (workspaces.isLoading) return <Spinner />;
  if (workspaces.data && !workspaces.data.some((w) => w.id === workspaceId)) {
    return <Navigate to="/" replace />;
  }

  return (
    <div className="flex h-full overflow-hidden">
      <aside
        className={cx(
          'shrink-0 overflow-hidden border-r border-[var(--color-line)] transition-[width] duration-200',
          leftOpen ? 'w-64' : 'w-0',
        )}
      >
        <div className="h-full w-64">
          <LeftSidebar
            workspaces={workspaces.data ?? []}
            workspaceId={workspaceId}
            onSelectWorkspace={(id) => navigate(`/w/${id}`)}
            documentId={documentId ?? null}
            onSelectDocument={(id) => navigate(`/w/${workspaceId}/d/${id}`)}
            onOpenJournal={() => setJournalDate(todayISO())}
            onOpenSearch={() => setSearchOpen(true)}
            onOpenAllDocuments={() => navigate(`/w/${workspaceId}/all`)}
            allDocumentsActive={allDocuments}
            documentCount={workspace?.documentCount ?? 0}
            activeTagIds={activeTagIds}
            onToggleTag={(id) => {
              setActiveTagIds([id]);
              setSearchOpen(true);
            }}
            onSignOut={() => logout.mutate()}
            onOpenSettings={setSettingsSection}
          />
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-11 shrink-0 items-center gap-1 border-b border-[var(--color-line)] px-2">
          <IconButton label={leftOpen ? 'Hide sidebar' : 'Show sidebar'} onClick={() => setLeftOpen(!leftOpen)}>
            {leftOpen ? '⬅' : '➡'}
          </IconButton>
          <span className="min-w-0 flex-1 truncate px-2 text-sm text-[var(--color-muted)]">
            {allDocuments ? 'All documents' : (document.data?.title ?? '')}
          </span>
          <IconButton label="Search (⌘K)" onClick={() => setSearchOpen(true)}>
            🔍
          </IconButton>
          <IconButton label={rightOpen ? 'Hide details' : 'Show details'} onClick={() => setRightOpen(!rightOpen)}>
            {rightOpen ? '➡' : '⬅'}
          </IconButton>
        </header>

        <div className="min-h-0 flex-1">
          {allDocuments ? (
            <AllDocuments
              workspaceId={workspaceId}
              onOpen={(id) => navigate(`/w/${workspaceId}/d/${id}`)}
            />
          ) : !documentId ? (
            <EmptyState
              icon="📄"
              title="Nothing open"
              hint="Pick a document from the sidebar, press ⌘K to search, or open today's journal."
            />
          ) : document.isLoading ? (
            <Spinner />
          ) : document.error ? (
            <EmptyState icon="⚠️" title="Could not open that document" hint={(document.error as Error).message} />
          ) : document.data ? (
            <ErrorBoundary resetKey={document.data.id}>
              <DocumentEditor
                doc={document.data}
                workspaceId={workspaceId}
                dark={dark}
                canEdit={canEdit}
                self={{ id: user.id, name: user.name }}
                onPatch={patch}
                onBlocksChange={setLiveBlocks}
                onOpenDocument={(id) => navigate(`/w/${workspaceId}/d/${id}`)}
              />
            </ErrorBoundary>
          ) : null}
        </div>
      </main>

      <aside
        className={cx(
          'shrink-0 overflow-hidden border-l border-[var(--color-line)] transition-[width] duration-200',
          rightOpen ? 'w-72' : 'w-0',
        )}
      >
        <div className="h-full w-72">
          <RightSidebar
            tab={rightTab}
            onTabChange={setRightTab}
            doc={document.data}
            liveBlocks={liveBlocks}
            workspaceId={workspaceId}
            currentUserId={userId}
            onPatch={patch}
            onDelete={() => {
              if (!documentId) return;
              deleteDocument.mutate(documentId);
              navigate(`/w/${workspaceId}`);
            }}
            onOpenJournal={(date) => setJournalDate(date)}
          />
        </div>
      </aside>

      {settingsSection && workspace && (
        <SettingsDialog
          section={settingsSection}
          onSectionChange={setSettingsSection}
          user={user}
          workspace={workspace}
          theme={theme}
          onThemeChange={setTheme}
          onClose={() => setSettingsSection(null)}
          onWorkspaceDeleted={() => {
            setSettingsSection(null);
            navigate('/');
          }}
          onOpenDocument={(id) => {
            setSettingsSection(null);
            navigate(`/w/${workspaceId}/d/${id}`);
          }}
        />
      )}

      {searchOpen && (
        <SearchPalette
          workspaceId={workspaceId}
          initialTagIds={activeTagIds}
          onClose={() => {
            setSearchOpen(false);
            setActiveTagIds([]);
          }}
          onSelect={(id) => navigate(`/w/${workspaceId}/d/${id}`)}
        />
      )}
    </div>
  );
}

/** Kept out of the component body so the DOM name is not shadowed by the `document` query. */
function document_setTheme(dark: boolean) {
  window.document.documentElement.classList.toggle('dark', dark);
}
