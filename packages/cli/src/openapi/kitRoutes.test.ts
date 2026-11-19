// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { artifacts } from "@pithy-sh/artifacts/src/index";
import { auth } from "@pithy-sh/auth/src/index";
import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { routeDrift } from "@pithy-sh/core/src/http/lazyRoutes";
import { ledger } from "@pithy-sh/ledger/src/index";
import { matchmaking } from "@pithy-sh/matchmaking/src/index";
import { organization } from "@pithy-sh/organization/src/index";
import { secrets } from "@pithy-sh/secrets/src/index";
import { storage } from "@pithy-sh/storage/src/index";
import { support } from "@pithy-sh/support/src/index";
import { describe, expect, test } from "vitest";
import { composeForSync } from "../project/composeFor";
import { KIT_COMPOSITION, KIT_CONTRACT_ENVIRONMENT, ORGANIZATION_ROLES } from "./kitDocument";

/**
 * **Every kit capability declares exactly the routes its module mounts, and loads that module on first use.**
 *
 * A capability hands core a declared table and a loader. A route its module mounts and the table misses is one
 * no request reaches; a declared route the module does not mount answers as an undeclared one. So the table is
 * held to the module for every configuration that changes which routes mount: the kit's own composition and
 * each variant in {@link ROUTE_VARIANTS}.
 *
 * The laziness is held structurally too: nothing a capability's module imports at startup may reach the
 * module its loader imports, or the bundle evaluates it at startup whatever the loader says.
 */

const ORIGIN = "https://app.example.com";

const PACKAGES = join(import.meta.dirname, "..", "..", "..");

/** One composition the test checks: a capability, the environment it composes for, and whether the kit is beside it. */
interface Composition {
  readonly name: string;
  readonly environment: string;
  readonly compose: () => Capability;
  /** Composed with no peers, for a route that mounts only when a peer is absent. */
  readonly alone?: boolean;
}

/**
 * The capability `entry` composes, beside the rest of the kit and with every `compose` hook run, the way
 * `createBackend` composes it: a capability that reads a peer, or reads where a peer mounted, declares then.
 */
function composedFor(entry: Composition): Capability {
  return composeForSync(entry.environment, () => {
    const mine = entry.compose();
    const peers = entry.alone
      ? []
      : Object.entries(KIT_COMPOSITION)
          .map(([, compose]) => compose())
          .filter((capability) => capability.name !== mine.name);
    const capabilities = [...peers, mine];
    for (const capability of capabilities) capability.compose?.({ capabilities });
    return mine;
  });
}

/**
 * Configurations beside the kit's own that change which routes a capability mounts, or where: another base path,
 * a feature switched off, another environment.
 */
const ROUTE_VARIANTS: readonly Composition[] = [
  { name: "auth in dev, with its dev sign-in", environment: "dev", compose: () => auth({ baseURL: ORIGIN }) },
  { name: "auth at another base path", environment: "prod", compose: () => auth({ baseURL: ORIGIN, basePath: "/id" }) },
  { name: "storage moved", environment: "prod", compose: () => storage({ basePath: "/files", sharePath: "/share" }) },
  {
    name: "matchmaking without friends",
    environment: "prod",
    compose: () =>
      matchmaking({ games: [{ key: "duel", players: 2, snapshot: { kind: "connect-n", rules: {} } }], friends: false }),
  },
  { name: "artifacts with no organization beside it", environment: "prod", compose: () => artifacts(), alone: true },
  {
    name: "support with no submission",
    environment: "prod",
    compose: () => support({ inboundAddresses: ["support@example.com"], submission: { enabled: false } }),
  },
  {
    name: "organization with no ownership transfer",
    environment: "prod",
    compose: () => organization({ baseUrl: ORIGIN, roles: ORGANIZATION_ROLES }),
  },
  {
    name: "ledger moved",
    environment: "prod",
    compose: () => ledger({ currencies: [{ code: "chips", name: "Chips" }], basePath: "/wallet" }),
  },
  { name: "secrets moved", environment: "prod", compose: () => secrets({ registry: {}, basePath: "/vault" }) },
];

const COMPOSITIONS: readonly Composition[] = [
  ...Object.entries(KIT_COMPOSITION).map(([name, compose]) => ({
    name,
    environment: KIT_CONTRACT_ENVIRONMENT,
    compose,
  })),
  ...ROUTE_VARIANTS,
];

describe("every kit capability's declared routes", () => {
  test.each(COMPOSITIONS.map((entry) => [entry.name, entry] as const))(
    "%s matches what its module mounts",
    async (_name, entry) => {
      const capability = composedFor(entry);
      if (capability.routes === undefined) return;
      expect(typeof capability.routes.load).toBe("function");
      const drift = await routeDrift(capability.routes);
      expect(drift, `${capability.name} (${entry.name}): the declared table and the mounted routes disagree.`).toEqual({
        undeclared: [],
        unmounted: [],
      });
    },
  );
});

