import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { ApiError } from './api/client';
import { ToastProvider } from './components/Toast';
import ServerPicker from './components/ServerPicker';
import { isNativeApp, serverOrigin } from './lib/server';
import 'bootstrap-icons/font/bootstrap-icons.min.css';
// BlockNote's styles are a chain of `@import url(...)` files, which Tailwind
// leaves unresolved if they go through index.css; Vite's own CSS pipeline
// follows them. Imported ahead of index.css so its overrides still win.
import '@blocknote/core/fonts/inter.css';
import '@blocknote/mantine/style.css';
import './index.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Documents change under the user's own hands, so refetching on focus is noise.
      refetchOnWindowFocus: false,
      staleTime: 10_000,
      // Once, for a blip, but never for something that is not there: asking
      // again only delays showing that it is gone.
      retry: (failures, error) => failures < 1 && !(error instanceof ApiError && error.status === 404),
    },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        {/* The mobile app has to know its server before anything can load.
            Choosing one reloads the page, so this is settled for its lifetime. */}
        {isNativeApp && !serverOrigin() ? (
          <ServerPicker />
        ) : (
          <BrowserRouter>
            <App />
          </BrowserRouter>
        )}
      </ToastProvider>
    </QueryClientProvider>
  </StrictMode>,
);
