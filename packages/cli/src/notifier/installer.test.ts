// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { detectInstaller, INSTALLERS, type Installer, upgradeCommandFor } from "./installer";

describe("detectInstaller", () => {
  const cases: { path: string; installer: Installer }[] = [
    { path: "/home/u/.bun/bin/pithy", installer: "bun" },
    { path: "/home/u/.deno/bin/pithy", installer: "deno" },
    { path: "/usr/local/pnpm/pithy", installer: "pnpm" },
    { path: "/home/u/.pnpm/global/pithy", installer: "pnpm" },
    { path: "/opt/homebrew/bin/pithy", installer: "brew" },
    { path: "/home/linuxbrew/.linuxbrew/bin/pithy", installer: "brew" },
    { path: "/usr/local/Cellar/pithy/1.0.0/bin/pithy", installer: "brew" },
    { path: "/home/u/.yarn/bin/pithy", installer: "yarn" },
    { path: "/usr/local/yarn/global/pithy", installer: "yarn" },
    { path: "/usr/local/npm/bin/pithy", installer: "npm" },
    { path: "/home/u/project/node_modules/.bin/pithy", installer: "npm" },
    { path: "/some/random/place/pithy", installer: "unknown" },
  ];

  for (const { path, installer } of cases) {
    test(`${path} → ${installer}`, () => {
      expect(detectInstaller(path)).toBe(installer);
    });
  }

  test(".bun wins over the node_modules npm test (order matters)", () => {
    expect(detectInstaller("/home/u/.bun/install/global/node_modules/@pithy-sh/cli/bin/pithy")).toBe("bun");
  });

  test("normalizes Windows backslash paths before matching", () => {
    expect(detectInstaller("C:\\Users\\u\\.bun\\bin\\pithy.exe")).toBe("bun");
    expect(detectInstaller("C:\\Users\\u\\AppData\\npm\\pithy.cmd")).toBe("npm");
  });
});

/**
 * THE GATE for detecting a deno install.
 *
 * The invariant, stated once: **a pithy installed with `deno install -g npm:@pithy-sh/cli` is detected as
 * `deno`, and so is told the deno upgrade command — at the path deno actually runs it from.**
 *
 * That last clause is the whole finding (#582). `deno install` writes a shim at
 * `$DENO_INSTALL_ROOT/bin/pithy`, but the module deno executes — and therefore `process.argv[1]` — is the
 * one it resolved into `$DENO_DIR/npm/<registry host>/@pithy-sh/cli/<version>/dist/bin.js`. That cache
 * directory is literally named `npm`, so the generic `/\/npm\//` test claimed it and a deno user was told to
 * run `npm i -g @pithy-sh/cli`: a second copy under npm's prefix, and the deno shim they actually invoke
 * left stale at the old version. The upgrade appeared to work and changed nothing.
 *
 * So the paths below are the **observed** shapes, not shapes chosen to match the code. A test written
 * against `/.deno/` passes against the old implementation and proves nothing, which is how this defect
 * survived a green suite. `containsNpmSegment` below is the part that keeps it honest: every measured path
 * is asserted to contain the `/npm/` segment the old test won on, so a future reordering that puts the npm
 * test first goes red here rather than silently.
 *
 * The gate ends at `upgradeCommandFor`, not at `detectInstaller`, because the harm is the advice, not the
 * label.
 */
