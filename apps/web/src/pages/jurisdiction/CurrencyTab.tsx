/**
 * Contractual currency configuration, payment splitting and the FX gain/loss
 * statement — spec Vol II Domain K / M19 (#593-596, #599).
 *
 * A contract that pays in more than one currency fixes, at its base date, the
 * share of every payment settled in each currency and the rate applied to that
 * share (FIDIC Sub-Clause 14.15). Three things follow, and this tab is those
 * three things:
 *
 *  · the configuration itself — proportions that must exhaust the payment;
 *  · the split of a given payment across those proportions, valued both at the
 *    contractual rates and at today's market (#596);
 *  · the drift between the two, which is the FX position the project is
 *    carrying whether or not anyone has booked it (#599).
 */
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { FX_RATE_SOURCES } from "@constructos/shared";
import { api } from "../../lib/api";
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
  Textarea,
  Th,
} from "../../ui";
import { formatDate } from "../format";
import {
  Caveat,
  DetailRow,
  FX_SOURCE_DESCRIPTIONS,
  FX_SOURCE_LABELS,
  StatCard,
  errorMessage,
  fmtMoney,
  fmtNum,
  fmtPct,
  fmtRate,
  fmtSignedMoney,
  fxSourceTone,
  todayISO,
  varianceClass,
  type ContractPickRow,
  type CurrencyConfigRow,
  type ExposureResponse,
  type ListResponse,
  type Portion,
  type SplitResponse,
} from "./jurisdictionShared";

/** The server's tolerance, mirrored so the form agrees with the validator. */
const PORTION_SUM_TOLERANCE = 0.01;

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

const EXPOSURE_TOOLTIP =
  "Both sides are stated in the configuration's BASE currency: what the covered portions were " +
  "meant to cost under the contractual rates, against what buying the same contractual foreign " +
  "entitlements costs at the as-of market. A positive variance means the contractual position is " +
  "expensive against spot.";

interface PortionDraft {
  currency: string;
  proportionPercent: string;
  baseRate: string;
}

const emptyPortion = (): PortionDraft => ({ currency: "", proportionPercent: "", baseRate: "" });

/* ========================= Portion sum indicator ========================== */

function PortionSum({ portions }: { portions: PortionDraft[] }) {
  const sum = round4(
    portions.reduce((s, p) => {
      const n = Number(p.proportionPercent);
      return s + (Number.isFinite(n) ? n : 0);
    }, 0),
  );
  const delta = round4(100 - sum);
  const exact = Math.abs(sum - 100) <= PORTION_SUM_TOLERANCE;
  return (
    <div
      className={`flex flex-wrap items-baseline justify-between gap-2 rounded-md px-3 py-2 text-sm ring-1 ${
        exact
          ? "bg-emerald-50 text-emerald-800 ring-emerald-200"
          : "bg-amber-50 text-amber-900 ring-amber-200"
      }`}
    >
      <span className="font-medium">
        {exact ? "✓ Proportions total 100%" : "Proportions must total 100%"}
      </span>
      <span className="tabular-nums">
        {fmtPct(sum, 4)}
        {exact ? null : (
          <span className="ml-2 font-medium">
            {delta > 0 ? `${fmtPct(delta, 4)} short` : `${fmtPct(Math.abs(delta), 4)} over`}
          </span>
        )}
      </span>
    </div>
  );
}

/* ============================== Config card =============================== */

