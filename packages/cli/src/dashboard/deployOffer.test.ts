// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { WorkerDir } from "@pithy-sh/core/src/cli/command";
import { controlplane } from "@pithy-sh/core/src/controlPlane/capability";
import { describe, expect, test } from "vitest";
import type { ResolvedWorker } from "../project/workerScope";
import { OffersKey } from "../terminal/nextSteps";
import { type DashboardOfferSeams, dashboardOfferLine, dashboardOffers, seamWorkerDirs } from "./deployOffer";

/**
 * **A deploy offers the dashboard to an environment that has none, and only when it knows that (#757).**
 *
 * An offer is something a person decides, so the condition is held both ways: the one fact that makes it — a
 * named environment, a Worker composing the seam, a registry read that found nothing — produces it, and every
 * fact short of that produces no key. An unknown is never an absence: a registry nobody could read offers
 * nothing rather than a connection that may already exist.
 */

/** Seams for a project whose `api` Worker composes the seam and whose registry holds nothing. */
function seams(overrides: Partial<DashboardOfferSeams> = {}): DashboardOfferSeams {
  return {
    seamWorkers: async () => ["api" as WorkerDir],
    connected: async () => false,
    ...overrides,
  };
}

const base = { projectDir: "/project", account: null, failed: false };

describe("dashboardOffers", () => {
  test("offers the connect for a named environment with a seam and no connection", async () => {
    expect(await dashboardOffers({ ...base, env: "staging", seams: seams() })).toEqual([
      {
        command: "pithy dashboard connect --env staging --worker api",
        why: "staging is not connected to a dashboard. Connecting opens a browser sign-in, so it is a person's to approve.",
      },
    ]);
  });

  test("names each Worker that composes the seam, any one of which connects the project", async () => {
    const offers = await dashboardOffers({
      ...base,
      env: "prod",
      seams: seams({ seamWorkers: async () => ["admin" as WorkerDir, "api" as WorkerDir] }),
    });
    expect(offers?.map((offer) => offer.command)).toEqual([
      "pithy dashboard connect --env prod --worker admin",
      "pithy dashboard connect --env prod --worker api",
    ]);
    expect(offers?.[0]?.why).toContain("Any one of these connects the project.");
  });

  test("offers nothing to an environment already connected", async () => {
    expect(await dashboardOffers({ ...base, env: "staging", seams: seams({ connected: async () => true }) })).toBe(
      undefined,
    );
  });

  test("offers nothing on dev, a feature environment, a bare deploy, or a failed run", async () => {
    for (const env of ["dev", "feature", undefined]) {
      expect(await dashboardOffers({ ...base, env, seams: seams() })).toBe(undefined);
    }
    expect(await dashboardOffers({ ...base, env: "staging", failed: true, seams: seams() })).toBe(undefined);
  });

  test("offers nothing when no Worker composes the seam, or the composition cannot be read", async () => {
    expect(await dashboardOffers({ ...base, env: "staging", seams: seams({ seamWorkers: async () => [] }) })).toBe(
      undefined,
    );
    expect(await dashboardOffers({ ...base, env: "staging", seams: seams({ seamWorkers: async () => null }) })).toBe(
      undefined,
    );
  });

  test("an unreadable registry is not an absent connection", async () => {
    const unreadable = seams({
      connected: async () => {
        throw new Error("D1 unreachable");
      },
    });
    expect(await dashboardOffers({ ...base, env: "staging", seams: unreadable })).toBe(undefined);
  });

  test("asks the registry only once the cheaper conditions hold", async () => {
    let asked = 0;
    const counting = seams({
      connected: async () => {
        asked += 1;
        return false;
      },
    });
    await dashboardOffers({ ...base, env: "dev", seams: counting });
    await dashboardOffers({ ...base, env: "staging", failed: true, seams: counting });
    await dashboardOffers({ ...base, env: "staging", seams: { ...counting, seamWorkers: async () => [] } });
    expect(asked).toBe(0);
  });

  test("every offer it makes is the published shape", async () => {
    const offers = await dashboardOffers({ ...base, env: "staging", seams: seams() });
    expect(OffersKey.safeParse(offers).success).toBe(true);
    expect(OffersKey.safeParse([]).success).toBe(false);
  });
});

describe("seamWorkerDirs", () => {
  /** A resolved Worker in `apps/<dir>`, composing what it is handed. Only the fields the selection reads. */
  function worker(dir: string, seam: boolean): ResolvedWorker {
    return { name: `acme-${dir}`, dir: `/project/apps/${dir}`, capabilities: seam ? [controlplane()] : [] } as never;
  }

  test("names each Worker composing the seam by its apps/ directory, sorted, and no other", () => {
    expect(seamWorkerDirs([worker("web", false), worker("api", true), worker("admin", true)])).toEqual([
      "admin",
      "api",
    ]);
    expect(seamWorkerDirs([worker("web", false)])).toEqual([]);
  });
});

describe("dashboardOfferLine", () => {
  test("names one command, or any one of several, in code", () => {
    const step = (worker: string) => ({ command: `pithy dashboard connect --env prod --worker ${worker}`, why: "." });
    expect(dashboardOfferLine("prod", [step("api")])).toBe(
      "prod is not connected to a dashboard. Connect it with `pithy dashboard connect --env prod --worker api`.",
    );
    expect(dashboardOfferLine("prod", [step("admin"), step("api")])).toBe(
      "prod is not connected to a dashboard. Connect it with `pithy dashboard connect --env prod --worker admin` or `pithy dashboard connect --env prod --worker api`.",
    );
  });
});
