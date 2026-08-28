import { cloudflare } from "@cloudflare/vite-plugin";
import { devWorkerConfig } from "@pithy-sh/vite/src/devOrigin";
import { pithy } from "@pithy-sh/vite/src/plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  /**
   * One React, however many checkouts the packages live in.
   *
   * Vite resolves a symlinked package from its realpath, so a package linked in from somewhere else —
   * the Pithy kit, a design system, any workspace you point at by path — imports `react` out of *its*
   * tree rather than out of this Worker's. Two copies of React is `invalid hook call` on the first
   * component that package renders, and the stack blames the component rather than the resolution.
   *
   * `dedupe` resolves both names from Vite's root no matter who asked, and the root here is this
   * Worker's own directory, where `react` is a dependency and there is therefore something to resolve.
   * That is not true one level up: the project's `vitest.config.ts` is rooted at the repository, which
   * has no React, so it states the same rule as an explicit alias instead. Read the note there before
   * moving either.
   *
   * It is not a workaround for a symlink. It is what every linked-package setup needs, it costs nothing
   * when nothing is linked, and it goes on costing nothing the day `@pithy-sh/*` is published.
   */
  resolve: { dedupe: ["react", "react-dom"] },
  plugins: [
    react(),
    cloudflare({
      // `BASE_URL` from the port block `pithy dev` allocated *this checkout*, overriding the one in
      // wrangler.jsonc while dev is running. A dev port is allocated rather than configured, so a
      // literal there is right in the first checkout on a machine and wrong in every other one — and
      // `BASE_URL` is the `iss` on every control-plane token this Worker signs and the origin its
      // callback links are built against. Outside `pithy dev` it does nothing and the declared value
      // stands, which is what a deployed environment wants. See `devWorkerConfig`.
      config: devWorkerConfig(),
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
