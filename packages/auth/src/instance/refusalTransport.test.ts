// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, sep } from "node:path";
import type { BetterAuthPlugin } from "better-auth";
// The barrel, deliberately: this file's job is to enumerate *every* plugin the dependency ships, and
// `oauth-popup` — the one the roster refuses — has no deep entry in `better-auth`'s export map at all.
import * as betterAuthPlugins from "better-auth/plugins";
import { describe, expect, test } from "vitest";
import { REFUSAL_TRANSPORT_ROSTER, REFUSED_PLUGIN_IDS } from "./refusalTransport";

/**
 * The completeness gate for `./refusalTransport`'s roster, and the measurement that keeps it a roster (#625).
 *
 * **Two jobs, and they pull in opposite directions on purpose.**
 *
 * The first is completeness. The roster refuses plugins by id, and a list is only honest if the next
 * dependency bump cannot quietly add a member to the class the list names. So this scans `better-auth`'s
 * own shipped plugin sources for the real predicate — a plugin that can **substitute** a response rather
 * than amend its headers — and requires every plugin family it finds to carry a written verdict. All
 * three seams `BetterAuthPlugin` offers for that are scanned, not only the one `oauthPopup` happens to
 * use, because the class is what the roster names. A bump that teaches a new plugin that move turns this
 * red naming the directory, and somebody rules on it.
 *
 * The second is the justification for the list existing at all. `./refusalTransport`'s docblock claims
 * that the structural property a plugin object *can* be asked about — does an `after` matcher claim the
 * callback path — is sound but far too wide to refuse on, and names the six plugins it would refuse for
 * something they do not do. That claim is executed here rather than asserted, because a docblock number
 * nobody runs is how a reach claim goes stale. If a bump narrows or widens that set, this goes red and the
 * prose gets corrected with it.
 *
 * **Each scan asserts a floor.** A regex that has stopped matching finds nothing and passes everything,
 * which is the failure mode a source scan actually has.
 */

const require_ = createRequire(import.meta.url);

/** Better Auth's `dist/`, found through its own export map rather than by guessing at a path. */
const DIST = dirname(dirname(require_.resolve("better-auth/oauth2")));

/**
 * The three seams `BetterAuthPlugin` gives a plugin for substituting a response, as source patterns.
 *
 * All three, not just the one `oauthPopup` uses, because the roster names a class rather than a
 * mechanism: a plugin that rendered the callback's refusal from `onResponse` would be exactly as far
 * outside the collapse's reach and would leave `context.returned` untouched. Two of them find nothing in
 * `better-auth` 1.7.1, which is a fact about the dependency and not a reason to stop asking — a scan that
 * only looks for what has already happened once cannot see the next one. `sample` is what keeps a pattern
 * finding nothing from being indistinguishable from a pattern that has gone blind.
 */
const RESPONSE_SEAMS: readonly { what: string; pattern: RegExp; sample: string }[] = [
  {
    what: "a hook assigning `context.returned`",
    // `[^=]` so `context.returned === x` is not read as an assignment. The receiver is not pinned: the
    // dependency spells it `c` in one plugin and `ctx` in the other, and a third spelling is a bump away.
    pattern: /\bcontext\.returned\s*=[^=]/,
    sample: "c.context.returned = response;",
  },
  {
    what: "a plugin-level `onResponse`",
    pattern: /\bonResponse\s*[:(]/,
    sample: "onResponse: async (response, ctx) => ({ response }),",
  },
  {
    what: "a plugin-level `middlewares` list",
    pattern: /\bmiddlewares\s*:/,
    sample: 'middlewares: [{ path: "/callback/:id", middleware }],',
  },
];

/**
 * `client.mjs` — the browser half of a plugin, which `createAuthClient` composes and no Worker runs.
 *
 * Excluded by name and said out loud, because it is the one place these patterns produce an answer about
 * the wrong program: `one-tap/client.mjs` declares a `hooks.onResponse` that is `better-fetch`'s
 * response hook in the browser, not `BetterAuthPlugin.onResponse` on the server.
 */
function isClientSource(entry: string): boolean {
  return (entry.split(sep).at(-1) ?? "").startsWith("client.");
}

/**
 * Every directory under `better-auth/dist/plugins/` holding a source that can substitute a response.
 *
 * Directories rather than plugin ids, because a source scan finds files and the two are not the same
 * string in general — `haveibeenpwned/` ships `have-i-been-pwned`. Every server `.mjs` in the tree is
 * read, not just `index.mjs`: a plugin's hooks may live in a sibling module, and a scan pointed at one
 * file name names a class it cannot catch.
 */
function directoriesReplacingTheResponse(): readonly string[] {
  const root = join(DIST, "plugins");
  const found = new Set<string>();
  for (const entry of readdirSync(root, { recursive: true, encoding: "utf8" })) {
    if (!entry.endsWith(".mjs") || isClientSource(entry)) continue;
    const [directory] = entry.split(sep);
    if (directory === undefined || directory === entry) continue;
    const source = readFileSync(join(root, entry), "utf8");
    if (RESPONSE_SEAMS.some((seam) => seam.pattern.test(source))) found.add(directory);
  }
  return [...found].sort();
}

/**
 * Every `id: "…"` literal declared anywhere under one plugin directory.
 *
 * The roster is keyed by plugin id because that is what `assertAdditivePlugins` has in hand, and the
 * completeness scan finds directories. Without this the two halves never meet: a verdict naming the right
 * directory under a misspelled id would satisfy the scan and refuse nothing at composition, which is a
 * gate claiming a reach it does not have.
 */
function idsDeclaredIn(directory: string): readonly string[] {
  const root = join(DIST, "plugins", directory);
  const ids = new Set<string>();
  for (const entry of readdirSync(root, { recursive: true, encoding: "utf8" })) {
    if (!entry.endsWith(".mjs")) continue;
    for (const match of readFileSync(join(root, entry), "utf8").matchAll(/\bid:\s*"([^"]+)"/g)) {
      ids.add(match[1] as string);
    }
  }
  return [...ids];
}

