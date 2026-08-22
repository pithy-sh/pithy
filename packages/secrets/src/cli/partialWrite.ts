// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * **How a run that failed part-way still says what it wrote.**
 *
 * A fan-out across environments has no transaction. The third write throws, the first two already
 * landed, and the return value that would have named them never happens — so the operator is told
 * nothing was done while two environments hold a brand-new signing key. That is the state #324 found in
 * `mintDeclaredSecrets` and #325 found again in `dispatchSecretWrite`, which is the path every
 * `pithy secrets create`, `update` and `rm` takes.
 *
 * The fix is the same both times, so it is written once here rather than twice at the call sites — two
 * producers of one rule is the defect class this repository has produced four times over.
 *
 * **Carried, never replaced.** The report is attached to whatever ended the run and the same thing is
 * rethrown: same class, same payload, same `instanceof`. The failure an operator has to read is
 * unchanged, and what the run wrote is what makes the remedy in it safe to perform.
 *
 * **A symbol, non-enumerable, and not a payload field.** The payload is what the HTTP codec encodes and
 * what `--json` prints as `{ error }`; this is the command's own output, on its own stream. Non-enumerable
 * so nothing serializing an error picks it up by accident.
 *
 * **The one thing it cannot carry: a thrown primitive.** Nothing can be attached to a thrown string, so a
 * caller that throws one loses its report. Replacing it with a wrapper would fix that and break the rule
 * this is built on — the failure an operator reads must be the failure that happened. Everything in this
 * repository throws a `PithyError`, and the kit's own linting says so; a dependency that throws a string
 * is the case this trades away deliberately.
 *
 * **`Symbol.for`, and one key per report.** The key is registry-global, so a report attached inside
 * `@pithy-sh/secrets` is readable from `@pithy-sh/cli` however the module graph resolved. Distinct keys
 * because there are genuinely two reports with two shapes — what a mint run created, and which
 * environments one dispatch reached — and a single shared key would let one reader decode the other's
 * payload as its own.
 */

/** Attach a report to a failing run, and read one back off whatever it threw. */
export interface PartialWriteReport<P> {
  /** Attach `report` to `error` and hand the same thing back, to be rethrown unchanged. */
  carry<E>(error: E, report: P): E;
  /** The report this run attached, or `undefined` for a throw from anywhere else. */
  read(error: unknown): P | undefined;
}

/**
 * One report channel, keyed by `key`. Call this once per module, at module scope: the key is the
 * contract between the writer and the reader, and one built per call would be a channel nobody else
 * can open.
 *
 * `isReport` is what makes reading safe. A carried value arrives as `unknown` — the error may have
 * crossed a package boundary, or been constructed by something else entirely — so the reader narrows it
 * rather than casting, exactly as every other boundary in this repository does.
 */
export function partialWriteReport<P>(key: string, isReport: (value: unknown) => value is P): PartialWriteReport<P> {
  const symbol = Symbol.for(key);
  return {
    carry<E>(error: E, report: P): E {
      if (typeof error === "object" && error !== null) {
        Object.defineProperty(error, symbol, { value: report, enumerable: false, configurable: true });
      }
      return error;
    },
    read(error: unknown): P | undefined {
      if (typeof error !== "object" || error === null) return undefined;
      const carried = (error as Record<symbol, unknown>)[symbol];
      return isReport(carried) ? carried : undefined;
    },
  };
}
