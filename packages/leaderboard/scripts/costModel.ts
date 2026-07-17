/**
 * The leaderboard cost model.
 *
 * The issue's requirement: the arithmetic ships as a script, not as hand-maths in prose, so each release
 * can re-run it. If the numbers here and the numbers in docs/costs.md disagree, the docs are wrong until
 * updated — `costModel.test.ts` asserts exactly that.
 *
 * Run it: `bun run --filter @pithy-sh/leaderboard costs`
 *
 * READ THE INFERENCE FLAGS BELOW BEFORE QUOTING ANY OUTPUT. Some inputs are Cloudflare's published
 * figures; the rest are our arithmetic over them. They are not the same thing and must not be presented
 * as though they were.
 */

/**
 * Cloudflare's published D1 unit prices, as of the date below.
 *
 * CITED — these come from Cloudflare's D1 pricing page. They are also the thing most likely to move:
 * the included allowances do most of the work in this model, and a change to the 25B rows-read allowance
 * alone would shift every boundary in the table.
 */
export const D1_PRICING_AS_OF = "2026-07-16";

export const D1_PRICING = {
  /** Rows read included per month before metering starts. */
  rowsReadIncluded: 25_000_000_000,
  /** USD per million rows read past the allowance. */
  rowsReadPerMillion: 0.001,
  /** Rows written included per month. */
  rowsWrittenIncluded: 50_000_000,
  /** USD per million rows written past the allowance. */
  rowsWrittenPerMillion: 1.0,
  /** GB of storage included per month. */
  storageGbIncluded: 5,
  /** USD per GB-month past the allowance. */
  storagePerGbMonth: 0.75,
} as const;

/**
 * The workload. OURS, not Cloudflare's — every field is an assumption, and the output moves with them.
 */
export interface Workload {
  players: number;
  /** Score submissions per player per day. */
  submissionsPerPlayerPerDay: number;
  /** Rank checks per player per day. */
  rankChecksPerPlayerPerDay: number;
  /** How many windows each submission writes to (e.g. daily + weekly + all-time). */
  windows: number;
  /** Days in the billing month. */
  days: number;
  /**
   * Rows written per *writing* submission, per window.
   *
   * MEASURED, not inferred. `src/entry/writeAmplification.workers.test.ts` reads D1's own
   * `meta.rows_written` for the real compiled upsert: a steady-state update writes 2 (the row + the rank
   * index; the unique-player index does not change on an update). The first-ever insert writes 3 (both
   * indexes), amortized to ~nothing across a player's submissions. The model prices the recurring case,
   * so 2 — which matches the issue's original estimate, but only because the schema uses a plain INTEGER
   * PRIMARY KEY: an autoincrement id would add a `sqlite_sequence` write to every upsert and push this to
   * 3. The test fails if that regresses, or if the index count moves.
   */
  rowsWrittenPerSubmissionPerWindow: number;
  /**
   * Fraction of submissions that actually write — i.e. that change the ranked score.
   *
   * The `best` default (`trackActivity: false`) skips a non-improving submission entirely: 0 rows. So on
   * a typical board only the minority of submissions that beat a player's own best cost anything. 1.0 is
   * the ceiling — every submission writes — which is what `trackActivity: true`, or a `sum`/`latest`
   * board, actually does. The published table uses 1.0 so it can never be accused of understating; the
   * text shows what a realistic improve rate does to it.
   */
  writingSubmissionFraction: number;
  /**
   * Rows scanned by one live rank check, as a fraction of the board.
   *
   * INFERENCE — D1 bills rows *scanned*, not returned, and a live rank counts every entry that beats
   * you. The average player sits mid-board, so half. A leaderboard's most engaged players sit near the
   * top and scan less; its whales check rank most. Treat 0.5 as the average, not a bound.
   */
  liveScanFractionOfBoard: number;
  /** Approximate bytes per entry row. */
  bytesPerRow: number;
}