describe("a deno install is told the deno command", () => {
  /** A path deno can put in `process.argv[1]`, and how we know. */
  type DenoPath = {
    /** The path, as deno produces it. */
    readonly path: string;
    /** Where this shape came from. Measured means observed on disk after a real `deno install`. */
    readonly provenance: string;
  };

  /**
   * Measured in #582 with deno 2.2.7, `DENO_INSTALL_ROOT` and `DENO_DIR` both pointed at a scratch
   * directory, then re-expressed at the default `DENO_DIR` for each platform.
   */
  const DENO_PATHS: readonly DenoPath[] = [
    {
      path: "/home/u/.cache/deno/npm/registry.npmjs.org/@pithy-sh/cli/0.7.1/dist/bin.js",
      provenance: "Measured cache layout, at the default DENO_DIR on Linux (`~/.cache/deno`).",
    },
    {
      path: "/Users/u/Library/Caches/deno/npm/registry.npmjs.org/@pithy-sh/cli/0.7.1/dist/bin.js",
      provenance: "Measured cache layout, at the default DENO_DIR on macOS (`~/Library/Caches/deno`).",
    },
    {
      path: "/tmp/fk-582/denodir/npm/registry.npmjs.org/@pithy-sh/cli/0.7.1/dist/bin.js",
      provenance:
        "Measured verbatim, with DENO_DIR set to a scratch directory. The one that matters: nothing in it says `deno`, so detection cannot key on the word.",
    },
    {
      path: "C:\\Users\\u\\AppData\\Local\\deno\\npm\\registry.npmjs.org\\@pithy-sh\\cli\\0.7.1\\dist\\bin.js",
      provenance:
        "The measured cache layout under deno's documented Windows default (`%LOCALAPPDATA%\\deno`); the platform default is documented, the layout below it is measured.",
    },
    {
      path: "/home/u/.cache/deno/npm/registry.corp.example/@pithy-sh/cli/0.7.1/dist/bin.js",
      provenance:
        "Inferred, not measured: deno keys the cache by registry host, so an adopter on a mirror lands the same shape under a different hostname. Here to stop the fix hard-coding registry.npmjs.org.",
    },
  ];

  /** The test the old implementation won with. Every path above must still be one it would have claimed. */
  const containsNpmSegment = (path: string) => /\/npm\/|\/node_modules\//.test(path.replace(/\\/g, "/"));

  for (const { path, provenance } of DENO_PATHS) {
    test(`${path} → the deno upgrade command`, () => {
      expect(
        containsNpmSegment(path),
        `${path} does not contain the \`/npm/\` segment this gate exists to beat. Either it is not a path deno produces, or the measurement changed — re-measure before editing it.`,
      ).toBe(true);

      expect(detectInstaller(path), provenance).toBe("deno");
      expect(upgradeCommandFor(detectInstaller(path))).toBe(
        "deno install --reload -f -g -A -n pithy npm:@pithy-sh/cli",
      );
    });
  }

  /**
   * The shim `deno install` writes, kept on purpose. It is **not** known to reach `process.argv[1]` — the
   * shim is `$0` to `/bin/sh` and `exec`s `deno run npm:@pithy-sh/cli`, so deno's main module is the cached
   * file above. It stays because `$DENO_INSTALL_ROOT` defaults to `~/.deno`, a directory no other installer
   * writes to: if a wrapper, an alias, or a future deno ever does surface the shim path, the answer is
   * already right, and until then the arm is inert rather than wrong. Being unreachable is not being wrong;
   * being reachable and wrong is what #582 was.
   */
  test("the install shim, if it is ever the path we are handed", () => {
    expect(detectInstaller("/home/u/.deno/bin/pithy")).toBe("deno");
  });

  test("an npm install is still npm — the deno test may not swallow it", () => {
    // A directory named `npm` whose child is not a registry host is npm's own layout, not deno's cache.
    expect(detectInstaller("/usr/local/lib/node_modules/npm/bin/pithy")).toBe("npm");
    expect(detectInstaller("/usr/local/npm/0.1.2/bin/pithy")).toBe("npm");
    expect(detectInstaller("/usr/local/lib/node_modules/@pithy-sh/cli/dist/bin.js")).toBe("npm");
  });
});

/**
 * THE GATE for `upgradeCommandFor`.
 *
 * The invariant, stated once: **every command `upgradeCommandFor` returns resolves the registry's `latest`
 * tag, rather than a version range a prior global install recorded.** The notifier only ever fires when a
 * newer version exists, so a command that re-resolves an old range — or that refuses to run at all — is
 * advice that cannot do the thing it is printed for.
 *
 * The gate holds over the whole `Installer` union by iterating `INSTALLERS`, the runtime array `Installer`
 * is derived from. A seventh installer is enrolled by existing: it cannot join the type without joining the
 * array, and the moment it does, this loop asks the same question of its command.
 *
 * The semantic half is `REGISTRY_RESOLUTION` below — a description of what package-manager invocations do,
 * kept deliberately separate from the map under test so the gate is not derived from its own subject. It
 * **fails closed**: an invocation no rule describes is a failure, not a pass. That is the bit that catches a
 * command nobody has measured, which is the only way a new row can be wrong.
 *
 * What this gate cannot do is reach the network. Proving `bun install -g` really rewrites a recorded caret
 * needs bun, pnpm, yarn, deno and brew installed, a writable global prefix, and the public registry — an
 * execution contract too flaky to gate CI on. So the measurements live in `evidence` strings, and the gate's
 * job is to make every row's claim explicit, attributable and reviewable rather than implied by a verb.
 */
