// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { clientError } from "@pithy-sh/core/src/error/client";
import { guaranteedErrorParams } from "@pithy-sh/core/src/error/messageParams";
import type { ErrorPayload } from "@pithy-sh/core/src/error/payload";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { operatorError, renderTerminal } from "@pithy-sh/core/src/error/terminal";
import {
  decodeWorkflowStepMessage,
  encodeWorkflowStepMessage,
  MAX_WORKFLOW_STEP_TEXT,
} from "@pithy-sh/core/src/workflow/stepMessage";
import { APIError } from "cloudflare";
import { describe, expect, it } from "vitest";
import {
  cloudflareApiErrors,
  cloudflareRefusal,
  cloudflareRequest,
  cloudflareSaid,
  isAuthorizationError,
} from "./errors";

/**
 * The body `GET /accounts/<id>/challenges/widgets` actually returned during the `pithy-sh/dashboard`
 * bring-up on cli 0.2.2 (#534), recorded verbatim. The token reached D1, Workers and Secrets Store on
 * the same run and was refused only Turnstile — a missing product grant, which the CLI reported as
 * "Cloudflare request failed: Turnstile list widgets for 'app.pithy.sh'." and nothing else.
 */
const TURNSTILE_DENIAL = `{"success":false,"errors":[{"code":10000,"message":"Authentication error","documentation_url":"https://developers.cloudflare.com/api/resources/turnstile/subresources/widgets/methods/list"}]}`;

/** A CF envelope as an SDK throw: `APIError.generate` is the constructor the client itself calls. */
function apiError(status: number, body: string): unknown {
  return APIError.generate(status, JSON.parse(body), undefined, new Headers());
}

/** Run `fn` through the real wrapper and hand back the payload it refused with. */
async function refusalOf(operation: string, thrown: unknown): Promise<ErrorPayload> {
  try {
    await cloudflareRequest(operation, () => Promise.reject(thrown));
  } catch (error) {
    if (error instanceof PithyError) return error.payload;
    throw error;
  }
  throw new Error("cloudflareRequest resolved; expected it to refuse.");
}