export const DEFAULT_WORKLOAD: Workload = {
  players: 1_000,
  submissionsPerPlayerPerDay: 5,
  rankChecksPerPlayerPerDay: 5,
  windows: 3,
  days: 30,
  rowsWrittenPerSubmissionPerWindow: 2,
  writingSubmissionFraction: 1,
  liveScanFractionOfBoard: 0.5,
  bytesPerRow: 100,
};

export type RankMode = { kind: "live" } | { kind: "materialize"; refreshesPerDay: number };

export interface CostBreakdown {
  players: number;
  mode: string;
  rowsRead: number;
  rowsWritten: number;
  storageGb: number;
  readCost: number;
  writeCost: number;
  storageCost: number;
  total: number;
  /** Average sustained upserts per second. The throughput wall, which cost alone does not show. */
  upsertsPerSecond: number;
}

/** Bill a metered quantity: everything past the included allowance, at the unit price. */
function meter(quantity: number, included: number, perMillion: number): number {
  return (Math.max(0, quantity - included) / 1_000_000) * perMillion;
}

/** Rank checks per month. */
function monthlyRankChecks(w: Workload): number {
  return w.players * w.rankChecksPerPlayerPerDay * w.days;
}

/** Entries in the store: one per player per window. */
function entries(w: Workload): number {
  return w.players * w.windows;
}

/**
 * Rows written by one refresh pass, per entry it re-ranks.
 *
 * MEASURED (`src/rank/materialize.workers.test.ts`): a refresh updates only the `rank` column, which no
 * index covers, so it writes **1** row per entry — not the 2 a submission costs (row + rank index). An
 * earlier draft priced the refresh at the submission rate and overstated every materialize figure ~2x on
 * the refresh term. Kept as a named constant so the test pins it.
 */
export const REFRESH_ROWS_WRITTEN_PER_ENTRY = 1;

/**
 * Rows written per month.
 *
 * Two terms with different unit costs. Submissions write the entry row and its rank index (2). A
 * materialized refresh writes only the unindexed `rank` column (1) — cheaper per touch, which is why the
 * refresh term is smaller than a naive "same as a submission" model would suggest.
 */
export function monthlyRowsWritten(w: Workload, mode: RankMode): number {
  const submissionWrites =
    w.players *
    w.submissionsPerPlayerPerDay *
    w.writingSubmissionFraction *
    w.windows *
    w.rowsWrittenPerSubmissionPerWindow *
    w.days;
  if (mode.kind === "live") return submissionWrites;
  const refreshWrites = entries(w) * mode.refreshesPerDay * w.days * REFRESH_ROWS_WRITTEN_PER_ENTRY;
  return submissionWrites + refreshWrites;
}

/**
 * Rows read per month.
 *
 * The quadratic term lives here and is the whole point of the table. D1 bills rows *scanned*, not
 * returned, so a live rank check that counts everyone above you scans a fraction of the board. The number
 * of checks grows with the player count *and* so does the scan depth of each one — so live rank reads
 * grow with players squared. That is the entire shape of the live column.
 *
 * Materialized rank replaces the scan with a single indexed point read, and the refresh pass reads each
 * entry once per refresh. Both terms are linear, which is why the curve flattens.
 */
export function monthlyRowsRead(w: Workload, mode: RankMode): number {
  const checks = monthlyRankChecks(w);
  if (mode.kind === "live") {
    // A rank check reads one board: the player asks where they stand on a board, not on all of them.
    return checks * w.players * w.liveScanFractionOfBoard;
  }
  const pointReads = checks;
  const refreshReads = entries(w) * mode.refreshesPerDay * w.days;
  return pointReads + refreshReads;
}

export function storageGb(w: Workload): number {
  return (entries(w) * w.bytesPerRow) / 1_000_000_000;
}

/**
 * Average sustained upserts per second.
 *
 * INFERENCE, and the number that matters most. Cloudflare publishes NO writes/sec ceiling. D1 is
 * single-threaded and its docs describe a write as taking "several milliseconds", which implies a
 * practical ceiling somewhere near 200/sec. This is our arithmetic on that implication, not a
 * Cloudflare figure — but it is why one database tops out around a million players regardless of what
 * the cost column says, and why the answer past that is to shard rather than to tune the cadence.
 */
