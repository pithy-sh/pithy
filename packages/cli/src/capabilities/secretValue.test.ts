// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { validateSecretValue } from "@pithy-sh/secrets/src/cli/validate";
import type { SecretRegistryEntry } from "@pithy-sh/secrets/src/registry";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { readSecretValue, type SecretBranchOption, type SecretPrompter, type SecretValueStdin } from "./secretValue";

/**
 * One string leaf that has said it fits on a terminal line. Every leaf of a `json` secret carries the
 * declaration (`@pithy-sh/secrets/src/cli/promptPlan`), and a leaf that has not is never asked for — so a
 * fixture without it would be testing the fallback rather than the prompts.
 */
const line = (description: string) => z.string().min(1).meta({ multiline: false }).describe(description);

/** Three optional rail blocks — `payments-provider-credentials` in miniature. */
const Credentials = z
  .strictObject({
    stripe: z
      .object({
        secretKey: line("The Stripe secret key."),
        webhookSecret: line("The Stripe webhook signing secret."),
      })
      .describe("Stripe's credentials, when the Stripe rail is enabled.")
      .optional(),
    paddle: z
      .object({
        apiKey: line("The Paddle API key."),
        webhookSecret: line("The Paddle notification secret."),
      })
      .describe("Paddle's credentials, when the Paddle rail is enabled.")
      .optional(),
    apple: z
      .object({ issuerId: line("The App Store issuer id.") })
      .describe("Apple's credentials, when the Apple rail is enabled.")
      .optional(),
  })
  .describe("Every enabled rail's credentials, in one secret.");

const CREDENTIALS: SecretRegistryEntry = {
  backend: "d1",
  scope: "environment",
  rotatable: true,
  valueType: "json",
  schema: Credentials,
};

/** A shape the walk declines: a union has no one field to ask for. */
const OPAQUE: SecretRegistryEntry = {
  backend: "d1",
  scope: "environment",
  rotatable: false,
  valueType: "json",
  schema: z.union([z.string(), z.object({ key: z.string().describe("k") }).describe("o")]).describe("Either."),
};

/** What one run asked, and what it was told. */
interface Recorded {
  prompter: SecretPrompter;
  asked: string[];
  chose: SecretBranchOption[][];
  notes: string[];
}

/** A prompter that answers every field with its own key, so an assembled object names what it was asked. */
function recorder(options: { choose?: string[]; cancelAt?: number } = {}): Recorded {
  const asked: string[] = [];
  const chose: SecretBranchOption[][] = [];
  const notes: string[] = [];
  return {
    asked,
    chose,
    notes,
    prompter: {
      password: async (message) => {
        asked.push(message);
        if (options.cancelAt !== undefined && asked.length > options.cancelAt) return null;
        return `answer-${asked.length}`;
      },
      choose: async (_message, offered) => {
        chose.push([...offered]);
        return options.choose ?? offered.map((option) => option.value);
      },
      note: (line) => notes.push(line),
    },
  };
}

/**
 * Piped input, in the chunks a real pipe arrives in.
 *
 * **No `isTTY`, which is the declaration rather than an omission.** Node leaves the property `undefined`
 * on a pipe, a file, and a closed descriptor alike, so *absent* is precisely what "a document is coming"
 * looks like — and a fake that had to remember to say so would be a fake that could forget.
 */
function piped(...chunks: string[]): SecretValueStdin {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield Buffer.from(chunk, "utf8");
    },
  };
}

/**
 * A stdin that is a terminal: nothing to read, and it says so the way Node says it.
 *
 * Every prompting test uses this rather than {@link piped}, because a terminal on stdin is the *only*
 * state in which a prompt is reached. It yields nothing, so a run that fell through to reading the
 * document would assemble an empty value instead of quietly reading the fixture's bytes.
 */
function terminal(): SecretValueStdin {
  return {
    isTTY: true,
    async *[Symbol.asyncIterator]() {
      // A terminal hands a value to the prompt, never to the reader.
    },
  };
}

/** A prompter that fails the test if anything asks it a question. */
const NEVER_ASKED: SecretPrompter = {
  password: async () => {
    throw new Error("a piped run must not prompt");
  },
  choose: async () => {
    throw new Error("a piped run must not prompt");
  },
  note: () => {
    throw new Error("a piped run must not prompt");
  },
};

