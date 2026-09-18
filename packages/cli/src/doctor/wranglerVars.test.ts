// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { blankComments } from "@pithy-sh/core/src/text/comments";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { NOT_INHERITED_BY_ENVIRONMENTS } from "../project/wranglerInheritance";
import { BINDING_NAMED_BY_NAME, bindingsIn, declaredBindings, VALUE_MAPS } from "./wranglerVars";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pithy-bindings-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/**
 * One entry per binding-bearing wrangler key, in the shape wrangler's own types give it, and the binding
 * name the reader must find in it. The claim is here; wrangler's declarations are the subject; the gate
 * below is what holds one to the other.
 */
const SAMPLES: Record<string, { value: unknown; binding: string }> = {
  durable_objects: { value: { bindings: [{ name: "ROOMS", class_name: "Room" }] }, binding: "ROOMS" },
  workflows: {
    value: [{ binding: "EMAIL_SENDER", name: "replay-dev-email-sender", class_name: "Sender" }],
    binding: "EMAIL_SENDER",
  },
  kv_namespaces: { value: [{ binding: "SESSIONS" }], binding: "SESSIONS" },
  send_email: { value: [{ name: "MAILER" }], binding: "MAILER" },
  queues: {
    value: { producers: [{ binding: "JOBS", queue: "jobs" }], consumers: [{ queue: "jobs" }] },
    binding: "JOBS",
  },
  r2_buckets: { value: [{ binding: "BUCKET" }], binding: "BUCKET" },
  d1_databases: { value: [{ binding: "DB" }], binding: "DB" },
  vectorize: { value: [{ binding: "INDEX", index_name: "i" }], binding: "INDEX" },
  ai_search_namespaces: { value: [{ binding: "SEARCH_NS", namespace: "n" }], binding: "SEARCH_NS" },
  ai_search: { value: [{ binding: "SEARCH", instance_name: "s" }], binding: "SEARCH" },
  agent_memory: { value: [{ binding: "MEMORY", namespace: "n" }], binding: "MEMORY" },
  websearch: { value: { binding: "WEB" }, binding: "WEB" },
  hyperdrive: { value: [{ binding: "HYPER", id: "h" }], binding: "HYPER" },
  services: { value: [{ binding: "COLLAB", service: "collab" }], binding: "COLLAB" },
  analytics_engine_datasets: { value: [{ binding: "EVENTS" }], binding: "EVENTS" },
  browser: { value: { binding: "BROWSER" }, binding: "BROWSER" },
  ai: { value: { binding: "AI" }, binding: "AI" },
  images: { value: { binding: "IMAGES" }, binding: "IMAGES" },
  media: { value: { binding: "MEDIA" }, binding: "MEDIA" },
  stream: { value: { binding: "STREAM" }, binding: "STREAM" },
  version_metadata: { value: { binding: "CF_VERSION_METADATA" }, binding: "CF_VERSION_METADATA" },
  unsafe: { value: { bindings: [{ name: "UNSAFE", type: "x" }] }, binding: "UNSAFE" },
  mtls_certificates: { value: [{ binding: "CERT", certificate_id: "c" }], binding: "CERT" },
  dispatch_namespaces: { value: [{ binding: "DISPATCH" }], binding: "DISPATCH" },
  pipelines: { value: [{ binding: "PIPE" }], binding: "PIPE" },
  secrets_store_secrets: {
    value: [{ binding: "SIGNING_KEY", store_id: "s", secret_name: "k" }],
    binding: "SIGNING_KEY",
  },
  artifacts: { value: [{ binding: "ARTIFACTS", namespace: "n" }], binding: "ARTIFACTS" },
  unsafe_hello_world: { value: [{ binding: "HELLO" }], binding: "HELLO" },
  flagship: { value: [{ binding: "FLAGS" }], binding: "FLAGS" },
  ratelimits: { value: [{ name: "LIMITER", namespace_id: "1", simple: { limit: 1, period: 60 } }], binding: "LIMITER" },
  worker_loaders: { value: [{ binding: "LOADER" }], binding: "LOADER" },
  vpc_services: { value: [{ binding: "VPC", service_id: "v" }], binding: "VPC" },
  vpc_networks: { value: [{ binding: "NET", tunnel_id: "t" }], binding: "NET" },
  logfwdr: { value: { bindings: [{ name: "LOGS", destination: "d" }] }, binding: "LOGS" },
  assets: { value: { directory: "./public", binding: "ASSETS" }, binding: "ASSETS" },
};

