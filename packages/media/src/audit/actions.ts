// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * The audit actions this capability emits, through the core `emit()` seam.
 *
 * **The delivery read is audited though it changes nothing.** It is the one media route a management
 * client calls, and it lists every asset this environment serves by name. A credential paging that is a
 * question with an answer only if the read leaves a row. Counts only in metadata — never a name, a key or
 * a number of minutes.
 *
 * Emitted with `c.var.emit`, never by importing `@pithy-sh/audit`: the seam is always present.
 */
export const MediaAuditActions = {
  /** A management client read what this environment's media was served. */
  deliveryRead: "media/delivery_read",
} as const;

/** One of the media capability's audit actions. */
export type MediaAuditAction = (typeof MediaAuditActions)[keyof typeof MediaAuditActions];
