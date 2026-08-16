// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { auth } from "@pithy-sh/auth/src/capability";
import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { type ClientProjection, resolveClientProjection } from "@pithy-sh/core/src/capability/client";
import { payments } from "@pithy-sh/payments/src/capability";
import { support } from "@pithy-sh/support/src/capability";
import { turnstile } from "@pithy-sh/turnstile/src/capability";
import { TEMPLATE_DIR } from "@pithy-sh/ui-react/src/templates";
import { afterAll, describe, expect, test } from "vitest";
import { renderVirtualModule } from "./virtualModule";

/**
 * **The one file in the kit that is its own type, gated against the values it describes (#392).**
 *
 * `@pithy-sh/ui-react`'s `templates/client-env.d.ts` is 144 lines of ambient declarations for the four
 * `virtual:pithy/*` modules. It is hand-written, it is copied into an adopter's Worker by
 * `pithy ui add react`, and until this file nothing compared it to anything. The producers are each
 * capability's `client:` projection, resolved by `resolveClientProjection` and rendered by
 * {@link renderVirtualModule} — three packages away, with no edge between them.
 *
 * **Because the declaration *is* the type, the compiler is structurally incapable of noticing a drift.**
 * A field a projection stops emitting still typechecks everywhere in the adopter's app: the declaration
 * says it exists. It is `undefined` at runtime, in production, in a browser, and nothing between here and
 * there goes red. The direction that hurts is *removal*, and it is exactly the direction a substring
 * assertion — "the file contains `otpLength: number;`" — cannot see, because the file still contains it.
 *
 * ## How this is checked, and why it is not a second statement of the shape
 *
 * The expectation is never written down. Every case below is a **real capability**, resolved through the
 * **real `resolveClientProjection`**, rendered by the **real `renderVirtualModule`** — so the text
 * checked against the declaration is byte-for-byte the text the plugin inlines into the bundle. That
 * literal is then assigned to the declared type in a throwaway TypeScript program, and `tsc` is the
 * comparator. Nothing here restates a field name, a type, or a key set.
 *
 * `Extract<typeof declared, { enabled: … }>` narrows the declared union to the branch the projection is
 * in before the assignment. That is what makes the check **exact in both directions**: a fresh object
 * literal assigned to a single object type is missing-property-checked *and* excess-property-checked, so
 * a field the projection dropped and a field it grew are both compile errors. Against the bare union
 * neither is guaranteed.
 *
 * ## Reach
 *
 * The mutation suites below are the proof that the gate reaches as far as the declaration does. Every
 * key at every depth of every real projection is dropped, added beside, and retyped — one throwaway
 * module each, all in one compiler run — and **every one must be red**. A declared property that is
 * optional, or a branch this file never exercises, shows up there as a mutation that stayed green.
 *
 * ## Why it is not generated instead
 *
 * Generating the declaration is the better shape and `#366` is the precedent, but it needs a faithful
 * source and there is not one yet: `Capability.client` is typed `(context) => ClientProjection`, which is
 * `{ enabled: boolean }` plus a JSON catchall, so every capability's real shape exists only as an
 * inferred object literal inside a closure and is erased at the interface. The only source in reach is
 * the projected *values*, and a type inferred from a value is strictly weaker than the file it would
 * replace — `"visible" | "invisible"`, `"sandbox" | "production"`, `paddle: … | null`, `token.header`,
 * `submission.attachments` and the product element type all collapse to whichever branch one sample
 * config happened to take, and every doc comment is lost. A generated file that types less than the
 * hand-written one is not a fix. The blocker is **not** a build step: the kit would generate at its own
 * build time and commit the artifact, so an adopter would still scaffold a static `.d.ts` and needs no
 * new step either way. Generation becomes available — and preferable — the day the four capabilities
 * annotate their `client` projections with declared types, which is a change to those packages rather
 * than to this seam.
 */

const run = promisify(execFile);

/** The declaration under test — the file `pithy ui add react` copies into an adopter's Worker. */
const DECLARATION = join(TEMPLATE_DIR, "client-env.d.ts");

