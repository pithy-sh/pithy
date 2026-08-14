// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { WorkflowRetryPolicy } from "@pithy-sh/core/src/workflow/faults";

/**
 * **What the secrets manager's Workflows retry, and what they refuse to.**
 *
 * The manager hosts two Workflows — the CLI's write dispatch and the at-rest key rotation — and both run
 * against exactly two storage systems: this environment's D1, and the account's CF Secrets Store. That is
 * a short list of ways a write can fail, so the classification is short too (pithy-sh/pithy#338).
 *
 * ## Terminal, and why
 *
 * - **`secrets/already_exists`** — `create` refusing a name that is already there. This is the write path
 *   *succeeding at its job*: the refusal is what closes the concurrent-write race, and it is what stops a
 *   typo minting a second secret over a live one. A name does not stop existing because you asked twice,
 *   so the retry is pure delay dressed as resilience.
 * - **`secrets/not_found`** — `update` refusing a name that is not there. The same argument, mirrored.
 * - **`secrets/invalid_value`**, **`validation/invalid_input`** — a value or a payload the schema refuses.
 *   Deterministic in the input; a second attempt parses the same bytes.
 * - **`secrets/crypto_failed`** — a missing key version or unreadable ciphertext. A key that is not in the
 *   bound key set will not be in it on the next attempt either; this one wants an operator, not a backoff.
 * - **A value too large for the Secrets Store** — a limit, and a refusal, not an outage.
 *
 * ## Retryable, and why
 *
 * - **`core/upstream_failed` / `core/upstream_timeout`** — the Cloudflare API, unreachable or out of time.
 *   Only the rotation write-back talks to it; the next attempt may well reach it.
 * - **A transient D1 fault** — busy, timed out, connection lost, storage reset, internal. Core classifies
 *   those (`withD1Retry`), the write path already retries them in-process, and a step re-drive is the
 *   second, much longer backoff for a database that is still recovering. Nothing is stated here because
 *   nothing should be: one D1 vocabulary, in core, or the two drift.
 *
 * Everything absent is terminal. That is the whole point of the record: a code is retried because someone
 * wrote down what a second attempt would see, not because nobody classified it.
 */
export const secretsWorkflowRetry: WorkflowRetryPolicy = {
  capability: "secrets",
  retryable: {
    "core/upstream_failed": "The Cloudflare API could not be reached; the rotation write-back may reach it next time.",
    "core/upstream_timeout": "The Cloudflare API ran out of time; the write-back is idempotent on the key set.",
  },
};