/** How many `.mjs` files the scan actually read. A scan over an empty tree proves nothing. */
function pluginSourceCount(): number {
  const root = join(DIST, "plugins");
  return readdirSync(root, { recursive: true, encoding: "utf8" }).filter((entry) => entry.endsWith(".mjs")).length;
}

/** The three shapes `callback.mjs` and the popup plugin's own matcher are written against. */
const CALLBACK_PATHS = ["/callback/:id", "/callback/github", "/oauth2/callback/:id"] as const;

/**
 * Every plugin the dependency's barrel exports and can build with no arguments, as `{ id, plugin }`.
 *
 * Constructors needing options are skipped — they throw on an argumentless call — and {@link BUILT_FLOOR}
 * is what stops that skip from quietly becoming "all of them".
 */
function shippedPlugins(): readonly { id: string; plugin: BetterAuthPlugin }[] {
  const built: { id: string; plugin: BetterAuthPlugin }[] = [];
  for (const candidate of Object.values(betterAuthPlugins)) {
    if (typeof candidate !== "function") continue;
    let plugin: unknown;
    try {
      plugin = (candidate as () => unknown)();
    } catch {
      continue;
    }
    if (typeof plugin !== "object" || plugin === null) continue;
    // The barrel exports helpers beside the factories — `verifyJWT`, `createJwk`, `toExpJWT` — and calling
    // one argumentless starts work that rejects. A thenable is not a plugin; swallow it so the enumeration
    // does not turn the dependency's own async failures into this suite's unhandled rejections.
    if (typeof (plugin as { then?: unknown }).then === "function") {
      void (plugin as Promise<unknown>).catch(() => undefined);
      continue;
    }
    const id = (plugin as { id?: unknown }).id;
    if (typeof id !== "string" || id.length === 0) continue;
    built.push({ id, plugin: plugin as BetterAuthPlugin });
  }
  return built;
}

/** The fewest argumentless plugin constructors that must succeed for the measurement to mean anything. */
const BUILT_FLOOR = 15;

/** Does any of this plugin's `after` hooks claim a path the social callback travels? */
function claimsTheCallback(plugin: BetterAuthPlugin): boolean {
  for (const hook of plugin.hooks?.after ?? []) {
    for (const path of CALLBACK_PATHS) {
      let claimed: boolean;
      try {
        // The matcher's whole contract is a `HookEndpointContext`, and every one in the dependency reads
        // `path` off it with optional chaining. A matcher that needs more than that throws, and a throw is
        // read as a claim: the wide property is being measured, so the wide answer is the honest one.
        claimed = hook.matcher({ path, context: {} } as Parameters<typeof hook.matcher>[0]);
      } catch {
        claimed = true;
      }
      if (claimed) return true;
    }
  }
  return false;
}