export function averageUpsertsPerSecond(w: Workload): number {
  return (w.players * w.submissionsPerPlayerPerDay * w.windows) / 86_400;
}

/** INFERENCE — implied by "several milliseconds" per write on a single thread. Not published. */
export const IMPLIED_UPSERT_CEILING_PER_SECOND = 200;

export function computeCost(w: Workload, mode: RankMode): CostBreakdown {
  const rowsRead = monthlyRowsRead(w, mode);
  const rowsWritten = monthlyRowsWritten(w, mode);
  const gb = storageGb(w);
  const readCost = meter(rowsRead, D1_PRICING.rowsReadIncluded, D1_PRICING.rowsReadPerMillion);
  const writeCost = meter(rowsWritten, D1_PRICING.rowsWrittenIncluded, D1_PRICING.rowsWrittenPerMillion);
  const storageCost = Math.max(0, gb - D1_PRICING.storageGbIncluded) * D1_PRICING.storagePerGbMonth;
  return {
    players: w.players,
    mode: mode.kind === "live" ? "live" : `materialize x${mode.refreshesPerDay}/day`,
    rowsRead,
    rowsWritten,
    storageGb: gb,
    readCost,
    writeCost,
    storageCost,
    total: readCost + writeCost + storageCost,
    upsertsPerSecond: averageUpsertsPerSecond(w),
  };
}

/** The player counts the docs table walks, an order of magnitude apart. */
export const PLAYER_SCALES = [1_000, 10_000, 100_000, 1_000_000, 10_000_000];

export const MODES: RankMode[] = [
  { kind: "live" },
  { kind: "materialize", refreshesPerDay: 1 },
  { kind: "materialize", refreshesPerDay: 24 },
];

export function buildTable(base: Workload = DEFAULT_WORKLOAD): CostBreakdown[] {
  return PLAYER_SCALES.flatMap((players) => MODES.map((mode) => computeCost({ ...base, players }, mode)));
}

const usd = (n: number) => (n === 0 ? "$0" : `$${Math.round(n).toLocaleString("en-US")}`);

function render(): string {
  const rows = buildTable();
  const lines: string[] = [];
  lines.push(`D1 leaderboard cost model. Prices as of ${D1_PRICING_AS_OF}.`);
  lines.push("");
  lines.push("| Players | live | materialize daily | materialize hourly | Storage | Upserts/sec |");
  lines.push("|---:|---:|---:|---:|---:|---:|");
  for (const players of PLAYER_SCALES) {
    const forScale = rows.filter((r) => r.players === players);
    const [live, daily, hourly] = forScale;
    if (!live || !daily || !hourly) continue;
    lines.push(
      `| ${players.toLocaleString("en-US")} | ${usd(live.total)} | ${usd(daily.total)} | ${usd(hourly.total)} | ${live.storageGb.toFixed(2)} GB | ${Math.round(live.upsertsPerSecond)} |`,
    );
  }
  lines.push("");
  lines.push("Worst case: every submission writes (writingSubmissionFraction = 1). The default `best` board");
  lines.push("guards non-improving submissions to 0 rows, so a real board pays for the minority that improve —");
  const guarded = computeCost(
    { ...DEFAULT_WORKLOAD, players: 1_000_000, writingSubmissionFraction: 0.2 },
    {
      kind: "materialize",
      refreshesPerDay: 1,
    },
  );
  lines.push(`e.g. at 1M players and a 20% improve rate, materialize-daily is ~${usd(guarded.total)}, not $940.`);
  lines.push("");
  lines.push("Best effort, and it will drift. Cloudflare sets these prices and can change them at any time.");
  lines.push("Pithy takes no cut: this is your Cloudflare account, metered by Cloudflare.");
  lines.push(`Implied write ceiling (ours, not published): ~${IMPLIED_UPSERT_CEILING_PER_SECOND} upserts/sec.`);
  return lines.join("\n");
}

if (import.meta.main) {
  console.log(render());
}

export { render };
