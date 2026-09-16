import { useMutation, useQuery, useQueryClient, type QueryClient, type UseQueryOptions } from '@tanstack/react-query';
import type {
  AccessSettings,
  ActivityDay,
  CalendarEvent,
  Channel,
  Comment,
  Doc,
  DocumentMode,
  DocumentSummary,
  Folder,
  FolderNode,
  InvitePreview,
  Message,
  MessageReferences,
  Notifications,
  PresenceSettings,
  PresenceStatus,
  Role,
  SearchHit,
  SheetSearchHit,
  SpreadsheetSummary,
  Tag,
  Team,
  UpdateAccessInput,
  UploadConfig,
  User,
  VoiceOccupant,
  Workspace,
  WorkspaceInvite,
  WorkspaceMember,
} from '@paradocs/shared';
import { formatBytes } from '../lib/util';
import { rememberNewDocument } from '../lib/newDocuments';
import { api, qs } from './client';

export interface WorkspaceSummary extends Workspace {
  documentCount: number;
  memberCount: number;
  /** The signed-in user's role in this workspace. */
  role: Role;
}

/** The sidebar tree. Unfiled documents are not included; see useAllDocuments. */
export interface Tree {
  folders: FolderNode[];
}

export type DocumentSort = 'updated' | 'created' | 'title';

export interface DocumentList {
  documents: DocumentSummary[];
  hasMore: boolean;
}

export const keys = {
  me: ['me'] as const,
  workspaces: ['workspaces'] as const,
  tree: (ws: string) => ['tree', ws] as const,
  documents: (ws: string) => ['documents', ws] as const,
  document: (id: string) => ['document', id] as const,
  tags: (ws: string) => ['tags', ws] as const,
  comments: (id: string) => ['comments', id] as const,
  events: (ws: string, from: string, to: string) => ['events', ws, from, to] as const,
  activity: (ws: string, from: string, to: string) => ['activity', ws, from, to] as const,
  search: (ws: string, key: string) => ['search', ws, key] as const,
  channels: (ws: string) => ['channels', ws] as const,
  messages: (channelId: string) => ['messages', channelId] as const,
  directs: (ws: string) => ['directs', ws] as const,
  presence: (ws: string) => ['presence', ws] as const,
  voiceParticipants: (ws: string) => ['voiceParticipants', ws] as const,
  presenceSettings: ['presenceSettings'] as const,
  notifications: ['notifications'] as const,
  uploadConfig: ['uploadConfig'] as const,
  spreadsheets: (ws: string) => ['spreadsheets', ws] as const,
  spreadsheet: (id: string) => ['spreadsheet', id] as const,
  teams: (ws: string) => ['teams', ws] as const,
  access: (kind: string, id: string) => ['access', kind, id] as const,
};

// --- session ---------------------------------------------------------------

export function useMe() {
  return useQuery({
    queryKey: keys.me,
    queryFn: () =>
      api.get<{
        user: User | null;
        allowRegistration: boolean;
        oidc: { enabled: boolean; configured: boolean; providerName: string };
      }>('/auth/me'),
    staleTime: Infinity,
  });
}

export function useLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { email: string; password: string }) =>
      api.post<{ user: User }>('/auth/login', input),
    onSuccess: () => qc.invalidateQueries(),
  });
}

export function useRegister() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { email: string; password: string; name: string }) =>
      api.post<{ user: User }>('/auth/register', input),
    onSuccess: () => qc.invalidateQueries(),
  });
}

export function useUpdateProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { name?: string; email?: string }) =>
      api.patch<{ user: User }>('/auth/me', input),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.me }),
  });
}

/** Sets the profile picture, or removes it when given null. */
export function useSetAvatar() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (picture: Blob | null) =>
      picture ? api.upload('PUT', '/auth/me/avatar', picture) : api.delete('/auth/me/avatar'),
    onSuccess: () => {
      // The picture is drawn beside your name in lists fetched on their own.
      for (const queryKey of [keys.me, ['members'], ['comments'], ['messages'], ['directs']]) {
        void qc.invalidateQueries({ queryKey });
      }
    },
  });
}

