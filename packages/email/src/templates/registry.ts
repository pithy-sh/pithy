// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import type { EmailKind, TemplateCategory } from "../data/enums";
import { NoticeSeverity } from "./severity";
import type { ContentWidth } from "./theme";

/**
 * The template set. The **typed input contract is the real deliverable**: each template declares a Zod
 * payload schema — its documented, validated variable set — plus a `category` that drives tracking
 * defaults and a `kind` that decides whether the message can be refused. Visual polish is explicitly
 * secondary. Bodies are Handlebars
 * (`{{var}}`, `{{#each}}`, `{{#if}}`) and include the shared `{{> emailHead}}` / `{{> emailFoot}}`
 * partials, so every template inherits the light/dark theme and the Gmail-safe shell; `links` names the
 * URL locations the engine rewrites for click tracking.
 *
 * ## This map is closed to adopters, and that is a decision rather than an omission
 *
 * There is no `registerTemplate`. An adopter composing `email` sends what is in this file, and the
 * argument for that — with what it costs, and what the kit owes in exchange — is in this package's
 * template model at https://pithy.sh/docs/capabilities/email/template-model. The short form is three things, of which the first is not
 * negotiable by design taste:
 *
 * 1. **The Workers runtime forbids code generation**, so a template cannot be compiled where it runs.
 *    Every body here is turned into a spec by `scripts/precompile.ts` at build time. Accepting an
 *    adopter's template means accepting a *precompiled spec* built by their own Handlebars, and
 *    Handlebars refuses a spec whose compiler revision differs from the runtime's — a version skew
 *    nobody would see until every email failed to render at once.
 * 2. **The kind would go back to being a claim.** #281's fix rests on a call site being unable to
 *    assert that a message is transactional; a registerable template makes that assertion writable
 *    again, and the mail it produces ignores an unsubscribe under the adopter's own sending domain.
 * 3. **Escaping is structural here, not conventional.** `testerNudge` and `supportReply` are safe
 *    because their bodies are fixed and the words arrive as escaped values. A supplied body with one
 *    `{{{triple}}}` is a phishing page sent over the adopter's DKIM signature.
 *
 * What the closure obliges instead: where a shape is missing, the kit adds it, and where the *words*
 * are the adopter's, the template takes them as payload. `supportReply`, `testerNudge` and
 * `operationalNotice` are all that pattern — the kit owns the shell, the caller owns the copy.
 */

/** A URL location within a payload that the engine may rewrite to a tracked click callback. A `path`
 *  is a top-level key (`"url"`) or an array element field (`"articles[].link"`). */
export interface LinkSpec {
  /** The payload path to the URL: a key, or `key[].subkey` for each element of an array. */
  path: string;
  /** The link's identity/label, recorded on the click event for attribution. */
  label: string;
}

/** One template: its id, category, kind, payload schema, Handlebars sources, and trackable link locations. */
export interface EmailTemplate {
  /** The template id used to enqueue and render (e.g. `magicLink`). */
  id: string;
  /** What the message is — drives tracking defaults, and makes an unsubscribe link mandatory for `marketing`. */
  category: TemplateCategory;
  /**
   * Whether a recipient may refuse this message.
   *
   * **Required, and declared here rather than passed at the call site.** If "is this transactional" were
   * an argument, a caller could get it wrong, and the failure mode is an account nobody can reach: a
   * magic link sent as elective is a magic link an unrelated unsubscribe silently swallows. Templates
   * are this capability's own — an adopter cannot register one — so declaring the kind on the template
   * makes the wrong thing impossible to write rather than merely discouraged. There is no default, for
   * the same reason: a forgotten field must be a type error, not a silent lockout.
   */
  kind: EmailKind;
  /** The body width this template renders at — a property of the email type, not the brand theme. */
  width: ContentWidth;
  /** The Zod payload schema — the validated, documented input-variable contract. */
  payload: z.ZodType;
  /** The subject line, as a Handlebars source over the payload + theme. */
  subject: string;
  /** The HTML body, as a Handlebars source including the shared header/footer partials. */
  html: string;
  /** The plain-text body, as a Handlebars source. Always shipped alongside HTML. */
  text: string;
  /** The URL locations the engine rewrites when click tracking is on. */
  links: LinkSpec[];
}

