// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import type { TemplateCategory } from "../data/enums";
import type { ContentWidth } from "./theme";

/**
 * The template set. The **typed input contract is the real deliverable**: each template declares a Zod
 * payload schema — its documented, validated variable set — plus a `category` that drives unsubscribe
 * enforcement and tracking defaults. Visual polish is explicitly secondary. Bodies are Handlebars
 * (`{{var}}`, `{{#each}}`, `{{#if}}`) and include the shared `{{> emailHead}}` / `{{> emailFoot}}`
 * partials, so every template inherits the light/dark theme and the Gmail-safe shell; `links` names the
 * URL locations the engine rewrites for click tracking.
 */

/** A URL location within a payload that the engine may rewrite to a tracked click callback. A `path`
 *  is a top-level key (`"url"`) or an array element field (`"articles[].link"`). */
export interface LinkSpec {
  /** The payload path to the URL: a key, or `key[].subkey` for each element of an array. */
  path: string;
  /** The link's identity/label, recorded on the click event for attribution. */
  label: string;
}

/** One template: its id, category, payload schema, Handlebars sources, and trackable link locations. */
export interface EmailTemplate {
  /** The template id used to enqueue and render (e.g. `magicLink`). */
  id: string;
  /** The category — `transactional` never carries an unsubscribe link; `marketing` always must. */
  category: TemplateCategory;
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

const PasswordChangedPayload = z
  .object({
    name: z.string().optional().describe("The recipient's name, for a personal greeting. Optional."),
    when: z.string().describe("A human-readable timestamp of when the credential changed."),
    supportUrl: z
      .string()
      .describe("A link to contact support if the change was not the recipient. Tracked when click tracking is on."),
  })
  .describe("Inputs for the account-credential-changed security notice.");

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

/** The full template set, keyed by id. */
export const templates: Record<string, EmailTemplate> = {
  magicLink: {
    id: "magicLink",
    category: "transactional",
    width: "narrow",
    payload: MagicLinkPayload,
    subject: "Your sign-in link",
    html: layout(
      `${heading("Sign in")}<p style="margin:0 0 16px">Hi{{#if name}} {{name}}{{/if}}, use the button below to sign in. It expires in {{expiresMinutes}} minutes.</p>${button("url", "Sign in")}<p class="t-subtle" style="margin:16px 0 0; font-size:13px; color:{{theme.light.textSubtle}}">If you didn't request this, you can ignore this email.</p>`,
    ),
    text: "Hi{{#if name}} {{name}}{{/if}},\n\nUse this link to sign in (expires in {{expiresMinutes}} minutes):\n{{url}}\n\nIf you didn't request this, ignore this email.",
    links: [{ path: "url", label: "magic-link" }],
  },
  otp: {
    id: "otp",
    category: "transactional",
    width: "narrow",
    payload: OtpPayload,
    subject: "Your verification code",
    html: layout(
      `${heading("Your code")}<p style="margin:0 0 12px">Hi{{#if name}} {{name}}{{/if}}, your verification code is:</p><p class="t-ink" style="font-size:32px; font-weight:700; letter-spacing:6px; color:{{theme.accent}}; margin:16px 0">{{code}}</p><p style="margin:0">It expires in {{expiresMinutes}} minutes.</p>`,
    ),
    text: "Hi{{#if name}} {{name}}{{/if}},\n\nYour verification code is {{code}}. It expires in {{expiresMinutes}} minutes.",
    links: [],
  },
  welcome: {
    id: "welcome",
    category: "transactional",
    width: "narrow",
    payload: WelcomePayload,
    subject: "Welcome to {{theme.appName}}",
    html: layout(
      `${heading("Welcome to {{theme.appName}}")}<p style="margin:0 0 8px">Hi {{name}}, welcome to {{theme.appName}}. We're glad you're here.</p>${button("ctaUrl", "{{ctaLabel}}")}`,
    ),
    text: "Hi {{name}},\n\nWelcome to {{theme.appName}}. We're glad you're here.\n\n{{ctaLabel}}: {{ctaUrl}}",
    links: [{ path: "ctaUrl", label: "welcome-cta" }],
  },
  securityAlert: {
    id: "securityAlert",
    category: "transactional",
    width: "narrow",
    payload: SecurityAlertPayload,
    subject: "Security alert: {{event}}",
    html: layout(
      `${heading("Security alert")}<p style="margin:0 0 8px">Hi{{#if name}} {{name}}{{/if}}, {{event}} on {{when}}.{{#if ipAddress}} IP address: {{ipAddress}}.{{/if}}</p><p style="margin:0 0 8px">If this was you, no action is needed.</p>${button("actionUrl", "Review activity")}`,
    ),
    text: "Hi{{#if name}} {{name}}{{/if}},\n\n{{event}} on {{when}}.{{#if ipAddress}} IP: {{ipAddress}}.{{/if}}\n\nIf this wasn't you, secure your account: {{actionUrl}}",
    links: [{ path: "actionUrl", label: "security-action" }],
  },
  invite: {
    id: "invite",
    category: "transactional",
    width: "narrow",
    payload: InvitePayload,
    subject: "{{inviterName}} invited you to {{organizationName}}",
    html: layout(
      `${heading("You're invited")}<p style="margin:0 0 8px">{{inviterName}} invited you to join <strong class="t-ink" style="color:{{theme.light.text}}">{{organizationName}}</strong> on {{theme.appName}}.</p>${button("acceptUrl", "Accept invitation")}`,
    ),
    text: "{{inviterName}} invited you to join {{organizationName}} on {{theme.appName}}.\n\nAccept: {{acceptUrl}}",
    links: [{ path: "acceptUrl", label: "invite-accept" }],
  },
  passwordChanged: {
    id: "passwordChanged",
    category: "transactional",
    width: "narrow",
    payload: PasswordChangedPayload,
    subject: "Your password was changed",
    html: layout(
      `${heading("Your password was changed")}<p style="margin:0 0 8px">Hi{{#if name}} {{name}}{{/if}}, your account credentials were changed on {{when}}.</p><p style="margin:0 0 8px">If this wasn't you, contact support immediately.</p>${button("supportUrl", "Contact support")}`,
    ),
    text: "Hi{{#if name}} {{name}}{{/if}},\n\nYour account credentials were changed on {{when}}. If this wasn't you, contact support: {{supportUrl}}",
    links: [{ path: "supportUrl", label: "password-support" }],
  },
  newsletter: {
    id: "newsletter",
    category: "marketing",
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
    width: "narrow",
    payload: LeadCapturePayload,
    subject: "Your download: {{assetName}}",
    html: layout(
      `${heading("Your download is ready")}<p style="margin:0 0 8px">Hi{{#if name}} {{name}}{{/if}}.</p>{{#if message}}<p style="margin:0 0 8px">{{message}}</p>{{/if}}<p style="margin:0 0 8px">Your copy of <strong class="t-ink" style="color:{{theme.light.text}}">{{assetName}}</strong> is ready.</p>${button("assetUrl", "Download now")}`,
    ),
    text: "Hi{{#if name}} {{name}}{{/if}},\n\n{{#if message}}{{message}}\n\n{{/if}}Your copy of {{assetName}} is ready: {{assetUrl}}",
    links: [{ path: "assetUrl", label: "lead-asset" }],
  },
  marketingCampaign: {
    id: "marketingCampaign",
    category: "marketing",
    width: "narrow",
    payload: MarketingCampaignPayload,
    subject: "{{subject}}",
    html: layout(`${heading("{{heading}}")}<p style="margin:0 0 8px">{{body}}</p>${button("ctaUrl", "{{ctaLabel}}")}`),
    text: "{{heading}}\n\n{{body}}\n\n{{ctaLabel}}: {{ctaUrl}}",
    links: [{ path: "ctaUrl", label: "campaign-cta" }],
  },
};
