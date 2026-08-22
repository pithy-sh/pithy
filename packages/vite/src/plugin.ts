// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

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

/**
 * What {@link pithy} hands back: a Vite plugin, described without naming a Vite type.
 *
 * **The return type used to be Vite's own `Plugin`, and that made the peer range a lie — Jim,
 * 2026-08-21 (#414).** `package.json` declares `vite: ^6.1.0 || ^7.0.0 || ^8.0.0`, but a `Plugin` in
 * the signature is a `Plugin` out of *this package's* `node_modules`. An adopter who resolved any
 * other copy — which is every adopter developing against a symlinked kit, and every adopter whose
 * install did not deduplicate — had to prove the kit's copy assignable to theirs, field by field,
 * before `plugins: [pithy()]` would compile. Across majors that comparison fails outright: `hotUpdate`
 * does not carry the same `this` in 6 as in 8, so this plugin was not a Vite 6 plugin however identical
 * the hook body is. Within a major it does not even finish — `Plugin` is deep and recursive enough to
 * exhaust tsc's depth budget, which is the `TS2321: Excessive stack depth` that stopped
 * `pithy-sh/dashboard` typechecking the `vite.config.ts` `pithy init` had just written for it. A peer
 * dependency that only compiles when the install deduplicates is not a peer dependency.
 *
 * So the signature promises the two things every Vite in that range agrees on and an adopter's
 * checker can settle in two comparisons: the plugin has a name, and it runs early. No recursion, no
 * hook signatures, nothing that can differ between two copies of the same library.
 *
 * **What is still checked.** The object below is written `satisfies Plugin` against the Vite this
 * package develops against, so every hook keeps its parameter types, its `this`, and its return type.
 * A hook that reads the wrong field off `config`, returns the wrong shape, or is spelled with a name
 * Vite does not call is still a red build — here, where the kit is compiled, and in
 * `tooling/vite-adopter`, which compiles this file too.
 *
 * **What is not.** The adopter's checker no longer re-derives any of that against their copy. It sees
 * two properties and takes the hooks on trust. Four things pay for that trust and none of them is a
 * type an adopter has to compare: `tooling/vite-adopter` compiles the return against every major in
 * the peer range and runs a real `vite build` through the plugin at each of them, {@link
 * PITHY_PLUGIN_HOOKS} holds every hook name to something all three call, `plugin.test.ts` drives each
 * hook by hand, and it runs a real `vite build` and reads the bundle.
 *
 * **One gap, named rather than papered over — Jim, 2026-08-21.** The hook *signatures* are checked
 * against one Vite, and there is no arrangement in which they could be checked against three. Vite 8
 * is rolldown-based and Vite 6 and 7 are rollup-based, so `hotUpdate`'s `this` is
 * `MinimalPluginContext & { environment: DevEnvironment }` out of two different bundlers — `meta`
 * carries `rolldownVersion` in one and not the other. A single object cannot be written `satisfies
 * Plugin` against both; restoring `pithy(): Plugin` reports exactly that at 6.1.6 and 7.0.0, and it is
 * a fact about the two Vites rather than about this plugin. What is checked across the range is the
 * hook *set* and the hook *behavior*: a name Vite 6 never calls is a red build, and a build that does
 * not inline the projection at 6.1.6 is a red test. What is taken on trust across the range is that a
 * hook Vite 6 calls with an argument of its own shape reaches the same field.
 *
 * **Why the floor is `^6.1.0` is not recorded here, because the reason first written down was wrong —
 * Jim, 2026-08-21.** It said `hotUpdate` arrived in 6.1 and that below it this plugin would be silently
 * inert. It did not: `npm pack vite@6.0.0` carries `hotUpdate?: ObjectHook<…>` in `index.d.ts`, and its
 * `HotUpdatePluginContext` is byte-identical to 6.1.6's. The floor may still be right for a reason
 * nobody has written down, and `6.0.0` is not pinned in `tooling/vite-adopter`, so nothing here has ever
 * compiled against it.
 *
 * Two honest next steps, neither taken in this change: pin `6.0.0` in the fixture and find out, or drop
 * the floor to `^6.0.0` and let the fixture say whether that holds. **An invented reason is worse than
 * an absent one**, because the next person reads it instead of measuring.
 */
export interface PithyPlugin {
  /** `"pithy"`. The plugin's identity in Vite's plugin list, and in any error raised from a hook. */
  name: string;
  /**
   * `"pre"`, always. `virtual:pithy/*` is claimed before any other plugin can, so the order of an
   * adopter's `plugins` array never decides whether the front end can read its own backend.
   */
  enforce: "pre";
}

/**
 * Every hook {@link pithy} defines, by name.
 *
 * **The one thing about the hooks an adopter's checker can be given for free.** {@link PithyPlugin}
 * deliberately names no Vite type, so nothing in the return says which hooks exist — and a hook Vite
 * never calls is dead code that looks like a feature. A name is not a Vite type: `tooling/vite-adopter`
 * asserts each of these is a `keyof Plugin` in 6, 7 and 8, which costs an adopter nothing and catches
 * the regression that matters here. Adding a `buildApp` hook, which Vite 7 introduced and Vite 6 has no
 * name for, reddens the fixture rather than shipping under a range that claims 6.
 *
 * `plugin.test.ts` holds this list to the object itself, both directions, at runtime — a hook added
 * without listing it is a failure there, and a name listed that no longer exists is one too. A list
 * that can drift from what it lists is a worse gate than none.
 */
export const PITHY_PLUGIN_HOOKS = ["configResolved", "configureServer", "resolveId", "load", "hotUpdate"] as const;

/** One of the names {@link PITHY_PLUGIN_HOOKS} lists. */
export type PithyPluginHook = (typeof PITHY_PLUGIN_HOOKS)[number];

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
export function pithy(options: PithyPluginOptions = {}): PithyPlugin {
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

  // `satisfies` rather than an annotation, and the difference is the whole fix. It contextually types
  // every hook below against Vite's `Plugin` — same checking as the old `: Plugin` return type gave —
  // while leaving the literal's own type intact, so the narrow `PithyPlugin` the signature promises is
  // still derived from what is actually returned rather than asserted over it. A `const` because a
  // fresh object literal returned straight out would be excess-property-checked against `PithyPlugin`,
  // which names none of the hooks.
  const plugin = {
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
  } satisfies Plugin;

  return plugin;
}
