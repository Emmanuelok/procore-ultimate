/**
 * FORECASTING — what each line will cost, and BY WHICH METHOD.
 *
 * The method is not decoration. "£412,000 to complete" means something
 * different depending on whether an estimator typed it, whether it assumes the
 * remaining work costs what was budgeted, or whether it extrapolates the rate
 * achieved so far — and the last of those is routinely the most pessimistic
 * number on the job. So the method travels with every figure on this screen:
 * on the preview, on the stored column it would replace, and on every recorded
 * forecast in the history.
 *
 * The preview computes what each line WOULD be under a chosen method and
 * throws the result away. Lines whose inputs do not support the method come
 * back with `null` and the platform's reasons, which are shown verbatim — a
 * fabricated figure here would be indistinguishable from a real one, and it
 * would be wrong.
 */
import { useCallback, useMemo, useState, type ReactNode } from "react";
import { FORECAST_METHODS, type ForecastMethod } from "@constructos/shared";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  EmptyState,
  ErrorAlert,
  Select,
  Tooltip,
  cx,
  useConfirm,
} from "../../ui";
import { IconInsight } from "../../ui/icons";
import { ChartCard, SCurveChart } from "../../ui/charts";
import { DataTable } from "../../ui/data";
import type { DataColumns, DataOption, DataRowAction } from "../../ui/data";
import { api } from "../../lib/api";
import ForecastLineModal from "./ForecastLineModal";
import {
  EM_DASH,
  FORECAST_METHOD_HINT,
  FORECAST_METHOD_LABEL,
  FORECAST_STATUS_TONE,
  LoadError,
  MethodBadge,
  RefusalNotice,
  SectionHeading,
  actorName,
  count,
  errorMessage,
  isForbidden,
  isoDate,
  labelize,
  loadAllLines,
  money,
  useResource,
  type BudgetDetail,
  type BudgetLine,
  type ForecastPreview,
  type ForecastPreviewLine,
  type ForecastRecord,
  type ListResponse,
} from "./budgetShared";

export interface ForecastTabProps {
  budget: BudgetDetail;
  currency: string;
  users: Map<string, string>;
  version: number;
  onChanged: () => void;
}