function ConfigCard({
  config,
  contractName,
  onSplit,
  selected,
}: {
  config: CurrencyConfigRow;
  contractName: string | null;
  onSplit: () => void;
  selected: boolean;
}) {
  const portions = config.portions ?? [];
  const sum = round4(portions.reduce((s, p) => s + p.proportionPercent, 0));
  return (
    <Card className={selected ? "ring-2 ring-brand-200" : undefined}>
      <CardBody>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-lg font-semibold tabular-nums text-ink-900">
                {config.baseCurrency}
              </span>
              <Badge tone={fxSourceTone(config.rateSource)}>
                {FX_SOURCE_LABELS[config.rateSource] ?? config.rateSource}
              </Badge>
            </div>
            <p className="mt-0.5 truncate text-xs text-ink-500">
              {contractName ? (
                <>Contract: {contractName}</>
              ) : config.contractId ? (
                <>Contract {config.contractId}</>
              ) : (
                <span className="text-amber-700">
                  No contract linked — cannot be valued against a sum
                </span>
              )}
            </p>
          </div>
          <Button size="sm" variant="secondary" onClick={onSplit}>
            Split a payment
          </Button>
        </div>

        <div className="mt-3 flex flex-wrap gap-1.5">
          {portions.map((p) => (
            <span
              key={p.currency}
              className="inline-flex items-baseline gap-1.5 rounded-full bg-brand-50 px-2.5 py-1 text-xs text-brand-900 ring-1 ring-brand-100"
              title={`${fmtPct(p.proportionPercent, 4)} of every payment is settled in ${p.currency}, at the base-date rate of ${fmtRate(p.baseRate)} ${p.currency} per 1 ${config.baseCurrency}.`}
            >
              <span className="font-semibold">{p.currency}</span>
              <span className="tabular-nums">{fmtPct(p.proportionPercent, 4)}</span>
              <span className="text-brand-400">@ {fmtRate(p.baseRate)}</span>
            </span>
          ))}
          {portions.length === 0 ? (
            <span className="text-xs text-ink-400">No portions recorded</span>
          ) : null}
        </div>

        <div className="mt-3 border-t border-ink-100 pt-2">
          <DetailRow label="Base date">
            <span className="tabular-nums">{formatDate(config.baseDate)}</span>
            <span className="ml-2 text-xs text-ink-400">
              the date the contractual rates were struck
            </span>
          </DetailRow>
          <DetailRow label="Portions total">
            <span
              className={`tabular-nums ${
                Math.abs(sum - 100) <= PORTION_SUM_TOLERANCE ? "text-emerald-700" : "text-red-700"
              }`}
            >
              {fmtPct(sum, 4)}
            </span>
          </DetailRow>
          {config.notes ? (
            <DetailRow label="Notes">
              <span className="whitespace-pre-wrap text-xs text-ink-600">{config.notes}</span>
            </DetailRow>
          ) : null}
        </div>
      </CardBody>
    </Card>
  );
}

/* ================================== Tab =================================== */

