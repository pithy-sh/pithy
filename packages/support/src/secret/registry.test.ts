// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { type SupportOptions, support } from "../capability";
import { SUPPORT_BUCKET_BINDING, SUPPORT_R2_SECRET, supportSecretsRegistry } from "./registry";

/**
 * **The credential names the bucket it presigns (#541).**
 *
 * Support's bucket is its one optional binding, and an adopter who turns attachments off declines it.
 * With the relation stated only in prose, one `pithy doctor` run printed `SUPPORT_BUCKET (r2) declined
 * in pithy.config.ts` and then asked for `support-r2-credentials` — the credential whose only purpose
 * is reaching that bucket. The entry carries the binding now, so the secrets side can read what the
 * bindings side already reports.
 */
describe("support-r2-credentials", () => {
  test("declares the bucket binding it exists to reach", () => {
    expect(supportSecretsRegistry[SUPPORT_R2_SECRET].binding).toBe(SUPPORT_BUCKET_BINDING);
  });

  /**
   * The pin that matters: the string on the entry has to be the string the capability declares, or the
   * CLI joins a decline against a binding nobody has. One constant feeds both, and this is what would
   * fail if the two were ever split.
   */
  test("and that binding is the r2 binding the capability declares", () => {
    const r2 = support({ inboundAddresses: ["support@help.example.com"] }).requiredBindings.filter(
      (binding) => binding.type === "r2",
    );
    expect(r2.map((binding) => binding.name)).toContain(supportSecretsRegistry[SUPPORT_R2_SECRET].binding);
  });
});

/**
 * **The headline case of #541, and the one the binding field alone does not close.**
 *
 * A project that declines `SUPPORT_BUCKET` is answered by the join above. A project that simply turned
 * attachments off never declines anything — `supportNeedsBucket` suppresses the binding at composition,
 * so there is nothing to decline and nothing for the CLI to read. `pithy doctor` asked for
 * `support-r2-credentials` on exactly the configuration the issue opens with.
 */
describe("inapplicableSecrets", () => {
  /** The three writers, all off — the configuration `supportNeedsBucket` answers `false` for. */
  const NO_ATTACHMENTS: SupportOptions = {
    inboundAddresses: ["support@help.example.com"],
    attachments: { enabled: false, retainRaw: false },
    submission: { attachments: { enabled: false } },
  };

  test("a composition that stores no attachments cannot reach its R2 credential", () => {
    const declared = support(NO_ATTACHMENTS).inapplicableSecrets ?? {};
    expect(declared[SUPPORT_R2_SECRET]).toContain("support() stores no attachments");
  });

  /** And it names all three settings, because any one of them turns the bucket back on. */
  test("the reason names every setting that would turn it back on", () => {
    const reason = support(NO_ATTACHMENTS).inapplicableSecrets?.[SUPPORT_R2_SECRET] ?? "";
    expect(reason).toContain("attachments.enabled");
    expect(reason).toContain("attachments.retainRaw");
    expect(reason).toContain("submission.attachments.enabled");
  });

  /**
   * The default project declares nothing, which is the property that made this safe to land on a
   * capability people already compose: all three writers default on, so the credential stays
   * outstanding work for every ordinary inbox.
   */
  test("the default composition declares nothing", () => {
    expect(support({ inboundAddresses: ["support@help.example.com"] }).inapplicableSecrets ?? {}).toEqual({});
  });

  /** One writer is enough — the same boundary the binding itself is declared on. */
  test("one writer left on keeps the credential in reach", () => {
    const capability = support({ ...NO_ATTACHMENTS, submission: { attachments: { enabled: true } } });
    expect(capability.inapplicableSecrets ?? {}).toEqual({});
  });
});