/** The installed compiler, resolved from the package rather than a guessed `node_modules` path. */
const TSC = fileURLToPath(new URL("bin/tsc", import.meta.resolve("typescript/package.json")));

/** The installed vite package — the declaration opens by referencing its client types. */
const VITE_DIR = fileURLToPath(new URL(".", import.meta.resolve("vite/package.json")));

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

/** One real projection, and which branch of its declared union must accept it. */
interface Projected {
  /** The module this case gets in the check program — what a compiler error is attributed to. */
  readonly id: string;
  /** The capability, and so the `virtual:pithy/<module>` its declaration lives under. */
  readonly module: string;
  /** The projection, exactly as the capability produced it. */
  readonly projection: ClientProjection;
}

/** Resolve a capability's projection the way the plugin does — or an absent capability's, which is also real. */
function projected(id: string, module: string, capability: Capability | undefined, environment = "prod"): Projected {
  return { id, module, projection: resolveClientProjection(capability, { environment }) };
}

/** Cloudflare's documented test sitekeys, per environment. Public by design — that is what a sitekey is. */
const SITEKEYS = { dev: "1x00000000000000000000AA", staging: "1x00000000000000000000AA", prod: "0x4AAAAAAA_prod" };

/** A catalog that reaches every branch of the payments projection: all five rails, and a product on each. */
const FULL_CATALOG = {
  rails: { apple: true, google: true, stripe: true, lemonSqueezy: true, paddle: true },
  stripe: {
    successUrl: "https://acme.example/thanks?session={CHECKOUT_SESSION_ID}",
    cancelUrl: "https://acme.example/pricing",
    portalReturnUrl: "https://acme.example/account",
  },
  lemonSqueezy: { successUrl: "https://acme.example/thanks" },
  paddle: {
    clientToken: "test_pithy392",
    environment: "sandbox" as const,
    checkout: "inline" as const,
    successUrl: "https://acme.example/thanks",
  },
  products: {
    pro_monthly: {
      type: "subscription" as const,
      name: "Pro",
      entitlements: ["pro"],
      stripe: { priceId: "price_1Abc" },
      lemonSqueezy: { variantId: "123456" },
      paddle: { priceId: "pri_01hv8w" },
    },
    remove_ads: {
      type: "non_consumable" as const,
      name: "Remove ads",
      entitlements: ["ads_removed"],
      apple: { productId: "com.acme.removeads" },
    },
    coin_pack: {
      type: "consumable" as const,
      name: "Coin pack",
      // No entitlements, so the projected array is empty — a shape a catalog of one product never shows.
      // What it grants is a ledger balance, and that stays server-side: a currency and an amount describe
      // the economy.
      entitlements: [],
      grants: { ledger: { currency: "coins", amount: 4242 } },
      google: { productId: "acme.coin.pack.v1" },
    },
  },
};

/** One web rail and nothing else — the branch where `paddle` is null and two of the three SKUs are too. */
const STRIPE_ONLY = {
  rails: { stripe: true },
  stripe: {
    successUrl: "https://acme.example/thanks?session={CHECKOUT_SESSION_ID}",
    cancelUrl: "https://acme.example/pricing",
    portalReturnUrl: "https://acme.example/account",
  },
  products: {
    pro_monthly: {
      type: "subscription" as const,
      name: "Pro",
      entitlements: ["pro"],
      stripe: { priceId: "price_1Abc" },
    },
  },
};

/** The address support claims out of the Worker's inbound entry. Required, and the same in every case. */
const INBOUND = ["help@acme.example"];

/**
 * Every projection the four capabilities can produce, in every shape the declaration has a branch for.
 *
 * **Both sides of every internal union are here on purpose.** A suite that only ever built the maximal
 * config would leave `paddle: null`, `token.header: null`, `submission.attachments: null`, the
 * `invisible` widget mode and the whole `{ enabled: false }` branch unchecked — which is most of what
 * the declaration says. The absent-capability cases are as real as the rest: `resolveClientProjection`
 * answers `{ enabled: false }` for a capability nobody composed, and that is the answer a bare scaffold
 * gets from three of these four modules.
 */
