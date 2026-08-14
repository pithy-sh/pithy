// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PithyError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { defineSecretRegistry } from "@pithy-sh/secrets/src/registry";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { editDevSecrets, type OpenEditor } from "./edit";
import { devSecretsFile } from "./location";

let config: string;
/** `<config>/replay/secrets.jsonc` — the resolved absolute path, the only thing this module takes. */
let path: string;

beforeEach(async () => {
  config = await mkdtemp(join(tmpdir(), "pithy-secrets-edit-"));
  path = devSecretsFile("replay", { platform: "linux", homedir: "/home/nobody", env: { PITHY_CONFIG_DIR: config } });
});
afterEach(async () => {
  await chmod(config, 0o700).catch(() => {});
  await chmod(dirname(path), 0o700).catch(() => {});
  await rm(config, { recursive: true, force: true });
});

/** A value that must never leave the file. Distinctive, so a leak anywhere is unmistakable. */
const SECRET = "sk_live_51H8xQzKm9pWv3RtY";

/** A file holding one real-looking secret, plus a comment saying where it came from. */
/**
 * The project's registry, as `pithy secrets edit` now resolves it — the only thing that can say which
 * payload belongs in which slot (#323).
 */
const registry = defineSecretRegistry({
  "payments-stripe-key": { backend: "d1", scope: "environment", rotatable: true, valueType: "text" },
});

const SEEDED = `// Local dev secret values.
{
  // Minted by pithy add payments.
  "payments-stripe-key": { "currentVersion": "1", "versions": { "1": "${SECRET}" } }
}
`;

/** Put a file at the resolved path, creating the project directory the CLI would have created. */
async function seed(contents: string = SEEDED): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, contents, { mode: 0o600 });
}

/** Every draft this module leaves in the secrets directory. */
async function drafts(): Promise<string[]> {
  const entries = await readdir(dirname(path)).catch(() => [] as string[]);
  return entries.filter((name) => name.includes(".edit-"));
}

/** The mode bits of a path. */
async function mode(target: string): Promise<number> {
  return (await stat(target)).mode & 0o777;
}

/**
 * An editor stand-in. Each round writes the next text (or leaves the file alone when it is `null`) and
 * exits with the matching status. `seen` records what the editor was opened *on*, which is the whole
 * question for "the adopter's text survived".
 */
function editorWriting(
  rounds: readonly (string | null)[],
  statuses: readonly number[] = [],
): { editor: () => OpenEditor; seen: string[]; drafts: string[] } {
  const seen: string[] = [];
  const opened: string[] = [];
  let round = 0;
  const open: OpenEditor = async (file) => {
    seen.push(await readFile(file, "utf8"));
    opened.push(file);
    const next = rounds[round];
    if (next !== undefined && next !== null) await writeFile(file, next);
    const status = statuses[round] ?? 0;
    round += 1;
    return status;
  };
  return { editor: () => open, seen, drafts: opened };
}

/** The error a call is expected to refuse with. */
async function refusal(work: Promise<unknown>): Promise<PithyError> {
  const error = await work.then(
    () => null,
    (e: unknown) => e,
  );
  if (error instanceof PithyError) return error;
  throw new Error(`expected a refusal, got ${error === null ? "success" : String(error)}`);
}