describe("piped stdin", () => {
  test("takes one whole document, byte for byte, whatever the secret's shape is", async () => {
    const document = JSON.stringify({ stripe: { secretKey: "sk_live_1", webhookSecret: "whsec_1" } });
    expect(
      await readSecretValue({
        name: "payments-provider-credentials",
        mode: "create",
        entry: CREDENTIALS,
        branches: ["stripe", "paddle"],
        canPrompt: false,
        stdin: piped(document, "\n"),
        prompter: NEVER_ASKED,
      }),
    ).toBe(document);
  });

  test("keeps every byte a pipe sends, including the whitespace and the inner newlines", async () => {
    const document = '{\n  "clientId": "abc",\n  "clientSecret": "  spaced  "\n}';
    expect(
      await readSecretValue({
        name: "auth-google-credentials",
        mode: "update",
        entry: CREDENTIALS,
        branches: ["stripe"],
        canPrompt: false,
        stdin: piped(document),
        prompter: NEVER_ASKED,
      }),
    ).toBe(document);
  });
});

describe("one configured branch", () => {
  test("is named and asked for, never chosen between", async () => {
    const recorded = recorder();
    const value = await readSecretValue({
      name: "payments-provider-credentials",
      mode: "create",
      entry: CREDENTIALS,
      branches: ["paddle"],
      canPrompt: true,
      stdin: terminal(),
      prompter: recorded.prompter,
    });
    expect(recorded.chose).toEqual([]);
    expect(recorded.notes).toEqual(["paddle — Paddle's credentials, when the Paddle rail is enabled."]);
    expect(recorded.asked).toEqual([
      "paddle.apiKey — The Paddle API key.",
      "paddle.webhookSecret — The Paddle notification secret.",
    ]);
    expect(JSON.parse(value ?? "")).toEqual({ paddle: { apiKey: "answer-1", webhookSecret: "answer-2" } });
  });
});

describe("several configured branches", () => {
  test("only the configured ones are offered, and an unconfigured one is never written", async () => {
    const recorded = recorder();
    const value = await readSecretValue({
      name: "payments-provider-credentials",
      mode: "create",
      entry: CREDENTIALS,
      branches: ["stripe", "paddle"],
      canPrompt: true,
      stdin: terminal(),
      prompter: recorded.prompter,
    });
    expect(recorded.chose[0]?.map((option) => option.value)).toEqual(["stripe", "paddle"]);
    expect(recorded.chose[0]?.map((option) => option.hint)).toEqual([
      "Stripe's credentials, when the Stripe rail is enabled.",
      "Paddle's credentials, when the Paddle rail is enabled.",
    ]);
    expect(recorded.asked.some((message) => message.startsWith("apple."))).toBe(false);
    const parsed = JSON.parse(value ?? "");
    expect(Object.keys(parsed)).toEqual(["stripe", "paddle"]);
    expect(parsed.apple).toBeUndefined();
  });

  test("a branch the operator does not choose is absent entirely, not an empty block", async () => {
    const recorded = recorder({ choose: ["paddle"] });
    const value = await readSecretValue({
      name: "payments-provider-credentials",
      mode: "create",
      entry: CREDENTIALS,
      branches: ["stripe", "paddle"],
      canPrompt: true,
      stdin: terminal(),
      prompter: recorded.prompter,
    });
    expect(recorded.asked).toEqual([
      "paddle.apiKey — The Paddle API key.",
      "paddle.webhookSecret — The Paddle notification secret.",
    ]);
    expect(JSON.parse(value ?? "")).toEqual({ paddle: { apiKey: "answer-1", webhookSecret: "answer-2" } });
  });

  test("an update says what it is about to replace, because it cannot show what is there", async () => {
    const recorded = recorder();
    await readSecretValue({
      name: "payments-provider-credentials",
      mode: "update",
      entry: CREDENTIALS,
      branches: ["stripe", "paddle"],
      canPrompt: true,
      stdin: terminal(),
      prompter: recorded.prompter,
    });
    expect(recorded.notes[0]).toContain("An update replaces the whole secret.");
  });
});

/**
 * **An update destroys every block it is not asked about, and the case that needed saying was the case
 * that was silent.**
 *
 * `assembleSecretValue` emits the configured branches and `runWriteSecret` replaces the stored value
 * outright, so a block for a rail this project has since switched off is gone — and a project down to one
 * configured rail gets no checkbox, which is where the warning used to live. The CLI cannot read the
 * stored value to merge it forward (the manager seals it under a master key and the read seam answers a
 * presence bit), and refusing every update would leave no way to write one, so stating the consequence
 * every time is the whole of what is available. It is also enough: the operator who needs the other block
 * kept can pipe the document.
 */