const CASES: readonly Projected[] = [
  projected(
    "auth-full",
    "auth",
    auth({
      baseURL: "https://api.example.com",
      basePath: "/identity",
      google: { enabled: true },
      apple: { enabled: true },
      facebook: { enabled: true },
      github: { enabled: true },
      otpLength: 8,
    }),
  ),
  projected("auth-bare", "auth", auth({ baseURL: "https://api.example.com", disableSignUp: true })),
  projected("auth-absent", "auth", undefined),
  projected("payments-full", "payments", payments(FULL_CATALOG)),
  projected("payments-stripe-only", "payments", payments(STRIPE_ONLY)),
  projected("payments-empty-catalog", "payments", payments({})),
  projected("payments-absent", "payments", undefined),
  projected("support-full", "support", support({ inboundAddresses: INBOUND })),
  projected(
    "support-no-attachments",
    "support",
    support({ inboundAddresses: INBOUND, submission: { attachments: { enabled: false } } }),
  ),
  projected("support-off", "support", support({ inboundAddresses: INBOUND, submission: { enabled: false } })),
  projected("support-absent", "support", undefined),
  projected(
    "turnstile-visible",
    "turnstile",
    turnstile({
      widgets: { visible: { sitekeys: SITEKEYS } },
      token: { field: "pithy-humanity", header: "X-Pithy-Humanity" },
    }),
  ),
  projected(
    "turnstile-invisible",
    "turnstile",
    turnstile({ widgets: { invisible: { sitekeys: SITEKEYS } }, protect: { login: "invisible" } }),
  ),
  projected("turnstile-unprotected", "turnstile", turnstile({ protect: {} })),
  projected("turnstile-absent", "turnstile", undefined),
];

/** The default export of a rendered virtual module — the literal the plugin inlines into the bundle. */
const DEFAULT_EXPORT = /^export default (.+);$/m;

/**
 * The projection as the browser receives it: the exact text {@link renderVirtualModule} writes, not a
 * re-serialization of the value beside it. If the renderer ever stops emitting a default export literal
 * this throws rather than quietly checking something else.
 */
function inlined(projection: ClientProjection): string {
  const match = DEFAULT_EXPORT.exec(renderVirtualModule(projection));
  const literal = match?.[1];
  if (!literal) throw new Error("renderVirtualModule no longer emits `export default <literal>;`.");
  return literal;
}

/**
 * One throwaway module: import the declared type, narrow it to the branch this projection is in, and
 * assign the projection's own literal to it. A fresh object literal against a single object type is
 * checked in both directions at once.
 */
function checkModule(entry: Projected, literal: string, enabled: boolean): string {
  return [
    `import declared from "virtual:pithy/${entry.module}";`,
    `type Branch = Extract<typeof declared, { enabled: ${enabled} }>;`,
    `export const projected: Branch = ${literal};`,
    "",
  ].join("\n");
}

/** Compile a set of named modules against the real declaration. One process, however many modules. */
async function typecheck(modules: Record<string, string>): Promise<{ ok: boolean; output: string }> {
  const dir = await mkdtemp(join(tmpdir(), "pithy-392-"));
  dirs.push(dir);
  // The declaration opens with `/// <reference types="vite/client" />`, so the throwaway project is laid
  // out the way an adopter's is: vite where a bare specifier finds it.
  await mkdir(join(dir, "node_modules"), { recursive: true });
  await symlink(VITE_DIR, join(dir, "node_modules", "vite"), "dir");
  const names = Object.keys(modules);
  await Promise.all(names.map((name) => writeFile(join(dir, `${name}.ts`), modules[name] ?? "")));
  await writeFile(
    join(dir, "tsconfig.json"),
    // The options `@pithy-sh/ui-react`'s `tsconfig.templates.json` compiles the templates under, minus
    // JSX: these modules are not screens. The declaration is named by absolute path so what is checked
    // is the file on disk, never a copy of it.
    `${JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          lib: ["ES2022", "DOM", "DOM.Iterable"],
          module: "ESNext",
          moduleResolution: "Bundler",
          moduleDetection: "force",
          verbatimModuleSyntax: true,
          isolatedModules: true,
          strict: true,
          noUncheckedIndexedAccess: true,
          skipLibCheck: true,
          noEmit: true,
        },
        files: [DECLARATION, ...names.map((name) => `${name}.ts`)],
      },
      null,
      2,
    )}\n`,
  );
  try {
    await run(TSC, ["-p", "tsconfig.json"], { cwd: dir, maxBuffer: 32 * 1024 * 1024 });
    return { ok: true, output: "" };
  } catch (error) {
    const failed = error as { stdout?: string; stderr?: string };
    return { ok: false, output: `${failed.stdout ?? ""}${failed.stderr ?? ""}` };
  }
}

