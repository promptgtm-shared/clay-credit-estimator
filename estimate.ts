#!/usr/bin/env bun
/**
 * Clay Action / Data credit estimator.
 *
 * Reads live workbooks/tables through the OFFICIAL `clay` CLI and estimates the
 * Actions a run will consume, for a single target or the whole workspace.
 *
 * Billing model (per Clay University — Actions & Data Credits):
 *   - Each `action` column costs 1 Action per record it runs on, any provider.
 *   - `basic` (plain / formula) and `source` (sourcing/import) columns cost 0.
 *   - Only successful returns are billed, so 100% fire is an upper bound.
 *   - A column with a run condition (conditionalRunFormulaText) fires on a
 *     subset of rows — flagged, and discounted by --conditional-rate.
 *
 * Usage:
 *   bun estimate.ts <workbookId|tableId> [options]   # one target
 *   bun estimate.ts --workspace [options]            # rank every workbook/table
 */

type Col = {
  type: "basic" | "action" | "source";
  id: string;
  name: string;
  updatedAt?: string;
  settings?: any;
  sources?: { id: string; name: string; numSourceRecords: number }[];
};

const ID_RE = /^(wb|t)_[A-Za-z0-9]+$/;

function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Run the official clay CLI via a POSIX shell (works with the Windows WSL shim). */
async function clay(args: string[]): Promise<any> {
  const cmd = ["clay", ...args].map(shq).join(" ");
  const p = Bun.spawn(["sh", "-c", cmd], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  if (code !== 0) {
    let msg = err.trim();
    try {
      msg = JSON.parse(err)?.error?.message ?? msg;
    } catch {}
    if (code === 3) msg += "  (run `clay login`)";
    throw new Error(`clay ${args.join(" ")} → exit ${code}: ${msg || "unknown error"}`);
  }
  try {
    return JSON.parse(out);
  } catch {
    throw new Error(`clay ${args.join(" ")} returned non-JSON output`);
  }
}

/** Bounded-concurrency map (WSL-shim spawns are heavy; keep a small pool). */
async function pool<T, R>(items: T[], worker: (item: T, i: number) => Promise<R>, concurrency: number): Promise<R[]> {
  const results = new Array<R>(items.length);
  let idx = 0;
  async function run() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, run));
  return results;
}

// Default heuristic for an integrated (single-column) waterfall. The public CLI
// exposes no provider/step list, so detection is name-based only. Kept tight
// (literal "waterfall") to avoid flagging separate Find/Validate build columns;
// widen it with --waterfall-pattern when your integrated columns are named e.g.
// "Find Work Email".
const DEFAULT_WATERFALL_PATTERN = /waterfall/i;

function classify(
  col: Col,
  waterfallPattern: RegExp,
): { billable: boolean; kind: string; conditional: boolean; waterfall: boolean } {
  if (col.type !== "action") return { billable: false, kind: col.type, conditional: false, waterfall: false };
  const s = col.settings ?? {};
  const conditional =
    typeof s.conditionalRunFormulaText === "string" && s.conditionalRunFormulaText.trim().length > 0;
  const inputs = Array.isArray(s.inputsBinding) ? s.inputsBinding : [];
  const isAI = inputs.some(
    (b: any) =>
      (b?.name === "useCase" && /claygent/i.test(String(b?.formulaText ?? ""))) || b?.name === "prompt",
  );
  let kind = "Enrichment";
  if (isAI) kind = "AI";
  else if (/export|send|sync|hubspot|salesforce|webhook|slack|notion|sequenc|campaign|push|ads?\b/i.test(col.name))
    kind = "GTM export";
  // A waterfall candidate is an enrichment column whose name matches the pattern.
  const waterfall = kind === "Enrichment" && waterfallPattern.test(col.name);
  return { billable: true, kind, conditional, waterfall };
}

type Opts = {
  hitRate: number;
  conditionalRate: number;
  rowsOverride?: number;
  dcPerEnrichment: number;
  concurrency: number;
  waterfallSteps: number;
  waterfallPattern: RegExp;
};

