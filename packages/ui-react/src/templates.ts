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
 * **`src/pithy-config.tsx` is base, not auth.** It imports the `virtual:pithy/*` modules and narrows
 * each on `enabled`, for *every* capability, and a payments-only scaffold would otherwise never get the
 * file its screens read. The consent screen alone narrows `virtual:pithy/consent` itself. It compiles with nothing composed: each projection is then `{ enabled: false }` and the
 * narrowing falls to the defaults it declares.
 *
 * ## Adding a file here is agreeing to one rule
 *
 * > **Every seeded file whose invariant an adopter can break silently ships with the gate that
 * > notices.**
 *
 * `docs/CONVENTIONS.md` § *Seeded files* is the whole statement, with the three properties a seeded
 * gate must meet and the two questions to answer before writing one. `seededGates.test.ts` beside this
 * file is what makes the question due: a path added below is red until the ledger there says which gate
 * holds it, or why none does. The reason is the deliverable either way — a decline with an argument is
 * an answer, and this list growing quietly is not.
 */
export const TEMPLATE_GROUPS = {
  base: [
    "index.html",
    "vite.config.ts",
    "tsconfig.client.json",
    "tsconfig.node.json",
    "client-env.d.ts",
    "src/client.tsx",
    // **The gate travels with the file it protects.** `src/client.tsx` creates its mount node in code,
    // because a node found by an id declared in `index.html` renders an empty page with no error once
    // that div is renamed. This keeps it so in a repository Pithy will never see.
    "src/client.test.tsx",
    "src/pithy-config.tsx",
    // **The language the document declares and the language the page renders are one value, and this
    // file is where it is resolved.** A `<html lang>` that disagrees with the rendered text is believed
    // by a screen reader, which mispronounces the page. Base rather than an i18n group, for
    // `pithy-config.tsx`'s reason: it compiles with nothing composed, where it renders its children
    // untouched and no catalog is ever fetched.
    "src/pithy-locale.tsx",
    // The gate travels with it: the two halves are asserted from one mount, which is the only way to
    // state the invariant at all.
    "src/pithy-locale.test.tsx",
    "src/router.tsx",
    // A guard's destination is the path the screen declares, and this is what keeps it so once
    // `router.tsx` is a file in somebody else's repository.
    "src/router.test.tsx",
    "src/styles.css",
    // **`src/pithy-screens.css` is base, and it is base for the same reason `pithy-config.tsx` is.**
    // It carries every class name a Pithy screen renders, and it is written whenever it is absent —
    // which is what makes a *backfill* (`--auth` on a project scaffolded `--no-auth`) produce screens
    // that render styled. Putting it in the `auth` group instead would leave a payments-only scaffold
    // unstyled, and duplicating it across both groups would name one file twice.
    //
    // The adopter's `src/styles.css` is correctly skipped on that backfill — it is theirs — so no class a
    // screen renders may live there.
    //
    // The palette these two files share has the one gate that could NOT be
    // seeded: the invariant is CSS text, and a scaffolded project's runner stubs CSS modules to the
    // empty string, so a seeded gate would sweep nothing and pass. It is kept in `palette.test.ts`,
    // with that reason at the site — see `seededGates.test.ts`, which records it rather than letting
    // the ledger look complete.
    "src/pithy-screens.css",
  ],
  auth: [
    "src/session.tsx",
    "src/turnstile.tsx",
    // **The gate travels with the file it protects.** `src/turnstile.tsx` is the adopter's the
    // moment it lands, and its whole risk is that the action label can be retyped into it — a drift
    // no environment before production can see, because the test keys dev and staging run answer with
    // no action to compare. The kit keeping the only gate for that leaves the adopter most
    // likely to hit it with nothing that goes red. So this one is seeded, not kept.
    "src/turnstile.test.tsx",
    "src/routes/pithy/sign-in.tsx",
    // The magic link's `callbackURL` and `callback.tsx`'s `path` are one statement, and this is the
    // gate that keeps them one after the screens are yours. Seeded for the same reason the
    // widget's is: the round trip it protects is the one flow nobody already signed in can test.
    "src/routes/pithy/sign-in.test.tsx",
    "src/routes/pithy/otp.tsx",
    // A right code for a suspended or deleted account goes on to the screen for that state, not to "that
    // code didn't work". Seeded: the screen is the adopter's, and an edit that reads every failure as
    // a wrong code looks like a simplification.
    "src/routes/pithy/otp.test.tsx",
    "src/routes/pithy/callback.tsx",
    // The account lifecycle: where a suspended or deleted account lands, and where somebody acting
    // for a suspended organization does. Each says what happened, what it means, and who to ask. The third
    // is auth's rather than organization's because the account screens and it are one set, written once.
    "src/routes/pithy/account-suspended.tsx",
    "src/routes/pithy/account-deleted.tsx",
    "src/routes/pithy/organization-suspended.tsx",
  ],
  organization: [
    // One screen, and the three-arrival logic is the reason it ships at all. A headless hook would hand
    // every adopter the same three cases to get right — and the middle one, the single membership that
    // is entered without being asked *and still written*, is the one that gets written wrong.
    "src/routes/pithy/choose-organization.tsx",
    // Seeded, for the reason the turnstile gate is: the behavior it holds is one nobody already inside
    // an account can test. Leaving the chooser by a document load rather than a route change is what
    // stops the previous account's roster, header and cached lists surviving the switch — and an in-app
    // `navigate` looks identical until somebody who belongs to two accounts uses it in production.
    "src/routes/pithy/choose-organization.test.tsx",
    // Where an invitation link lands. Reading the offer is public; accepting needs a sign-in, and the sign-in comes
    // back here. Joining does not move the account in force, so the screen records the choice itself.
    "src/routes/pithy/invitation.tsx",
    // Seeded, for the chooser's reason: leaving by a document load once the joined account is in force, and writing
    // that choice at all, are both invisible to somebody who belongs to one account.
    "src/routes/pithy/invitation.test.tsx",
  ],
  mcp: [
    // The app's agent surface: the consent screen an MCP client's authorization lands on, and the screen a
    // person revokes what they approved from. Every adopter needs the identical consent screen, and it is the one
    // place in the flow where a mistake is irreversible — so it ships, rather than being left to each to get right.
    "src/routes/pithy/agent-consent.tsx",
    // Seeded: the invariant is that the application's name is never the headline and the redirect address is
    // always on the page, and the edit that breaks it looks like a restyle.
    "src/routes/pithy/agent-consent.test.tsx",
    "src/routes/pithy/connected-applications.tsx",
    // Seeded: the invariant is that the checked host is the only thing called checked, and the name an
    // application gave itself never is.
    "src/routes/pithy/connected-applications.test.tsx",
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
  consent: [
    // One screen: every purpose and where the reader stands, and a withdrawal never harder than its grant. It rides on the Worker composing `consent`, and serves visitors and accounts alike.
    "src/routes/pithy/consent.tsx",
  ],
} as const satisfies Record<string, readonly string[]>;

/** A group name this library offers. */
export type TemplateGroup = keyof typeof TEMPLATE_GROUPS;

/**
 * The templates generated in the kit rather than written by hand: their content follows the capabilities'
 * declared projections, and nothing in them is the adopter's to edit. A backfill rewrites one that differs from
 * the current emit, so a module declared since the scaffold reaches the screens the backfill adds.
 */
export const GENERATED_TEMPLATES = ["client-env.d.ts"] as const;

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
