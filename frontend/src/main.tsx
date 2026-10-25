import "@fontsource-variable/geist";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "@fontsource/ibm-plex-mono/600.css";
import "@fontsource/instrument-serif/400.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ApiRequestError, ApiUnreachableError, SchemaError } from "./api/client";
import App from "./App";
import "./index.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Retry only transient failures; validation, 4xx and schema errors are final.
      retry: (count, error) => {
        if (error instanceof SchemaError) return false;
        if (error instanceof ApiRequestError) return error.status === 503 && error.code === "busy" && count < 2;
        if (error instanceof ApiUnreachableError) return count < 1;
        return count < 1;
      },
      refetchOnWindowFocus: false,
      // Keep showing the last good data on error; panels label it STALE.
      staleTime: 2000,
    },
    mutations: { retry: false },
  },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
