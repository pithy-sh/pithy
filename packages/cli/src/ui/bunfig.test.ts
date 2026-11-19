// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { withHoistedLinker } from "./bunfig";

describe("withHoistedLinker", () => {
  test("no bunfig.toml becomes one that installs with the hoisted linker", () => {
    expect(withHoistedLinker(null)).toBe('[install]\nlinker = "hoisted"\n');
  });

  test("a bunfig.toml with no [install] table gains one at the end", () => {
    expect(withHoistedLinker('telemetry = false\n\n[test]\nroot = "src"\n')).toBe(
      'telemetry = false\n\n[test]\nroot = "src"\n\n[install]\nlinker = "hoisted"\n',
    );
  });

  test("a file with no trailing newline still ends on one", () => {
    expect(withHoistedLinker("telemetry = false")).toBe('telemetry = false\n\n[install]\nlinker = "hoisted"\n');
  });

  test("an [install] table with no linker gains it as the table's first key", () => {
    expect(withHoistedLinker('[install]\nexact = true\n\n[test]\nroot = "src"\n')).toBe(
      '[install]\nlinker = "hoisted"\nexact = true\n\n[test]\nroot = "src"\n',
    );
  });

  test("a linker the adopter already chose is theirs, and the file is left alone", () => {
    expect(withHoistedLinker('[install]\nlinker = "isolated"\n')).toBeNull();
    expect(withHoistedLinker('[install]\n  linker="hoisted"\n')).toBeNull();
  });

  test("a linker key in another table does not count as the install linker", () => {
    expect(withHoistedLinker('[other]\nlinker = "x"\n')).toBe(
      '[other]\nlinker = "x"\n\n[install]\nlinker = "hoisted"\n',
    );
  });

  test("a dotted install.linker key at the top level is the adopter's choice too", () => {
    expect(withHoistedLinker('install.linker = "isolated"\n')).toBeNull();
  });

  test("a commented-out linker is not a choice", () => {
    expect(withHoistedLinker('[install]\n# linker = "isolated"\n')).toBe(
      '[install]\nlinker = "hoisted"\n# linker = "isolated"\n',
    );
  });
});
