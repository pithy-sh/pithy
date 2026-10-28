// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { ConfigOptionValue } from "@pithy-sh/core/src/capability/manifest";
import { ValidationError } from "@pithy-sh/core/src/error/pithyError";

/**
 * A config option whose value is structured, and which the command line therefore writes as one string.
 *
 * `--set` and the prompt carry strings. An option like mcp's `floor` takes `"signed-in"`, `{ power }` or
 * `{ entitlement }`, so its form states the spellings a string may take, reads one into the value the
 * factory takes, and spells a value back for the `pithy add` a refusal names.
 */
export interface OptionForm {
  /** The `pithy add` flag that carries this option, beside `--set <key>=<spelling>`. */
  readonly flag: `--${string}`;
  /** Every spelling, each with one sentence saying what it admits. */
  readonly spellings: readonly { readonly spelling: string; readonly admits: string }[];
  /** The value a spelling stands for. Refuses a spelling outside the set, naming all of them. */
  parse(raw: string, capability: string): ConfigOptionValue;
  /** The spelling a value was read from. */
  spell(value: ConfigOptionValue): string;
}

const FLOOR_PREFIXES = ["power", "entitlement"] as const;

/** Who mcp's endpoint admits at all: `signed-in`, `power:<name>` or `entitlement:<name>`. */
export const ACCESS_FLOOR: OptionForm = {
  flag: "--floor",
  spellings: [
    { spelling: "signed-in", admits: "Every signed-in user may connect an agent." },
    { spelling: "power:<name>", admits: "Only a caller whose role holds that power." },
    { spelling: "entitlement:<name>", admits: "Only a caller holding that entitlement." },
  ],
  parse(raw, capability) {
    if (raw === "signed-in") return raw;
    const colon = raw.indexOf(":");
    const prefix = raw.slice(0, colon);
    const name = raw.slice(colon + 1);
    const kind = FLOOR_PREFIXES.find((one) => one === prefix);
    if (colon !== -1 && kind !== undefined && name !== "") return { [kind]: name };
    throw new ValidationError({
      message: `${capability} does not take "${raw}" as its floor.`,
      action: `Pass ${ACCESS_FLOOR.spellings.map((one) => `${ACCESS_FLOOR.flag} ${one.spelling}`).join(", ")}.`,
      detail: ACCESS_FLOOR.spellings.map((one) => `${one.spelling}: ${one.admits}`).join(" "),
    });
  },
  spell(value) {
    if (typeof value === "string") return value;
    const [entry] = Object.entries(value as Record<string, ConfigOptionValue>);
    return entry === undefined ? "" : `${entry[0]}:${String(entry[1])}`;
  },
};

const FORMS: Readonly<Record<string, Readonly<Record<string, OptionForm>>>> = {
  mcp: { floor: ACCESS_FLOOR },
};

/** The form one capability's option is written in on the command line, or `undefined` for a plain value. */
export function optionForm(capability: string, key: string): OptionForm | undefined {
  return Object.hasOwn(FORMS, capability) ? FORMS[capability]?.[key] : undefined;
}
