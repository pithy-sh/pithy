// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { existsSync, readdirSync, readFileSync } from "node:fs";
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

describe("what the auth docs tell an adopter to import", () => {
  // `package.json` exports only `./src/*`, so a bare `@pithy-sh/auth` does not resolve
  // (ERR_PACKAGE_PATH_NOT_EXPORTED). Every sample imports a module by its deep path.
  const imports = [readme, ...docs].flatMap((d) =>
    [...d.text.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+"(@pithy-sh\/auth(?:\/[^"]*)?)"/g)].map((m) => ({
      file: d.file,
      names: (m[1] ?? "")
        .split(",")
        .map(
          (n) =>
            n
              .trim()
              .replace(/^type\s+/, "")
              .split(/\s+as\s+/)[0] ?? "",
        )
        .filter(Boolean),
      specifier: m[2] ?? "",
    })),
  );

  test("the sweep is reading the samples, not nothing", () => {
    expect(imports.length).toBeGreaterThanOrEqual(5);
  });

  test("every import names an exported module that exports what it imports", () => {
    const offenders = imports.flatMap(({ file, names, specifier }) => {
      const sub = /^@pithy-sh\/auth\/src\/(.+)$/.exec(specifier)?.[1];
      const source = sub === undefined ? undefined : join(pkg, "src", `${sub.replace(/\.(js|ts)$/, "")}.ts`);
      if (source === undefined || !existsSync(source)) return [`${file}: ${specifier} does not resolve`];
      const text = readFileSync(source, "utf8");
      return names
        .filter(
          (n) =>
            !new RegExp(
              `export\\s+(?:async\\s+)?(?:function|const|class|type|interface)\\s+${n}\\b|export\\s+\\{[^}]*\\b${n}\\b`,
            ).test(text),
        )
        .map((n) => `${file}: ${specifier} does not export ${n}`);
    });
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

describe("what the auth docs say about requireRecentSignIn", () => {
  const page = docs.find((d) => d.file === "docs/recent-sign-in.md");

  test("the README links its page", () => {
    expect(readme.text).toMatch(/\[[^\]]*\]\(docs\/recent-sign-in\.md\)/);
    expect(readme.text).toMatch(/requireRecentSignIn/);
  });

  test("the page names the gate, its refusal and its audit action", () => {
    expect(page).toBeDefined();
    expect(page?.text).toMatch(/requireRecentSignIn\(\{ maxAgeSeconds: \d+, purpose: "[a-z_]+\/[a-z_]+" \}\)/);
    expect(page?.text).toMatch(/auth\/recent_sign_in_required/);
    expect(page?.text).toMatch(/auth\/recent_sign_in_refused/);
  });

  test("the page gives the module authenticationIsFresh is imported from", () => {
    expect(page?.text).toMatch(
      /import \{ authenticationIsFresh \} from "@pithy-sh\/auth\/src\/http\/providerFreshness"/,
    );
  });

  test("the page tells a phone client that a rotation never passes and a new sign-in does", () => {
    // `/token/rotate` carries `authenticatedAt` forward (`src/instance/auth.ts`, `session.create.before`),
    // so a client that answered the refusal by rotating would retry forever.
    expect(page?.text).toMatch(/## A phone client/);
    expect(page?.text).toMatch(/## A web client/);
    expect(page?.text).toMatch(/rotat[a-z]* never passes/i);
    expect(page?.text).toMatch(/adopt\(/);
  });
});
