/** Thin fetch wrapper. Requests are same-origin thanks to the Vite proxy. */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  // Form data sets its own multipart content type, boundary included.
  const form = body instanceof FormData;
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'include',
    headers: body === undefined || form ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : form ? body : JSON.stringify(body),
  });

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  const payload = text ? safeJson(text) : null;
  if (!res.ok) {
    const detail =
      payload && typeof payload === 'object' && 'error' in payload
        ? String((payload as { error: unknown }).error)
        : '';
    throw new ApiError(res.status, detail || `Request failed (${res.status})`);
  }
  return payload as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
  delete: (path: string) => request<void>('DELETE', path),
  /** Sends one file as multipart form data. */
  upload: <T>(method: 'POST' | 'PUT', path: string, file: Blob) => {
    const form = new FormData();
    form.append('file', file);
    return request<T>(method, path, form);
  },
  /** Returns the raw text body, for the markdown export endpoint. */
  text: async (path: string) => {
    const res = await fetch(`/api${path}`, { credentials: 'include' });
    if (!res.ok) throw new ApiError(res.status, `Request failed (${res.status})`);
    return res.text();
  },
};

/** Builds a querystring, repeating a key for each value in an array. */
export function qs(params: Record<string, string | number | boolean | string[] | undefined | null>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) value.forEach((v) => search.append(key, v));
    else search.set(key, String(value));
  }
  const out = search.toString();
  return out ? `?${out}` : '';
}