export function useChangePassword() {
  return useMutation({
    mutationFn: (input: { currentPassword?: string; newPassword: string }) =>
      api.post<void>('/auth/password', input),
  });
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post('/auth/logout'),
    onSuccess: () => qc.clear(),
  });
}

// --- workspaces and tree ---------------------------------------------------

export function useWorkspaces() {
  return useQuery({ queryKey: keys.workspaces, queryFn: () => api.get<WorkspaceSummary[]>('/workspaces') });
}

export function useCreateWorkspace() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; icon?: string | null }) =>
      api.post<Workspace>('/workspaces', input),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.workspaces }),
  });
}

export function useUpdateWorkspace(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { name?: string; icon?: string | null }) =>
      api.patch<Workspace>(`/workspaces/${workspaceId}`, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.workspaces }),
  });
}

/** Sets the workspace picture, or removes it when given null. */
export function useSetWorkspaceAvatar(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (picture: Blob | null) =>
      picture
        ? api.upload('PUT', `/workspaces/${workspaceId}/avatar`, picture)
        : api.delete(`/workspaces/${workspaceId}/avatar`),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.workspaces }),
  });
}

export function useDeleteWorkspace() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (workspaceId: string) => api.delete(`/workspaces/${workspaceId}`),
    onSuccess: () => qc.invalidateQueries(),
  });
}

export function useTree(workspaceId: string | undefined) {
  return useQuery({
    queryKey: keys.tree(workspaceId ?? ''),
    queryFn: () => api.get<Tree>(`/workspaces/${workspaceId}/tree`),
    enabled: Boolean(workspaceId),
  });
}

export function useCreateFolder(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; icon?: string | null; parentId?: string | null }) =>
      api.post<Folder>(`/workspaces/${workspaceId}/folders`, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.tree(workspaceId) }),
  });
}

export function useUpdateFolder(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...patch }: { id: string; name?: string; icon?: string | null }) =>
      api.patch<Folder>(`/folders/${id}`, patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.tree(workspaceId) }),
  });
}

export function useDeleteFolder(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    /** The documents inside are kept, unfiled, unless `deleteDocuments` says to delete them too. */
    mutationFn: ({ id, deleteDocuments }: { id: string; deleteDocuments: boolean }) =>
      api.delete(`/folders/${id}${deleteDocuments ? '?documents=delete' : ''}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.tree(workspaceId) });
      // Documents either became unfiled or are gone, which the flat listing and
      // the workspace's document count both show.
      qc.invalidateQueries({ queryKey: ['allDocuments', workspaceId] });
      qc.invalidateQueries({ queryKey: keys.workspaces });
    },
  });
}

// --- teams and access ------------------------------------------------------

/** Something that can be locked. */
export interface AccessTarget {
  kind: 'folder' | 'document' | 'channel';
  id: string;
}

const ACCESS_PATHS = { folder: 'folders', document: 'documents', channel: 'channels' } as const;

/**
 * After who can see what changes, anything on screen may be showing too much
 * or too little, so it is all asked for again. Loaded chat history is left
 * alone: refetching it would drop older pages, and whether a channel is shown
 * at all is the channel list's call.
 */
export function refetchAfterAccessChange(qc: QueryClient) {
  return qc.invalidateQueries({ predicate: (query) => query.queryKey[0] !== 'messages' });
}

export function useTeams(workspaceId: string | undefined) {
  return useQuery({
    queryKey: keys.teams(workspaceId ?? ''),
    queryFn: () => api.get<Team[]>(`/workspaces/${workspaceId}/teams`),
    enabled: Boolean(workspaceId),
  });
}

export function useCreateTeam(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; memberIds?: string[] }) =>
      api.post<Team>(`/workspaces/${workspaceId}/teams`, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.teams(workspaceId) }),
  });
}

export function useUpdateTeam(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...patch }: { id: string; name?: string; memberIds?: string[] }) =>
      api.patch<Team>(`/teams/${id}`, patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.teams(workspaceId) }),
  });
}

export function useDeleteTeam(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/teams/${id}`),
    onSuccess: () => refetchAfterAccessChange(qc),
  });
}