describe("cloudflareRequest", () => {
  it("renders Cloudflare's own code, sentence and documentation link to the operator", async () => {
    const payload = await refusalOf("Turnstile list widgets for 'app.pithy.sh'", apiError(401, TURNSTILE_DENIAL));

    // The whole refusal, verbatim — the operator's rendered bytes, not the payload's fields.
    expect(renderTerminal(payload)).toBe(
      [
        "Cloudflare request failed: Turnstile list widgets for 'app.pithy.sh'. Cloudflare said: 10000 Authentication error — https://developers.cloudflare.com/api/resources/turnstile/subresources/widgets/methods/list",
        "A missing grant, a dead token and the wrong account all look the same here. Check the token for Account → Turnstile, then CLOUDFLARE_API_TOKEN, then CLOUDFLARE_ACCOUNT_ID.",
      ].join("\n"),
    );
    // Two lines, and the second is the action. The message is one line because the newline is a field
    // separator — `renderTerminal`'s, and `stepMessage`'s across a durable step boundary — so a
    // `message` that carries one loses the remedy at the CLI and the whole refusal at a Workflow step.
    expect(renderTerminal(payload).split("\n")).toHaveLength(2);
    expect(payload.message).not.toContain("\n");
    expect(payload.code).toBe("cloudflare/request_failed");
    expect(payload.status).toBe(502);
  });

  it("puts the structured code and link in params, for a client that renders its own wording", async () => {
    const payload = await refusalOf("Turnstile list widgets for 'app.pithy.sh'", apiError(401, TURNSTILE_DENIAL));

    expect(payload.params).toEqual({
      apiAnswer: ": 10000 Authentication error",
      apiCode: 10000,
      apiMessage: "Authentication error",
      apiDocumentationUrl:
        "https://developers.cloudflare.com/api/resources/turnstile/subresources/widgets/methods/list",
    });
  });

  it("gives an agent reading --json what the human reads", async () => {
    const payload = await refusalOf("Turnstile list widgets for 'app.pithy.sh'", apiError(401, TURNSTILE_DENIAL));
    const json = operatorError(payload);

    expect(json.message).toContain("10000 Authentication error");
    expect(json.action).toContain("Account → Turnstile");
    expect(json).not.toHaveProperty("detail");
  });

  it("keeps the raw body internal: a client sees the projection, never the envelope", async () => {
    const payload = await refusalOf("Turnstile list widgets for 'app.pithy.sh'", apiError(401, TURNSTILE_DENIAL));

    // `detail` is where the raw body has always lived, and it is the field no audience but a log reads.
    expect(payload.detail).toContain('"success":false');
    expect(payload.message).not.toContain('"success":false');

    const client = clientError(payload);
    expect(client).not.toHaveProperty("action");
    expect(client).not.toHaveProperty("detail");
    expect(client.message).toContain("10000 Authentication error");
  });

  it("carries a non-auth code to the operator, and adds no permission line to it", async () => {
    const payload = await refusalOf(
      "Workers script info for 'app'",
      apiError(404, `{"success":false,"errors":[{"code":10007,"message":"workers.api.error.script_not_found"}]}`),
    );

    expect(payload.message).toBe(
      "Cloudflare request failed: Workers script info for 'app'. Cloudflare said: 10007 workers.api.error.script_not_found",
    );
    expect(payload.action).toBeUndefined();
  });

  it("names no product when Cloudflare names no endpoint", async () => {
    const payload = await refusalOf(
      "Email Service send",
      apiError(403, `{"success":false,"errors":[{"code":10000,"message":"Authentication error"}]}`),
    );

    expect(payload.action).toBe(
      "A missing grant, a dead token and the wrong account all look the same here. Check the token's permission for this product, then CLOUDFLARE_API_TOKEN, then CLOUDFLARE_ACCOUNT_ID.",
    );
  });

  it("degrades to the operation sentence when the failure carries no API answer", async () => {
    const payload = await refusalOf("KV get for key 'session:1'", new Error("ECONNRESET"));

    expect(payload.message).toBe("Cloudflare request failed: KV get for key 'session:1'.");
    expect(payload.action).toBeUndefined();
    expect(payload.detail).toBe("ECONNRESET");
    // `apiAnswer` is supplied on the degraded path too — that is the whole promise a locale writes
    // `{apiAnswer}` against, and `core`'s `GUARANTEED_ERROR_PARAMS` is where the promise is declared.
    expect(payload.params).toEqual({ apiAnswer: "" });
  });

  it("passes a PithyError already in flight through untouched", async () => {
    const configured = new PithyError({
      code: "cloudflare/not_configured",
      status: 500,
      message: "The Cloudflare REST client is not fully configured.",
    });

    await expect(cloudflareRequest("D1 query", () => Promise.reject(configured))).rejects.toBe(configured);
  });
});

describe("cloudflareApiErrors", () => {
  it("reads the SDK's parsed entries and an unwrapped envelope's array alike", () => {
    const entries = [
      { code: 10000, message: "Authentication error", documentation_url: "https://developers.cloudflare.com/api/x" },
    ];

    expect(cloudflareApiErrors(apiError(401, JSON.stringify({ success: false, errors: entries })))).toEqual([
      {
        code: 10000,
        message: "Authentication error",
        documentationUrl: "https://developers.cloudflare.com/api/x",
      },
    ]);
    // The raw-`fetch` path (CloudflareBuildsManager) hands the array straight in.
    expect(cloudflareApiErrors(entries)).toEqual(
      cloudflareApiErrors(apiError(401, JSON.stringify({ errors: entries }))),
    );
  });

  it("drops an entry that says nothing, and a documentation link that is not one", () => {
    expect(cloudflareApiErrors([{}, { source: { pointer: "/x" } }])).toEqual([]);
    expect(cloudflareApiErrors([{ code: 1, documentation_url: "javascript:alert(1)" }])).toEqual([{ code: 1 }]);
  });

  it("answers empty for anything that is not a Cloudflare envelope", () => {
    expect(cloudflareApiErrors(new Error("ECONNRESET"))).toEqual([]);
    expect(cloudflareApiErrors(undefined)).toEqual([]);
    expect(cloudflareApiErrors({ errors: "nope" })).toEqual([]);
  });
});

