import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import "./app.css";

function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 15_000,
        gcTime: 5 * 60_000,
        refetchOnWindowFocus: false,
        retry: 1
      }
    }
  });
}

export function mountApp(page: ReactNode, rootId = "root"): void {
  const container = document.getElementById(rootId);
  if (!container) {
    throw new Error(`Missing app root: ${rootId}`);
  }

  createRoot(container).render(
    <StrictMode>
      <QueryClientProvider client={createQueryClient()}>{page}</QueryClientProvider>
    </StrictMode>
  );
}