/** The accent CTA button, with a VML fallback so it renders solid in Outlook. Ink text reads on saffron in both modes. */
function button(urlVar: string, label: string): string {
  return `<!--[if mso]><v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="{{${urlVar}}}" style="height:44px;v-text-anchor:middle;width:220px;" arcsize="16%" fillcolor="{{theme.accent}}" stroke="f"><w:anchorlock/><center style="color:#111111;font-family:sans-serif;font-size:14px;font-weight:600;">${label}</center></v:roundrect><![endif]--><!--[if !mso]><!--><a href="{{${urlVar}}}" style="display:inline-block; margin:24px 0; background-color:{{theme.accent}}; color:#111111; font-size:14px; font-weight:600; text-decoration:none; padding:13px 26px; border-radius:8px">${label}</a><!--<![endif]-->`;
}

/** A heading in the primary text color (dark-mode aware via the t-ink class). */
function heading(text: string): string {
  return `<h1 class="t-ink" style="margin:0 0 16px; font-size:22px; font-weight:600; letter-spacing:-0.02em; color:{{theme.light.text}}">${text}</h1>`;
}

/** A hairline separator that flips color in dark mode via the sep class. */
const sep = `<div role="separator" class="sep" style="background-color:{{theme.light.separator}}; height:1px; line-height:1px; margin:28px 0">&zwj;</div>`;

/** Wrap a body fragment in the shared head/footer partials. */
function layout(body: string): string {
  return `{{> emailHead}}${body}{{> emailFoot}}`;
}

/**
 * The salutation every kit-authored template opens with, named when the payload carries a name.
 *
 * Two catalog keys rather than one sentence with an optional placeholder: a language that greets an
 * unnamed reader differently — not merely with the name deleted — has nowhere to say so otherwise.
 * `{{#if name}}` stays in the template because the *choice* is structural and the *words* are not.
 */
const greeting = `{{#if name}}{{t "email/shell.greeting_named" name=name}}{{else}}{{t "email/shell.greeting"}}{{/if}}`;

// --- Payload schemas (the typed contracts) ---

const MagicLinkPayload = z
  .object({
    name: z.string().optional().describe("The recipient's name, for a personal greeting. Optional."),
    url: z.string().describe("The single-use magic sign-in link. Tracked when click tracking is on."),
    expiresMinutes: z.number().int().describe("How many minutes until the link expires, shown to the recipient."),
  })
  .describe("Inputs for the passwordless magic-link sign-in email.");

const OtpPayload = z
  .object({
    name: z.string().optional().describe("The recipient's name, for a personal greeting. Optional."),
    code: z.string().describe("The one-time verification code to display prominently."),
    expiresMinutes: z.number().int().describe("How many minutes until the code expires, shown to the recipient."),
  })
  .describe("Inputs for the one-time-passcode (OTP) verification email.");

const WelcomePayload = z
  .object({
    name: z.string().describe("The new user's name, for the greeting."),
    ctaUrl: z.string().describe("The link to get started (dashboard, onboarding). Tracked when click tracking is on."),
    ctaLabel: z.string().describe("The call-to-action button label, e.g. `Open your dashboard`."),
  })
  .describe("Inputs for the post-signup welcome email.");

const SecurityAlertPayload = z
  .object({
    name: z.string().optional().describe("The recipient's name, for a personal greeting. Optional."),
    event: z.string().describe("A short description of the security event, e.g. `New sign-in from Chrome on macOS`."),
    when: z.string().describe("A human-readable timestamp of the event."),
    ipAddress: z.string().optional().describe("The originating IP address, if known. Optional."),
    actionUrl: z
      .string()
      .describe("A link to review activity or secure the account. Tracked when click tracking is on."),
  })
  .describe("Inputs for a security-alert email (new sign-in, settings change, etc.).");