describe("upgrade commands resolve the registry's latest tag", () => {
  /** A package-manager invocation, and what it does with a range a prior global install recorded. */
  type Invocation = {
    /** How the invocation is spelled, for the failure message. */
    readonly name: string;
    /** Does running this actually land the registry's `latest` tag? */
    readonly resolvesLatest: boolean;
    /** How we know. Measured against the live registry on 2026-09-14 unless it says otherwise. */
    readonly evidence: string;
    /** Whether a command's tokens are this invocation. */
    readonly matches: (tokens: readonly string[]) => boolean;
  };

  /** Match a command by its leading words, so flags in any order don't defeat the test. */
  const head =
    (...words: readonly string[]) =>
    (tokens: readonly string[]) =>
      words.every((word, i) => tokens[i] === word);

  /** Deno refuses to replace an existing global install without this. */
  const forced = (tokens: readonly string[]) => tokens.includes("-f") || tokens.includes("--force");

  /**
   * What each invocation does. Rules that describe a range-respecting verb are kept here on purpose: they are
   * what turns a regression into a specific failure ("this verb respects the recorded range") instead of the
   * generic "nothing describes this". Anything absent from this table fails the gate — measure it and add it.
   */
  const REGISTRY_RESOLUTION: readonly Invocation[] = [
    {
      name: "bun install -g <pkg>",
      resolvesLatest: true,
      evidence: "No range is named, so bun resolves `latest` and rewrites the range in the global package.json.",
      matches: head("bun", "install"),
    },
    {
      name: "bun update|upgrade -g <pkg>",
      resolvesLatest: false,
      evidence:
        "Resolves the range recorded in ~/.bun/install/global/package.json. `^0.5.0` pins the 0.x minor, so it reinstalls 0.5.0 and reports success. Reproduced in #577.",
      matches: (t) => t[0] === "bun" && (t[1] === "update" || t[1] === "upgrade"),
    },
    {
      name: "pnpm add -g <pkg>",
      resolvesLatest: true,
      evidence: "The install verb takes no recorded range; it resolves `latest` and rewrites the range.",
      matches: head("pnpm", "add"),
    },
    {
      name: "pnpm update|up -g <pkg>",
      resolvesLatest: false,
      evidence: "Honors the recorded range, which for a global install may be an exact pin, not only a caret.",
      matches: (t) => t[0] === "pnpm" && (t[1] === "update" || t[1] === "up" || t[1] === "upgrade"),
    },
    {
      name: "yarn global add <pkg>",
      resolvesLatest: true,
      evidence:
        "Yarn 1 spelling, and the only one that exists: Yarn 2+ removed `yarn global` entirely, so anyone whose binary came from `yarn global add` is on Yarn 1 by construction. The install verb resolves `latest`.",
      matches: head("yarn", "global", "add"),
    },
    {
      name: "yarn global upgrade <pkg>",
      resolvesLatest: false,
      evidence: "Upgrades within the range recorded in the global manifest; `--latest` is what ignores it.",
      matches: head("yarn", "global", "upgrade"),
    },
    {
      name: "deno install -f ... npm:<pkg>",
      resolvesLatest: true,
      evidence: "Re-resolves the npm specifier against `latest`, and `-f` lets it replace the existing shim.",
      matches: (t) => head("deno", "install")(t) && forced(t),
    },
    {
      name: "deno install ... npm:<pkg> (unforced)",
      resolvesLatest: false,
      evidence:
        'Exits 1 with "Existing installation found. Aborting (Use -f to overwrite)" — it resolves nothing at all, which fails this invariant as surely as resolving the wrong thing.',
      matches: (t) => head("deno", "install")(t) && !forced(t),
    },
    {
      name: "brew upgrade <formula>",
      resolvesLatest: true,
      evidence: "A formula records no range. Upgrade takes whatever version the tap's formula now names.",
      matches: head("brew", "upgrade"),
    },
    {
      name: "npm i|install -g <pkg>",
      resolvesLatest: true,
      evidence:
        "npm's global prefix has no package.json, so there is no range to respect; the install resolves `latest`.",
      matches: (t) => t[0] === "npm" && (t[1] === "i" || t[1] === "install"),
    },
  ];

  for (const installer of INSTALLERS) {
    test(`${installer}: the command it prints lands the latest release`, () => {
      const command = upgradeCommandFor(installer);
      const tokens = command.trim().split(/\s+/);
      const rules = REGISTRY_RESOLUTION.filter((rule) => rule.matches(tokens));

      expect(
        rules.map((rule) => rule.name),
        `\`${command}\` is described by no registry-resolution rule, or by more than one. Run it against a global install that has an older version recorded, then add what you measured to REGISTRY_RESOLUTION.`,
      ).toHaveLength(1);

      const [rule] = rules;
      expect(
        rule?.resolvesLatest,
        `\`${command}\` is \`${rule?.name}\`, which does not land the registry's latest tag: ${rule?.evidence}`,
      ).toBe(true);
    });
  }

  test("the gate reaches every installer, because the union is derived from the list it walks", () => {
    // If `Installer` were written out by hand beside `INSTALLERS`, this loop could silently miss a member.
    // It is derived from it instead, so this assertion is about the list being real, not about its length.
    const members: Installer[] = [...INSTALLERS];
    expect(new Set(members).size).toBe(members.length);
    expect(members).toContain("unknown");
  });
});

describe("upgradeCommandFor", () => {
  // These literals are a change-detector, not the gate. The gate is the `describe` above: it asks whether
  // each command lands `latest`, over the whole union. Updating a literal here proves nothing on its own.
  test("maps each installer to its upgrade command", () => {
    expect(upgradeCommandFor("bun")).toBe("bun install -g @pithy-sh/cli");
    expect(upgradeCommandFor("pnpm")).toBe("pnpm add -g @pithy-sh/cli");
    expect(upgradeCommandFor("yarn")).toBe("yarn global add @pithy-sh/cli");
    expect(upgradeCommandFor("deno")).toBe("deno install --reload -f -g -A -n pithy npm:@pithy-sh/cli");
    expect(upgradeCommandFor("brew")).toBe("brew upgrade pithy");
    expect(upgradeCommandFor("npm")).toBe("npm i -g @pithy-sh/cli");
  });

  test("unknown falls back to a global npm install", () => {
    expect(upgradeCommandFor("unknown")).toBe("npm i -g @pithy-sh/cli");
  });
});
