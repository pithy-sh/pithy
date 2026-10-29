// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { describe, expect, test } from "vitest";
import { HOME_SCREEN, TEMPLATE_DIR, TEMPLATE_GROUPS } from "./templates";

/**
 * **The ledger for `docs/CONVENTIONS.md` § *Seeded files*, for the React Native templates: every file
 * `pithy ui add react-native` seeds is held by a gate the kit keeps, with the wall that kept it here, or is
 * ungated for a reason written down.**
 *
 * None of these files ships with a gate beside it, and that is a wall found by trying rather than a choice. The
 * Expo app gets no test runner of its own: its `package.json` carries Expo's start scripts and no `vitest`. The
 * only runner that reaches it is the project's root `vitest.config.ts`, whose `node` project collects
 * `apps/*\/src/**\/*.test.{ts,tsx}` in plain Node. A module that imports `react-native` does not load there:
 * React Native's entry is untransformed Flow, and the import fails to parse before a test runs. This package's
 * own `vitest.config.ts` is what makes the screens testable — `react-native` aliased to `react-native-web`,
 * happy-dom, a stand-in under `testing/` for every native module, and a transform for Metro's
 * `require.context` — and an adopter's project has none of it. A gate seeded beside one of these screens would
 * not pass over nothing; it would turn the adopter's `bun run test` red on the day it arrived.
 *
 * ## What this can check, and what it cannot
 *
 * It cannot tell whether a file has an invariant, whether a kept gate really holds it, or whether a decline is
 * true. What it does is make the decision due when a path joins `TEMPLATE_GROUPS`, and refuse to let it rot: a
 * file with no entry is red, an entry for a file that left is red, and a kept gate must be a file that exists in
 * this package outside the template tree and names its subject.
 *
 * The one wall it can check is the runner's. An entry that says its gate could not travel because the scaffolded
 * runner cannot load the subject is held to that: the subject's own imports, followed through the tree, must
 * reach `react-native` or Metro's `require.context`. A file that loads in plain Node cannot claim it, and has to
 * argue the other wall or decline.
 */

/** Why a kept gate could not travel with its subject. */
type Wall =
  /** The project's runner cannot load the subject: its imports reach `react-native` or `require.context`. */
  | "runner"
  /** The party who can break the invariant is the kit, so the alarm belongs where the fix can be made. */
  | "kit";

/** How a seeded file is held. Exactly one of these, and the sentence is the point of either. */
type Held =
  /** Held by a test in this package's `src/`, by its path from the package root, with the wall that kept it. */
  | { readonly keptGate: string; readonly wall: Wall; readonly why: string }
  /** No gate, and why. A decline with an argument is an answer; a shrug is not. */
  | { readonly ungated: string };

/**
 * Every file this library seeds, and what holds it. Adding a template without adding a line below fails
 * `the ledger names every seeded file`.
 */
