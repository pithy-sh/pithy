// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { heldLines, heldSummary } from "./held";
import type { PackageHeld } from "./plan";

const LATEST = "pithy upgrade --packages --latest";

function held(overrides: Partial<PackageHeld> & Pick<PackageHeld, "name" | "latest">): PackageHeld {
  return {
    manifest: "package.json",
    range: "^0.24.1",
    installed: "0.24.2",
    reason: "breaking",
    command: LATEST,
    ...overrides,
  };
}

describe("heldLines", () => {
  test("names the package, the newest version, the one installed, why, and the command", () => {
    expect(heldLines([held({ name: "@pithy-sh/cli", latest: "0.25.0" })])).toEqual([
      "@pithy-sh/cli  0.25.0 held, 0.24.2 installed. A new 0.x minor crosses a breaking boundary. Run pithy upgrade --packages --latest.",
    ]);
  });

  test("a new major says so", () => {
    expect(heldLines([held({ name: "@pithy-sh/auth", range: "^1.2.0", installed: "1.4.0", latest: "2.0.0" })])).toEqual(
      [
        "@pithy-sh/auth  2.0.0 held, 1.4.0 installed. A new major crosses a breaking boundary. Run pithy upgrade --packages --latest.",
      ],
    );
  });

  test("a gap that is no boundary names the declared range", () => {
    const entry = held({ name: "@pithy-sh/auth", range: "0.2.0", installed: "0.2.0", latest: "0.2.3" });
    expect(heldLines([{ ...entry, reason: "outside-range" }])).toEqual([
      "@pithy-sh/auth  0.2.3 held, 0.2.0 installed. Outside the declared range 0.2.0. Run pithy upgrade --packages --latest.",
    ]);
  });

  test("nothing installed is said, not left blank", () => {
    expect(heldLines([held({ name: "@pithy-sh/core", installed: null, latest: "0.21.0" })])).toEqual([
      "@pithy-sh/core  0.21.0 held, nothing installed. A new 0.x minor crosses a breaking boundary. Run pithy upgrade --packages --latest.",
    ]);
  });

  test("one package held the same way in two manifests is one line; a different install is its own", () => {
    const lines = heldLines([
      held({ name: "@pithy-sh/core", latest: "0.21.0", installed: "0.20.1" }),
      held({ name: "@pithy-sh/core", latest: "0.21.0", installed: "0.20.1", manifest: "apps/api/package.json" }),
      held({ name: "@pithy-sh/core", latest: "0.21.0", installed: "0.20.0", manifest: "apps/web/package.json" }),
    ]);
    expect(lines).toEqual([
      "@pithy-sh/core  0.21.0 held, 0.20.1 installed. A new 0.x minor crosses a breaking boundary. Run pithy upgrade --packages --latest.",
      "@pithy-sh/core  0.21.0 held, 0.20.0 installed. A new 0.x minor crosses a breaking boundary. Run pithy upgrade --packages --latest.",
    ]);
  });
});

describe("heldSummary", () => {
  test("nothing held says nothing", () => {
    expect(heldSummary([])).toBeNull();
  });

  test("names each package held once, with its newest version, and the command that takes them", () => {
    expect(
      heldSummary([
        held({ name: "@pithy-sh/cli", latest: "0.25.0" }),
        held({ name: "@pithy-sh/core", latest: "0.21.0" }),
        held({ name: "@pithy-sh/core", latest: "0.21.0", manifest: "apps/api/package.json" }),
      ]),
    ).toBe(
      "Held back: @pithy-sh/cli 0.25.0, @pithy-sh/core 0.21.0. Run pithy upgrade --packages --latest to take them.",
    );
  });

  test("one package is taken as it", () => {
    expect(heldSummary([held({ name: "@pithy-sh/cli", latest: "0.25.0" })])).toBe(
      "Held back: @pithy-sh/cli 0.25.0. Run pithy upgrade --packages --latest to take it.",
    );
  });
});
