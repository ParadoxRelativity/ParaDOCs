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
  if (!res.ok) throw new ApiError(res.status, errorDetail(payload) || `Request failed (${res.status})`);
  return payload as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function errorDetail(payload: unknown): string {
  return payload && typeof payload === 'object' && 'error' in payload
    ? String((payload as { error: unknown }).error)
    : '';
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body ?? {}),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
  delete: <T = void>(path: string) => request<T>('DELETE', path),
  /**
   * Posts multipart form data, reporting progress as it goes. Built on
   * XMLHttpRequest because fetch cannot report upload progress.
   */
  uploadWithProgress: <T>(
    path: string,
    form: FormData,
    onProgress: (fraction: number) => void,
    signal?: AbortSignal,
  ) =>
    new Promise<T>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `/api${path}`);
      xhr.withCredentials = true;
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(e.loaded / e.total);
      };
      xhr.onload = () => {
        const payload = xhr.responseText ? safeJson(xhr.responseText) : null;
        if (xhr.status >= 200 && xhr.status < 300) resolve(payload as T);
        else reject(new ApiError(xhr.status, errorDetail(payload) || `Upload failed (${xhr.status})`));
      };
      xhr.onerror = () => reject(new ApiError(0, 'The upload did not finish. Check the connection and try again.'));
      xhr.onabort = () => reject(new DOMException('The upload was cancelled', 'AbortError'));
      if (signal?.aborted) {
        reject(new DOMException('The upload was cancelled', 'AbortError'));
        return;
      }
      signal?.addEventListener('abort', () => xhr.abort(), { once: true });
      xhr.send(form);
    }),
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