const LEDGER: Record<string, Held> = {
  // ── base ────────────────────────────────────────────────────────────────────────────────────────
  "app.config.ts": {
    ungated:
      "The two values that must agree with the screens, the scheme a sign-in returns to and the host a universal link claims, are read from `src/pithy-config.generated.ts` rather than written here, so the agreement is one statement and the rest of the file — the name, the bundle identifiers, the plugins — is the adopter's to set. Restating the scheme as a literal breaks the first sign-in tried on a device, which is loud. `src/appConfig.test.tsx` holds the kit's template to reading both, and it is not named as a kept gate because neither wall stands: the file loads in plain Node, and the party who can break it is the adopter.",
  },
  "metro.config.js": {
    ungated:
      "Three lines: Expo's default Metro config with the dev proxy added. Dropping the proxy is loud and local — under `pithy dev` the web build's calls to the Worker answer 404 — and it changes nothing a phone or a production build does. `src/metroProxy.test.ts` holds the kit's template to that shape.",
  },
  "metro-proxy.cjs": {
    keptGate: "src/metroProxy.test.ts",
    wall: "kit",
    why: "What it must agree with is the kit's: it reads `src/pithy-config.generated.ts` without TypeScript, so its reader has to accept every file the kit's own reader accepts and refuse every one it refuses, and the format changes only when the kit changes `generatedConfig.ts`. The gate holds the two readers together and holds the proxy to never forwarding a path a screen claims. It runs only under `pithy dev`, so an adopter's edit costs their own dev loop and never a build.",
  },
  "tsconfig.json": {
    ungated:
      "Nothing in the app runs it. The app's scripts are Expo's, and Metro transpiles without type-checking, so the compiler options here drive the editor's checker and nothing a build or a test passes or fails on. A narrowed `include` shows as diagnostics missing from the file that is open, not as a green run over nothing.",
  },
  "app/_layout.tsx": {
    keptGate: "src/app.test.tsx",
    wall: "runner",
    why: "The root layout puts the locale over whatever route expo-router resolved; `src/storeTransactions.test.tsx` mounts it too, for the store listener it runs when the payments screens were written. It imports expo-router and the locale provider, which reach `react-native`, so no test of it loads in the project's Node runner.",
  },
  "app/index.tsx": {
    keptGate: "src/app.test.tsx",
    wall: "runner",
    why: "The index route hands `/` to the kit's router like every other path. It renders the catch-all, which imports the router, which reaches `react-native`, so no test of it loads in the project's Node runner.",
  },
  "app/[...pithy].tsx": {
    keptGate: "src/app.test.tsx",
    wall: "runner",
    why: "Every path expo-router lands on must reach the kit's router, or a screen registered by dropping a file in is never shown. It imports the router, which reaches `react-native`, so no test of it loads in the project's Node runner.",
  },
  "src/theme.ts": {
    keptGate: "src/theme.test.tsx",
    wall: "runner",
    why: "The values are the adopter's to edit; what the gate holds is that a dark device draws with the dark palette and the two differ where a reader would see it. It reads the device's scheme from `react-native`, so no test of it loads in the project's Node runner.",
  },
  "src/platform.ts": {
    keptGate: "src/platform.test.tsx",
    wall: "runner",
    why: "It reads a query string and a deep link without `URLSearchParams` or `URL`, which React Native does not implement in full, and a tidy-up onto either works on the web and misreads on a phone. It imports `react-native`, expo-linking and expo-web-browser, so no test of it loads in the project's Node runner.",
  },
  "src/pithy-config.ts": {
    keptGate: "src/pithyConfig.test.tsx",
    wall: "runner",
    why: "It picks the Worker's origin per environment and refuses a phone sending its bearer credential to staging or prod over anything but https. It reads `Platform` from `react-native`, so no test of it loads in the project's Node runner.",
  },
  "src/pithy-config.generated.ts": {
    ungated:
      "The file `pithy ui sync --app` rewrites from the Worker's composed config, keeping the fields it names as the adopter's. A sync reads it back without running it, and refuses one it cannot read by name rather than writing over it, so a hand edit that breaks the shape is loud at the next sync. `src/generatedConfig.test.ts` holds the template to being a file the kit's writer produces, so the scaffold and the sync agree.",
  },
  "src/pithy-locale.tsx": {
    keptGate: "src/pithyLocale.test.tsx",
    wall: "runner",
    why: "It follows the device's language, remembers a reader's choice, and says a change of direction needs a restart. It imports `react-native`, so no test of it loads in the project's Node runner.",
  },
  "src/router.tsx": {
    keptGate: "src/router.test.tsx",
    wall: "runner",
    why: "The guards send a signed-out visitor to the path the sign-in screen declares and a visitor without the entitlement to the paywall, and a redirect that loads remounts every screen. It imports `react-native` and expo-router, so no test of it loads in the project's Node runner.",
  },
  "src/route-modules.ts": {
    keptGate: "src/routeModules.test.tsx",
    wall: "runner",
    why: "Its filter registers every screen and keeps every co-located test out of the bundle, fixtures and stub tokens included, which is silent when it fails. It calls Metro's `require.context`, which exists only in a Metro bundle; the kit's tests reach it through a transform the project's runner does not have.",
  },
  "src/transport.ts": {
    keptGate: "src/transport.test.tsx",
    wall: "runner",
    why: "On a phone the session is a bearer credential in the secure store, presented only to the Worker's origin; on the web it is the page's cookie and nothing is stored. It imports `react-native`, expo-secure-store and expo-crypto, so no test of it loads in the project's Node runner.",
  },

  // ── auth ────────────────────────────────────────────────────────────────────────────────────────
  "src/session.tsx": {
    keptGate: "src/session.test.tsx",
    wall: "runner",
    why: "A sign-in's token is adopted into the secure store before the session is read, sign-out tells the Worker before forgetting, and a resume target that is one of the app's own screens stays in the app. It imports `react-native` and expo-crypto, so no test of it loads in the project's Node runner.",
  },
  "src/turnstile.tsx": {
    keptGate: "src/turnstile.test.tsx",
    wall: "runner",
    why: "On a phone the widget page loads in a WebView that goes nowhere but the Worker's widget page and Cloudflare's challenge frames, and drops a message from any other page. It imports `react-native` and react-native-webview, so no test of it loads in the project's Node runner.",
  },
  "src/useTurnstileWeb.ts": {
    keptGate: "src/useTurnstileWeb.test.tsx",
    wall: "runner",
    why: "A script that fails to load answers no token, so the form says so rather than waiting, and the next widget asks for it again. It imports `react-native`, so no test of it loads in the project's Node runner.",
  },
  "src/routes/pithy/sign-in.tsx": {
    keptGate: "src/signIn.test.tsx",
    wall: "runner",
    why: "The answer is the same whether or not an address can sign in, and an authorization URL naming no client is refused rather than followed. It imports `react-native` and the native sign-in modules, so no test of it loads in the project's Node runner.",
  },
  "src/routes/pithy/otp.tsx": {
    keptGate: "src/otp.test.tsx",
    wall: "runner",
    why: "A right code's session is adopted on a phone and rides the cookie on the web, and a suspended account's right code goes to the suspended screen rather than reading as a wrong code. It imports `react-native`, so no test of it loads in the project's Node runner.",
  },
  "src/routes/pithy/callback.tsx": {
    keptGate: "src/callback.test.tsx",
    wall: "runner",
    why: "On a phone the deep link's one-time code is traded only with the verifier this device holds, and a code nothing asked for never reaches the Worker. It imports `react-native`, so no test of it loads in the project's Node runner.",
  },
  "src/routes/pithy/account-suspended.tsx": {
    keptGate: "src/accountScreens.test.tsx",
    wall: "runner",
    why: "It claims its role at the path the web screen does, so a refusal reaches it by job, names no address, and signs out once. It imports `react-native`, so no test of it loads in the project's Node runner.",
  },
  "src/routes/pithy/account-deleted.tsx": {
    keptGate: "src/accountScreens.test.tsx",
    wall: "runner",
    why: "The suspended screen's shape for the other state, held by the same tests for the same reasons. It imports `react-native`, so no test of it loads in the project's Node runner.",
  },
  "src/routes/pithy/organization-suspended.tsx": {
    keptGate: "src/organizationSuspended.test.tsx",
    wall: "runner",
    why: "It claims its route and its role, so a refusal anywhere can send somebody here, and says their own account is not the one suspended. It imports `react-native`, so no test of it loads in the project's Node runner.",
  },

  // ── organization ────────────────────────────────────────────────────────────────────────────────
  "src/routes/pithy/choose-organization.tsx": {
    keptGate: "src/chooseOrganization.test.tsx",
    wall: "runner",
    why: "Choosing an account leaves the way a document load does, so nothing the last account put on a screen survives the switch; a plain navigation looks identical in every manual test. It imports `react-native`, so no test of it loads in the project's Node runner.",
  },
  "src/routes/pithy/invitation.tsx": {
    keptGate: "src/invitation.test.tsx",
    wall: "runner",
    why: "Accepting is followed by choosing the joined account, because the server leaves the account in force where it was, and leaving remounts every screen for the chooser's reason. Dropping either looks like a tidy-up. It imports `react-native`, so no test of it loads in the project's Node runner.",
  },

  // ── mcp ─────────────────────────────────────────────────────────────────────────────────────────
  "src/routes/pithy/agent-consent.tsx": {
    keptGate: "src/agentConsent.test.tsx",
    wall: "runner",
    why: "The application's name is self-asserted and the redirect address is what identifies it. A restyle that promotes the name to the heading, or drops the address as clutter, turns the screen into a phishing page on the adopter's own domain. It imports `react-native` and expo-linking, so no test of it loads in the project's Node runner.",
  },
  "src/routes/pithy/connected-applications.tsx": {
    keptGate: "src/connectedApplications.test.tsx",
    wall: "runner",
    why: "Each application is listed by its reported name beside where its access goes, and a revoke asks the Worker and reads the list again. It imports `react-native`, so no test of it loads in the project's Node runner.",
  },

  // ── payments ────────────────────────────────────────────────────────────────────────────────────
  "src/payments.tsx": {
    keptGate: "src/payments.test.tsx",
    wall: "runner",
    why: "A store purchase's account token is a random UUID kept per user on this device and never the user id, and the entitlement guard fails shut on a failed read. It imports `react-native` and expo-crypto, so no test of it loads in the project's Node runner.",
  },
  "src/payments-store.ts": {
    ungated:
      "The web half of a platform split: Metro resolves `./payments-store` to this file on the web, and its `loadStore` answers null whatever it imports, so no edit to it changes what a reader sees. What it keeps out is `expo-iap` from the web bundle, a cost and not a wrong answer. `src/paymentsStore.test.ts` holds the kit's template to naming it only as a type.",
  },
  "src/payments-store.native.ts": {
    ungated:
      "The phone half of the same split. It loads `expo-iap` on the first store call and forgets a failed load, so an app that never sells through a store never loads it. Loading it eagerly costs launch time on such an app and changes no answer. `src/paymentsStore.test.ts` holds the kit's template to the one lazy import.",
  },
  "src/useStoreTransactions.ts": {
    keptGate: "src/storeTransactions.test.tsx",
    wall: "runner",
    why: "What the store delivers with no screen waiting is finished only once the Worker has it, and a purchase tagged with another user's account token is neither submitted nor finished. It imports the payments module, which reaches `react-native`, so no test of it loads in the project's Node runner.",
  },
  "src/useAppFocus.ts": {
    keptGate: "src/payments.test.tsx",
    wall: "runner",
    why: "It fires when the app returns to the foreground and not on the first render, so a screen reads the subscription again after a checkout in the system browser. It listens to `AppState` from `react-native`, so no test of it loads in the project's Node runner.",
  },
  "src/routes/pithy/paywall.tsx": {
    keptGate: "src/paywall.test.tsx",
    wall: "runner",
    why: "A consumable is consumed once the Worker has it, Restore Purchases submits only what the store holds for this account, and the return from Stripe posts its session exactly once. It imports `react-native`, so no test of it loads in the project's Node runner.",
  },
  "src/routes/pithy/pricing.tsx": {
    keptGate: "src/pricing.test.tsx",
    wall: "runner",
    why: "It shows the store's own price, tags a purchase with the account's token, and leaves a purchase the Worker refuses with the store. It imports `react-native`, so no test of it loads in the project's Node runner.",
  },
  "src/routes/pithy/subscription.tsx": {
    keptGate: "src/subscription.test.tsx",
    wall: "runner",
    why: "It says so when the read failed rather than claiming the account holds nothing, and reads again when the app comes back from the portal. It imports `react-native`, so no test of it loads in the project's Node runner.",
  },

  // ── consent ─────────────────────────────────────────────────────────────────────────────────────
  "src/routes/pithy/consent.tsx": {
    keptGate: "src/consent.test.tsx",
    wall: "runner",
    why: "Withdrawing is never harder than granting, and a written withdrawal is asked for at the grade of the grant behind it, so the screen never offers one the server would refuse. It imports `react-native`, so no test of it loads in the project's Node runner.",
  },

  // ── the home screen, in both variants ────────────────────────────────────────────────────────────
  "src/routes/app/home.tsx": {
    ungated:
      "It is the adopter's from the moment it is written: `src/routes/app/` is the one directory Pithy writes once and never touches again. It reads who is signed in from `session.tsx` and restates nothing, so an edit that breaks it breaks the render. `src/home.test.tsx` holds the kit's template to rendering.",
  },
  "src/routes/app/home.bare.tsx": {
    keptGate: "src/home.test.tsx",
    wall: "kit",
    why: "It reads the health route's path from `@pithy-sh/core/src/worker/health` rather than writing it down, so a rename in core moves the screen with it. The file is the adopter's once written, so what is left to hold is the kit's template reading that constant rather than a literal, and the party who would retype one is the kit.",
  },
};

