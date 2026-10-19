// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { BindingSpec, BindingType } from "@pithy-sh/core/src/capability/bindings";
import { envStem } from "@pithy-sh/core/src/env/stem";

/**
 * **The project's service bindings as a graph: who binds whom (#617).**
 *
 * An app binds another Worker of its project by declaring `{ type: "service", name, service }` in its own app
 * capability. Each such declaration is one edge, from the `apps/<name>` Worker holding it to the Worker it
 * calls — another `apps/` Worker by its directory name, or a kit Worker by its capability name. This module
 * knows nothing about files; `pithy worker bind`, `pithy doctor` and `pithy deploy` read the edges and ask it
 * the same three questions, so all three answer them one way.
 *
 * **A self edge is never a loop here.** A Worker reaching itself is the self binding, #616's, declared in the
 * root `pithy.config.ts` rather than as an edge, and the loop check ignores one an adopter wrote by hand.
 */

/** One declared service binding: the Worker holding it, its name in that Worker's env, and the Worker it calls. */
export interface ServiceEdge {
  /** The `apps/<name>` Worker that holds the binding. */
  from: string;
  /** The binding name in `from`'s env. */
  binding: string;
  /** The Worker called: an `apps/<name>` directory name, or a kit Worker's capability name. */
  to: string;
}

/** The binding name `pithy worker bind` gives a target when `--binding` is not passed: `app-b` → `APP_B`. */
export function defaultServiceBinding(target: string): string {
  return envStem(target);
}

/** `from -> … -> to`, the one rendering every loop is printed in. */
export function renderPath(path: readonly string[]): string {
  return path.join(" -> ");
}

/** The sentence a loop is reported in, by `pithy worker bind` and `pithy doctor` alike. */
export function loopSentence(from: string, to: string, path: readonly string[]): string {
  return `${from} -> ${to} closes a loop: ${renderPath(path)}.`;
}

/** Each Worker's outgoing edges, self edges dropped, targets in declaration order. */
function adjacency(edges: readonly ServiceEdge[]): Map<string, string[]> {
  const next = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.from === edge.to) continue;
    const targets = next.get(edge.from) ?? [];
    if (!targets.includes(edge.to)) targets.push(edge.to);
    next.set(edge.from, targets);
  }
  return next;
}

/** A path from `start` to `goal` through the edges, both ends included, or `null` when there is none. */
function pathBetween(next: ReadonlyMap<string, readonly string[]>, start: string, goal: string): string[] | null {
  const seen = new Set<string>();
  const walk = (node: string): string[] | null => {
    if (node === goal) return [node];
    if (seen.has(node)) return null;
    seen.add(node);
    for (const target of next.get(node) ?? []) {
      const rest = walk(target);
      if (rest) return [node, ...rest];
    }
    return null;
  };
  return walk(start);
}

/**
 * **The loop a new edge `from -> to` would close, or `null`.** Printed from the target: the existing path from
 * `to` back to `from`, then `to` again — `app-a -> app-b -> app-a` for a new `app-b -> app-a` over an existing
 * `app-a -> app-b`. A new self edge is the self binding's question, not this one's, and answers `null`.
 */
export function closesLoop(edges: readonly ServiceEdge[], from: string, to: string): string[] | null {
  if (from === to) return null;
  const back = pathBetween(adjacency(edges), to, from);
  return back ? [...back, to] : null;
}

/**
 * **Every loop the declared edges already hold**, each once, for `pithy doctor` and a config edited by hand.
 *
 * A loop is printed from its smallest name and closed on itself, so the same loop found from any of its members
 * is one line rather than three. Self edges are dropped first.
 */
export function serviceLoops(edges: readonly ServiceEdge[]): string[][] {
  const next = adjacency(edges);
  const found = new Map<string, string[]>();
  for (const [from, targets] of next) {
    for (const to of targets) {
      const back = pathBetween(next, to, from);
      if (!back) continue;
      const cycle = [from, ...back.slice(0, -1)];
      const start = cycle.indexOf([...cycle].sort()[0] as string);
      const rotated = [...cycle.slice(start), ...cycle.slice(0, start)];
      const key = rotated.join("\u0000");
      if (!found.has(key)) found.set(key, [...rotated, rotated[0] as string]);
    }
  }
  return [...found.values()].sort((a, b) => renderPath(a).localeCompare(renderPath(b)));
}

/**
 * **`names`, reordered so every binding's target comes before the Worker that binds it** — the order
 * `pithy deploy` ships in, because a service binding to a script that does not exist yet is refused at upload.
 *
 * Stable: a Worker that binds nothing and is bound by nothing keeps its place. An edge naming something outside
 * `names` (a kit Worker, deployed by the kit half) is ignored, and a loop — refused by `pithy worker bind`,
 * reported by `pithy doctor` — loses no Worker: its members keep their relative order.
 */
export function dependencyOrder(names: readonly string[], edges: readonly ServiceEdge[]): string[] {
  const members = new Set(names);
  const next = adjacency(edges.filter((edge) => members.has(edge.from) && members.has(edge.to)));
  const placed = new Set<string>();
  const visiting = new Set<string>();
  const order: string[] = [];
  const place = (name: string): void => {
    if (placed.has(name) || visiting.has(name)) return;
    visiting.add(name);
    for (const target of next.get(name) ?? []) place(target);
    visiting.delete(name);
    placed.add(name);
    order.push(name);
  };
  for (const name of names) place(name);
  return order;
}

/** What each kind of binding holds, as the object of "already binds DB, to …". */
const KIND_PHRASE: Record<BindingType, string> = {
  d1: "a D1 database",
  kv: "a KV namespace",
  r2: "an R2 bucket",
  ai: "Workers AI",
  vectorize: "a Vectorize index",
  queue: "a queue",
  ratelimit: "a rate limiter",
  email: "an email sender",
  secret: "a secret",
  workflow: "a Workflow",
  service: "another Worker",
  durable_object: "a Durable Object namespace",
  hyperdrive: "a Hyperdrive config",
  browser: "Browser Rendering",
  images: "Cloudflare Images",
  analytics_engine_datasets: "an Analytics Engine dataset",
  pipelines: "a pipeline",
  mtls_certificates: "an mTLS certificate",
  dispatch_namespaces: "a dispatch namespace",
  artifacts: "an Artifacts namespace",
};

/** The resource a binding already holds, for a refusal: `a D1 database`, or the Worker a service binding calls. */
export function bindingKindPhrase(binding: Pick<BindingSpec, "type" | "name" | "service">): string {
  if (binding.type === "service" && binding.service !== undefined) return binding.service;
  return KIND_PHRASE[binding.type];
}
