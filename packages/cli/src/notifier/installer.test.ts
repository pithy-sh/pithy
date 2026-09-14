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
