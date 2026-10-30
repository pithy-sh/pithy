// Your project's lint safeguards, as one Oxlint JS plugin. `.oxlintrc.json` loads it and turns each rule on for
// the files it covers.
//
// Six rules, each matching what the GritQL rule of the same name matches for a Biome project, with the same
// message: `no-console` and `no-process-io` keep Worker logs queryable, `no-raw-request-input` and
// `no-bare-zvalidator` keep every route's request contract declared, `no-raw-use-effect` keeps effects in hooks
// named for what they sync with, and `no-z-config` keeps a locale inside its request.
//
// Oxlint's JS plugin API is alpha and outside semver. None of these rules needs type information, which it does not
// support.
//
// This file is yours. Narrow a rule's `files` in .oxlintrc.json, widen them, or delete the rule here and its
// override there.

const MESSAGES = {
  "no-console":
    "console is not the logger. Reach for c.var.log in a request, or createWorkerLogger() elsewhere — a console line carries no level, name, or request id, and Workers Logs cannot filter it.",
  "no-process-io":
    "A Worker log must be queryable. process.stdout writes an unstructured line with no level, name, or request id, and Workers Logs cannot filter it. Reach for c.var.log in a request, or createWorkerLogger() elsewhere.",
  "no-raw-request-input":
    "Request input is read raw here. Declare it on the route line with validate(target, Schema) and read it with c.req.valid(target).",
  "no-bare-zvalidator":
    "A bare zValidator hides its schema from the OpenAPI contract. Use validate(target, Schema) from @pithy-sh/core/src/http/validation.",
  "no-raw-use-effect":
    "A raw effect. Load data with useRead, run a call with useAction, navigate on an answer by rendering <Redirect>. An effect that syncs with something outside React goes in a hook named for it, in its own file, excluded in biome.jsonc.",
  "no-z-config":
    "z.config sets Zod's error map globally, and a Worker isolate outlives the request. A locale written there renders the NEXT request's validation failure in the LAST request's language. Pass the map per parse instead: Schema.parse(value, { error }).",
};

/** Whether `inner` starts where `outer` does, so it is not wrapped in parentheses inside it. */
const flush = (outer, inner) => inner.range[0] === outer.range[0];

/** An identifier with one of `names`. */
const named = (node, names) => node?.type === "Identifier" && names.includes(node.name);

/** `object.property` with a plain property: not computed, not optional, its object not parenthesized. */
const member = (node, names) =>
  node?.type === "MemberExpression" &&
  !node.computed &&
  !node.optional &&
  node.property.type === "Identifier" &&
  flush(node, node.object) &&
  (names === undefined || names.includes(node.property.name));

/** A call that is not optional and whose callee is not parenthesized. */
const call = (node) => !node.optional && flush(node, node.callee);

/** Whether a member expression is written to rather than read: the target of an assignment or an update. */
function written(node) {
  const parent = node.parent;
  switch (parent?.type) {
    case "AssignmentExpression":
      return parent.left === node;
    case "UpdateExpression":
      return true;
    case "ArrayPattern":
    case "RestElement":
      return true;
    case "AssignmentPattern":
      return parent.left === node;
    case "Property":
      return parent.value === node && parent.parent?.type === "ObjectPattern";
    case "ForInStatement":
    case "ForOfStatement":
      return parent.left === node;
    default:
      return false;
  }
}

/** One rule: its message, and the visitor that reports each node it matches. */
function rule(name, visitor) {
  return {
    meta: { type: "problem", docs: { description: MESSAGES[name] } },
    create(context) {
      return visitor((node) => context.report({ node, message: MESSAGES[name] }));
    },
  };
}

/** A rule over member expressions that are read, never written. */
function memberRule(name, matches) {
  return rule(name, (report) => ({
    MemberExpression(node) {
      if (member(node) && !written(node) && matches(node)) report(node);
    },
  }));
}

const EFFECTS = ["useEffect", "useLayoutEffect"];

export default {
  meta: { name: "pithy" },
  rules: {
    "no-console": memberRule(
      "no-console",
      ({ object }) =>
        named(object, ["console"]) || (member(object, ["console"]) && named(object.object, ["globalThis"])),
    ),
    "no-process-io": memberRule(
      "no-process-io",
      ({ object }) => member(object, ["stdout", "stderr"]) && named(object.object, ["process"]),
    ),
    "no-raw-request-input": rule("no-raw-request-input", (report) => ({
      CallExpression(node) {
        const callee = node.callee;
        if (call(node) && member(callee, ["param", "query", "json"]) && member(callee.object, ["req"])) report(node);
      },
    })),
    "no-bare-zvalidator": rule("no-bare-zvalidator", (report) => ({
      CallExpression(node) {
        if (call(node) && named(node.callee, ["zValidator"])) report(node);
      },
    })),
    "no-raw-use-effect": rule("no-raw-use-effect", (report) => ({
      CallExpression(node) {
        if (call(node) && (named(node.callee, EFFECTS) || member(node.callee, EFFECTS))) report(node);
      },
    })),
    "no-z-config": memberRule(
      "no-z-config",
      (node) => node.property.name === "config" && named(node.object, ["z", "zod"]),
    ),
  },
};
