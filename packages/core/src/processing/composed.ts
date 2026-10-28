// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Capability } from "../capability/capability";
import { parseProcessingPolicy, type ResolvedActivity, resolveProcessing } from "./activity";

/**
 * The processing activities as this Worker resolved them at assembly, reachable from module scope, so the control
 * plane reads the same record `createBackend` refused or accepted. One Worker assembles one backend; a second assembly
 * in one isolate replaces the first wholesale, as `../retention/composed.ts` does for the retention policy.
 */

/** Parse and resolve a Worker's `processing` block over what it composes, or refuse it. */
export function effectiveProcessing(block: unknown, capabilities: readonly Capability[]): ResolvedActivity[] {
  return resolveProcessing(parseProcessingPolicy(block), capabilities);
}

let recorded: readonly ResolvedActivity[] | null = null;

/** Record the resolved activities. Called once by `createBackend`. */
export function recordProcessing(activities: readonly ResolvedActivity[]): void {
  recorded = activities;
}

/** Forget them. For a test that needs the un-assembled state back. */
export function forgetProcessing(): void {
  recorded = null;
}

/** The resolved activities, or `null` before any backend has been assembled in this isolate. */
export function composedProcessing(): readonly ResolvedActivity[] | null {
  return recorded;
}