export default function ForecastTab({
  budget,
  currency,
  users,
  version,
  onChanged,
}: ForecastTabProps) {
  const { confirm, dialog } = useConfirm();
  const [method, setMethod] = useState<ForecastMethod>("committed_plus_pending");
  const [localVersion, setLocalVersion] = useState(0);
  const [forecastLine, setForecastLine] = useState<BudgetLine | null>(null);
  const [wholeBudgetOpen, setWholeBudgetOpen] = useState(false);
  const [selectedForecast, setSelectedForecast] = useState<ForecastRecord | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<{ title: string; message: string } | null>(null);

  const bump = useCallback(() => setLocalVersion((n) => n + 1), []);

  const preview = useResource<ForecastPreview>(
    (signal) =>
      api.get<ForecastPreview>(
        `/api/v1/budgets/${budget.id}/forecast-preview?method=${method}`,
        { signal },
      ),
    [budget.id, method, version, localVersion],
  );

  const lines = useResource(
    (signal) => loadAllLines(budget.id, signal),
    [budget.id, version, localVersion],
  );

  const forecasts = useResource<ListResponse<ForecastRecord>>(
    (signal) =>
      api.get<ListResponse<ForecastRecord>>(
        `/api/v1/budgets/${budget.id}/forecasts?page=1&pageSize=200`,
        { signal },
      ),
    [budget.id, version, localVersion],
  );

  const lineById = useMemo(
    () => new Map((lines.data?.lines ?? []).map((line) => [line.id, line])),
    [lines.data],
  );

  const previewRows = preview.data?.lines ?? [];
  const storedFinalTotal = budget.forecastFinalTotal;
  const proposedTotal = preview.data?.proposedForecastFinalTotal ?? null;

  async function act(key: string, run: () => Promise<unknown>, refusalTitle: string) {
    setBusy(key);
    setError(null);
    setRefusal(null);
    try {
      await run();
      bump();
      onChanged();
    } catch (err) {
      if (isForbidden(err)) {
        setRefusal({
          title: "Segregation of duties",
          message: errorMessage(err, "This approval was refused."),
        });
      } else {
        const status = (err as { status?: number }).status;
        if (status === 409 || status === 400) {
          setRefusal({ title: refusalTitle, message: errorMessage(err, "The platform refused this.") });
        } else {
          setError(errorMessage(err, "That action could not be completed"));
        }
      }
    } finally {
      setBusy(null);
    }
  }

  /**
   * The preview grid. A line whose inputs do not support the chosen method
   * shows "Not available" and carries the platform's reasons in a column of
   * their own — never a zero, and never a silently omitted row.
   */
  const previewColumns = useMemo<DataColumns<ForecastPreviewLine>>(
    () => [
      {
        id: "costCode",
        header: "Cost code",
        accessor: "costCode",
        type: "code",
        width: 132,
        sticky: "start",
        mono: true,
      },
      { id: "description", header: "Description", accessor: "description", type: "text", width: 260 },
      {
        id: "revisedBudget",
        header: "Revised budget",
        accessor: "revisedBudget",
        type: "currency",
        currency,
        precision: 2,
        width: 150,
        mono: true,
        aggregate: "sum",
      },
      {
        id: "jobToDateCosts",
        header: "Spent (JTD)",
        accessor: "jobToDateCosts",
        type: "currency",
        currency,
        precision: 2,
        width: 140,
        mono: true,
        aggregate: "sum",
      },
      {
        id: "storedMethod",
        header: "Stored method",
        headerTooltip: "The method the line's stored forecast was derived by.",
        accessor: "storedMethod",
        type: "enum",
        width: 160,
        aggregate: "none",
        options: FORECAST_METHODS.map<DataOption>((value) => ({
          value,
          text: FORECAST_METHOD_LABEL[value],
          label: FORECAST_METHOD_LABEL[value],
        })),
        cell: (ctx) => <MethodBadge method={ctx.row.storedMethod} />,
      },
      {
        id: "storedForecastFinal",
        header: "Stored at completion",
        accessor: "storedForecastFinal",
        type: "currency",
        currency,
        precision: 2,
        width: 160,
        mono: true,
        aggregate: "sum",
      },
      {
        id: "proposedForecastToComplete",
        header: "Proposed to complete",
        accessor: "proposedForecastToComplete",
        type: "currency",
        currency,
        precision: 2,
        width: 168,
        mono: true,
        aggregate: "none",
        cell: (ctx) => <ProposedCell row={ctx.row} value={ctx.row.proposedForecastToComplete} currency={currency} />,
      },
      {
        id: "proposedForecastFinal",
        header: "Proposed at completion",
        accessor: "proposedForecastFinal",
        type: "currency",
        currency,
        precision: 2,
        width: 172,
        mono: true,
        aggregate: "none",
        cell: (ctx) => <ProposedCell row={ctx.row} value={ctx.row.proposedForecastFinal} currency={currency} />,
      },
      {
        id: "delta",
        header: "Movement",
        headerTooltip: "Proposed forecast at completion against the figure the line stores today.",
        accessor: "delta",
        type: "currency",
        currency,
        precision: 2,
        width: 150,
        mono: true,
        aggregate: "none",
        cell: (ctx) =>
          ctx.row.delta === null ? (
            <span className="text-content-disabled">{EM_DASH}</span>
          ) : (
            <span
              className={cx(
                "tabular-nums font-medium",
                ctx.row.delta > 0
                  ? "text-danger-fg"
                  : ctx.row.delta < 0
                    ? "text-success-fg"
                    : "text-content-muted",
              )}
            >
              {money(ctx.row.delta, currency, { signed: true })}
            </span>
          ),
      },
      {
        id: "reasons",
        header: "Why it cannot be computed",
        accessor: (row: ForecastPreviewLine) => row.reasons.join(" "),
        type: "text",
        width: 340,
        aggregate: "none",
        cell: (ctx) =>
          ctx.row.reasons.length === 0 ? (
            <span className="text-content-disabled">{EM_DASH}</span>
          ) : (
            <Tooltip
              content={
                <span className="block max-w-xs space-y-1">
                  {ctx.row.reasons.map((reason, index) => (
                    <span key={index} className="block">
                      {reason}
                    </span>
                  ))}
                </span>
              }
            >
              <span className="truncate text-warning-fg">{ctx.row.reasons[0]}</span>
            </Tooltip>
          ),
      },
    ],
    [currency],
  );

  const previewActions = useCallback(
    (row: ForecastPreviewLine): ReadonlyArray<DataRowAction<ForecastPreviewLine>> => [
      {
        id: "record",
        label: "Record a forecast on this line",
        disabled: budget.status === "closed",
        onSelect: () => {
          const line = lineById.get(row.lineItemId);
          if (line) setForecastLine(line);
        },
      },
    ],
    [budget.status, lineById],
  );

  const forecastColumns = useMemo<DataColumns<ForecastRecord>>(
    () => [
      { id: "reference", header: "Ref", accessor: "reference", type: "code", width: 92, sticky: "start" },
      {
        id: "scope",
        header: "Scope",
        accessor: (row: ForecastRecord) =>
          row.lineItemId === null
            ? "Whole budget"
            : (lineById.get(row.lineItemId)?.costCode ?? row.lineItemId),
        type: "text",
        width: 160,
      },
      {
        id: "method",
        header: "Method",
        accessor: "method",
        type: "enum",
        width: 170,
        options: FORECAST_METHODS.map<DataOption>((value) => ({
          value,
          text: FORECAST_METHOD_LABEL[value],
          label: FORECAST_METHOD_LABEL[value],
        })),
        cell: (ctx) => <MethodBadge method={ctx.row.method} />,
      },
      {
        id: "status",
        header: "Status",
        accessor: "status",
        type: "status",
        width: 128,
        options: (["draft", "submitted", "approved", "superseded"] as const).map<DataOption>(
          (value) => ({
            value,
            text: labelize(value),
            label: labelize(value),
            tone: FORECAST_STATUS_TONE[value],
          }),
        ),
      },
      { id: "asOfDate", header: "As at", accessor: "asOfDate", type: "date", width: 118 },
      {
        id: "forecastToComplete",
        header: "To complete",
        accessor: "forecastToComplete",
        type: "currency",
        currency,
        precision: 0,
        width: 140,
        mono: true,
        aggregate: "none",
      },
      {
        id: "forecastFinal",
        header: "At completion",
        accessor: "forecastFinal",
        type: "currency",
        currency,
        precision: 0,
        width: 150,
        mono: true,
        aggregate: "none",
      },
      {
        id: "deltaFromPrevious",
        header: "Moved by",
        headerTooltip: "Against the previous approved position for the same scope.",
        accessor: "deltaFromPrevious",
        type: "currency",
        currency,
        precision: 0,
        width: 140,
        mono: true,
        signColor: true,
        aggregate: "none",
      },
      {
        id: "percentComplete",
        header: "% complete",
        accessor: (row: ForecastRecord) => Math.round(row.percentComplete * 1000) / 10,
        type: "percent",
        precision: 1,
        width: 116,
        aggregate: "none",
      },
      {
        id: "createdBy",
        header: "Author",
        accessor: (row: ForecastRecord) => actorName(users, row.createdBy),
        type: "text",
        width: 150,
      },
      {
        id: "approvedBy",
        header: "Approved by",
        accessor: (row: ForecastRecord) => actorName(users, row.approvedBy),
        type: "text",
        width: 150,
      },
    ],
    [currency, lineById, users],
  );

  const forecastActions = useCallback(
    (row: ForecastRecord): ReadonlyArray<DataRowAction<ForecastRecord>> => {
      const actions: Array<DataRowAction<ForecastRecord>> = [
        {
          id: "curve",
          label: "Show the spend curve",
          onSelect: () => setSelectedForecast(row),
        },
      ];
      if (row.status === "draft") {
        actions.push({
          id: "submit",
          label: "Submit for approval",
          onSelect: () =>
            void act(
              `submit:${row.id}`,
              () => api.post(`/api/v1/budget-forecasts/${row.id}/submit`, {}),
              "This forecast cannot be submitted",
            ),
        });
      }
      if (row.status === "submitted") {
        actions.push({
          id: "approve",
          label: "Approve",
          onSelect: () =>
            void (async () => {
              const ok = await confirm({
                title: `Approve ${row.reference}?`,
                description:
                  "Approving moves the line's stored forecast figure and supersedes the standing position for the same scope. The approver may be neither the author nor the submitter.",
                confirmLabel: "Approve forecast",
                tone: "warning",
              });
              if (!ok) return;
              await act(
                `approve:${row.id}`,
                () => api.post(`/api/v1/budget-forecasts/${row.id}/approve`, {}),
                "This forecast cannot be approved",
              );
            })(),
        });
      }
      return actions;
    },
    [confirm],
  );

  return (
    <div className="space-y-5">
      <ErrorAlert message={error} onDismiss={() => setError(null)} />
      {refusal ? (
        <RefusalNotice
          title={refusal.title}
          message={refusal.message}
          onDismiss={() => setRefusal(null)}
        />
      ) : null}

      <section>
        <SectionHeading
          title="What every line would be under one method"
          hint="Computed and discarded — nothing here is stored until a forecast is recorded and approved."
          actions={
            <>
              <Select
                value={method}
                onChange={(event) => setMethod(event.target.value as ForecastMethod)}
                size="sm"
                aria-label="Forecast method"
                className="min-w-52"
              >
                {FORECAST_METHODS.map((option) => (
                  <option key={option} value={option}>
                    {FORECAST_METHOD_LABEL[option]}
                  </option>
                ))}
              </Select>
              <Button
                variant="secondary"
                onClick={() => setWholeBudgetOpen(true)}
                disabled={budget.status === "closed" || budget.lineCount === 0}
              >
                Forecast the whole budget
              </Button>
            </>
          }
        />

        <Alert tone="info" variant="subtle" size="sm" title={FORECAST_METHOD_LABEL[method]}>
          {FORECAST_METHOD_HINT[method]}
        </Alert>

        {preview.error ? (
          <div className="mt-3">
            <LoadError
              message={preview.error}
              onRetry={preview.reload}
              title="The forecast preview could not be computed"
            />
          </div>
        ) : null}

        <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Figure
            label="Stored forecast at completion"
            value={money(storedFinalTotal, currency)}
            hint="What the budget holds right now, line by line, by each line's own method."
          />
          <Figure
            label={`Proposed under ${FORECAST_METHOD_LABEL[method]}`}
            value={
              proposedTotal === null ? (
                <span className="text-content-muted">
                  Not available
                  <span className="mt-1 block text-meta font-normal">
                    No line on this budget supports this method, so a total would be a fiction.
                  </span>
                </span>
              ) : (
                money(proposedTotal, currency)
              )
            }
            hint={
              preview.data
                ? `${count(preview.data.computableCount)} of ${count(preview.data.lineCount)} lines could be computed.`
                : undefined
            }
          />
          <Figure
            label="Movement"
            value={
              proposedTotal === null ? (
                <span className="text-content-muted">{EM_DASH}</span>
              ) : (
                <span
                  className={cx(
                    proposedTotal - storedFinalTotal > 0 ? "text-danger-fg" : "text-success-fg",
                  )}
                >
                  {money(proposedTotal - storedFinalTotal, currency, { signed: true })}
                </span>
              )
            }
            hint="Against the stored position."
          />
          <Figure
            label="Lines this method cannot answer"
            value={preview.data ? count(preview.data.uncomputableCount) : EM_DASH}
            hint="Each one says why, in the platform's own words."
          />
        </div>

        {previewRows.length === 0 && !preview.loading ? (
          <EmptyState
            className="mt-3"
            icon={IconInsight}
            title="No line to forecast"
            hint="This budget holds no lines, so there is nothing to compute a position for."
          />
        ) : (
          <div className="mt-3">
            <DataTable<ForecastPreviewLine>
              tableId="budget-forecast-preview"
              data={previewRows}
              columns={previewColumns}
              getRowId={(row) => row.lineItemId}
              loading={preview.loading && previewRows.length === 0}
              loadingRows={10}
              density="compact"
              stickyHeader
              gridLines
              height={460}
              savedViews={false}
              exportFileName={`${budget.reference}-forecast-${method}`}
              searchPlaceholder="Search cost code, description…"
              rowActions={previewActions}
              empty={{
                title: "No line to forecast",
                description: "This budget holds no lines.",
              }}
              aria-label={`Forecast preview under ${FORECAST_METHOD_LABEL[method]}`}
            />
          </div>
        )}
      </section>

      <section>
        <SectionHeading
          title="Recorded forecasts"
          hint="Who forecast what, by which method, and when. A forecast moves the stored figure only once somebody independent approves it."
        />
        {forecasts.error ? (
          <LoadError
            message={forecasts.error}
            onRetry={forecasts.reload}
            title="Recorded forecasts could not be loaded"
          />
        ) : null}
        <DataTable<ForecastRecord>
          tableId="budget-forecasts"
          data={forecasts.data?.items ?? []}
          columns={forecastColumns}
          getRowId={(row) => row.id}
          loading={forecasts.loading && !forecasts.data}
          density="compact"
          stickyHeader
          maxHeight={420}
          rowActions={forecastActions}
          onRowClick={({ row }) => setSelectedForecast(row)}
          exportFileName={`${budget.reference}-forecasts`}
          searchPlaceholder="Search reference, method…"
          empty={{
            title: "No forecast has been recorded",
            description:
              "Until one is, every line's forecast comes from its own stored method applied to its current inputs. Record one to put a name, a date and a basis against the number.",
          }}
          aria-label="Recorded forecasts"
        />
        {busy ? <p className="mt-2 text-meta text-content-subtle">Working…</p> : null}
      </section>

      {selectedForecast ? (
        <CurvePanel
          forecast={selectedForecast}
          currency={currency}
          scope={
            selectedForecast.lineItemId === null
              ? "the whole budget"
              : (lineById.get(selectedForecast.lineItemId)?.costCode ?? selectedForecast.lineItemId)
          }
          onClose={() => setSelectedForecast(null)}
        />
      ) : null}

      <ForecastLineModal
        open={forecastLine !== null}
        budgetId={budget.id}
        currency={currency}
        line={forecastLine}
        initialMethod={method}
        onClose={() => setForecastLine(null)}
        onSaved={() => {
          setForecastLine(null);
          bump();
          onChanged();
        }}
      />

      <ForecastLineModal
        open={wholeBudgetOpen}
        budgetId={budget.id}
        currency={currency}
        line={null}
        initialMethod={method}
        onClose={() => setWholeBudgetOpen(false)}
        onSaved={() => {
          setWholeBudgetOpen(false);
          bump();
          onChanged();
        }}
      />

      {dialog}
    </div>
  );
}

