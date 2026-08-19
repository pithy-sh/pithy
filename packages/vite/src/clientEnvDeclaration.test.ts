// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { auth } from "@pithy-sh/auth/src/capability";
import { resolveClientProjection } from "@pithy-sh/core/src/capability/client";
import { payments } from "@pithy-sh/payments/src/capability";
import { support } from "@pithy-sh/support/src/capability";
import { turnstile } from "@pithy-sh/turnstile/src/capability";
import { TEMPLATE_DIR } from "@pithy-sh/ui-react/src/templates";
import { describe, expect, test } from "vitest";
import {
  DECLARED_MODULES,
  generateClientEnv,
  inlineAliases,
  parseTypeAliases,
  readProjectionSources,
  renderClientEnv,
} from "./clientEnvDeclaration";
import { renderVirtualModule } from "./virtualModule";

/**
 * **The declaration an adopter is given is emitted from the four declared projections (#398).**
 *
 * #392 held `templates/client-env.d.ts` against those projections with a spawned compiler, because the
 * file was hand-written and there was no faithful source to generate it from. #395 supplied one: the
 * four capabilities declare their projection types, each `client:` closure is checked against its own
 * declaration in its own package, and the declaration is the source of truth. So the file is generated
 * now, and **a gate that watches two things agree has been replaced by there being one thing.**
 *
 * What is left to check is not agreement, and this file is careful about the difference:
 *
 * - **The committed artifact is the current emit.** Not a second statement of the shape — a derived
 *   file that has gone stale, which is the only failure generation can still have.
 * - **The emit follows its input.** Every case below plants a projection this repository does not
 *   contain and reads what came out. A generator asserted only against the real sources would pass
 *   just as well if it ignored them and printed a constant.
 * - **The fixed text is fixed.** The preamble and the single `enabled` export are policy, not shape,
 *   and the check is that they survive rather than that they match something.
 * - **The one named export is one the plugin emits.** Carried over from #392's gate, because it is the
 *   half that is *not* true by construction: `export const enabled` is written by this generator, and
 *   `renderVirtualModule` decides separately whether such an export exists.
 *
 * The emitted file is compiled, and not here: it is in `@pithy-sh/ui-react`'s `tsconfig.templates.json`
 * alongside the screens that import `virtual:pithy/*` and read through it, so a declaration that does
 * not parse or does not admit what a screen does is that package's typecheck failing.
 */

/** The artifact — the file `pithy ui add react` copies into an adopter's Worker. */
const DECLARATION = join(TEMPLATE_DIR, "client-env.d.ts");

/**
 * A projection this repository does not contain, so nothing here can pass by reading the real one.
 *
 * It is a whole module's worth on purpose: a union with both arms, a nested object, a string-literal
 * union, a `| null` arm, an array of a *named* sibling alias, a doc comment at every depth, and — the
 * two things a naive scanner gets wrong — a brace inside a template literal and a type name inside an
 * `{@link}` tag, neither of which is code.
 */
const PLANTED = `// SPDX-FileCopyrightText: 2026 Pithy

/** An element of {@link WidgetClientProjection}'s list. Mentioned in prose, not referenced here. */
export type WidgetClientPart = {
  /** What the part is called. */
  label: string;
  /** Where it is fetched from, or null when it is inert. */
  href: string | null;
};

/**
 * A planted projection. {@link WidgetClientPart} is named above and inlined below.
 *
 * The route is \`POST {basePath}/widget\` — braces in a template literal, which is text and not a
 * bracket the alias scanner may count.
 */
export type WidgetClientProjection =
  | {
      /** Widgets are not composed. */
      enabled: false;
    }
  | {
      /** Widgets are composed. */
      enabled: true;
      /** How the widget is presented. */
      mode: "compact" | "full";
      /** The parts, in order. */
      parts: WidgetClientPart[];
      /** The frame, or null when it renders inline. */
      frame: {
        /** How wide, in pixels. */
        width: number;
      } | null;
    };
`;

/** The planted module, rendered on its own. One entry, so the assertions are about one block. */
function plant(source: string, type = "WidgetClientProjection"): string {
  return renderClientEnv(new Map([["widget", source]]), [{ module: "widget", specifier: "planted", type }]);
}

/** The declared type each module is emitted from, by module. */
const DECLARED_BY_MODULE = new Map(DECLARED_MODULES.map((declared) => [declared.module, declared]));

