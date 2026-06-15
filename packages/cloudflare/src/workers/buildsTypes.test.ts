import { describe, expect, it } from "vitest";
import { CfBuild, CfBuildLog, CfBuildToken, CfBuildTrigger, CfRepoConnection, CfTriggerEnvVar } from "./buildsTypes";

describe("buildsTypes", () => {
  describe("CfRepoConnection", () => {
    it("decodes ISO dates to Date and round-trips back to ISO strings", () => {
      const wire = {
        repo_connection_uuid: "rc-1",
        repo_id: "42",
        repo_name: "group/repo",
        provider_type: "gitlab",
        provider_account_id: "group:7",
        provider_account_name: "acme",
        created_on: "2026-01-02T03:04:05.000Z",
        modified_on: "2026-01-03T03:04:05.000Z",
      };
      const decoded = CfRepoConnection.parse(wire);
      expect(decoded.created_on).toBeInstanceOf(Date);
      expect(decoded.created_on.toISOString()).toBe("2026-01-02T03:04:05.000Z");
      const encoded = CfRepoConnection.encode(decoded);
      expect(encoded.created_on).toBe("2026-01-02T03:04:05.000Z");
      expect(encoded.modified_on).toBe("2026-01-03T03:04:05.000Z");
    });

    it("accepts an absent deleted_on", () => {
      const decoded = CfRepoConnection.parse({
        repo_connection_uuid: "rc-1",
        repo_id: "1",
        repo_name: "r",
        provider_type: "github",
        provider_account_id: "a",
        provider_account_name: "n",
        created_on: "2026-01-02T00:00:00.000Z",
        modified_on: "2026-01-02T00:00:00.000Z",
      });
      expect(decoded.deleted_on).toBeUndefined();
    });
  });

  describe("CfBuildTrigger", () => {
    it("round-trips with nullable optional fields present", () => {
      const wire = {
        trigger_uuid: "t-1",
        external_script_id: "hex-1",
        build_token_uuid: "bt-1",
        build_command: "bun run build",
        deploy_command: "echo deploy",
        root_directory: "/",
        branch_includes: ["main"],
        created_on: "2026-02-01T00:00:00.000Z",
        modified_on: "2026-02-02T00:00:00.000Z",
      };
      const decoded = CfBuildTrigger.parse(wire);
      expect(decoded.created_on).toBeInstanceOf(Date);
      expect(decoded.branch_includes).toEqual(["main"]);
      const encoded = CfBuildTrigger.encode(decoded);
      expect(encoded.created_on).toBe("2026-02-01T00:00:00.000Z");
    });
  });

  describe("CfBuild", () => {
    it("decodes lifecycle timestamps and nested metadata", () => {
      const wire = {
        build_uuid: "b-1",
        status: "running",
        build_outcome: null,
        running_on: "2026-03-01T10:00:00.000Z",
        created_on: "2026-03-01T09:59:00.000Z",
        modified_on: "2026-03-01T10:00:00.000Z",
        build_trigger_metadata: { branch: "main", commit_hash: "abc123", extra: "kept" },
        trigger: { trigger_uuid: "t-1", external_script_id: "hex-1" },
      };
      const decoded = CfBuild.parse(wire);
      expect(decoded.running_on).toBeInstanceOf(Date);
      expect(decoded.build_trigger_metadata?.branch).toBe("main");
      // .loose() keeps unknown keys.
      expect((decoded.build_trigger_metadata as Record<string, unknown>).extra).toBe("kept");
      const encoded = CfBuild.encode(decoded);
      expect(encoded.created_on).toBe("2026-03-01T09:59:00.000Z");
      expect(encoded.running_on).toBe("2026-03-01T10:00:00.000Z");
    });

    it("accepts a minimal build with only required fields", () => {
      const decoded = CfBuild.parse({
        build_uuid: "b-2",
        status: "queued",
        created_on: "2026-03-01T00:00:00.000Z",
        modified_on: "2026-03-01T00:00:00.000Z",
      });
      expect(decoded.build_outcome).toBeUndefined();
      expect(decoded.running_on).toBeUndefined();
    });
  });

  describe("CfBuildLog", () => {
    it("round-trips its timestamp", () => {
      const decoded = CfBuildLog.parse({ line: 3, timestamp: "2026-04-01T00:00:00.000Z", message: "hi" });
      expect(decoded.timestamp).toBeInstanceOf(Date);
      expect(CfBuildLog.encode(decoded).timestamp).toBe("2026-04-01T00:00:00.000Z");
    });
  });

  describe("CfTriggerEnvVar", () => {
    it("accepts both plain_text and secret_text", () => {
      expect(CfTriggerEnvVar.parse({ name: "A", value: "1", type: "plain_text" }).type).toBe("plain_text");
      expect(CfTriggerEnvVar.parse({ name: "B", value: "2", type: "secret_text" }).type).toBe("secret_text");
    });

    it("rejects an unknown type", () => {
      expect(CfTriggerEnvVar.safeParse({ name: "A", value: "1", type: "nope" }).success).toBe(false);
    });
  });

  describe("CfBuildToken", () => {
    it("parses a token", () => {
      expect(CfBuildToken.parse({ build_token_uuid: "u", build_token_name: "n" })).toEqual({
        build_token_uuid: "u",
        build_token_name: "n",
      });
    });
  });
});
