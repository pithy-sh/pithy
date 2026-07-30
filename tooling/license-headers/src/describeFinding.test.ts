// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import type { Finding } from "./audit";
import { describeFinding } from "./describeFinding";

// One line per finding kind. These are the only words a developer sees when the gate fails, so each
// has to name the file and say what to do about it — a kind rendered as a bare path teaches nothing.
describe("describeFinding", () => {
  const cases: Array<[string, Finding, string[]]> = [
    [
      "missing-license-field",
      { kind: "missing-license-field", package: "@pithy-sh/core" },
      ["@pithy-sh/core", "no license"],
    ],
    [
      "unknown-license",
      { kind: "unknown-license", package: "@pithy-sh/core", license: "Apache-2.0" },
      ["@pithy-sh/core", "Apache-2.0"],
    ],
    [
      "missing-license-file",
      { kind: "missing-license-file", package: "@pithy-sh/core", path: "packages/core/LICENSE" },
      ["packages/core/LICENSE", "@pithy-sh/core"],
    ],
    [
      "license-file-mismatch",
      { kind: "license-file-mismatch", package: "@pithy-sh/core", path: "packages/core/LICENSE" },
      ["packages/core/LICENSE", "by hand"],
    ],
    [
      "missing-header",
      { kind: "missing-header", path: "packages/core/src/a.ts", expected: "MIT", actual: null },
      ["packages/core/src/a.ts", "MIT"],
    ],
    [
      "wrong-header",
      { kind: "wrong-header", path: "packages/core/src/a.ts", expected: "MIT", actual: "FSL-1.1-MIT" },
      ["packages/core/src/a.ts", "MIT", "FSL-1.1-MIT"],
    ],
    [
      "unexpected-header",
      { kind: "unexpected-header", path: "packages/ui-react/templates/a.tsx" },
      ["packages/ui-react/templates/a.tsx", "adopter"],
    ],
  ];

  test.each(cases)("%s names its subject and the problem", (_kind, finding, expected) => {
    const line = describeFinding(finding);
    for (const fragment of expected) expect(line).toContain(fragment);
  });

  test.each(cases)("%s renders one line, with no newline to break the report", (_kind, finding) => {
    expect(describeFinding(finding)).not.toContain("\n");
  });

  test("covers every kind the audit can produce", () => {
    expect(cases.map(([kind]) => kind).sort()).toEqual(
      [
        "license-file-mismatch",
        "missing-header",
        "missing-license-field",
        "missing-license-file",
        "unexpected-header",
        "unknown-license",
        "wrong-header",
      ].sort(),
    );
  });
});
