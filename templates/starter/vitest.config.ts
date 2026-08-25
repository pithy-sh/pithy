import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/** This file sits at the project root, and every path below is resolved from it rather than from a cwd. */
const PROJECT_ROOT = dirname(fileURLToPath(import.meta.url));

/**
 * The directory `name` resolves to when a Worker asks for it, or `null` when it resolves nowhere.
 *
 * Node's own resolution, walking outward from the Worker: `apps/<worker>/node_modules` first, then the
 * project root's, then whatever is above that. Deliberately not a fixed path — Bun installs a workspace
 * member's dependencies beside that member, npm and pnpm hoist most of them to the root, and both
 * answers are correct. Asking the resolver means this file needs no opinion about which you use.
 *
 * `<name>/package.json` rather than the bare name, because the bare name answers with an entry file
 * that differs per export condition, and what an alias replacement needs is the package's directory.
 */
function packageDir(from: string, name: string): string | null {
  try {
    return dirname(createRequire(join(from, "package.json")).resolve(`${name}/package.json`));
  } catch {
    // Nothing there. A project with no front end has no React at all, which is not an error here.
    return null;
  }
}

/**
 * One React, however many checkouts the packages live in.
 *
 * Vite resolves a symlinked package from its realpath, so a package linked in from somewhere else — the
 * Pithy kit, a design system, any workspace you point at by path — imports `react` out of *its* tree
 * rather than out of this project's. Two copies of React is `invalid hook call` in every component that
 * package renders, and the stack blames the component rather than the resolution. It stays invisible for
 * as long as no linked component is mounted, which in a project that owns its own screens is a long
 * time: the first one you ever mount is the one that fails.
 *
 * **An alias and not `dedupe`, and the reason is where React lives.** `dedupe` resolves the names it is
 * given from Vite's root, and this config's root is the project root, where React is not installed — it
 * is a dependency of `apps/<worker>`. So `dedupe` here finds nothing and changes nothing, without a
 * word. `apps/<worker>/vite.config.ts` is rooted at the Worker and uses `dedupe` for that reason; this
 * file cannot, and a `dedupe` line added here would read as covered while resolving nothing.
 *
 * **Two rules per package, an exact one and a prefixed one.** The exact rule answers `react`; the
 * prefixed one answers the subpaths — `react/jsx-runtime`, `react-dom/client`. A single `^react` rule
 * would answer `react-dom` too and rewrite it through React's own directory, which lands on a path that
 * exists only while the two packages happen to sit side by side under one `node_modules`.
 *
 * **No Worker is named here, because none of them is the project's.** The first `apps/*` that resolves
 * React is the copy every test gets. A name written into this file would be one more place your Worker's
 * name lives, and it would go stale the day you rename it or `pithy worker add` a second one.
 *
 * **An empty list is a legitimate answer, and it says nothing.** No `apps/*` resolves React in a project
 * with no front end, which is every project between `pithy init` and its first `pithy ui add`. Throwing
 * would fail `bun run test` on a fresh scaffold; warning would print on every run of a project that
 * simply has no client. What separates this from the `dedupe` line it replaces is therefore not noise,
 * it is reach: an alias list is a value, so an empty one is visible to anything that cares to look — the
 * kit's own gates plant a Worker with no React and require the loop to skip past it.
 *
 * It is not a workaround for a symlink. It is what every linked-package setup needs, it costs nothing
 * when nothing is linked, and it goes on costing nothing the day `@pithy-sh/*` is published.
 */
function oneReact(): { find: RegExp; replacement: string }[] {
  const apps = join(PROJECT_ROOT, "apps");
  if (!existsSync(apps)) return [];
  // Sorted, so a project with two front ends resolves the same React on every machine.
  const workers = readdirSync(apps, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (const worker of workers) {
    const react = packageDir(join(apps, worker), "react");
    const reactDom = packageDir(join(apps, worker), "react-dom");
    if (react === null || reactDom === null) continue;
    return [
      { find: /^react-dom$/, replacement: reactDom },
      { find: /^react-dom\//, replacement: `${reactDom}/` },
      { find: /^react$/, replacement: react },
      { find: /^react\//, replacement: `${react}/` },
    ];
  }
  return [];
}

const ONE_REACT = oneReact();

// Two projects, split by runtime, because a Pithy project has two runtimes.
//
// `node` runs plain unit tests in Node — codecs, pure logic, anything with no binding in it.
// `workers` runs against the real Workers runtime with real D1 and KV, in vitest.workers.config.ts.
// A test that touches a binding belongs there and nowhere else: mocking D1 proves your mock works.
//
// The split is by filename, not by directory: `*.workers.test.ts` is the Workers project, every other
// `*.test.ts` is the node one. Tests sit beside the code they cover, so a folder rule would mean
// choosing between co-location and the runtime — and the runtime is not negotiable.
//
// `.tsx` is in the include for the same reason. A front end scaffolded by `pithy ui add` is all `.tsx`,
// so a `.ts`-only pattern silently collected none of its tests — and `passWithNoTests` made that green
// (#245). Every co-located test runs, whatever the file's extension.
export default defineConfig({
  test: {
    // A scaffolded project starts with almost no tests. `bun run test` should still be green.
    passWithNoTests: true,
    projects: [
      {
        // See `oneReact` at the head of this file. On the project rather than beside `passWithNoTests`,
        // and that is measured rather than assumed: on vitest 4.1.10 a `resolve.alias` stated at the
        // root of a `projects` config does not reach an inline project, and one stated here does. Up
        // there it would read as covered and rewrite nothing. This is also the project that collects
        // the `.tsx` tests a front end brings, so this is where it has to be either way.
        resolve: { alias: ONE_REACT },
        test: {
          name: "node",
          environment: "node",
          include: ["apps/*/src/**/*.test.{ts,tsx}"],
          exclude: ["apps/*/src/**/*.workers.test.{ts,tsx}"],
        },
      },
      "./vitest.workers.config.ts",
    ],
  },
});
