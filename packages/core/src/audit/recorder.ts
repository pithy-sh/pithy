import type { AuditEventInput } from "./auditEvent";

/**
 * The recorder seam. `emit()` on the request context (`c.var.emit`) takes one {@link AuditEventInput}
 * and durably records it. `@pithy-sh/audit`'s middleware replaces the default with a real D1-backed
 * recorder; with no audit capability installed the default is {@link noopEmit}, so an emitter can
 * always call `emit()` without first checking whether auditing is on.
 *
 * `emit()` is **non-fatal by contract**: it never throws and never rejects, so an audited action is
 * never broken by an audit write. The real recorder swallows and logs its own failures; the no-op
 * simply resolves.
 */
export type AuditEmit = (event: AuditEventInput) => Promise<void>;

/**
 * The default recorder when no audit capability is composed: accept the event and drop it. Resolves
 * without throwing, so calling `emit()` is always safe whether or not auditing is installed.
 */
export const noopEmit: AuditEmit = async () => {};
