// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { email } from "@pithy-sh/email/src/capability";
import type { EnqueueDeps, EnqueueInput } from "@pithy-sh/email/src/send/enqueue";
import { emailTranslator } from "@pithy-sh/email/src/templates/messages";
import { i18n } from "@pithy-sh/i18n/src/capability";
import { describe, expect, test, vi } from "vitest";
import type { ResolvedWorker } from "../project/workerScope";
import { buildEnqueue } from "./testers";

/**
 * **What `pithy testers nudge` actually puts in the mail.**
 *
 * The seam this drives reads `layersFor` off a composed `i18n` capability, and that value is filled by
 * a `compose` hook rather than by the constructor. Read off an unassembled capability it is not wrong,
 * it is *empty* — every layer `undefined` — and `createTranslator` answers a missing key with the key.
 * So the shell of every nudge went out reading `email/shell.greeting_named`, and the footer link was
 * labeled `email/shell.unsubscribe`.
 *
 * The reason that is worth a test file of its own rather than a line in an existing one: `enqueueEmail`
 * falls back to `kitEmailLayers` — this package's own English — when it is handed *no* `layersFor` at
 * all. So the broken path is strictly the one where the adopter added `i18n()`. Adding a capability
 * broke a path that was correct without it, and every assertion here fails if the composition is ever
 * dropped again (pithy-sh/pithy#441).
 */

/** What the enqueue was called with, captured at the one seam the CLI reaches the email package through. */
const captured = vi.hoisted(() => ({
  deps: undefined as EnqueueDeps | undefined,
  input: undefined as EnqueueInput | undefined,
}));

// The row-writing half is not what is under test — the words are. Stubbing it is also what keeps this a
// node test: `enqueueEmail` would otherwise want a real D1 to insert into.
vi.mock("@pithy-sh/email/src/send/enqueue", () => ({
  enqueueEmail: async (deps: EnqueueDeps, input: EnqueueInput) => {
    captured.deps = deps;
    captured.input = input;
    return { jobId: "job-1", status: "queued" };
  },
}));

/** One app Worker composing the given capabilities — the shape `resolveWorkers` hands back. */
function workers(...capabilities: Capability[]): ResolvedWorker[] {
  return [
    {
      name: "api",
      dir: "/proj/apps/api",
      config: {} as ResolvedWorker["config"],
      capabilities,
      target: {} as ResolvedWorker["target"],
    },
  ];
}

function mail() {
  return email({ fromAddress: "noreply@acme.test", baseUrl: "https://api.acme.test" });
}

/** Run the seam the way `openTesters` does, and hand back what the email package was asked for. */
async function nudge(...capabilities: Capability[]) {
  captured.deps = undefined;
  captured.input = undefined;
  // Kysely is constructed over this and never queried — the insert is stubbed above.
  const enqueue = await buildEnqueue(workers(...capabilities), {} as D1Database);
  expect(enqueue).toBeDefined();
  await enqueue?.({ to: "tester@example.test", template: "testerNudge", payload: {} });
  return captured;
}

describe("the nudge a project composing i18n() actually sends", () => {
  test("the shell renders words, not the catalog keys that name them", async () => {
    const { deps } = await nudge(i18n({ supportedLocales: ["en", "es"] }), mail());
    const t = emailTranslator("en", deps?.layersFor ?? (() => []));

    // `translate` answers a missing key with the key itself, so this assertion is the symptom verbatim:
    // an unassembled i18n capability sends a footer link labeled `email/shell.unsubscribe`.
    expect(t.t("email/shell.unsubscribe")).toBe("Unsubscribe");
    expect(t.t("email/shell.greeting_named", { name: "Sam" })).toBe("Hi Sam,");
  });

  test("and the locale it is written in is the project's declared default", async () => {
    const { deps, input } = await nudge(i18n({ defaultLocale: "es", supportedLocales: ["es", "en"] }), mail());
    // There is no request to negotiate from at a terminal and no per-tester preference on a roster row,
    // so the project's own default is the only truthful answer.
    expect(input?.locale).toBe("es");
    expect(emailTranslator("es", deps?.layersFor ?? (() => [])).t("email/shell.unsubscribe")).not.toBe(
      "email/shell.unsubscribe",
    );
  });

  test("a project composing no i18n capability keeps the English it always had", async () => {
    const { deps, input } = await nudge(mail());
    // No layers handed over at all, which is `enqueueEmail`'s own signal to walk `kitEmailLayers`. This
    // is the path that was already correct, and it stays a separate assertion because it is the one the
    // broken path was measured against.
    expect(deps?.layersFor).toBeUndefined();
    expect(input?.locale).toBeUndefined();
  });

  test("no email capability composed means no enqueue seam, so the pass sends nothing", async () => {
    expect(await buildEnqueue(workers(i18n()), {} as D1Database)).toBeUndefined();
  });
});