describe("what an update warns about", () => {
  async function updateNotes(branches: readonly string[], entry = CREDENTIALS): Promise<string[]> {
    const recorded = recorder();
    await readSecretValue({
      name: "payments-provider-credentials",
      mode: "update",
      entry,
      branches,
      canPrompt: true,
      stdin: terminal(),
      prompter: recorded.prompter,
    });
    return recorded.notes;
  }

  test("one configured branch is warned too — it is the case with no checkbox to carry the warning", async () => {
    const notes = await updateNotes(["paddle"]);
    expect(notes[0]).toContain("An update replaces the whole secret.");
    expect(notes[0]).toContain("switched off");
  });

  test("several configured branches are warned before the checkbox is drawn", async () => {
    const notes = await updateNotes(["stripe", "paddle"]);
    expect(notes[0]).toContain("An update replaces the whole secret.");
  });

  test("a flat secret is warned about the fields it will drop", async () => {
    const flat: SecretRegistryEntry = {
      backend: "d1",
      scope: "environment",
      rotatable: false,
      valueType: "json",
      schema: z
        .object({
          clientId: line("The client id."),
          clientSecret: line("The client secret."),
        })
        .describe("A credential pair."),
    };
    expect((await updateNotes([], flat))[0]).toContain("An update replaces the whole secret.");
  });

  test("a create is never warned — it destroys nothing", async () => {
    const recorded = recorder();
    await readSecretValue({
      name: "payments-provider-credentials",
      mode: "create",
      entry: CREDENTIALS,
      branches: ["paddle"],
      canPrompt: true,
      stdin: terminal(),
      prompter: recorded.prompter,
    });
    expect(recorded.notes.some((note) => note.includes("replaces the whole secret"))).toBe(false);
  });
});

/**
 * **A value that may span lines is never collected one line at a time, and the declaration is what says
 * which values those are.**
 *
 * The plan refuses a field that declares `multiline` — Apple's `.p8`, Google's service-account key — and
 * refuses a field that has declared nothing, because a masked prompt truncates either one and the
 * fragment validates. Both fall back to one prompt for one JSON document, where the newline is escaped.
 * The PEM-delimiter trap below is the last resort for a field marked single-line **wrongly**; it is not
 * the defense, and the arm that claimed to be one — an answer "arriving with a newline" — is deleted,
 * because `capabilities/secretPrompt.pty.test.ts` measured that an answer never does.
 */
