// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { renderDevSecretsNotes } from "./report";
import type { DevSecretsSeedReport } from "./seed";

const empty: DevSecretsSeedReport = {
  seeded: [],
  unchanged: [],
  minted: [],
  devVars: [],
  missing: [],
  undeclared: [],
  skipped: [],
};

describe("renderDevSecretsNotes", () => {
  test("a run that changed nothing says nothing — pithy dev seeds on every start", () => {
    expect(renderDevSecretsNotes({ ...empty, unchanged: ["auth-session-secret"] })).toEqual([]);
  });

  test("names what it minted, where it landed, and what it seeded, and says the mint is local", () => {
    // The absolute path, not the file's name. The file is outside the checkout since #156, so
    // "minted into secrets.jsonc" names nothing the reader can open — and a project sharing a name
    // with another is only visible from the whole path.
    const lines = renderDevSecretsNotes({
      ...empty,
      path: "/home/u/.config/pithy/replay/secrets.jsonc",
      minted: ["auth-session-secret"],
      seeded: ["auth-session-secret"],
    });
    expect(lines.join("\n")).toContain("/home/u/.config/pithy/replay/secrets.jsonc");
    expect(lines.join("\n")).toMatch(/local/i);
    expect(lines.join("\n")).toContain("Seeded auth-session-secret");
  });

  test("a missing secret is doctor's to report, not every run's", () => {
    // auth declares four OAuth credential pairs and almost every project sets none. Naming them here
    // put four names in front of every `pithy dev` and every `pithy seed`, about nothing that changed.
    expect(renderDevSecretsNotes({ ...empty, missing: ["auth-google-credentials"] })).toEqual([]);
  });

  test("several names read as a sentence, not a JSON array", () => {
    const lines = renderDevSecretsNotes({ ...empty, minted: ["a-one", "b-two", "c-three"] });
    expect(lines[0]).toContain("a-one, b-two and c-three");
  });

  test("a skipped Worker is named with the one thing it needs", () => {
    const lines = renderDevSecretsNotes({ ...empty, skipped: [{ worker: "board", reason: "Run pithy migrate." }] });
    expect(lines).toEqual(["board: secrets not seeded. Run pithy migrate."]);
  });

  test("a Worker the value could not be delivered to is never silent — that is a binding it will not have", () => {
    // The one line between "seeded" and a Worker that starts with no secret at all. A failed link used
    // to be swallowed, and the run reported the delivery as done.
    const lines = renderDevSecretsNotes({ ...empty, undelivered: ["/p/apps/board has no .dev.vars: EACCES"] });
    expect(lines).toEqual(["/p/apps/board has no .dev.vars: EACCES"]);
  });

  test("an undeclared name is doctor's too — this runs mid-`pithy add`, on a config already rewritten", () => {
    // `pithy add auth` imports the Worker config before it rewrites it, so the process is still holding
    // the pre-write module when this renders. It reported the value it had just minted as undeclared.
    expect(renderDevSecretsNotes({ ...empty, undeclared: ["gone-key"] })).toEqual([]);
  });
});