export default function CurrencyTab({ projectId }: { projectId: string }) {
  const base = `/api/v1/projects/${projectId}`;

  const [configs, setConfigs] = useState<CurrencyConfigRow[] | null>(null);
  const [contracts, setContracts] = useState<ContractPickRow[]>([]);
  const [exposure, setExposure] = useState<ExposureResponse | null>(null);
  const [exposureError, setExposureError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [asOf, setAsOf] = useState(todayISO);
  const [busy, setBusy] = useState(false);

  const contractName = useMemo(() => {
    const byId = new Map(contracts.map((c) => [c.id, c.name] as const));
    return (id: string | null) => (id ? (byId.get(id) ?? null) : null);
  }, [contracts]);

  const load = useCallback(async () => {
    setError(null);
    try {
      const list = await api.get<ListResponse<CurrencyConfigRow>>(
        `${base}/currency-configs?pageSize=200`,
      );
      setConfigs(list.items);
    } catch (err) {
      setConfigs((prev) => prev ?? []);
      setError(errorMessage(err, "Failed to load the currency configurations"));
    }
    try {
      const cs = await api.get<ListResponse<ContractPickRow>>(`${base}/contracts?pageSize=200`);
      setContracts(cs.items);
    } catch {
      // the contract picker is a convenience; its absence must not block the tab
      setContracts([]);
    }
  }, [base]);

  const loadExposure = useCallback(async () => {
    setExposureError(null);
    try {
      setExposure(await api.get<ExposureResponse>(`${base}/fx/exposure?asOf=${asOf}`));
    } catch (err) {
      setExposure(null);
      setExposureError(errorMessage(err, "Failed to compute the FX exposure"));
    }
  }, [base, asOf]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void loadExposure();
  }, [loadExposure]);

  /* ----------------------------- create modal ----------------------------- */

  const [open, setOpen] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [fContract, setFContract] = useState("");
  const [fBaseCurrency, setFBaseCurrency] = useState("");
  const [fBaseDate, setFBaseDate] = useState(todayISO);
  const [fSource, setFSource] = useState<string>("contractual");
  const [fNotes, setFNotes] = useState("");
  const [fPortions, setFPortions] = useState<PortionDraft[]>([emptyPortion(), emptyPortion()]);

  function openCreate() {
    setFormError(null);
    setFContract("");
    setFBaseCurrency("");
    setFBaseDate(todayISO());
    setFSource("contractual");
    setFNotes("");
    setFPortions([emptyPortion(), emptyPortion()]);
    setOpen(true);
  }

  function patchPortion(index: number, patch: Partial<PortionDraft>) {
    setFPortions((prev) => prev.map((p, i) => (i === index ? { ...p, ...patch } : p)));
  }

  const portionSumOk = useMemo(() => {
    const sum = round4(
      fPortions.reduce((s, p) => {
        const n = Number(p.proportionPercent);
        return s + (Number.isFinite(n) ? n : 0);
      }, 0),
    );
    return Math.abs(sum - 100) <= PORTION_SUM_TOLERANCE;
  }, [fPortions]);

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    setBusy(true);
    try {
      const portions: Portion[] = fPortions
        .filter((p) => p.currency.trim() !== "")
        .map((p) => ({
          currency: p.currency.trim().toUpperCase(),
          proportionPercent: Number(p.proportionPercent),
          baseRate: Number(p.baseRate),
        }));
      const payload: Record<string, unknown> = {
        baseCurrency: fBaseCurrency.trim().toUpperCase(),
        baseDate: fBaseDate,
        portions,
        rateSource: fSource,
      };
      if (fContract) payload["contractId"] = fContract;
      if (fNotes.trim()) payload["notes"] = fNotes.trim();
      await api.post<CurrencyConfigRow>(`${base}/currency-configs`, payload);
      setOpen(false);
      await load();
      await loadExposure();
    } catch (err) {
      setFormError(errorMessage(err, "Failed to record the currency configuration."));
    } finally {
      setBusy(false);
    }
  }

  /* --------------------------- split calculator --------------------------- */

  const [splitConfigId, setSplitConfigId] = useState("");
  const [splitAmount, setSplitAmount] = useState("");
  const [splitAsOf, setSplitAsOf] = useState(todayISO);
  const [split, setSplit] = useState<SplitResponse | null>(null);
  const [splitError, setSplitError] = useState<string | null>(null);
  const [splitting, setSplitting] = useState(false);

  useEffect(() => {
    // default the calculator to the first configuration once they land
    if (!splitConfigId && configs && configs.length > 0) {
      setSplitConfigId(configs[0]?.id ?? "");
    }
  }, [configs, splitConfigId]);

  const splitConfig = useMemo(
    () => (configs ?? []).find((c) => c.id === splitConfigId) ?? null,
    [configs, splitConfigId],
  );

  async function onSplit(e: FormEvent) {
    e.preventDefault();
    setSplitError(null);
    setSplitting(true);
    try {
      const res = await api.post<SplitResponse>(
        `${base}/currency-configs/${splitConfigId}/split`,
        { amount: Number(splitAmount), asOf: splitAsOf },
      );
      setSplit(res);
    } catch (err) {
      setSplit(null);
      setSplitError(errorMessage(err, "Failed to split the payment"));
    } finally {
      setSplitting(false);
    }
  }

  /* -------------------------------- render -------------------------------- */

  if (configs === null && !error) return <Spinner label="Loading currency configurations…" />;

  const items = configs ?? [];

  return (
    <div>
      <ErrorAlert message={error} />

      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-ink-900">
          Currency configurations{" "}
          <span className="font-normal text-ink-400">
            — {items.length} on this project
          </span>
        </h3>
        <Button size="sm" onClick={openCreate}>
          New configuration
        </Button>
      </div>

      {items.length === 0 ? (
        <EmptyState
          title="No currency configuration recorded"
          hint="A multi-currency contract fixes the share of each payment settled in each currency, and the rate applied to that share at the base date. Without it, every certificate is converted on somebody's ad-hoc rate."
          action={<Button onClick={openCreate}>Record the first configuration</Button>}
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          {items.map((c) => (
            <ConfigCard
              key={c.id}
              config={c}
              contractName={contractName(c.contractId)}
              selected={c.id === splitConfigId}
              onSplit={() => {
                setSplitConfigId(c.id);
                setSplit(null);
                setSplitError(null);
              }}
            />
          ))}
        </div>
      )}

      {/* ---------------------------- split calculator ----------------------- */}
      {items.length > 0 ? (
        <Card className="mt-5">
          <CardBody>
            <h3 className="text-sm font-semibold text-ink-900">Payment split calculator</h3>
            <p className="mb-3 mt-0.5 text-xs text-ink-400">
              Split one payment across the contractual proportions and value each share against the
              market on the as-of date. The contractual column is what is payable; the market column
              is what the same base share would buy today.
            </p>

            <form onSubmit={onSplit} className="grid grid-cols-1 gap-3 sm:grid-cols-4">
              <Field label="Configuration">
                <Select
                  value={splitConfigId}
                  onChange={(e) => {
                    setSplitConfigId(e.target.value);
                    setSplit(null);
                  }}
                >
                  {items.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.baseCurrency} — {contractName(c.contractId) ?? "no contract"} (
                      {formatDate(c.baseDate)})
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={`Amount${splitConfig ? ` (${splitConfig.baseCurrency})` : ""}`}>
                <Input
                  type="number"
                  min="0.01"
                  step="any"
                  required
                  value={splitAmount}
                  onChange={(e) => setSplitAmount(e.target.value)}
                  placeholder="Gross certified amount"
                />
              </Field>
              <Field label="As of" hint="Market rates on or before this date">
                <Input
                  type="date"
                  value={splitAsOf}
                  onChange={(e) => setSplitAsOf(e.target.value)}
                />
              </Field>
              <div className="flex items-end">
                <Button type="submit" disabled={splitting || !splitAmount}>
                  {splitting ? "Splitting…" : "Split"}
                </Button>
              </div>
            </form>

            <div className="mt-3">
              <ErrorAlert message={splitError} />
            </div>

            {split ? (
              <div className="mt-3">
                <Table>
                  <thead>
                    <tr>
                      <Th>Currency</Th>
                      <Th className="text-right">Proportion</Th>
                      <Th className="text-right">Base amount</Th>
                      <Th className="text-right">Contractual rate</Th>
                      <Th className="text-right">Contractual amount</Th>
                      <Th className="text-right">Market rate</Th>
                      <Th className="text-right">Market amount</Th>
                      <Th className="text-right">Variance</Th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-ink-100">
                    {split.lines.map((l) => (
                      <tr key={l.currency} className="hover:bg-ink-50/60">
                        <Td className="font-medium text-ink-900">{l.currency}</Td>
                        <Td className="text-right tabular-nums text-ink-700">
                          {fmtPct(l.proportionPercent, 4)}
                        </Td>
                        <Td className="text-right tabular-nums text-ink-800">
                          {fmtMoney(l.baseAmount, split.baseCurrency)}
                        </Td>
                        <Td
                          className="text-right tabular-nums text-ink-600"
                          title={`${fmtRate(l.contractualRate)} ${l.currency} per 1 ${split.baseCurrency}, fixed at the base date ${split.baseDate}`}
                        >
                          {fmtRate(l.contractualRate)}
                        </Td>
                        <Td className="text-right font-medium tabular-nums text-ink-900">
                          {fmtMoney(l.contractualAmount, l.currency)}
                        </Td>
                        <Td
                          className="text-right tabular-nums text-ink-600"
                          title={
                            l.marketRate === null
                              ? `No ${split.baseCurrency}/${l.currency} quote on or before ${split.asOf}.`
                              : `${fmtRate(l.marketRate)} ${l.currency} per 1 ${split.baseCurrency} — ${l.marketRatePath ?? "resolved"} rate dated ${l.marketRateDate ?? "unknown"}.`
                          }
                        >
                          {l.marketRate === null ? (
                            <span className="text-ink-300">—</span>
                          ) : (
                            fmtRate(l.marketRate)
                          )}
                        </Td>
                        <Td className="text-right tabular-nums text-ink-800">
                          {l.marketAmount === null ? (
                            <span className="text-ink-300">—</span>
                          ) : (
                            fmtMoney(l.marketAmount, l.currency)
                          )}
                        </Td>
                        <Td
                          className={`text-right font-medium tabular-nums ${varianceClass(l.fxVariance)}`}
                          title={
                            l.fxVariance === null
                              ? "No market rate on file for this currency, so the variance is unknown — not zero."
                              : `Market value minus contractual value on this portion, in ${l.currency}.`
                          }
                        >
                          {l.fxVariance === null ? (
                            <span className="text-ink-300">—</span>
                          ) : (
                            fmtSignedMoney(l.fxVariance, l.currency)
                          )}
                        </Td>
                      </tr>
                    ))}
                    <tr className="bg-ink-50/70 font-medium">
                      <Td className="text-ink-900">Total</Td>
                      <Td className="text-right tabular-nums text-ink-800">
                        {fmtPct(split.totals.proportionPercent, 4)}
                      </Td>
                      <Td className="text-right tabular-nums text-ink-900">
                        {fmtMoney(split.totals.baseAmount, split.baseCurrency)}
                      </Td>
                      <Td />
                      <Td className="text-right text-xs text-ink-400">
                        mixed currencies — not summed
                      </Td>
                      <Td />
                      <Td className="text-right text-xs text-ink-400">
                        covered {fmtMoney(split.totals.coveredBaseAmount, split.baseCurrency)}
                      </Td>
                      <Td
                        className={`text-right tabular-nums ${varianceClass(split.totals.baseVariance)}`}
                        title={EXPOSURE_TOOLTIP}
                      >
                        {fmtSignedMoney(split.totals.baseVariance, split.baseCurrency)}
                      </Td>
                    </tr>
                  </tbody>
                </Table>
                <p className="mt-1.5 text-[11px] text-ink-400">
                  Per-currency variances are stated in their own currency and are deliberately not
                  added together. The total variance is the base-currency gain or loss on the
                  portions that have a market rate:{" "}
                  <span className="tabular-nums">
                    {fmtMoney(split.totals.coveredBaseEquivalent, split.baseCurrency)}
                  </span>{" "}
                  to buy{" "}
                  <span className="tabular-nums">
                    {fmtMoney(split.totals.coveredBaseAmount, split.baseCurrency)}
                  </span>{" "}
                  of contractual entitlement.
                </p>
                {split.note ? (
                  <div className="mt-2">
                    <Caveat>{split.note}</Caveat>
                  </div>
                ) : null}
              </div>
            ) : null}
          </CardBody>
        </Card>
      ) : null}

      {/* ------------------------------- exposure ---------------------------- */}
      <div className="mt-6 mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-ink-900">
          FX exposure{" "}
          <span
            title={EXPOSURE_TOOLTIP}
            aria-label={EXPOSURE_TOOLTIP}
            className="cursor-help rounded-full border border-ink-200 px-1 text-[9px] leading-4 text-ink-400"
          >
            ?
          </span>
        </h3>
        <label className="flex items-center gap-2 text-xs text-ink-500">
          Valued as at
          <Input
            type="date"
            value={asOf}
            onChange={(e) => setAsOf(e.target.value)}
            className="w-40"
          />
        </label>
      </div>

      <ErrorAlert message={exposureError} />

      {exposure === null && !exposureError ? (
        <Spinner label="Valuing the contractual positions…" />
      ) : exposure && exposure.items.length === 0 ? (
        <EmptyState
          title="Nothing to value"
          hint="The exposure statement values each currency configuration's contract sum at the contractual base-date rates against the market on the as-of date. Record a configuration linked to a contract with a sum to see it."
        />
      ) : exposure ? (
        <div className="space-y-4">
          {exposure.totals.length > 0 ? (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {exposure.totals.map((t) => (
                <StatCard
                  key={t.baseCurrency}
                  label={`${t.baseCurrency} position`}
                  value={fmtSignedMoney(t.variance, t.baseCurrency)}
                  tone={t.variance > 0 ? "red" : t.variance < 0 ? "green" : undefined}
                  hint={`${fmtMoney(t.contractualValue, t.baseCurrency)} contractual vs ${fmtMoney(t.marketValue, t.baseCurrency)} market · ${t.configs} configuration${t.configs === 1 ? "" : "s"}`}
                  title={EXPOSURE_TOOLTIP}
                />
              ))}
              {exposure.unpriced > 0 ? (
                <StatCard
                  label="Unpriced"
                  value={exposure.unpriced}
                  tone="amber"
                  hint="configurations that cannot be valued"
                  title="A configuration with no linked contract, or a contract with no sum recorded, cannot be quantified. It is counted here rather than silently dropped."
                />
              ) : null}
            </div>
          ) : null}

          {exposure.items.map((item) => (
            <Card key={item.configId}>
              <CardBody>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-ink-900">
                      {item.contractName ?? "Unlinked configuration"}
                    </div>
                    <div className="mt-0.5 text-xs text-ink-400">
                      Base {item.baseCurrency} · struck {formatDate(item.baseDate)} · valued at{" "}
                      {formatDate(exposure.asOf)}
                    </div>
                  </div>
                  <div className="text-right">
                    <div
                      className={`text-lg font-semibold tabular-nums ${varianceClass(item.variance)}`}
                    >
                      {fmtSignedMoney(item.variance, item.baseCurrency)}
                    </div>
                    <div className="text-xs text-ink-400">
                      {item.variancePercent === null
                        ? "no variance computed"
                        : `${fmtPct(item.variancePercent, 2)} of the covered value`}
                    </div>
                  </div>
                </div>

                {item.contractualValue !== null && item.marketValue !== null ? (
                  <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
                    <div className="rounded-md bg-ink-50 px-3 py-2">
                      <div className="text-[11px] uppercase tracking-wide text-ink-400">
                        Contract sum
                      </div>
                      <div className="tabular-nums text-ink-900">
                        {fmtMoney(item.contractSum, item.baseCurrency)}
                      </div>
                    </div>
                    <div className="rounded-md bg-ink-50 px-3 py-2">
                      <div className="text-[11px] uppercase tracking-wide text-ink-400">
                        Contractual valuation
                      </div>
                      <div className="tabular-nums text-ink-900">
                        {fmtMoney(item.contractualValue, item.baseCurrency)}
                      </div>
                    </div>
                    <div className="rounded-md bg-ink-50 px-3 py-2">
                      <div className="text-[11px] uppercase tracking-wide text-ink-400">
                        Market valuation
                      </div>
                      <div className="tabular-nums text-ink-900">
                        {fmtMoney(item.marketValue, item.baseCurrency)}
                      </div>
                    </div>
                  </div>
                ) : null}

                {item.missingRates.length > 0 ? (
                  <div className="mt-3">
                    <Caveat>
                      No market rate on or before {formatDate(exposure.asOf)} for{" "}
                      <span className="font-semibold">{item.missingRates.join(", ")}</span> — those
                      portions are shown at contractual values only and are excluded from the
                      variance.
                    </Caveat>
                  </div>
                ) : null}

                {item.notes.map((n) => (
                  <p key={n} className="mt-2 text-xs text-amber-800">
                    {n}
                  </p>
                ))}
              </CardBody>
            </Card>
          ))}
        </div>
      ) : null}

      {/* ----------------------------- create modal -------------------------- */}
      <Modal
        open={open}
        title="New currency configuration"
        onClose={() => setOpen(false)}
        wide
      >
        <ErrorAlert message={formError} />
        <form onSubmit={onCreate} className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field label="Base currency" hint="3-letter code, e.g. USD">
              <Input
                required
                maxLength={3}
                value={fBaseCurrency}
                onChange={(e) => setFBaseCurrency(e.target.value.toUpperCase())}
                placeholder="USD"
                className="uppercase"
              />
            </Field>
            <Field label="Base date" hint="When the contractual rates were struck">
              <Input
                type="date"
                required
                value={fBaseDate}
                onChange={(e) => setFBaseDate(e.target.value)}
              />
            </Field>
            <Field label="Rate source" hint={FX_SOURCE_DESCRIPTIONS[fSource]}>
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
            label="Contract"
            hint="Optional, but a configuration with no contract cannot be valued in the exposure statement."
          >
            <Select value={fContract} onChange={(e) => setFContract(e.target.value)}>
              <option value="">— none —</option>
              {contracts.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                  {c.contractSum !== null ? ` — ${fmtNum(c.contractSum, 0)} ${c.currency ?? ""}` : ""}
                </option>
              ))}
            </Select>
          </Field>

          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-xs font-medium text-ink-600">Currency portions</span>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => setFPortions((p) => [...p, emptyPortion()])}
              >
                Add portion
              </Button>
            </div>
            <div className="space-y-2">
              {fPortions.map((p, i) => (
                <div key={i} className="flex items-end gap-2">
                  <div className="w-24">
                    <Field label={i === 0 ? "Currency" : ""}>
                      <Input
                        maxLength={3}
                        value={p.currency}
                        onChange={(e) => patchPortion(i, { currency: e.target.value.toUpperCase() })}
                        placeholder="EUR"
                        className="uppercase"
                      />
                    </Field>
                  </div>
                  <div className="flex-1">
                    <Field label={i === 0 ? "Proportion %" : ""}>
                      <Input
                        type="number"
                        min="0"
                        max="100"
                        step="any"
                        value={p.proportionPercent}
                        onChange={(e) => patchPortion(i, { proportionPercent: e.target.value })}
                        placeholder="40"
                      />
                    </Field>
                  </div>
                  <div className="flex-1">
                    <Field label={i === 0 ? `Base rate per 1 ${fBaseCurrency || "base"}` : ""}>
                      <Input
                        type="number"
                        min="0"
                        step="any"
                        value={p.baseRate}
                        onChange={(e) => patchPortion(i, { baseRate: e.target.value })}
                        placeholder="0.92"
                      />
                    </Field>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="mb-0.5"
                    aria-label="Remove portion"
                    disabled={fPortions.length <= 1}
                    onClick={() => setFPortions((prev) => prev.filter((_, j) => j !== i))}
                  >
                    ✕
                  </Button>
                </div>
              ))}
            </div>
            <div className="mt-2">
              <PortionSum portions={fPortions} />
            </div>
            <p className="mt-1 text-[11px] text-ink-400">
              A tolerance of ±0.01% is allowed, because contracts routinely state thirds as
              33.33 / 33.33 / 33.34. Each currency may appear only once.
            </p>
          </div>

          <Field label="Notes">
            <Textarea
              value={fNotes}
              onChange={(e) => setFNotes(e.target.value)}
              placeholder="Clause reference, agreed mechanism, anything a later reader needs"
            />
          </Field>

          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !portionSumOk}>
              {busy ? "Saving…" : "Save configuration"}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
