// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Capability } from "@pithy-sh/core/src/capability/capability";
import type { BuiltInPrivacyClass } from "@pithy-sh/core/src/privacy/classes";
import { privacyOf } from "@pithy-sh/core/src/privacy/classify";
import { z } from "zod";

/**
 * **`pithy privacy scan`: find what is not marked, and never decide for you** (#132).
 *
 * It walks the storage schemas each Worker composes — the D1 tables and KV stores the runtime inventory walks,
 * through the same composed capabilities — and reads each field's name. A name that reads as private (`email`,
 * `phone`, `ipAddress`, `dateOfBirth`, `ssn`, `diagnosis`) is a **candidate**, with the class it suggests and the
 * marker to apply; a field already marked is **covered**. It prints a report and exits 0. It edits nothing and
 * fails nothing.
 *
 * ## How it reaches the schemas
 *
 * **Through each Worker's own `pithy.config.ts`, loaded the way every command loads it, and the capabilities it
 * composes** — not by importing an arbitrary project's modules and hunting for exported Zod objects. That is the
 * open question the issue named, settled: a config is already a thing the CLI resolves, a capability's storage
 * schemas are already the table definitions, and walking them is walking exactly what the control plane's
 * inventory walks, so the scanner and the report cannot disagree about what was covered. A schema that is not a
 * table or a KV store — a request body, an email template — is not reached, which is the inventory's own scope.
 * A Worker whose config does not load is reported as unreadable rather than skipped in silence.
 *
 * ## Why it advises and nothing more
 *
 * Which of an adopter's fields are regulated is a question about their jurisdiction, their sector and their
 * counsel — not one Pithy may answer by refusing to build (principle 1). A tool that surfaces candidates is useful
 * the day someone inherits a codebase; one that locked their data down on a heuristic would be Pithy deciding
 * their compliance posture for them.
 */

/** A name's trailing words that read as one class. Matched on whole words at the end, so `ownership` is not `ip`. */
const NAME_RULES: readonly [BuiltInPrivacyClass, readonly string[]][] = [
  ["secret", ["password"]],
  ["secret", ["password", "hash"]],
  ["secret", ["passphrase"]],
  ["secret", ["token"]],
  ["secret", ["secret"]],
  ["secret", ["api", "key"]],
  ["secret", ["otp"]],
  ["pci", ["card", "number"]],
  ["pci", ["pan"]],
  ["pci", ["cvv"]],
  ["pci", ["cvc"]],
  ["phi", ["diagnosis"]],
  ["phi", ["diagnoses"]],
  ["phi", ["medication"]],
  ["phi", ["medications"]],
  ["phi", ["prescription"]],
  ["phi", ["prescriptions"]],
  ["phi", ["treatment"]],
  ["phi", ["allergy"]],
  ["phi", ["allergies"]],
  ["phi", ["symptoms"]],
  ["phi", ["medical", "record"]],
  ["phi", ["mrn"]],
  ["phi", ["blood", "type"]],
  ["pii", ["email"]],
  ["pii", ["phone"]],
  ["pii", ["phone", "number"]],
  ["pii", ["mobile"]],
  ["pii", ["address"]],
  ["pii", ["ip"]],
  ["pii", ["postal", "code"]],
  ["pii", ["zip"]],
  ["pii", ["zip", "code"]],
  ["pii", ["first", "name"]],
  ["pii", ["last", "name"]],
  ["pii", ["full", "name"]],
  ["pii", ["date", "of", "birth"]],
  ["pii", ["birth", "date"]],
  ["pii", ["birthday"]],
  ["pii", ["dob"]],
  ["pii", ["ssn"]],
  ["pii", ["national", "id"]],
  ["pii", ["passport"]],
];

/** A field name as lowercase words: `contactEmail` → `contact email`, `phone_number` → `phone number`. */
function words(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
}

/** The class a field's name suggests, or `null`. The longest rule that matches the name's last words wins. */
export function candidateClass(name: string): BuiltInPrivacyClass | null {
  const said = words(name);
  let best: { cls: BuiltInPrivacyClass; length: number } | null = null;
  for (const [cls, tail] of NAME_RULES) {
    if (tail.length > said.length) continue;
    const end = said.slice(said.length - tail.length);
    if (end.every((word, index) => word === tail[index]) && (best === null || tail.length > best.length)) {
      best = { cls, length: tail.length };
    }
  }
  return best?.cls ?? null;
}