/** A plain JSON object — the only thing a field can hang off, and the only thing a field can be added to. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Every **field** path in a projection, at every depth, and every **object** in it including array elements. */
function survey(projection: ClientProjection): { fields: string[]; objects: string[] } {
  const fields: string[] = [];
  const objects: string[] = [""];
  const descend = (value: unknown, path: string): void => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        const at = `${path}.${index}`;
        if (isRecord(item)) objects.push(at);
        descend(item, at);
      });
      return;
    }
    if (!isRecord(value)) return;
    for (const [key, nested] of Object.entries(value)) {
      const at = path ? `${path}.${key}` : key;
      fields.push(at);
      if (isRecord(nested)) objects.push(at);
      descend(nested, at);
    }
  };
  descend(projection, "");
  return { fields, objects };
}

/** A deep copy with one path rewritten by `edit`. Returning `undefined` deletes the field. */
function rewrite(projection: ClientProjection, path: string, edit: (value: unknown) => unknown): unknown {
  const copy: unknown = JSON.parse(JSON.stringify(projection));
  if (path === "") return edit(copy);
  const segments = path.split(".");
  let cursor: Record<string, unknown> = copy as Record<string, unknown>;
  for (const segment of segments.slice(0, -1)) cursor = cursor[segment] as Record<string, unknown>;
  const last = segments[segments.length - 1] ?? "";
  const next = edit(cursor[last]);
  if (next === undefined) delete cursor[last];
  else cursor[last] = next;
  return copy;
}

/**
 * A value of a different JSON type. An object where a scalar was, and a string where anything else was —
 * `null` counts as a scalar here on purpose, because a declared `string | null` accepts a string and the
 * retyping would not be one.
 */
function retyped(value: unknown): unknown {
  return typeof value === "object" && value !== null ? "pithy-retyped" : { pithyRetyped: true };
}

/** A name safe to use as a module file name. */
function moduleName(id: string, kind: string, path: string): string {
  return `${id}--${kind}--${path.replaceAll(".", "-")}`;
}

