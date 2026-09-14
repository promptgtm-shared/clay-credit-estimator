# clay-credit-estimator

A Claude Code skill that estimates how many **Actions** (Clay's platform-usage meter — what people mean by "action credits") a Clay workbook or table will consume before you run it at scale. It can also roll up an entire workspace, ranked by Action load, to show where credit spend concentrates.

It reads live tables through the **official `clay` CLI** and applies Clay's documented billing model, so the estimate reflects real column configuration rather than a guess.

## Why

Before running an enrichment at scale, you want to know what it will cost in Actions. Counting enrichment columns by hand is slow and error-prone, and it ignores conditional columns that only run on a subset of rows. This computes it from the table's actual columns.

## Billing model

Per [Clay University — Actions & Data Credits](https://university.clay.com/docs/actions-data-credits):

- Each **action** column costs **1 Action per record it runs on**, regardless of provider (including when you bring your own API key).
- **basic** (plain / formula) and **source** (sourcing / import) columns cost **0 Actions**.
- Only **successful** returns are billed, so 100% fire is an upper bound. A waterfall that resolves on provider 2 of 4 still bills 1 Action for that column.
- A column with a run condition fires on a subset of rows; it's flagged and discounted separately.
- **Data Credits** (marketplace data cost) are provider-dependent and can't be read from the CLI, so they're off by default; `--dc-per-enrichment` gives a rough, clearly-labeled estimate.

## Requirements

- [Bun](https://bun.sh)
- The official [`clay` CLI](https://github.com/clay-run/agent-plugins), authenticated (`clay whoami`; `clay login` if needed)
- The public observability API (Enterprise plans) for reading table columns

## Usage

```bash
bun estimate.ts <workbookId|tableId> [options]   # one target
bun estimate.ts --workspace [options]            # rank every workbook & table
```

`wb_…` is a workbook (all its tables are summed); `t_…` is a single table. `--workspace` enumerates every table, groups by workbook, and ranks both lists by Action load.

### Options

| Flag | Default | Meaning |
|---|---|---|
| `-r, --hit-rate <0..1>` | `1.0` | Expected success/fire rate for action columns. `1.0` = deterministic upper bound. |
| `--conditional-rate <0..1>` | = hit-rate | Fire rate applied only to conditional columns. |
| `--rows <n>` | live rowCount | Override the row count (single target) — what-if for an empty table. |
| `--dc-per-enrichment <n>` | `0` (off) | Rough Data Credits per successful enrichment column. |
| `--workspace`, `--all` | — | Roll up every workbook & table, ranked by Action load. |
| `--top <n>` | `20` | Rows shown per ranking in `--workspace`. |
| `--min-actions <n>` | `0` | Hide tables below this Action load in `--workspace`. |
| `--concurrency <n>` | `8` | Parallel `clay` calls. |
| `--json` | — | Machine-readable output. |
| `--csv` | — | CSV to stdout, one row per table, ranked by expected Actions. |

`--json` and `--csv` are mutually exclusive.

### Examples

```bash
# Upper-bound Actions for a whole workbook
bun estimate.ts wb_yourWorkbookId

# Realistic estimate: 75% enrichment hit, conditional columns fire ~50%
bun estimate.ts t_yourTableId --hit-rate 0.75 --conditional-rate 0.5

# Plan a 5,000-row run before importing, with a rough Data Credit figure
bun estimate.ts t_yourTableId --rows 5000 --dc-per-enrichment 6

# Workspace roll-up: where is your Action load concentrated?
bun estimate.ts --workspace --hit-rate 0.75 --top 15

# CSV for a spreadsheet (only tables above 100 Actions)
bun estimate.ts --workspace --hit-rate 0.75 --min-actions 100 --csv > workspace-actions.csv
```

CSV columns: `rank, workbook_id, workbook_name, table_id, table_name, rows, action_columns, enrichment_columns, expected_actions, max_actions, data_credits`.

## How it classifies columns

- `type: "action"` → billable (1 Action/rec). Sub-label is best-effort for display only:
  - **AI** if an input binding uses Claygent or a `prompt` input.
  - **GTM export** if the name matches export / sync / sequence / CRM / webhook / ads patterns.
  - **Enrichment** otherwise.
- `type: "basic"` / `type: "source"` → free (0 Actions).

## Notes

- Uses **only** the official `clay` CLI — no vendored tooling.
- The `--workspace` scan is read-only and can take a couple of minutes on a large workspace (hundreds of tables). Progress prints to stderr. Tables the CLI can't read (unsupported / archive types) are skipped and listed at the end.
- The estimate is a planning tool. **Verify** by running 5–10 rows, then reading the table's real-time credit-usage dashboard.

## License

MIT
