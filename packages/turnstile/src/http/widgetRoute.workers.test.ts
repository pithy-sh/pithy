// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { createBackend } from "@pithy-sh/core/src/createBackend";
import { secrets } from "@pithy-sh/secrets/src/capability";
import { seedSecrets } from "@pithy-sh/secrets/src/test-utils/secretFixtures";
import { describe, expect, test } from "vitest";
import { turnstile } from "../capability";
import type { TurnstileConfigInput } from "../config/config";
import { testSitekey } from "../provision/testKeys";
import { TURNSTILE_SECRET_NAME, turnstileSecretsRegistry } from "../secret/registry";
import { TURNSTILE_WIDGET_PATH } from "./widgetPage";

const SITEKEYS = { dev: "0xDEVSITEKEY", staging: "0xSTAGINGSITEKEY", prod: "0xPRODSITEKEY" };
const SECRET = "0xWIDGETSECRET-must-never-reach-the-page";

/** A composed Worker, the way an adopter's mount builds it, answering one GET at `path`. */
async function get(
  path: string,
  options: { config?: TurnstileConfigInput; compose?: boolean; environment?: string } = {},
): Promise<Response> {
  const capabilities =
    options.compose === false
      ? [secrets({ registry: {} })]
      : [secrets({ registry: {} }), turnstile(options.config ?? { widgets: { visible: { sitekeys: SITEKEYS } } })];
  const app = createBackend({ capabilities });
  return app.request(path, {}, { ...env, ENVIRONMENT: options.environment ?? "prod" });
}

describe(`GET ${TURNSTILE_WIDGET_PATH}`, () => {
  test("is served when turnstile is composed", async () => {
    const response = await get(TURNSTILE_WIDGET_PATH);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
  });

  test("is not served when turnstile is not composed", async () => {
    const response = await get(TURNSTILE_WIDGET_PATH, { compose: false });
    expect(response.status).toBe(404);
  });

  test("answers with a CSP whose nonce is the one on the page, fresh per response", async () => {
    const first = await get(TURNSTILE_WIDGET_PATH);
    const csp = first.headers.get("content-security-policy") ?? "";
    const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
    expect(nonce).toBeTruthy();
    expect(csp).toContain("frame-ancestors 'none'");
    expect(await first.text()).toContain(`nonce="${nonce}"`);
    const second = await get(TURNSTILE_WIDGET_PATH);
    expect(second.headers.get("content-security-policy")).not.toContain(`'nonce-${nonce}'`);
    expect(first.headers.get("cache-control")).toBe("no-store");
    expect(first.headers.get("x-frame-options")).toBe("DENY");
  });

  test("renders the environment's sitekey and the login action", async () => {
    const html = await (await get(TURNSTILE_WIDGET_PATH, { environment: "staging" })).text();
    expect(html).toContain(`data-sitekey="${SITEKEYS.staging}"`);
    expect(html).toContain('data-action="login"');
    expect(html).toContain('data-mode="visible"');
  });

  test("renders the mode `protect.login` names", async () => {
    const config = { widgets: { invisible: { sitekeys: SITEKEYS } }, protect: { login: "invisible" as const } };
    const html = await (await get(TURNSTILE_WIDGET_PATH, { config })).text();
    expect(html).toContain('data-mode="invisible"');
    expect(html).toContain(`data-sitekey="${SITEKEYS.prod}"`);
  });

  test("a feature build with no stated key renders the mode's test sitekey", async () => {
    const html = await (await get(TURNSTILE_WIDGET_PATH, { environment: "feature" })).text();
    expect(html).toContain(`data-sitekey="${testSitekey("visible")}"`);
  });

  test("escapes a sitekey the config states", async () => {
    const config = { widgets: { visible: { sitekeys: { ...SITEKEYS, prod: `"><script>alert(1)</script>` } } } };
    const html = await (await get(TURNSTILE_WIDGET_PATH, { config })).text();
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain('data-sitekey="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"');
  });

  test("never carries the widget secret, even with one provisioned", async () => {
    await seedSecrets(env, turnstileSecretsRegistry, { [TURNSTILE_SECRET_NAME]: { visible: { key: SECRET } } });
    const response = await get(TURNSTILE_WIDGET_PATH);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).not.toContain(SECRET);
    expect(html).not.toContain("WIDGETSECRET");
  });

  test("answers 404 when no widget is renderable in this environment", async () => {
    const config = { widgets: { visible: { sitekeys: { ...SITEKEYS, prod: "" } } } };
    const response = await get(TURNSTILE_WIDGET_PATH, { config });
    expect(response.status).toBe(404);
  });

  test("answers 404 on a Worker no environment is stamped on", async () => {
    const app = createBackend({
      capabilities: [secrets({ registry: {} }), turnstile({ widgets: { visible: { sitekeys: SITEKEYS } } })],
    });
    const { ENVIRONMENT: _stamped, ...unstamped } = env as typeof env & { ENVIRONMENT?: string };
    const response = await app.request(TURNSTILE_WIDGET_PATH, {}, unstamped);
    expect(response.status).toBe(404);
  });

  test("answers 404 when `protect` gates no login", async () => {
    const config = { widgets: { visible: { sitekeys: SITEKEYS } }, protect: {} };
    const response = await get(TURNSTILE_WIDGET_PATH, { config });
    expect(response.status).toBe(404);
  });

  test("passes a valid theme and language through, escaped onto the host", async () => {
    const html = await (await get(`${TURNSTILE_WIDGET_PATH}?theme=dark&language=pt-br`)).text();
    expect(html).toContain('data-theme="dark"');
    expect(html).toContain('data-language="pt-br"');
  });

  test("defaults the theme and language to Cloudflare's own choice", async () => {
    const html = await (await get(TURNSTILE_WIDGET_PATH)).text();
    expect(html).toContain('data-theme="auto"');
    expect(html).toContain('data-language="auto"');
  });

  test("refuses a query it does not recognize the shape of", async () => {
    const theme = await get(`${TURNSTILE_WIDGET_PATH}?theme=%22%3E%3Cscript%3E`);
    expect(theme.status).toBe(400);
    const language = await get(`${TURNSTILE_WIDGET_PATH}?language=%22onload%3D`);
    expect(language.status).toBe(400);
  });
});
