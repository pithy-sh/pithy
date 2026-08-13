// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * **Nothing non-deterministic may be evaluated in a Workflow driver body.**
 *
 * A Cloudflare Workflow does not resume inside the step it died in. It re-executes the driver from the top
 * and serves every completed step from the journal. So a value the body *computes* answers differently on
 * every attempt, while a value the journal *holds* does not — and every field the pages behind the
 * interruption were already written under has to come from the second kind.
 *
 * The kit has now shipped this defect four times, in four capabilities, one field at a time: payments minted
 * its run id in the body (#328), then read its clock in the body in the very fix for it (#331), and testers,
 * email and secrets each held a body-read clock of their own. Patching the reported field and leaving its
 * sibling is the failure mode, so this is a statement about *where* a value may be produced rather than a
 * list of the ways to produce one.
 *
 * ## The rule, and why it is not a list of function names
 *
 * > **A driver body may not evaluate a nullary call or a nullary construction.**
 *
 * A call that takes no arguments cannot compute its result from its input, because it has none. Whatever it
 * returns therefore came from outside the program — a clock, an entropy source, a counter, a queue. That is
 * the whole population of things a replay must not re-read, and it is closed under the next author's
 * favourite spelling of it: `Date.now()`, `new Date()`, `crypto.randomUUID()`, `performance.now()`,
 * `deps.now()` and the sixth thing nobody has written yet are all nullary, necessarily, because a source
 * takes no input. A deny-list of names would have caught the first five and not the sixth — which is
 * pithy-sh/pithy#326 finding 4 in miniature, and precisely what this refuses to be.
 *
 * Two structural exceptions, both of which are the rule rather than holes in it:
 *
 *   - **A function-like node is not evaluated where it is written.** `now: () => new Date()` handed into a
 *     step is the *correct* pattern — the thunk is defined in the body and called inside the journal — so
 *     the walk stops at every function boundary. That is also what excludes a `step.do` callback, which
 *     needs no special case: it is an arrow like any other.
 *   - **A module-local function called from the body is part of the body.** `await buildSendDeps(this.env)`
 *     is one argument long and perfectly innocent-looking, and email's clock was inside it. So the walk
 *     follows a call to a function declared in the same module and judges its body by the same rule.
 *
 * ## What this does not see
 *
 * A thunk defined and then *called* in the same driver body would be missed: the call site is an identifier
 * this walker does not resolve to its arrow. Nothing in the tree does that, and the population assertions in
 * `workflowDeterminism.test.ts` are what would surface a new driver that did.
 *
 * The population is discovered, never declared: a driver is the `run` of a class extending
 * `WorkflowEntrypoint`, or any function taking a parameter typed as a step runner — and a step runner is
 * itself discovered, as any interface in the tree whose one member is `do(name, callback)`. A capability
 * that adds a Workflow tomorrow is analysed tomorrow, with nothing to remember.
 */

/** A source file the analysis reads. The same shape `sourceFiles` yields, so the tree walk feeds it directly. */
export interface DriverSource {
  /** Path to the file, used in findings. */
  readonly path: string;
  /** Its text. */
  readonly text: string;
}

/** One Workflow driver body the analysis found. */
export interface WorkflowDriver {
  /** The file it lives in. */
  readonly file: string;
  /** `ClassName.run` for a Workflow class, or the function's name for a delegate that takes a step runner. */
  readonly name: string;
  /** Whether it is the Workflow class itself or a function the class hands its step runner to. */
  readonly kind: "entrypoint" | "delegate";
}

/** One evaluation of a source in a driver body — the thing this gate exists to refuse. */
export interface DriverFinding extends WorkflowDriver {
  /** 1-indexed line of the offending expression. */
  readonly line: number;
  /** The expression as written, e.g. `deps.now()` or `new Date()`. */
  readonly expression: string;
  /** Where it was found: the driver body itself, or a module-local function the body calls. */
  readonly via: string;
}

/** What one analysis pass found. */
export interface DriverAnalysis {
  /** Every `WorkflowEntrypoint` subclass in the tree, as `path#ClassName`, sorted. */
  readonly entrypoints: string[];
  /** Every driver body analysed. */
  readonly drivers: WorkflowDriver[];
  /** Every `WorkflowSpec.className` declared anywhere in the tree, sorted. */
  readonly declaredClassNames: string[];
  /** Every violation of the rule. */
  readonly findings: DriverFinding[];
  /** Files that were parsed. A gate over an empty population is not a gate. */
  readonly parsed: number;
}

/** An AST node, structurally. The walk needs a discriminant and children; it needs nothing else. */
export interface Node {
  readonly type: string;
  readonly loc?: { readonly start: { readonly line: number } };
  readonly [key: string]: unknown;
}

/**
 * The parser, injected.
 *
 * A seam rather than an import, for one reason: the parser this gate uses is a dev-only dependency, and this
 * module ships. Taking it as a parameter keeps a published `@pithy-sh/cli` free of a module that imports
 * something an installer never gets — and lets the fixture cases in the gate's own suite run through exactly
 * the code path the tree scan does.
 */
export type ParseModule = (text: string) => Node;

/**
 * The node kinds that defer evaluation of what is inside them.
 *
 * This is a fact about the language rather than a policy: a function body runs where the function is called,
 * so nothing written inside one is evaluated at the point it appears. It is what makes `() => new Date()`
 * handed to a step legal and `new Date()` beside it not.
 */
const DEFERRED = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
  "ObjectMethod",
  "ClassMethod",
  "ClassPrivateMethod",
]);

