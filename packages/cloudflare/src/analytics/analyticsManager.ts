// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { CloudflareInvalidResponseError, cloudflareRefusal, cloudflareRequest, decodeResponse } from "../client/errors";
import { CloudflareManager } from "../client/manager";

/**
 * **Cloudflare's GraphQL Analytics API, for the account-level datasets the kit reads (#728).**
 *
 * One endpoint, `POST /graphql`, reached through the SDK's raw `post` like every other call the typed SDK
 * does not cover — never a hand-rolled `fetch` (CLAUDE.md §Cloudflare access). It answers HTTP 200 with
 * `{ data, errors }` even when it refuses, so `errors` is read on every answer and a non-empty one is a
 * refusal in Cloudflare's own words.
 *
 * The token it runs on carries "Account Analytics Read" (the shared `analytics` profile), whose grain is
 * the whole account. This manager narrows nothing on its own: every query takes the keys it is about, and
 * the caller decides which keys those are.
 */

/** Minutes of Stream video delivered, groupable by video `uid`. Account-level, US-only under a metadata boundary. */
export const STREAM_MINUTES = "streamMinutesViewedAdaptiveGroups";

/**
 * Hosted Images delivery requests, groupable by `imageId` — the id Cloudflare Images assigns at upload.
 *
 * Not `imagesRequestsAdaptiveGroups`: that dataset groups by time and nothing else, so it can only ever
 * answer an account total, which cannot be scoped to an environment. This one carries the image id,
 * found by schema introspection on 2026-10-17.
 */
export const IMAGE_REQUESTS = "imagesHostedRequestsAdaptiveGroups";

/** The datasets this manager queries. */
export type AnalyticsDataset = typeof STREAM_MINUTES | typeof IMAGE_REQUESTS;

/**
 * How many keys one query filters on. The answer is one group per key, so this is also the `limit`, and
 * it sits far under the 10,000 `maxPageSize` the datasets advertise — a large library is several bounded
 * queries, never one unbounded filter.
 */
export const ANALYTICS_KEY_CHUNK = 500;

/** One dataset's limits, as `viewer.accounts.settings` reports them. Every duration is in seconds. */
export const DatasetLimits = z
  .object({
    enabled: z.boolean().describe("Whether Cloudflare serves this dataset to this account at all."),
    maxDuration: z.number().describe("The widest window one query may ask for, in seconds."),
    notOlderThan: z.number().describe("How far back the dataset reaches, in seconds — its retention."),
    maxPageSize: z.number().describe("The largest `limit` one query may pass."),
  })
  .describe("One analytics dataset's limits for this account, as Cloudflare's settings node reports them.");
export type DatasetLimits = z.infer<typeof DatasetLimits>;

/** The GraphQL error code for a spent rate budget — the one refusal a caller may retry. */
const RATE_BUDGET_CODE = "budget";

/** One entry of a GraphQL `errors` array. */
const GraphQLError = z
  .object({
    message: z.string().optional().describe("Cloudflare's own sentence for the failure."),
    extensions: z
      .object({ code: z.string().optional().describe("Cloudflare's machine code for the failure.") })
      .partial()
      .optional()
      .describe("Cloudflare's structured extras."),
  })
  .describe("One error the GraphQL endpoint answered.");

/** The envelope every GraphQL answer arrives in. `data` is decoded per query. */
const GraphQLAnswer = z
  .object({
    data: z.unknown().optional().describe("The query's result, when it ran."),
    errors: z.array(GraphQLError).nullish().describe("Why the query did not run, when it did not."),
  })
  .describe("The GraphQL endpoint's answer envelope.");

/** The one account a query is about, from `viewer.accounts(filter: { accountTag })`. */
function accountOf<T extends z.ZodType>(account: T) {
  return z
    .object({
      viewer: z
        .object({ accounts: z.array(account).describe("The accounts the filter matched.") })
        .describe("The authenticated viewer."),
    })
    .describe("A GraphQL answer about one account.");
}

const StreamMinutesGroup = z
  .object({
    sum: z
      .object({ minutesViewed: z.number().describe("Minutes of video delivered.") })
      .describe("The summed metrics."),
    dimensions: z.object({ uid: z.string().describe("The Stream video uid.") }).describe("The group's key."),
  })
  .describe("Minutes delivered for one video.");

const ImageRequestsGroup = z
  .object({
    count: z.number().describe("Delivery requests for the image."),
    dimensions: z.object({ imageId: z.string().describe("The Cloudflare Images id.") }).describe("The group's key."),
  })
  .describe("Delivery requests for one hosted image.");

/** A window and the keys to read it for. */
export interface WindowQuery {
  /** The window's start, inclusive. */
  since: Date;
  /** The window's end, exclusive. */
  until: Date;
}

/** Split keys into bounded chunks. */
function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Out-of-band reads of the account's delivery analytics. */
export class CloudflareAnalyticsManager extends CloudflareManager {
  getServiceType(): string {
    return "Analytics";
  }