const InvitePayload = z
  .object({
    inviterName: z.string().describe("The name of the person who sent the invitation."),
    organizationName: z.string().describe("The team or organization the recipient is invited to."),
    acceptUrl: z.string().describe("The link to accept the invitation. Tracked when click tracking is on."),
  })
  .describe("Inputs for a team/organization invitation email.");

/**
 * The one template `@pithy-sh/testers` sends everything through — invitations, confirmations, and every
 * nudge kind.
 *
 * **`paragraphs` is an array of plain strings, and that is the security boundary.** A control-plane
 * caller may supply the words of a nudge, and those words go out over the adopter's own DKIM signature
 * to the adopter's own users. Rendering them through `{{this}}` means Handlebars escapes every one of
 * them, so supplied markup arrives as visible text rather than as markup — structurally, not because a
 * filter guessed right about what to strip. A single `body` string with `{{{triple}}}` interpolation
 * would turn a leaked dashboard credential into a phishing platform running from a trusted domain.
 *
 * One template rather than one per nudge kind, because the kinds differ only in their words, and the
 * words are the half this template deliberately does not own.
 */
const TesterNudgePayload = z
  .object({
    subject: z
      .string()
      .describe(
        "The subject line. Bounded and stripped of control characters by the testers capability before it arrives.",
      ),
    heading: z.string().describe("The email's heading. Always supplied by the testers capability, never by a caller."),
    paragraphs: z
      .array(z.string())
      .describe(
        "The body, as one plain string per paragraph. Each renders HTML-escaped, which is what makes caller-supplied copy safe to send over the adopter's own sending domain.",
      ),
    ctaUrl: z
      .string()
      .optional()
      .describe("The confirmation link, when the message carries one. Tracked when click tracking is on."),
    ctaLabel: z.string().optional().describe("The button label. Only rendered when `ctaUrl` is present."),
    footnote: z
      .string()
      .optional()
      .describe(
        "A closing line in muted type — used for the honesty note about who actually decides the test's outcome.",
      ),
    optOutUrl: z
      .string()
      .optional()
      .describe(
        "The tester's own way out, rendered as a footer link. Transactional mail carries no unsubscribe by default, but a testing program asks one person for something repeatedly over a fortnight, so someone being chased must be able to stop it.",
      ),
    optOutLabel: z
      .string()
      .optional()
      .describe(
        "The wording of that link. Supplied by the capability, never by a caller. Only rendered with `optOutUrl`.",
      ),
  })
  .describe(
    "Inputs for a testing-cohort invitation, confirmation, or nudge. The words may be supplied; the shell never is.",
  );

const PasswordChangedPayload = z
  .object({
    name: z.string().optional().describe("The recipient's name, for a personal greeting. Optional."),
    when: z.string().describe("A human-readable timestamp of when the credential changed."),
    supportUrl: z
      .string()
      .describe("A link to contact support if the change was not the recipient. Tracked when click tracking is on."),
  })
  .describe("Inputs for the account-credential-changed security notice.");

/** One labeled fact in an operational notice — what makes the notice specific rather than a mood. */
const OperationalNoticeFact = z
  .object({
    label: z.string().describe("What this fact is: `Environment`, `Last rotated`, `Version`, `Owner`."),
    value: z
      .string()
      .describe("The fact itself, as text. Rendered HTML-escaped — it is a value read off a system, never markup."),
  })
  .describe("One label/value row in an operational notice's fact table.");

