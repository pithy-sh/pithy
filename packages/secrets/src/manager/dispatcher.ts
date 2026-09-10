// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { CloudflareWorkflowsClient } from "@pithy-sh/cloudflare/src/workflows/workflowsClient";
import { InternalError, UpstreamError } from "@pithy-sh/core/src/error/pithyError";
import { resourceNames } from "@pithy-sh/core/src/naming/resourceNames";
import type {
  PreflightSecretDispatcher,
  SecretProbe,
  SecretProbeRequest,
  SecretRotationCloseRequest,
  SecretRotationOpenRequest,
  SecretRotationRecorder,
  SecretWriteRequest,
} from "../cli/dispatch";
import { SecretAlreadyExistsError, SecretNotFoundError } from "../error/errors";
import type { ManagedEnvironment } from "../scope";
import { WriteWorkflowResult } from "./writeWorkflow";

/**
 * The `<capability>` segment of every name the secrets manager deploys under — its Worker script, its
 * D1, and both of its Workflows. One literal, so the manager, the dispatcher, and teardown cannot drift.
 */
export const SECRETS_CAPABILITY = "secrets";

/**
 * The canonical name of one project's manager write-Workflow in one environment —
 * `<project>-<env>-secrets-write`. This is the contract between the deployed manager and every CLI
 * dispatch site, so it is defined once here: a rename can't leave a caller dispatching to a Workflow
 * that does not exist.
 *
 * The project segment is not decoration. Workflow names are **account-scoped**, so without it a second
 * Pithy project in the same account dispatches into the first project's manager — writing its secrets
 * into another project's database, under another project's master key.
 *
 * Named as a **Workflow** through core's facade: 64 characters, and refused rather than truncated. A
 * Workflow name is a running instance's address, so a silently reshaped one loses whatever was in
 * flight — and this particular name is also the contract every CLI dispatch resolves against.
 */
export function secretsWriteWorkflowName(project: string, env: ManagedEnvironment): string {
  return resourceNames(project).env(env).workflow(SECRETS_CAPABILITY, "write");
}

/**
 * The canonical name of one project's at-rest key-rotation Workflow in one environment —
 * `<project>-<env>-secrets-rotate`. Triggered by the manager's own cron rather than by the CLI, but
 * named here beside the write Workflow because both are the same account-scoped namespace and the
 * manager's resolved `wrangler.jsonc` declares them together.
 */
export function secretsRotateWorkflowName(project: string, env: ManagedEnvironment): string {
  return resourceNames(project).env(env).workflow(SECRETS_CAPABILITY, "rotate");
}

/**
 * The real {@link PreflightSecretDispatcher}: dispatches a write to the target environment's manager
 * write-Workflow over the CF Workflows REST API and polls to completion. This is the CLI's write
 * path — the master key is worker-only, so the CLI never encrypts or stores locally. The dispatched
 * params carry the (already validated) value, so failures never echo them (see the client).
 *
 * **Bound to one project.** The dispatcher resolves the target Workflow itself rather than taking an
 * env-to-name function: the name needs both the project and the environment, and a seam that took only
 * the environment quietly invited a caller to supply an unscoped name that resolves to whichever
 * project provisioned the account last.
 */
export class WorkflowSecretDispatcher implements PreflightSecretDispatcher, SecretProbe, SecretRotationRecorder {
  readonly #client: CloudflareWorkflowsClient;
  readonly #project: string;

  constructor(client: CloudflareWorkflowsClient, project: string) {
    this.#client = client;
    this.#project = project;
  }

