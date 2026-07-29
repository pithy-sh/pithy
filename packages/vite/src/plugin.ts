import { resolve } from "node:path";
import { resolveClientProjection } from "@pithy-sh/core/src/capability/client";
import { type EnvironmentModuleNode, normalizePath, type Plugin, type ViteDevServer } from "vite";
import {
  capabilityNameFromResolvedId,
  isResolvedVirtualId,
  renderVirtualModule,
  resolveVirtualId,
} from "./virtualModule";
import { type LoadedWorkerConfig, loadWorkerConfig } from "./workerConfig";

/** Options for {@link pithy}. Every one has a working default; `pithy()` is the usual call. */
export interface PithyPluginOptions {
  /**
   * The Worker's `pithy.config.ts`. Relative paths resolve against the Vite root, which for a Pithy
   * Worker is `apps/<name>/` — so the default, `pithy.config.ts`, is already the right file.
   */
  configFile?: string;
  /**
   * The environment this bundle is built for. Defaults to `ENVIRONMENT` in the process env, then
   * `dev`. `pithy deploy --env <name>` is what threads a real value in, so a production bundle sees
   * production's projection and a dev bundle sees dev's.
   */
  environment?: string;
}

/**
 * Serve one `virtual:pithy/<capability>` module per capability, projected from the Worker's own
 * `pithy.config.ts`.
 *
 * A screen imports what it needs — `import auth from "virtual:pithy/auth"` — and gets that
 * capability's client-safe projection inlined at build time. A capability the Worker does not compose
 * resolves to `{ enabled: false }` rather than failing the import, including a name nobody has ever
 * heard of: a screen branches on `enabled`, it does not guard on whether the module exists.
 */
export function pithy(options: PithyPluginOptions = {}): Plugin {
  const environment = options.environment ?? process.env.ENVIRONMENT ?? "dev";
  let configFile = "";
  // Memoize the promise, not the value: `load` runs concurrently for every virtual module a bundle
  // imports, and each `runnerImport` builds a fresh environment. One promise means one config load.
  let loading: Promise<LoadedWorkerConfig> | null = null;
  let server: ViteDevServer | undefined;
  const watched = new Set<string>();

  function watch(files: Iterable<string>): void {
    for (const file of files) {
      const path = normalizePath(file);
      if (watched.has(path)) continue;
      watched.add(path);
      server?.watcher.add(path);
    }
  }

  function loadOnce(): Promise<LoadedWorkerConfig> {
    loading ??= loadWorkerConfig(configFile)
      .then((loaded) => {
        // The config's transitive imports are watched too, so editing a file the config imports
        // reloads the front end just like editing the config itself.
        watch(loaded.dependencies);
        return loaded;
      })
      .catch((cause: unknown) => {
        // Never memoize a failure. A first load can fail for reasons the developer is about to fix —
        // most often `pithy dev` run before `bun install`, so the config's `@pithy-sh/*` imports do
        // not resolve. Caching the rejection would wedge the dev server on that error until restart,
        // and `hotUpdate` could not rescue it: the watch set only learns the config's transitive
        // imports from a load that SUCCEEDED, so a file the developer then edits may not be watched.
        loading = null;
        throw cause;
      });
    return loading;
  }

  return {
    name: "pithy",
    // Claim `virtual:pithy/*` before any other plugin can, so the plugin array's order in an
    // adopter's vite.config.ts never decides whether the front end can read its own backend.
    enforce: "pre",

    configResolved(config) {
      // `resolve` leaves an absolute option alone and anchors a relative one to the Vite root.
      configFile = normalizePath(resolve(config.root, options.configFile ?? "pithy.config.ts"));
      watch([configFile]);
    },

    configureServer(devServer) {
      server = devServer;
      // Watch before the first load: a config that fails to import is still watched, so fixing it
      // recovers the dev server instead of requiring a restart.
      for (const path of watched) devServer.watcher.add(path);
    },

    resolveId(id) {
      return resolveVirtualId(id);
    },

    async load(id) {
      const name = capabilityNameFromResolvedId(id);
      if (name === null) return null;
      const { capabilities } = await loadOnce();
      return renderVirtualModule(resolveClientProjection(capabilities.get(name), { environment }));
    },

    hotUpdate({ file }) {
      if (!watched.has(normalizePath(file))) return;
      // Drop the memo so the next `load` re-reads the config, then invalidate what it produced.
      loading = null;
      const invalidated: EnvironmentModuleNode[] = [];
      for (const [id, module] of this.environment.moduleGraph.idToModuleMap) {
        if (!isResolvedVirtualId(id)) continue;
        this.environment.moduleGraph.invalidateModule(module);
        invalidated.push(module);
      }
      // Config is read at module scope by screens all over the app; a full reload is the honest
      // update, and returning the invalidated modules keeps Vite from also guessing at one.
      this.environment.hot.send({ type: "full-reload" });
      return invalidated;
    },
  };
}