/** The superclass every Cloudflare Workflow extends. The platform's name for the seam, not ours. */
const WORKFLOW_BASE = "WorkflowEntrypoint";

function isNode(value: unknown): value is Node {
  return typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string";
}

/** Every child node of `node`, in source order. Property-driven, so it needs no per-kind knowledge. */
function children(node: Node): Node[] {
  const found: Node[] = [];
  for (const key of Object.keys(node)) {
    if (key === "loc" || key === "leadingComments" || key === "trailingComments") continue;
    const value = node[key];
    if (isNode(value)) found.push(value);
    else if (Array.isArray(value)) for (const item of value) if (isNode(item)) found.push(item);
  }
  return found;
}

function nameOf(node: unknown): string | undefined {
  return isNode(node) && node.type === "Identifier" && typeof node.name === "string" ? node.name : undefined;
}

/** `deps.now` → `deps.now`; `crypto.randomUUID` → `crypto.randomUUID`; anything computed → undefined. */
function memberPath(node: Node): string | undefined {
  if (node.type === "Identifier") return nameOf(node);
  if (node.type !== "MemberExpression" || node.computed === true) return undefined;
  const object = isNode(node.object) ? memberPath(node.object) : undefined;
  const property = nameOf(node.property);
  if (node.type === "MemberExpression" && isNode(node.object) && node.object.type === "ThisExpression") {
    return property === undefined ? undefined : `this.${property}`;
  }
  return object !== undefined && property !== undefined ? `${object}.${property}` : undefined;
}

/**
 * Is this interface a step runner?
 *
 * Structurally: one member, called `do`, taking a name and a callback. That is the whole of the seam every
 * package declares for itself — `ReconcileStep`, `ReprocessStep`, `StepRunner` — and it is how a fourth one
 * added tomorrow is recognised without being written down here.
 */
function isStepRunnerInterface(node: Node): boolean {
  if (node.type !== "TSInterfaceDeclaration" || !isNode(node.body)) return false;
  const members = Array.isArray(node.body.body) ? node.body.body.filter(isNode) : [];
  if (members.length !== 1) return false;
  const member = members[0] as Node;
  if (member.type !== "TSMethodSignature") return false;
  return nameOf(member.key) === "do" && Array.isArray(member.parameters ?? member.params);
}

/** The type name a parameter is annotated with, if it is a plain reference. */
function parameterTypeName(param: Node): string | undefined {
  const annotation = param.typeAnnotation;
  if (!isNode(annotation) || !isNode(annotation.typeAnnotation)) return undefined;
  const reference = annotation.typeAnnotation;
  if (reference.type !== "TSTypeReference" || !isNode(reference.typeName)) return undefined;
  return nameOf(reference.typeName);
}