/**
 * Wrangler keys that bind nothing, each for its reason. Some declare a `name` that is not a binding's —
 * `containers[].name`, the Worker's own `name` — and the rest are the non-inherited keys that are not
 * bindings at all.
 */
const NOT_BINDINGS: Record<string, string> = {
  vars: "a map of variable names to values — declaredVars' question",
  define: "a map of build-time substitutions",
  containers: "`name` names a container application, not a binding",
  name: "the Worker's own name",
  secrets: "`required` lists secret names, whose binding is the secret itself",
  cloudchamber: "container runtime settings",
  connect: "outbound sockets, addressed by host and port",
  tail_consumers: "Workers that receive this one's logs, named by service",
  streaming_tail_consumers: "Workers that receive this one's logs, named by service",
};

describe("bindingsIn", () => {
  test("every sample, as wrangler shapes it, yields its binding and its kind", () => {
    const config = Object.fromEntries(Object.entries(SAMPLES).map(([key, sample]) => [key, sample.value]));
    const found = bindingsIn(config);
    for (const [kind, sample] of Object.entries(SAMPLES)) {
      expect(found.get(sample.binding), kind).toBe(kind);
    }
    expect(found.size).toBe(Object.keys(SAMPLES).length);
  });

  test("an env.<name> stanza is read too — a binding declared only for staging is still a binding", () => {
    const found = bindingsIn({
      workflows: [],
      env: { staging: { workflows: [{ binding: "EMAIL_SENDER", name: "w", class_name: "C" }] } },
    });
    expect(found.get("EMAIL_SENDER")).toBe("workflows");
  });

  test("vars, define, a container's name and a queue consumer name no binding", () => {
    const found = bindingsIn({
      name: "board",
      vars: { binding: "NOT_A_BINDING", ENVIRONMENT: "dev" },
      define: { binding: "ALSO_NOT" },
      containers: [{ name: "sandbox", class_name: "Sandbox", image: "./Dockerfile" }],
      queues: { consumers: [{ queue: "jobs" }] },
      tail_consumers: [{ service: "tail" }],
    });
    expect([...found.keys()]).toEqual([]);
  });

  test("anything that is not a config declares nothing", () => {
    expect(bindingsIn(null).size).toBe(0);
    expect(bindingsIn("wrangler.jsonc").size).toBe(0);
    expect(bindingsIn({ env: { staging: null } }).size).toBe(0);
  });
});

describe("declaredBindings", () => {
  test("reads a Worker's wrangler.jsonc, top level and every environment", async () => {
    await writeFile(
      join(dir, "wrangler.jsonc"),
      `{
  // a comment, because this is JSONC
  "durable_objects": { "bindings": [{ "name": "ROOMS", "class_name": "Room" }] },
  "env": { "prod": { "secrets_store_secrets": [{ "binding": "SIGNING_KEY", "store_id": "s", "secret_name": "k" }] } }
}
`,
    );
    const found = await declaredBindings(dir);
    expect(Object.fromEntries(found)).toEqual({ ROOMS: "durable_objects", SIGNING_KEY: "secrets_store_secrets" });
  });

  test("an absent or unreadable config declares nothing", async () => {
    expect((await declaredBindings(dir)).size).toBe(0);
    await writeFile(join(dir, "wrangler.jsonc"), "{ not json");
    expect((await declaredBindings(dir)).size).toBe(0);
  });
});

/**
 * **The gate.** The reader is a shape rule plus two short lists, and both lists are claims about
 * wrangler. This holds them to wrangler's own declarations, so the day wrangler adds a binding kind — or
 * one spelled by `name` — the build says so.
 */
const require_ = createRequire(import.meta.url);
const declarationsPath = join(dirname(require_.resolve("wrangler/package.json")), "wrangler-dist", "cli.d.ts");