describe("editDevSecrets — the ordinary edit", () => {
  test("the editor opens on what the file holds, comments and all", async () => {
    await seed();
    const { editor, seen } = editorWriting([null]);

    await editDevSecrets({ path, editor });

    expect(seen).toEqual([SEEDED]);
  });

  test("what the editor left is what the file holds, byte for byte", async () => {
    await seed();
    const edited = `${SEEDED.trimEnd()}\n// a note the adopter added\n`;
    const { editor } = editorWriting([edited]);

    const result = await editDevSecrets({ path, editor });

    expect(await readFile(path, "utf8")).toBe(edited);
    expect(result).toMatchObject({ changed: true, secrets: 1, reopened: 0 });
  });

  test("the file is 0600 and its directory 0700, whatever the editor left behind", async () => {
    await seed();
    // An editor that renames a new file into place hands over the umask default. `vim` does exactly
    // that with `backupcopy=no`, which is the default on most systems.
    const { editor } = editorWriting([SEEDED.replace(SECRET, "sk_live_rotated")]);

    await editDevSecrets({ path, editor });

    expect(await mode(path)).toBe(0o600);
    expect(await mode(dirname(path))).toBe(0o700);
  });

  test("no draft is left behind", async () => {
    await seed();
    await editDevSecrets({ path, editor: editorWriting([`${SEEDED}`]).editor });
    expect(await drafts()).toEqual([]);
  });

  test("the draft is 0600 while it is open, not only afterwards", async () => {
    // It holds every value the real file does, for as long as the adopter has the editor open.
    await seed();
    let draftMode = 0;
    let dirMode = 0;
    const editor = (): OpenEditor => async (file) => {
      draftMode = await mode(file);
      dirMode = await mode(dirname(file));
      return 0;
    };

    await editDevSecrets({ path, editor });

    expect(draftMode).toBe(0o600);
    expect(dirMode).toBe(0o700);
  });

  test("a project with no file yet opens on something that already parses", async () => {
    const { editor, seen } = editorWriting([
      '{ "auth-session-secret": { "currentVersion": "1", "versions": { "1": "abc" } } }\n',
    ]);

    const result = await editDevSecrets({ path, editor });

    expect(seen[0]).toContain("{}");
    expect(result).toMatchObject({ changed: true, secrets: 1 });
    expect(await mode(path)).toBe(0o600);
  });

  test("an edit that changes nothing writes nothing and leaves nothing", async () => {
    await seed();
    const before = await stat(path);
    const { editor } = editorWriting([null]);

    const result = await editDevSecrets({ path, editor });

    expect(result.changed).toBe(false);
    expect(await readFile(path, "utf8")).toBe(SEEDED);
    expect((await stat(path)).mtimeMs).toBe(before.mtimeMs);
    expect(await drafts()).toEqual([]);
  });

  test("an edit reverted back to the original is the same as no edit", async () => {
    await seed();
    const { editor } = editorWriting(["{ nope", SEEDED]);

    const result = await editDevSecrets({ path, editor, report: () => {} });

    expect(result.changed).toBe(false);
    expect(await readFile(path, "utf8")).toBe(SEEDED);
    expect(await drafts()).toEqual([]);
  });

  test("a project with no file that is not edited creates no file at all", async () => {
    const result = await editDevSecrets({ path, editor: editorWriting([null]).editor });

    expect(result.changed).toBe(false);
    await expect(stat(path)).rejects.toThrow();
  });
});

describe("editDevSecrets — an edit that does not parse", () => {
  test("it is re-opened on the adopter's own text, not on the original", async () => {
    // The unforgivable behaviour: re-opening the *file* would silently drop everything they typed,
    // and the value they were pasting in may be the only copy of it that exists.
    await seed();
    const malformed = `${SEEDED.trimEnd()}\n// unclosed`;
    const fixed = SEEDED.replace(SECRET, "sk_live_rotated");
    const { editor, seen } = editorWriting([`{ ${malformed}`, fixed]);

    const result = await editDevSecrets({ path, editor, report: () => {} });

    expect(seen[1]).toBe(`{ ${malformed}`);
    expect(result).toMatchObject({ changed: true, reopened: 1 });
    expect(await readFile(path, "utf8")).toBe(fixed);
  });

  test("the real file is untouched while the edit is being fixed", async () => {
    await seed();
    const during: string[] = [];
    let round = 0;
    const editor = (): OpenEditor => async (file) => {
      during.push(await readFile(path, "utf8"));
      await writeFile(file, round === 0 ? "{ broken" : SEEDED.replace(SECRET, "rotated"));
      round += 1;
      return 0;
    };

    await editDevSecrets({ path, editor, report: () => {} });

    expect(during).toEqual([SEEDED, SEEDED]);
  });

  test("an edit that stays broken is kept in a file the refusal names", async () => {
    await seed();
    const broken = '{ "payments-stripe-key": }';
    const { editor, seen } = editorWriting([broken, null]);

    const error = await refusal(editDevSecrets({ path, editor, report: () => {} }));

    expect(seen).toHaveLength(2);
    const left = await drafts();
    expect(left).toHaveLength(1);
    expect(await readFile(join(dirname(path), left[0] as string), "utf8")).toBe(broken);
    expect(error.payload.message).toContain(left[0] as string);
    expect(await readFile(path, "utf8")).toBe(SEEDED);
  });

  test("a schema failure is a failure too, not only a syntax one", async () => {
    await seed();
    // Valid JSONC, and not a secrets file: a bare value where an envelope belongs is the mistake
    // somebody makes migrating a line out of `.dev.vars`.
    //
    // **Judged against the registry, because nothing else can judge it (#323).** Which payload a slot
    // takes is the registry's answer — for this secret an envelope, for `SECRETS_ENCRYPTION_KEYS` the
    // value itself — so the command resolves the project's registry and hands it in.
    const { editor } = editorWriting([`{ "payments-stripe-key": "${SECRET}" }`, null]);

    const error = await refusal(editDevSecrets({ path, editor, registry, report: () => {} }));

    expect(error.payload.message).toContain("payments-stripe-key");
    expect(await readFile(path, "utf8")).toBe(SEEDED);
  });

  test("without a registry the same edit is accepted — nothing knows what belongs in that slot", async () => {
    // The cost of the optional registry, stated rather than left to be discovered. `pithy secrets edit`
    // on a project whose `pithy.config.ts` will not load still opens, still refuses broken JSONC, and
    // cannot judge a shape. Refusing to open at all would make the tool for fixing a project unusable
    // in the state that needs it.
    await seed();
    const { editor } = editorWriting([`{ "payments-stripe-key": "${SECRET}" }`, null]);

    const result = await editDevSecrets({ path, editor, report: () => {} });

    expect(result.changed).toBe(true);
  });

  test("the notice says the file has not been written", async () => {
    await seed();
    const said: string[] = [];
    const { editor } = editorWriting(["{ broken", SEEDED.replace(SECRET, "rotated")]);

    await editDevSecrets({ path, editor, report: (text) => said.push(text) });

    expect(said).toHaveLength(1);
    expect(said[0]).toContain("Nothing has been written");
  });

  test("the file the editor is opened on is the file the error names", async () => {
    // Naming the real path for a fault in the draft sends the adopter to a file that is fine.
    await seed();
    const said: string[] = [];
    const { editor, drafts: opened } = editorWriting(["{ broken", SEEDED.replace(SECRET, "rotated")]);

    await editDevSecrets({ path, editor, report: (text) => said.push(text) });

    expect(said[0]).toContain(opened[0] as string);
  });
});