describe("a value that spans lines", () => {
  const WITH_PEM: SecretRegistryEntry = {
    backend: "d1",
    scope: "environment",
    rotatable: true,
    valueType: "json",
    schema: z
      .strictObject({
        apple: z
          .object({
            keyId: line("The App Store Connect key id."),
            privateKey: z.string().min(1).describe("The `.p8` file's contents.").meta({ multiline: true }),
          })
          .describe("Apple's credentials, when the Apple rail is enabled.")
          .optional(),
      })
      .describe("Every enabled rail's credentials, in one secret."),
  };

  test("is asked for as one document, and the fallback says which field is the reason", async () => {
    const recorded = recorder();
    const value = await readSecretValue({
      name: "payments-provider-credentials",
      mode: "create",
      entry: WITH_PEM,
      branches: ["apple"],
      canPrompt: true,
      stdin: terminal(),
      prompter: recorded.prompter,
    });
    expect(recorded.asked).toEqual(["Value for 'payments-provider-credentials'"]);
    expect(recorded.notes).toEqual([
      "apple.privateKey spans lines — so this secret is asked for as one JSON document.",
    ]);
    expect(value).toBe("answer-1");
  });

  /**
   * **An unmarked field is not asked for at all**, which is the fix and not the trap. The plan refuses,
   * the CLI asks for one JSON document, and the note says which field could not be asked for — so the
   * paste never meets a single-line prompt in the first place.
   */
  test("a field that declared nothing is asked for as one document, and the note says so", async () => {
    const unmarked: SecretRegistryEntry = {
      ...CREDENTIALS,
      schema: z
        .strictObject({
          stripe: z
            .object({
              secretKey: z.string().min(1).describe("The Stripe secret key."),
              webhookSecret: line("The Stripe webhook signing secret."),
            })
            .describe("Stripe's credentials, when the Stripe rail is enabled.")
            .optional(),
        })
        .describe("Every enabled rail's credentials, in one secret."),
    };
    const recorded = recorder();
    const value = await readSecretValue({
      name: "payments-provider-credentials",
      mode: "create",
      entry: unmarked,
      branches: ["stripe"],
      canPrompt: true,
      stdin: terminal(),
      prompter: recorded.prompter,
    });
    expect(recorded.asked).toEqual(["Value for 'payments-provider-credentials'"]);
    expect(recorded.notes).toEqual([
      "stripe.secretKey does not say whether it spans lines — so this secret is asked for as one JSON document.",
    ]);
    expect(value).toBe("answer-1");
  });

  /**
   * The trap, for the field somebody marked single-line and pasted a PEM into anyway. **Both delimiter
   * lines**, because which one survives is the terminal's choice: a CR-delimited paste leaves the header
   * and an LF-delimited one leaves the footer, both measured under a real pty. Watching for the header
   * alone caught one of the two.
   */
  test("a PEM pasted into a single-line field is refused, header line or footer line", async () => {
    for (const surviving of ["-----BEGIN PRIVATE KEY-----", "-----END PRIVATE KEY-----"]) {
      const prompter: SecretPrompter = {
        password: async () => surviving,
        choose: async (_message, offered) => offered.map((option) => option.value),
        note: () => {},
      };
      await expect(
        readSecretValue({
          name: "payments-provider-credentials",
          mode: "create",
          entry: CREDENTIALS,
          branches: ["stripe"],
          canPrompt: true,
          stdin: terminal(),
          prompter,
        }),
      ).rejects.toThrow(/stripe\.secretKey/);
    }
  });

  /**
   * **An indented PEM is still a PEM, and `startsWith` said otherwise.** Measured under the real pty with
   * a P-256 key and a 4096-bit RSA key: a document pasted with leading whitespace — copied out of a YAML
   * block, an indented heredoc, anything a formatter has touched — arrives as
   * `'  -----BEGIN PRIVATE KEY-----'`, and the trap accepted it. The signal is the delimiter line, not the
   * column it starts in.
   */
  test.each(["  ", "\t", "    \t "])("a PEM indented with %j is refused too", async (lead) => {
    for (const surviving of ["-----BEGIN PRIVATE KEY-----", "-----END CERTIFICATE-----"]) {
      const prompter: SecretPrompter = {
        password: async () => `${lead}${surviving}`,
        choose: async (_message, offered) => offered.map((option) => option.value),
        note: () => {},
      };
      await expect(
        readSecretValue({
          name: "payments-provider-credentials",
          mode: "create",
          entry: CREDENTIALS,
          branches: ["stripe"],
          canPrompt: true,
          stdin: terminal(),
          prompter,
        }),
      ).rejects.toThrow(/stripe\.secretKey/);
    }
  });

  /**
   * And it refuses only. A value that merely *contains* a delimiter further along is not a truncated
   * paste, and trimming must not have widened the match into the body of an answer.
   */
  test("a value with a delimiter after its first characters is not refused", async () => {
    const prompter: SecretPrompter = {
      password: async () => "sk_live_x-----BEGIN PRIVATE KEY-----",
      choose: async (_message, offered) => offered.map((option) => option.value),
      note: () => {},
    };
    await expect(
      readSecretValue({
        name: "payments-provider-credentials",
        mode: "create",
        entry: CREDENTIALS,
        branches: ["stripe"],
        canPrompt: true,
        stdin: terminal(),
        prompter,
      }),
    ).resolves.toBeTypeOf("string");
  });

  test("and the refusal names the field, never a character of the value", async () => {
    const header = "-----BEGIN PRIVATE KEY-----";
    const prompter: SecretPrompter = {
      password: async () => header,
      choose: async (_message, offered) => offered.map((option) => option.value),
      note: () => {},
    };
    const thrown = await readSecretValue({
      name: "payments-provider-credentials",
      mode: "create",
      entry: CREDENTIALS,
      branches: ["stripe"],
      canPrompt: true,
      stdin: terminal(),
      prompter,
    }).catch((error: unknown) => error);
    const payload = (thrown as { payload: { message: string; action?: string } }).payload;
    expect(payload.message).toContain("stripe.secretKey");
    expect(JSON.stringify(payload)).not.toContain(header);
    expect(payload.action).toContain("pithy secrets create payments-provider-credentials");
  });
});

