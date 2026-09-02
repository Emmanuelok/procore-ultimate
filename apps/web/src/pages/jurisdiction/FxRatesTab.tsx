/**
 * FX rate register and converter — spec Vol II Domain K / M19 (#597-598).
 *
 * Every rate is dated, attributed to a source and immutable once recorded,
 * because a rate-of-exchange dispute is won on the audit trail rather than on
 * the number. The converter exists to make that trail visible: it reports not
 * only the converted amount but HOW the rate was arrived at — a direct quote,
 * the reciprocal of the opposite quote, or a triangulation through a
 * configured base currency — and says so plainly when no path exists at all.
 */
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { FX_RATE_SOURCES } from "@constructos/shared";
import { api, ApiClientError } from "../../lib/api";
import {
  Badge,
  Button,
  Card,
  CardBody,
  EmptyState,
  ErrorAlert,
  Field,
  Input,
  Modal,
  Select,
  Spinner,
  Table,
  Td,
  Th,
} from "../../ui";
import { formatDate } from "../format";
import {
  FX_SOURCE_DESCRIPTIONS,
  FX_SOURCE_LABELS,
  PATH_DESCRIPTIONS,
  PATH_LABELS,
  errorMessage,
  fmtMoney,
  fmtRate,
  fxSourceTone,
  todayISO,
  type ConvertResponse,
  type FxRateRow,
  type ListResponse,
} from "./jurisdictionShared";

