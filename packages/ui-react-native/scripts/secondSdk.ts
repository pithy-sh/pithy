// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { join } from "node:path";

/**
 * The templates are checked against two Expo SDKs. The first is the workspace's own, pinned in this package's
 * `devDependencies` and checked by `tsconfig.templates.json`. The second is the release after it, installed into a
 * directory of its own by `typecheckSecondSdk.ts` and checked by the same program with its module paths pointed
 * there. This module is the part of that with no I/O.
 */

/** The second SDK: the Expo release after the one the scaffold pins. */
export const SECOND_EXPO = "~58.0.0";

/** A package's `package.json`, as far as this reads it. */
export interface Manifest {
  version?: string;
  main?: string;
  types?: string;
  typings?: string;
  exports?: unknown;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

/** The packages the second SDK replaces whatever they peer on. */
const ALWAYS = new Set(["expo", "react", "react-native", "@types/react"]);

/**
 * The `devDependencies` an Expo app installs for its SDK: React, React Native, their types, Expo, and every package
 * that peers on React Native or Expo. Test tooling, the web build and the kit's own packages stay as they are.
 */
export function sdkPackageNames(
  devDependencies: Record<string, string>,
  peersOf: (name: string) => Record<string, string> | undefined,
): string[] {
  return Object.keys(devDependencies)
    .filter((name) => !name.startsWith("@pithy-sh/"))
    .filter((name) => {
      if (ALWAYS.has(name)) return true;
      const peers = peersOf(name) ?? {};
      return "react-native" in peers || "expo" in peers;
    })
    .sort();
}

/** The leading number of a version or a range. */
function major(range: string): string | undefined {
  return /(\d+)/.exec(range)?.[1];
}

/**
 * The version of each package for the second SDK, chosen the way `expo install` chooses: Expo's own list of the
 * versions it bundles, then Expo's own dependency ranges. A package versioned with the SDK (its major is the
 * workspace Expo's) moves to the second SDK's major. Anything else keeps the workspace's pin.
 */
export function secondSdkVersions(input: {
  names: string[];
  pins: Record<string, string>;
  currentExpo: string;
  expo: Manifest;
  bundled: Record<string, string>;
}): Record<string, string> {
  const expoVersion = input.expo.version ?? SECOND_EXPO;
  const sdkMajor = major(expoVersion);
  const currentMajor = major(input.currentExpo);
  const versions: Record<string, string> = {};
  for (const name of input.names) {
    const pin = input.pins[name] ?? "*";
    versions[name] =
      name === "expo"
        ? expoVersion
        : (input.bundled[name] ??
          input.expo.dependencies?.[name] ??
          input.expo.devDependencies?.[name] ??
          (major(pin) === currentMajor ? `~${sdkMajor}.0.0` : pin));
  }
  return versions;
}

/** The export conditions the templates' program resolves with, as `tsconfig.templates.json` sets them. */
const CONDITIONS = new Set(["types", "react-native", "import", "default"]);

/** The file an export target resolves to under `CONDITIONS`, walking nested condition maps in key order. */
function resolveTarget(target: unknown): string | undefined {
  if (typeof target === "string") return target;
  if (Array.isArray(target)) {
    for (const item of target) {
      const found = resolveTarget(item);
      if (found) return found;
    }
    return undefined;
  }
  if (target && typeof target === "object") {
    for (const [condition, value] of Object.entries(target)) {
      if (!CONDITIONS.has(condition)) continue;
      const found = resolveTarget(value);
      if (found) return found;
    }
  }
  return undefined;
}

/** A path TypeScript reads as declarations or source. */
function isDeclarations(file: string): boolean {
  return /\.(d\.[mc]?ts|[mc]?tsx?)$/.test(file);
}

/** The declarations a package's bare specifier resolves to, or undefined for a package that ships none. */
export function typesEntry(manifest: Manifest): string | undefined {
  const exports = manifest.exports;
  const root =
    exports &&
    typeof exports === "object" &&
    !Array.isArray(exports) &&
    Object.keys(exports).some((key) => key.startsWith("."))
      ? (exports as Record<string, unknown>)["."]
      : exports;
  const fromExports = resolveTarget(root);
  if (fromExports && isDeclarations(fromExports)) return fromExports;
  return manifest.types ?? manifest.typings;
}

/** The specifier an installed package answers: its own name, or for an `@types` package the one it types. */
function specifierOf(name: string): string {
  if (!name.startsWith("@types/")) return name;
  const typed = name.slice("@types/".length);
  return typed.includes("__") ? `@${typed.replace("__", "/")}` : typed;
}

/**
 * The `paths` that send every module the second SDK installed to its copy: a bare specifier to its declarations, and
 * a subpath into its directory. A package's own declarations win, as TypeScript's do; one with none takes its `@types`
 * package's.
 */
export function secondSdkPaths(
  root: string,
  installed: { name: string; manifest: Manifest }[],
): Record<string, string[]> {
  const paths: Record<string, string[]> = {};
  const ordered = [...installed].sort(
    (a, b) => Number(a.name.startsWith("@types/")) - Number(b.name.startsWith("@types/")),
  );
  for (const { name, manifest } of ordered) {
    const entry = typesEntry(manifest);
    if (!entry) continue;
    const dir = join(root, "node_modules", name);
    const specifier = specifierOf(name);
    if (name.startsWith("@types/") && paths[specifier]) continue;
    paths[specifier] = [join(dir, entry)];
    paths[`${specifier}/*`] = [join(dir, "*")];
  }
  return paths;
}

/**
 * The installed packages whose specifier `paths` does not send to the second SDK. Each would resolve from the
 * workspace's own SDK instead, because the templates sit inside the workspace, so the check would not be measuring it.
 */
export function unmappedPackages(installed: { name: string }[], paths: Record<string, string[]>): string[] {
  return installed.map(({ name }) => name).filter((name) => !paths[specifierOf(name)]);
}

/** The second SDK's program: the templates' own, with its module paths into the second SDK. */
export function secondSdkTsconfig(
  templatesConfig: string,
  paths: Record<string, string[]>,
): { extends: string; compilerOptions: { paths: Record<string, string[]> } } {
  return { extends: templatesConfig, compilerOptions: { paths } };
}
