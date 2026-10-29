// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * **Reading a live probe Worker's answer, for the suites that deploy one.** A probe Worker answers JSON, its
 * own failures included. An HTML page in its place is Cloudflare's, not the Worker's: a workers.dev address
 * that has not reached every machine yet, or a platform error page such as 1101 (an exception the Worker did
 * not catch) or 1102 (a resource limit). `response.json()` reports any of those as `Unexpected token '<'`,
 * which names none of them, so {@link readWorkerAnswer} reads the body as text and, when it is not JSON, fails
 * with the status, the `cf-ray`, the Cloudflare error code and the page's title.
 */

/** How much of a body that is not JSON a failure quotes. */
export const BODY_EXCERPT_CHARS = 300;

/** The Cloudflare error code and title an HTML error page carries, when it carries them. */
export function cloudflareErrorPage(body: string): { code: string | null; title: string | null } {
  const code =
    /class="cf-error-code"[^>]*>\s*(\d{3,4})\s*</i.exec(body)?.[1] ??
    /\bError(?:\s+code)?\s*:?\s*(1\d{3})\b/i.exec(body)?.[1] ??
    null;
  const title = /<title>([^<]*)<\/title>/i.exec(body)?.[1]?.replace(/\s+/g, " ").trim() || null;
  return { code, title };
}

/** One line describing an answer that was not the JSON the probe sends: status, ray, error code, title, excerpt. */
export function describeNonJsonAnswer(
  what: string,
  answer: { status: number; ray: string | null; body: string },
): string {
  const { code, title } = cloudflareErrorPage(answer.body);
  const excerpt = answer.body.replace(/\s+/g, " ").trim().slice(0, BODY_EXCERPT_CHARS);
  const parts = [
    `${what} answered ${answer.status} with a body that is not JSON`,
    `cf-ray ${answer.ray ?? "absent"}`,
    `Cloudflare error ${code ?? "none named"}`,
    ...(title ? [`title "${title}"`] : []),
  ];
  return `${parts.join(", ")}. Body: ${excerpt}`;
}

/**
 * The probe's JSON answer, or a failure that says what came back instead. A non-2xx JSON answer is the Worker's
 * own failure and is reported with its body; a body that is not JSON is Cloudflare's page, described by
 * {@link describeNonJsonAnswer}.
 */
export async function readWorkerAnswer(what: string, response: Response): Promise<unknown> {
  const body = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error(
      describeNonJsonAnswer(what, { status: response.status, ray: response.headers.get("cf-ray"), body }),
    );
  }
  if (!response.ok) throw new Error(`${what} answered ${response.status}: ${JSON.stringify(parsed)}`);
  return parsed;
}