type TableEstimate = {
  id: string;
  name: string;
  workbook: { id: string; name: string } | null;
  rows: number;
  rowsOverridden: boolean;
  columns: {
    name: string;
    type: string;
    kind: string;
    billable: boolean;
    conditional: boolean;
    waterfall: boolean;
    steps: number;
    fireRate: number;
    actions: number;
  }[];
  actionColumnCount: number;
  waterfallColumnCount: number;
  maxActions: number;
  expectedActions: number;
  enrichmentColumnCount: number;
  dataCredits: number;
};

async function estimateTable(
  tableId: string,
  opts: Opts,
  workbook: { id: string; name: string } | null = null,
): Promise<TableEstimate> {
  const [meta, colResp] = await Promise.all([
    clay(["tables", "get", tableId]),
    // `columns get` can trip the CLI's schema check on odd columns; fall back to
    // the abbreviated `columns list` (type only, no settings) so we still estimate.
    clay(["tables", "columns", "get", tableId]).catch(() => null),
  ]);
  const name: string = meta?.name ?? tableId;
  const realRows: number = typeof meta?.rowCount === "number" ? meta.rowCount : 0;
  const rows = opts.rowsOverride ?? realRows;

  let cols: Col[] = Array.isArray(colResp?.data) ? colResp.data : [];
  if (!Array.isArray(colResp?.data)) {
    const listResp = await clay(["tables", "columns", "list", tableId]);
    cols = Array.isArray(listResp?.data) ? listResp.data : [];
  }
  const columns = cols.map((c) => {
    const { billable, kind, conditional, waterfall } = classify(c, opts.waterfallPattern);
    const fireRate = !billable ? 0 : conditional ? opts.conditionalRate : opts.hitRate;
    // An integrated waterfall bills per returning provider + validation step; model
    // that with a step multiplier (default 1 = one Action, i.e. unchanged).
    const steps = billable && waterfall ? opts.waterfallSteps : 1;
    return { name: c.name, type: c.type, kind, billable, conditional, waterfall, steps, fireRate, actions: Math.round(rows * fireRate * steps) };
  });

  const actionCols = columns.filter((c) => c.billable);
  const enrichmentColumnCount = actionCols.filter((c) => c.kind === "Enrichment").length;
  const waterfallColumnCount = actionCols.filter((c) => c.waterfall).length;
  const expectedActions = actionCols.reduce((s, c) => s + c.actions, 0);
  const maxActions = actionCols.reduce((s, c) => s + rows * c.steps, 0);
  const dataCredits =
    opts.dcPerEnrichment > 0 ? Math.round(rows * opts.hitRate * enrichmentColumnCount * opts.dcPerEnrichment) : 0;

  return {
    id: tableId,
    name,
    workbook,
    rows,
    rowsOverridden: opts.rowsOverride != null,
    columns,
    actionColumnCount: actionCols.length,
    waterfallColumnCount,
    maxActions,
    expectedActions,
    enrichmentColumnCount,
    dataCredits,
  };
}

type TableRef = { id: string; name: string; workbook: { id: string; name: string } | null };

async function listWorkbookTables(workbookId: string): Promise<TableRef[]> {
  const out: TableRef[] = [];
  let cursor: string | undefined;
  do {
    const args = ["tables", "list", "--filter", `workbook.id=${workbookId}`, "--limit", "100"];
    if (cursor) args.push("--cursor", cursor);
    const resp = await clay(args);
    for (const t of resp?.data ?? []) out.push({ id: t.id, name: t.name, workbook: t.workbook ?? null });
    cursor = resp?.cursor;
  } while (cursor);
  return out;
}

async function listAllTables(): Promise<TableRef[]> {
  const out: TableRef[] = [];
  let cursor: string | undefined;
  do {
    const args = ["tables", "list", "--limit", "100"];
    if (cursor) args.push("--cursor", cursor);
    const resp = await clay(args);
    for (const t of resp?.data ?? []) out.push({ id: t.id, name: t.name, workbook: t.workbook ?? null });
    cursor = resp?.cursor;
  } while (cursor);
  return out;
}

// ---------------------------------------------------------------- formatting
const n = (x: number) => x.toLocaleString("en-US");
const pct = (x: number) => `${Math.round(x * 100)}%`;
const pad = (s: string, w: number) => s.padEnd(w);
const padL = (s: string, w: number) => s.padStart(w);

