import { useMutation, useQuery, useQueryClient, type UseQueryOptions } from '@tanstack/react-query';
import type {
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
  Role,
  SearchHit,
  Tag,
  User,
  VoiceOccupant,
  Workspace,
  WorkspaceInvite,
  WorkspaceMember,
} from '@paradocs/shared';
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
      for (const queryKey of [keys.me, ['members'], ['comments'], ['messages']]) {
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
    mutationFn: (id: string) => api.delete(`/folders/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.tree(workspaceId) }),
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

export function useSearch(workspaceId: string | undefined, filters: SearchFilters, enabled: boolean) {
  const query = qs({ ...filters, limit: 40 });
  return useQuery({
    queryKey: keys.search(workspaceId ?? '', query),
    queryFn: () => api.get<{ hits: SearchHit[]; query: string }>(`/workspaces/${workspaceId}/search${query}`),
    enabled: Boolean(workspaceId) && enabled,
    // Search results are cheap to refetch and stale ones feel broken while typing.
    staleTime: 0,
  } satisfies UseQueryOptions<{ hits: SearchHit[]; query: string }>);
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
    mutationFn: (body: string) => api.post<MessagePage>(`/channels/${channelId}/messages`, { body }),
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
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.channels(workspaceId) }),
  });
}

// --- voice and video -------------------------------------------------------

export interface VoiceConfig {
  enabled: boolean;
  url: string | null;
}

export interface CallCredentials {
  url: string;
  token: string;
  room: string;
  channelName: string;
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
    queryKey: ['voiceParticipants', workspaceId],
    queryFn: () => api.get<Record<string, VoiceOccupant[]>>(`/workspaces/${workspaceId}/voice/participants`),
    enabled: Boolean(workspaceId) && enabled,
    // Rooms fill and empty without telling us, so this is polled while the
    // chat tab is open and not at all otherwise.
    refetchInterval: 10_000,
  });
}

export function useJoinCall() {
  return useMutation({
    mutationFn: (channelId: string) => api.post<CallCredentials>(`/channels/${channelId}/call`),
  });
}