describe("client-env.d.ts is emitted from the declared projections", () => {
  test("the committed declaration is what the generator emits today", async () => {
    // The one failure generation still has: a projection moved and nobody ran `bun run generate`.
    // There is nothing else to compare — the shape below is stated once, in the capability.
    const committed = await readFile(DECLARATION, "utf8");
    expect(committed).toBe(await generateClientEnv());
  });

  test("every declared module is emitted, and nothing else is", async () => {
    const emitted = await generateClientEnv();
    const declared = [...emitted.matchAll(/declare module "virtual:pithy\/([^"]+)"/g)].map((match) => match[1] ?? "");
    expect(declared).toEqual(DECLARED_MODULES.map((entry) => entry.module));
  });

  test("`enabled` is the only named export, and it is one the plugin actually emits", async () => {
    // Two claims, and the second is the one that is not true by construction. `renderVirtualModule`
    // skips a key that is not a legal binding name, so a declared named export is not automatically a
    // rendered one — and `export const enabled: boolean` is written by the generator as fixed text,
    // which is exactly the kind of promise that can outlive the thing it promises.
    const emitted = await generateClientEnv();
    const blocks = emitted.split(/declare module "virtual:pithy\//).slice(1);
    expect(blocks.length).toBe(DECLARED_MODULES.length);
    const projections = [
      resolveClientProjection(auth({ baseURL: "https://api.example.com" }), { environment: "prod" }),
      resolveClientProjection(
        payments({
          billingSubject: "user",
          rails: { stripe: true },
          stripe: {
            successUrl: "https://acme.example/thanks",
            cancelUrl: "https://acme.example/pricing",
            portalReturnUrl: "https://acme.example/account",
          },
          products: { pro: { type: "subscription", name: "Pro", entitlements: ["pro"], stripe: { priceId: "p_1" } } },
        }),
        { environment: "prod" },
      ),
      resolveClientProjection(support({ inboundAddresses: ["help@acme.example"] }), { environment: "prod" }),
      resolveClientProjection(turnstile({ protect: {} }), { environment: "prod" }),
    ];
    let named = 0;
    for (const [index, block] of blocks.entries()) {
      const exports = [...block.matchAll(/export const (\w+):/g)].map((match) => match[1] ?? "");
      expect(exports, "a second named export would make an absent capability a build error").toEqual(["enabled"]);
      named += exports.length;
      expect(renderVirtualModule(projections[index] ?? { enabled: false })).toContain("export const enabled = ");
    }
    // A sweep that matched nothing would read the same as a file that promised nothing.
    expect(named).toBe(4);
  });

  test("the fixed text is written, not derived", async () => {
    const emitted = await generateClientEnv();
    // Item one: the reference the adopter's client program needs, and it must be the first line.
    expect(emitted.startsWith('/// <reference types="vite/client" />\n')).toBe(true);
    // Item two: the prose explaining why the default export is a union, which no projection states.
    expect(emitted).toContain("union discriminated on `enabled`");
    // And the file says of itself that it is generated, so a reader who lands here is not misled.
    expect(emitted).toContain("Generated");
    // None of it is in any projection — otherwise "fixed text" would be a description of an accident.
    for (const source of (await readProjectionSources()).values()) {
      expect(source).not.toContain("vite/client");
      expect(source).not.toContain("export const enabled: boolean");
    }
  });
});

describe("the emit follows its input", () => {
  // Proof of reach. Every case plants a projection and reads the output — the direction that would stay
  // green against a generator that ignored its sources, and the direction that matters, because the
  // declaration going stale is `undefined` in somebody's browser.

  test("a planted shape reaches the declaration whole — unions, `| null`, and the nested alias", () => {
    const emitted = plant(PLANTED);
    expect(emitted).toContain('mode: "compact" | "full";');
    expect(emitted).toContain("} | null;");
    // The sibling alias is inlined where it was referenced, not named — an adopter has no import to
    // resolve `WidgetClientPart` with.
    expect(emitted).not.toContain("WidgetClientPart[]");
    expect(emitted).toContain("parts: {");
    expect(emitted).toContain("href: string | null;");
  });

  test("a doc comment at every depth reaches the declaration", () => {
    const emitted = plant(PLANTED);
    for (const line of [
      "/** Widgets are not composed. */",
      "/** How the widget is presented. */",
      "/** The parts, in order. */",
      "/** What the part is called. */",
      "/** Where it is fetched from, or null when it is inert. */",
      "/** How wide, in pixels. */",
    ]) {
      expect(emitted, `${line} was written on a projection and did not survive the emit`).toContain(line);
    }
  });

  test("a field a projection stops declaring leaves the declaration", () => {
    const dropped = PLANTED.replace("      /** The parts, in order. */\n      parts: WidgetClientPart[];\n", "");
    expect(dropped).not.toBe(PLANTED);
    expect(plant(dropped)).not.toContain("parts:");
    // And the rest is still there, so this is a field leaving rather than the generator failing over.
    expect(plant(dropped)).toContain('mode: "compact" | "full";');
  });

  test("a field a projection starts declaring joins the declaration", () => {
    const grown = PLANTED.replace(
      "      /** The parts, in order. */",
      "      /** A telemetry key nobody decided to publish. */\n      beacon: string;\n      /** The parts, in order. */",
    );
    expect(grown).not.toBe(PLANTED);
    expect(plant(grown)).toContain("beacon: string;");
  });

  test("a union a projection narrows is narrowed in the declaration", () => {
    // The `paddle.checkout` case, in miniature: the real widening from `string` to a three-arm union is
    // the one intended difference between the hand-written file and the emitted one.
    const narrowed = PLANTED.replace('      mode: "compact" | "full";', '      mode: "compact";');
    expect(plant(narrowed)).toContain('mode: "compact";');
    expect(plant(narrowed)).not.toContain('"compact" | "full"');
  });

  test("the top-level prose about a type stays behind — only the shape is emitted", () => {
    // The alias's own JSDoc explains the declaration to whoever maintains the capability. It is not
    // what a browser needs, and copying it would put "#395 measured…" in somebody else's repository.
    expect(plant(PLANTED)).not.toContain("A planted projection");
  });

  test("the real doc comments survive the real emit, every one of them", async () => {
    // The planted cases prove the mechanism; this proves it over the four projections actually shipped.
    // A comment count rather than a list, because a list here would be this file restating the file.
    const emitted = await generateClientEnv();
    for (const [module, source] of await readProjectionSources()) {
      const declared = DECLARED_BY_MODULE.get(module);
      const body = parseTypeAliases(source).get(declared?.type ?? "") ?? "";
      expect(body, `no declared type for virtual:pithy/${module}`).not.toBe("");
      const inlined = inlineAliases(body, parseTypeAliases(source));
      const comments = inlined.match(/\/\*\*/g)?.length ?? 0;
      expect(comments, `virtual:pithy/${module} declares no doc comments to lose`).toBeGreaterThan(3);
      const block = emitted.split(`declare module "virtual:pithy/${module}" {`)[1]?.split("\ndeclare module")[0] ?? "";
      // One more in the emitted block than in the type: the fixed `enabled` export carries its own.
      expect(block.match(/\/\*\*/g)?.length ?? 0, `doc comments were lost emitting ${module}`).toBe(comments + 1);
    }
  });
});

describe("the scanner is not fooled, and says so when it cannot finish", () => {
  test("a brace in a template literal is text, not a bracket", () => {
    // `POST {basePath}/feedback` is in the real support projection, and counting its braces would end
    // the alias in the wrong place — silently, with a declaration that still parses.
    const aliases = parseTypeAliases(PLANTED);
    expect([...aliases.keys()]).toEqual(["WidgetClientPart", "WidgetClientProjection"]);
    expect(aliases.get("WidgetClientProjection")).toContain("frame: {");
  });

  test("a type name inside a doc comment is prose, not a reference", () => {
    // `{@link WidgetClientProjection}` sits in WidgetClientPart's own JSDoc, above the type body.
    // Inlining it would be an infinite regress; treating it as prose is the whole of the fix.
    expect(() => plant(PLANTED)).not.toThrow();
  });

  test("an alias that refers to itself is refused rather than expanded forever", () => {
    const looping =
      "export type Part = { child: Part | null };\nexport type WidgetClientProjection = { root: Part };\n";
    expect(() => plant(looping)).toThrow(/refers to itself/);
  });

  test("an alias that is never closed is refused rather than truncated", () => {
    expect(() => parseTypeAliases("export type Broken = {\n  a: string;\n")).toThrow(/never closed/);
  });

  test("a module whose declared type is missing is refused by name", () => {
    expect(() => plant("export type Other = { a: string };\n")).toThrow(/WidgetClientProjection/);
  });

  test("a module with no source at all is refused by name", () => {
    expect(() => renderClientEnv(new Map())).toThrow(/virtual:pithy\/auth/);
  });
});
