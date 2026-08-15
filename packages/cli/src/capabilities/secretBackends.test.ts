// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { isShippedSource, readSource, sourcePaths } from "../ci/sourceFiles";

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

/**
 * Every file under each package's `src` whose name `keep` accepts.
 *
 * The traversal is `ci/sourceFiles.ts`, the one every reader of this tree's own source goes through — so
 * the ENOENT tolerance and the `packages/cli/templates` exclusion that landed after this file was written
 * (#185, #192) reach it too, instead of stopping at the walker they were written in (#202). Listing
 * `packages/` itself stays here: that is one directory, not a traversal.
 */
function sourceFiles(keep: (name: string) => boolean): string[] {
  const found: string[] = [];
  for (const pkg of readdirSync(PACKAGES, { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue;
    // A package without a `src/` contributes nothing rather than throwing.
    found.push(...sourcePaths(join(PACKAGES, pkg.name, "src"), { keep }));
  }
  return found;
}

/** A committed wrangler template, by base name. */
function isWranglerTemplate(name: string): boolean {
  return name === "wrangler.jsonc";
}

/**
 * The declaration this whole file hunts for. Counted as text, so nothing can be skipped silently.
 *
 * **Raw text, comments included, and that is deliberate rather than an oversight.** Stripping comments
 * before the scan would be one heuristic away from losing a real declaration, and this file's whole
 * design is that a declaration it cannot read is *loud* rather than absent. The cost is a rule for
 * anyone writing prose in `packages/*​/src`: **do not quote this exact string in a comment.** Name the
 * backend on its own (`a cf-secrets-store secret`) instead. A comment that quotes it is reported as an
 * unnameable declaration, with the surrounding text in the message, which is a confusing failure but a
 * safe one — the unsafe direction is the one this refuses to take.
 */
const STORE_BACKED = 'backend: "cf-secrets-store"';

/** Every shipped source, with its text. Read once — three of the four helpers below need all of it. */
function shippedSources(): { path: string; source: string }[] {
  const found: { path: string; source: string }[] = [];
  for (const path of sourceFiles(isShippedSource)) {
    const source = readSource(path);
    if (source !== null) found.push({ path, source });
  }
  return found;
}

/**
 * Every `const NAME = "literal"` in the shipped sources, so a computed key resolves to the name that
 * actually reaches the store rather than to the identifier somebody spelled it with.
 *
 * `[MEDIA_STORAGE_SECRET]: { … }` is a declaration of `media-storage-credentials`; reporting
 * `MEDIA_STORAGE_SECRET` would be reporting a binding nobody ever writes, and comparing it against a
 * wrangler template would produce a failure with no true remedy. A name declared twice with two values
 * is dropped from the map, so it throws at the point of use rather than resolving to whichever won.
 */
function stringConstants(sources: readonly { source: string }[]): Map<string, string> {
  const found = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const { source } of sources) {
    for (const match of source.matchAll(/(?:^|\n)\s*(?:export\s+)?const\s+([A-Za-z0-9_$]+)\s*=\s*"([^"]*)"/g)) {
      const name = match[1] as string;
      const value = match[2] as string;
      if (found.has(name) && found.get(name) !== value) ambiguous.add(name);
      found.set(name, value);
    }
  }
  for (const name of ambiguous) found.delete(name);
  return found;
}

/** The index of the `{` that opens the object literal containing `at`, balancing braces backwards. */
function openingBrace(source: string, at: number): number {
  let depth = 0;
  for (let index = at; index >= 0; index -= 1) {
    const char = source[index];
    if (char === "}") depth += 1;
    else if (char === "{") {
      if (depth === 0) return index;
      depth -= 1;
    }
  }
  return -1;
}

/**
 * The registry key one `backend: "cf-secrets-store"` declaration is filed under.
 *
 * **Every shape, and a throw for anything else.** The previous extractor matched a bare identifier or an
 * UPPERCASE computed key and nothing more, so `"media-storage-credentials": { … }` — the hyphenated,
 * quoted form every non-core capability names its secrets with — was not reported as unparsed. It
 * produced no match at all, so the declaration simply vanished before the comparison it was meant to
 * face, and the `<unparsed>` sentinel the old file asserted against could never be reached.
 *
 * So the unnameable case throws. A declaration shape this cannot read is a store-backed secret nobody
 * is checking, and that has to be loud rather than empty.
 */