describe("cloudflareRefusal", () => {
  it("shows at most three entries and bounds the sentence that crosses to a client", () => {
    const long = "x".repeat(500);
    const payload = cloudflareRefusal({
      problem: "Cloudflare Builds returned 403.",
      apiErrors: cloudflareApiErrors([
        { code: 1, message: long },
        { code: 2, message: "two" },
        { code: 3, message: "three" },
        { code: 4, message: "four" },
      ]),
      status: 403,
      detail: "raw",
    }).payload;

    expect(payload.message).not.toContain("\n");
    expect(payload.message).not.toContain("four");
    expect(payload.message).toContain(`Cloudflare said: 1 ${"x".repeat(200)}; 2 two; 3 three`);
  });

  it("treats a 401 or 403 with no code at all as auth-class", () => {
    const bare = {
      problem: "Cloudflare request failed: get user.",
      apiErrors: [],
      detail: "401 status code (no body)",
    };

    expect(cloudflareRefusal({ ...bare, status: 401 }).payload.action).toContain("A missing grant");
    expect(cloudflareRefusal({ ...bare, status: 403 }).payload.action).toContain("A missing grant");
    expect(cloudflareRefusal({ ...bare, status: 500 }).payload.action).toBeUndefined();
  });
});

describe("isAuthorizationError", () => {
  it("stays 403-only: its callers swallow a denial, and a 401 is a dead token", () => {
    expect(isAuthorizationError(apiError(403, `{"success":false,"errors":[{"code":10000}]}`))).toBe(true);
    expect(isAuthorizationError(apiError(401, TURNSTILE_DENIAL))).toBe(false);
  });
});

describe("the action line answers auth, and only auth", () => {
  it("adds no permission line to a 403 whose code is not an auth code", async () => {
    // Cloudflare answers 403 for things that have nothing to do with credentials. `10021` is one, and
    // "add Account → Workers Scripts to it" changes nothing about a CPU limit. The status is a fallback
    // for a body-less throw, never a second way to reach the grant instruction.
    const payload = await refusalOf(
      "Workers script upload for 'app'",
      apiError(
        403,
        `{"success":false,"errors":[{"code":10021,"message":"Script startup exceeded CPU limit","documentation_url":"https://developers.cloudflare.com/api/resources/workers/subresources/scripts/methods/update"}]}`,
      ),
    );

    expect(payload.message).toContain("10021 Script startup exceeded CPU limit");
    expect(payload.action).toBeUndefined();
  });

  it("names the wrong account as a remedy, because a wrong-account token reaches other products", async () => {
    // The dichotomy this replaced — "reaches other products" → add the grant, "reaches none" → replace
    // the token — excluded the wrong-account case by construction: a token in the wrong account reaches
    // plenty in *its* account, so the operator was told to add a grant they already held.
    const payload = await refusalOf("Turnstile list widgets for 'app.pithy.sh'", apiError(401, TURNSTILE_DENIAL));

    expect(payload.action).toContain("CLOUDFLARE_ACCOUNT_ID");
    expect(payload.action).not.toContain("if it reaches none");
  });

  it("never reads a permission group off `Object.prototype`", async () => {
    // A plain object answers `constructor`, `toString` and `valueOf` for keys nobody put in the table.
    // Without the `Object.hasOwn` guard this action reads "add Account → function Object() { [native
    // code] }", which is a native function printed at an operator as a Cloudflare permission group.
    const payload = await refusalOf(
      "Something list",
      apiError(
        401,
        `{"success":false,"errors":[{"code":10000,"message":"Authentication error","documentation_url":"https://developers.cloudflare.com/api/resources/constructor/subresources/x/methods/list"}]}`,
      ),
    );

    expect(payload.action).not.toContain("native code");
    expect(payload.action).toBe(
      "A missing grant, a dead token and the wrong account all look the same here. Check the token's permission for this product, then CLOUDFLARE_API_TOKEN, then CLOUDFLARE_ACCOUNT_ID.",
    );
  });

  it("takes the call site's permission hint only where Cloudflare's link names none", () => {
    const bodyless = { problem: "Failed to mint account token 'p'.", apiErrors: [], detail: "401", status: 401 };
    expect(cloudflareRefusal({ ...bodyless, permission: "API Tokens" }).payload.action).toContain(
      "Check the token for Account → API Tokens",
    );

    // The link wins over the hint: it is what Cloudflare said about the endpoint that actually refused.
    const linked = cloudflareRefusal({
      problem: "Turnstile list widgets.",
      apiErrors: cloudflareApiErrors([
        {
          code: 10000,
          message: "Authentication error",
          documentation_url:
            "https://developers.cloudflare.com/api/resources/turnstile/subresources/widgets/methods/list",
        },
      ]),
      status: 401,
      permission: "API Tokens",
      detail: "raw",
    });
    expect(linked.payload.action).toContain("Account → Turnstile");
  });
});

