import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import type { UiStub, UiStubContext } from "./stubs";

/**
 * Turn a stub's declaration into the file contents it writes.
 *
 * A stub declares *what* it writes ({@link UiStub.manifest}) and keeps that pure; this is the one
 * place that reads the template tree off disk. Splitting it that way is what lets the screens be real
 * `.tsx` files — typechecked by CI, linted by Biome, readable in a diff — while the file set a given
 * invocation produces stays assertable as a plain value.
 */

/** Replace every literal token in `text`. Tokens are fixed strings, never patterns. */
function substitute(text: string, tokens: Record<string, string>): string {
  let out = text;
  for (const [token, value] of Object.entries(tokens)) out = out.split(token).join(value);
  return out;
}

/**
 * Read every file a stub writes for this context, keyed by its path relative to `apps/<worker>/`.
 *
 * A missing template is an internal error, not an adopter error: it means this package shipped
 * without part of its own template tree, and no adopter action can fix it.
 */
export async function loadStubFiles(stub: UiStub, context: UiStubContext): Promise<Record<string, string>> {
  const tokens = stub.substitutions(context);
  const files: Record<string, string> = {};
  for (const file of stub.manifest(context)) {
    const path = join(stub.templateDir, file.source);
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (cause) {
      throw new InternalError(
        {
          message: `The ${stub.id} front-end template is incomplete.`,
          action: "Reinstall @pithy-sh/cli. This is a packaging fault, not something in your project.",
          detail: `missing template file ${path}`,
        },
        { cause },
      );
    }
    files[file.target] = substitute(text, tokens);
  }
  return files;
}