function keyOf(
  path: string,
  source: string,
  at: number,
  constants: Map<string, string>,
  all: readonly string[],
): string {
  const open = openingBrace(source, at);
  const header = open < 0 ? "" : source.slice(Math.max(0, open - 300), open);
  const refuse = (why: string): never => {
    throw new Error(
      `${path}: a \`${STORE_BACKED}\` declaration ${why}.\nTeach this extractor the shape — a declaration it cannot name is a store-backed secret nothing is holding against the wrangler templates.\n…${header.slice(-160)}{`,
    );
  };

  const computed = /\[\s*([A-Za-z0-9_$]+)\s*\]\s*:\s*$/.exec(header);
  if (computed) {
    const name = computed[1] as string;
    return constants.get(name) ?? refuse(`is keyed by \`${name}\`, which resolves to no unique string literal`);
  }
  const quoted = /["']([^"']+)["']\s*:\s*$/.exec(header);
  if (quoted) return quoted[1] as string;
  const bare = /(?:^|[\s,{])([A-Za-z0-9_$]+)\s*:\s*$/.exec(header);
  if (bare) return bare[1] as string;

  // The entry is bound to a variable and used as a registry value elsewhere — `masterKeyRegistryEntry`
  // is declared in `secrets/capability.ts` and filed under `[MASTER_KEY_BINDING]` forty lines later.
  // Following the variable is the only way to learn the name it is actually stored under.
  const bound = /\bconst\s+([A-Za-z0-9_$]+)\s*(?::[^=]*)?=\s*$/.exec(header);
  if (!bound) return refuse("is not preceded by a key or a variable binding this extractor recognises");
  const variable = bound[1] as string;
  for (const text of all) {
    const used = new RegExp(
      `(?:\\[\\s*([A-Za-z0-9_$]+)\\s*\\]|["']([^"']+)["']|([A-Za-z0-9_$]+))\\s*:\\s*${variable}\\s*[,\\n}]`,
    ).exec(text);
    if (!used) continue;
    if (used[1]) {
      return constants.get(used[1]) ?? refuse(`is filed under \`${used[1]}\`, which resolves to no unique literal`);
    }
    return (used[2] ?? used[3]) as string;
  }
  return refuse(`is bound to \`${variable}\`, which is never used as a registry key`);
}

/**
 * Every registry key declared `backend: "cf-secrets-store"`.
 *
 * For a store-backed secret the registry key **is** the Worker binding name (`secretsStore` resolves
 * it as `resolveBinding(bindings[name], name)`), which is what makes the comparison below meaningful.
 *
 * Driven off a plain text count of the declaration rather than off one regex that has to match both the
 * declaration and its key. A regex that fails to match reports nothing; a count that finds a declaration
 * and cannot name it raises. Those are the same scan with opposite failure modes, and only one of them
 * can be trusted to have looked.
 */
function declaredStoreBackedKeys(): string[] {
  const sources = shippedSources();
  const constants = stringConstants(sources);
  const texts = sources.map(({ source }) => source);
  const keys: string[] = [];
  for (const { path, source } of sources) {
    for (let at = source.indexOf(STORE_BACKED); at >= 0; at = source.indexOf(STORE_BACKED, at + 1)) {
      keys.push(keyOf(path, source, at, constants, texts));
    }
  }
  return [...new Set(keys)].sort();
}

/** The bindings one wrangler template declares, split by the two blocks this test cares about. */
function templateBindings(path: string): { store: string[]; d1: string[] } {
  const source = (readSource(path) ?? "").replace(/^\s*\/\/.*$/gm, "");
  const blockOf = (key: string): string =>
    source.match(new RegExp(`"${key}"\\s*:\\s*\\[(.*?)\\n\\s*\\]`, "s"))?.[1] ?? "";
  const bindingsIn = (block: string): string[] =>
    [...block.matchAll(/"binding"\s*:\s*"([^"]+)"/g)].map((m) => m[1] as string);
  return { store: bindingsIn(blockOf("secrets_store_secrets")), d1: bindingsIn(blockOf("d1_databases")) };
}

/** Every committed wrangler template, with its bindings. */
function templates(): { path: string; store: string[]; d1: string[] }[] {
  return sourceFiles(isWranglerTemplate).map((path) => ({ path, ...templateBindings(path) }));
}

/** Every `secrets_store_secrets[].binding` across every committed wrangler template. */
function boundStoreBindings(): string[] {
  return [...new Set(templates().flatMap((t) => t.store))].sort();
}

/** The master key's binding name — fixed, and the same in every template that reads secrets. */
const MASTER_KEY_BINDING = "SECRETS_ENCRYPTION_KEYS";

describe("a secret's declared backend is where the value actually goes", () => {
  test("the scan finds every declaration there is, named", () => {
    // Exact, not `> 0`. The kit declares two store-backed secrets: the at-rest master key and the
    // manager's Cloudflare token. `> 0` was satisfied by finding one of the two — and it *was* finding
    // one of the two, because `masterKeyRegistryEntry` is a standalone const rather than an inline key
    // and the old regex could not see it. A guard a broken scan still passes is not a guard.
    expect(declaredStoreBackedKeys()).toEqual(["CLOUDFLARE_API_TOKEN", "SECRETS_ENCRYPTION_KEYS"]);
    // And the text count agrees with the naming, so a third declaration cannot be found and dropped.
    const occurrences = shippedSources().reduce(
      (total, { source }) => total + source.split(STORE_BACKED).length - 1,
      0,
    );
    expect(occurrences).toBe(2);
    expect(boundStoreBindings().length).toBeGreaterThan(0);
  });

  test("every `cf-secrets-store` secret is bound by some wrangler template", () => {
    const bound = new Set(boundStoreBindings());
    const unbound = declaredStoreBackedKeys().filter((key) => !bound.has(key));
    // An unbound store-backed secret resolves to a binding that does not exist at runtime. Either add
    // the `secrets_store_secrets` entry, or declare the secret `d1` — whichever is actually true.
    expect(unbound).toEqual([]);
  });

  test("the extractor names every declaration shape, and refuses the ones it cannot", () => {
    // The gate over the gate. `keyOf` is the whole scan, so a shape it reads as "nothing here" is a
    // secret the check above cannot report — which is exactly what the hyphenated quoted key was.
    const constants = new Map([["MEDIA_SECRET", "media-storage-credentials"]]);
    const name = (text: string, all: string[] = [text]) =>
      keyOf("sample.ts", text, text.indexOf(STORE_BACKED), constants, all);

    expect(name(`const r = { CLOUDFLARE_API_TOKEN: { ${STORE_BACKED} } };`)).toBe("CLOUDFLARE_API_TOKEN");
    expect(name(`const r = { "media-storage-credentials": { ${STORE_BACKED} } };`)).toBe("media-storage-credentials");
    expect(name(`const r = { [MEDIA_SECRET]: { ${STORE_BACKED} } };`)).toBe("media-storage-credentials");
    // The field need not come first in the object.
    expect(name(`const r = { "later": { scope: "environment", origin: { kind: "minted" }, ${STORE_BACKED} } };`)).toBe(
      "later",
    );
    // A standalone entry, filed under a computed key somewhere else entirely.
    expect(
      name(`export const entry: SecretRegistryEntry = { ${STORE_BACKED} };`, [
        `export const entry: SecretRegistryEntry = { ${STORE_BACKED} };`,
        "const registry = { [MEDIA_SECRET]: entry };",
      ]),
    ).toBe("media-storage-credentials");

    // And the shapes it cannot name raise rather than vanishing.
    expect(() => name(`const r = { [UNKNOWN_CONST]: { ${STORE_BACKED} } };`)).toThrow(/resolves to no unique/);
    expect(() => name(`export const orphan = { ${STORE_BACKED} };`)).toThrow(/never used as a registry key/);
    expect(() => name(`const r = [{ ${STORE_BACKED} }];`)).toThrow(/not preceded by a key/);
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

    const asD1 = sourceFiles(isShippedSource).filter((path) => {
      const source = readSource(path);
      return source !== null && new RegExp(`${MASTER_KEY_BINDING}[^}]*?backend:\\s*"d1"`, "s").test(source);
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
