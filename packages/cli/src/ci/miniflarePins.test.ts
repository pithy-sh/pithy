// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { CLOUDFLARE_VITE_PLUGIN } from "../project/workerScaffold";
import { reactStub } from "../ui/react";

/**
 * **One miniflare, the one the kit's wrangler pins (#738).**
 *
 * `@pithy-sh/cli` declared `miniflare: ^4.20260722.1` while every wrangler from `4.148.0` pins one exact
 * miniflare from the 5 line. So an adopter on a current wrangler installed two miniflares and two workerds:
 * its tests and its build ran one runtime, and `pithy dev`, `pithy migrate`, `pithy seed` and the dev
 * secrets store ran the other. A behavior that differs between the two passes the gates and fails in dev.
 *
 * A semver range admits prereleases only of the exact version it names, so while miniflare 5 is a
 * prerelease no range can follow wrangler from one beta to the next. Sharing one copy means pinning the
 * version wrangler pins, and that is four statements of one fact: the CLI's `miniflare`, auth's
 * `miniflare`, the starter's `wrangler`, and the `wrangler` floor in every `packages/*` manifest.
 *
 * Cloudflare's two plugins carry the same fact a second way: every release of `@cloudflare/vitest-plugin`
 * and `@cloudflare/vite-plugin` depends on one exact wrangler and one exact miniflare. A caret on either in
 * what `pithy init` or `pithy ui add` writes resolves the plugin's next release, and with it a nested
 * wrangler and a second miniflare, the day it ships. So the starter's vitest-plugin and the React stub's
 * vite-plugin are exact too, each the release that pins the kit's wrangler. The vitest-plugin is installed
 * here, so its pin is read; the vite-plugin is not, so `CLOUDFLARE_VITE_PLUGIN` records the pair. The
 * installed wrangler is the source of truth, because it is what a bump moves; every other pin is checked
 * against it, and a failure names the file to change and the value to put there.
 *
 * Once miniflare 5 reaches `latest`, the pins become ranges and this test loosens with them.
 */

/** The repository root. This file lives at `packages/cli/src/ci/`. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

interface Manifest {
  version?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

/** Every pin this test holds, read from disk or handed in by a case below. */
interface Pins {
  /** The wrangler the CLI resolves, and the exact miniflare it depends on. */
  wrangler: { version: string; miniflare: string };
  cliMiniflare: string | undefined;
  authMiniflare: string | undefined;
  starterWrangler: string | undefined;
  /** Every `wrangler` range declared under `packages/*`, by the manifest that declares it. */
  wranglerRanges: { file: string; range: string }[];
  /** The `@cloudflare/vitest-plugin` installed here, and the exact wrangler it depends on. */
  vitestPlugin: { version: string; wrangler: string };
  starterVitestPlugin: string | undefined;
  /** The `@cloudflare/vite-plugin` release `workerScaffold.ts` records, and the wrangler it pins. */
  vitePlugin: { version: string; wrangler: string };
  reactVitePlugin: string | undefined;
}

/**
 * One line per pin that disagrees with the installed wrangler, each naming the file and the value.
 *
 * Empty when they all agree. A bump to the `wrangler` floor followed by `bun install` moves the installed
 * wrangler, and this then lists every other pin the bump has to move with it.
 */
function pinDrift(pins: Pins): string[] {
  const { version, miniflare } = pins.wrangler;
  const why = `the miniflare wrangler ${version} pins (npm view wrangler@${version} dependencies.miniflare)`;
  const drift: string[] = [];
  if (pins.cliMiniflare !== miniflare) {
    drift.push(`packages/cli/package.json: set dependencies.miniflare to "${miniflare}", ${why}.`);
  }
  if (pins.authMiniflare !== miniflare) {
    drift.push(`packages/auth/package.json: set devDependencies.miniflare to "${miniflare}", ${why}.`);
  }
  if (pins.starterWrangler !== version) {
    drift.push(
      `templates/starter/apps/api/package.json: set devDependencies.wrangler to "${version}", the kit's wrangler, so a new project resolves one miniflare.`,
    );
  }
  for (const { file, range } of pins.wranglerRanges) {
    if (range !== `^${version}`) drift.push(`${file}: set wrangler to "^${version}", the kit's wrangler.`);
  }
  if (pins.vitestPlugin.wrangler !== version) {
    drift.push(
      `packages/*/package.json: move every @cloudflare/vitest-plugin floor to the release that pins wrangler ${version}; the installed ${pins.vitestPlugin.version} pins ${pins.vitestPlugin.wrangler}.`,
    );
  }
  if (pins.starterVitestPlugin !== pins.vitestPlugin.version) {
    drift.push(
      `templates/starter/package.json: set devDependencies["@cloudflare/vitest-plugin"] to "${pins.vitestPlugin.version}", the release installed here, so a new project resolves one miniflare.`,
    );
  }
  if (pins.vitePlugin.wrangler !== version) {
    drift.push(
      `packages/cli/src/project/workerScaffold.ts: set CLOUDFLARE_VITE_PLUGIN to the @cloudflare/vite-plugin release that pins wrangler ${version} (npm view @cloudflare/vite-plugin@<version> dependencies.wrangler).`,
    );
  }
  if (pins.reactVitePlugin !== pins.vitePlugin.version) {
    drift.push(
      `packages/cli/src/ui/react.ts: set devDependencies["@cloudflare/vite-plugin"] to "${pins.vitePlugin.version}", CLOUDFLARE_VITE_PLUGIN's release.`,
    );
  }
  return drift;
}