/** This package's root. `TEMPLATE_DIR` is `<package>/templates`. */
const PACKAGE_ROOT: string = join(TEMPLATE_DIR, "..");

/** Every path any group or the home screen declares. */
const SUBJECTS: string[] = [...Object.values(TEMPLATE_GROUPS).flat(), HOME_SCREEN.auth, HOME_SCREEN.bare];

/** A path without its extension: how a test names the module it imports. */
const stem = (path: string): string => path.replace(/\.[cm]?[jt]sx?$/, "");

/** The extensions a relative import in the tree may leave off, in the order a bundler tries them. */
const EXTENSIONS = ["", ".ts", ".tsx", ".js", ".cjs"];

/** The modules `text` loads when it runs: type-only imports are erased before anything loads, so they are not. */
function runtimeSpecifiers(text: string): string[] {
  const found: string[] = [];
  for (const line of text.split("\n")) {
    if (/^\s*(import|export)\s+type\s/.test(line)) continue;
    for (const match of line.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)["']([^"']+)["']/g)) {
      found.push(match[1] ?? "");
    }
  }
  return found;
}

/**
 * Does `subject`, followed through its relative imports in the tree, load something the project's Node runner
 * cannot: `react-native`, whose entry is Flow, or Metro's `require.context`, which only a Metro bundle defines?
 */