/** Every team one member is on, replacing what was there. */
export function useSetMemberTeams(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, teamIds }: { userId: string; teamIds: string[] }) =>
      api.put(`/workspaces/${workspaceId}/members/${userId}/teams`, { teamIds }),
    // Returned so the mutation stays pending until the teams are fresh, and a
    // second change is never made from the list the first one replaced.
    onSuccess: () => refetchAfterAccessChange(qc),
  });
}

export function useAccessSettings(target: AccessTarget | null) {
  return useQuery({
    queryKey: keys.access(target?.kind ?? '', target?.id ?? ''),
    queryFn: () => api.get<AccessSettings>(`/${ACCESS_PATHS[target!.kind]}/${target!.id}/access`),
    enabled: Boolean(target),
    // Opened to be changed, so it should show what is set now.
    staleTime: 0,
  });
}

export function useUpdateAccess(target: AccessTarget) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateAccessInput) =>
      api.put<AccessSettings>(`/${ACCESS_PATHS[target.kind]}/${target.id}/access`, input),
    onSuccess: (settings) => {
      qc.setQueryData(keys.access(target.kind, target.id), settings);
      void refetchAfterAccessChange(qc);
    },
  });
}

// --- members and invites ---------------------------------------------------

export function useMembers(workspaceId: string | undefined) {
  return useQuery({
    queryKey: ['members', workspaceId],
    queryFn: () => api.get<WorkspaceMember[]>(`/workspaces/${workspaceId}/members`),
    enabled: Boolean(workspaceId),
  });
}

export function useUpdateMember(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: Role }) =>
      api.patch(`/workspaces/${workspaceId}/members/${userId}`, { role }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['members', workspaceId] });
      qc.invalidateQueries({ queryKey: keys.workspaces });
    },
  });
}

export function useRemoveMember(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) => api.delete(`/workspaces/${workspaceId}/members/${userId}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['members', workspaceId] });
      qc.invalidateQueries({ queryKey: keys.workspaces });
    },
  });
}

export function useInvites(workspaceId: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ['invites', workspaceId],
    queryFn: () => api.get<WorkspaceInvite[]>(`/workspaces/${workspaceId}/invites`),
    enabled: Boolean(workspaceId) && enabled,
  });
}

export function useCreateInvite(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { email?: string | null; role: Role }) =>
      api.post<WorkspaceInvite>(`/workspaces/${workspaceId}/invites`, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['invites', workspaceId] }),
  });
}

export function useRevokeInvite(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (inviteId: string) => api.delete(`/workspaces/${workspaceId}/invites/${inviteId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['invites', workspaceId] }),
  });
}

export function useInvitePreview(token: string) {
  return useQuery({
    queryKey: ['invite', token],
    queryFn: () => api.get<InvitePreview>(`/invites/${token}`),
    retry: false,
  });
}

export function useAcceptInvite() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (token: string) =>
      api.post<{ workspaceId: string; role: Role; alreadyMember: boolean }>(`/invites/${token}/accept`),
    onSuccess: () => qc.invalidateQueries(),
  });
}

// --- documents -------------------------------------------------------------

/** Flat listing for the All Documents view, including unfiled documents. */
export function useAllDocuments(
  workspaceId: string | undefined,
  options: { sort: DocumentSort; archived: boolean; limit: number },
) {
  return useQuery({
    queryKey: ['allDocuments', workspaceId, options.sort, options.archived, options.limit],
    queryFn: () =>
      api.get<DocumentList>(
        `/workspaces/${workspaceId}/documents${qs({
          sort: options.sort,
          archived: options.archived,
          limit: options.limit,
        })}`,
      ),
    enabled: Boolean(workspaceId),
    placeholderData: (previous) => previous,
  });
}

export function useDocument(id: string | undefined) {
  return useQuery({
    queryKey: keys.document(id ?? ''),
    queryFn: () => api.get<Doc>(`/documents/${id}`),
    enabled: Boolean(id),
  });
}

