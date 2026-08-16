/**
 * Write `@pithy-sh/ui-react`'s `templates/client-env.d.ts` from the four declared client projections.
 *
 * The shape lives in one place — each capability's `src/client/projection.ts`, which is also the type
 * its `client:` closure is checked against — and this writes it out as the ambient declaration
 * `pithy ui add react` copies into an adopter's Worker. `src/clientEnvDeclaration.ts` beside it is the
 * whole of the logic and is tested there; this is the wiring.
 *
 * Run via `bun run generate`, which `build` runs first. The artifact is committed so `typecheck`, the
 * templates program and the CLI's scaffolder all have it without a build step — and so an **adopter**
 * has one static file and nothing to run. That was the objection #392 checked before anything else.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TEMPLATE_DIR } from "@pithy-sh/ui-react/src/templates";
import { generateClientEnv } from "../src/clientEnvDeclaration";

// The template tree is located by the library that owns it, not by a guessed `../../ui-react` path, so
// this keeps working whatever the install layout puts where.
const target = join(TEMPLATE_DIR, "client-env.d.ts");

await writeFile(target, await generateClientEnv());
console.log(`Wrote ${target}`);
