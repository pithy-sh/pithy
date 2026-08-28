// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as authClient from "@pithy-sh/auth/src/client/api";
import { KitErrorPayload } from "@pithy-sh/core/src/error/payload";
import { LocaleCatalogs, MessageKey, messageDomain } from "@pithy-sh/core/src/i18n/catalog";
import { blankComments } from "@pithy-sh/core/src/text/comments";
import { KIT_CATALOGS } from "@pithy-sh/i18n/src/catalogs/kit";
import * as paymentsClient from "@pithy-sh/payments/src/client/api";
import { describe, expect, test } from "vitest";
import { CATALOG } from "../capabilities/catalog";
import { readSource, sourcePaths } from "./sourceFiles";

/**
 * **Every sentence the kit writes exists in every language the kit ships.**
 *
 * Repo-wide and unconditional, like `migrations/orders.test.ts` and `project/capabilityVersions.test.ts`,
 * and for the same reason those two are: the property is only true *as a set*. A capability lands five
 * error codes, a screen gains a line, a template registry gains an email — each of those is a correct,
 * reviewable, self-contained change, and each of them silently makes a Spanish reader meet English.
 * Nothing in the changed package can notice, because the sentence that is missing lives in a package
 * the change never touched.
 *
 * ## One source, not two things agreeing
 *
 * `docs/CONVENTIONS.md` asks the question before a gate is written: can the invariant be removed
 * instead? Half of it can, and is. **The English key set is never written down here.** It is derived
 * from the three places a kit sentence actually lives, and each of those is the only place its own
 * half exists:
 *
 * - **The screens**: the `satisfies MessageCatalog` block baked into each template under
 *   `@pithy-sh/ui-react/templates`. That block is the English, and it is the English precisely because
 *   it is copied into the adopter's repository — there is no second copy in a package to compare it
 *   with, so a list here would be the second copy.
 * - **The capabilities**: every `Capability.messages` contribution in the tree, **swept for rather than
 *   named**. This is #441's verification finding and the reason this file was rewritten: it used to
 *   import `EMAIL_MESSAGES` and nothing else, because `@pithy-sh/email` was the only capability
 *   contributing one — with nothing gating that it stayed the only one. A `messages` contribution
 *   planted on `@pithy-sh/turnstile` with one untranslated English key left this file **green**, which
 *   is exactly the failure the paragraph above says it exists to prevent. Worse in the other direction:
 *   translate that capability's keys and the reverse check below reports them as strays, so the gate
 *   fails on correct work. The sweep is the same move `project/capabilityVersions.test.ts` and
 *   `capabilities/addable.test.ts` make — walk `packages/*`, find the capability file, read what it
 *   declares — and it is `readdirSync`, not `import.meta.glob`, so `ci/sweepPopulation.test.ts` has
 *   nothing to enroll and the population is pinned here instead.
 * - **The errors**: `KitErrorPayload.options`. An error has no English catalog at all — the payload
 *   carries its `message` on the wire and a translating client renders
 *   `t.maybe(code, params) ?? message` — so the taxonomy *is* the key set, and the code *is* the key.
 *
 * The shipped side is derived the same way: `KIT_CATALOGS`, the value `@pithy-sh/i18n` composes into
 * its layers. A locale directory nobody imported into that map ships to nobody, so reading the map
 * rather than the filenames answers "what ships" instead of "what somebody wrote".
 *
 * What is left after that derivation is irreducible. **A translation is not a function of its source**,
 * so English against Spanish is two sets that genuinely have to be compared, and this is the file that
 * compares them.
 *
 * ## Both directions, and why the reverse one is not pedantry
 *
 * A key in English with no Spanish is a reader meeting the source language. A key in Spanish that no
 * English key answers is worse than dead weight: it is a *typo*, and a typo in a catalog is invisible
 * forever, because the lookup that would have found it never runs and the fallback that would have
 * exposed it is the English the reader sees anyway.
 *
 * ## The templates are read as source, and only the templates
 *
 * Three of the four inputs are imported. The fourth cannot be: a template is `.tsx`, it imports
 * `virtual:pithy/*` modules that only a Vite build resolves, and this package's suite is a node program
 * with no JSX. So the baked catalogs are read out of the source text — the same move
 * `migrations/orders.test.ts` makes for the same reason, and with the same comment stripper every gate
 * in this directory shares.
 */

/** `packages/ui-react/templates/src`, the tree the screens are copied out of. */
const TEMPLATES = fileURLToPath(new URL("../../../../packages/ui-react/templates/src", import.meta.url));

