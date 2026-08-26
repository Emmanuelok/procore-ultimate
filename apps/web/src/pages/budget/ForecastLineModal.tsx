/**
 * Record a forecast — for one line, or for the whole budget.
 *
 * The screen exists to make one distinction impossible to miss: the COMPUTED
 * DEFAULT (what the chosen method derives from the figures the platform
 * already holds) sits beside WHAT YOU ARE RECORDING, and the method travels
 * with the number from here all the way to the grid. A forecast whose inputs
 * are missing is refused by the API with its reasons rather than rounded down
 * to a plausible-looking zero, and those reasons are shown verbatim.
 */
import { useEffect, useMemo, useState } from "react";
import { FORECAST_METHODS, type ForecastMethod } from "@constructos/shared";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  Checkbox,
  ErrorAlert,
  Field,
  Modal,
  Select,
  Textarea,
  cx,
} from "../../ui";
import { DatePicker, NumberInput } from "../../ui/inputs";
import { api } from "../../lib/api";
import { MoneyField } from "./moneyInput";
import {
  EM_DASH,
  FORECAST_METHOD_HINT,
  FORECAST_METHOD_LABEL,
  MethodBadge,
  ReasonList,
  errorMessage,
  errorReasons,
  isoDate,
  money,
  percent,
  today,
  type BudgetLine,
  type CurvePoint,
  type ForecastPreview,
  type ForecastRecord,
} from "./budgetShared";

