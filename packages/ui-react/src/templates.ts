// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The React 19 front-end templates `pithy ui add react` copies into a Worker.
 *
 * This is a template library, not a runtime library: it ships text, has no dependencies of its own,
 * and nothing imports it at runtime except the CLI's scaffolder. It is a real package rather than a
 * folder inside `@pithy-sh/cli` for one reason that only gets truer with time — **a framework's
 * templates need that framework's toolchain to be checked.** React needs `react`, `@types/react` and
 * a `jsx: react-jsx` program; Svelte would need an entirely different set. Folding them into the CLI
 * makes the CLI accumulate every framework's devDependencies and every framework's tsconfig, to
 * typecheck files it only ever copies.
 *
 * The tree mirrors the scaffolded layout exactly. That is what lets a screen's `../../router` import
 * resolve in the template as well as in the Worker it lands in, so the whole library typechecks in
 * place instead of only after it has been written somewhere.
 *
 * **Grouping is the manifest's job, not the directory's.** The tree is one layout; which files a
 * given invocation writes is chosen by {@link TEMPLATE_GROUPS}. That is why the auth screens sit in
 * their final `src/routes/pithy/` home rather than an `auth/` subtree, and it is how a later screen
 * set — payments, say — joins: add its files to the tree, name them in a new group, and no path,
 * import, or contract moves.
 */

/** Absolute path to the template tree. Resolved from this module, so it holds in a workspace and once published. */
export const TEMPLATE_DIR: string = join(dirname(fileURLToPath(import.meta.url)), "..", "templates");

/**
 * The named file groups this library offers, each keyed by path within {@link TEMPLATE_DIR}.
 *
 * `base` is every template, always. Every other group is a screen set that rides on a capability
 * being composed — `auth` and `payments` today, and whatever follows is an additive entry here with
 * nothing about the CLI's stub contract having to change to admit it.
 *
 * **`src/pithy-config.tsx` is base, not auth.** It is the one module that imports the
 * `virtual:pithy/*` modules and narrows each on `enabled`, for *every* capability — `docs/UI.md` says
 * so in as many words, and a payments-only scaffold would otherwise never get the file its screens
 * read. It compiles with nothing composed: each projection is then `{ enabled: false }` and the
 * narrowing falls to the defaults it declares.
 */
export const TEMPLATE_GROUPS = {
  base: [
    "index.html",
    "vite.config.ts",
    "tsconfig.client.json",
    "tsconfig.node.json",
    "client-env.d.ts",
    "src/client.tsx",
    // **The gate travels with the file it protects (#383, #391).** `src/client.tsx` used to find its
    // mount node by an id declared in `index.html`, and renaming that div rendered an empty page with
    // no error at all (#394). The node is created in code now, and this is what keeps it that way in a
    // repository Pithy will never see again.
    "src/client.test.tsx",
    "src/pithy-config.tsx",
    "src/router.tsx",
    // The router's half of #393: a guard's destination is the path the screen declares, and this is
    // what keeps it so once `router.tsx` is a file in somebody else's repository.
    "src/router.test.tsx",
    "src/styles.css",
    // **`src/pithy-screens.css` is base, and it is base for the same reason `pithy-config.tsx` is.**
    // It carries every class name a Pithy screen renders, and it is written whenever it is absent —
    // which is what makes a *backfill* (`--auth` on a project scaffolded `--no-auth`) produce screens
    // that render styled. Putting it in the `auth` group instead would leave a payments-only scaffold
    // unstyled, and duplicating it across both groups would name one file twice.
    //
    // The adopter's `src/styles.css` is correctly skipped on that backfill — it is theirs. Before this
    // file existed, the classes lived in it, so the run wrote a sign-in screen whose `stack`, `divider`
    // and `secondary` nothing defined and reported it as created.
    "src/pithy-screens.css",
  ],
  auth: [
    "src/session.tsx",
    "src/turnstile.tsx",
    // **The gate travels with the file it protects (#383).** `src/turnstile.tsx` is the adopter's the
    // moment it lands, and its whole risk is that the action label can be retyped into it — a drift
    // no environment before production can see, because the test keys dev and staging run answer with
    // no action to compare (#374). The kit keeping the only gate for that leaves the adopter most
    // likely to hit it with nothing that goes red. So this one is seeded, not kept.
    "src/turnstile.test.tsx",
    "src/routes/pithy/sign-in.tsx",
    // The magic link's `callbackURL` and `callback.tsx`'s `path` are one statement, and this is the
    // gate that keeps them one after the screens are yours (#393). Seeded for the same reason the
    // widget's is: the round trip it protects is the one flow nobody already signed in can test.
    "src/routes/pithy/sign-in.test.tsx",
    "src/routes/pithy/otp.tsx",
    "src/routes/pithy/callback.tsx",
  ],
  payments: [
    "src/payments.tsx",
    "src/routes/pithy/paywall.tsx",
    // The pricing screen ships even for a project with no Paddle rail, and renders its own empty state
    // there. The argument against shipping one at all is that a pricing page is the most brand-specific
    // screen there is — which is true of the paywall too, and did not stop that one. What settles it is
    // that the alternative is every adopter writing the same PricePreview plumbing by hand, getting the
    // tax convention wrong in one direction or the other, and freezing it into their own repository.
    "src/routes/pithy/pricing.tsx",
    "src/routes/pithy/subscription.tsx",
  ],
} as const satisfies Record<string, readonly string[]>;

/** A group name this library offers. */
export type TemplateGroup = keyof typeof TEMPLATE_GROUPS;

/**
 * The adopter's own home screen, which exists in two variants because it is the one file that
 * differs between templates: the auth one carries the signed-in guard, the bare one does one typed
 * `fetch`. Both live in the tree so both compile against the router and the session hook; exactly
 * one is ever written, and always to the same place.
 */
export const HOME_SCREEN = {
  target: "src/routes/app/home.tsx",
  auth: "src/routes/app/home.tsx",
  bare: "src/routes/app/home.bare.tsx",
} as const;

/** The token every template uses where the Worker's name belongs. */
export const WORKER_TOKEN = "__PITHY_WORKER__";