/** Collect every function declaration in a module, by name, so a call from a driver body can be followed. */
function moduleFunctions(program: Node): Map<string, Node> {
  const found = new Map<string, Node>();
  const visit = (node: Node): void => {
    if (node.type === "FunctionDeclaration") {
      const name = nameOf(node.id);
      if (name !== undefined) found.set(name, node);
    }
    for (const child of children(node)) visit(child);
  };
  visit(program);
  return found;
}

/** Every name a binding pattern introduces — a plain identifier, or one buried in destructuring. */
function boundNames(pattern: unknown, into: Set<string>): void {
  if (!isNode(pattern)) return;
  const name = nameOf(pattern);
  if (name !== undefined) {
    into.add(name);
    return;
  }
  for (const child of children(pattern)) boundNames(child, into);
}

/**
 * The bindings a scope holds that carry a value it already has, rather than a way of getting one.
 *
 * This is the line between `now.getTime()` and `deps.now()`, and it is the only thing in this file that has to
 * be careful. `now` is a `const` the body computed from a journalled step; calling a method on it reads a
 * value already in hand and answers the same on every replay. `deps` is a *parameter* — the injected effect
 * surface — and `Date` is a free identifier the module never declared. Both of those reach outside.
 *
 * So: a local declared in this scope is a value; a parameter, an import, and a global are not.
 *
 * **Aliasing is not a way round it.** A local whose initializer is just a name or a property of one — the
 * `const clock = deps.clock` shape — is a second name for the seam rather than a value, so it does not count
 * as local. A local initialized from an expression that *produces* something (a call, a construction, an
 * `await step.do`) does.
 */
function localValues(scope: Node): Set<string> {
  const locals = new Set<string>();
  const visit = (node: Node): void => {
    if (node !== scope && DEFERRED.has(node.type)) return;
    if (node.type === "VariableDeclarator") {
      const initializer = node.init;
      const aliasesASeam =
        isNode(initializer) &&
        (initializer.type === "Identifier" ||
          (initializer.type === "MemberExpression" && memberPath(initializer) !== undefined));
      if (!aliasesASeam) boundNames(node.id, locals);
    }
    for (const child of children(node)) visit(child);
  };
  visit(scope);
  return locals;
}

/**
 * Walk one scope, refusing every nullary evaluation of something the scope does not already hold, and
 * following calls into this module's own functions.
 *
 * `seen` guards recursion through a helper that calls itself; `via` names where a finding actually sits, so
 * a clock two frames down from the body is reported at the function that holds it rather than at the call.
 */
function walkScope(
  scope: Node,
  context: { driver: WorkflowDriver; functions: Map<string, Node>; via: string; seen: Set<string> },
  findings: DriverFinding[],
): void {
  const locals = localValues(scope);
  const visit = (node: Node): void => {
    if (node !== scope && DEFERRED.has(node.type)) return;

    if (node.type === "CallExpression" || node.type === "NewExpression" || node.type === "OptionalCallExpression") {
      const args = Array.isArray(node.arguments) ? node.arguments : [];
      const callee = isNode(node.callee) ? node.callee : undefined;
      const path = callee ? memberPath(callee) : undefined;
      const root = path?.split(".")[0];

      // A call into this module's own code is part of the body, whatever its arity: the value it produces is
      // produced here. Followed once, and judged by the same rule.
      if (path !== undefined && context.functions.has(path) && !context.seen.has(path)) {
        context.seen.add(path);
        const target = context.functions.get(path) as Node;
        walkScope(
          target,
          { driver: context.driver, functions: context.functions, via: path, seen: context.seen },
          findings,
        );
      } else if (args.length === 0 && (root === undefined || !locals.has(root))) {
        // Nullary, on something this scope does not already hold. It takes no input and its receiver is not a
        // value the body computed, so whatever it answers came from outside the program.
        const written = path === undefined ? node.type : path;
        findings.push({
          ...context.driver,
          line: node.loc?.start.line ?? 0,
          expression: node.type === "NewExpression" ? `new ${written}()` : `${written}()`,
          via: context.via,
        });
      }
    }

    for (const child of children(node)) visit(child);
  };
  visit(scope);
}

