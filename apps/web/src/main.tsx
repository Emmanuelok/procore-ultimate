import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { ThemeProvider } from "./lib/theme";
import { AppErrorBoundary, Toaster } from "./ui";
import "./styles.css";

/**
 * Root wiring.
 *
 *   ThemeProvider      theme + density on <html>, persisted, no flash
 *     AppErrorBoundary the last line of defence — a crash inside App shows a
 *                      recoverable page instead of a white screen
 *       App            router, auth, shortcuts, palette, shell
 *     Toaster          one toast stack for the whole app, themed
 */
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider>
      <AppErrorBoundary variant="page">
        <App />
      </AppErrorBoundary>
      <Toaster />
    </ThemeProvider>
  </StrictMode>,
);