  /**
   * **`d1` only, and a request for any other backend is refused rather than performed** (#517).
   *
   * This dispatcher's whole reach is one environment's manager Workflow, and that Workflow runs
   * `runWriteSecret` against `SystemSecretsStore` — the encrypted D1. It has no route to a Secrets Store
   * entry and never had one. Before the request carried a backend it could not tell, so a
   * `cf-secrets-store` write arrived here and became a D1 row: `pithy secrets create` exited 0 having
   * written a value nothing reads, and `pithy secrets rm` deleted that row and reported the revocation of
   * a live entry it never touched.
   *
   * {@link backendRoutedDispatcher} is what sends a store write elsewhere, so this refusal should be
   * unreachable — which is exactly why it is here. A write path added later that forgets to route fails
   * loudly at the first dispatch instead of quietly filling a database with values no reader looks in.
   */
  async dispatch(request: SecretWriteRequest): Promise<void> {
    this.#requireD1(request, "dispatch");
    await this.#client.dispatchAndPoll(secretsWriteWorkflowName(this.#project, request.env), {
      mode: request.mode,
      name: request.name,
      value: request.value,
      valueType: request.valueType,
      rotatable: request.rotatable,
    });
  }

  /**
   * **The same two refusals {@link dispatch} would raise, asked with nothing written** (#517).
   *
   * This is the half of the pre-flight the first fix did not land. `storeSecretWriter` got one and this
   * did not, the router called it with `?.`, and the omission read as *nothing to ask* — so on the more
   * common backend `pithy secrets rotate` still called the issuer, took delivery of a new credential, and
   * only then dispatched an `update` the manager answered `Secret 'X' does not exist` to. The old
   * credential was dead at the issuer and the new one existed only in the process raising that error.
   *
   * Both refusals are facts about the destination and both are knowable now. The manager itself may be
   * unreachable — never provisioned, deployed under another project's name, or simply down — and that is
   * the first thing `probe` finds out, because it is the same dispatch-and-poll against the same Workflow.
   * And an `update` needs the secret to be there while a `create` needs it not to be, which is precisely
   * what a probe answers: it is the one mode of the write Workflow that writes nothing, so the pre-flight
   * and the write read the same store through the same code and cannot come to two answers.
   *
   * `delete` is asked nothing beyond reachability — it refuses nothing and is idempotent, exactly as the
   * store writer's is — and no branch here looks at the value: a pre-flight that could fail on a value
   * would be a validation, and `validateSecretValue` owns that, before a prompt is even answered.
   */
  async preflight(request: SecretWriteRequest): Promise<void> {
    this.#requireD1(request, "preflight");
    const present = await this.probe({ env: request.env, name: request.name });
    if (request.mode === "delete") return;
    // The words `runWriteSecret` uses, because it is the same rule and the operator meets it twice: a typo
    // must not create a second secret, and must not be answered differently depending on how early it was
    // caught. Only `detail` differs, and it says where the answer came from.
    if (request.mode === "create" && present) {
      throw new SecretAlreadyExistsError({
        message: `Secret '${request.name}' already exists.`,
        action: `Use pithy secrets update ${request.name} to replace it.`,
        detail: `create '${request.name}': already present in the ${request.env} manager's store (pre-flight)`,
      });
    }
    if (request.mode === "update" && !present) {
      throw new SecretNotFoundError({
        message: `Secret '${request.name}' does not exist.`,
        action: "Use create to add a new secret.",
        detail: `update '${request.name}': not present in the ${request.env} manager's store (pre-flight)`,
      });
    }
  }

  /**
   * The backend guard, on both entry points rather than on the write alone — a pre-flight that answered
   * about a destination this writer cannot reach would be worse than not asking, because it would resolve.
   */
  #requireD1(request: SecretWriteRequest, step: "dispatch" | "preflight"): void {
    if (request.backend === "d1") return;
    throw new InternalError({
      message: `Secret '${request.name}' is held in the Secrets Store, and this writer only reaches D1.`,
      detail: `secrets manager ${step}: ${request.mode} '${request.name}' arrived with backend '${request.backend}'; route it through backendRoutedDispatcher`,
    });
  }

  /**
   * Ask one environment's manager whether a name is in its store. The same Workflow, in the one mode
   * that writes nothing (`management/writeSecret.ts`), so a presence check cannot drift from the write
   * it gates: they read the same store, in the same worker, through the same code.
   *
   * The instance output is **decoded, never trusted**. It arrives over the Workflows REST API as
   * `unknown`, and an unread field would default to absent — which is the answer that makes
   * provisioning mint a second value over a live one. A shape nobody expected stops the run instead.
   */
  async probe(request: SecretProbeRequest): Promise<boolean> {
    const output = await this.#client.dispatchAndPoll(secretsWriteWorkflowName(this.#project, request.env), {
      mode: "probe",
      name: request.name,
    });
    const parsed = WriteWorkflowResult.safeParse(output);
    if (!parsed.success) {
      throw new UpstreamError({
        message: `The ${request.env} secrets manager gave no usable answer about '${request.name}'.`,
        action: "Redeploy the manager with pithy secrets provision, then run this again.",
        detail: `probe ${request.name} in ${request.env}: unexpected write-workflow output`,
      });
    }
    return parsed.data.outcome === "present";
  }

  /**
   * Open a rotation row in one environment's ledger and return its id.
   *
   * The same Workflow again, for the same reason the probe uses it: the rotation table sits in the manager's
   * own D1, so the process that can write it is the one that can write the value. The output is decoded and
   * the id demanded — a `rotation-open` that answered with no id would leave the close addressing nothing,
   * and a row that never closes reads as a rotation still running long after it finished.
   */
  async openRotation(request: SecretRotationOpenRequest): Promise<number> {
    const output = await this.#client.dispatchAndPoll(secretsWriteWorkflowName(this.#project, request.env), {
      mode: "rotation-open",
      name: request.name,
      trigger: request.trigger,
      rotatedBy: request.rotatedBy,
    });
    const parsed = WriteWorkflowResult.safeParse(output);
    if (!parsed.success || parsed.data.outcome !== "opened" || parsed.data.rotationId === undefined) {
      throw new UpstreamError({
        message: `The ${request.env} secrets manager did not record a rotation of '${request.name}'.`,
        action: "Redeploy the manager with pithy secrets provision so its rotation history is written again.",
        detail: `rotation-open ${request.name} in ${request.env}: unexpected write-workflow output`,
      });
    }
    return parsed.data.rotationId;
  }

  /** Close a row this dispatcher opened in the same environment. */
  async closeRotation(request: SecretRotationCloseRequest): Promise<void> {
    await this.#client.dispatchAndPoll(secretsWriteWorkflowName(this.#project, request.env), {
      mode: "rotation-close",
      rotationId: request.rotationId,
      closure: request.closure,
    });
  }
}
