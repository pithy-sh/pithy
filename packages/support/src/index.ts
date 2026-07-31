// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * The package entrypoint — the surface `pithy add support` wires into `pithy.config.ts`. Deliberately
 * narrow: the capability factory, its config and options types, the two federation helpers an adopter
 * calls, the control-plane scopes, and the table schemas. Every other module is imported by deep path
 * (`@pithy-sh/support/src/...`); this is the documented contract, not a barrel over the package.
 */

export { type SupportAuditAction, SupportAuditActions } from "./audit/actions";
export {
  isSupportCapability,
  SUPPORT_MIGRATION_ORDER,
  type SupportCapability,
  type SupportOptions,
  support,
} from "./capability";
export {
  DEFAULT_CLASSIFY_MODEL,
  SupportAiConfig,
  SupportAttachmentsConfig,
  SupportConfig,
  type SupportConfigInput,
  SupportGuardConfig,
  SupportReplyConfig,
  SupportSearchConfig,
} from "./config/config";
export { SupportAttachment } from "./data/attachment";
export {
  DEFAULT_SUPPORT_CATEGORIES,
  defineSupportCategories,
  type SupportCategories,
} from "./data/categories";
export { SupportClassification } from "./data/classification";
export { SupportMessageDirection, SupportPriority, SupportSentiment, UNCATEGORIZED } from "./data/enums";
export { SupportThreadFlag } from "./data/flag";
export { SupportMessage } from "./data/message";
export {
  SUPPORT_ATTACHMENTS_TABLE,
  SUPPORT_CLASSIFICATIONS_TABLE,
  SUPPORT_FLAGS_TABLE,
  SUPPORT_MESSAGES_TABLE,
  SUPPORT_SEARCH_TABLE,
  SUPPORT_THREADS_TABLE,
  type SupportDatabase,
  supportDatabase,
} from "./data/tables";
export { SupportThread } from "./data/thread";
export {
  SUPPORT_CONTROL_PLANE_SCOPES,
  SUPPORT_THREADS_ARCHIVE_SCOPE,
  SUPPORT_THREADS_FLAG_SCOPE,
  SUPPORT_THREADS_READ_SCOPE,
  SUPPORT_THREADS_RECLASSIFY_SCOPE,
  SUPPORT_THREADS_REPLY_SCOPE,
} from "./http/guards";
export {
  DEFAULT_SUPPORT_REPLIES,
  defineSupportReplies,
  SupportReplySnippet,
  type SupportReplySnippets,
} from "./reply/snippets";
