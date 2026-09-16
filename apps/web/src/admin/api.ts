import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AdminCreateUserInput,
  AdminStatus,
  AdminUpdateUserInput,
  AdminUser,
  AdminVersionStatus,
  ServerSettings,
  UpdateServerSettingsInput,
} from '@paradocs/shared';

/** Client for the server admin API, served on the admin port under /api/admin. */

export class AdminApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<T> {
  const read = method === 'GET';
  const res = await fetch(`/api/admin${path}`, {
    method,
    credentials: 'same-origin',
    // Every change carries the admin header, which the server requires so that
    // no other page can act here; see admin/session.ts in the API.
    headers: read ? undefined : { 'content-type': 'application/json', 'x-paradocs-admin': '1' },
    body: read ? undefined : JSON.stringify(body ?? {}),
  });
  if (res.status === 204) return undefined as T;

  const text = await res.text();
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    // Not JSON; the status says enough.
  }
  if (!res.ok) {
    const detail = payload && typeof payload === 'object' && 'error' in payload ? String(payload.error) : '';
    throw new AdminApiError(res.status, detail || `Request failed (${res.status})`);
  }
  return payload as T;
}

export const adminKeys = {
  all: ['admin'] as const,
  status: ['admin', 'status'] as const,
  settings: ['admin', 'settings'] as const,
  users: ['admin', 'users'] as const,
  version: ['admin', 'version'] as const,
};

// --- session -----------------------------------------------------------------

export function useAdminStatus() {
  return useQuery({ queryKey: adminKeys.status, queryFn: () => request<AdminStatus>('GET', '/status') });
}

/** Signing in or out changes whose data is on screen, so everything else is dropped. */
function useSessionChange() {
  const qc = useQueryClient();
  return (status: AdminStatus | null) => {
    qc.removeQueries({ predicate: (q) => q.queryKey[0] === 'admin' && q.queryKey[1] !== 'status' });
    if (status) qc.setQueryData(adminKeys.status, status);
    else void qc.invalidateQueries({ queryKey: adminKeys.status });
  };
}

export function useAdminLogin() {
  const changed = useSessionChange();
  return useMutation({
    mutationFn: (input: { email: string; password: string }) => request<AdminStatus>('POST', '/login', input),
    onSuccess: changed,
  });
}

export function useAdminSetup() {
  const changed = useSessionChange();
  return useMutation({
    mutationFn: (input: { name: string; email: string; password: string }) =>
      request<AdminStatus>('POST', '/setup', input),
    onSuccess: changed,
  });
}

export function useAdminLogout() {
  const changed = useSessionChange();
  return useMutation({
    mutationFn: () => request<void>('POST', '/logout'),
    onSettled: () => changed(null),
  });
}

// --- settings ----------------------------------------------------------------

export function useServerSettings() {
  return useQuery({ queryKey: adminKeys.settings, queryFn: () => request<ServerSettings>('GET', '/settings') });
}

export function useUpdateServerSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateServerSettingsInput) => request<ServerSettings>('PATCH', '/settings', input),
    onSuccess: (settings) => qc.setQueryData(adminKeys.settings, settings),
  });
}

// --- version -----------------------------------------------------------------

export function useVersionStatus() {
  return useQuery({
    queryKey: adminKeys.version,
    queryFn: () => request<AdminVersionStatus>('GET', '/version'),
    // The server checks on its own schedule; this only picks up what it found.
    refetchInterval: 10 * 60_000,
  });
}

export function useCheckForUpdate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => request<AdminVersionStatus>('POST', '/version/check'),
    onSuccess: (status) => qc.setQueryData(adminKeys.version, status),
  });
}

// --- accounts ----------------------------------------------------------------

export function useAdminUsers(search: string) {
  return useQuery({
    queryKey: [...adminKeys.users, search],
    queryFn: () =>
      request<{ users: AdminUser[]; total: number }>(
        'GET',
        `/users${search ? `?q=${encodeURIComponent(search)}` : ''}`,
      ),
    // Keeps the list in place while a new search loads, instead of flashing empty.
    placeholderData: keepPreviousData,
  });
}

/**
 * A change to an account. Everything under admin is refetched afterwards: the
 * signed-in administrator's own name can be among what changed.
 */
function useAccountMutation<TInput, TResult>(fn: (input: TInput) => Promise<TResult>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => qc.invalidateQueries({ queryKey: adminKeys.all }),
  });
}

export const useCreateUser = () =>
  useAccountMutation((input: AdminCreateUserInput) => request<AdminUser>('POST', '/users', input));

export const useUpdateUser = () =>
  useAccountMutation(({ id, input }: { id: string; input: AdminUpdateUserInput }) =>
    request<AdminUser>('PATCH', `/users/${id}`, input),
  );

export const useSetUserPassword = () =>
  useAccountMutation(({ id, password }: { id: string; password: string }) =>
    request<void>('POST', `/users/${id}/password`, { password }),
  );

export const useSignOutUser = () =>
  useAccountMutation((id: string) => request<void>('POST', `/users/${id}/sign-out`));

export const useDeleteUser = () => useAccountMutation((id: string) => request<void>('DELETE', `/users/${id}`));