/**
 * The operational notice: *something about your own infrastructure changed or needs attention*.
 *
 * **It is not `securityAlert`, and the difference is the whole reason it exists.** That template is
 * about a session — it describes a sign-in and closes with "if this was you, no action is needed",
 * which is the opposite of what an overdue secret or a security release means. This one assumes the
 * recipient is the operator and that the fact is true; there is nothing to confirm, only something to
 * do or to know.
 *
 * **One template rather than one per notice, and one per capability is what it replaces.** A rotation
 * that failed, a release with a security fix, a connection that stopped answering and a job retrying
 * for a day differ only in their words and their urgency. Both of those are payload. What is fixed —
 * the shell, the escaping, the kind, the severity vocabulary — is what the kit is for.
 *
 * The severity is required and has no default. A default would be `info`, and a capability that forgot
 * the field would then send a critical fault at the volume of a newsletter.
 */
export const OperationalNoticePayload = z
  .object({
    severity: NoticeSeverity.describe(
      "How urgent this is. Sets the subject-line label (`Notice:` / `Action needed:` / `Critical:`), so the level is visible in the inbox before the message is opened.",
    ),
    summary: z
      .string()
      .describe("What happened, in one line. It is the subject after the severity label, and the heading in the body."),
    thing: z
      .string()
      .describe(
        "What it happened to, named the way an operator would recognize it: `STRIPE_SECRET_KEY`, `@pithy-sh/auth`, `acme-prod-db`. A notice that does not name its subject cannot be acted on.",
      ),
    when: z
      .string()
      .describe(
        "When it happened, human-readable (`2 hours ago`, `18 June, 14:02 UTC`). Formatted by the caller, who knows the recipient's locale and whether an exact time matters.",
      ),
    detail: z
      .string()
      .optional()
      .describe(
        "One paragraph explaining what it means or what to do. Rendered HTML-escaped as a single block. Optional — the summary and the facts already stand alone.",
      ),
    facts: z
      .array(OperationalNoticeFact)
      .default([])
      .describe(
        "Supporting facts as label/value rows — version, environment, last success, owner. Empty renders nothing at all rather than an empty table.",
      ),
    actionUrl: z
      .string()
      .optional()
      .describe(
        "The one place this can be acted on. Optional, because a caller with nowhere to send somebody would otherwise invent a link, and a dead link in a critical notice is worse than none. Tracked when click tracking is on.",
      ),
    actionLabel: z
      .string()
      .default("Open")
      .describe("The button's words. Only rendered alongside `actionUrl`; defaults to a plain `Open`."),
  })
  .describe(
    "Inputs for an operational notice — what happened, to what, when, how serious, and one place to act on it.",
  );
/**
 * `z.input`, not `z.output`: `facts` and `actionLabel` carry defaults, so the parsed shape is the
 * renderer's and this one is the caller's. It is exported because a capability building a notice should
 * be told at compile time that it forgot the severity — the payload reaches `enqueueEmail` as
 * `unknown`, and a Zod failure there is a runtime error in a code path that only runs when something is
 * already wrong.
 */
export type OperationalNoticePayload = z.input<typeof OperationalNoticePayload>;

const NewsletterArticle = z
  .object({
    title: z.string().describe("The article headline."),
    summary: z.string().describe("A one- or two-sentence summary shown under the headline."),
    link: z.string().describe("The link to the full article. Tracked when click tracking is on."),
    featureImage: z.string().optional().describe("An absolute URL of a header image for the article. Optional."),
  })
  .describe("One article block in a newsletter's iterable list.");

const NewsletterPayload = z
  .object({
    subject: z.string().describe("The newsletter subject line."),
    intro: z.string().describe("The opening paragraph above the article list."),
    articles: z.array(NewsletterArticle).describe("The iterable list of article blocks rendered with `{{#each}}`."),
    outro: z.string().optional().describe("An optional closing paragraph below the article list."),
  })
  .describe("Inputs for the newsletter email — opening copy plus an iterable list of articles.");

const LeadCapturePayload = z
  .object({
    name: z.string().optional().describe("The lead's name, for a personal greeting. Optional."),
    assetName: z.string().describe("The name of the downloadable asset, e.g. `The 2026 Backend Playbook`."),
    assetUrl: z.string().describe("The link to download the asset. Tracked when click tracking is on."),
    message: z.string().optional().describe("An optional custom message above the download link."),
  })
  .describe("Inputs for the lead-capture delivery email (a notice with a link to a downloadable asset).");

