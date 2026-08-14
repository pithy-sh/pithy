// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * The package entrypoint — the surface `pithy add testers` wires into `pithy.config.ts`.
 *
 * Deliberately narrow: the capability factory and its type guard, the configuration schema, the four
 * table schemas, and the two things a management client or the CLI needs by name — the control-plane
 * scopes and the disclaimer every opt-in figure travels with. Every other module is reached by deep
 * path (`@pithy-sh/testers/src/...`); this is the documented contract, not a barrel over the package.
 *
 * `workflows/worker.ts` is **not** here and must not be. It imports `cloudflare:workers`, and
 * re-exporting it would make that import unresolvable in every Node context that touches this package —
 * including the CLI, the seed harness, and every node-project test.
 */

export {
  isTestersCapability,
  TESTERS_MIGRATION_ORDER,
  type TestersCapability,
  type TestersOptions,
  testers,
} from "./capability";
export {
  CohortDefaults,
  HealthCredits,
  HealthPenalties,
  NudgePolicy,
  ResetPolicy,
  SurvivalPriors,
  TesterPlatform,
  TestersConfig,
  type TestersConfigInput,
} from "./config/config";
export { TestersCohort } from "./data/cohort";
export {
  ActivityState,
  MemberEventKind,
  MemberState,
  NudgeKind,
  Observability,
  ProjectionBasis,
  ProjectionConfidence,
  RiskBand,
  TrendDirection,
} from "./data/enums";
export { TestersEvent } from "./data/event";
export { TestersMember } from "./data/member";
export { TestersCohortSnapshot } from "./data/snapshot";
export {
  TESTERS_COHORTS_TABLE,
  TESTERS_EVENTS_TABLE,
  TESTERS_MEMBERS_TABLE,
  TESTERS_SNAPSHOTS_TABLE,
  type TestersDatabase,
  testersDatabase,
  testersTables,
} from "./data/tables";
export { DISCLAIMER, ESTIMATE_STATEMENT } from "./http/responses";
export { TESTERS_ROUTES, type TestersRouteDeclaration } from "./http/routes";
export {
  TESTERS_CONTROL_PLANE_SCOPES,
  TESTERS_NUDGE_SEND_SCOPE,
  TESTERS_ROSTER_READ_SCOPE,
  TESTERS_ROSTER_WRITE_SCOPE,
} from "./http/scopes";
export {
  deprovisionTesters,
  provisionTesters,
  type TestersDeprovisioner,
  type TestersProvisioner,
  type TestersProvisionResult,
  testersWorkerName,
} from "./provision/provisionTesters";
export {
  resolveTestersConfig,
  type TestersConfigParams,
  type TestersEmailIdentity,
} from "./provision/resolveTestersConfig";
export { TESTERS_CAPABILITY, TestersDailyParams, testersWorkflowRegistry, testersWorkflows } from "./workflows/specs";
