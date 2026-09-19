// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { AuthPeer } from "@pithy-sh/auth/src/peer";
import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { kitImport } from "../project/kitResolve";
import { kitCarries } from "./hostEntry";
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

/**
 * **The auth a terminal read hands testers — the project's own composed auth, or none** (#645 review).
 *
 * `testers()` finds auth in its `compose` hook, and its host is handed auth by the entry `pithy` generates. The
 * CLI is the third reader, and it had neither: `list`, `status` and `roster` read every tester `unobservable`,
 * and `run` wrote a permanent day of nobody observed, for a project that composes auth. So it takes auth from the
 * same place the host's entry does — the project's composed capabilities — and `readCohort` now requires it, so
 * the next caller that forgets fails typecheck.
 *
 * Three answers. No auth composed: `undefined`, and every reading says `unobservable`, which is true. Auth
 * carrying its surface: that surface. Auth composed and too old to carry one: that depends on the testers
 * installed. One that takes auth as a peer would read nobody, so it is refused by name; one from before the seam
 * ignores the argument and imports auth itself, so it is handed nothing and reads as it always did.
 */
export function testersAuth(projectDir: string, capabilities: readonly Capability[]): AuthPeer | undefined {
  const auth = capabilities.find((capability) => capability.name === "auth" && "authConfig" in capability);
  if (auth === undefined) return undefined;
  const peer = (auth as { authPeer?: Partial<AuthPeer> }).authPeer;
  if (typeof peer?.authDatabase === "function") return peer as AuthPeer;
  if (!kitCarries(projectDir, "@pithy-sh/testers/src/workflows/hostPeers")) return undefined;
  throw new ValidationError({
    message: "The composed auth is too old for testers to see who has used the app.",
    action: "Upgrade @pithy-sh/auth to the version this @pithy-sh/testers peers.",
    detail:
      "The composed auth capability carries no `authPeer`, so every tester would read unobservable and `pithy testers run` would record nobody observed.",
  });
}
