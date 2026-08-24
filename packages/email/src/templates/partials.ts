// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * The shared head + footer partials every template includes via `{{> emailHead}}` ... `{{> emailFoot}}`.
 * They carry the full document shell: a Gmail-safe table layout, the theme (logo light/dark swap, accent,
 * width), the light-mode colors applied inline, and a `prefers-color-scheme: dark` style block that swaps
 * in the dark palette (honored by Apple Mail, iOS Mail, and the Outlook app; Gmail self-inverts and ignores
 * the query — a known limit). The open-tracking pixel and the unsubscribe link render only when the render
 * context supplies them; the engine guarantees a marketing send always supplies the unsubscribe.
 *
 * The dark block also carries the `.sev-*` severity colors, which are the one thing in this shell that
 * is not the brand's to set — see `severity.ts`. They live here because this is where every other
 * dark-mode swap lives, and they are generated from the same table the inline light colors come from.
 *
 * **The shell speaks the job's language.** `lang` and `dir` are injected by the engine from the
 * render's translator, so a document is declared in the language it is actually written in and an RTL
 * locale lays out right-to-left rather than being mirrored by hand — there was no `dir` here at all
 * before pithy-sh/pithy#441, which meant an Arabic body inherited a left-to-right shell. The footer's
 * opt-out word comes from the catalog for the same reason: it is the one sentence in this file, and a
 * Spanish reader offered `Unsubscribe` has been told the rest of the letter was a translation of
 * something.
 *
 * Restyled from the Leed/Pithy email shell. Variables are Handlebars: `{{theme.*}}`, `{{layoutWidth}}`,
 * `{{lang}}`, `{{dir}}`, `{{openPixelUrl}}`, `{{unsubscribeUrl}}`.
 */

import { severityDarkModeCss } from "./severity";

const FONT = "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

/** Doctype, head (with the dark-mode style block), body open, the branded masthead, and the content cell. */
export const emailHead = `<!DOCTYPE html>
<html lang="{{lang}}" dir="{{dir}}" xmlns:v="urn:schemas-microsoft-com:vml">
<head>
<meta charset="utf-8">
<meta name="x-apple-disable-message-reformatting">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<style>
  .hover-underline:hover { text-decoration: underline !important }
  @media (prefers-color-scheme: dark) {
    .email-bg   { background-color: {{theme.dark.background}} !important; }
    .email-card { background-color: {{theme.dark.cardBackground}} !important; box-shadow: none !important; }
    .t-ink      { color: {{theme.dark.text}} !important; }
    .t-muted    { color: {{theme.dark.textMuted}} !important; }
    .t-subtle   { color: {{theme.dark.textSubtle}} !important; }
    .sep        { background-color: {{theme.dark.separator}} !important; }
    .logo-light { display: none !important; }
    .logo-dark  { display: inline-block !important; max-height: none !important; overflow: visible !important; }
${severityDarkModeCss}
  }
</style>
</head>
<body class="email-bg" style="margin: 0; width: 100%; background-color: {{theme.light.background}}; padding: 0; -webkit-font-smoothing: antialiased; word-break: break-word">
<div role="article" aria-roledescription="email" lang="{{lang}}" dir="{{dir}}">
{{#if openPixelUrl}}<img src="{{openPixelUrl}}" width="1" height="1" alt="" style="position: absolute; left: 0; top: 0; max-width: 1px; max-height: 1px; opacity: 0; border: 0">{{/if}}
<div class="email-bg" style="background-color: {{theme.light.background}}; font-family: ${FONT}; padding: 0 16px">
  <table align="center" cellpadding="0" cellspacing="0" role="none" style="width: {{layoutWidth}}px; max-width: {{layoutWidth}}px">
    <tr><td>
      <div style="margin-top: 40px; margin-bottom: 32px; text-align: center">
        {{#if theme.logoUrl}}<img src="{{theme.logoUrl}}" width="150" alt="{{theme.appName}}" class="logo-light" style="max-width: 100%; vertical-align: middle; border: 0">{{#if theme.logoDarkUrl}}<img src="{{theme.logoDarkUrl}}" width="150" alt="{{theme.appName}}" class="logo-dark" style="display: none; max-height: 0; overflow: hidden; max-width: 100%; vertical-align: middle; border: 0">{{/if}}{{else}}<span class="t-ink" style="font-size: 22px; font-weight: 700; color: {{theme.accent}}">{{theme.appName}}</span>{{/if}}
      </div>
      <table style="width: 100%" cellpadding="0" cellspacing="0" role="none">
        <tr>
          <td class="email-card t-muted" style="border-radius: 8px; background-color: {{theme.light.cardBackground}}; padding: 44px; font-size: 16px; line-height: 26px; color: {{theme.light.textMuted}}; box-shadow: 0 1px 2px 0 rgba(17,17,17,0.06); border-top: 3px solid {{theme.accent}}">`;

/** Closes the content cell, renders the footer (logo, links, address, optional unsubscribe), and the document. */
export const emailFoot = `</td>
        </tr>
        <tr role="separator"><td style="line-height: 40px">&zwj;</td></tr>
        <tr>
          <td class="t-subtle" style="padding: 0 24px; text-align: center; font-size: 12px; line-height: 18px; color: {{theme.light.textSubtle}}">
            <p class="t-subtle" style="margin: 0; color: {{theme.light.textSubtle}}">{{theme.appName}}</p>
            {{#if theme.links.length}}<p style="margin: 12px 0 0">{{#each theme.links}}{{#unless @first}} &middot; {{/unless}}<a href="{{href}}" class="hover-underline t-muted" style="color: {{../theme.light.textMuted}}; text-decoration: none">{{label}}</a>{{/each}}</p>{{/if}}
            {{#if theme.footerAddress}}<p class="t-subtle" style="margin: 14px 0 0; color: {{theme.light.textSubtle}}">{{theme.footerAddress}}</p>{{/if}}
            {{#if unsubscribeUrl}}<p style="margin: 12px 0 0"><a href="{{unsubscribeUrl}}" class="hover-underline t-subtle" style="color: {{theme.light.textSubtle}}; text-decoration: underline">{{t "email/shell.unsubscribe"}}</a></p>{{/if}}
          </td>
        </tr>
        <tr role="separator"><td style="line-height: 40px">&zwj;</td></tr>
      </table>
    </td></tr>
  </table>
</div>
</div>
</body>
</html>`;