export function useCreateDocument(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { title?: string; folderId?: string | null; mode?: DocumentMode }) =>
      api.post<Doc>(`/workspaces/${workspaceId}/documents`, input),
    onSuccess: (doc) => {
      qc.setQueryData(keys.document(doc.id), doc);
      qc.invalidateQueries({ queryKey: keys.tree(workspaceId) });
      qc.invalidateQueries({ queryKey: ['allDocuments', workspaceId] });
      // So the editor opens with "Untitled" selected, whichever of the several
      // ways of making a document was used.
      rememberNewDocument(doc.id);
    },
  });
}

export interface DocumentPatch {
  title?: string;
  mode?: DocumentMode;
  folderId?: string | null;
  icon?: string | null;
  body?: unknown[];
  bodyMd?: string;
  properties?: Record<string, string | number | boolean | null>;
  archived?: boolean;
  tagIds?: string[];
}

export function useUpdateDocument(workspaceId: string, documentId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: DocumentPatch) => api.patch<Doc>(`/documents/${documentId}`, patch),
    onSuccess: (doc, patch) => {
      qc.setQueryData(keys.document(documentId), doc);
      // The sidebar and listings show everything except the body and custom
      // properties, so refresh them unless the patch touched only those.
      // Listing the fields that *do* matter was fragile: adding `mode` to the
      // summary meant switching modes left a stale icon in the sidebar.
      const contentOnly = Object.keys(patch).every(
        (key) => key === 'body' || key === 'bodyMd' || key === 'properties',
      );
      if (!contentOnly) {
        qc.invalidateQueries({ queryKey: keys.tree(workspaceId) });
        qc.invalidateQueries({ queryKey: ['allDocuments', workspaceId] });
      }
    },
  });
}

export function useDeleteDocument(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/documents/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.tree(workspaceId) });
      qc.invalidateQueries({ queryKey: ['allDocuments', workspaceId] });
    },
  });
}

// --- spreadsheets ------------------------------------------------------------
// Their own application, with their own records: nothing here touches the
// document hooks above, and nothing there knows these exist.

export function useSpreadsheets(workspaceId: string | undefined) {
  return useQuery({
    queryKey: keys.spreadsheets(workspaceId ?? ''),
    queryFn: () => api.get<SpreadsheetSummary[]>(`/workspaces/${workspaceId}/spreadsheets`),
    enabled: Boolean(workspaceId),
  });
}

export function useSpreadsheet(id: string | undefined) {
  return useQuery({
    queryKey: keys.spreadsheet(id ?? ''),
    queryFn: () => api.get<SpreadsheetSummary>(`/spreadsheets/${id}`),
    enabled: Boolean(id),
  });
}

export function useCreateSpreadsheet(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { title?: string } = {}) =>
      api.post<SpreadsheetSummary>(`/workspaces/${workspaceId}/spreadsheets`, input),
    onSuccess: (sheet) => {
      qc.setQueryData(keys.spreadsheet(sheet.id), sheet);
      void qc.invalidateQueries({ queryKey: keys.spreadsheets(workspaceId) });
      // The same "open on the name, selected" welcome a new document gets.
      rememberNewDocument(sheet.id);
    },
  });
}

export function useUpdateSpreadsheet(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...patch }: { id: string; title?: string; icon?: string | null; archived?: boolean }) =>
      api.patch<SpreadsheetSummary>(`/spreadsheets/${id}`, patch),
    onSuccess: (sheet) => {
      qc.setQueryData(keys.spreadsheet(sheet.id), sheet);
      void qc.invalidateQueries({ queryKey: keys.spreadsheets(workspaceId) });
    },
  });
}

export function useDeleteSpreadsheet(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/spreadsheets/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.spreadsheets(workspaceId) }),
  });
}

export function useJournal(workspaceId: string | undefined, date: string, enabled: boolean) {
  return useQuery({
    queryKey: ['journal', workspaceId, date],
    queryFn: () => api.get<Doc>(`/workspaces/${workspaceId}/journal/${date}`),
    enabled: Boolean(workspaceId) && enabled,
    staleTime: 0,
  });
}

// --- tags ------------------------------------------------------------------

