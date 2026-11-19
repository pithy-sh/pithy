// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { i18n } from "@better-auth/i18n";
import type { AuditEmit } from "@pithy-sh/core/src/audit/recorder";
import type { BetterAuthPlugin } from "better-auth";
import { bearer } from "better-auth/plugins/bearer";
import { emailOTP } from "better-auth/plugins/email-otp";
import { jwt } from "better-auth/plugins/jwt";
import { magicLink } from "better-auth/plugins/magic-link";
import { type AuthEmailDelivery, markMessageDelivery, SEND_FAULT } from "../audit/evidence";
import { authErrorTranslations } from "../i18n/errorCopy";
import type { VerificationLedger } from "../ledger/record";
import type { AuthEmailMessage, SendAuthEmail } from "./auth";
import { providerSignInGate } from "./providerSignInGate";
import { ALL_SIGN_IN_METHODS, type SignInMethods } from "./signInMethods";

/** What the kit's own plugins need to be constructed. The subset of `AuthInstanceDeps` they read. */
export interface KitPluginDeps {
  /**
   * Which email sign-in methods to compose. Absent means both, which is what the schema baseline and an instance
   * built outside a config get.
   */
  methods?: SignInMethods;
  /** Magic-link / OTP token lifetime in seconds. */
  verificationExpiresIn: number;
  /** OTP length (digits). */
  otpLength: number;
  /** When true, sign-in never provisions a new user (existing accounts only). */
  disableSignUp: boolean;
  /** Deliver a magic link or OTP. Enqueues an email job; never sends inline. */
  sendEmail: SendAuthEmail;
  /**
   * The catalog locale this request negotiated, or `null`/absent when nothing did.
   *
   * Read from `c.var.locale` where the instance is built, which is per request — so this is the locale
   * the *project* resolved through its own configured chain, never a second negotiation of Better
   * Auth's own. Without that a reader who chose Spanish with `?lang=es` would get Spanish screens and
   * English refusals on the same page, because the two chains ask different signals in different
   * orders (#452).
   *
   * `null` is the ordinary state of a project that never composed `i18n`, and it means English — which
   * is what the plugin answers with anyway, so its absence is not a special case.
   */
  locale?: string | null;
  /**
   * Audit seam — where a refused provider sign-in records which refusal it really was (#625).
   *
   * Read by `./providerSignInGate` and by nothing else in this list. The browser gets one code for rows
   * 3 and 4 alike, so the trail is the only place the distinction survives.
   */
  emit: AuditEmit;
  /**
   * This request's headers, for the `ip` and `user-agent` a refusal row carries. Absent where no request
   * built the instance — the schema baseline, a seed, a unit test. See `./providerSignInGate`.
   */
  requestHeaders?: Headers;
  /**
   * The verification ledger (#829) — told what each send was and which mail carries it, once the email seam
   * has answered. Absent where no instance will ever send: the schema baseline in `../migrations/pluginTables.ts`.
   */
  ledger?: VerificationLedger;
}

/**
 * The kit's own, as a **tuple** rather than an array. Better Auth infers a composed instance's whole
 * `$Infer` surface from the element types of its `plugins` list, so widening this to
 * `BetterAuthPlugin[]` here would erase the adopter's plugin types one line later, where `makeAuth`
 * spreads the two lists together.
 */
export type KitPlugins = [
  // Widened where the other four are not, and it costs nothing: the translator contributes no
  // endpoints and no `$Infer` surface, so there is no adopter-visible type to erase. Its own return
  // type names an internal `MiddlewareOptions` that cannot be named from here, which is a TS4058 on
  // `makeAuth`'s declaration emit rather than anything about the composition.
  BetterAuthPlugin,
  ReturnType<typeof bearer>,
  ReturnType<typeof jwt>,
  ReturnType<typeof magicLink>,
  ReturnType<typeof emailOTP>,
  // Widened for the same reason the translator is: the gate contributes no endpoints, no schema and no
  // `$Infer` surface — it only decorates provider objects the context already holds — so there is no
  // adopter-visible type here to erase.
  BetterAuthPlugin,
];

/**
 * Build the kit's own plugins. **One definition, two readers**: `makeAuth` composes these into the
 * live instance, and the migration builder composes the same four into the baseline schema it diffs an
 * adopter's plugins against. Two copies of this list would be drift that no test could see — the
 * baseline would claim a table the instance never created, or miss one it did.
 */