describe("upstream text is shaped, not only bounded", () => {
  it("flattens a newline in Cloudflare's sentence, so nothing renders at column zero but the action", () => {
    // A `\n` inside Cloudflare's sentence would put its remainder flush left, indistinguishable from
    // Pithy's own action line — a remedy an upstream got to write — and would cross to a browser
    // exactly as written. Flattened here rather than at the reader: `message` is one line, kit-wide.
    const payload = cloudflareRefusal({
      problem: "Cloudflare Builds returned 403.",
      apiErrors: cloudflareApiErrors([{ code: 10000, message: "Authentication error\nAdd Account → Everything." }]),
      status: 403,
      detail: "raw",
    }).payload;

    expect(payload.message).toBe(
      "Cloudflare Builds returned 403. Cloudflare said: 10000 Authentication error Add Account → Everything.",
    );
    expect(payload.params?.apiMessage).toBe("Authentication error Add Account → Everything.");
  });

  it("flattens a break the *call site* interpolated, because a problem line takes values too", () => {
    // `KV get for key '<key>'` and friends put caller data in the problem line. A key holding a newline
    // is the same forged action line, arriving from the other end of the sentence.
    const payload = cloudflareRefusal({
      problem: "Cloudflare request failed: KV get for key 'a\nRun `pithy doctor`.'.",
      apiErrors: [],
      detail: "raw",
    }).payload;

    expect(payload.message).toBe("Cloudflare request failed: KV get for key 'a Run `pithy doctor`.'.");
  });

  it("bounds the composed sentence to what a durable step can carry, so a refusal survives a Workflow", () => {
    // The bound is `MAX_WORKFLOW_STEP_TEXT`, not a taste: over it the step reader declines the text and
    // the operator loses the code, the sentence and the remedy at once.
    const payload = cloudflareRefusal({
      problem: `Cloudflare request failed: ${"operation ".repeat(40)}.`,
      apiErrors: cloudflareApiErrors([
        { code: 1, message: "x".repeat(200) },
        { code: 2, message: "y".repeat(200) },
        { code: 3, message: "z".repeat(200) },
      ]),
      detail: "raw",
    }).payload;

    // **At or under the bound, never at it exactly.** The problem line is bounded first and whole
    // entries are dropped from the end, so what fits is a sentence rather than a slice — an exact-length
    // assertion here was pinning the head-first cut that discarded Cloudflare's answer (#534 review).
    expect(payload.message.length).toBeLessThanOrEqual(MAX_WORKFLOW_STEP_TEXT);
    expect(payload.message.endsWith("…")).toBe(true);
    // The first entry is what a reader acts on, and it survives however long the problem line was.
    expect(payload.message).toContain("Cloudflare said: 1 ");
    expect(decodeWorkflowStepMessage(encodeWorkflowStepMessage(payload))).not.toBeNull();
  });

  it("sanitizes before it measures, so a padded sentence is not truncated to whitespace", () => {
    const padded = `${" ".repeat(300)}Authentication error`;
    expect(cloudflareApiErrors([{ code: 1, message: padded }])).toEqual([{ code: 1, message: "Authentication error" }]);
  });

  it("drops a documentation link that is not one token", () => {
    expect(cloudflareApiErrors([{ code: 1, documentation_url: "https://example.com/a b" }])).toEqual([{ code: 1 }]);
  });
});