/** One field the scan has something to say about. */
export const ScanFinding = z
  .object({
    worker: z.string().describe("The Worker under `apps/` that composes it."),
    capability: z.string().describe("The capability that declares the schema."),
    owner: z
      .enum(["app", "kit"])
      .describe("`app` for the adopter's own schema; `kit` for a `@pithy-sh/*` capability's, which the kit marks."),
    storage: z.enum(["d1", "kv"]).describe("Where the schema is stored: a `d1` table or a `kv` store."),
    container: z.string().describe("The D1 database or KV namespace it lives in."),
    schema: z.string().describe("The table name, or the KV store name."),
    path: z.string().describe("The field's path, in the inventory's notation: `email`, `profile.phone`, `key.email`."),
    status: z
      .enum(["candidate", "covered"])
      .describe("`candidate`: the name reads as private and the field is unmarked. `covered`: it is marked."),
    class: z
      .string()
      .describe("For a candidate, the class its name suggests; for a covered field, the class it carries."),
    marker: z
      .string()
      .nullable()
      .describe("For a candidate, the marker to wrap the field's schema in — `pii(…)`. Null for a covered field."),
  })
  .describe("One field `pithy privacy scan` reports: a candidate to mark, or a field already marked.");
export type ScanFinding = z.output<typeof ScanFinding>;

/** A Zod schema's internal definition, as much of it as this walk reads. */
interface Def {
  type: string;
  innerType?: z.ZodType;
  element?: z.ZodType;
  options?: z.ZodType[];
  valueType?: z.ZodType;
  out?: z.ZodType;
  in?: z.ZodType;
}

/** The definition behind a schema. */
function defOf(schema: z.ZodType): Def {
  return (schema as unknown as { def: Def }).def;
}

const WRAPPERS: ReadonlySet<string> = new Set(["optional", "nullable", "default", "prefault", "readonly", "catch"]);

/** Where a finding sits, before its field is known. */
type Place = Omit<ScanFinding, "path" | "status" | "class" | "marker">;

/** Walk one schema's fields, appending a finding for each covered or candidate field. */
function walkFields(schema: z.ZodType, path: string, place: Place, out: ScanFinding[]): void {
  let node = schema;
  for (let def = defOf(node); WRAPPERS.has(def.type) && def.innerType; def = defOf(node)) node = def.innerType;
  const def = defOf(node);
  if (def.type === "object") {
    for (const [key, field] of Object.entries((node as z.ZodObject).shape) as [string, z.ZodType][]) {
      const fieldPath = path === "" ? key : `${path}.${key}`;
      const marked = privacyOf(field);
      if (marked !== null) {
        out.push({ ...place, path: fieldPath, status: "covered", class: marked, marker: null });
        continue;
      }
      const suggested = candidateClass(key);
      if (suggested !== null) {
        out.push({ ...place, path: fieldPath, status: "candidate", class: suggested, marker: `${suggested}(…)` });
      }
      walkFields(field, fieldPath, place, out);
    }
    return;
  }
  if (def.type === "array" && def.element) {
    walkFields(def.element, `${path}[]`, place, out);
    return;
  }
  if ((def.type === "record" || def.type === "map") && def.valueType) {
    walkFields(def.valueType, path === "" ? "*" : `${path}.*`, place, out);
    return;
  }
  if (def.type === "union") {
    for (const option of def.options ?? []) walkFields(option, path, place, out);
    return;
  }
  if (def.type === "pipe") {
    const side = node instanceof z.ZodCodec ? def.out : (def.in ?? def.out);
    if (side) walkFields(side, path, place, out);
  }
}

/** The findings of one Worker's composed capabilities, in composition order. A path reached twice is listed once. */
export function scanCapabilities(worker: string, capabilities: readonly Capability[]): ScanFinding[] {
  const out: ScanFinding[] = [];
  for (const capability of capabilities) {
    const owner = capability.version === undefined || capability.version === null ? "app" : "kit";
    const base = { worker, capability: capability.name, owner } as const;
    for (const [container, database] of Object.entries(capability.databases ?? {})) {
      for (const [name, table] of Object.entries(database.tables)) {
        const place: Place = { ...base, storage: "d1", container, schema: name };
        walkFields(table as z.ZodType, "", place, out);
      }
    }
    for (const [container, namespace] of Object.entries(capability.kvNamespaces ?? {})) {
      for (const [name, store] of Object.entries(namespace.stores)) {
        const place: Place = { ...base, storage: "kv", container, schema: name };
        walkFields(store.key, "key", place, out);
        walkFields(store.value, "value", place, out);
        if (store.metadata) walkFields(store.metadata, "metadata", place, out);
      }
    }
  }
  const seen = new Set<string>();
  return out.filter((finding) => {
    const key = [finding.capability, finding.storage, finding.container, finding.schema, finding.path].join("\u0000");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
