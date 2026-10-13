// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { copyEntryOnce, copyTreeOnce } from "./treeCopy";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pithy-tree-copy-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("copyEntryOnce", () => {
  test("copies a file with its mode, into directories it makes", () => {
    writeFileSync(join(dir, "run.sh"), "echo hi\n", { mode: 0o755 });
    expect(copyEntryOnce(join(dir, "run.sh"), join(dir, "out", "deep", "run.sh"))).toBe(true);
    expect(readFileSync(join(dir, "out", "deep", "run.sh"), "utf8")).toBe("echo hi\n");
    expect(statSync(join(dir, "out", "deep", "run.sh")).mode & 0o777).toBe(0o755);
  });

  test("copies a symbolic link as the link it is, never what it points at", () => {
    symlinkSync("../somewhere", join(dir, "link"));
    expect(copyEntryOnce(join(dir, "link"), join(dir, "out", "link"))).toBe(true);
    expect(readlinkSync(join(dir, "out", "link"))).toBe("../somewhere");
  });

  test("reports a path already gone as not copied, and writes nothing", () => {
    expect(copyEntryOnce(join(dir, "gone"), join(dir, "out", "gone"))).toBe(false);
  });

  // The race this exists for: a parallel suite removes the file after the copy found it. Read through the open
  // descriptor, the removal cannot take the content away.
  test("a file removed after it was opened is still copied whole", () => {
    writeFileSync(join(dir, "transient.json"), "{}\n");
    const copied = copyEntryOnce(join(dir, "transient.json"), join(dir, "out", "transient.json"), (path) =>
      unlinkSync(path),
    );
    expect(copied).toBe(true);
    expect(readFileSync(join(dir, "out", "transient.json"), "utf8")).toBe("{}\n");
  });
});

/**
 * **A copy of a live tree tolerates whatever vanishes while it is taken (#711).** A full run copied `packages/email`
 * while another suite's deploy removed `.wrangler.feature.json` from it, and `fs.cp` failed with `ENOENT` between
 * listing the directory and reading the entry. A name filter covers the files it names; this covers the rest.
 */
describe("copyTreeOnce", () => {
  /** A small tree: files, a nested directory, a link. */
  function tree(): string {
    const source = join(dir, "source");
    mkdirSync(join(source, "src", "deep"), { recursive: true });
    writeFileSync(join(source, "package.json"), "{}\n");
    writeFileSync(join(source, "src", "a.ts"), "export {};\n");
    writeFileSync(join(source, "src", "transient.json"), "{}\n");
    writeFileSync(join(source, "src", "deep", "b.ts"), "export {};\n");
    symlinkSync("../elsewhere", join(source, "link"));
    return source;
  }

  test("copies files, directories and links as they are, and passes over what it is told to skip", () => {
    const source = tree();
    copyTreeOnce(source, join(dir, "out"), { skip: (name) => name === "transient.json" });
    expect(readdirSync(join(dir, "out")).sort()).toEqual(["link", "package.json", "src"]);
    expect(readdirSync(join(dir, "out", "src")).sort()).toEqual(["a.ts", "deep"]);
    expect(readFileSync(join(dir, "out", "src", "deep", "b.ts"), "utf8")).toBe("export {};\n");
    // Where it pointed, as `fs.cp` writes it: a relative link would point somewhere else from the copy.
    expect(readlinkSync(join(dir, "out", "link"))).toBe(join(dir, "elsewhere"));
  });

  // The failure itself: listed, then gone before the copy reads it.
  test("a file deleted after its directory was listed is passed over, and the rest is copied", () => {
    const source = tree();
    copyTreeOnce(source, join(dir, "out"), {
      listed: (at) => {
        if (at === join(source, "src")) unlinkSync(join(source, "src", "transient.json"));
      },
    });
    expect(readdirSync(join(dir, "out", "src")).sort()).toEqual(["a.ts", "deep"]);
  });

  test("a directory deleted after its parent was listed is passed over too", () => {
    const source = tree();
    copyTreeOnce(source, join(dir, "out"), {
      listed: (at) => {
        if (at === join(source, "src")) rmSync(join(source, "src", "deep"), { recursive: true });
      },
    });
    expect(readdirSync(join(dir, "out", "src")).sort()).toEqual(["a.ts", "transient.json"]);
  });

  test("a source that is gone copies nothing, and is not an error", () => {
    copyTreeOnce(join(dir, "gone"), join(dir, "out"));
    expect(readdirSync(dir)).toEqual([]);
  });
});