describe("the roster covers every better-auth plugin that replaces the callback's response", () => {
  test("the scan read the dependency's plugin sources, rather than an empty tree", () => {
    expect(pluginSourceCount()).toBeGreaterThanOrEqual(40);
  });

  test("the scan still finds the assignment it is written against", () => {
    // The floor a blinded regex trips over: `oauth-popup` is the whole reason this round exists.
    expect(directoriesReplacingTheResponse()).toContain("oauth-popup");
  });

  test.each(RESPONSE_SEAMS)("the pattern for $what still matches the thing it names", ({ pattern, sample }) => {
    // Two of the three find nothing in the dependency as installed, and a pattern that finds nothing is
    // indistinguishable from one somebody broke. This is the difference, asserted rather than assumed.
    expect(pattern.test(sample)).toBe(true);
  });

  test("every plugin that replaces the response carries a written verdict", () => {
    const reviewed = new Set(Object.values(REFUSAL_TRANSPORT_ROSTER).map((verdict) => verdict.source));
    const unreviewed = directoriesReplacingTheResponse().filter((directory) => !reviewed.has(directory));
    // The message is the point of the gate: it hands the next reader the directories to rule on.
    expect(unreviewed, "better-auth plugins with no verdict in REFUSAL_TRANSPORT_VERDICTS — decide each").toEqual([]);
  });

  test("no verdict is written about a plugin that no longer does it", () => {
    // The other direction, so the roster cannot become a museum of claims nobody can check.
    const replacing = new Set(directoriesReplacingTheResponse());
    const stale = Object.values(REFUSAL_TRANSPORT_ROSTER)
      .map((verdict) => verdict.source)
      .filter((source) => !replacing.has(source))
      .sort();
    expect(stale, "verdicts about plugins that no longer assign context.returned").toEqual([]);
  });

  test("every rostered source is a directory the dependency actually ships", () => {
    for (const verdict of Object.values(REFUSAL_TRANSPORT_ROSTER)) {
      expect(statSync(join(DIST, "plugins", verdict.source)).isDirectory(), `${verdict.source} is not shipped`).toBe(
        true,
      );
    }
  });

  test("every rostered id is an id its own source declares — the key is what the gate reads", () => {
    for (const [id, verdict] of Object.entries(REFUSAL_TRANSPORT_ROSTER)) {
      expect(idsDeclaredIn(verdict.source), `${verdict.source} declares no plugin with id "${id}"`).toContain(id);
    }
  });

  test("every verdict says why, because a verdict without the reason is just a list", () => {
    for (const [id, verdict] of Object.entries(REFUSAL_TRANSPORT_ROSTER)) {
      expect(verdict.why.length, `${id} has no reason`).toBeGreaterThan(80);
    }
  });
});

/**
 * The measurement behind "a roster, not a property".
 *
 * `./refusalTransport` says the structural property is sound and too wide, and names the plugins it would
 * refuse wrongly. Both halves are checked here against the dependency as installed.
 */
describe("the structural property is sound and too wide to refuse on", () => {
  test("the measurement was taken over the plugins the dependency ships, not a handful", () => {
    expect(shippedPlugins().length).toBeGreaterThanOrEqual(BUILT_FLOOR);
  });

  test("it is sound: every plugin the roster refuses also has the property", () => {
    // Necessary, not sufficient. A plugin that replaces the callback's response has to claim the callback
    // first, so a refused plugin failing this would mean the property had stopped being a superset.
    const claiming = new Set(
      shippedPlugins()
        .filter(({ plugin }) => claimsTheCallback(plugin))
        .map(({ id }) => id),
    );
    for (const id of REFUSED_PLUGIN_IDS) expect(claiming, `${id} no longer claims the callback`).toContain(id);
  });

  test("it is too wide: these are the plugins refusing on it would take with it", () => {
    const claiming = shippedPlugins()
      .filter(({ plugin }) => claimsTheCallback(plugin))
      .map(({ id }) => id)
      .sort();
    // Named rather than counted, so the docblock's list is the assertion. `bearer` is the kit's own and is
    // already reserved; the other five are plugins an adopter may compose today, and every one of them
    // only reads `set-cookie` or amends a header. Refusing them would be the gate stating a reason that is
    // not true of them — which is the defect this whole issue keeps being about, one level up.
    expect(claiming, "the structural property's reach changed — correct ./refusalTransport's docblock").toEqual([
      "anonymous",
      "bearer",
      "last-login-method",
      "multi-session",
      "oauth-popup",
      "oauth-proxy",
      "one-time-token",
    ]);
    expect(claiming.length).toBeGreaterThan(REFUSED_PLUGIN_IDS.length);
  });
});
