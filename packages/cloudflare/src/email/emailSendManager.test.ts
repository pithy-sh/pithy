import { beforeEach, describe, expect, it, vi } from "vitest";
import { CloudflareEmailSendManager } from "./emailSendManager";

const mockSend = vi.fn();

vi.mock("cloudflare", () => ({
  Cloudflare: class {
    emailSending = { send: mockSend };
  },
}));

/** The SDK's send result. Every field is required on the wire. */
const sendResult = {
  message_id: "msg-1",
  delivered: ["a@example.com"],
  queued: [],
  permanent_bounces: [],
};

const message = {
  to: "a@example.com",
  from: { email: "no-reply@pithy.sh" },
  subject: "Hello",
  html: "<p>Hi</p>",
  text: "Hi",
};

describe("CloudflareEmailSendManager", () => {
  const config = { accountId: "acct-1", apiToken: "tok-1" };
  let manager: CloudflareEmailSendManager;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    manager = new CloudflareEmailSendManager(config);
  });

  it("reports its service type", () => {
    expect(manager.getServiceType()).toBe("Email Sending");
  });

  describe("send", () => {
    it("maps the message onto the SDK params and decodes the result", async () => {
      mockSend.mockResolvedValue(sendResult);

      expect(await manager.send(message)).toEqual({
        messageId: "msg-1",
        delivered: ["a@example.com"],
        queued: [],
        permanentBounces: [],
      });
      expect(mockSend).toHaveBeenCalledWith({
        account_id: "acct-1",
        to: "a@example.com",
        from: "no-reply@pithy.sh",
        subject: "Hello",
        html: "<p>Hi</p>",
        text: "Hi",
      });
    });

    // The SDK's object form requires `name`; a bare string is the wire's own "address, no display
    // name". Sending `{ address, name: undefined }` would not typecheck and reads as a named sender.
    it("sends `from` as an object only when a display name exists", async () => {
      mockSend.mockResolvedValue(sendResult);

      await manager.send({ ...message, from: { email: "no-reply@pithy.sh", name: "Pithy" } });

      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({ from: { address: "no-reply@pithy.sh", name: "Pithy" } }),
      );
    });

    it("omits reply_to entirely when no replyTo is given", async () => {
      mockSend.mockResolvedValue(sendResult);

      await manager.send(message);

      expect(mockSend.mock.calls[0]?.[0]).not.toHaveProperty("reply_to");
    });

    it("passes replyTo through as reply_to", async () => {
      mockSend.mockResolvedValue(sendResult);

      await manager.send({ ...message, replyTo: "support@pithy.sh" });

      expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({ reply_to: "support@pithy.sh" }));
    });

    it("accepts an array of recipients", async () => {
      mockSend.mockResolvedValue(sendResult);

      await manager.send({ ...message, to: ["a@example.com", "b@example.com"] });

      expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({ to: ["a@example.com", "b@example.com"] }));
    });

    // The SDK raises on a `success: false` envelope, so a resolved call is a send and there is no
    // envelope check of our own — `cloudflareRequest` turns the throw into a typed PithyError.
    it("wraps an SDK failure as cloudflare/request_failed", async () => {
      mockSend.mockRejectedValue(new Error("quota exceeded"));

      await expect(manager.send(message)).rejects.toThrowError(
        expect.objectContaining({
          payload: expect.objectContaining({ code: "cloudflare/request_failed", detail: "quota exceeded" }),
        }),
      );
    });
  });

  describe("validateServiceAccess", () => {
    it("is true when the limits endpoint responds ok", async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal("fetch", fetchMock);

      expect(await manager.validateServiceAccess()).toBe(true);
      expect(fetchMock).toHaveBeenCalledWith(
        "https://api.cloudflare.com/client/v4/accounts/acct-1/email/sending/limits",
        { headers: { Authorization: "Bearer tok-1" } },
      );
    });

    it("is false on a non-ok response, and never throws on a network error", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
      expect(await manager.validateServiceAccess()).toBe(false);

      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
      expect(await manager.validateServiceAccess()).toBe(false);
    });
  });
});