const MarketingCampaignPayload = z
  .object({
    subject: z.string().describe("The campaign subject line."),
    heading: z.string().describe("The headline at the top of the body."),
    body: z.string().describe("The main campaign copy. Plain text rendered into a paragraph."),
    ctaUrl: z.string().describe("The campaign call-to-action link. Tracked when click tracking is on."),
    ctaLabel: z.string().describe("The call-to-action button label."),
  })
  .describe("Inputs for a per-user marketing campaign email (tracking-enabled, marketing category).");

/**
 * The one template `@pithy-sh/support` sends through.
 *
 * **One template, not one per canned reply.** The wording of a support answer belongs to the adopter
 * and changes on a Tuesday; a Handlebars body here is precompiled at build time and changes on a
 * release. So this is the *shell* — the theme, the HTML and text pair, the shape a reply arrives in —
 * and the words are `body`, chosen and edited by a human in the dashboard from the catalog
 * `@pithy-sh/support` federates. The machine's job is a better blank page, not the letter.
 *
 * `{{body}}` is Handlebars-escaped, which matters more here than anywhere else in this file: it is
 * the only template whose payload is free text somebody typed rather than a value this codebase
 * produced.
 */
const SupportReplyPayload = z
  .object({
    subject: z.string().describe("The reply's subject line, already `Re:`-prefixed by the support capability."),
    body: z
      .string()
      .describe(
        "The reply text a human wrote. Rendered as paragraphs, HTML-escaped — it is free text from an operator, never markup.",
      ),
    agentName: z
      .string()
      .optional()
      .describe("Who is answering, signed at the bottom. Optional; omitted rather than guessed."),
  })
  .describe("Inputs for a support reply — the shell around text a human wrote and edited.");