function readManifest(path: string): Manifest {
  return JSON.parse(readFileSync(resolve(REPO_ROOT, path), "utf8"));
}

/**
 * The `@cloudflare/vitest-plugin` the kit's packages resolve, read from `packages/core`'s `node_modules`.
 * Read by path: the plugin's `exports` do not list `./package.json`, so `require.resolve` refuses it.
 */
function installedVitestPlugin(): { version: string; wrangler: string } {
  const manifest = readManifest("packages/core/node_modules/@cloudflare/vitest-plugin/package.json");
  const wrangler = manifest.dependencies?.wrangler;
  if (!manifest.version || !wrangler) throw new Error("Cannot read the installed vitest-plugin's wrangler.");
  return { version: manifest.version, wrangler };
}

/** The wrangler `packages/cli` resolves — the copy `bun install` put in its `node_modules`. */
function installedWrangler(): { version: string; miniflare: string } {
  const require = createRequire(import.meta.url);
  const manifest: Manifest = JSON.parse(readFileSync(require.resolve("wrangler/package.json"), "utf8"));
  const miniflare = manifest.dependencies?.miniflare;
  if (!manifest.version || !miniflare) throw new Error("Cannot read the installed wrangler's miniflare.");
  return { version: manifest.version, miniflare };
}

function wranglerRanges(): { file: string; range: string }[] {
  const ranges: { file: string; range: string }[] = [];
  for (const name of readdirSync(resolve(REPO_ROOT, "packages"))) {
    const file = `packages/${name}/package.json`;
    let manifest: Manifest;
    try {
      manifest = readManifest(file);
    } catch {
      continue;
    }
    for (const block of [
      manifest.dependencies,
      manifest.devDependencies,
      manifest.peerDependencies,
      manifest.optionalDependencies,
    ]) {
      const range = block?.wrangler;
      if (range) ranges.push({ file, range });
    }
  }
  return ranges;
}

function pinsOnDisk(): Pins {
  return {
    wrangler: installedWrangler(),
    cliMiniflare: readManifest("packages/cli/package.json").dependencies?.miniflare,
    authMiniflare: readManifest("packages/auth/package.json").devDependencies?.miniflare,
    starterWrangler: readManifest("templates/starter/apps/api/package.json").devDependencies?.wrangler,
    wranglerRanges: wranglerRanges(),
    vitestPlugin: installedVitestPlugin(),
    starterVitestPlugin: readManifest("templates/starter/package.json").devDependencies?.["@cloudflare/vitest-plugin"],
    vitePlugin: CLOUDFLARE_VITE_PLUGIN,
    reactVitePlugin: reactStub.devDependencies["@cloudflare/vite-plugin"] ?? undefined,
  };
}

/** Every version of `name` that `bun.lock` resolves, however deep it is nested. */
function lockedVersions(lock: string, name: string): string[] {
  const escaped = name.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  const found = [...lock.matchAll(new RegExp(`\\["${escaped}@([^"]+)"`, "g"))].map((match) => match[1] ?? "");
  return [...new Set(found)].sort();
}

describe("the miniflare pins", () => {
  test("every pin agrees with the miniflare the installed wrangler pins", () => {
    expect(pinDrift(pinsOnDisk())).toEqual([]);
  });

  // The floor: a reader that stopped finding the ranges would pass the loop above on nothing.
  test("the wrangler ranges are found, the CLI's among them", () => {
    expect(wranglerRanges().map(({ file }) => file)).toContain("packages/cli/package.json");
  });

  test.each(["miniflare", "workerd"])("bun.lock resolves one %s", (name) => {
    expect(lockedVersions(readFileSync(resolve(REPO_ROOT, "bun.lock"), "utf8"), name)).toHaveLength(1);
  });
});

