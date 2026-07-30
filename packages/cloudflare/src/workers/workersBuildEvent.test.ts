// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { WorkersBuildEvent, WorkersBuildOutcome, WorkersBuildStatus, WorkersTriggerSource } from "./workersBuildEvent";

describe("workersBuildEvent", () => {
  describe("enums", () => {
    it("accept their documented members and reject others", () => {
      expect(WorkersBuildStatus.parse("running")).toBe("running");
      expect(WorkersBuildStatus.safeParse("paused").success).toBe(false);
      expect(WorkersBuildOutcome.parse("success")).toBe("success");
      expect(WorkersBuildOutcome.safeParse("ok").success).toBe(false);
      expect(WorkersTriggerSource.parse("manual")).toBe("manual");
      expect(WorkersTriggerSource.safeParse("cron").success).toBe(false);
    });
  });

  describe("WorkersBuildEvent", () => {
    it("decodes ISO date fields to Date and round-trips back to ISO strings", () => {
      const wire = {
        build_id: "b-1",
        script_name: "my-worker",
        trigger_id: "t-1",
        trigger_source: "push",
        status: "stopped",
        outcome: "success",
        branch: "main",
        commit_hash: "deadbeef",
        started_at: "2026-05-01T10:00:00.000Z",
        completed_at: "2026-05-01T10:05:00.000Z",
        created_at: "2026-05-01T09:59:00.000Z",
      };
      const decoded = WorkersBuildEvent.parse(wire);
      expect(decoded.created_at).toBeInstanceOf(Date);
      expect(decoded.started_at).toBeInstanceOf(Date);
      expect(decoded.outcome).toBe("success");

      const encoded = WorkersBuildEvent.encode(decoded);
      expect(encoded.created_at).toBe("2026-05-01T09:59:00.000Z");
      expect(encoded.started_at).toBe("2026-05-01T10:00:00.000Z");
      expect(encoded.completed_at).toBe("2026-05-01T10:05:00.000Z");
    });

    it("accepts an in-flight event with no outcome or completion time", () => {
      const decoded = WorkersBuildEvent.parse({
        build_id: "b-2",
        script_name: "w",
        trigger_id: "t",
        trigger_source: "api",
        status: "running",
        branch: "dev",
        commit_hash: "abc",
        created_at: "2026-05-01T00:00:00.000Z",
      });
      expect(decoded.outcome).toBeUndefined();
      expect(decoded.completed_at).toBeUndefined();
    });

    it("rejects an unknown status", () => {
      expect(
        WorkersBuildEvent.safeParse({
          build_id: "b",
          script_name: "w",
          trigger_id: "t",
          trigger_source: "push",
          status: "bogus",
          branch: "main",
          commit_hash: "abc",
          created_at: "2026-05-01T00:00:00.000Z",
        }).success,
      ).toBe(false);
    });
  });
});
