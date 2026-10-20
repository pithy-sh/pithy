// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Loggable } from "../privacy/types";
import type { AuditEventInput, AuditMetadata } from "./auditEvent";

/**
 * The recorder seam. `emit()` on the request context (`c.var.emit`) takes one {@link AuditEventInput}
 * and durably records it. `@pithy-sh/audit`'s middleware replaces the default with a real D1-backed
 * recorder; with no audit capability installed the default is {@link noopEmit}, so an emitter can
 * always call `emit()` without first checking whether auditing is on.
 *
 * `emit()` is **non-fatal by contract**: it never throws and never rejects, so an audited action is
 * never broken by an audit write. The real recorder swallows and logs its own failures; the no-op
 * simply resolves.
 *
 * **`metadata` refuses a value marked with a privacy class** (#132). The trail is the longest-lived internal
 * surface there is — a row in the adopter's D1 with no retention window — so a `pii()`/`phi()`/`secret()`/
 * `pci()` value in it, or inside an object in it, is a compile error, by the same `Loggable` rule the logger
 * applies. `AuditMetadata` the schema stays permissive: a stored row still parses.
 */
export type AuditEmit = <M extends AuditMetadata = AuditMetadata>(
  event: Omit<AuditEventInput, "metadata"> & { metadata?: (M & Loggable<M>) | null | undefined },
) => Promise<void>;

/**
 * The default recorder when no audit capability is composed: accept the event and drop it. Resolves
 * without throwing, so calling `emit()` is always safe whether or not auditing is installed.
 */
export const noopEmit: AuditEmit = async () => {};
