import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/* -------------------------------------------------------------------------- */
/* App identity assets                                                         */
/*                                                                            */
/* There is no public/ directory in this package, so the installable-app       */
/* assets referenced by index.html are generated here. Keeping them in the     */
/* config means the manifest values cannot drift from the theme tokens.        */
/* -------------------------------------------------------------------------- */

const BRAND = {
  name: "ConstructOS",
  shortName: "ConstructOS",
  description: "AI-native construction delivery and assurance.",
  /** Must match THEME_COLOR.light in src/ui/tokens.ts. */
  backgroundColor: "#f6f7fa",
  themeColor: "#f6f7fa",
  /** brand-500 → brand-700 from styles.css. */
  gradientFrom: "#3380fc",
  gradientTo: "#164bde",
};

const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-label="${BRAND.name}">
  <defs>
    <linearGradient id="c" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${BRAND.gradientFrom}"/>
      <stop offset="1" stop-color="${BRAND.gradientTo}"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="116" fill="url(#c)"/>
  <path d="M338 174A116 116 0 1 0 338 338" fill="none" stroke="#fff" stroke-width="58" stroke-linecap="round"/>
</svg>
`;

const WEB_MANIFEST = JSON.stringify(
  {
    name: BRAND.name,
    short_name: BRAND.shortName,
    description: BRAND.description,
    id: "/",
    start_url: "/",
    scope: "/",
    display: "standalone",
    display_override: ["window-controls-overlay", "standalone"],
    orientation: "any",
    background_color: BRAND.backgroundColor,
    theme_color: BRAND.themeColor,
    categories: ["business", "productivity"],
    icons: [
      {
        src: "/icon.svg",
        sizes: "any",
        type: "image/svg+xml",
        purpose: "any",
      },
      {
        src: "/icon.svg",
        sizes: "any",
        type: "image/svg+xml",
        purpose: "maskable",
      },
    ],
  },
  null,
  2,
);

const GENERATED: Record<string, { body: string; type: string }> = {
  "/manifest.webmanifest": {
    body: WEB_MANIFEST,
    type: "application/manifest+json; charset=utf-8",
  },
  "/icon.svg": { body: ICON_SVG, type: "image/svg+xml; charset=utf-8" },
};

function appIdentityAssets(): Plugin {
  return {
    name: "constructos:app-identity",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const pathname = (req.url ?? "").split("?")[0] ?? "";
        const asset = GENERATED[pathname];
        if (!asset) {
          next();
          return;
        }
        res.setHeader("Content-Type", asset.type);
        res.setHeader("Cache-Control", "no-cache");
        res.end(asset.body);
      });
    },
    configurePreviewServer(server) {
      server.middlewares.use((req, res, next) => {
        const pathname = (req.url ?? "").split("?")[0] ?? "";
        const asset = GENERATED[pathname];
        if (!asset) {
          next();
          return;
        }
        res.setHeader("Content-Type", asset.type);
        res.end(asset.body);
      });
    },
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "manifest.webmanifest",
        source: WEB_MANIFEST,
      });
      this.emitFile({ type: "asset", fileName: "icon.svg", source: ICON_SVG });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), appIdentityAssets()],
  resolve: {
    // Single React instance across the workspace — framer-motion, cmdk and
    // react-day-picker all rely on shared context.
    dedupe: ["react", "react-dom"],
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: process.env.VITE_API_URL ?? "http://localhost:4000",
        changeOrigin: true,
      },
    },
  },
  build: {
    chunkSizeWarningLimit: 4000,
  },
  optimizeDeps: {
    exclude: ["web-ifc"],
  },
});
