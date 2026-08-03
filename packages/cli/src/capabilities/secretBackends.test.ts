// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

/**
 * A secret's declared `backend` must be where the value physically goes.
 *
 * CLAUDE.md calls `backend` "the single place a secret's storage location is decided", and the read
 * seam routes strictly on it: a `cf-secrets-store` secret is resolved from a **Worker binding**, so
 * if no wrangler template declares a `secrets_store_secrets` entry for it, a deployed read reaches a
 * binding that does not exist. The declaration is not documentation — it is the routing.
 *
 * Five secrets once declared `cf-secrets-store` while their provisioners wrote them through
 * `dispatchSecretWrite` into the encrypted D1 store, and nothing caught it because both paths happen
 * to agree for `environment` scope (`resolveWriteTargets` returns the one requested environment
 * either way). They diverge for `global` scope, where `cf-secrets-store` writes once via production
 * and `d1` fans out across every environment — so the same latent mistake becomes a real one the
 * moment a secret's scope changes.
 *
 * This scans source text rather than importing the registries on purpose: `@pithy-sh/cli` must not
 * hard-depend on the optional capability packages, so it cannot import `mediaSecretsRegistry` and
 * friends to introspect them.
 */

/** The repo root, from this file's location — `packages/cli/src/capabilities` is four levels down. */
const REPO_ROOT = join(import.meta.dirname, "..", "..", "..", "..");
const PACKAGES = join(REPO_ROOT, "packages");

/** Every file under each package's `src` matching `predicate`, skipping `dist` and test files. */
function sourceFiles(predicate: (path: string) => boolean): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry === "dist" || entry === "node_modules") continue;
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (predicate(path) && !path.includes(".test.")) found.push(path);
    }
  };
  for (const pkg of readdirSync(PACKAGES)) {
    const src = join(PACKAGES, pkg, "src");
    try {
      if (statSync(src).isDirectory()) walk(src);
    } catch {
      // A package without a src/ directory is not a source package.
    }
  }
  return found;
}

/**
 * Every registry key declared `backend: "cf-secrets-store"`.
 *
 * For a store-backed secret the registry key **is** the Worker binding name (`secretsStore` resolves
 * it as `resolveBinding(bindings[name], name)`), which is what makes the comparison below meaningful.
 * The key is whatever precedes the entry — either `KEY: { … }` or `[KEY_CONST]: { … }` — so both
 * forms are matched, and a computed key that resolves to neither is reported rather than skipped.
 */
function declaredStoreBackedKeys(): string[] {
  const keys: string[] = [];
  for (const path of sourceFiles((p) => p.endsWith(".ts"))) {
    const source = readFileSync(path, "utf8");
    if (!source.includes('backend: "cf-secrets-store"')) continue;
    // Walk each declaration and take the nearest preceding object key.
    for (const match of source.matchAll(
      /(?:^|\n)\s*(?:\[([A-Z0-9_]+)\]|([A-Za-z0-9_]+)):\s*\{[^}]*?backend:\s*"cf-secrets-store"/gs,
    )) {
      keys.push(match[1] ?? match[2] ?? "<unparsed>");
    }
  }
  return [...new Set(keys)].sort();
}

/** The bindings one wrangler template declares, split by the two blocks this test cares about. */
function templateBindings(path: string): { store: string[]; d1: string[] } {
  const source = readFileSync(path, "utf8").replace(/^\s*\/\/.*$/gm, "");
  const blockOf = (key: string): string =>
    source.match(new RegExp(`"${key}"\\s*:\\s*\\[(.*?)\\n\\s*\\]`, "s"))?.[1] ?? "";
  const bindingsIn = (block: string): string[] =>
    [...block.matchAll(/"binding"\s*:\s*"([^"]+)"/g)].map((m) => m[1] as string);
  return { store: bindingsIn(blockOf("secrets_store_secrets")), d1: bindingsIn(blockOf("d1_databases")) };
}

/** Every committed wrangler template, with its bindings. */
function templates(): { path: string; store: string[]; d1: string[] }[] {
  return sourceFiles((p) => p.endsWith("wrangler.jsonc")).map((path) => ({ path, ...templateBindings(path) }));
}

/** Every `secrets_store_secrets[].binding` across every committed wrangler template. */
function boundStoreBindings(): string[] {
  return [...new Set(templates().flatMap((t) => t.store))].sort();
}

/** The master key's binding name — fixed, and the same in every template that reads secrets. */
const MASTER_KEY_BINDING = "SECRETS_ENCRYPTION_KEYS";

describe("a secret's declared backend is where the value actually goes", () => {
  test("the scan finds real declarations, so a broken glob cannot make this vacuous", () => {
    expect(declaredStoreBackedKeys().length).toBeGreaterThan(0);
    expect(boundStoreBindings().length).toBeGreaterThan(0);
  });

  test("every `cf-secrets-store` secret is bound by some wrangler template", () => {
    const bound = new Set(boundStoreBindings());
    const unbound = declaredStoreBackedKeys().filter((key) => !bound.has(key));
    // An unbound store-backed secret resolves to a binding that does not exist at runtime. Either add
    // the `secrets_store_secrets` entry, or declare the secret `d1` — whichever is actually true.
    expect(unbound).toEqual([]);
  });

  test("no key is left unparsed, so a new declaration shape cannot slip through the scan", () => {
    expect(declaredStoreBackedKeys()).not.toContain("<unparsed>");
  });
});

/**
 * The at-rest encryption key is the one secret that **must** live in the Cloudflare Secrets Store,
 * and it is the only secret exempt from the `secretsStore` reader (CLAUDE.md).
 *
 * It is the bootstrap: it decrypts every `d1`-backed secret, so it cannot itself be a `d1` row —
 * there would be nothing to decrypt it with. `resolveEncryptionConfig` reads it straight off the
 * `SECRETS_ENCRYPTION_KEYS` binding for exactly that reason. It appears in no `defineSecretRegistry`,
 * which is why the scan above cannot see it and it needs its own assertions.
 *
 * Worth pinning explicitly because five neighbouring credential secrets were just corrected from
 * `cf-secrets-store` to `d1`: the master key must never be swept along with them.
 */
describe("the at-rest encryption key stays in the Cloudflare Secrets Store", () => {
  test("it is store-backed, and never declared as a D1 row", () => {
    expect(boundStoreBindings()).toContain(MASTER_KEY_BINDING);

    const asD1 = sourceFiles((p) => p.endsWith(".ts")).filter((path) => {
      const source = readFileSync(path, "utf8");
      return new RegExp(`${MASTER_KEY_BINDING}[^}]*?backend:\\s*"d1"`, "s").test(source);
    });
    expect(asD1).toEqual([]);
  });

  test("every worker that can read a secret can also decrypt one", () => {
    // A `d1`-backed secret is an encrypted row; without the master key binding the worker holds
    // ciphertext it cannot open, and the failure lands at the first read rather than at deploy.
    const mismatched = templates()
      .filter((t) => t.d1.includes("SECRETS") !== t.store.includes(MASTER_KEY_BINDING))
      .map((t) => t.path.slice(REPO_ROOT.length + 1));
    expect(mismatched).toEqual([]);
  });
});
