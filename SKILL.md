---
name: clay-credit-estimate
description: Estimate the Actions (and rough Data Credits) a Clay workbook or table will consume before running it at scale, or roll up the whole workspace ranked by Action load. Use when the user asks "how many action credits will this workbook/table use", "estimate credits for wb_… / t_…", "what will this cost to run", "which tables/workbooks use the most Actions", or wants a credit/Action calculator or workspace-wide Action ranking.
---

# Clay credit estimator

Reads a live workbook or table via the **official `clay` CLI** and estimates the
**Actions** a full run will consume. Actions are Clay's platform-usage meter — the
thing users mean by "action credits."

## Billing model (from Clay University — Actions & Data Credits)

- Each **`action` column** costs **1 Action per record it runs on**, regardless of provider (including when you use your own API key).
- **`basic`** (plain / formula) and **`source`** (sourcing / import) columns cost **0 Actions**.
- Only steps that **return data** are billed — a provider step that returns nothing or errors is free, so a 100% fire rate is an upper bound. A waterfall bills **1 Action per returning provider step _and_ per validation step**, up to the one that validates (a validator bills on a valid *or* invalid result). Because Clay waterfalls are usually built as separate `Find` + `Validate` columns, counting each action column as 1 Action/row is accurate; a single **integrated** multi-provider waterfall column can bill more than 1 Action/row, which this tool would under-count.
- A column with a **run condition** (`conditionalRunFormulaText`) only fires on a subset of rows; the script flags it (`*`) and discounts it by `--conditional-rate`.
- **Data Credits** (marketplace data cost) are provider-dependent and cannot be read from the CLI, so they're **off by default**; `--dc-per-enrichment` gives a rough, clearly-labeled estimate.

## Usage

```bash
bun estimate.ts <workbookId|tableId> [options]   # one target
bun estimate.ts --workspace [options]            # rank the workspace
```

`wb_…` is treated as a workbook (all its tables are summed); `t_…` as a single table. `--workspace` enumerates every table, groups them by workbook, and ranks both lists by Action load. Row counts come from the live table (`clay tables get`).

Options:

| Flag | Default | Meaning |
|---|---|---|
| `-r, --hit-rate <0..1>` | `1.0` | Expected success/fire rate for action columns. `1.0` = deterministic upper bound. |
| `--conditional-rate <0..1>` | = hit-rate | Fire rate applied only to conditional (`*`) columns. |
| `--rows <n>` | live rowCount | Override the row count (single target only) — what-if planning for an empty table. |
| `--dc-per-enrichment <n>` | `0` (off) | Rough Data Credits per successful enrichment column. |
| `--workspace`, `--all` | — | Roll up every workbook & table in the workspace, ranked by Action load. |
| `--top <n>` | `20` | Rows shown per ranking in `--workspace`. |
| `--min-actions <n>` | `0` | Hide tables below this Action load in `--workspace`. |
| `--concurrency <n>` | `8` | Parallel `clay` calls (WSL-shim spawns are slow; ~2 calls per table). |
| `--json` | — | Machine-readable output. |
| `--csv` | — | CSV to stdout — one row per table, ranked by expected Actions. Works in every mode; pair with `--workspace` to slice in a spreadsheet. |
| `-h, --help` | — | Help. |

CSV columns: `rank, workbook_id, workbook_name, table_id, table_name, rows, action_columns, enrichment_columns, expected_actions, max_actions, data_credits`. `--json` and `--csv` are mutually exclusive.

## Examples

```bash
# Upper-bound Actions for a whole workbook
bun estimate.ts wb_yourWorkbookId

# Realistic estimate: 80% enrichment hit, conditional columns fire ~50%
bun estimate.ts t_yourTableId -r 0.8 --conditional-rate 0.5

# Plan a 5,000-row run before importing, with a rough Data Credit figure, as JSON
bun estimate.ts t_yourTableId --rows 5000 --dc-per-enrichment 6 --json

# Workspace roll-up: where is your Action load concentrated?
bun estimate.ts --workspace --hit-rate 0.8 --top 15
bun estimate.ts --workspace --json > workspace-actions.json

# CSV for a spreadsheet (only tables above 100 Actions), or for one workbook
bun estimate.ts --workspace --hit-rate 0.8 --min-actions 100 --csv > workspace-actions.csv
bun estimate.ts wb_yourWorkbookId --csv > workbook-actions.csv
```

The `--workspace` scan is read-only and can take a couple of minutes on a large workspace (hundreds of tables). It prints progress to stderr, ranks **workbooks** then **tables** by expected Actions, and reports a workspace total. Tables the CLI can't read (unsupported/archive types) are skipped and listed at the end.

## How it classifies columns

- `type: "action"` → billable (1 Action/rec). Sub-label is best-effort for display only:
  - **AI** if an `inputsBinding` has `useCase: "claygent"` or a `prompt` input.
  - **GTM export** if the name matches export/sync/sequence/CRM/webhook/ads patterns.
  - **Enrichment** otherwise.
- `type: "basic"` / `type: "source"` → free (0 Actions).

## Notes

- Requires an authenticated `clay` CLI (`clay whoami`; `clay login` if needed). Needs the public observability API (Enterprise) for `tables columns`/`get`.
- Uses **only** the official `clay` CLI — no vendored tooling.
- The estimate is a planning tool. **Verify** by running 5–10 rows, then reading the table's real-time credit-usage dashboard.
