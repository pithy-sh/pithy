// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { KitErrorPayload } from "@pithy-sh/core/src/error/payload";
import { describe, expect, test } from "vitest";
import { hasKitCatalog, loadKitCatalog } from "./browser";
import { KIT_CATALOGS } from "./kit";

/**
 * The browser's per-locale loaders, against the server's static map.
 *
 * **Two maps of the same thing is the defect this file exists for.** `KIT_CATALOGS` is what a Worker
 * imports statically; `LOADERS` next door is what a page imports dynamically, one Rollup chunk per
 * locale, so a reader downloads only their own language. They are written out separately because a
 * computed specifier is a specifier no bundler can split — and two hand-written maps drift. A locale
 * added to one and not the other ships to a Worker and not to a browser, or the reverse, and until
 * #441's verification pass nothing anywhere compared them: `loadKitCatalog` gutted to return `{}` for
 * every locale passed all 130 tests in this package.
 */

describe("the two maps agree", () => {
  test("every locale the kit ships has a browser loader", () => {
    // The drift that matters. Adding `fr` to `KIT_CATALOGS` and not to `LOADERS` is a Spanish-shaped
    // hole: correct on the server, English in the browser, and nothing says so.
    const missing = Object.keys(KIT_CATALOGS).filter((locale) => !hasKitCatalog(locale));
    expect(missing, "Add a loader to `catalogs/browser.ts` for each locale in `KIT_CATALOGS`.").toEqual([]);
  });

  test("and the kit ships at least one, so that comparison is not two empty sets", () => {
    expect(Object.keys(KIT_CATALOGS)).toContain("es");
    expect(Object.keys(KIT_CATALOGS).length).toBeGreaterThanOrEqual(1);
  });

  test("a loader answers with exactly the catalog the server holds", async () => {
    for (const [locale, catalog] of Object.entries(KIT_CATALOGS)) {
      expect(await loadKitCatalog(locale), locale).toEqual(catalog);
    }
  });
});

describe("English is absent on purpose", () => {
  test("`hasKitCatalog` says so", () => {
    // A copied screen already carries the English it was scaffolded with, and that is the only catalog
    // that survives being copied. A second copy here is a second place for one sentence to drift.
    expect(hasKitCatalog("en")).toBe(false);
  });

  test("and loading it is an empty catalog rather than a throw", async () => {
    // A reader in the default locale takes this path on every visit, so it is the common case rather
    // than an error one.
    await expect(loadKitCatalog("en")).resolves.toEqual({});
  });
});

describe("a locale the kit does not write", () => {
  test("`hasKitCatalog` is false and loading it is empty", async () => {
    expect(hasKitCatalog("fr")).toBe(false);
    expect(await loadKitCatalog("fr")).toEqual({});
  });

  test("nothing a reader can send reaches an import", async () => {
    // The loaders are a static map keyed by string, so a hostile tag is a missing key rather than a
    // specifier. It is worth stating: a computed `import()` here is exactly the shape that would not be.
    for (const hostile of ["../es/index", "es/index", "./es/index", "__proto__", "constructor"]) {
      expect(hasKitCatalog(hostile), hostile).toBe(false);
      expect(await loadKitCatalog(hostile), hostile).toEqual({});
    }
  });
});

describe("what the Spanish catalog actually carries", () => {
  test("real sentences, from both of the files it is assembled from", async () => {
    // The anti-vacuity guard for every case above: `toEqual` between two references to one gutted
    // object passes perfectly. These are keys from `errors.ts` and `screens.ts` in turn.
    const es = await loadKitCatalog("es");
    expect(Object.keys(es).length).toBeGreaterThanOrEqual(185);
    expect(es["core/not_found"]).toBeTypeOf("string");
    expect(es["auth/sign_in.title"]).toBeTypeOf("string");
  });

  test("and no email template copy, because a browser is not what renders a letter", () => {
    // The email *copy* moved to `@pithy-sh/email` in #442, so the send Worker is built with it rather
    // than sent it. Nothing in a browser renders an email, so its absence here costs a reader nothing
    // — and its presence was ~3 KB in every language chunk a reader downloads.
    //
    // The `email/*` **error codes** stay, and the distinction is the point: for an error the key is the
    // code, the taxonomy has no capability home, and a browser really does render one when a send is
    // refused. Written as "everything under the domain that is not a code", so a seventh code arrives
    // without editing this.
    const codes = new Set<string>(KitErrorPayload.options.map((member) => member.shape.code.value));
    const shipped = Object.keys(KIT_CATALOGS.es ?? {});
    expect(shipped.filter((key) => key.startsWith("email/") && !codes.has(key))).toEqual([]);
    // And the codes really are still here, or the filter above is passing over an empty set.
    expect(shipped.filter((key) => key.startsWith("email/") && codes.has(key)).length).toBeGreaterThanOrEqual(6);
  });
});
