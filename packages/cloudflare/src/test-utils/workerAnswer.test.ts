// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { BODY_EXCERPT_CHARS, cloudflareErrorPage, describeNonJsonAnswer, readWorkerAnswer } from "./workerAnswer";

/** The shape of a Cloudflare error page, cut down to the parts the reader looks at. */
const ERROR_1101 = `<!DOCTYPE html>
<html><head><title>Worker threw exception | probe.example.workers.dev | Cloudflare</title></head>
<body><h1><span class="cf-error-type">Error</span> <span class="cf-error-code">1101</span></h1></body></html>`;

describe("cloudflareErrorPage", () => {
  it("reads the error code and the title off a Cloudflare error page", () => {
    expect(cloudflareErrorPage(ERROR_1101)).toEqual({
      code: "1101",
      title: "Worker threw exception | probe.example.workers.dev | Cloudflare",
    });
  });

  it("reads a code written as prose when the page has no code element", () => {
    expect(cloudflareErrorPage("<html><body>Error 1042: no such Worker</body></html>").code).toBe("1042");
  });

  it("names nothing it cannot find", () => {
    expect(cloudflareErrorPage("<!DOCTYPE html><p>maintenance</p>")).toEqual({ code: null, title: null });
  });
});

describe("describeNonJsonAnswer", () => {
  it("names the status, the ray, the error code and the title", () => {
    expect(describeNonJsonAnswer("/mint", { status: 500, ray: "8d1e-IAD", body: ERROR_1101 })).toMatch(
      /^\/mint answered 500 with a body that is not JSON, cf-ray 8d1e-IAD, Cloudflare error 1101, title "Worker threw exception \| probe\.example\.workers\.dev \| Cloudflare"\. Body: <!DOCTYPE html>/,
    );
  });

  it("says when there is no ray and no code, and quotes a bounded excerpt", () => {
    const line = describeNonJsonAnswer("/ready", { status: 404, ray: null, body: `<p>${"x".repeat(1000)}</p>` });
    expect(line).toContain("cf-ray absent, Cloudflare error none named.");
    expect(line.split("Body: ")[1]).toHaveLength(BODY_EXCERPT_CHARS);
  });
});

describe("readWorkerAnswer", () => {
  it("returns the JSON of a 2xx answer", async () => {
    expect(await readWorkerAnswer("/tokens", Response.json({ total: 3 }))).toEqual({ total: 3 });
  });

  it("reports a JSON failure as the Worker's own, with its body", async () => {
    await expect(
      readWorkerAnswer("/mint", Response.json({ failure: "Error: quota", code: null }, { status: 500 })),
    ).rejects.toThrow('/mint answered 500: {"failure":"Error: quota","code":null}');
  });

  it("reports an HTML page as Cloudflare's, never as a JSON syntax error", async () => {
    const response = new Response(ERROR_1101, { status: 500, headers: { "cf-ray": "8d1e-IAD" } });
    await expect(readWorkerAnswer("/mint", response)).rejects.toThrow(
      /\/mint answered 500 with a body that is not JSON, cf-ray 8d1e-IAD, Cloudflare error 1101/,
    );
  });

  it("does not take a 2xx HTML page for an answer", async () => {
    await expect(readWorkerAnswer("/ready", new Response("<html></html>", { status: 200 }))).rejects.toThrow(
      /\/ready answered 200 with a body that is not JSON/,
    );
  });
});
