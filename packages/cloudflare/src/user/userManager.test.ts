import { beforeEach, describe, expect, it, vi } from "vitest";
import { CloudflareInvalidResponseError } from "../client/errors";
import { CloudflareUserManager } from "./userManager";

const mockUserGet = vi.fn();
const mockTokenVerify = vi.fn();
const mockTokenGet = vi.fn();

vi.mock("cloudflare", () => ({
  Cloudflare: class {
    user = {
      get: mockUserGet,
      tokens: { verify: mockTokenVerify, get: mockTokenGet },
    };
  },
}));

describe("CloudflareUserManager", () => {
  const config = { accountId: "acct-1", apiToken: "tok-1" };
  let manager: CloudflareUserManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new CloudflareUserManager(config);
  });

  it("reports its service type", () => {
    expect(manager.getServiceType()).toBe("Cloudflare User");
  });

  it("getUser decodes id and email (email survives even though the SDK type omits it)", async () => {
    mockUserGet.mockResolvedValue({ id: "cf-user-1", email: "dev@example.com", first_name: "Dev" });
    expect(await manager.getUser()).toEqual({ id: "cf-user-1", email: "dev@example.com" });
  });

  it("verifyToken decodes the token id and status", async () => {
    mockTokenVerify.mockResolvedValue({ id: "tok-9", status: "active", expires_on: "2030-01-01T00:00:00Z" });
    expect(await manager.verifyToken()).toEqual({ id: "tok-9", status: "active" });
  });

  it("getTokenName returns the token name", async () => {
    mockTokenGet.mockResolvedValue({ id: "tok-9", name: "ci-deployer", status: "active" });
    expect(await manager.getTokenName("tok-9")).toBe("ci-deployer");
  });

  it("getTokenName returns null when the response has no name", async () => {
    mockTokenGet.mockResolvedValue({ id: "tok-9" });
    expect(await manager.getTokenName("tok-9")).toBeNull();
  });

  it("throws cloudflare/invalid_response when the user shape is wrong", async () => {
    mockUserGet.mockResolvedValue({ id: 123 });
    await expect(manager.getUser()).rejects.toBeInstanceOf(CloudflareInvalidResponseError);
  });

  it("validateServiceAccess is false when the read fails", async () => {
    mockUserGet.mockRejectedValue(new Error("unauthorized"));
    expect(await manager.validateServiceAccess()).toBe(false);
  });
});
