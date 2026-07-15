/**
 * The package entrypoint — the surface `pithy add audit` wires into `pithy.config.ts`. Deliberately
 * narrow: the capability factory, the recorder/query seams an app reads the trail with, the federated
 * action-constant helper, and the CLI emitter + actor resolver. Every other module is imported by
 * deep path (`@pithy-sh/audit/src/...`); this is the documented contract, not a barrel.
 */

export { defineAuditActions } from "./actions";
export { type AuditCapability, type AuditConfigInput, audit, isAuditCapability } from "./capability";
export { type CliAuditEvent, emitFromCLI } from "./cli/emitFromCLI";
export {
  type CfActorSource,
  createCachedActorResolver,
  type ResolvedActor,
  resolveActor,
} from "./cli/resolveActor";
export { AuditEventRow } from "./data/auditEvent";
export { type AuditDatabase, auditDatabase } from "./data/tables";
export { type AuditQuery, queryAuditEvents } from "./query";
export { type AuditRecorderOptions, createAuditEmit, recordAuditEvent } from "./recorder";
