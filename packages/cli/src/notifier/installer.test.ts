// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { detectInstaller, type Installer, upgradeCommandFor } from "./installer";

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

describe("upgradeCommandFor", () => {
  test("maps each installer to its upgrade command", () => {
    expect(upgradeCommandFor("bun")).toBe("bun update -g @pithy-sh/cli");
    expect(upgradeCommandFor("pnpm")).toBe("pnpm update -g @pithy-sh/cli");
    expect(upgradeCommandFor("yarn")).toBe("yarn global upgrade @pithy-sh/cli");
    expect(upgradeCommandFor("deno")).toBe("deno install --reload -g -A -n pithy npm:@pithy-sh/cli");
    expect(upgradeCommandFor("brew")).toBe("brew upgrade pithy");
    expect(upgradeCommandFor("npm")).toBe("npm i -g @pithy-sh/cli");
  });

  test("unknown falls back to a global npm install", () => {
    expect(upgradeCommandFor("unknown")).toBe("npm i -g @pithy-sh/cli");
  });
});