/** A brace-balanced slice from `from` — the text of one `{ … }` or one type alias up to its `;`. */
function balanced(text: string, from: number, until: "}" | ";"): string {
  let depth = 0;
  for (let at = from; at < text.length; at++) {
    const char = text[at] as string;
    if ("{([".includes(char)) depth++;
    else if ("})]".includes(char)) {
      depth--;
      if (until === "}" && depth === 0) return text.slice(from + 1, at);
    } else if (until === ";" && char === ";" && depth === 0) return text.slice(from, at);
  }
  return "";
}

/** Each top-level field of one wrangler config interface, with the text of every type it names inlined. */
function interfaceFields(declarations: string, name: string): { name: string; text: string }[] {
  const open = declarations.indexOf("{", declarations.indexOf(`interface ${name} {`));
  const body = balanced(declarations, open, "}");
  const fields: { name: string; text: string }[] = [];
  let depth = 0;
  for (const line of body.split("\n")) {
    const field = /^ {4}(\w+)\??:/.exec(line);
    if (field && depth === 0) fields.push({ name: field[1] as string, text: "" });
    const current = fields.at(-1);
    if (current) current.text += `${line}\n`;
    for (const char of line) {
      if ("{([".includes(char)) depth++;
      else if ("})]".includes(char)) depth--;
    }
  }
  for (const field of fields) {
    for (const ref of new Set(field.text.match(/\b[A-Z]\w+\b/g) ?? [])) {
      const alias = new RegExp(String.raw`\ntype ${ref}(<[^>]*>)? = `).exec(declarations);
      if (alias) field.text += balanced(declarations, alias.index + alias[0].length, ";");
    }
  }
  return fields;
}

/**
 * The fields the samples and lists do not account for: every field whose type names a `binding` needs a
 * sample, and every field whose objects are named by a required `name` is either spelled that way in
 * {@link BINDING_NAMED_BY_NAME} or excused in {@link NOT_BINDINGS}.
 */
function ungated(fields: readonly { name: string; text: string }[]): string[] {
  const missing: string[] = [];
  for (const field of fields) {
    const bindingField = /\bbinding\??: string/.test(field.text);
    const nameField = /(^|[^\w?])name: string/.test(field.text.replace(/^ {4}name:.*$/m, ""));
    if (bindingField && !SAMPLES[field.name]) missing.push(field.name);
    else if (!bindingField && nameField && !NOT_BINDINGS[field.name]) {
      if (!BINDING_NAMED_BY_NAME.has(field.name) || !SAMPLES[field.name]) missing.push(field.name);
    }
  }
  return missing;
}

describe("the reader against wrangler's declarations", () => {
  test("every binding kind wrangler declares has a sample, and every name-spelled kind is listed", async () => {
    // Comments blanked first, through the one stripper (#437): a `{@link}` in a docblock is a brace.
    const declarations = blankComments(await readFile(declarationsPath, "utf8"));
    const fields = [
      ...interfaceFields(declarations, "EnvironmentNonInheritable"),
      ...interfaceFields(declarations, "EnvironmentInheritable"),
    ];
    // A reader that found nothing would pass on an empty set — the reach failure this repo has shipped.
    expect(fields.length).toBeGreaterThan(60);
    expect(fields.map((field) => field.name)).toEqual(
      expect.arrayContaining(["workflows", "durable_objects", "assets"]),
    );
    expect(ungated(fields)).toEqual([]);
  });

  test("every non-inherited key is either a binding kind with a sample or a named exception", () => {
    const unexplained = NOT_INHERITED_BY_ENVIRONMENTS.filter((key) => !SAMPLES[key] && !NOT_BINDINGS[key]);
    expect(unexplained).toEqual([]);
  });

  test("VALUE_MAPS is exactly the maps of names to values", () => {
    expect([...VALUE_MAPS].sort()).toEqual(["define", "vars"]);
  });

  test("the gate fails on a planted binding kind it has no sample for", () => {
    expect(
      ungated([{ name: "future_things", text: "    future_things: {\n        binding: string;\n    }[];\n" }]),
    ).toEqual(["future_things"]);
  });

  test("the gate fails on a planted kind spelled by name — the reader cannot see one it was not told of", () => {
    const planted = { name: "future_named", text: "    future_named: {\n        name: string;\n    }[];\n" };
    expect(ungated([planted])).toEqual(["future_named"]);
    expect(bindingsIn({ future_named: [{ name: "FUTURE" }] }).has("FUTURE")).toBe(false);
  });
});