describe("virtual:pithy/* — the declaration an adopter is given, against the projections they receive", () => {
  test("every real projection satisfies the declared type, on both branches of every union", async () => {
    const modules: Record<string, string> = {};
    for (const entry of CASES) {
      modules[entry.id] = checkModule(entry, inlined(entry.projection), entry.projection.enabled);
    }
    const result = await typecheck(modules);
    expect(result.ok, result.output).toBe(true);
  });

  /**
   * The direction that produces `undefined` in production, and the one a substring assertion is blind to.
   *
   * Every key at every depth, dropped one at a time, in its own module. **All of them must be red** —
   * which is also the reach assertion: a declared property that this suite leaves green is one an
   * adopter could read after the projection stopped writing it.
   */
  test("a field a projection stops emitting is a compile error — every field, at every depth", async () => {
    const modules: Record<string, string> = {};
    for (const entry of CASES) {
      for (const path of survey(entry.projection).fields) {
        const dropped = rewrite(entry.projection, path, () => undefined);
        modules[moduleName(entry.id, "drops", path)] = checkModule(
          entry,
          JSON.stringify(dropped),
          entry.projection.enabled,
        );
      }
    }
    // A floor. A walk that stopped descending would generate a handful of modules and pass perfectly.
    expect(Object.keys(modules).length).toBeGreaterThan(80);
    const result = await typecheck(modules);
    expect(result.ok, "no dropped field was refused — the declaration has stopped requiring them").toBe(false);
    for (const name of Object.keys(modules)) {
      expect(result.output, `${name} dropped a field and the declaration accepted it`).toContain(`${name}.ts(`);
    }
  });

  /**
   * The other direction: a projection that grew a key the declaration never learned about. Silent in a
   * different way — the field reaches the browser and no screen may read it.
   */
  test("a field a projection starts emitting is a compile error — beside every object, at every depth", async () => {
    const modules: Record<string, string> = {};
    for (const entry of CASES) {
      for (const path of survey(entry.projection).objects) {
        const grown = rewrite(entry.projection, path, (value) => ({ ...(value as object), pithyDrifted: "x" }));
        modules[moduleName(entry.id, "grows", path || "root")] = checkModule(
          entry,
          JSON.stringify(grown),
          entry.projection.enabled,
        );
      }
    }
    expect(Object.keys(modules).length).toBeGreaterThan(30);
    const result = await typecheck(modules);
    expect(result.ok, "an undeclared field crossed into the bundle and nothing refused it").toBe(false);
    for (const name of Object.keys(modules)) {
      expect(result.output, `${name} grew a field and the declaration accepted it`).toContain(`${name}.ts(`);
    }
  });

  /** The third direction: the key stayed, its type did not. */
  test("a field a projection retypes is a compile error — every field, at every depth", async () => {
    const modules: Record<string, string> = {};
    for (const entry of CASES) {
      for (const path of survey(entry.projection).fields) {
        const changed = rewrite(entry.projection, path, retyped);
        modules[moduleName(entry.id, "retypes", path)] = checkModule(
          entry,
          JSON.stringify(changed),
          entry.projection.enabled,
        );
      }
    }
    expect(Object.keys(modules).length).toBeGreaterThan(80);
    const result = await typecheck(modules);
    expect(result.ok, "a retyped field was accepted — the declaration has widened to `unknown`").toBe(false);
    for (const name of Object.keys(modules)) {
      expect(result.output, `${name} retyped a field and the declaration accepted it`).toContain(`${name}.ts(`);
    }
  });

  test("every module the declaration declares is compared, and every module compared is declared", async () => {
    // The reach assertion for the file as a whole: the suite above is exact about the modules it holds,
    // and this is what stops a fifth `declare module` block being added with nothing behind it.
    const text = await readFile(DECLARATION, "utf8");
    const declared = [...text.matchAll(/declare module "virtual:pithy\/([^"]+)"/g)].map((match) => match[1] ?? "");
    expect([...new Set(declared)].sort()).toEqual([...new Set(CASES.map((entry) => entry.module))].sort());
    expect(declared.length).toBe(4);
  });

  test("every named export the declaration promises is one the plugin actually emits", async () => {
    // `export const enabled: boolean` is a second promise the declaration makes, and it is made in a
    // second place from the default export. `renderVirtualModule` skips a key that is not a legal binding
    // name, so a declared named export is not automatically a rendered one.
    const text = await readFile(DECLARATION, "utf8");
    const blocks = text.split(/declare module "virtual:pithy\//).slice(1);
    expect(blocks.length).toBe(4);
    let promises = 0;
    for (const block of blocks) {
      const module = block.slice(0, block.indexOf('"'));
      const entry = CASES.find((candidate) => candidate.module === module && candidate.projection.enabled);
      expect(entry, `nothing in this suite projects an enabled ${module}`).toBeDefined();
      const rendered = renderVirtualModule(entry?.projection ?? { enabled: false });
      for (const [, name] of block.matchAll(/export const (\w+):/g)) {
        promises += 1;
        expect(rendered, `virtual:pithy/${module} declares \`${name}\` and the plugin emits no such export`).toContain(
          `export const ${name} = `,
        );
      }
    }
    // A sweep that matched nothing would say the same thing as a declaration that promised nothing.
    expect(promises).toBe(4);
  });
});