export function useTags(workspaceId: string | undefined) {
  return useQuery({
    queryKey: keys.tags(workspaceId ?? ''),
    queryFn: () => api.get<Tag[]>(`/workspaces/${workspaceId}/tags`),
    enabled: Boolean(workspaceId),
  });
}

export function useCreateTag(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; color?: string }) =>
      api.post<Tag>(`/workspaces/${workspaceId}/tags`, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.tags(workspaceId) }),
  });
}

export function useDeleteTag(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/tags/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.tags(workspaceId) });
      qc.invalidateQueries({ queryKey: keys.tree(workspaceId) });
    },
  });
}

export interface UploadedFile {
  id: string;
  filename: string;
  mimeType: string;
  byteSize: number;
  url: string;
}

const uploadConfigQuery = {
  queryKey: keys.uploadConfig,
  queryFn: () => api.get<UploadConfig>('/uploads/config'),
  // The limit is set by whoever runs the server, not changed while someone works.
  staleTime: Infinity,
};

/** The server's upload limit, which applies to chat, documents and canvases alike. */
export function useUploadConfig() {
  return useQuery(uploadConfigQuery);
}

/** Uploads a file and returns its served URL. Multipart, so not via api.post. */
export function useUploadFile(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      file,
      documentId,
    }: {
      file: File;
      /** Recorded on the attachment so the file is not treated as orphaned. */
      documentId?: string;
    }): Promise<UploadedFile> => {
      // Refused here as well as on the server, which cuts an oversized upload
      // off partway and cannot always get its explanation back to the browser.
      const limit = await qc.ensureQueryData(uploadConfigQuery).catch(() => null);
      if (limit && file.size > limit.maxBytes) {
        throw new Error(`${file.name} is larger than the ${formatBytes(limit.maxBytes)} limit`);
      }

      const body = new FormData();
      // The document id must precede the file: the server reads fields that
      // arrived before the file part.
      if (documentId) body.append('documentId', documentId);
      body.append('file', file);
      const res = await fetch(`/api/workspaces/${workspaceId}/uploads`, {
        method: 'POST',
        credentials: 'include',
        body,
      });
      if (!res.ok) {
        const detail = await res.json().catch(() => null);
        throw new Error(detail?.error ?? `Upload failed (${res.status})`);
      }
      return res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['uploads', workspaceId] }),
  });
}

export interface WorkspaceUpload {
  id: string;
  filename: string;
  mimeType: string;
  byteSize: number;
  createdAt: string;
  documentId: string | null;
  documentTitle: string | null;
  url: string;
}

export interface UploadTotals {
  total: number;
  unattached: number;
  bytes: number;
  unattached_bytes: number;
}

export function useUploads(workspaceId: string | undefined, unattachedOnly: boolean, enabled: boolean) {
  return useQuery({
    queryKey: ['uploads', workspaceId, unattachedOnly],
    queryFn: () =>
      api.get<{ uploads: WorkspaceUpload[]; totals: UploadTotals }>(
        `/workspaces/${workspaceId}/uploads${qs({ unattached: unattachedOnly })}`,
      ),
    enabled: Boolean(workspaceId) && enabled,
  });
}

