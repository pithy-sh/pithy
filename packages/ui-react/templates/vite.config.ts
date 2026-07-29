import { cloudflare } from "@cloudflare/vite-plugin";
import { pithy } from "@pithy-sh/vite/src/plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    react(),
    cloudflare({
      // Local state lives at the PROJECT root, not here — the same store pithy dev, migrate, and seed
      // use. Per-worker state would silently give two workers separate copies of a shared database.
      persistState: { path: "../../.wrangler/state" },
      // Pinned off. The inspector defaults to 9229 and silently advances on a collision, so two
      // UI-bearing workers under one pithy dev would drift onto ports nobody assigned them.
      inspectorPort: false,
    }),
    pithy(),
  ],
});
