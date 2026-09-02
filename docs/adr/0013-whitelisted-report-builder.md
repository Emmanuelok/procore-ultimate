# ADR 0013 — The report builder executes a whitelist, never user SQL

**Status:** accepted (implemented in `apps/api/src/modules/analytics/datasets.ts`, consumed
by `modules/analytics/index.ts`)

## Context

Spec Vol I §6.1–6.2 asks for a cross-tool custom report builder: column selection across
objects (#731–732), filter and grouping configuration (#733), project- and company-level
scope (#739), dashboards over the results (#741–742), BI-style data-model exposure (#743)
and **row-level security in analytics** (#751). A report definition is therefore, by
design, *stored user input that describes a query* — the `report_definitions` row carries a
dataset name, a list of column keys, filters, a group-by field, aggregation fields and a
sort field (`packages/db/src/schema/analytics.ts`).

That shape is the classic injection surface, and it is worse than the usual one for a
structural reason: **identifiers cannot be parameterized in SQL.** A filter *value* binds
as `$1`; a column name, a table name, a GROUP BY target and an aggregate alias cannot. Any
design that lets a definition contribute an identifier has to reach SQL by string
concatenation, and then the only defence left is escaping — a defence that has to be
perfect on every path, forever, including the paths added by the next module.

The tenancy problem compounds it. This platform's isolation is a code convention — every
query filters `companyId`, and there is no Postgres row-level security (`docs/security.md`
§3, §8 gap 6). A report definition is a *persisted, shareable* query fragment: if the
definition were allowed to supply its own scope predicates, one saved report with the wrong
(or deliberately chosen) company id would be a cross-tenant read that survives in the
database and runs again on every dashboard load.

The tempting alternatives were both rejected:

- **A restricted SQL dialect** (parse user SQL, allow a subset). It moves the security
  boundary into a parser we would own and would have to keep correct against every
  Postgres extension of syntax. The failure mode is silent.
- **An ORM-level "any column on any table" builder.** Slightly safer — drizzle would build
  the SQL — but the set of reportable columns then becomes "whatever exists in the
  schema", which leaks `passwordHash`, `tokenHash`, evidence payloads and every other
  column that was never meant to be projected into a shared CSV.

## Decision

**A report definition names *keys*. Every key is looked up in a registry defined in code,
and the lookup either resolves to a drizzle column object or the request is a 400. No
user-supplied string ever reaches SQL text — not as a column, not as a table, not as an
alias.**

The registry is `DATASETS` in `apps/api/src/modules/analytics/datasets.ts`: one
`DatasetDef` per member of `REPORT_DATASETS` (`packages/shared/src/enums.ts` — today
`rfis`, `submittals`, `punch_items`, `daily_logs`, `delay_events`, `risks`, `signals`,
`payment_claims`, `variations`, `disbursements`, `grievances`, `workers`). Each definition
carries the drizzle `table`, its `companyColumn` and `projectColumn`, a default sort, and a
`Record<string, DatasetColumnDef>` of reportable columns. Each column declares its `label`,
the **drizzle column object itself**, a type (`string | number | date | enum`), an optional
closed `enumValues` vocabulary, and three capability flags — `filterable`, `groupable`,
`aggregatable`.

Consequences of that shape, all enforced in `resolveReport` / `executeReport`:

1. **Lookups are own-property checks, not bare indexing.** `Object.hasOwn(DATASETS, key)`
   and `Object.hasOwn(ds.columns, key)` — a bare `DATASETS[key]` would resolve
   `constructor`, `__proto__` or `toString` from `Object.prototype` to a truthy non-dataset
   and crash (or worse) downstream. The offending key is echoed back to the builder in the
   400 body; it is never used in a query.
2. **Aliases are the one place a user string is emitted, and they are pattern-locked.**
   An aggregation alias must match `[A-Za-z][A-Za-z0-9_]{0,40}` (`ALIAS_RE`), and duplicate
   aliases are rejected.
3. **Values are coerced to the registered column's type before binding.** Numbers must be
   finite, dates must parse as ISO, and a value for an `enum` column must be a member of
   that column's declared vocabulary. `in` is capped at 200 values. Drizzle binds them as
   parameters.
4. **Operators are constrained by column type.** `operatorsForType` refuses `gt` on a
   string and `contains` on a number; `aggregationsForColumn` refuses `sum` on an enum.
   `count` is available on every column.
5. **Scope predicates are appended by the executor, from the request, and are always
   first.** `executeReport(db, plan, scope, window)` pushes `eq(companyColumn, scope.companyId)`
   before any definition filter, and the definition's own filters are ANDed *beneath* it.
   A definition that filters on another tenant's id therefore returns nothing rather than
   escaping the tenant. For a company-wide run, `scope.projectIds` narrows a project-scoped
   dataset to the caller's reachable projects (`reachableProjectIds` in
   `modules/analytics/index.ts` mirrors `requireTool`'s model: owner/admin and company-wide
   assurance grants are unrestricted; everyone else gets their memberships plus
   project-scoped grants) — and an empty array renders as a literal `false` predicate,
   because a user on no projects should see no rows, not every row (#751).

The registry is also the **catalog**: `datasetCatalog()` renders the same code constant as
the builder UI's field list, with the labels, types, enum vocabularies and per-column
capability flags. `GET /analytics/datasets` serves it. There is exactly one source of
truth for what is reportable, and it is the same object the executor runs.

## Consequences

- **The injection class is designed out, not filtered out.** There is no path from a
  definition to SQL text. Adding a module cannot accidentally open one; a new dataset is a
  new entry in `DATASETS`, and anything not listed there is unreportable by construction.
  Analytics is called out as an injection control in `docs/security.md` §2.4.
- **Analytics is never a wider door than the tool it reports on.** Scope is taken from the
  request context, and project reach is recomputed per run. A saved report cannot be used
  to launder access to a project the caller lost, and sharing a report (`isShared`) shares
  the *definition*, not the rows — every viewer's run is re-scoped to that viewer.
- **The accepted cost: only registered columns are reportable.** Twelve datasets today, a
  chosen column set within each. A field that exists in the schema but not in the registry
  cannot be reported on at any level of the UI, and the answer to "why can't I report on
  X?" is a code change plus a test, not a config toggle. That is the trade we want —
  the alternative is that `users.passwordHash` and `refresh_tokens.tokenHash` are one
  clever column key away from a CSV export — but it does mean the registry needs
  deliberate curation as modules land, and a dataset that nobody adds is silently absent
  rather than loudly broken.
- **Calculated columns (#734) are not supported**, and cannot be without reopening this
  decision: an arbitrary user expression is user-authored SQL by another name. When it is
  needed, the shape that preserves the invariant is a registry of *named* derived columns
  (`age_days`, `variance_percent`) defined in code as drizzle `sql` fragments over
  registered columns, selected by key like everything else.
- **Aggregate numerics are normalized on the way out.** Postgres returns `sum`/`avg` as
  strings on some driver paths; `executeReport` coerces the declared-numeric output columns
  with `Number(...)` so a chart never has to guess. Row-mode string columns pass through
  untouched.
- **Limits are structural, not advisory.** `limitRows` is clamped to `MAX_LIMIT_ROWS`
  (5000) and the executor fetches `want + 1` rows to report `truncated: true` honestly
  rather than silently cutting a page.