describe("editDevSecrets — the edit is never the thing that is lost", () => {
  test("an editor that exits non-zero keeps the text and writes nothing", async () => {
    await seed();
    const attempt = SEEDED.replace(SECRET, "rotated");
    const { editor } = editorWriting([attempt], [1]);

    const error = await refusal(editDevSecrets({ path, editor }));

    const left = await drafts();
    expect(left).toHaveLength(1);
    expect(await readFile(join(dirname(path), left[0] as string), "utf8")).toBe(attempt);
    expect(error.payload.message).toContain(left[0] as string);
    expect(await readFile(path, "utf8")).toBe(SEEDED);
  });

  test("an editor that exits non-zero having changed nothing leaves no plaintext behind", async () => {
    // `:cq` out of vim. There is nothing to keep, so keeping a copy of every secret in the project
    // beside the file would be litter, not caution.
    await seed();
    const { editor } = editorWriting([null], [1]);

    const result = await editDevSecrets({ path, editor });

    expect(result.changed).toBe(false);
    expect(await drafts()).toEqual([]);
  });

  test("a file that changed underneath the edit is not clobbered", async () => {
    await seed();
    const minted = SEEDED.replace(
      "}\n",
      '  ,"auth-session-secret": { "currentVersion": "1", "versions": { "1": "x" } }\n}\n',
    );
    const editor = (): OpenEditor => async (file) => {
      await writeFile(file, SEEDED.replace(SECRET, "rotated"));
      // `pithy dev` in the next terminal, minting into the same file while the editor is open.
      await writeFile(path, minted);
      return 0;
    };

    const error = await refusal(editDevSecrets({ path, editor }));

    expect(await readFile(path, "utf8")).toBe(minted);
    expect((await drafts()).length).toBe(1);
    expect(error.payload.message).toContain(path);
  });

  test("no editor means no draft — nothing is created before there is something to open it with", async () => {
    await seed();
    const editor = () => {
      throw new ValidationError({ message: "No terminal here.", action: "Run this at a terminal." });
    };

    await refusal(editDevSecrets({ path, editor }));

    expect(await drafts()).toEqual([]);
  });

  test("an editor that deletes the file it was given is an abandon, not a write", async () => {
    await seed();
    const editor = (): OpenEditor => async (file) => {
      await rm(file);
      return 0;
    };

    const result = await editDevSecrets({ path, editor });

    expect(result.changed).toBe(false);
    expect(await readFile(path, "utf8")).toBe(SEEDED);
  });
});

describe("editDevSecrets — nothing it says carries a value", () => {
  test("not the notice, not the error, not the detail — for either kind of failure", async () => {
    await seed();
    for (const broken of [
      `{ "payments-stripe-key": { "versions": { "1": "${SECRET}" } }`,
      `{ "payments-stripe-key": "${SECRET}" }`,
    ]) {
      const said: string[] = [];
      const { editor } = editorWriting([broken, null]);

      const error = await refusal(editDevSecrets({ path, editor, registry, report: (text) => said.push(text) }));

      const everything = [...said, error.payload.message, error.payload.action ?? "", error.payload.detail ?? ""];
      for (const text of everything) expect(text).not.toContain(SECRET);
      // And it is still a usable diagnosis: it names the file that is wrong and what is wrong with it.
      expect(said.join("")).toMatch(/not valid JSONC|envelope/);
    }
  });

  test("the result carries a count, never a name or a value", async () => {
    await seed();
    const result = await editDevSecrets({ path, editor: editorWriting([SEEDED.replace(SECRET, "rotated")]).editor });

    expect(result).toEqual({ changed: true, secrets: 1, reopened: 0 });
    expect(JSON.stringify(result)).not.toContain("rotated");
  });
});