/**
 * Analyse a set of source files for Workflow driver bodies and the sources they evaluate.
 *
 * Everything is derived from the files: the Workflow classes, the step-runner interfaces, the delegates that
 * take one, and the class names the `WorkflowSpec` maps declare. Nothing about the shipped population is
 * written down here, which is the point — see the module doc.
 */
export function analyseDrivers(sources: readonly DriverSource[], parseModule: ParseModule): DriverAnalysis {
  const programs: { source: DriverSource; program: Node }[] = [];
  for (const source of sources) programs.push({ source, program: parseModule(source.text) });

  // Pass one: every step-runner interface in the tree, by name.
  const stepRunners = new Set<string>();
  for (const { program } of programs) {
    const visit = (node: Node): void => {
      if (isStepRunnerInterface(node)) {
        const name = nameOf(node.id);
        if (name !== undefined) stepRunners.add(name);
      }
      for (const child of children(node)) visit(child);
    };
    visit(program);
  }

  const entrypoints: string[] = [];
  const declaredClassNames = new Set<string>();
  const drivers: WorkflowDriver[] = [];
  const findings: DriverFinding[] = [];

  for (const { source, program } of programs) {
    const functions = moduleFunctions(program);
    const bodies: { driver: WorkflowDriver; scope: Node }[] = [];

    const visit = (node: Node): void => {
      // A Workflow class: its `run` is a driver body, and the second parameter is the platform's step runner.
      if (
        (node.type === "ClassDeclaration" || node.type === "ClassExpression") &&
        isNode(node.superClass) &&
        nameOf(node.superClass) === WORKFLOW_BASE
      ) {
        const className = nameOf(node.id) ?? "<anonymous>";
        entrypoints.push(`${source.path}#${className}`);
        const members = isNode(node.body) && Array.isArray(node.body.body) ? node.body.body.filter(isNode) : [];
        for (const member of members) {
          if (member.type !== "ClassMethod" || nameOf(member.key) !== "run") continue;
          bodies.push({
            driver: { file: source.path, name: `${className}.run`, kind: "entrypoint" },
            scope: member,
          });
        }
      }

      // A delegate: any function handed a step runner. It re-executes on resume exactly as the class does.
      if (node.type === "FunctionDeclaration" && Array.isArray(node.params)) {
        const params = node.params.filter(isNode);
        if (
          params.some((param) => {
            const type = parameterTypeName(param);
            return type !== undefined && stepRunners.has(type);
          })
        ) {
          const name = nameOf(node.id);
          if (name !== undefined) {
            bodies.push({ driver: { file: source.path, name, kind: "delegate" }, scope: node });
          }
        }
      }

      // A `WorkflowSpec`'s `className` — the second, independent enumeration of the shipped population.
      //
      // Recognised by the spec's own shape rather than by the key alone: `className` is also what a
      // `durable_object` binding names its class with, so a bare key search collects `MatchmakingPresence`
      // and asserts that a Durable Object is a Workflow. A `WorkflowSpec` is the object that carries a
      // `binding`, a `params` schema and a `className` together.
      if (node.type === "ObjectExpression" && Array.isArray(node.properties)) {
        const properties = node.properties.filter(isNode);
        const keys = new Set(properties.map((property) => nameOf(property.key)));
        if (keys.has("binding") && keys.has("params") && keys.has("className")) {
          const declared = properties.find((property) => nameOf(property.key) === "className");
          const value = declared !== undefined && isNode(declared.value) ? declared.value : undefined;
          if (value?.type === "StringLiteral" && typeof value.value === "string") declaredClassNames.add(value.value);
        }
      }

      for (const child of children(node)) visit(child);
    };
    visit(program);

    for (const { driver, scope } of bodies) {
      drivers.push(driver);
      walkScope(scope, { driver, functions, via: driver.name, seen: new Set([driver.name]) }, findings);
    }
  }

  return {
    entrypoints: entrypoints.sort(),
    drivers: drivers.sort((a, b) => `${a.file}#${a.name}`.localeCompare(`${b.file}#${b.name}`)),
    declaredClassNames: [...declaredClassNames].sort(),
    findings,
    parsed: programs.length,
  };
}
