// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const pkg = join(import.meta.dirname, "..");
const docs = readdirSync(join(pkg, "docs"))
  .filter((f) => f.endsWith(".md"))
  .map((f) => ({ file: `docs/${f}`, text: readFileSync(join(pkg, "docs", f), "utf8") }));
const readme = { file: "README.md", text: readFileSync(join(pkg, "README.md"), "utf8") };

describe("what the auth docs tell an adopter to run", () => {
  test("the sweep is reading the docs, not nothing", () => {
    // Five provider pages store a credential. A glob that lost them would pass every check below.
    const storing = docs.filter((d) => /pithy secrets create auth-\w+-credentials/.test(d.text));
    expect(storing.length).toBeGreaterThanOrEqual(5);
  });

  test("no command passes a secret's value to --json, which is the output flag", () => {
    // `--json` on `pithy secrets` is the boolean "Machine-readable output" flag, and the value is never
    // read from a flag (`packages/cli/src/commands/secrets.ts`, `readValue`). Written as a flag value,
    // the JSON becomes a stray positional and a terminal run refuses with nothing stored.
    const offenders = [readme, ...docs].flatMap((d) =>
      d.text
        .split("\n")
        .filter((line) => /pithy secrets (create|update)\b.*--json\s+['"{]/.test(line))
        .map((line) => `${d.file}: ${line.trim()}`),
    );
    expect(offenders).toEqual([]);
  });
});

describe("what the README promises about linking from inside the account", () => {
  test("it does not promise an unverified, different address will link", () => {
    // Better Auth's `linkOAuthAccount` refuses a provider outside `trustedProviders` whose address is
    // unverified, `allowDifferentEmails` or not. Microsoft reaches that refusal on purpose.
    const paragraph = readme.text.split("\n").find((line) => line.includes("Linking from inside the account"));
    expect(paragraph).toBeDefined();
    expect(paragraph).not.toMatch(/deliberately unconstrained by the address\./);
    expect(paragraph).toMatch(/verified/);
  });
});