  /** Whether the token can read the account's analytics settings. Never throws. */
  async validateServiceAccess(): Promise<boolean> {
    try {
      await this.datasetLimits([STREAM_MINUTES]);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Run one query and hand back its `data`, refusing in Cloudflare's own words when `errors` is non-empty.
   * The status is a 200 either way, so the envelope is the only place a refusal can be read.
   */
  private async query(operation: string, query: string, variables: Record<string, unknown>): Promise<unknown> {
    const raw = await cloudflareRequest(
      operation,
      () => this.getClient().post<unknown>("/graphql", { body: { query, variables } }),
      { permission: "Account Analytics Read" },
    );
    const answer = decodeResponse(GraphQLAnswer, raw, operation);
    const errors = answer.errors ?? [];
    if (errors.length > 0) {
      throw cloudflareRefusal({
        problem: `Cloudflare request failed: ${operation}.`,
        apiErrors: errors.map((error) => ({ ...(error.message === undefined ? {} : { message: error.message }) })),
        permission: "Account Analytics Read",
        // A spent rate budget answers 200 too, with `extensions.code: "budget"` (measured 2026-10-17). It
        // is the one GraphQL refusal that is worth asking again, so it is handed on as the 429 it means.
        ...(errors.some((error) => error.extensions?.code === RATE_BUDGET_CODE) ? { status: 429 } : {}),
        detail: JSON.stringify(errors),
      });
    }
    return answer.data;
  }

  /** The one account in an answer, refused when the token's viewer cannot see it. */
  private onlyAccount<T extends z.ZodType>(schema: T, data: unknown, operation: string): z.output<T> {
    const [account] = decodeResponse(accountOf(schema), data, operation).viewer.accounts;
    if (account === undefined) {
      throw new CloudflareInvalidResponseError({
        message: `Cloudflare answered no account for ${operation}. The token cannot see this account.`,
        detail: `viewer.accounts was empty for account ${this.accountId}`,
      });
    }
    return account;
  }

  /**
   * Each dataset's limits for this account — whether it is served at all, its retention, and the widest
   * window one query may ask for. Read, never assumed: the numbers differ per dataset and per plan.
   */
  async datasetLimits(
    datasets: readonly AnalyticsDataset[],
  ): Promise<Partial<Record<AnalyticsDataset, DatasetLimits>>> {
    const fields = datasets.map((dataset) => `${dataset} { enabled maxDuration notOlderThan maxPageSize }`).join(" ");
    const operation = "read analytics dataset limits";
    const data = await this.query(
      operation,
      `query ($account: string!) { viewer { accounts(filter: { accountTag: $account }) { settings { ${fields} } } } }`,
      { account: this.accountId },
    );
    // A dataset Cloudflare does not serve to this account answers null or is left out — under a Customer
    // Metadata Boundary outside the US, both are. That is a fact the caller names, not a broken answer.
    const shape = z
      .object({
        settings: z
          .object(Object.fromEntries(datasets.map((dataset) => [dataset, DatasetLimits.nullish()])))
          .describe("The datasets asked about. A dataset this account is not served is null or absent."),
      })
      .describe("The account's analytics settings.");
    const settings = this.onlyAccount(shape, data, operation).settings as Record<
      string,
      DatasetLimits | null | undefined
    >;
    const limits: Partial<Record<AnalyticsDataset, DatasetLimits>> = {};
    for (const dataset of datasets) {
      const entry = settings[dataset];
      if (entry !== null && entry !== undefined) limits[dataset] = entry;
    }
    return limits;
  }

  /** Minutes of video delivered per Stream uid inside the window, for the uids given. Absent means none. */
  async streamMinutesViewed(window: WindowQuery & { uids: readonly string[] }): Promise<Map<string, number>> {
    const totals = new Map<string, number>();
    const operation = "read Stream minutes viewed";
    for (const uids of chunks(window.uids, ANALYTICS_KEY_CHUNK)) {
      const data = await this.query(
        operation,
        `query ($account: string!, $filter: AccountStreamMinutesViewedAdaptiveGroupsFilter_InputObject, $limit: uint64!) { viewer { accounts(filter: { accountTag: $account }) { ${STREAM_MINUTES}(filter: $filter, limit: $limit) { sum { minutesViewed } dimensions { uid } } } } }`,
        {
          account: this.accountId,
          filter: { datetime_geq: window.since.toISOString(), datetime_lt: window.until.toISOString(), uid_in: uids },
          limit: uids.length,
        },
      );
      const groups = this.onlyAccount(
        z.object({ [STREAM_MINUTES]: z.array(StreamMinutesGroup).describe("Minutes per video.") }),
        data,
        operation,
      )[STREAM_MINUTES] as z.output<typeof StreamMinutesGroup>[];
      for (const group of groups) {
        totals.set(group.dimensions.uid, (totals.get(group.dimensions.uid) ?? 0) + group.sum.minutesViewed);
      }
    }
    return totals;
  }

  /** Delivery requests per hosted image id inside the window, for the ids given. Absent means none. */
  async imageRequests(window: WindowQuery & { imageIds: readonly string[] }): Promise<Map<string, number>> {
    const totals = new Map<string, number>();
    const operation = "read Images delivery requests";
    for (const imageIds of chunks(window.imageIds, ANALYTICS_KEY_CHUNK)) {
      const data = await this.query(
        operation,
        `query ($account: string!, $filter: AccountImagesHostedRequestsAdaptiveGroupsFilter_InputObject, $limit: uint64!) { viewer { accounts(filter: { accountTag: $account }) { ${IMAGE_REQUESTS}(filter: $filter, limit: $limit) { count dimensions { imageId } } } } }`,
        {
          account: this.accountId,
          filter: {
            datetime_geq: window.since.toISOString(),
            datetime_lt: window.until.toISOString(),
            imageId_in: imageIds,
          },
          limit: imageIds.length,
        },
      );
      const groups = this.onlyAccount(
        z.object({ [IMAGE_REQUESTS]: z.array(ImageRequestsGroup).describe("Requests per image.") }),
        data,
        operation,
      )[IMAGE_REQUESTS] as z.output<typeof ImageRequestsGroup>[];
      for (const group of groups) {
        totals.set(group.dimensions.imageId, (totals.get(group.dimensions.imageId) ?? 0) + group.count);
      }
    }
    return totals;
  }
}