function printTable(t: TableEstimate) {
  console.log(`\n▚ ${t.name}  (${t.id})`);
  console.log(`  Rows: ${n(t.rows)}${t.rowsOverridden ? "  [overridden]" : ""}   Action columns: ${t.actionColumnCount}`);
  const billable = t.columns.filter((c) => c.billable);
  if (billable.length) {
    const wName = Math.max(6, ...billable.map((c) => c.name.length));
    console.log(`  ${pad("Column", wName)}  ${pad("Kind", 11)}  Fire   Actions`);
    for (const c of billable) {
      const flag = c.waterfall && c.steps > 1 ? "≈" : c.conditional ? "*" : " ";
      const kindLabel = c.waterfall ? `${c.kind} (wf×${c.steps})` : c.kind;
      console.log(`  ${pad(c.name, wName)}  ${pad(kindLabel, 11)}  ${padL(pct(c.fireRate), 4)}${flag}  ${padL(n(c.actions), 8)}`);
    }
  } else {
    console.log("  (no action columns — 0 Actions)");
  }
  const free = t.columns.filter((c) => !c.billable);
  if (free.length)
    console.log(`  Free columns (0 Actions): ${free.length} (${[...new Set(free.map((c) => c.type))].join(", ")})`);
  console.log(`  → Expected Actions: ${n(t.expectedActions)}   (max at 100% fire: ${n(t.maxActions)})`);
  if (t.dataCredits > 0) console.log(`  → Rough Data Credits: ~${n(t.dataCredits)} (assumption-based)`);
  if (t.waterfallColumnCount > 0 && t.columns.every((c) => c.steps === 1))
    console.log(`  ℹ ${t.waterfallColumnCount} waterfall-named column(s) counted as 1 Action each — pass --waterfall-steps <n> to model per-step billing.`);
}

// ---------------------------------------------------------------- CSV
type Output = "pretty" | "json" | "csv";

const CSV_COLS = [
  "rank",
  "workbook_id",
  "workbook_name",
  "table_id",
  "table_name",
  "rows",
  "action_columns",
  "enrichment_columns",
  "waterfall_columns",
  "expected_actions",
  "max_actions",
  "data_credits",
] as const;

