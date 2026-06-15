import { describe, expect, it } from "vitest";
import { R2Credentials } from "./r2Credentials";

describe("R2Credentials", () => {
  it("accepts a well-formed credential pair and round-trips it", () => {
    const input = { accessKeyId: "ak-1", secretAccessKey: "sk-1" };
    const parsed = R2Credentials.parse(input);
    expect(parsed).toEqual(input);
  });

  it("rejects an empty accessKeyId", () => {
    expect(() => R2Credentials.parse({ accessKeyId: "", secretAccessKey: "sk-1" })).toThrow();
  });

  it("rejects an empty secretAccessKey", () => {
    expect(() => R2Credentials.parse({ accessKeyId: "ak-1", secretAccessKey: "" })).toThrow();
  });
});