export function useDeleteUpload(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (uploadId: string) => api.delete(`/workspaces/${workspaceId}/uploads/${uploadId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['uploads', workspaceId] }),
  });
}

export function useAttachUpload(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ uploadId, ...body }: { uploadId: string; title?: string; folderId?: string | null }) =>
      api.post<{ document: { id: string; title: string } }>(
        `/workspaces/${workspaceId}/uploads/${uploadId}/attach`,
        body,
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['uploads', workspaceId] });
      qc.invalidateQueries({ queryKey: keys.tree(workspaceId) });
      qc.invalidateQueries({ queryKey: ['allDocuments', workspaceId] });
    },
  });
}

// --- search ----------------------------------------------------------------

export interface SearchFilters {
  q?: string;
  tags?: string[];
  from?: string;
  to?: string;
  folderId?: string;
}

/** Documents and spreadsheets that match. A server older than spreadsheets sends no `sheets`. */
export interface SearchResults {
  hits: SearchHit[];
  sheets?: SheetSearchHit[];
  query: string;
}

export function useSearch(workspaceId: string | undefined, filters: SearchFilters, enabled: boolean) {
  const query = qs({ ...filters, limit: 40 });
  return useQuery({
    queryKey: keys.search(workspaceId ?? '', query),
    queryFn: () => api.get<SearchResults>(`/workspaces/${workspaceId}/search${query}`),
    enabled: Boolean(workspaceId) && enabled,
    // Search results are cheap to refetch and stale ones feel broken while typing.
    staleTime: 0,
  } satisfies UseQueryOptions<SearchResults>);
}

// --- comments --------------------------------------------------------------

export function useComments(documentId: string | undefined) {
  return useQuery({
    queryKey: keys.comments(documentId ?? ''),
    queryFn: () => api.get<Comment[]>(`/documents/${documentId}/comments`),
    enabled: Boolean(documentId),
  });
}

export function useCreateComment(documentId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { body: string; parentId?: string | null }) =>
      api.post<Comment>(`/documents/${documentId}/comments`, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.comments(documentId) }),
  });
}

export function useUpdateComment(documentId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...patch }: { id: string; body?: string; resolved?: boolean }) =>
      api.patch<Comment>(`/comments/${id}`, patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.comments(documentId) }),
  });
}

export function useDeleteComment(documentId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/comments/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.comments(documentId) }),
  });
}

// --- calendar --------------------------------------------------------------

export function useEvents(workspaceId: string | undefined, from: string, to: string) {
  return useQuery({
    queryKey: keys.events(workspaceId ?? '', from, to),
    queryFn: () => api.get<CalendarEvent[]>(`/workspaces/${workspaceId}/events${qs({ from, to })}`),
    enabled: Boolean(workspaceId),
  });
}

export function useActivity(workspaceId: string | undefined, from: string, to: string) {
  return useQuery({
    queryKey: keys.activity(workspaceId ?? '', from, to),
    queryFn: () => api.get<ActivityDay[]>(`/workspaces/${workspaceId}/activity${qs({ from, to })}`),
    enabled: Boolean(workspaceId),
  });
}

export function useCreateEvent(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      title: string;
      startAt: string;
      endAt?: string | null;
      allDay?: boolean;
      documentId?: string | null;
    }) => api.post<CalendarEvent>(`/workspaces/${workspaceId}/events`, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['events', workspaceId] }),
  });
}

export function useDeleteEvent(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/events/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['events', workspaceId] }),
  });
}

// --- chat ------------------------------------------------------------------

export function useChannels(workspaceId: string | undefined) {
  return useQuery({
    queryKey: keys.channels(workspaceId ?? ''),
    queryFn: () => api.get<Channel[]>(`/workspaces/${workspaceId}/channels`),
    enabled: Boolean(workspaceId),
  });
}

export function useCreateChannel(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; topic?: string | null; kind?: 'text' | 'voice' }) =>
      api.post<Channel>(`/workspaces/${workspaceId}/channels`, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.channels(workspaceId) }),
  });
}

export function useUpdateChannel(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...patch }: { id: string; name?: string; topic?: string | null }) =>
      api.patch<Channel>(`/channels/${id}`, patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.channels(workspaceId) }),
  });
}

export function useDeleteChannel(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/channels/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.channels(workspaceId) }),
  });
}

export interface MessagePage {
  messages: Message[];
  hasMore: boolean;
  references: MessageReferences;
}

export function useMessages(channelId: string | undefined) {
  return useQuery({
    queryKey: keys.messages(channelId ?? ''),
    queryFn: () => api.get<MessagePage>(`/channels/${channelId}/messages?limit=50`),
    enabled: Boolean(channelId),
    // The socket delivers anything newer, so a refetch on focus would only
    // duplicate work and jump the scroll position.
    refetchOnWindowFocus: false,
  });
}

export function useSendMessage(channelId: string) {
  return useMutation({
    // The reply is ignored: the same message arrives over the socket, which is
    // the single path that appends to the list, so there is nothing to de-dupe.
    mutationFn: (input: { body: string; attachmentIds: string[] }) =>
      api.post<MessagePage>(`/channels/${channelId}/messages`, input),
  });
}

/**
 * Adds a reaction, or takes one back. The reply updates this view straight
 * away; everyone else's arrives over the socket.
 */
export function useToggleReaction(channelId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ messageId, emoji, on }: { messageId: string; emoji: string; on: boolean }) => {
      const path = `/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`;
      return on ? api.put<{ message: Message }>(path) : api.delete<{ message: Message }>(path);
    },
    onSuccess: ({ message }) => {
      qc.setQueryData<MessagePage>(keys.messages(channelId), (current) =>
        current
          ? { ...current, messages: current.messages.map((m) => (m.id === message.id ? message : m)) }
          : current,
      );
    },
  });
}

export function useEditMessage() {
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: string }) => api.patch(`/messages/${id}`, { body }),
  });
}

export function useDeleteMessage() {
  return useMutation({ mutationFn: (id: string) => api.delete(`/messages/${id}`) });
}

export function useMarkChannelRead(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (channelId: string) => api.post(`/channels/${channelId}/read`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.channels(workspaceId) });
      void qc.invalidateQueries({ queryKey: keys.directs(workspaceId) });
      void qc.invalidateQueries({ queryKey: keys.notifications });
    },
  });
}

// --- direct conversations --------------------------------------------------

/** The signed-in person's direct conversations in a workspace, most recent first. */
export function useDirectConversations(workspaceId: string | undefined) {
  return useQuery({
    queryKey: keys.directs(workspaceId ?? ''),
    queryFn: () => api.get<Channel[]>(`/workspaces/${workspaceId}/direct`),
    enabled: Boolean(workspaceId),
  });
}

/** Opens the conversation with one or more other members, starting it if there is none. */
export function useOpenDirect(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    // One person goes as `userId`, which every server understands; only a
    // group needs a server that knows about them.
    mutationFn: (userIds: string[]) =>
      api.post<Channel>(
        `/workspaces/${workspaceId}/direct`,
        userIds.length === 1 ? { userId: userIds[0] } : { userIds },
      ),
    onSuccess: (conversation) => {
      // In the list straight away, so opening it does not wait on a refetch to find it.
      qc.setQueryData<Channel[]>(keys.directs(workspaceId), (current) =>
        current && !current.some((c) => c.id === conversation.id) ? [conversation, ...current] : current,
      );
      void qc.invalidateQueries({ queryKey: keys.directs(workspaceId) });
    },
  });
}

/** A change to a group conversation, after which the list is refetched for everything it shows. */
function useDirectMutation<TInput, TResult>(workspaceId: string, fn: (input: TInput) => Promise<TResult>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.directs(workspaceId) }),
  });
}

/** Names a group conversation. An empty name goes back to naming it for its people. */
export const useRenameDirect = (workspaceId: string) =>
  useDirectMutation(workspaceId, ({ channelId, name }: { channelId: string; name: string }) =>
    api.patch<Channel>(`/direct/${channelId}`, { name }),
  );

export const useAddDirectMembers = (workspaceId: string) =>
  useDirectMutation(workspaceId, ({ channelId, userIds }: { channelId: string; userIds: string[] }) =>
    api.post<Channel>(`/direct/${channelId}/members`, { userIds }),
  );

/** Removes someone from a group conversation, or with your own id, leaves it. */
export const useRemoveDirectMember = (workspaceId: string) =>
  useDirectMutation(workspaceId, ({ channelId, userId }: { channelId: string; userId: string }) =>
    api.delete(`/direct/${channelId}/members/${userId}`),
  );

// --- presence --------------------------------------------------------------

/** Who in a workspace is around, keyed by user id. */
export function usePresence(workspaceId: string | undefined) {
  return useQuery({
    queryKey: keys.presence(workspaceId ?? ''),
    queryFn: () => api.get<Record<string, PresenceStatus>>(`/workspaces/${workspaceId}/presence`),
    enabled: Boolean(workspaceId),
    // The chat socket keeps this current, and it is asked for again whenever
    // the socket reconnects.
    staleTime: Infinity,
  });
}

/** The status you chose and how long you may be idle before showing as away. */
export function usePresenceSettings() {
  return useQuery({
    queryKey: keys.presenceSettings,
    queryFn: () => api.get<PresenceSettings>('/presence/me'),
    staleTime: Infinity,
  });
}

export function useUpdatePresenceSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<PresenceSettings>) => api.patch<PresenceSettings>('/presence/me', patch),
    // Shown at once: a status menu that lags its own click reads as broken.
    onMutate: async (patch) => {
      await qc.cancelQueries({ queryKey: keys.presenceSettings });
      const previous = qc.getQueryData<PresenceSettings>(keys.presenceSettings);
      if (previous) qc.setQueryData<PresenceSettings>(keys.presenceSettings, { ...previous, ...patch });
      return { previous };
    },
    onError: (_err, _patch, context) => {
      if (context?.previous) qc.setQueryData(keys.presenceSettings, context.previous);
    },
    onSuccess: (settings) => qc.setQueryData(keys.presenceSettings, settings),
  });
}

// --- notifications ---------------------------------------------------------

export function useNotifications() {
  return useQuery({
    queryKey: keys.notifications,
    queryFn: () => api.get<Notifications>('/notifications'),
    // Messages in workspaces other than the one open arrive on no socket here,
    // and invitations never do, so this is polled.
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });
}

/**
 * The version the server is running. A browser tab keeps the client it loaded,
 * so this is how it notices the server was upgraded since. The desktop app
 * ships its own client and is updated with the app instead.
 */
export function useServerVersion(enabled: boolean) {
  return useQuery({
    queryKey: ['serverVersion'],
    queryFn: async () => (await api.get<{ version: string | null }>('/health')).version,
    enabled,
    refetchInterval: 10 * 60_000,
    refetchOnWindowFocus: true,
  });
}

/** Marks the given channels read, or every channel when given none. */
export function useMarkNotificationsRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (channelIds?: string[]) => api.post('/notifications/read', channelIds ? { channelIds } : {}),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.notifications });
      void qc.invalidateQueries({ queryKey: ['channels'] });
      void qc.invalidateQueries({ queryKey: ['directs'] });
    },
  });
}

/**
 * Clears tags addressed to you in the given documents, or in all of them.
 * Opening a document you were tagged in calls this, so the bell stops asking
 * about something you have already read.
 */
export function useMarkMentionsRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (documentIds?: string[]) =>
      api.post('/notifications/mentions/read', documentIds ? { documentIds } : {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.notifications }),
  });
}

export function useDeclineInvite() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (inviteId: string) => api.post(`/notifications/invites/${inviteId}/decline`),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.notifications }),
  });
}

// --- voice and video -------------------------------------------------------

export interface VoiceConfig {
  enabled: boolean;
  url: string | null;
}

export interface CallCredentials {
  /** Null when the server relays signalling, meaning this page's own origin. */
  url: string | null;
  token: string;
  room: string;
  channelName: string;
  /** False where a lock lets this person listen but not speak. Absent from older servers. */
  canSpeak?: boolean;
}

export function useVoiceConfig() {
  return useQuery({
    queryKey: ['voiceConfig'],
    queryFn: () => api.get<VoiceConfig>('/voice/config'),
    // Whether the server has a voice service is a deployment fact, not
    // something that changes while someone is looking at it.
    staleTime: Infinity,
  });
}

/** Who is in each voice channel, keyed by channel id. */
export function useVoiceParticipants(workspaceId: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: keys.voiceParticipants(workspaceId ?? ''),
    queryFn: () => api.get<Record<string, VoiceOccupant[]>>(`/workspaces/${workspaceId}/voice/participants`),
    enabled: Boolean(workspaceId) && enabled,
    // Not polled: the chat socket brings each change as LiveKit reports it
    // (voice.changed), and a reconnect asks again for whatever was missed.
  });
}

export function useJoinCall() {
  return useMutation({
    mutationFn: (channelId: string) => api.post<CallCredentials>(`/channels/${channelId}/call`),
  });
}