describe("the assembled value", () => {
  test("passes the one parse gate, which is the same one a piped document passes", async () => {
    const recorded = recorder();
    const value = await readSecretValue({
      name: "payments-provider-credentials",
      mode: "create",
      entry: CREDENTIALS,
      branches: ["stripe"],
      canPrompt: true,
      stdin: terminal(),
      prompter: recorded.prompter,
    });
    expect(JSON.parse(validateSecretValue(CREDENTIALS, "payments-provider-credentials", value ?? ""))).toEqual({
      stripe: { secretKey: "answer-1", webhookSecret: "answer-2" },
    });
  });
});

describe("the fallback", () => {
  test("a schema the walk cannot ask for gets today's single prompt", async () => {
    const recorded = recorder();
    const value = await readSecretValue({
      name: "opaque-secret",
      mode: "create",
      entry: OPAQUE,
      branches: undefined,
      canPrompt: true,
      stdin: terminal(),
      prompter: recorded.prompter,
    });
    expect(recorded.asked).toEqual(["Value for 'opaque-secret'"]);
    expect(value).toBe("answer-1");
  });

  test("a branched secret no capability declared for gets it too, rather than five rails offered to one", async () => {
    const recorded = recorder();
    await readSecretValue({
      name: "payments-provider-credentials",
      mode: "create",
      entry: CREDENTIALS,
      branches: undefined,
      canPrompt: true,
      stdin: terminal(),
      prompter: recorded.prompter,
    });
    expect(recorded.asked).toEqual(["Value for 'payments-provider-credentials'"]);
    expect(recorded.chose).toEqual([]);
  });

  test("an undeclared name has no entry to plan from, so it is asked for whole", async () => {
    const recorded = recorder();
    await readSecretValue({
      name: "not-declared",
      mode: "create",
      entry: undefined,
      canPrompt: true,
      stdin: terminal(),
      prompter: recorded.prompter,
    });
    expect(recorded.asked).toEqual(["Value for 'not-declared'"]);
  });
});

describe("canceling", () => {
  test("stops at the field it was canceled on and writes nothing", async () => {
    const recorded = recorder({ cancelAt: 1 });
    expect(
      await readSecretValue({
        name: "payments-provider-credentials",
        mode: "create",
        entry: CREDENTIALS,
        branches: ["stripe"],
        canPrompt: true,
        stdin: terminal(),
        prompter: recorded.prompter,
      }),
    ).toBeNull();
    expect(recorded.asked).toHaveLength(2);
  });
});

/**
 * **The trap that is left, and the arm that was deleted.**
 *
 * `refuseSplitPaste` refused two shapes: an answer carrying a newline, and one opening `-----BEGIN`.
 * The newline arm was the stated backstop for every field nobody marked, and it **could never fire** —
 * a masked prompt submits at the newline, so an answer does not carry one. `secretPrompt.pty.test.ts`
 * measures that against the real `password()` on a real terminal; this file is where the consequence
 * lives, because a mocked prompter can hand the code a string no terminal would.
 *
 * So the arm is gone and the defense moved upstream, to a declaration every leaf carries and a repo-wide
 * sweep that fails the one that does not. What remains here is narrow and honest: a field marked
 * single-line **wrongly**, with a PEM pasted into it, leaves one delimiter line in the answer — and no
 * credential is one.
 */