/** `packages/`, the tree every capability's `messages` contribution is swept out of. */
const PACKAGES = fileURLToPath(new URL("../../../../packages", import.meta.url));

/**
 * Every kit error code, in union order. `member.shape.code.value` is how the taxonomy reads itself in
 * `payload.ts`, so this is the same access rather than a new one.
 */
const CODES = KitErrorPayload.options.map((member) => member.shape.code.value);

/**
 * The size of the taxonomy, pinned — the third copy of this number, after `core`'s `payload.test.ts`
 * and `@pithy-sh/i18n`'s `catalogs/es/errors.test.ts`.
 *
 * It earns the duplication for the reason those two state: without it, "every code has a Spanish entry"
 * is a comparison of two sets that would agree perfectly if the union failed to import and the catalog
 * were gutted to `{}`. The population is what makes the agreement mean anything.
 *
 * **The four sites, so one red gate names them all.** This number is written by hand in four places on
 * purpose (see above). Adding or removing a kit error code moves every one of them, and they live in
 * three packages that do not run each other's tests — so a contributor who fixes only the one that went
 * red ships the other three red. They are:
 *
 *   packages/core/src/error/payload.test.ts            KIT_ERROR_CODE_COUNT
 *   packages/cli/src/ci/catalogCoverage.test.ts        KIT_ERROR_CODE_COUNT
 *   packages/i18n/src/catalogs/es/errors.test.ts       KIT_ERROR_CODE_COUNT
 *   packages/i18n/src/catalogs/es/catalogs.test.ts     the inline toHaveLength
 *
 * And the code itself also needs: the Spanish sentence in `packages/i18n/src/catalogs/es/errors.ts`,
 * and `bun run docs-catalog` to regenerate `docs/catalog.generated.json`.
 */
const KIT_ERROR_CODE_COUNT = 121;

/**
 * The domain segment a *catalog key* must carry: a capability's `name`, or `app`.
 *
 * Read from the CLI's own discovery catalog rather than restated, so a capability that ships tomorrow
 * may write keys tomorrow. `app` is the adopter's own capability — the router and the home screen are
 * seeded into their repository and are theirs, which is why `app/home.title` is right and
 * `ui_react/home.title` would not be.
 */
const CAPABILITY_DOMAINS = new Set<string>([...CATALOG.map((entry) => entry.name), "app"]);

/**
 * The four domains the **error taxonomy** owns that no capability is named after.
 *
 * **A frozen literal, and that is the whole point.** The previous version of this file built its
 * permitted domain set partly from `CODES.map(messageDomain)` while `CODES` was one of the sets making
 * up the keys being checked — shape 2 of `ci/sweepPopulation.test.ts`'s taxonomy, a check derived from
 * its own subject. No error code could ever have been reported by it: every code's domain was admitted
 * by construction, including the typo'd one the check was for.
 *
 * Written down, `aut/invalid_token` is in neither set and fails. And the equality below keeps the list
 * from rotting: a fifth non-capability domain is a diff a human reads, which is the moment to ask
 * whether it is a new seam or a mistake.
 */
const ERROR_ONLY_DOMAINS = ["cloudflare", "core", "rate_limit", "validation"];

/**
 * The one domain a **browser SDK** owns, which no capability is named after and the taxonomy never sends.
 *
 * Beside {@link ERROR_ONLY_DOMAINS} rather than inside it, because it is a different kind of thing: a
 * `client/*` code is minted in the browser when the request never reached a Worker, so it is on no
 * wire and in no `KitErrorPayload`. Its keys come from {@link SENTINELS}.
 */
const CLIENT_DOMAINS = ["client"];

/** Every domain any kit key may carry — a capability's name, `app`, or one the taxonomy or an SDK owns. */
const KIT_DOMAINS = new Set<string>([...CAPABILITY_DOMAINS, ...ERROR_ONLY_DOMAINS, ...CLIENT_DOMAINS]);

/**
 * Every screen under the template tree: a `.tsx` that is not itself a test, sorted.
 *
 * Through the one walk in `./sourceFiles`, never a private one — `sourceFiles.test.ts` fails any module
 * that writes its own, and the reason is #185's: a tripwire with its own traversal is a tripwire that
 * flakes, and a flaking tripwire gets muted. `keep` is stated because the default is `.ts` only, and a
 * screen is `.tsx`.
 */