async function reachesWhatNodeCannotLoad(subject: string): Promise<boolean> {
  const seen = new Set<string>();
  const queue = [subject];
  while (queue.length > 0) {
    const path = queue.shift() ?? "";
    if (seen.has(path)) continue;
    seen.add(path);
    const text = await readFile(join(TEMPLATE_DIR, path), "utf8").catch(() => null);
    if (text === null) continue;
    if (text.includes("require.context(")) return true;
    for (const specifier of runtimeSpecifiers(text)) {
      if (specifier === "react-native") return true;
      if (!specifier.startsWith(".")) continue;
      const base = posix.join(posix.dirname(path), specifier);
      for (const extension of EXTENSIONS) {
        const candidate = `${base}${extension}`;
        if (SUBJECTS.includes(candidate)) {
          queue.push(candidate);
          break;
        }
      }
    }
  }
  return false;
}

describe("the ledger and the tree agree", () => {
  test("the ledger names every seeded file, and names nothing else", () => {
    // Both directions. A missing key is a template that slipped in with no decision taken; an extra key is a
    // decision kept alive for a file that left.
    expect(Object.keys(LEDGER).sort()).toEqual([...SUBJECTS].sort());
  });

  test("a decline is an argument, not a shrug", () => {
    for (const [subject, held] of Object.entries(LEDGER)) {
      if (!("ungated" in held)) continue;
      expect(held.ungated.length, `${subject} is ungated and says almost nothing about why`).toBeGreaterThan(80);
    }
  });
});

