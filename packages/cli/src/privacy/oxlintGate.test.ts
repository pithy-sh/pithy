// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { OXLINT_NO_CONSOLE_OVERRIDE } from "./consoleGate";
import { oxlintGateOf, withEslintIgnore } from "./oxlintGate";

const FILE = ".oxlintrc.json";
const SOURCE = ["apps/api/src/index.ts"];
const read = (config: unknown, sources: readonly string[] = SOURCE) => oxlintGateOf(config, FILE, sources);

describe("oxlintGateOf: enforced", () => {
  test("by the rule at the root, in every spelling of `error`", () => {
    for (const level of ["error", "deny", 2, ["error"], ["deny", {}]]) {
      expect(read({ rules: { "no-console": level } })).toEqual({ state: "enforced", file: FILE });
    }
    expect(read({ rules: { "eslint/no-console": "error" } }).state).toBe("enforced");
  });

  test("by the override `pithy privacy enable` writes, which leaves tests aside", () => {
    expect(read({ overrides: [OXLINT_NO_CONSOLE_OVERRIDE] }, [...SOURCE, "apps/api/src/client.tsx"]).state).toBe(
      "enforced",
    );
  });

  test("by the `restriction` category at `error`, where no rule says otherwise", () => {
    expect(read({ categories: { restriction: "error" } }).state).toBe("enforced");
    expect(read({ categories: { restriction: "error" }, rules: { "no-console": "warn" } })).toMatchObject({
      state: "off",
      cause: "lowered",
    });
  });
});

describe("oxlintGateOf: off", () => {
  test("unstated when nothing names the rule, the one cause `enable` writes", () => {
    expect(read({ rules: { eqeqeq: "error" } })).toEqual({
      state: "off",
      file: FILE,
      rule: "no-console",
      cause: "unstated",
      reason: "no-console is not on for apps/api/src/index.ts in .oxlintrc.json.",
    });
    expect(read({}).state).toBe("off");
  });

  test("lowered by a level below `error`, or by an allow-list", () => {
    for (const level of ["warn", 1, "off", "allow", 0]) {
      expect(read({ rules: { "no-console": level } })).toMatchObject({ state: "off", cause: "lowered" });
    }
    const allowed = read({ rules: { "no-console": ["error", { allow: ["warn", "error"] }] } });
    expect(allowed).toMatchObject({ state: "off", cause: "lowered" });
    expect(allowed.state === "off" && allowed.reason).toContain("`console.warn`, `console.error`");
  });

  test("lowered by an override that covers the file, and not by one that does not", () => {
    const base = { rules: { "no-console": "error" } };
    const covering = { files: ["apps/api/src/**"], rules: { "no-console": "off" } };
    expect(read({ ...base, overrides: [covering] })).toMatchObject({ state: "off", cause: "lowered" });
    const elsewhere = { files: ["scripts/**"], rules: { "no-console": "off" } };
    expect(read({ ...base, overrides: [elsewhere] }).state).toBe("enforced");
    const excluded = { ...covering, excludeFiles: ["**/index.ts"] };
    expect(read({ ...base, overrides: [excluded] }).state).toBe("enforced");
  });

  test("lowered for the one file an override reaches, named in the reason", () => {
    const config = {
      rules: { "no-console": "error" },
      overrides: [{ files: ["apps/api/src/legacy/**"], rules: { "no-console": "warn" } }],
    };
    const gate = read(config, [...SOURCE, "apps/api/src/legacy/old.ts"]);
    expect(gate.state === "off" && gate.reason).toContain("apps/api/src/legacy/old.ts");
  });

  test("disabled when `ignorePatterns` leave a Worker source file unlinted", () => {
    const gate = read({ rules: { "no-console": "error" }, ignorePatterns: ["apps/api/src"] });
    expect(gate).toMatchObject({ state: "off", cause: "disabled" });
    expect(gate.state === "off" && gate.reason).toContain("ignorePatterns");
  });
});

describe("oxlintGateOf: unverifiable, never a guess", () => {
  test("for a negated or bracketed glob", () => {
    const negated = { files: ["**/*.ts", "!**/*.test.ts"], rules: { "no-console": "error" } };
    expect(read({ overrides: [negated] }).state).toBe("unverifiable");
    expect(read({ rules: { "no-console": "error" }, ignorePatterns: ["!keep.ts"] }).state).toBe("unverifiable");
    const braced = { files: ["**/*.{ts,tsx}"], rules: { "no-console": "error" } };
    const gate = read({ overrides: [braced] });
    expect(gate).toMatchObject({ state: "unverifiable", file: FILE });
    expect(gate.state === "unverifiable" && gate.reason).toContain("Oxlint's reading");
  });

  test("for an override with no `files` list", () => {
    expect(read({ overrides: [{ rules: { "no-console": "error" } }] }).state).toBe("unverifiable");
  });

  test("for one block stating the rule under both of its names", () => {
    const gate = read({ rules: { "no-console": "error", "eslint/no-console": "off" } });
    expect(gate.state === "unverifiable" && gate.reason).toContain("both");
  });

  test("for a config that extends another, unless a file is already off", () => {
    expect(read({ extends: ["./base.json"], rules: { "no-console": "error" } }).state).toBe("unverifiable");
    expect(read({ extends: [], rules: { "no-console": "error" } }).state).toBe("enforced");
    expect(read({ extends: ["./base.json"], rules: { "no-console": "warn" } }).state).toBe("off");
  });
});

describe("withEslintIgnore", () => {
  test("adds an .eslintignore's patterns to ignorePatterns, skipping blanks and comments", () => {
    expect(withEslintIgnore({ ignorePatterns: ["dist"] }, "# built\n\napps/api/src\r\n")).toEqual({
      ignorePatterns: ["dist", "apps/api/src"],
    });
    expect(withEslintIgnore({}, "apps/api/src\n")).toEqual({ ignorePatterns: ["apps/api/src"] });
    expect(withEslintIgnore({ rules: {} }, "# nothing\n")).toEqual({ rules: {} });
  });

  test("leaves an ignorePatterns that is not a list alone, for the gate to refuse", () => {
    const config = { ignorePatterns: "apps" };
    expect(withEslintIgnore(config, "dist\n")).toEqual(config);
    expect(read(withEslintIgnore(config, "dist\n")).state).toBe("unverifiable");
  });
});