/* ========================================================================== */
/* Cells                                                                       */
/* ========================================================================== */

/**
 * A proposed figure, or the platform's refusal to invent one. A blank here
 * would read as zero, so the cell says "Not available" and carries the reasons.
 */
function ProposedCell({
  row,
  value,
  currency,
}: {
  row: ForecastPreviewLine;
  value: number | null;
  currency: string;
}) {
  if (value !== null) return <span className="tabular-nums">{money(value, currency, { precision: 2 })}</span>;
  return (
    <Tooltip
      content={
        <span className="block max-w-xs space-y-1">
          {row.reasons.map((reason, index) => (
            <span key={index} className="block">
              {reason}
            </span>
          ))}
        </span>
      }
    >
      <span>
        <Badge tone="warning" size="xs">
          Not available
        </Badge>
      </span>
    </Tooltip>
  );
}

/* ========================================================================== */
/* Curve                                                                       */
/* ========================================================================== */

function CurvePanel({
  forecast,
  currency,
  scope,
  onClose,
}: {
  forecast: ForecastRecord;
  currency: string;
  scope: string;
  onClose: () => void;
}) {
  const data = useMemo(() => {
    let running = 0;
    return forecast.curve.map((point) => {
      running = Math.round((running + point.amount) * 100) / 100;
      return { period: point.month, forecast: running };
    });
  }, [forecast.curve]);

  return (
    <section>
      <ChartCard
        title={`${forecast.reference} · spend curve`}
        subtitle={`${FORECAST_METHOD_LABEL[forecast.method]} · ${scope} · as at ${isoDate(
          forecast.asOfDate,
        )}`}
        metric={money(forecast.forecastFinal, currency)}
        metricCaption="Forecast at completion"
        actions={
          <Button size="sm" variant="ghost" onClick={onClose}>
            Close
          </Button>
        }
        footnote={`Recorded by the ${FORECAST_METHOD_LABEL[forecast.method]} method. ${
          FORECAST_METHOD_HINT[forecast.method]
        }`}
        footerMeta={
          <Badge tone={FORECAST_STATUS_TONE[forecast.status]} size="sm" dot>
            {labelize(forecast.status)}
          </Badge>
        }
      >
        <SCurveChart
          data={data}
          keys={{ period: "period", forecast: "forecast" }}
          labels={{ forecast: "Cumulative forecast spend" }}
          valueFormat="currency"
          formatOptions={{ currency }}
          height={260}
          empty={data.length === 0}
          emptyTitle="No spend curve on this forecast"
          emptyMessage="This forecast records a figure but no monthly distribution, so there is no curve to draw. Nothing is drawn at zero in its place."
          ariaLabel={`Cumulative forecast spend for ${forecast.reference}`}
        />
      </ChartCard>
      {forecast.assumptions ? (
        <Card variant="sunken" className="mt-3">
          <CardBody>
            <p className="text-label uppercase text-content-subtle">Assumptions</p>
            <p className="mt-1 whitespace-pre-wrap text-body text-content">{forecast.assumptions}</p>
          </CardBody>
        </Card>
      ) : null}
    </section>
  );
}

function Figure({
  label,
  value,
  hint,
}: {
  label: string;
  value: ReactNode;
  hint?: string | undefined;
}) {
  return (
    <Card>
      <CardBody>
        <p className="text-label uppercase text-content-subtle">{label}</p>
        <p className="mt-1 text-display-xs font-semibold tabular-nums text-content">{value}</p>
        {hint ? <p className="mt-1 text-meta text-content-muted">{hint}</p> : null}
      </CardBody>
    </Card>
  );
}