export function kitPlugins(deps: KitPluginDeps): KitPlugins {
  const methods = deps.methods ?? ALL_SIGN_IN_METHODS;
  const composed: KitPlugins = [
    /**
     * Better Auth's own refusals, in the reader's language (#452).
     *
     * **First in the list deliberately.** It works by wrapping the error rendering of the plugins
     * registered around it, so anything composed before it answers in English regardless.
     *
     * `getLocale` is the whole of the integration: one chain, the project's, resolved before this
     * instance was built. The plugin's own `header`/`cookie`/`session` strategies are deliberately
     * unused — each is a second negotiation, and two chains over one page is the bug where the screens
     * and the errors disagree about who is reading.
     */
    i18n({
      translations: authErrorTranslations(),
      detection: ["callback"],
      getLocale: () => deps.locale ?? null,
    }),
    bearer(),
    jwt({ schema: { jwks: { modelName: "pithyAuthJwks" } } }),
    magicLink({
      expiresIn: deps.verificationExpiresIn,
      disableSignUp: deps.disableSignUp,
      /**
       * **The only place that knows whether a message exists** — hence `sendAndRecord`, and see
       * `../audit/evidence.ts` for why the two send events need it. `auth/magic_link_sent` claims a
       * message; the endpoint answers `200 {"status":true}` whether or not one was made, and the `after`
       * hook that writes the row cannot see the difference.
       */
      sendMagicLink: async ({ email, url, token }, ctx) => {
        await sendAndRecord(deps, { to: email, template: "magicLink", token, url }, ctx);
      },
    }),
    emailOTP({
      otpLength: deps.otpLength,
      expiresIn: deps.verificationExpiresIn,
      disableSignUp: deps.disableSignUp,
      /**
       * **Two ways this declines, and neither shows on the wire.** Better Auth calls this only after its
       * own user-enumeration guard has passed — an unregistered address that is not signing up gets the
       * verification row dropped and `200 {"success":true}`, deliberately, so a caller cannot tell a
       * registered address from a stranger's. And the kit declines again below: an OTP is a sign-in
       * credential here, and no other `type` is a message this product sends.
       *
       * So the mark sits past the early return, beside the send itself. That is what `auth/otp_sent` has
       * to mean, and reading it off the status wrote `success` for every one of these (#627).
       *
       * **And two more ways it declines, below this callback rather than above it.** The email capability
       * withholds a message to a suppressed address, and an enqueue can simply fail; `runInBackgroundOrAwait`
       * logs that failure and the endpoint still answers `200 {"success":true}`. Neither is visible from
       * here except in what `sendEmail` answers, which is why the mark is the answer and comes after it.
       */
      sendVerificationOTP: async ({ email, otp, type }, ctx) => {
        if (type !== "sign-in") return;
        await sendAndRecord(deps, { to: email, template: "otp", code: otp }, ctx);
      },
    }),
    /**
     * The provider sign-in gate (#625). **Last in the list deliberately**, and it is not a preference:
     * `runPluginInit` walks the plugins in order, so wrapping `getUserInfo` after every other kit plugin
     * has had its `init` means the wrap sits outside anything one of them did to the same objects. The
     * adopter's plugins come after this in `makeAuth`, which is the residue `./providerSignInGate`
     * states rather than hides.
     */
    providerSignInGate({ emit: deps.emit, headers: deps.requestHeaders }),
  ];
  const absent = new Set<string>([
    ...(methods.magicLink ? [] : ["magic-link"]),
    ...(methods.emailOtp ? [] : ["email-otp"]),
  ]);
  if (absent.size === 0) return composed;
  // The tuple type stays the full set, so a composed instance's type surface still names an email method it left
  // out; the routes are what answer 404.
  return composed.filter((plugin) => !absent.has(plugin.id)) as unknown as KitPlugins;
}

/**
 * Hand one message to the email seam and record what the seam answered.
 *
 * **After the await, and the answer rather than the attempt — that pair is #627's last hole.** The
 * previous revision marked the evidence *before* `sendEmail` was awaited and discarded its result, so
 * `@pithy-sh/email` deciding to withhold a message, or failing to queue one at all, was invisible to the
 * event that claims the message exists. Both wrote `auth/otp_sent outcome=success` over a
 * `200 {"success":true}`, for an unauthenticated caller, on the default composition.
 *
 * **A throw is marked and re-thrown, never swallowed.** Swallowing would move the wire —
 * `/sign-in/magic-link` awaits this callback directly and answers 500 when it throws, while
 * `/email-otp/send-verification-otp` routes it through `runInBackgroundOrAwait`, which logs and answers
 * 200 either way. Nothing here decides a status; it records what happened underneath one. The recorded
 * reason is {@link SEND_FAULT} and never the error's own text: an audit row is long-lived and queryable,
 * and a thrown message is the one value in reach that nobody has vetted.
 */
async function sendAndRecord(
  deps: KitPluginDeps,
  message: AuthEmailMessage,
  ctx: { context?: unknown } | undefined,
): Promise<void> {
  const requestContext = ctx?.context;
  const type = message.template === "magicLink" ? "magic_link" : "otp";
  let delivery: AuthEmailDelivery;
  try {
    delivery = await deps.sendEmail(message);
  } catch (error) {
    markMessageDelivery(requestContext, { delivery: "failed", reason: SEND_FAULT });
    // The link exists whether or not its mail does, so the ledger counts it, with no job to join.
    await deps.ledger?.issued(requestContext, { type, email: message.to, emailJobId: null });
    throw error;
  }
  markMessageDelivery(requestContext, delivery);
  // A withheld message has a job too — the suppressed row — and that row is what a reader joins a
  // suppression on, so it is recorded exactly like a queued one.
  await deps.ledger?.issued(requestContext, {
    type,
    email: message.to,
    emailJobId: delivery.delivery === "failed" ? null : (delivery.jobId ?? null),
  });
}