describe("every kept gate is real", () => {
  test("it is a test in this package, outside the template tree, that names its subject, with the reason it stayed", async () => {
    // A ledger entry pointing at a renamed file rots into a subject that reads as held, so the path is resolved,
    // and the gate is required to name the module it holds.
    let checked = 0;
    for (const [subject, held] of Object.entries(LEDGER)) {
      if (!("keptGate" in held)) continue;
      expect(held.keptGate.startsWith("src/"), `${subject}'s kept gate ${held.keptGate} is not in src/`).toBe(true);
      expect(/\.test\.tsx?$/.test(held.keptGate), `${held.keptGate} is named as a gate and is not a test`).toBe(true);
      const text = await readFile(join(PACKAGE_ROOT, held.keptGate), "utf8").catch(() => null);
      expect(text, `${subject} is held by ${held.keptGate}, which is not there`).not.toBeNull();
      expect(text?.includes(stem(subject)), `${held.keptGate} never names ${subject}`).toBe(true);
      expect(held.why.length, `${subject} is kept and says almost nothing about why`).toBeGreaterThan(80);
      checked += 1;
    }
    expect(checked, "the kept-gate sweep no longer reads every gate the ledger names").toBeGreaterThanOrEqual(32);
  });
});

describe("the runner wall is checked, not claimed", () => {
  test("the reading is calibrated before it is trusted", async () => {
    // A screen reaches `react-native`, and the route registration reaches `require.context`.
    expect(await reachesWhatNodeCannotLoad("src/theme.ts")).toBe(true);
    expect(await reachesWhatNodeCannotLoad("src/route-modules.ts")).toBe(true);
    // Through a relative import: the hook imports nothing native itself.
    expect(await reachesWhatNodeCannotLoad("src/useStoreTransactions.ts")).toBe(true);
    // Files that load in plain Node, so a sweep that answered true for everything would be caught here.
    expect(await reachesWhatNodeCannotLoad("metro-proxy.cjs")).toBe(false);
    expect(await reachesWhatNodeCannotLoad("src/payments-store.ts")).toBe(false);
    expect(await reachesWhatNodeCannotLoad("app.config.ts")).toBe(false);
    // A type-only import of `react-native` is erased, so it loads nothing.
    expect(runtimeSpecifiers('import type { TextStyle } from "react-native";')).toEqual([]);
    expect(runtimeSpecifiers('import { type TextStyle, View } from "react-native";')).toEqual(["react-native"]);
  });

  test("every entry that says the project's runner cannot load its subject is one that cannot", async () => {
    let checked = 0;
    for (const [subject, held] of Object.entries(LEDGER)) {
      if (!("keptGate" in held) || held.wall !== "runner") continue;
      expect(
        await reachesWhatNodeCannotLoad(subject),
        `${subject} claims the runner wall and loads in plain Node: a gate beside it could run, so argue the other wall or decline`,
      ).toBe(true);
      checked += 1;
    }
    expect(checked, "the runner sweep no longer reads every entry that claims the wall").toBeGreaterThanOrEqual(30);
  });
});

describe("the floors", () => {
  test("the tree is the size the ledger was written about", () => {
    // Near-exact rather than comfortable: thirty-nine subjects across six groups and two home variants.
    expect(SUBJECTS.length).toBeGreaterThanOrEqual(39);
  });
});