/** The full template set, keyed by id. */
export const templates: Record<string, EmailTemplate> = {
  magicLink: {
    id: "magicLink",
    category: "transactional",
    // The kind that matters most in this file. Passwordless is the kit's sign-in and there is no
    // password to fall back to, so an unsubscribe that reached this template would not withhold a
    // preference — it would make the account permanently unreachable, silently, from both ends.
    kind: "transactional",
    width: "narrow",
    payload: MagicLinkPayload,
    subject: `{{t "email/magic_link.subject"}}`,
    html: layout(
      `${heading('{{t "email/magic_link.heading"}}')}<p style="margin:0 0 16px">${greeting} {{t "email/magic_link.instruction"}} {{tn "email/magic_link.expiry" count=expiresMinutes}}</p>${button("url", '{{t "email/magic_link.cta"}}')}<p class="t-subtle" style="margin:16px 0 0; font-size:13px; color:{{theme.light.textSubtle}}">{{t "email/magic_link.ignore"}}</p>`,
    ),
    text: `${greeting}\n\n{{tn "email/magic_link.text_instruction" count=expiresMinutes}}\n{{url}}\n\n{{t "email/magic_link.text_ignore"}}`,
    links: [{ path: "url", label: "magic-link" }],
  },
  otp: {
    id: "otp",
    category: "transactional",
    kind: "transactional",
    width: "narrow",
    payload: OtpPayload,
    subject: `{{t "email/otp.subject"}}`,
    html: layout(
      `${heading('{{t "email/otp.heading"}}')}<p style="margin:0 0 12px">${greeting} {{t "email/otp.lead"}}</p><p class="t-ink" style="font-size:32px; font-weight:700; letter-spacing:6px; color:{{theme.accent}}; margin:16px 0">{{code}}</p><p style="margin:0">{{tn "email/otp.expiry" count=expiresMinutes}}</p>`,
    ),
    text: `${greeting}\n\n{{tn "email/otp.text_body" count=expiresMinutes code=code}}`,
    links: [],
  },
  welcome: {
    id: "welcome",
    category: "transactional",
    kind: "transactional",
    width: "narrow",
    payload: WelcomePayload,
    subject: `{{t "email/welcome.subject" app=theme.appName}}`,
    html: layout(
      `${heading('{{t "email/welcome.heading" app=theme.appName}}')}<p style="margin:0 0 8px">{{t "email/welcome.body" name=name app=theme.appName}}</p>${button("ctaUrl", "{{ctaLabel}}")}`,
    ),
    text: `{{t "email/shell.greeting_named" name=name}}\n\n{{t "email/welcome.text_body" app=theme.appName}}\n\n{{ctaLabel}}: {{ctaUrl}}`,
    links: [{ path: "ctaUrl", label: "welcome-cta" }],
  },
  securityAlert: {
    id: "securityAlert",
    category: "transactional",
    kind: "transactional",
    width: "narrow",
    payload: SecurityAlertPayload,
    subject: `{{t "email/security_alert.subject" event=event}}`,
    html: layout(
      `${heading('{{t "email/security_alert.heading"}}')}<p style="margin:0 0 8px">${greeting} {{t "email/security_alert.body" event=event when=when}}{{#if ipAddress}} {{t "email/security_alert.ip" ip=ipAddress}}{{/if}}</p><p style="margin:0 0 8px">{{t "email/security_alert.reassure"}}</p>${button("actionUrl", '{{t "email/security_alert.cta"}}')}`,
    ),
    text: `${greeting}\n\n{{t "email/security_alert.body" event=event when=when}}{{#if ipAddress}} {{t "email/security_alert.text_ip" ip=ipAddress}}{{/if}}\n\n{{t "email/security_alert.text_action"}} {{actionUrl}}`,
    links: [{ path: "actionUrl", label: "security-action" }],
  },
  invite: {
    id: "invite",
    category: "transactional",
    kind: "transactional",
    width: "narrow",
    payload: InvitePayload,
    subject: `{{t "email/invite.subject" inviter=inviterName organization=organizationName}}`,
    html: layout(
      `${heading('{{t "email/invite.heading"}}')}<p style="margin:0 0 8px">{{t "email/invite.body" inviter=inviterName organization=organizationName app=theme.appName}}</p>${button("acceptUrl", '{{t "email/invite.cta"}}')}`,
    ),
    text: `{{t "email/invite.body" inviter=inviterName organization=organizationName app=theme.appName}}\n\n{{t "email/invite.text_accept"}} {{acceptUrl}}`,
    links: [{ path: "acceptUrl", label: "invite-accept" }],
  },
  testerNudge: {
    id: "testerNudge",
    category: "transactional",
    // Elective, though the category is transactional — the two axes genuinely disagree here and this is
    // the template that proves they are separate. A testing program chases one person repeatedly over
    // a fortnight, so somebody who said "stop emailing me" means this mail, and it is the mail an
    // unsubscribe must stop. Nothing is locked by withholding it: a tester who never confirms simply
    // lapses, which is already a state the cohort handles.
    kind: "elective",
    width: "narrow",
    payload: TesterNudgePayload,
    subject: "{{subject}}",
    html: layout(
      `{{#if heading}}<h1 class="t-ink" style="margin:0 0 16px; font-size:22px; font-weight:600; letter-spacing:-0.02em; color:{{theme.light.text}}">{{heading}}</h1>{{/if}}{{#each paragraphs}}<p style="margin:0 0 16px">{{this}}</p>{{/each}}{{#if ctaUrl}}${button("ctaUrl", "{{ctaLabel}}")}{{/if}}{{#if footnote}}<p class="t-subtle" style="margin:16px 0 0; font-size:13px; color:{{theme.light.textSubtle}}">{{footnote}}</p>{{/if}}{{#if optOutUrl}}<p class="t-subtle" style="margin:20px 0 0; font-size:13px; color:{{theme.light.textSubtle}}"><a href="{{optOutUrl}}" class="hover-underline t-subtle" style="color:{{theme.light.textSubtle}}; text-decoration:underline">{{optOutLabel}}</a></p>{{/if}}`,
    ),
    text: "{{heading}}\n\n{{#each paragraphs}}{{this}}\n\n{{/each}}{{#if ctaUrl}}{{ctaLabel}}: {{ctaUrl}}\n\n{{/if}}{{#if footnote}}{{footnote}}\n\n{{/if}}{{#if optOutUrl}}{{optOutLabel}}: {{optOutUrl}}{{/if}}",
    links: [{ path: "ctaUrl", label: "tester-confirm" }],
  },
  passwordChanged: {
    id: "passwordChanged",
    category: "transactional",
    kind: "transactional",
    width: "narrow",
    payload: PasswordChangedPayload,
    subject: `{{t "email/password_changed.subject"}}`,
    html: layout(
      `${heading('{{t "email/password_changed.heading"}}')}<p style="margin:0 0 8px">${greeting} {{t "email/password_changed.body" when=when}}</p><p style="margin:0 0 8px">{{t "email/password_changed.warn"}}</p>${button("supportUrl", '{{t "email/password_changed.cta"}}')}`,
    ),
    text: `${greeting}\n\n{{t "email/password_changed.text_body" when=when}} {{supportUrl}}`,
    links: [{ path: "supportUrl", label: "password-support" }],
  },
  operationalNotice: {
    id: "operationalNotice",
    category: "transactional",
    // Transactional in both axes. An operator who unsubscribed from a product newsletter has not asked
    // to stop being told their secret expired — and unlike a nudge, nothing here is a request they can
    // let lapse. The notice is about infrastructure they are responsible for.
    kind: "transactional",
    width: "narrow",
    payload: OperationalNoticePayload,
    // The label leads the subject, so the severity is legible in a list of forty unread messages. It is
    // also why the summary is one line: everything after `Critical: ` competes with the sender name for
    // the width of a phone.
    subject: "{{severityLabel severity}}: {{summary}}",
    html: layout(
      // The severity renders as a word in color, not as a color. `sev-{{severity}}` is the dark-mode
      // hook (the class is safe to interpolate: the value is enum-constrained before it reaches here),
      // and `severityColor` supplies the light value inline, the way every other color in this shell
      // is applied.
      `<p class="sev-{{severity}}" style="margin:0 0 10px; font-size:12px; font-weight:700; letter-spacing:0.08em; text-transform:uppercase; color:{{severityColor severity}}">{{severityLabel severity}}</p>${heading("{{summary}}")}<p class="t-subtle" style="margin:0 0 20px; font-size:13px; color:{{theme.light.textSubtle}}">{{thing}} &middot; {{when}}</p>{{#if detail}}<p style="margin:0 0 16px">{{detail}}</p>{{/if}}{{#if facts.length}}<table cellpadding="0" cellspacing="0" role="none" style="width:100%; margin:0 0 8px">{{#each facts}}<tr><td class="t-subtle" style="padding:4px 16px 4px 0; font-size:13px; color:{{../theme.light.textSubtle}}; vertical-align:top">{{label}}</td><td class="t-ink" style="padding:4px 0; font-size:13px; color:{{../theme.light.text}}; vertical-align:top">{{value}}</td></tr>{{/each}}</table>{{/if}}{{#if actionUrl}}${button("actionUrl", "{{actionLabel}}")}{{/if}}`,
    ),
    text: "{{severityLabel severity}} — {{summary}}\n\n{{thing}}\n{{when}}\n\n{{#if detail}}{{detail}}\n\n{{/if}}{{#each facts}}{{label}}: {{value}}\n{{/each}}{{#if actionUrl}}\n{{actionLabel}}: {{actionUrl}}{{/if}}",
    links: [{ path: "actionUrl", label: "operational-action" }],
  },
  supportReply: {
    id: "supportReply",
    category: "transactional",
    kind: "transactional",
    // Wide: a support reply is prose, frequently quoting the customer back at themselves, and the
    // narrow shell is sized for a button and a sentence.
    width: "wide",
    payload: SupportReplyPayload,
    subject: "{{subject}}",
    html: layout(
      // No heading, and no button. A reply that opened with a headline would read as a broadcast —
      // the whole point is that it looks like a person wrote it, because one did. `linebreaks` keeps
      // the operator's paragraphing while Handlebars still escapes the content.
      `<div style="margin:0 0 16px; white-space:pre-wrap">{{body}}</div>{{#if agentName}}<p class="t-subtle" style="margin:24px 0 0; font-size:14px">— {{agentName}}</p>{{/if}}`,
    ),
    text: "{{body}}{{#if agentName}}\n\n— {{agentName}}{{/if}}",
    // Deliberately none. Rewriting a link a human typed into a tracked redirect would put a
    // marketing URL in a one-to-one reply, and a support answer is a letter, not a campaign.
    links: [],
  },
  newsletter: {
    id: "newsletter",
    category: "marketing",
    kind: "elective",
    width: "wide",
    payload: NewsletterPayload,
    subject: "{{subject}}",
    html: layout(
      `<p style="margin:0 0 8px">{{intro}}</p>{{#each articles}}${sep}{{#if featureImage}}<a href="{{link}}"><img src="{{featureImage}}" alt="{{title}}" width="100%" style="height:180px; width:100%; object-fit:cover; border-radius:8px; margin-bottom:12px; border:0" /></a>{{/if}}<h2 class="t-ink" style="margin:0 0 8px; font-size:19px; font-weight:600; letter-spacing:-0.02em; color:{{../theme.light.text}}">{{title}}</h2><p style="margin:0 0 8px">{{summary}}</p><a href="{{link}}" class="t-ink" style="color:{{../theme.light.text}}; font-weight:600; text-decoration:none">Read more &rarr;</a>{{/each}}{{#if outro}}${sep}<p style="margin:0">{{outro}}</p>{{/if}}`,
    ),
    text: "{{intro}}\n\n{{#each articles}}{{title}}\n{{summary}}\n{{link}}\n\n{{/each}}{{#if outro}}{{outro}}{{/if}}",
    links: [{ path: "articles[].link", label: "newsletter-article" }],
  },
  leadCapture: {
    id: "leadCapture",
    category: "transactional",
    // A lead magnet is list-building wearing a receipt's clothes, so it is elective even though the
    // delivery answers something the person just did. Refusing it costs them a download they can get
    // another way; sending it to somebody who opted out is exactly the mail they refused, and the
    // complaint that follows is charged to the adopter's sending domain.
    kind: "elective",
    width: "narrow",
    payload: LeadCapturePayload,
    subject: `{{t "email/lead_capture.subject" asset=assetName}}`,
    html: layout(
      `${heading('{{t "email/lead_capture.heading"}}')}<p style="margin:0 0 8px">${greeting}</p>{{#if message}}<p style="margin:0 0 8px">{{message}}</p>{{/if}}<p style="margin:0 0 8px">{{t "email/lead_capture.ready" asset=assetName}}</p>${button("assetUrl", '{{t "email/lead_capture.cta"}}')}`,
    ),
    text: `${greeting}\n\n{{#if message}}{{message}}\n\n{{/if}}{{t "email/lead_capture.text_ready" asset=assetName}} {{assetUrl}}`,
    links: [{ path: "assetUrl", label: "lead-asset" }],
  },
  marketingCampaign: {
    id: "marketingCampaign",
    category: "marketing",
    kind: "elective",
    width: "narrow",
    payload: MarketingCampaignPayload,
    subject: "{{subject}}",
    html: layout(`${heading("{{heading}}")}<p style="margin:0 0 8px">{{body}}</p>${button("ctaUrl", "{{ctaLabel}}")}`),
    text: "{{heading}}\n\n{{body}}\n\n{{ctaLabel}}: {{ctaUrl}}",
    links: [{ path: "ctaUrl", label: "campaign-cta" }],
  },
};
