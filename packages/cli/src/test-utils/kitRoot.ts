// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { resolve } from "node:path";

/**
 * The project root a unit test hands a loader or a provisioner, now that both resolve `@pithy-sh/*`
 * from the project rather than from the CLI (#533).
 *
 * This repository's own `packages/cli` — chosen because node's resolver walks *up* from a base, so from
 * here every `@pithy-sh/*` package resolves through the workspace's hoisted `node_modules`, which is the
 * same copy these tests loaded before the change. It is a stand-in for an adopter's project root and
 * nothing more; a test that is actually *about* resolution stages its own fixture project with its own
 * `node_modules` (see `capabilities/projectResolution.test.ts`).
 *
 * Written once rather than as `resolve(import.meta.dirname, "..", "..")` in nineteen test files, so the
 * day one of them needs a different base there is one place that says what this value is for.
 */
export const KIT_ROOT = resolve(import.meta.dirname, "..", "..");
