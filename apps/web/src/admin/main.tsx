import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import AdminApp from './AdminApp';
import { AdminApiError, adminKeys } from './api';
import { ToastProvider } from '../components/Toast';
import 'bootstrap-icons/font/bootstrap-icons.min.css';
import '../index.css';

// The admin page is its own origin, so it cannot read the app's saved theme.
// It follows the system instead. This runs from the bundle rather than inline
// in the page, which the admin server's content security policy forbids.
const dark = window.matchMedia('(prefers-color-scheme: dark)');
const applyTheme = () => document.documentElement.classList.toggle('dark', dark.matches);
applyTheme();
dark.addEventListener('change', applyTheme);

/** An admin session that ran out, or was ended elsewhere, returns to sign-in. */
function onError(err: unknown) {
  if (err instanceof AdminApiError && err.status === 401) {
    void queryClient.invalidateQueries({ queryKey: adminKeys.status });
  }
}

const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError }),
  mutationCache: new MutationCache({ onError }),
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      // A refusal will not change on retry; only a server error might.
      retry: (count, err) => !(err instanceof AdminApiError && err.status < 500) && count < 1,
    },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <AdminApp />
      </ToastProvider>
    </QueryClientProvider>
  </StrictMode>,
);