describe("the truncated-paste trap", () => {
  /** A prompter that pastes `answer` into every question it is asked. */
  function pasting(answer: string): SecretPrompter {
    return {
      password: async () => answer,
      choose: async (_message, offered) => offered.map((option) => option.value),
      note: () => {},
    };
  }

  const read = (answer: string) =>
    readSecretValue({
      name: "payments-provider-credentials",
      mode: "create",
      entry: CREDENTIALS,
      branches: ["stripe"],
      canPrompt: true,
      stdin: terminal(),
      prompter: pasting(answer),
    });

  test("fires on the header line a CR-delimited paste leaves behind", async () => {
    const thrown = await read("-----BEGIN PRIVATE KEY-----").catch((error: unknown) => error);
    const payload = (thrown as { payload: { message: string } }).payload;
    expect(payload.message).toContain("one line of a PEM");
    expect(payload.message).toContain("stripe.secretKey");
  });

  test("fires on the footer line an LF-delimited paste leaves behind — the half a header check missed", async () => {
    const thrown = await read("-----END PRIVATE KEY-----").catch((error: unknown) => error);
    expect((thrown as { payload: { message: string } }).payload.message).toContain("one line of a PEM");
  });

  test("nothing of the value reaches the refusal, and the remedy is the pipe", async () => {
    const thrown = await read("-----BEGIN PRIVATE KEY-----").catch((error: unknown) => error);
    const payload = (thrown as { payload: { message: string; action?: string } }).payload;
    expect(JSON.stringify(payload)).not.toContain("PRIVATE KEY");
    expect(payload.action).toContain("pithy secrets create payments-provider-credentials");
  });

  /**
   * **It claims nothing about a body line, and must not.** `MIGabc…` is what a paste truncated between
   * its delimiters leaves, and it is shaped like every other credential — so it is accepted here, and
   * the reason no such value is ever asked for is the declaration, not this.
   */
  test("accepts anything that is not a delimiter line, including a PEM's body", async () => {
    expect(JSON.parse((await read("MIGTAgEAMBMGByqGSM49AgEGCCqGSM49")) ?? "")).toEqual({
      stripe: { secretKey: "MIGTAgEAMBMGByqGSM49AgEGCCqGSM49", webhookSecret: "MIGTAgEAMBMGByqGSM49AgEGCCqGSM49" },
    });
    expect(JSON.parse((await read("sk_live_only")) ?? "")).toEqual({
      stripe: { secretKey: "sk_live_only", webhookSecret: "sk_live_only" },
    });
  });
});

/**
 * **Which of the two questions decides which path, asked one at a time.**
 *
 * The regression the first remedy shipped was one boolean answering both: with `interactive` false
 * meaning *a document is piped*, a terminal on stdin plus `--json` — or plus a redirected stdout — took
 * the pipe branch and read the operator's terminal, unprompted and unmasked, for a credential. So the
 * matrix is held here rather than inferred: stdin decides whether there is a document, and `canPrompt`
 * decides only what happens when there is not.
 *
 * `commands/secretsInteractive.test.ts` runs the same matrix through a real pty, where `isTTY` is set by
 * the kernel rather than by a fixture.
 */
describe("the two questions", () => {
  const askedNothing: SecretPrompter = NEVER_ASKED;

  test("a document on stdin is read whatever canPrompt says — the agent path is one path", async () => {
    for (const canPrompt of [true, false]) {
      expect(
        await readSecretValue({
          name: "GOOGLE_CLIENT_SECRET",
          mode: "create",
          entry: undefined,
          canPrompt,
          stdin: piped("sk_live_1\n"),
          prompter: askedNothing,
        }),
      ).toBe("sk_live_1");
    }
  });

  test("a terminal on stdin with nowhere to draw is refused, never read in silence", async () => {
    const thrown = await readSecretValue({
      name: "GOOGLE_CLIENT_SECRET",
      mode: "create",
      entry: undefined,
      canPrompt: false,
      stdin: terminal(),
      prompter: askedNothing,
    }).catch((error: unknown) => error);
    const payload = (thrown as { payload: { code: string; message: string; action?: string } }).payload;
    expect(payload.code).toBe("validation/invalid_input");
    expect(payload.message).toContain("GOOGLE_CLIENT_SECRET");
    expect(payload.action).toContain("printf '%s' \"$VALUE\" | pithy secrets create GOOGLE_CLIENT_SECRET");
  });

  test("a terminal on stdin that can draw is prompted", async () => {
    const recorded = recorder();
    expect(
      await readSecretValue({
        name: "GOOGLE_CLIENT_SECRET",
        mode: "create",
        entry: undefined,
        canPrompt: true,
        stdin: terminal(),
        prompter: recorded.prompter,
      }),
    ).toBe("answer-1");
    expect(recorded.asked).toEqual(["Value for 'GOOGLE_CLIENT_SECRET'"]);
  });

  test("the refusal is a refusal: it returns no value and never reaches the prompter", async () => {
    await expect(
      readSecretValue({
        name: "payments-provider-credentials",
        mode: "update",
        entry: CREDENTIALS,
        branches: ["stripe", "paddle"],
        canPrompt: false,
        stdin: terminal(),
        prompter: askedNothing,
      }),
    ).rejects.toThrow(/No value was piped/);
  });
});
