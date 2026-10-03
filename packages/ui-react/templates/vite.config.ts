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
  /**
   * One pre-bundled chunk for the kit, because every extra chunk is a round trip.
   *
   * Before this Worker serves a request, `@cloudflare/vite-plugin` has to know which classes it
   * exports, so it imports the whole module graph *inside workerd* and sorts the exports by what they
   * extend. That forces every statically reachable module to load, and the module runner fetches them
   * **one at a time**. It is round-trip latency rather than build work, so what it costs is a function
   * of how many modules there are — not how big they are.
   *
   * The dependency optimizer splits the kit into many small chunks, and each one is another round trip
   * for no benefit. Merging them into one measured **~40s to ~28s** on a Worker composing nine
   * capabilities, a median across runs.
   *
   * **Dev only.** `optimizeDeps` is not consulted by `vite build`, so the shipped bundle is unchanged
   * and no tree-shaking is given up.
   */
  environments: {
    // **A computed key, and the three underscores are not a typo.** A worker directory is kebab-case
    // (`WORKER_NAME` is `^[a-z0-9]+(?:-[a-z0-9]+)*$`), so a bare `worker_my-api:` is a syntax error that
    // takes the whole config with it — and quoting it instead does not survive, because Biome's
    // `quoteProperties: "asNeeded"` strips redundant quotes on the next `format`, restoring the error.
    // A computed key is the one spelling that is both valid and stable under the formatter.
    ["worker___PITHY_WORKER__"]: {
      optimizeDeps: {
        rolldownOptions: { output: { advancedChunks: { groups: [{ name: "pithy-deps", test: /.*/ }] } } },
      },
    },
  },
  plugins: [
    react(),
    cloudflare({
      /**
       * Pin the Vite environment name to this Worker's directory name.
       *
       * Left alone, the plugin names the environment after the **deployed** Worker — `<project>-<worker>`
       * with hyphens swapped for underscores — which is not a name this file can be scaffolded with: the
       * generator knows the directory name and not the project's. Pinning it is what lets `environments`
       * above key the same token, and a key that names no environment is silently dropped rather than
       * reported, so matching them by construction is the only way to be sure the block applies.
       *
       * **Prefixed, because `client` is a reserved Vite environment name.** The plugin throws on it
       * outright, and `apps/client` is a legal worker directory that nothing refuses — so pinning to the
       * bare name would turn a working project into one that cannot start. The prefix also guarantees no
       * collision with any environment Vite creates for itself.
       */
      viteEnvironment: { name: "worker___PITHY_WORKER__" },
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
