// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { kitImport } from "../project/kitResolve";
import { capabilityLoadError } from "./loadFailure";

/**
 * `@pithy-sh/testers` is an **optional** capability, so the CLI must not hard-depend on it. Types come
 * in through type-only imports (erased at build), and every runtime value comes through
 * {@link loadTesters} — a guarded dynamic import that turns "the package isn't installed" into an
 * actionable error rather than an unresolved-module crash.
 */

/** The testers runtime surface the CLI commands need, from the project's own install. */
type TestersCapabilityModule = typeof import("@pithy-sh/testers/src/capability");
type TestersTablesModule = typeof import("@pithy-sh/testers/src/data/tables");
type TestersReadModule = typeof import("@pithy-sh/testers/src/roster/read");
type TestersWriteModule = typeof import("@pithy-sh/testers/src/roster/write");
type TestersDailyModule = typeof import("@pithy-sh/testers/src/workflows/daily");
type TestersViewModule = typeof import("@pithy-sh/testers/src/http/view");
type TestersConfigModule = typeof import("@pithy-sh/testers/src/config/config");

/** Everything `pithy testers` loads out of the optional package, in one guarded import. */
export type TestersModule = TestersCapabilityModule &
  TestersTablesModule &
  TestersReadModule &
  TestersWriteModule &
  TestersDailyModule &
  TestersViewModule &
  TestersConfigModule;

/**
 * Load `@pithy-sh/testers` from the project's own install.
 *
 * The one place the optional dependency is resolved, so a project that has not added testers gets one
 * clear instruction instead of a module error from whichever call site happened to run first.
 */
export async function loadTesters(projectDir: string): Promise<TestersModule> {
  try {
    const [capability, tables, read, write, daily, view, config] = await Promise.all([
      kitImport<TestersCapabilityModule>(projectDir, "@pithy-sh/testers/src/capability"),
      kitImport<TestersTablesModule>(projectDir, "@pithy-sh/testers/src/data/tables"),
      kitImport<TestersReadModule>(projectDir, "@pithy-sh/testers/src/roster/read"),
      kitImport<TestersWriteModule>(projectDir, "@pithy-sh/testers/src/roster/write"),
      kitImport<TestersDailyModule>(projectDir, "@pithy-sh/testers/src/workflows/daily"),
      kitImport<TestersViewModule>(projectDir, "@pithy-sh/testers/src/http/view"),
      kitImport<TestersConfigModule>(projectDir, "@pithy-sh/testers/src/config/config"),
    ]);
    return { ...capability, ...tables, ...read, ...write, ...daily, ...view, ...config };
  } catch (error) {
    throw capabilityLoadError("testers", "@pithy-sh/testers", error, projectDir);
  }
}