describe("the params a locale may interpolate", () => {
  it("supplies every name `core` declares guaranteed, on the answered path and the degraded one", async () => {
    // `@pithy-sh/i18n`'s Spanish catalog writes `{apiAnswer}` into the sentence for this code, and
    // `interpolate` leaves an unsupplied placeholder written out. So the promise is per-path, not
    // per-happy-path, and this is the half of it that lives beside the throw site.
    const guaranteed = guaranteedErrorParams("cloudflare/request_failed");
    expect(guaranteed).toEqual(["apiAnswer"]);

    const answered = await refusalOf("Turnstile list widgets", apiError(401, TURNSTILE_DENIAL));
    const degraded = await refusalOf("KV get", new Error("ECONNRESET"));
    for (const payload of [answered, degraded]) {
      for (const name of guaranteed) expect(Object.keys(payload.params ?? {})).toContain(name);
    }
  });

  it("holds on every path the composer has, because `refusalSites` proves those are all of them", async () => {
    // The declaration is a promise about *throw sites*, and until now only the declaration had a gate:
    // `@pithy-sh/i18n` reads `GUARANTEED_ERROR_PARAMS` and cannot reach a call. This is the other half.
    // It is a closed sweep rather than a list of remembered cases: `refusalSites.test.ts` fails any
    // construction of the refusal class outside `errors.ts` — its own prose is the one place the banned
    // literal may be spelled — so every refusal in the kit is composed by one of the paths below, and
    // `terminalWorkflowError`'s re-raise is held by `refusalAcrossSteps.test.ts`.
    const paths = [
      await refusalOf("answered", apiError(401, TURNSTILE_DENIAL)),
      await refusalOf("no body at all", apiError(401, "{}")),
      await refusalOf("never reached Cloudflare", new Error("ECONNRESET")),
      cloudflareRefusal({ problem: "composed directly.", apiErrors: [], detail: "raw" }).payload,
      cloudflareRefusal({
        problem: "composed directly.",
        apiErrors: cloudflareApiErrors([{ message: "Widget not found" }]),
        detail: "raw",
      }).payload,
    ];

    for (const payload of paths) {
      for (const name of guaranteedErrorParams("cloudflare/request_failed")) {
        expect(Object.keys(payload.params ?? {})).toContain(name);
      }
    }
  });

  it("carries its own separator, so one sentence closes correctly with an answer and without", async () => {
    const answered = await refusalOf("Turnstile list widgets", apiError(401, TURNSTILE_DENIAL));
    const degraded = await refusalOf("KV get", new Error("ECONNRESET"));

    expect(`Una frase${answered.params?.apiAnswer}.`).toBe("Una frase: 10000 Authentication error.");
    expect(`Una frase${degraded.params?.apiAnswer}.`).toBe("Una frase.");
  });
});

describe("what a refusal keeps when it does not fit", () => {
  /**
   * **The half that survives truncation is Cloudflare's, not ours (#534 review).**
   *
   * The composed sentence used to be sliced head-first at `MAX_WORKFLOW_STEP_TEXT`, and a call site
   * interpolates caller data into the problem line — `KV get for key '<key>'`, `R2 copy '<src>' to
   * '<dst>'`. Cloudflare permits a 512-byte KV key and a 1024-byte R2 one, so a long key pushed the code,
   * the sentence and the documentation link off the end and left the operator holding 59 characters of
   * their own key. The answer is the reason this path exists; the operation label is the part that can be
   * shortened without losing anything.
   */
  const authError = {
    code: 10000,
    message: "Authentication error",
    documentationUrl: "https://developers.cloudflare.com/api/x",
  };

  it("a key long enough to fill the budget still leaves the code and the link", () => {
    const said = cloudflareSaid(`KV get for key '${"k".repeat(512)}'`, [authError]);

    expect(said.message).toContain("10000");
    expect(said.message).toContain("Authentication error");
    expect(said.message).toContain("https://developers.cloudflare.com/api/x");
  });

  it("and the operation is still recognizable, not dropped for the answer's sake", () => {
    const said = cloudflareSaid(`KV get for key '${"k".repeat(512)}'`, [authError]);

    expect(said.message.startsWith("KV get for key 'kkk")).toBe(true);
    expect(said.message).toContain("…");
  });

  // Cloudflare's own body reaches the bound without any help from a call site: three entries with links
  // compose to roughly 810 characters. A dropped entry is a whole entry, because `toApiError` refuses a
  // link carrying whitespace on the ground that a printed link is one somebody clicks — and a link cut
  // mid-URL takes that back.
  it("three long entries drop whole, never leaving a half-written link", () => {
    const long = (code: number) => ({
      code,
      message: "z".repeat(200),
      documentationUrl: `https://developers.cloudflare.com/api/${String(code)}`,
    });
    const said = cloudflareSaid("Zone settings read.", [long(10202), long(10203), long(10204)]);

    expect(said.message).toContain("10202");
    for (const url of ["/api/10202", "/api/10203", "/api/10204"]) {
      const at = said.message.indexOf(url);
      if (at !== -1) expect(said.message.slice(at)).toContain(url);
    }
    expect(said.message).not.toMatch(/https:\/\/developers\.cloudflare\.com\/api\/\d*…/);
  });
});