const toIsoDate = (date: Date | null): string | null => {
  if (!date) return null;
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const fromIsoDate = (value: string | null): Date | null =>
  value ? new Date(`${value}T00:00:00`) : null;

const round2 = (n: number): number => Math.round(n * 100) / 100;

function monthsFrom(start: string, n: number): string[] {
  const [yearRaw, monthRaw] = start.split("-");
  let year = Number(yearRaw);
  let month = Number(monthRaw);
  if (!Number.isFinite(year) || !Number.isFinite(month)) return [];
  const out: string[] = [];
  for (let i = 0; i < n; i += 1) {
    out.push(`${year}-${String(month).padStart(2, "0")}`);
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return out;
}

export interface ForecastLineModalProps {
  open: boolean;
  budgetId: string;
  currency: string;
  /** null records a whole-budget forecast */
  line: BudgetLine | null;
  /** Method to open on. Defaults to the line's own recorded method. */
  initialMethod?: ForecastMethod;
  onClose: () => void;
  onSaved: (forecast: ForecastRecord) => void;
}

export default function ForecastLineModal({
  open,
  budgetId,
  currency,
  line,
  initialMethod,
  onClose,
  onSaved,
}: ForecastLineModalProps) {
  const [method, setMethod] = useState<ForecastMethod>("manual");
  const [manualFtc, setManualFtc] = useState<number | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [asOf, setAsOf] = useState<Date | null>(() => fromIsoDate(today()));
  const [assumptions, setAssumptions] = useState("");
  const [notes, setNotes] = useState("");
  const [spread, setSpread] = useState(false);
  const [spreadMonths, setSpreadMonths] = useState<number | null>(6);
  const [spreadStart, setSpreadStart] = useState(() => today().slice(0, 7));

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refusalReasons, setRefusalReasons] = useState<string[]>([]);

  const [preview, setPreview] = useState<ForecastPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    setMethod(initialMethod ?? (line ? line.forecastMethod : "remaining_budget"));
    setManualFtc(line ? line.forecastToComplete : null);
    setProgress(line ? round2(line.percentComplete * 100) : null);
    setAsOf(fromIsoDate(today()));
    setAssumptions("");
    setNotes("");
    setSpread(false);
    setSpreadMonths(6);
    setSpreadStart(today().slice(0, 7));
    setError(null);
    setRefusalReasons([]);
  }, [open, line, initialMethod]);

  useEffect(() => {
    if (!open || !line) {
      setPreview(null);
      setPreviewError(null);
      return;
    }
    const controller = new AbortController();
    setPreviewLoading(true);
    setPreviewError(null);
    api
      .get<ForecastPreview>(
        `/api/v1/budgets/${budgetId}/forecast-preview?method=${method}&lineItemId=${line.id}`,
        { signal: controller.signal },
      )
      .then((result) => {
        setPreview(result);
        setPreviewLoading(false);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setPreview(null);
        setPreviewError(errorMessage(err, "The computed default could not be read"));
        setPreviewLoading(false);
      });
    return () => controller.abort();
  }, [open, line, budgetId, method]);

  const previewLine = preview?.lines[0] ?? null;

  /** The figure that will actually be stored: typed for manual, derived otherwise. */
  const effectiveFtc = useMemo<number | null>(() => {
    if (method === "manual") return manualFtc;
    return previewLine?.proposedForecastToComplete ?? null;
  }, [method, manualFtc, previewLine]);

  const curve = useMemo<CurvePoint[]>(() => {
    if (!spread || effectiveFtc === null || effectiveFtc <= 0) return [];
    const n = Math.max(1, Math.min(240, Math.trunc(spreadMonths ?? 0)));
    const months = monthsFrom(spreadStart, n);
    if (months.length === 0) return [];
    const each = round2(effectiveFtc / months.length);
    const points = months.map((month) => ({ month, amount: each }));
    // The last month absorbs the rounding so the curve sums to the forecast.
    const drift = round2(effectiveFtc - each * months.length);
    const last = points[points.length - 1];
    if (last && drift !== 0) last.amount = round2(last.amount + drift);
    return points;
  }, [spread, effectiveFtc, spreadMonths, spreadStart]);

  const manualMissing = method === "manual" && (manualFtc === null || manualFtc < 0);

  async function submit() {
    if (manualMissing) {
      setError(
        "Method 'manual' requires an explicit forecast to complete — a manual forecast with no typed figure is not a forecast.",
      );
      return;
    }
    setSaving(true);
    setError(null);
    setRefusalReasons([]);
    try {
      const body: Record<string, unknown> = {
        method,
        asOfDate: toIsoDate(asOf) ?? today(),
      };
      if (line) body["lineItemId"] = line.id;
      if (method === "manual" && manualFtc !== null) body["forecastToComplete"] = manualFtc;
      if (progress !== null) body["percentComplete"] = Math.min(1, Math.max(0, progress / 100));
      if (curve.length > 0) body["curve"] = curve;
      if (assumptions.trim() !== "") body["assumptions"] = assumptions.trim();
      if (notes.trim() !== "") body["notes"] = notes.trim();
      const created = await api.post<ForecastRecord>(`/api/v1/budgets/${budgetId}/forecasts`, body);
      onSaved(created);
    } catch (err) {
      setError(errorMessage(err, "The forecast could not be recorded"));
      setRefusalReasons(errorReasons(err));
    } finally {
      setSaving(false);
    }
  }

  const storedFinal = line ? line.forecastFinal : null;
  const proposedFinal =
    method === "manual"
      ? manualFtc !== null && line
        ? round2(line.jobToDateCosts + manualFtc)
        : null
      : (previewLine?.proposedForecastFinal ?? null);

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="xl"
      title={line ? `Forecast ${line.costCode}` : "Forecast this budget"}
      description={
        line
          ? line.description
          : "A whole-budget forecast aggregates every line into one position; the method is recorded against it just the same."
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} loading={saving} disabled={manualMissing}>
            Record forecast
          </Button>
        </>
      }
    >
      <ErrorAlert message={error} />
      {refusalReasons.length > 0 ? (
        <Alert tone="warning" title="The platform refused to store this forecast">
          <p>
            A forecast whose inputs are missing is refused rather than rounded down to a
            plausible-looking zero. The reasons are the platform's own:
          </p>
          <ReasonList reasons={refusalReasons} className="mt-2" />
        </Alert>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-3">
          <Field
            label="Method"
            hint="Recorded with the figure, and displayed everywhere the figure appears."
          >
            <Select value={method} onChange={(event) => setMethod(event.target.value as ForecastMethod)}>
              {FORECAST_METHODS.map((option) => (
                <option key={option} value={option}>
                  {FORECAST_METHOD_LABEL[option]}
                </option>
              ))}
            </Select>
          </Field>

          <Alert tone="info" variant="subtle" size="sm" title={FORECAST_METHOD_LABEL[method]}>
            {FORECAST_METHOD_HINT[method]}
          </Alert>

          {method === "manual" ? (
            <Field
              label="Forecast to complete"
              required
              hint="The estimator's own figure. Nothing is derived from it."
              error={manualMissing ? "A manual forecast needs a typed figure of zero or more." : null}
            >
              <MoneyField
                value={manualFtc}
                onChange={setManualFtc}
                currency={currency}
                aria-label="Forecast to complete"
              />
            </Field>
          ) : (
            <Alert tone="neutral" variant="outline" size="sm">
              This method derives the figure from what the platform already holds, so there is
              nothing to type. Switch to <strong>Manual</strong> to record a judgement instead.
            </Alert>
          )}

          <Field
            label="Percent complete"
            optional
            hint="Overrides the line's stored progress for this computation only."
          >
            <NumberInput
              value={progress}
              onChange={setProgress}
              min={0}
              max={100}
              step={1}
              precision={2}
              suffix="%"
              aria-label="Percent complete"
            />
          </Field>

          <Field label="As at">
            <DatePicker value={asOf} onChange={setAsOf} aria-label="Forecast as-at date" />
          </Field>
        </div>

        <div className="space-y-3">
          <Card variant="sunken">
            <CardBody>
              <h3 className="text-label uppercase text-content-subtle">
                Computed default for {FORECAST_METHOD_LABEL[method]}
              </h3>
              {!line ? (
                <p className="mt-2 text-meta text-content-muted">
                  A per-line default is only meaningful on a line. For the whole budget the API
                  aggregates every line into one position and applies the method to that.
                </p>
              ) : previewLoading ? (
                <p className="mt-2 text-meta text-content-muted">Computing…</p>
              ) : previewError ? (
                <p className="mt-2 text-meta text-danger-fg">{previewError}</p>
              ) : previewLine === null ? (
                <p className="mt-2 text-meta text-content-muted">No preview available.</p>
              ) : previewLine.proposedForecastToComplete === null ? (
                <div className="mt-2">
                  <p className="text-body font-medium text-content-muted">Not available</p>
                  <p className="mt-1 text-meta text-content-muted">
                    This method cannot be computed from what the platform holds for this line:
                  </p>
                  <ReasonList reasons={previewLine.reasons} className="mt-1" />
                </div>
              ) : (
                <dl className="mt-2 space-y-1.5">
                  <Row
                    label="Forecast to complete"
                    value={money(previewLine.proposedForecastToComplete, currency)}
                  />
                  <Row
                    label="Forecast at completion"
                    value={money(previewLine.proposedForecastFinal, currency)}
                  />
                  <Row
                    label="Movement vs stored"
                    value={money(previewLine.delta, currency, { signed: true })}
                    tone={
                      previewLine.delta === null
                        ? undefined
                        : previewLine.delta > 0
                          ? "text-danger-fg"
                          : previewLine.delta < 0
                            ? "text-success-fg"
                            : undefined
                    }
                  />
                </dl>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardBody>
              <h3 className="text-label uppercase text-content-subtle">What will be recorded</h3>
              <div className="mt-2 flex items-center gap-2">
                <MethodBadge method={method} size="sm" />
                {method === "manual" ? (
                  <Badge tone="highlight" size="xs" variant="subtle">
                    Typed by a person
                  </Badge>
                ) : (
                  <Badge tone="info" size="xs" variant="subtle">
                    Derived by formula
                  </Badge>
                )}
              </div>
              <dl className="mt-2 space-y-1.5">
                <Row
                  label="Forecast to complete"
                  value={effectiveFtc === null ? EM_DASH : money(effectiveFtc, currency)}
                />
                <Row
                  label="Forecast at completion"
                  value={proposedFinal === null ? EM_DASH : money(proposedFinal, currency)}
                />
                {line ? (
                  <Row
                    label="Currently stored"
                    value={`${money(storedFinal, currency)} · ${FORECAST_METHOD_LABEL[line.forecastMethod]}`}
                  />
                ) : null}
                {line ? <Row label="Reported progress" value={percent(line.percentComplete)} /> : null}
              </dl>
              <p className="mt-2 text-meta text-content-subtle">
                Recorded as a draft. It moves the line's stored figure only once somebody other
                than its author approves it.
              </p>
            </CardBody>
          </Card>
        </div>
      </div>

      <div className="mt-4 space-y-3">
        <Checkbox
          checked={spread}
          onChange={(event) => setSpread(event.target.checked)}
          label="Spread the remaining cost over a monthly curve"
          description="Stored with the forecast and drawn as a cumulative spend curve."
        />
        {spread ? (
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Starting month" hint="YYYY-MM">
              <input
                value={spreadStart}
                onChange={(event) => setSpreadStart(event.target.value)}
                type="month"
                className="block h-control w-full rounded-md border border-border bg-surface-raised px-3 text-body text-content"
              />
            </Field>
            <Field label="Months">
              <NumberInput
                value={spreadMonths}
                onChange={setSpreadMonths}
                min={1}
                max={240}
                step={1}
                aria-label="Months"
              />
            </Field>
            <Field label="Per month" hint="The final month absorbs the rounding.">
              <p className="pt-2 text-body tabular-nums text-content">
                {curve.length > 0 && curve[0]
                  ? money(curve[0].amount, currency)
                  : "Nothing to spread yet"}
              </p>
            </Field>
          </div>
        ) : null}

        <Field label="Assumptions" optional hint="The “why” behind the figure — read at every review.">
          <Textarea
            value={assumptions}
            onChange={(event) => setAssumptions(event.target.value)}
            rows={2}
          />
        </Field>
        <Field label="Notes" optional>
          <Textarea value={notes} onChange={(event) => setNotes(event.target.value)} rows={2} />
        </Field>
        {line ? (
          <p className="text-meta text-content-subtle">
            Line {line.costCode} · revised budget {money(line.revisedBudget, currency)} · job to date{" "}
            {money(line.jobToDateCosts, currency)} · as at {isoDate(toIsoDate(asOf))}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}

function Row({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: string | undefined;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-meta text-content-muted">{label}</dt>
      <dd className={cx("text-body font-medium tabular-nums text-content", tone)}>{value}</dd>
    </div>
  );
}
