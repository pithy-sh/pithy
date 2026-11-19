// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type Manifest,
  SECOND_EXPO,
  sdkPackageNames,
  secondSdkPaths,
  secondSdkTsconfig,
  secondSdkVersions,
  unmappedPackages,
} from "./secondSdk";

/**
 * Typecheck the React Native templates against the second Expo SDK's types.
 *
 * Installs that SDK's Expo, then every package an Expo app installs for it at the versions `expo install` would pick,
 * into a temporary directory outside the workspace, so the workspace's own pins never move. Then runs the templates'
 * own program with its module paths sent there, and fails if any of those packages has no declarations to send. The kit's packages the templates import resolve from the workspace,
 * so the workspace must be built first. Exits with the checker's status. `--keep` leaves the directory for a look.
 */

const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));

function readManifest(file: string): Manifest {
  return JSON.parse(readFileSync(file, "utf8")) as Manifest;
}

function run(command: string, args: string[], cwd: string): number {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  return result.status ?? 1;
}

function install(dir: string, dependencies: Record<string, string>): number {
  writeFileSync(join(dir, "package.json"), `${JSON.stringify({ private: true, dependencies }, null, 2)}\n`);
  return run("bun", ["install", "--ignore-scripts", "--linker", "hoisted", "--no-save"], dir);
}

/** Install the second SDK into `dir` and check the templates against it, answering the exit status. */
function check(dir: string): number {
  const own = readManifest(join(PACKAGE_DIR, "package.json"));
  const pins = own.devDependencies ?? {};
  const first = install(dir, { expo: SECOND_EXPO });
  if (first !== 0) return first;
  const expo = readManifest(join(dir, "node_modules", "expo", "package.json"));
  const bundledFile = join(dir, "node_modules", "expo", "bundledNativeModules.json");
  const bundled = JSON.parse(readFileSync(bundledFile, "utf8")) as Record<string, string>;
  const peersOf = (name: string) =>
    readManifest(join(PACKAGE_DIR, "node_modules", name, "package.json")).peerDependencies;
  const names = sdkPackageNames(pins, peersOf);
  const versions = secondSdkVersions({ names, pins, currentExpo: pins.expo ?? "", expo, bundled });
  console.log(`Expo ${expo.version}:`);
  for (const [name, version] of Object.entries(versions)) console.log(`  ${name} ${version}`);
  const second = install(dir, versions);
  if (second !== 0) return second;
  const installed = names.map((name) => ({
    name,
    manifest: readManifest(join(dir, "node_modules", name, "package.json")),
  }));
  const paths = secondSdkPaths(dir, installed);
  const unmapped = unmappedPackages(installed, paths);
  if (unmapped.length > 0) {
    console.error(
      `No declarations found in the Expo ${expo.version} copy of ${unmapped.join(", ")}, so the check would read the workspace's instead.`,
    );
    return 1;
  }
  const tsconfig = secondSdkTsconfig(join(PACKAGE_DIR, "tsconfig.templates.json"), paths);
  writeFileSync(join(dir, "tsconfig.json"), `${JSON.stringify(tsconfig, null, 2)}\n`);
  const status = run("bun", ["check", "--all", "-p", join(dir, "tsconfig.json")], dir);
  if (status === 0) console.log(`The templates typecheck on Expo ${expo.version}.`);
  return status;
}

const dir = mkdtempSync(join(tmpdir(), "pithy-rn-second-sdk-"));
const keep = process.argv.includes("--keep");
let status = 1;
try {
  status = check(dir);
} finally {
  if (keep) console.log(`Kept ${dir}.`);
  else rmSync(dir, { recursive: true, force: true });
}
process.exit(status);
