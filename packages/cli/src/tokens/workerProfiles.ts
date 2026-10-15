// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { resolveTokenProfiles, type TokenProfile } from "@pithy-sh/cloudflare/src/tokens/profiles";
import { commandName } from "@pithy-sh/core/src/cli/command";
import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { isUnknown, projectCapabilities, type WorkerSet } from "../project/workerScope";

/**
 * The profile registry a token operation derives from — **refused when the capability set cannot be read,
 * never derived from an emptied one** (#455).
 *
 * `pithy token`'s `buildEngine` already insists the *root* config is required and never guessed, because `revoke`
 * deletes every account token of the name it computes. The Worker half was best-effort, and that is the
 * same mistake one level down: `resolveTokenProfiles([])` returns only `ci-system` and drops every
 * capability's `ciPermissions`, so `pithy token list <env>` told an operator auditing live credentials that
 * capability-profile tokens do not exist and exited 0, and `pithy token rotate ci-system <env>` minted a
 * replacement carrying only the base permissions before deleting the fully-permissioned one it replaced.
 * CI lost permissions silently, with nothing in the run saying the capability set was unknown.
 *
 * A project with genuinely **no** Workers still resolves normally: `ci-system` is a project-level profile
 * and mints fine before the first `pithy worker add`. See `resolveWorkerSet` for the difference.
 *
 * The refusal quotes the set's own diagnosis rather than inventing one, so it names the worker.
 */
export function tokenProfiles(workers: WorkerSet): Record<string, TokenProfile> {
  if (!isUnknown(workers)) return resolveTokenProfiles(projectCapabilities(workers));
  throw new ValidationError({
    message: "This project's capability set is unknown, so token permissions cannot be derived.",
    action:
      `${workers.unknown} Fix it — ${commandName("doctor")} names the fault — and re-run. Token permissions come from ` +
      "the composed capabilities, so minting from a partial set narrows what CI can do.",
  });
}