describe("pinDrift", () => {
  const agreed: Pins = {
    wrangler: { version: "4.151.0", miniflare: "5.20261012.0-beta" },
    cliMiniflare: "5.20261012.0-beta",
    authMiniflare: "5.20261012.0-beta",
    starterWrangler: "4.151.0",
    wranglerRanges: [{ file: "packages/core/package.json", range: "^4.151.0" }],
    vitestPlugin: { version: "1.4.2", wrangler: "4.151.0" },
    starterVitestPlugin: "1.4.2",
    vitePlugin: { version: "1.64.0", wrangler: "4.151.0" },
    reactVitePlugin: "1.64.0",
  };

  test("is empty when every pin agrees", () => {
    expect(pinDrift(agreed)).toEqual([]);
  });

  test("names the CLI's manifest and the version when its miniflare moves alone", () => {
    expect(pinDrift({ ...agreed, cliMiniflare: "^4.20260722.1" })).toEqual([
      'packages/cli/package.json: set dependencies.miniflare to "5.20261012.0-beta", the miniflare wrangler 4.151.0 pins (npm view wrangler@4.151.0 dependencies.miniflare).',
    ]);
  });

  test("names auth's manifest when its miniflare moves alone", () => {
    const [line] = pinDrift({ ...agreed, authMiniflare: "5.20261006.2-beta" });
    expect(line).toMatch(/^packages\/auth\/package\.json: set devDependencies\.miniflare to "5\.20261012\.0-beta"/);
  });

  test("names the starter when its wrangler moves alone, and a range is not an exact pin", () => {
    const [line] = pinDrift({ ...agreed, starterWrangler: "^4.151.0" });
    expect(line).toMatch(/^templates\/starter\/apps\/api\/package\.json: set devDependencies\.wrangler to "4\.151\.0"/);
  });

  test("names each manifest whose wrangler floor is left behind", () => {
    const ranges = [...agreed.wranglerRanges, { file: "packages/vector/package.json", range: "^4.149.0" }];
    expect(pinDrift({ ...agreed, wranglerRanges: ranges })).toEqual([
      'packages/vector/package.json: set wrangler to "^4.151.0", the kit\'s wrangler.',
    ]);
  });

  test("names the starter when its vitest-plugin is a caret, which resolves the plugin's next wrangler", () => {
    expect(pinDrift({ ...agreed, starterVitestPlugin: "^1.0.0" })).toEqual([
      'templates/starter/package.json: set devDependencies["@cloudflare/vitest-plugin"] to "1.4.2", the release installed here, so a new project resolves one miniflare.',
    ]);
  });

  test("names the React stub when its vite-plugin is a caret", () => {
    const [line] = pinDrift({ ...agreed, reactVitePlugin: "^1.48.0" });
    expect(line).toMatch(
      /^packages\/cli\/src\/ui\/react\.ts: set devDependencies\["@cloudflare\/vite-plugin"\] to "1\.64\.0"/,
    );
  });

  test("a wrangler bump with nothing else moved lists every pin it has to carry, the plugins among them", () => {
    const drift = pinDrift({ ...agreed, wrangler: { version: "4.152.0", miniflare: "5.20261020.0-beta" } });
    expect(drift).toHaveLength(6);
    expect(drift.join("\n")).toContain("@cloudflare/vitest-plugin floor to the release that pins wrangler 4.152.0");
    expect(drift.join("\n")).toContain(
      "CLOUDFLARE_VITE_PLUGIN to the @cloudflare/vite-plugin release that pins wrangler 4.152.0",
    );
  });
});

describe("lockedVersions", () => {
  test("reads a top-level and a nested resolution, and counts a version once", () => {
    const lock = [
      '"miniflare": ["miniflare@5.20261012.0-beta", "", {}],',
      '"wrangler/miniflare": ["miniflare@5.20261012.0-beta", "", {}],',
      '"@cloudflare/vitest-plugin/miniflare": ["miniflare@4.20260730.0", "", {}],',
      '"@cloudflare/workerd-linux-64": ["@cloudflare/workerd-linux-64@1.20261012.1", "", {}],',
    ].join("\n");
    expect(lockedVersions(lock, "miniflare")).toEqual(["4.20260730.0", "5.20261012.0-beta"]);
    expect(lockedVersions(lock, "workerd")).toEqual([]);
  });
});