function csvEscape(v: string | number): string {
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** One row per table, ordered by expected Actions desc, to stdout. */
function emitCsv(tables: TableEstimate[]) {
  const rows = [...tables].sort((a, b) => b.expectedActions - a.expectedActions);
  const lines = [CSV_COLS.join(",")];
  rows.forEach((t, i) => {
    const rec: Record<(typeof CSV_COLS)[number], string | number> = {
      rank: i + 1,
      workbook_id: t.workbook?.id ?? "",
      workbook_name: t.workbook?.name ?? "",
      table_id: t.id,
      table_name: t.name,
      rows: t.rows,
      action_columns: t.actionColumnCount,
      enrichment_columns: t.enrichmentColumnCount,
      waterfall_columns: t.waterfallColumnCount,
      expected_actions: t.expectedActions,
      max_actions: t.maxActions,
      data_credits: t.dataCredits,
    };
    lines.push(CSV_COLS.map((c) => csvEscape(rec[c])).join(","));
  });
  process.stdout.write(lines.join("\r\n") + "\r\n");
}

// ---------------------------------------------------------------- workspace roll-up
async function runWorkspace(opts: Opts, top: number, minActions: number, output: Output) {
  process.stderr.write("Listing tables…\n");
  const refs = await listAllTables();
  process.stderr.write(`Estimating ${refs.length} tables (concurrency ${opts.concurrency})…\n`);

  let done = 0;
  const errors: { id: string; name: string; error: string }[] = [];
  const wsOpts: Opts = { ...opts, rowsOverride: undefined }; // row override is meaningless workspace-wide
  const settled = await pool(
    refs,
    async (r) => {
      try {
        const est = await estimateTable(r.id, wsOpts, r.workbook);
        return est;
      } catch (e: any) {
        errors.push({ id: r.id, name: r.name, error: e.message });
        return null;
      } finally {
        done++;
        if (done % 10 === 0 || done === refs.length) process.stderr.write(`  …${done}/${refs.length}\r`);
      }
    },
    opts.concurrency,
  );
  process.stderr.write("\n");

  const tables = settled.filter((t): t is TableEstimate => t != null);

  // group by workbook
  type WB = { id: string; name: string; tables: TableEstimate[]; expected: number; max: number; rows: number; actionCols: number; dc: number };
  const wbMap = new Map<string, WB>();
  for (const t of tables) {
    const key = t.workbook?.id ?? "__none__";
    const nm = t.workbook?.name ?? "(no workbook)";
    let wb = wbMap.get(key);
    if (!wb) {
      wb = { id: t.workbook?.id ?? "", name: nm, tables: [], expected: 0, max: 0, rows: 0, actionCols: 0, dc: 0 };
      wbMap.set(key, wb);
    }
    wb.tables.push(t);
    wb.expected += t.expectedActions;
    wb.max += t.maxActions;
    wb.rows += t.rows;
    wb.actionCols += t.actionColumnCount;
    wb.dc += t.dataCredits;
  }
  const workbooks = [...wbMap.values()].sort((a, b) => b.expected - a.expected);
  const rankedTables = [...tables].sort((a, b) => b.expectedActions - a.expectedActions).filter((t) => t.expectedActions >= minActions);

  const totalExpected = tables.reduce((s, t) => s + t.expectedActions, 0);
  const totalMax = tables.reduce((s, t) => s + t.maxActions, 0);
  const totalRows = tables.reduce((s, t) => s + t.rows, 0);
  const totalDC = tables.reduce((s, t) => s + t.dataCredits, 0);

  if (output === "csv") {
    emitCsv(rankedTables);
    if (errors.length) process.stderr.write(`(${errors.length} tables skipped and omitted from CSV)\n`);
    return;
  }
  if (output === "json") {
    console.log(
      JSON.stringify(
        {
          kind: "workspace",
          assumptions: { hitRate: opts.hitRate, conditionalRate: opts.conditionalRate, dcPerEnrichment: opts.dcPerEnrichment },
          totals: { tables: tables.length, workbooks: workbooks.length, rows: totalRows, expectedActions: totalExpected, maxActions: totalMax, dataCredits: totalDC },
          workbooks: workbooks.map((w) => ({ id: w.id, name: w.name, tables: w.tables.length, actionColumns: w.actionCols, rows: w.rows, expectedActions: w.expected, maxActions: w.max, dataCredits: w.dc })),
          tables: rankedTables.map((t) => ({ id: t.id, name: t.name, workbook: t.workbook, rows: t.rows, actionColumns: t.actionColumnCount, expectedActions: t.expectedActions, maxActions: t.maxActions, dataCredits: t.dataCredits })),
          errors,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(`\n=== Clay workspace Action roll-up ===`);
  console.log(
    `Assumptions: hit-rate ${pct(opts.hitRate)}, conditional ${pct(opts.conditionalRate)}` +
      (opts.dcPerEnrichment > 0 ? `, ${opts.dcPerEnrichment} DC/enrichment` : ""),
  );
  console.log(`Scanned ${n(tables.length)} tables across ${n(workbooks.length)} workbook groups${errors.length ? `  (${errors.length} skipped — see errors)` : ""}`);

  // Workbooks ranked
  const wbShown = workbooks.slice(0, top);
  const wName = Math.max(8, ...wbShown.map((w) => w.name.length));
  console.log(`\nWorkbooks by Action load${workbooks.length > top ? ` (top ${top} of ${workbooks.length})` : ""}:`);
  console.log(`  ${padL("#", 3)}  ${padL("Expected", 12)}  ${padL("Max", 12)}  ${padL("Tbls", 4)}  ${padL("ActCol", 6)}  Workbook`);
  wbShown.forEach((w, i) => {
    console.log(
      `  ${padL(String(i + 1), 3)}  ${padL(n(w.expected), 12)}  ${padL(n(w.max), 12)}  ${padL(String(w.tables.length), 4)}  ${padL(String(w.actionCols), 6)}  ${w.name}${w.id ? `  (${w.id})` : ""}`,
    );
  });

  // Tables ranked
  const tShown = rankedTables.slice(0, top);
  console.log(`\nTables by Action load${rankedTables.length > top ? ` (top ${top} of ${rankedTables.length})` : ""}:`);
  const tName = Math.max(6, ...tShown.map((t) => t.name.length));
  console.log(`  ${padL("#", 3)}  ${padL("Expected", 12)}  ${padL("Rows", 9)}  ${padL("ActCol", 6)}  ${pad("Table", tName)}  Workbook`);
  tShown.forEach((t, i) => {
    console.log(
      `  ${padL(String(i + 1), 3)}  ${padL(n(t.expectedActions), 12)}  ${padL(n(t.rows), 9)}  ${padL(String(t.actionColumnCount), 6)}  ${pad(t.name, tName)}  ${t.workbook?.name ?? "(no workbook)"}`,
    );
  });

  console.log(`\n────────────────────────────────────────`);
  console.log(`WORKSPACE TOTAL: ${n(totalExpected)} expected Actions (max ${n(totalMax)}) across ${n(tables.length)} tables, ${n(totalRows)} rows`);
  if (totalDC > 0) console.log(`  Rough Data Credits: ~${n(totalDC)} (assumption-based)`);
  if (errors.length) {
    console.log(`\nSkipped ${errors.length} tables:`);
    for (const e of errors.slice(0, 10)) console.log(`  - ${e.name} (${e.id}): ${e.error.split("\n")[0]}`);
    if (errors.length > 10) console.log(`  …and ${errors.length - 10} more`);
  }
  console.log(`\nActions bill only on success. Verify a table by running 5–10 rows, then check its credit-usage dashboard.`);
}

// ---------------------------------------------------------------- single target
async function runSingle(id: string, opts: Opts, output: Output) {
  const isWorkbook = id.startsWith("wb_");
  const refs = isWorkbook ? await listWorkbookTables(id) : [{ id, name: id, workbook: null }];
  if (isWorkbook && refs.length === 0) throw new Error(`Workbook ${id} has no tables (or you lack access).`);

  const tables = await pool(refs, (r) => estimateTable(r.id, opts, r.workbook), opts.concurrency);

  const totalExpected = tables.reduce((s, t) => s + t.expectedActions, 0);
  const totalMax = tables.reduce((s, t) => s + t.maxActions, 0);
  const totalRows = tables.reduce((s, t) => s + t.rows, 0);
  const totalDC = tables.reduce((s, t) => s + t.dataCredits, 0);

  if (output === "csv") {
    emitCsv(tables);
    return;
  }
  if (output === "json") {
    console.log(
      JSON.stringify(
        {
          target: id,
          kind: isWorkbook ? "workbook" : "table",
          assumptions: { hitRate: opts.hitRate, conditionalRate: opts.conditionalRate, rowsOverride: opts.rowsOverride ?? null, dcPerEnrichment: opts.dcPerEnrichment },
          totals: { rows: totalRows, expectedActions: totalExpected, maxActions: totalMax, dataCredits: totalDC },
          tables,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(`\n=== Clay credit estimate: ${isWorkbook ? "workbook" : "table"} ${id} ===`);
  console.log(
    `Assumptions: hit-rate ${pct(opts.hitRate)}, conditional ${pct(opts.conditionalRate)}` +
      (opts.rowsOverride != null ? `, rows overridden to ${n(opts.rowsOverride)}` : "") +
      (opts.dcPerEnrichment > 0 ? `, ${opts.dcPerEnrichment} DC/enrichment` : ""),
  );
  for (const t of tables) printTable(t);

  if (tables.length > 1) {
    console.log(`\n────────────────────────────────────────`);
    console.log(`WORKBOOK TOTAL (${tables.length} tables, ${n(totalRows)} rows)`);
    console.log(`  Expected Actions: ${n(totalExpected)}`);
    console.log(`  Max Actions (100% fire): ${n(totalMax)}`);
    if (totalDC > 0) console.log(`  Rough Data Credits: ~${n(totalDC)} (assumption-based)`);
  }
  console.log(
    `\nActions bill only on success; Data Credits are provider-dependent and shown only with --dc-per-enrichment.` +
      `\nVerify by running 5–10 rows, then check the table's credit-usage dashboard.`,
  );
}

function help() {
  console.log(`Clay Action / Data credit estimator (official \`clay\` CLI)

Usage:
  bun estimate.ts <workbookId|tableId> [options]   estimate one workbook or table
  bun estimate.ts --workspace [options]            rank every workbook & table by Action load

Options:
  -r, --hit-rate <0..1>         Expected fire/success rate for action columns (default 1.0 = upper bound)
      --conditional-rate <0..1> Fire rate for columns with a run condition (default = hit-rate)
      --rows <n>                Override row count, single target only (what-if for empty tables)
      --dc-per-enrichment <n>   Rough Data Credits per successful enrichment column (default 0 = off)
      --workspace               Roll up the whole workspace, ranked by Action load
      --top <n>                 Rows to show per ranking in --workspace (default 20)
      --min-actions <n>         Hide tables below this Action load in --workspace (default 0)
      --concurrency <n>         Parallel clay calls (default 8)
      --waterfall-steps <n>     Actions billed per integrated-waterfall column (default 1). Models a
                                single multi-provider column that bills per returning + validation step.
      --waterfall-pattern <re>  Case-insensitive regex naming integrated-waterfall columns (default: waterfall)
      --json                    Emit JSON
      --csv                     Emit CSV (one row per table, ranked by expected Actions) to stdout
  -h, --help                    This help

Examples:
  bun estimate.ts wb_yourWorkbookId
  bun estimate.ts t_yourTableId --hit-rate 0.8 --conditional-rate 0.5
  bun estimate.ts --workspace --hit-rate 0.7 --top 15
  bun estimate.ts --workspace --json > workspace-actions.json
  bun estimate.ts wb_yourWorkbookId --waterfall-steps 3 --waterfall-pattern "find.*email|waterfall"

* Actions bill 1 per record per action column, on success only. basic/source columns are free.
  A "*" marks a conditional column; "≈" a waterfall column billed at >1 step.
  The CLI exposes no provider list, so waterfall detection is name-based — verify against a real run.`);
}

// ---------------------------------------------------------------- main
async function main() {
  const argv = process.argv.slice(2);
  const opts: Opts = { hitRate: 1.0, conditionalRate: NaN, rowsOverride: undefined, dcPerEnrichment: 0, concurrency: 8, waterfallSteps: 1, waterfallPattern: DEFAULT_WATERFALL_PATTERN };
  let id: string | undefined;
  let workspace = false;
  let json = false;
  let csv = false;
  let top = 20;
  let minActions = 0;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "-h" || a === "--help") return help();
    else if (a === "-r" || a === "--hit-rate") opts.hitRate = parseFloat(next());
    else if (a === "--conditional-rate") opts.conditionalRate = parseFloat(next());
    else if (a === "--rows") opts.rowsOverride = parseInt(next(), 10);
    else if (a === "--dc-per-enrichment") opts.dcPerEnrichment = parseFloat(next());
    else if (a === "--concurrency") opts.concurrency = Math.max(1, parseInt(next(), 10) || 8);
    else if (a === "--waterfall-steps") opts.waterfallSteps = Math.max(1, parseFloat(next()) || 1);
    else if (a === "--waterfall-pattern") {
      const raw = next();
      try {
        opts.waterfallPattern = new RegExp(raw, "i");
      } catch {
        throw new Error(`Invalid --waterfall-pattern regex: ${raw}`);
      }
    } else if (a === "--workspace" || a === "--all") workspace = true;
    else if (a === "--top") top = Math.max(1, parseInt(next(), 10) || 20);
    else if (a === "--min-actions") minActions = Math.max(0, parseInt(next(), 10) || 0);
    else if (a === "--json") json = true;
    else if (a === "--csv") csv = true;
    else if (!a.startsWith("-")) id = a;
    else throw new Error(`Unknown option: ${a}`);
  }

  if (json && csv) throw new Error("Pass either --json or --csv, not both.");
  const output: Output = csv ? "csv" : json ? "json" : "pretty";

  if (!(opts.hitRate >= 0 && opts.hitRate <= 1)) throw new Error("--hit-rate must be between 0 and 1");
  if (Number.isNaN(opts.conditionalRate)) opts.conditionalRate = opts.hitRate;
  if (!(opts.conditionalRate >= 0 && opts.conditionalRate <= 1)) throw new Error("--conditional-rate must be between 0 and 1");

  if (workspace) {
    if (id) throw new Error("Pass either a workbook/table id OR --workspace, not both.");
    return runWorkspace(opts, top, minActions, output);
  }
  if (!id) {
    help();
    process.exit(2);
  }
  if (!ID_RE.test(id)) throw new Error(`Not a valid Clay id (expected wb_… or t_…): ${id}`);
  return runSingle(id, opts, output);
}

main().catch((e: any) => {
  console.error(`Error: ${e.message}`);
  process.exit(1);
});
