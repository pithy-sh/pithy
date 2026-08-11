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
export { listTemplates } from "./templates/engine";
// The one payload contract exported by name. Every other template is called by a capability in this
// repo, which deep-imports; an operational notice is the template an *adopter* sends, about their own
// infrastructure, and it is the one where getting the severity wrong should not wait for runtime.
export { OperationalNoticePayload } from "./templates/registry";
export { NoticeSeverity } from "./templates/severity";
