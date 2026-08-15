---
"@pithy-sh/vite": minor
---

Read the config projection in a test. `pithyTest` is the Pithy plugin, for a test runner's config — one line in the test project, and every module that reaches `virtual:pithy/*` becomes mountable.

**A module that reads the projection could be built and could not be tested.** Vitest bundles its config and hands every bare specifier to node, so `import { pithy } from "@pithy-sh/vite/src/plugin"` in a `vitest.config.ts` reached an extensionless import inside `@pithy-sh/core` that node cannot resolve. The config never loaded, and no test ran. Without the plugin the virtual modules resolve nowhere at all — and that failure is transitive, so one unreadable projection took every screen whose import graph reached it. In `pithy-sh/dashboard` that was thirteen test files behind one module, and three lanes hit the same wall independently.

```ts
import { pithyTest } from "@pithy-sh/vite/src/testPlugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [pithyTest({ configFile: "apps/board/pithy.config.ts" })],
  test: { environment: "happy-dom" },
});
```

`configFile` resolves against the Vite root, which for a test run is usually the repository root rather than the Worker's directory — so a monorepo names its Worker and a single-Worker project takes the default. It goes on the test project that mounts client modules, and nowhere else: no consumer of the projection configures anything.

**It is not a second plugin, and that is the point.** It resolves to the object `pithy()` returns, built from `plugin.ts` through vite's own loader — same config, same `resolveClientProjection`, same `renderVirtualModule`. A test imports the module a build inlines, byte for byte, so a Paddle Price id or a Turnstile sitekey reads under test as the value that environment actually ships. There is no fixture, and therefore nothing that can drift from the projection.

That is held rather than asserted. `testPlugin.test.ts` lays out a throwaway project the way an adopter's is, renders the module through the **build** plugin's own hooks, and runs a real child `vitest` that compares what it imports against it — from a test file two hops away that names no virtual module. Its whole static graph is `vite` and `node:url`, because anything else would be handed to node again; the child run is what says so out loud the moment an import is added.

**Restating the values instead is not always available**, which is why this had to be closed here. A base path is the same in every account. A Price id is not — it is a sandbox id the day a live catalog appears — so for exactly the values that most need the projection, a hand-written copy in a client module is the wrong answer.