/** A module's static imports within its package, resolved to files. `import type` and `export type` are left out. */
function staticImports(file: string): string[] {
  const source = readFileSync(file, "utf8");
  const found: string[] = [];
  const pattern = /^(?:import|export)\s+(?!type\s)(?:[^;]*?\sfrom\s+)?"(\.{1,2}\/[^"]+)";/gms;
  for (const match of source.matchAll(pattern)) {
    const target = resolveModule(dirname(file), match[1] ?? "");
    if (target !== undefined) found.push(target);
  }
  return found;
}

/** The modules `source` imports on first use: every `import("./…")` in it, resolved from `file`. */
function dynamicImports(file: string, source = readFileSync(file, "utf8")): string[] {
  return [...source.matchAll(/import\("(\.{1,2}\/[^"]+)"\)/g)]
    .map((match) => resolveModule(dirname(file), match[1] ?? ""))
    .filter((target): target is string => target !== undefined);
}

/**
 * The modules the `routes` loader imports: the `import("./…")` calls inside the first `routes: { … }` or
 * `routes = { … }` block. Empty when the file builds its routes any other way, which the test refuses.
 */
function routeLoaderImports(file: string): string[] {
  const source = readFileSync(file, "utf8");
  const start = source.search(/\broutes(?::|\s*=)\s*\{/);
  if (start === -1) return [];
  let depth = 0;
  for (let at = source.indexOf("{", start); at < source.length; at += 1) {
    if (source[at] === "{") depth += 1;
    if (source[at] === "}") depth -= 1;
    if (depth === 0) return dynamicImports(file, source.slice(start, at + 1));
  }
  return [];
}

function resolveModule(from: string, specifier: string): string | undefined {
  const base = resolve(from, specifier.replace(/\.js$/, ""));
  for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** Every module reachable from `entry` through static imports. */
function closure(entry: string): Set<string> {
  const seen = new Set<string>([entry]);
  const queue = [entry];
  while (queue.length > 0) {
    const next = queue.pop() as string;
    for (const target of staticImports(next)) {
      if (seen.has(target)) continue;
      seen.add(target);
      queue.push(target);
    }
  }
  return seen;
}

/** Every file that defines a kit capability: each package's `src/capability.ts`, and the two that ship beside one. */
function capabilityFiles(): string[] {
  const files = readdirSync(PACKAGES)
    .map((pkg) => join(PACKAGES, pkg, "src", "capability.ts"))
    .filter((file) => existsSync(file));
  return [...files, ...Object.values(BESIDE_A_PACKAGE)];
}

/** The capabilities defined somewhere other than their own package's `src/capability.ts`, by name. */
const BESIDE_A_PACKAGE: Readonly<Record<string, string>> = {
  controlplane: join(PACKAGES, "core", "src", "controlPlane", "capability.ts"),
  mcp: join(PACKAGES, "auth", "src", "mcp", "capability.ts"),
};

/** The file that defines a composed kit capability, found by its name. */
function capabilityFile(name: string): string {
  return BESIDE_A_PACKAGE[name] ?? join(PACKAGES, name, "src", "capability.ts");
}

/** The package entry an adopter imports a capability through, beside the file that defines it. */
function packageIndex(capabilityFile: string): string | undefined {
  const index = join(capabilityFile.slice(0, capabilityFile.indexOf("/src/") + 5), "index.ts");
  return existsSync(index) ? index : undefined;
}

describe("every kit capability's routes module", () => {
  test("every file that defines a kit capability is one the kit composes, so none escapes the check below", () => {
    const composed = new Set(Object.values(KIT_COMPOSITION).map((compose) => capabilityFile(compose().name)));
    expect(capabilityFiles().filter((file) => !composed.has(file))).toEqual([]);
  });

  // Which capabilities are held is read off the composed capability, never off its source: one with routes must
  // name the module its loader imports, however its file builds the routes object.
  test.each(COMPOSITIONS.map((entry) => [entry.name, entry] as const))("%s loads it on first use", (_name, entry) => {
    const capability = composedFor(entry);
    if (capability.routes === undefined) return;
    const file = capabilityFile(capability.name);
    expect(existsSync(file), `${capability.name} has routes and no file at ${file} defines it.`).toBe(true);
    const routeModules = routeLoaderImports(file);
    expect(
      routeModules.length,
      `${file} declares routes and its \`routes: { load }\` imports no module for them on first use.`,
    ).toBeGreaterThan(0);
    // Everything the capability defers, its routes and its handlers alike, stays out of its own startup imports.
    const own = closure(file);
    expect(
      dynamicImports(file)
        .filter((module) => own.has(module))
        .map((module) => module.slice(PACKAGES.length + 1)),
      "A module the capability loads on first use is also imported by the capability itself, so it is evaluated at startup.",
    ).toEqual([]);
    // The routes module stays out of the package entry too. Anything else the entry re-exports is left out of a
    // Worker that does not use it, since every capability package declares no side effects.
    const index = packageIndex(file);
    const entryModules = index ? closure(index) : new Set<string>();
    expect(
      routeModules.filter((module) => entryModules.has(module)).map((module) => module.slice(PACKAGES.length + 1)),
      "A module the routes loader imports is also imported by the package entry, so it is evaluated before the first request.",
    ).toEqual([]);
  });
});
