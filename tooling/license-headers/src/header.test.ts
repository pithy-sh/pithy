// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { applyHeader, buildHeader, mentionsSpdx, readIdentifier } from "./header";

describe("buildHeader", () => {
  test("puts the copyright line above the identifier line", () => {
    expect(buildHeader("MIT")).toBe("// SPDX-FileCopyrightText: 2026 Pithy\n// SPDX-License-Identifier: MIT");
  });
});

describe("readIdentifier", () => {
  test("reads the identifier from a headed file", () => {
    expect(readIdentifier(`${buildHeader("MIT")}\n\nexport const a = 1;\n`)).toBe("MIT");
  });

  test("returns null when the file has no header", () => {
    expect(readIdentifier("export const a = 1;\n")).toBeNull();
  });

  test("reads past a shebang", () => {
    expect(readIdentifier(`#!/usr/bin/env bun\n${buildHeader("MIT")}\n\nrun();\n`)).toBe("MIT");
  });

  // The header is the file's opening comment block, not "anywhere the string appears". A package
  // that documents SPDX in a doc comment must still fail the gate if its own header is missing.
  test("ignores an identifier that appears below the leading comment block", () => {
    expect(readIdentifier("import { z } from 'zod';\n\n// SPDX-License-Identifier: MIT\n")).toBeNull();
  });

  // Nearly every file in this repo opens with a module docblock. A header hand-placed under one is
  // still the file's header — failing to see it makes --fix write a second copy.
  test("reads an identifier sitting below a leading docblock", () => {
    expect(readIdentifier("/** What this module is.\n *\n * More prose.\n */\n// SPDX-License-Identifier: MIT\n")).toBe(
      "MIT",
    );
  });

  test("reads an identifier below a single-line block comment", () => {
    expect(readIdentifier("/* banner */\n// SPDX-License-Identifier: MIT\n")).toBe("MIT");
  });

  test("still stops at the first real statement", () => {
    expect(readIdentifier("/** doc */\nexport const a = 1;\n// SPDX-License-Identifier: MIT\n")).toBeNull();
  });
});

describe("mentionsSpdx", () => {
  // The template carve-out reads every file at any extension, and a .css or .html scaffold cannot
  // carry a `//` comment. Detecting only the TypeScript form would let a stamped stylesheet ship to
  // the adopter unflagged, which is the exact thing the carve-out exists to prevent.
  test("sees a block-comment identifier, as a stylesheet would carry", () => {
    expect(mentionsSpdx("/* SPDX-License-Identifier: MIT */\n.a { color: red; }\n")).toBe(true);
  });

  test("sees an HTML-comment identifier", () => {
    expect(mentionsSpdx("<!-- SPDX-License-Identifier: MIT -->\n<html></html>\n")).toBe(true);
  });

  test("sees a hash-comment identifier", () => {
    expect(mentionsSpdx("# SPDX-License-Identifier: MIT\nKEY=value\n")).toBe(true);
  });

  test("sees the ordinary line-comment identifier", () => {
    expect(mentionsSpdx("// SPDX-License-Identifier: MIT\n\nexport const a = 1;\n")).toBe(true);
  });

  test("is false for a file that carries none", () => {
    expect(mentionsSpdx(".a { color: red; }\n")).toBe(false);
  });
});

describe("applyHeader", () => {
  test("inserts the header above the first line, separated by a blank line", () => {
    expect(applyHeader("export const a = 1;\n", "MIT")).toBe(`${buildHeader("MIT")}\n\nexport const a = 1;\n`);
  });

  test("keeps a shebang on line 1 and puts the header under it", () => {
    const out = applyHeader("#!/usr/bin/env bun\nrun();\n", "MIT");
    expect(out.split("\n")[0]).toBe("#!/usr/bin/env bun");
    expect(out).toBe(`#!/usr/bin/env bun\n${buildHeader("MIT")}\n\nrun();\n`);
  });

  test("is idempotent", () => {
    const once = applyHeader("export const a = 1;\n", "MIT");
    expect(applyHeader(once, "MIT")).toBe(once);
  });

  test("is idempotent on a shebang file", () => {
    const once = applyHeader("#!/usr/bin/env bun\nrun();\n", "MIT");
    expect(applyHeader(once, "MIT")).toBe(once);
  });

  test("corrects a wrong identifier without duplicating the header", () => {
    const wrong = `${buildHeader("MIT")}\n\nexport const a = 1;\n`;
    expect(applyHeader(wrong, "FSL-1.1-MIT")).toBe(`${buildHeader("FSL-1.1-MIT")}\n\nexport const a = 1;\n`);
  });

  // The copyright line is free-form on purpose: `2026 Pithy` becomes an entity name one day, and
  // that edit must not be reverted by the next --fix run.
  test("leaves a customised copyright line alone when the identifier is already right", () => {
    const custom =
      "// SPDX-FileCopyrightText: 2026 Pithy, LLC\n// SPDX-License-Identifier: MIT\n\nexport const a = 1;\n";
    expect(applyHeader(custom, "MIT")).toBe(custom);
  });

  test("preserves a customised copyright line while correcting the identifier", () => {
    const custom =
      "// SPDX-FileCopyrightText: 2026 Pithy, LLC\n// SPDX-License-Identifier: MIT\n\nexport const a = 1;\n";
    expect(applyHeader(custom, "FSL-1.1-MIT")).toBe(
      "// SPDX-FileCopyrightText: 2026 Pithy, LLC\n// SPDX-License-Identifier: FSL-1.1-MIT\n\nexport const a = 1;\n",
    );
  });

  // The duplicate is the damage: --check called it headerless, so --fix stamped a second header
  // above the docblock and left the first one where it was.
  test("corrects a header under a docblock in place, never adding a second", () => {
    const source = "/** What this module is. */\n// SPDX-License-Identifier: MIT\n\nexport const a = 1;\n";

    expect(applyHeader(source, "MIT")).toBe(source);
    expect(applyHeader(source, "FSL-1.1-MIT")).toBe(
      "/** What this module is. */\n// SPDX-License-Identifier: FSL-1.1-MIT\n\nexport const a = 1;\n",
    );
  });

  test("does not add a second blank line before an already-blank first line", () => {
    expect(applyHeader("\nexport const a = 1;\n", "MIT")).toBe(`${buildHeader("MIT")}\n\nexport const a = 1;\n`);
  });
});