export default function FxRatesTab({ projectId }: { projectId: string }) {
  const [rates, setRates] = useState<FxRateRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /* filters */
  const [qFrom, setQFrom] = useState("");
  const [qTo, setQTo] = useState("");
  const [qSource, setQSource] = useState("");

  const load = useCallback(async () => {
    setError(null);
    const params = new URLSearchParams({ pageSize: "200" });
    if (qFrom.trim().length === 3) params.set("from", qFrom.trim().toUpperCase());
    if (qTo.trim().length === 3) params.set("to", qTo.trim().toUpperCase());
    if (qSource) params.set("source", qSource);
    try {
      const res = await api.get<ListResponse<FxRateRow>>(`/api/v1/fx-rates?${params.toString()}`);
      setRates(res.items);
      setTotal(res.total);
    } catch (err) {
      setRates((prev) => prev ?? []);
      setError(errorMessage(err, "Failed to load the FX rate register"));
    }
  }, [qFrom, qTo, qSource]);

  useEffect(() => {
    void load();
  }, [load]);

  /* ------------------------------ add modal ------------------------------- */

  const [open, setOpen] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [fFrom, setFFrom] = useState("");
  const [fTo, setFTo] = useState("");
  const [fRate, setFRate] = useState("");
  const [fDate, setFDate] = useState(todayISO);
  const [fSource, setFSource] = useState<string>("central_bank");
  const [fReference, setFReference] = useState("");

  function openAdd() {
    setFormError(null);
    setFFrom("");
    setFTo("");
    setFRate("");
    setFDate(todayISO());
    setFSource("central_bank");
    setFReference("");
    setOpen(true);
  }

  async function onAdd(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    setBusy(true);
    try {
      const payload: Record<string, unknown> = {
        fromCurrency: fFrom.trim().toUpperCase(),
        toCurrency: fTo.trim().toUpperCase(),
        rate: Number(fRate),
        rateDate: fDate,
        source: fSource,
      };
      if (fReference.trim()) payload["sourceReference"] = fReference.trim();
      await api.post<FxRateRow>("/api/v1/fx-rates", payload);
      setOpen(false);
      await load();
    } catch (err) {
      // 409 is the interesting one: the register refuses to restate a rate that
      // is already on file for that pair, date and source.
      setFormError(
        err instanceof ApiClientError ? err.message : "Failed to record the rate.",
      );
    } finally {
      setBusy(false);
    }
  }

  /* ------------------------------ converter ------------------------------- */

  const [cAmount, setCAmount] = useState("");
  const [cFrom, setCFrom] = useState("");
  const [cTo, setCTo] = useState("");
  const [cAsOf, setCAsOf] = useState(todayISO);
  const [conversion, setConversion] = useState<ConvertResponse | null>(null);
  /** the 404 "no rate path" case, surfaced as guidance rather than an error */
  const [noPath, setNoPath] = useState<string | null>(null);
  const [convertError, setConvertError] = useState<string | null>(null);
  const [converting, setConverting] = useState(false);

  async function onConvert(e: FormEvent) {
    e.preventDefault();
    setConversion(null);
    setNoPath(null);
    setConvertError(null);
    setConverting(true);
    try {
      const res = await api.post<ConvertResponse>(
        `/api/v1/projects/${projectId}/fx/convert`,
        {
          amount: Number(cAmount),
          fromCurrency: cFrom.trim().toUpperCase(),
          toCurrency: cTo.trim().toUpperCase(),
          asOf: cAsOf,
        },
      );
      setConversion(res);
    } catch (err) {
      if (err instanceof ApiClientError && err.status === 404) {
        setNoPath(err.message);
      } else {
        setConvertError(errorMessage(err, "Conversion failed"));
      }
    } finally {
      setConverting(false);
    }
  }

  /* -------------------------------- render -------------------------------- */

  const items = rates ?? [];

  return (
    <div>
      <ErrorAlert message={error} />

      {/* ------------------------------ converter ---------------------------- */}
      <Card className="mb-5">
        <CardBody>
          <h3 className="text-sm font-semibold text-ink-900">Quick converter</h3>
          <p className="mb-3 mt-0.5 text-xs text-ink-400">
            Resolves the rate in force on the as-of date and reports the path it took: a direct
            quote first, then the reciprocal, then a triangulation through one of the project's
            configured base currencies.
          </p>

          <form onSubmit={onConvert} className="grid grid-cols-2 gap-3 sm:grid-cols-5">
            <Field label="Amount">
              <Input
                type="number"
                step="any"
                required
                value={cAmount}
                onChange={(e) => setCAmount(e.target.value)}
                placeholder="100000"
              />
            </Field>
            <Field label="From">
              <Input
                required
                maxLength={3}
                value={cFrom}
                onChange={(e) => setCFrom(e.target.value.toUpperCase())}
                placeholder="USD"
                className="uppercase"
              />
            </Field>
            <Field label="To">
              <Input
                required
                maxLength={3}
                value={cTo}
                onChange={(e) => setCTo(e.target.value.toUpperCase())}
                placeholder="EUR"
                className="uppercase"
              />
            </Field>
            <Field label="As of">
              <Input type="date" value={cAsOf} onChange={(e) => setCAsOf(e.target.value)} />
            </Field>
            <div className="flex items-end">
              <Button type="submit" disabled={converting}>
                {converting ? "Converting…" : "Convert"}
              </Button>
            </div>
          </form>

          <div className="mt-3">
            <ErrorAlert message={convertError} />
          </div>

          {noPath ? (
            <div className="mt-3 rounded-md bg-amber-50 px-3 py-2.5 text-sm text-amber-900 ring-1 ring-amber-200">
              <p className="font-medium">No rate path available</p>
              <p className="mt-1 text-xs leading-relaxed">{noPath}</p>
              <p className="mt-1.5 text-xs leading-relaxed">
                Record either leg below and the converter will find it: the direct quote, the
                opposite quote (the reciprocal is used automatically), or both legs through a
                currency that a configuration on this project already uses as its base.
              </p>
            </div>
          ) : null}

          {conversion ? (
            <div className="mt-3 rounded-md bg-brand-50 px-4 py-3 ring-1 ring-brand-100">
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="text-sm text-ink-600 tabular-nums">
                  {fmtMoney(conversion.amount, conversion.fromCurrency)}
                </span>
                <span className="text-ink-400" aria-hidden>
                  →
                </span>
                <span className="text-2xl font-semibold tabular-nums text-brand-800">
                  {fmtMoney(conversion.converted, conversion.toCurrency)}
                </span>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-600">
                <span className="tabular-nums">
                  1 {conversion.fromCurrency} = {fmtRate(conversion.rate)} {conversion.toCurrency}
                </span>
                <span aria-hidden className="text-ink-300">
                  ·
                </span>
                <span title={PATH_DESCRIPTIONS[conversion.path]} className="cursor-help">
                  <Badge tone={conversion.path === "triangulated" ? "amber" : "blue"}>
                    {PATH_LABELS[conversion.path]}
                    {conversion.via ? ` via ${conversion.via}` : ""}
                  </Badge>
                </span>
                <span aria-hidden className="text-ink-300">
                  ·
                </span>
                <span>
                  quote dated{" "}
                  <span className="tabular-nums">
                    {conversion.rateDate ? formatDate(conversion.rateDate) : "n/a"}
                  </span>
                </span>
                <span aria-hidden className="text-ink-300">
                  ·
                </span>
                <span>as at {formatDate(conversion.asOf)}</span>
              </div>

              {conversion.legs.length > 0 ? (
                <ul className="mt-2 space-y-0.5 text-[11px] text-ink-500">
                  {conversion.legs.map((leg, i) => (
                    <li key={`${leg.fromCurrency}${leg.toCurrency}${leg.rateDate}${i}`}>
                      <span className="tabular-nums">
                        {leg.fromCurrency}/{leg.toCurrency} @ {fmtRate(leg.rate)}
                      </span>{" "}
                      — {FX_SOURCE_LABELS[leg.source] ?? leg.source}, {formatDate(leg.rateDate)}
                    </li>
                  ))}
                </ul>
              ) : null}

              {conversion.path === "triangulated" ? (
                <p className="mt-2 text-[11px] leading-relaxed text-amber-800">
                  A triangulated rate is only as fresh as its stalest leg; the date shown is that
                  earlier leg. For a certificate, record the direct quote.
                </p>
              ) : null}
            </div>
          ) : null}
        </CardBody>
      </Card>

      {/* ------------------------------- register ---------------------------- */}
      <div className="mb-2 flex flex-wrap items-end justify-between gap-2">
        <h3 className="text-sm font-semibold text-ink-900">
          Rate register{" "}
          <span className="font-normal text-ink-400">
            — {total} quote{total === 1 ? "" : "s"} on file
          </span>
        </h3>
        <div className="flex flex-wrap items-end gap-2">
          <Input
            maxLength={3}
            value={qFrom}
            onChange={(e) => setQFrom(e.target.value.toUpperCase())}
            placeholder="From"
            aria-label="Filter by from-currency"
            className="w-24 uppercase"
          />
          <Input
            maxLength={3}
            value={qTo}
            onChange={(e) => setQTo(e.target.value.toUpperCase())}
            placeholder="To"
            aria-label="Filter by to-currency"
            className="w-24 uppercase"
          />
          <Select
            value={qSource}
            onChange={(e) => setQSource(e.target.value)}
            aria-label="Filter by source"
            className="w-40"
          >
            <option value="">All sources</option>
            {FX_RATE_SOURCES.map((s) => (
              <option key={s} value={s}>
                {FX_SOURCE_LABELS[s] ?? s}
              </option>
            ))}
          </Select>
          <Button size="sm" onClick={openAdd}>
            Record rate
          </Button>
        </div>
      </div>

      {rates === null && !error ? (
        <Spinner label="Loading rates…" />
      ) : items.length === 0 ? (
        <EmptyState
          title="No rates recorded"
          hint="A rate with no date and no attribution is an assertion. Record the pair, the rate, the date it applies from and where it came from — that record is what a rate-of-exchange dispute turns on."
          action={<Button onClick={openAdd}>Record the first rate</Button>}
        />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Pair</Th>
              <Th className="text-right">Rate</Th>
              <Th>Date</Th>
              <Th>Source</Th>
              <Th>Reference</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {items.map((r) => (
              <tr key={r.id} className="hover:bg-ink-50/60">
                <Td className="whitespace-nowrap font-medium text-ink-900">
                  {r.fromCurrency}/{r.toCurrency}
                </Td>
                <Td
                  className="whitespace-nowrap text-right tabular-nums text-ink-900"
                  title={`1 ${r.fromCurrency} buys ${fmtRate(r.rate)} ${r.toCurrency}`}
                >
                  {fmtRate(r.rate)}
                </Td>
                <Td className="whitespace-nowrap text-xs text-ink-500">{formatDate(r.rateDate)}</Td>
                <Td>
                  <span title={FX_SOURCE_DESCRIPTIONS[r.source]}>
                    <Badge tone={fxSourceTone(r.source)}>
                      {FX_SOURCE_LABELS[r.source] ?? r.source}
                    </Badge>
                  </span>
                </Td>
                <Td className="text-xs text-ink-600">
                  {r.sourceReference ?? (
                    <span
                      className="text-amber-700"
                      title="No provenance recorded — the quote cannot be traced back to a publication."
                    >
                      not recorded
                    </span>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      {items.length > 0 ? (
        <p className="mt-1.5 text-[11px] text-ink-400">
          Rates are company reference data and are immutable once recorded — a correction is a new
          quote, not an edit. The rate in force on any date is the most recent quote on or before it.
        </p>
      ) : null}

      {/* ------------------------------- add modal --------------------------- */}
      <Modal open={open} title="Record an FX rate" onClose={() => setOpen(false)}>
        <ErrorAlert message={formError} />
        <form onSubmit={onAdd} className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field label="From">
              <Input
                required
                maxLength={3}
                value={fFrom}
                onChange={(e) => setFFrom(e.target.value.toUpperCase())}
                placeholder="USD"
                className="uppercase"
              />
            </Field>
            <Field label="To">
              <Input
                required
                maxLength={3}
                value={fTo}
                onChange={(e) => setFTo(e.target.value.toUpperCase())}
                placeholder="EUR"
                className="uppercase"
              />
            </Field>
            <Field label="Rate" hint={`units of ${fTo || "to"} per 1 ${fFrom || "from"}`}>
              <Input
                type="number"
                min="0"
                step="any"
                required
                value={fRate}
                onChange={(e) => setFRate(e.target.value)}
                placeholder="0.92"
              />
            </Field>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Rate date" hint="The date the quote applies from.">
              <Input
                type="date"
                required
                value={fDate}
                onChange={(e) => setFDate(e.target.value)}
              />
            </Field>
            <Field label="Source" hint={FX_SOURCE_DESCRIPTIONS[fSource]}>
              <Select value={fSource} onChange={(e) => setFSource(e.target.value)}>
                {FX_RATE_SOURCES.map((s) => (
                  <option key={s} value={s}>
                    {FX_SOURCE_LABELS[s] ?? s}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          <Field
            label="Source reference"
            hint="Where this rate was published — the bulletin, page or dealing ticket. This is the provenance a dispute rests on."
          >
            <Input
              value={fReference}
              onChange={(e) => setFReference(e.target.value)}
              placeholder="e.g. ECB reference rates, 2026-03-14"
            />
          </Field>

          {fFrom && fTo && fFrom === fTo ? (
            <p className="text-xs font-medium text-amber-700">
              The two currencies must differ — an identity rate is not recorded.
            </p>
          ) : null}

          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || (!!fFrom && fFrom === fTo)}>
              {busy ? "Recording…" : "Record rate"}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
