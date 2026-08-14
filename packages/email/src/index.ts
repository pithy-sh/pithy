// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * The package entrypoint — the surface `pithy add email` wires into `pithy.config.ts`. Deliberately
 * narrow: the capability factory plus the enqueue API and the types an app needs to send mail. Every
 * other module is imported by deep path (`@pithy-sh/email/src/...`); this is the documented contract,
 * not a barrel over the package.
 */

export { type CampaignStats, campaignStats } from "./analytics";
export { type EmailCapability, type EmailConfigInput, email, isEmailCapability } from "./capability";
export type { EmailKind, SuppressionReason } from "./data/enums";
export type { EmailSuppressionDatabase } from "./data/tables";
// The control-plane scopes, exported because they are the join key with what `pithy dashboard connect`
// offers an adopter to grant. A doc or a tool naming one of these should read the constant, not retype
// the string — a scope that differs by a character is a gate nothing ever satisfies.
export {
  EMAIL_CONTROL_PLANE_SCOPES,
  EMAIL_JOBS_READ_SCOPE,
  EMAIL_JOBS_RETRY_SCOPE,
  EMAIL_SUPPRESSIONS_DELETE_SCOPE,
  EMAIL_SUPPRESSIONS_READ_SCOPE,
  EMAIL_SUPPRESSIONS_WRITE_SCOPE,
} from "./http/guards";
export { type EnqueueInput, type EnqueueResult, enqueueEmail } from "./send/enqueue";
// How a Workflow sends mail (pithy-sh/pithy#356). A route holds the bound `enqueue` its `compose` hook
// handed it; a durable step has no such hook, and this is the seam that gets it there without restating
// the sending identity `pithy.config.ts` already resolved.
export { composedEmail, enqueueFromEnv } from "./send/fromComposition";
/**
 * The suppression list, for the adopter who wants to look (pithy-sh/pithy#355).
 *
 * Nobody needs these to be protected — `enqueue` consults the list on its own and `runSend` refuses a
 * blocked recipient regardless. They are here because **it is the adopter's database**: an operator
 * un-suppressing an address a customer has fixed, a support screen explaining why a letter did not go,
 * a report of who a notice could not reach. Pair them with `EmailCapability.suppressions(env)`, which
 * hands back the handle without anybody naming a binding.
 *
 * `blockingSuppression` takes the message's kind, and the kind belongs to the template — read it with
 * `templateKind`, never type a literal. A restated `"transactional"` is a claim about somebody else's
 * template, and it is the claim that starts withholding invitations from people who unsubscribed from
 * a newsletter.
 */
export {
  blockingSuppression,
  listSuppressions,
  type SuppressionListFilter,
  type SuppressionPage,
  suppress,
  suppressionBlocks,
  unsuppress,
} from "./send/suppression";
export { listTemplates, templateKind } from "./templates/engine";
// The one payload contract exported by name. Every other template is called by a capability in this
// repo, which deep-imports; an operational notice is the template an *adopter* sends, about their own
// infrastructure, and it is the one where getting the severity wrong should not wait for runtime.
export { OperationalNoticePayload } from "./templates/registry";
export { NoticeSeverity } from "./templates/severity";