function templateFiles(): string[] {
  return sourcePaths(TEMPLATES, { keep: (name) => name.endsWith(".tsx") && !name.endsWith(".test.tsx") });
}

/**
 * A catalog entry as it is written in a baked block: a quoted `<domain>/<path>`, a colon, a quoted
 * sentence. The value is captured because the placeholder comparison needs both sides.
 *
 * The domain segment admits `_`, matching `MessageKey`'s own grammar since `core` widened it to reach
 * `rate_limit/exceeded`.
 */
const CATALOG_ENTRY = /(["'])([a-z][a-z0-9_]*\/[A-Za-z0-9_.]+)\1\s*:\s*(["'])((?:\\.|(?!\3)[^\\])*)\3/g;

/** The tail that makes an object literal a catalog. Nothing else in a template is typed this way. */
const SATISFIES_CATALOG = /^\s*satisfies\s+MessageCatalog\b/;

/** How far past a closing brace the annotation may sit. Every real one is the next token. */
const ANNOTATION_SPAN = 40;

/** One key and the English behind it. */
interface Entry {
  /** The catalog key. */
  key: string;
  /** The sentence, as the source writes it. */
  value: string;
}

/**
 * The entries of every `… satisfies MessageCatalog` block in one template's source.
 *
 * Not exported: the fixtures that prove it can fail are in this file, which is where it is used.
 *
 * Brace-matched from the `= {` rather than pattern-matched whole, because a catalog holds nested braces
 * in nothing today and would hold them the moment somebody writes a `{` inside a sentence. Prose is
 * blanked first with the shared stripper: this repository's docblocks quote catalog keys constantly —
 * the block above this function does — and a docblock that could add a key to the gate's own expected
 * set is a gate that grades its own homework.
 */
function bakedCatalogEntries(source: string): Entry[] {
  const code = blankComments(source);
  const entries: Entry[] = [];
  for (const match of code.matchAll(/=\s*\{/g)) {
    const open = match.index + match[0].length - 1;
    let depth = 0;
    let close = -1;
    for (let at = open; at < code.length; at += 1) {
      if (code[at] === "{") depth += 1;
      else if (code[at] === "}") {
        depth -= 1;
        if (depth === 0) {
          close = at;
          break;
        }
      }
    }
    if (close < 0) continue;
    if (!SATISFIES_CATALOG.test(code.slice(close + 1, close + ANNOTATION_SPAN))) continue;
    for (const entry of code.slice(open, close).matchAll(CATALOG_ENTRY)) {
      entries.push({ key: entry[2] as string, value: entry[4] as string });
    }
  }
  return entries;
}

/** The keys of every baked block, for the callers that want only those. */
function bakedCatalogKeys(source: string): string[] {
  return bakedCatalogEntries(source).map(({ key }) => key);
}

/** Every key the screens bake in, with the file that bakes it, so a failure names something openable. */
function screenKeys(): { key: string; value: string; file: string }[] {
  const found: { key: string; value: string; file: string }[] = [];
  for (const file of templateFiles()) {
    const source = readSource(file);
    if (source === null) continue;
    for (const { key, value } of bakedCatalogEntries(source)) found.push({ key, value, file });
  }
  return found;
}

/**
 * The capability file a package declares its `Capability` in.
 *
 * `core`'s is at `src/controlPlane/capability.ts`; every other package's is at `src/capability.ts`.
 * The same pair `project/capabilityVersions.test.ts` and `scripts/stampVersions.ts` key on, stated the
 * same way so the three cannot disagree about what a capability package is.
 */
function capabilityFile(dir: string): string {
  return dir === "core"
    ? join(PACKAGES, dir, "src/controlPlane/capability.ts")
    : join(PACKAGES, dir, "src/capability.ts");
}

/** `messages: <identifier>` on a capability literal — the contribution this file has to read. */
const MESSAGES_CONTRIBUTION = /(?:^|[\s{,])messages:\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*[,\n]/;

/** A named import binding, so the identifier can be resolved back to the module that exports it. */
const NAMED_IMPORT = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g;

/** Where a capability's `messages` contribution comes from: an identifier, and the module exporting it. */
interface Contribution {
  /** The package directory under `packages/`. */
  package: string;
  /** The identifier the capability literal names. */
  identifier: string;
  /** The module specifier that identifier was imported from. */
  specifier: string;
}

/** The `messages:` identifier a capability source contributes, or `null` when it contributes none. */
function messagesIdentifier(source: string): string | null {
  return MESSAGES_CONTRIBUTION.exec(blankComments(source))?.[1] ?? null;
}

/** The module specifier `identifier` was imported from, or `null` when it was not imported at all. */
function importSpecifier(source: string, identifier: string): string | null {
  const code = blankComments(source);
  for (const match of code.matchAll(NAMED_IMPORT)) {
    const bindings = (match[1] ?? "").split(",").map((binding) => binding.trim());
    const named = bindings.some((binding) => {
      if (binding.startsWith("type ")) return false;
      const [, local] = /(?:^|\s+as\s+)([A-Za-z_$][A-Za-z0-9_$]*)$/.exec(binding) ?? [];
      return (local ?? binding) === identifier;
    });
    if (named) return match[2] ?? null;
  }
  return null;
}

/** The file a specifier resolves to, from the module that imported it. `null` when nothing is there. */
function resolveSpecifier(from: string, specifier: string): string | null {
  const base = specifier.startsWith(".")
    ? resolve(dirname(from), specifier)
    : specifier.startsWith("@pithy-sh/")
      ? join(PACKAGES, specifier.slice("@pithy-sh/".length))
      : null;
  if (base === null) return null;
  for (const candidate of [`${base}.ts`, join(base, "index.ts")]) if (existsSync(candidate)) return candidate;
  return null;
}

/**
 * Every capability package in the tree, and the `messages` contribution it declares, if any.
 *
 * `readdirSync` over `packages/` and one `existsSync` per candidate, exactly as
 * `project/capabilityVersions.test.ts` does it — not a recursive walk, so `./sourceFiles`'s one-walk
 * rule has nothing to say here and `node_modules` is never descended into.
 */
function contributions(): { packages: string[]; found: Contribution[] } {
  const packages: string[] = [];
  const found: Contribution[] = [];
  for (const dir of readdirSync(PACKAGES).sort()) {
    const file = capabilityFile(dir);
    if (!existsSync(file)) continue;
    packages.push(dir);
    const source = readSource(file);
    if (source === null) continue;
    const identifier = messagesIdentifier(source);
    if (identifier === null) continue;
    found.push({ package: dir, identifier, specifier: importSpecifier(source, identifier) ?? "" });
  }
  return { packages, found };
}

const CAPABILITIES = contributions();

/** One capability's contribution, once it has been loaded — or the reason it could not be. */
interface Loaded {
  /** The package directory under `packages/`. */
  package: string;
  /** The catalogs the module actually exports, Zod-validated as `LocaleCatalogs`. */
  catalogs: LocaleCatalogs;
}

/**
 * Every capability's contributed catalogs, read as the value the runtime reads.
 *
 * Loaded by dynamic import of the resolved module rather than by parsing its source: a catalog is a
 * value, and a gate that read the literal would be blind to a contribution assembled from three
 * objects — which is exactly how `@pithy-sh/email` builds its own.
 *
 * Problems are collected rather than thrown, because this runs at module scope where there is no test
 * to fail; the first case in the block below is what reports them.
 */
async function capabilityMessages(): Promise<{ loaded: Loaded[]; problems: string[] }> {
  const loaded: Loaded[] = [];
  const problems: string[] = [];
  for (const contribution of CAPABILITIES.found) {
    const file = resolveSpecifier(capabilityFile(contribution.package), contribution.specifier);
    if (file === null) {
      problems.push(
        `${contribution.package} contributes \`messages: ${contribution.identifier}\` and this gate cannot resolve the module it comes from.`,
      );
      continue;
    }
    const module = (await import(/* @vite-ignore */ pathToFileURL(file).href)) as Record<string, unknown>;
    const value = module[contribution.identifier];
    if (value === undefined) {
      problems.push(
        `${contribution.package} imports ${contribution.identifier} from a module that exports no such thing.`,
      );
      continue;
    }
    const parsed = LocaleCatalogs.safeParse(value);
    if (!parsed.success) {
      problems.push(`${contribution.package}'s ${contribution.identifier} is not a \`LocaleCatalogs\`.`);
      continue;
    }
    loaded.push({ package: contribution.package, catalogs: parsed.data });
  }
  return { loaded, problems };
}

const { loaded: CONTRIBUTED, problems: LOAD_PROBLEMS } = await capabilityMessages();

const SCREENS = screenKeys();

/** Every key a capability contributes in the kit's own language, with the package that wrote it. */
const CONTRIBUTED_EN = CONTRIBUTED.flatMap(({ package: name, catalogs }) =>
  Object.entries(catalogs.en ?? {}).map(([key, value]) => ({ package: name, key, value })),
);

/**
 * The failures a browser SDK mints for itself, as `{ key, value }` — the fourth place a kit sentence
 * lives, and the only one that never crosses a wire.
 *
 * `client/*` is the one domain with no capability behind it: `@pithy-sh/auth` and `@pithy-sh/payments`
 * each declare these as `const`s for the cases where the request never reached a Worker at all —
 * offline, a proxy's HTML page, no browser to redirect to. They are in neither the taxonomy (nothing
 * sends them) nor any `Capability.messages` (no capability owns the domain), so the three sources
 * above are all blind to them — and **offline is the commonest failure a screen renders**, which made
 * that blindness expensive rather than tidy.
 *
 * Read off the modules that declare them, so a fourth sentinel is a red build until it has a Spanish
 * sentence. Both SDKs mint `client/unreachable` and `client/unreadable` with different English nouns
 * ("the server", "the store"); one key holds one string, so the later one wins here and the catalog's
 * own comment argues why the Spanish names no noun at all.
 */
const SENTINELS: { key: string; value: string }[] = (
  [...Object.values(authClient), ...Object.values(paymentsClient)] as unknown[]
)
  .filter(
    (value): value is { code: string; message: string } =>
      typeof value === "object" &&
      value !== null &&
      typeof (value as { code?: unknown }).code === "string" &&
      typeof (value as { message?: unknown }).message === "string" &&
      (value as { code: string }).code.startsWith("client/"),
  )
  .map((failure) => ({ key: failure.code, value: failure.message }));

/** Every key the kit writes in its source language, from the four places one can live. */
const SOURCE_KEYS = [
  ...new Set([
    ...SCREENS.map(({ key }) => key),
    ...CONTRIBUTED_EN.map(({ key }) => key),
    ...SENTINELS.map(({ key }) => key),
    ...CODES,
  ]),
].sort();

/**
 * The English behind every key that has one — the screens and the capability contributions.
 *
 * An error code is absent on purpose: it has no English catalog, only a `message` on the payload, so
 * there is nothing to compare a placeholder against.
 */
const ENGLISH = new Map<string, string>([
  ...SCREENS.map(({ key, value }) => [key, value] as const),
  ...CONTRIBUTED_EN.map(({ key, value }) => [key, value] as const),
  ...SENTINELS.map(({ key, value }) => [key, value] as const),
]);

/** The locales that ship, and their keys — the map `@pithy-sh/i18n` actually composes into its layers. */
/**
 * Every locale the kit ships, and every sentence in it — **from both places a kit translation lives**.
 *
 * `@pithy-sh/i18n` holds what no capability can: the error taxonomy, whose domains are not capability
 * names, and the screens, which are copied into an adopter's repository rather than imported. A
 * capability holds its own domain, in every language it is written in — `@pithy-sh/email` carries its
 * `email/` Spanish beside its English, because the send Worker is a separate deploy that has to be
 * *built* with the words or else be sent them as configuration on every provision run (#442).
 *
 * Read as a union rather than from one of them, because which package a sentence lives in is a fact
 * about how it reaches a Worker, and this file is asking a different question: whether the sentence
 * exists at all. A gate that read only `KIT_CATALOGS` would report every email key as untranslated
 * the day one moved, which is exactly what it did.
 */
const SHIPPED = [
  ...new Set([
    ...Object.keys(KIT_CATALOGS),
    ...CONTRIBUTED.flatMap(({ catalogs }) => Object.keys(catalogs).filter((locale) => locale !== "en")),
  ]),
].map((locale) => {
  const merged: Record<string, string> = { ...(KIT_CATALOGS[locale] ?? {}) };
  for (const { catalogs } of CONTRIBUTED) Object.assign(merged, catalogs[locale] ?? {});
  return { locale, keys: Object.keys(merged), entries: Object.entries(merged) };
});

/** `{placeholder}`, spelled exactly as `interpolate` spells it. Anything between braces counts. */
const PLACEHOLDER = /\{([^}]*)\}/g;

/** The placeholder names one sentence interpolates, deduplicated and sorted. */
function placeholders(message: string): string[] {
  return [...new Set([...message.matchAll(PLACEHOLDER)].map((match) => match[1] as string))].sort();
}

describe("the catalogs cover what the kit says", () => {
  test("the derivation found all three sources, so every comparison below has something in it", () => {
    // The anti-vacuity guard, and it is five numbers rather than one because each source can fail to
    // arrive on its own: a moved template tree, a capability whose contribution no longer resolves, a
    // union that did not import. Floors rather than equalities for the ones that grow with ordinary
    // work — a screen gaining a line must not edit this file — and they are near-exact, measured at 71
    // screen keys and 51 contributed keys on 2026-08-23. The taxonomy is pinned exactly because it is
    // the one that must not grow quietly.
    expect(templateFiles().length).toBeGreaterThanOrEqual(14);
    expect(new Set(SCREENS.map(({ key }) => key)).size).toBeGreaterThanOrEqual(71);
    expect(CONTRIBUTED_EN.length).toBeGreaterThanOrEqual(51);
    expect(CODES).toHaveLength(KIT_ERROR_CODE_COUNT);
    expect(SOURCE_KEYS.length).toBeGreaterThanOrEqual(242);
  });

  test("at least one locale ships, and it is not empty", () => {
    // Otherwise the loops below iterate nothing and the file passes over a kit that ships no
    // translation at all — shape 8 of `sweepPopulation.test.ts`'s taxonomy, an anti-vacuity guard far
    // below the real population.
    expect(SHIPPED.length).toBeGreaterThanOrEqual(1);
    expect(SHIPPED.map(({ locale }) => locale)).toContain("es");
    for (const { locale, keys } of SHIPPED) expect(keys.length, locale).toBeGreaterThanOrEqual(242);
  });

  test("every key the kit writes in English is written in every locale it ships", () => {
    // The failure this file exists for. A capability lands a code, a screen gains a line, and the only
    // file that knows is one nobody edited.
    const missing = SHIPPED.map(({ locale, keys }) => {
      const covered = new Set(keys);
      return [locale, SOURCE_KEYS.filter((key) => !covered.has(key))] as const;
    }).filter(([, keys]) => keys.length > 0);
    expect(
      Object.fromEntries(missing),
      "A kit sentence has no translation. Add it to `packages/i18n/src/catalogs/<locale>/`, or beside the capability's own English.",
    ).toEqual({});
  });

  test("every kit error code has an entry in every locale, because for an error the key is the code", () => {
    // Stated apart from the sweep above even though the codes are inside `SOURCE_KEYS`, because the
    // reason is different and so is the fix. A screen key missing is a sentence nobody translated; a
    // code missing is a *caller* — someone else's mobile app — rendering our English at their reader.
    const missing = SHIPPED.map(({ locale, keys }) => {
      const covered = new Set(keys);
      return [locale, CODES.filter((code) => !covered.has(code))] as const;
    }).filter(([, codes]) => codes.length > 0);
    expect(Object.fromEntries(missing)).toEqual({});
  });

  test("no locale carries a key nothing renders", () => {
    // The reverse direction, and the one a typo lands in. `auth/sign_in.titel` in a Spanish catalog is
    // invisible forever: the lookup that would have found it never runs, and the reader gets the
    // English fallback that makes it look like a missing translation rather than a misspelled one.
    const known = new Set(SOURCE_KEYS);
    const stray = SHIPPED.map(({ locale, keys }) => [locale, keys.filter((key) => !known.has(key))] as const).filter(
      ([, keys]) => keys.length > 0,
    );
    expect(
      Object.fromEntries(stray),
      "A translated key answers nothing the kit writes. Check its spelling against the screen, the capability's `messages` or the error code.",
    ).toEqual({});
  });
});

describe("every capability that writes sentences is found, not remembered", () => {
  test("the sweep finds the capability packages at all", () => {
    // The guard over the derivation. A sweep that found no capability file would report no
    // contributions, and no contributions is what "nobody writes messages" looks like — which is
    // exactly the state this file's previous version was frozen in.
    expect(CAPABILITIES.packages.length).toBeGreaterThan(15);
    expect(CAPABILITIES.packages).toContain("email");
    expect(CAPABILITIES.packages).toContain("turnstile");
  });

  test("every contribution this sweep found could actually be loaded", () => {
    // A contribution the gate cannot read is a contribution the gate is not checking, and silence is
    // what that looked like before: the English set was simply smaller than the kit.
    expect(LOAD_PROBLEMS).toEqual([]);
  });

  test("and at least one of them contributes messages, loaded from the module it names", () => {
    expect(CONTRIBUTED.map(({ package: name }) => name)).toContain("email");
    expect(CONTRIBUTED.length).toBeGreaterThanOrEqual(1);
    for (const { package: name, catalogs } of CONTRIBUTED) {
      expect(Object.keys(catalogs.en ?? {}).length, name).toBeGreaterThan(0);
    }
  });

  test("the contribution reader finds a `messages:` and reads a capability without one as none", () => {
    // The gate over the gate. A reader that found nothing would make the English set the screens plus
    // the codes, which is what shipped — and the missing half is precisely the half nobody notices.
    expect(messagesIdentifier("defineCapability({ name: 'email', messages: EMAIL_MESSAGES, routes: [] })")).toBe(
      "EMAIL_MESSAGES",
    );
    expect(messagesIdentifier("defineCapability({\n  name: 'auth',\n  messages: AUTH_MESSAGES,\n})")).toBe(
      "AUTH_MESSAGES",
    );
    expect(messagesIdentifier("defineCapability({ name: 'turnstile' })")).toBeNull();
    // Not a contribution: reading a config's own catalogs back out is an index, not a declaration.
    expect(messagesIdentifier("const layers = [resolved.messages[locale], resolved.messages[fallback]];")).toBeNull();
    // And a docblock naming one is prose, not a declaration.
    expect(
      messagesIdentifier("/** Contributes `messages: FAKE_MESSAGES,` one day. */\nexport const x = 1;"),
    ).toBeNull();
  });

  test("the import reader resolves the identifier back to a module, and ignores a type-only binding", () => {
    const source = 'import { EMAIL_MESSAGES, type EmailLayers, kitLayers } from "./templates/messages";';
    expect(importSpecifier(source, "EMAIL_MESSAGES")).toBe("./templates/messages");
    expect(importSpecifier(source, "kitLayers")).toBe("./templates/messages");
    expect(importSpecifier(source, "EmailLayers")).toBeNull();
    expect(importSpecifier(source, "NOT_IMPORTED")).toBeNull();
    expect(importSpecifier('import { A as MESSAGES } from "./elsewhere";', "MESSAGES")).toBe("./elsewhere");
  });
});

describe("every key is namespaced to the domain that owns it", () => {
  test("every sentence the kit writes carries a capability's name, or `app`", () => {
    // The same rule as `pithy_<capability>_<table>` and `auth/invalid_token`, and `composeMessages`
    // already refuses a violation at assembly — but only for a key a *capability* contributes, and only
    // when a project composes it. A screen's baked catalog never reaches that check at all: it is
    // copied into the adopter's repository and read as a translator layer, not merged. So `payment/`
    // for `payments/` would ship, render as its own key on the screen, and fail nothing.
    //
    // The codes are checked separately, below, against a set that is not built from them.
    const written = [...SCREENS.map(({ key }) => key), ...CONTRIBUTED_EN.map(({ key }) => key)];
    const stray = [...new Set(written)].filter((key) => !CAPABILITY_DOMAINS.has(messageDomain(key)));
    expect(stray, `Known domains: ${[...CAPABILITY_DOMAINS].sort().join(", ")}.`).toEqual([]);
  });

  test("every error code's domain is a capability's name or one of the four the taxonomy owns", () => {
    const stray = CODES.filter((code) => !KIT_DOMAINS.has(messageDomain(code)));
    expect(stray, `Known domains: ${[...KIT_DOMAINS].sort().join(", ")}.`).toEqual([]);
  });

  test("and those four are exactly the taxonomy's own — a fifth is a diff somebody reads", () => {
    // The tripwire that keeps {@link ERROR_ONLY_DOMAINS} from rotting into a list nobody re-reads.
    // Equality rather than a subset: a domain that stops being thrown belongs out of the literal, and
    // a new one belongs in it deliberately rather than by a check that admitted it automatically.
    const beyond = [...new Set(CODES.map(messageDomain))].filter((domain) => !CAPABILITY_DOMAINS.has(domain)).sort();
    expect(beyond).toEqual([...ERROR_ONLY_DOMAINS].sort());
  });

  test("none of the four is a capability name, so each really is extra", () => {
    expect(ERROR_ONLY_DOMAINS.filter((domain) => CAPABILITY_DOMAINS.has(domain))).toEqual([]);
  });

  test("every locale's keys carry the same domains", () => {
    const stray = SHIPPED.flatMap(({ locale, keys }) =>
      keys.filter((key) => !KIT_DOMAINS.has(messageDomain(key))).map((key) => `${locale}: ${key}`),
    );
    expect(stray).toEqual([]);
  });

  test("every capability writes only under its own domain", () => {
    // `composeMessages` throws on this at assembly, which means a worker that will not start. This is
    // the cheap place to catch it, and — unlike the version of this test that named `email` — it is
    // asked of whichever capabilities contribute, including the ones that do not exist yet.
    const stray = CONTRIBUTED.flatMap(({ package: name, catalogs }) =>
      Object.values(catalogs).flatMap((catalog) =>
        Object.keys(catalog ?? {})
          .filter((key) => messageDomain(key) !== name)
          .map((key) => `${name}: ${key}`),
      ),
    );
    expect(stray).toEqual([]);
  });

  test("every key is spellable as a `MessageKey`", () => {
    // No exception any more. `core` widened the domain segment to admit `_` so `rate_limit/exceeded`
    // — a code since long before the catalog grammar existed — is a key an adopter can override.
    const unspellable = [...SOURCE_KEYS, ...SHIPPED.flatMap(({ keys }) => keys)].filter(
      (key) => !MessageKey.safeParse(key).success,
    );
    expect([...new Set(unspellable)]).toEqual([]);
  });
});

describe("a translated sentence interpolates what its English does", () => {
  test("every locale's placeholders match the English, name for name", () => {
    // A placeholder is a contract with the throw site or the screen that renders the key. `{count}`
    // written as `{cuenta}` in Spanish renders the braces at the reader, permanently: `interpolate`
    // leaves an unsupplied placeholder as written, and no lookup fails, so nothing anywhere says so.
    // Both directions in one comparison — a Spanish sentence that dropped `{email}` is a reader who
    // is never told which address the code went to.
    const drifted: string[] = [];
    for (const { locale, entries } of SHIPPED) {
      for (const [key, message] of entries) {
        const english = ENGLISH.get(key);
        if (english === undefined) continue;
        const source = placeholders(english);
        const translated = placeholders(message);
        if (source.join(",") !== translated.join(",")) {
          drifted.push(`${locale} ${key}: English {${source.join(", ")}} against {${translated.join(", ")}}`);
        }
      }
    }
    expect(drifted, "A translation interpolates a different set of parameters than its English.").toEqual([]);
  });

  test("the English side really has values and really has placeholders", () => {
    // Without this the comparison above is over an empty map, which is what a regex that stopped
    // capturing values would leave — and an empty map is indistinguishable from perfect agreement.
    expect(ENGLISH.size).toBeGreaterThanOrEqual(122);
    expect([...ENGLISH.values()].filter((value) => value.includes("{")).length).toBeGreaterThanOrEqual(30);
  });
});

describe("the reader that finds the baked catalogs", () => {
  test("reads a satisfies-annotated block, and reads a plain object as none", () => {
    // The gate over the gate. A reader that found nothing would make every assertion above vacuous for
    // the screens — 71 of the 242 keys — and the sweep would still pass, loudly.
    expect(bakedCatalogKeys('const EN = { "auth/sign_in.title": "Welcome." } satisfies MessageCatalog;')).toEqual([
      "auth/sign_in.title",
    ]);
    expect(bakedCatalogKeys('const SOCIAL = { "auth/sign_in.title": "Welcome." };')).toEqual([]);
  });

  test("reads the sentence as well as the key, which is what the placeholder check compares", () => {
    expect(
      bakedCatalogEntries('const EN = { "auth/otp.sent": "We sent {count} to {email}." } satisfies MessageCatalog;'),
    ).toEqual([{ key: "auth/otp.sent", value: "We sent {count} to {email}." }]);
  });

  test("does not read a key out of prose", () => {
    // This file's own docblock names `auth/sign_in.title` twice. A reader that took keys from comments
    // would add them to the expected set from the very sentence explaining why it must not.
    expect(bakedCatalogKeys('// const EN = { "auth/nope": "x" } satisfies MessageCatalog;')).toEqual([]);
    expect(bakedCatalogKeys('/* const EN = { "auth/nope": "x" } satisfies MessageCatalog; ')).toEqual([]);
  });

  test("finds every screen catalog in the real tree", () => {
    // Nine templates bake one. The number is the shape of the screen set — sign-in, otp, callback,
    // paywall, pricing, subscription, the router, and the two home screens — so a template that loses
    // its catalog to a refactor is a failure here rather than a screen that renders its keys.
    const withCatalog = templateFiles().filter((file) => bakedCatalogKeys(readSource(file) ?? "").length > 0);
    expect(withCatalog.length).toBeGreaterThanOrEqual(9);
  });
});
