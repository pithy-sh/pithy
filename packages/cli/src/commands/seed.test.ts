import { describe, expect, test } from "vitest";
import seed from "./seed";

/** The args are a static object literal on this command — resolve their type for the assertions. */
type ArgSpec = { type: string; default?: unknown };
const args = seed.args as Record<string, ArgSpec>;

describe("seed command", () => {
  test("is a non-interactive, agent-drivable command with the documented flags", () => {
    expect(seed.meta).toMatchObject({ name: "seed" });
    // Every lifecycle command works headlessly with full flags and a --json surface (docs/CLI.md).
    expect(Object.keys(args)).toEqual(["env", "json", "dry-run", "yes", "confirm-production"]);
    expect(args.env).toMatchObject({ type: "string", default: "dev" });
    expect(args.json).toMatchObject({ type: "boolean" });
    expect(args["dry-run"]).toMatchObject({ type: "boolean" });
    expect(args["confirm-production"]).toMatchObject({ type: "string" });
  });
});
