/**
 * Remeasure & provisional sums tab (spec Vol II Domain B #141-144, #125-127).
 *
 * A remeasurement is an assertion about quantity: one person measures it,
 * a DIFFERENT person agrees it, and only then is it applied to the bill. A
 * provisional sum is an allowance, not work: expenditure is recorded against
 * it so the final-account adjustment (omit the allowance, add the spend) is
 * computed rather than typed.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
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
  Select,
  Spinner,
  Table,
  Td,
  Textarea,
  Th,
} from "../../ui";
import { formatDate, humanize } from "../format";
import {
  Drawer,
  flattenBoqItems,
  money,
  moneySigned,
  parseNum,
  qty,
  remeasurementTone,
  todayIso,
  useCompanyUsers,
  type BoqDetail,
  type BoqRow,
  type FlatBoqItem,
  type ListResponse,
  type ProvisionalSumRow,
  type RemeasurementRow,
} from "./commercialShared";

const METHODS = [
  "site_measure",
  "drawing_measure",
  "model_quantity",
  "survey",
  "agreed_record",
] as const;

const PS_KINDS = ["defined", "undefined", "prime_cost", "contingency"] as const;

interface PsListResponse extends ListResponse<ProvisionalSumRow> {
  byCurrency: Array<{ currency: string; allowance: number; expended: number; remaining: number }>;
}

export default function MeasureTab({
  projectId,
  boqs,
  currency,
  onMutate,
}: {
  projectId: string;
  boqs: BoqRow[] | null;
  currency: string;
  onMutate: () => void;
}) {
  const [remeasures, setRemeasures] = useState<RemeasurementRow[] | null>(null);
  const [sums, setSums] = useState<ProvisionalSumRow[] | null>(null);
  const [psTotals, setPsTotals] = useState<PsListResponse["byCurrency"]>([]);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState<"remeasure" | "ps" | null>(null);
  const [expenditureFor, setExpenditureFor] = useState<ProvisionalSumRow | null>(null);
  const [busy, setBusy] = useState(false);
  const { nameOf } = useCompanyUsers();

  const load = useCallback(async () => {
    setError(null);
    try {
      const [r, p] = await Promise.all([
        api.get<ListResponse<RemeasurementRow>>(
          `/api/v1/projects/${projectId}/remeasurements?pageSize=200`,
        ),
        api.get<PsListResponse>(`/api/v1/projects/${projectId}/provisional-sums?pageSize=200`),
      ]);
      setRemeasures(r?.items ?? []);
      setSums(p?.items ?? []);
      setPsTotals(p?.byCurrency ?? []);
    } catch (err) {
      setRemeasures([]);
      setSums([]);
      setError(err instanceof Error ? err.message : "Failed to load the measurement register");
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(fn: () => Promise<unknown>) {
    setError(null);
    setBusy(true);
    try {
      await fn();
      await load();
      onMutate();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "The action failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-8">
      <section>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-ink-900">Remeasurement register</h2>
            <p className="mt-0.5 text-xs text-ink-500">
              Measured by one party, agreed by another; only an agreed record moves the bill.
            </p>
          </div>
          <Button size="sm" onClick={() => setCreating("remeasure")}>
            Propose a remeasurement
          </Button>
        </div>
        <ErrorAlert message={error} />
        {remeasures === null ? (
          <Spinner />
        ) : remeasures.length === 0 ? (
          <EmptyState
            title="Nothing remeasured yet"
            hint="Remeasurement applies to an issued bill — a draft bill is edited directly."
          />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Item</Th>
                <Th className="text-right">Billed</Th>
                <Th className="text-right">Remeasured</Th>
                <Th className="text-right">Movement</Th>
                <Th className="text-right">Value</Th>
                <Th>Method</Th>
                <Th>Measured by</Th>
                <Th>Status</Th>
                <Th />
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {remeasures.map((r) => (
                <tr key={r.id} className="hover:bg-ink-50/60">
                  <Td>
                    <span className="font-mono text-xs font-medium">{r.code ?? "—"}</span>
                    <span className="block max-w-xs truncate text-xs text-ink-500">
                      {r.description ?? ""}
                    </span>
                  </Td>
                  <Td className="text-right tabular-nums">{qty(r.originalQuantity)}</Td>
                  <Td className="text-right font-medium tabular-nums">
                    {qty(r.remeasuredQuantity)} {r.unit ?? ""}
                  </Td>
                  <Td
                    className={
                      (r.quantityMovement ?? 0) >= 0
                        ? "text-right tabular-nums text-emerald-600"
                        : "text-right tabular-nums text-red-600"
                    }
                  >
                    {r.quantityMovement == null
                      ? "—"
                      : `${r.quantityMovement > 0 ? "+" : ""}${qty(r.quantityMovement)}`}
                  </Td>
                  <Td className="text-right tabular-nums">
                    {moneySigned(r.valueMovement, currency)}
                  </Td>
                  <Td className="whitespace-nowrap text-xs">{humanize(r.method)}</Td>
                  <Td className="whitespace-nowrap text-xs text-ink-500">
                    {nameOf(r.measuredBy)}
                    <span className="block">{formatDate(r.measuredAt)}</span>
                  </Td>
                  <Td>
                    <Badge tone={remeasurementTone(r.status)}>{humanize(r.status)}</Badge>
                  </Td>
                  <Td className="whitespace-nowrap text-right">
                    {r.status === "proposed" ? (
                      <div className="flex justify-end gap-2">
                        <button
                          type="button"
                          disabled={busy}
                          className="text-xs font-medium text-brand-700 hover:text-brand-900"
                          onClick={() =>
                            void act(() => api.post(`/api/v1/remeasurements/${r.id}/agree`, {}))
                          }
                        >
                          Agree
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          className="text-xs font-medium text-red-600 hover:text-red-800"
                          onClick={() => {
                            const reason = window.prompt("Why is this measure disputed?");
                            if (reason && reason.trim().length >= 3) {
                              void act(() =>
                                api.post(`/api/v1/remeasurements/${r.id}/dispute`, { reason }),
                              );
                            }
                          }}
                        >
                          Dispute
                        </button>
                      </div>
                    ) : null}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </section>

      <section>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-ink-900">Provisional sums & prime cost</h2>
            <p className="mt-0.5 text-xs text-ink-500">
              The allowance is omitted and the expenditure added when the final account is built.
            </p>
          </div>
          <Button size="sm" onClick={() => setCreating("ps")}>
            Record a provisional sum
          </Button>
        </div>
        {psTotals.length > 0 ? (
          <div className="mb-3 flex flex-wrap gap-2">
            {psTotals.map((t) => (
              <Badge key={t.currency} tone="gray">
                {t.currency}: {money(t.allowance, t.currency)} allowed ·{" "}
                {money(t.expended, t.currency)} spent · {money(t.remaining, t.currency)} remaining
              </Badge>
            ))}
          </div>
        ) : null}
        {sums === null ? (
          <Spinner />
        ) : sums.length === 0 ? (
          <EmptyState
            title="No provisional sums recorded"
            hint="Attach a provisional sum to the BQ item that carries the allowance."
          />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Item</Th>
                <Th>Title</Th>
                <Th>Kind</Th>
                <Th className="text-right">Allowance</Th>
                <Th className="text-right">Expended</Th>
                <Th className="text-right">Variance</Th>
                <Th>Status</Th>
                <Th />
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {sums.map((p) => (
                <tr key={p.id} className="hover:bg-ink-50/60">
                  <Td className="whitespace-nowrap font-mono text-xs">{p.code ?? "—"}</Td>
                  <Td className="max-w-xs truncate">{p.title}</Td>
                  <Td>
                    <Badge tone={p.kind === "prime_cost" ? "violet" : "amber"}>
                      {humanize(p.kind)}
                    </Badge>
                  </Td>
                  <Td className="text-right tabular-nums">{money(p.allowance, p.currency)}</Td>
                  <Td className="text-right tabular-nums">{money(p.expendedTotal, p.currency)}</Td>
                  <Td
                    className={
                      (p.variance ?? 0) > 0
                        ? "text-right font-medium tabular-nums text-red-600"
                        : "text-right tabular-nums text-ink-500"
                    }
                  >
                    {moneySigned(p.variance, p.currency)}
                    {p.variancePercent != null ? (
                      <span className="block text-xs">{p.variancePercent}%</span>
                    ) : null}
                  </Td>
                  <Td>
                    <Badge tone={p.status === "omitted" ? "gray" : "blue"}>
                      {humanize(p.status)}
                    </Badge>
                  </Td>
                  <Td className="whitespace-nowrap text-right">
                    <div className="flex justify-end gap-2">
                      <button
                        type="button"
                        className="text-xs font-medium text-brand-700 hover:text-brand-900"
                        onClick={() => setExpenditureFor(p)}
                      >
                        Expenditure
                      </button>
                      {p.status === "open" ? (
                        <button
                          type="button"
                          disabled={busy}
                          className="text-xs font-medium text-ink-500 hover:text-ink-800"
                          onClick={() => {
                            const ref = window.prompt("Instruction reference");
                            if (ref) {
                              void act(() =>
                                api.post(`/api/v1/provisional-sums/${p.id}/instruct`, {
                                  instructionRef: ref,
                                  instructedAt: todayIso(),
                                }),
                              );
                            }
                          }}
                        >
                          Instruct
                        </button>
                      ) : null}
                      {p.expendedTotal === 0 && p.status !== "omitted" ? (
                        <button
                          type="button"
                          disabled={busy}
                          className="text-xs font-medium text-red-600 hover:text-red-800"
                          onClick={() =>
                            void act(() => api.post(`/api/v1/provisional-sums/${p.id}/omit`, {}))
                          }
                        >
                          Omit
                        </button>
                      ) : null}
                    </div>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </section>

      <RecordDrawer
        mode={creating}
        projectId={projectId}
        boqs={boqs}
        onClose={() => setCreating(null)}
        onSaved={async () => {
          setCreating(null);
          await load();
          onMutate();
        }}
      />

      <ExpenditureDrawer
        sum={expenditureFor}
        onClose={() => setExpenditureFor(null)}
        onSaved={async () => {
          setExpenditureFor(null);
          await load();
          onMutate();
        }}
      />
    </div>
  );
}

/** Shared BQ item picker — loads the leaf items of the chosen bill. */
function useBoqItems(boqs: BoqRow[] | null) {
  const [boqId, setBoqId] = useState<string>("");
  const [items, setItems] = useState<FlatBoqItem[]>([]);
  const candidates = useMemo(() => boqs ?? [], [boqs]);

  useEffect(() => {
    if (!boqId && candidates[0]) setBoqId(candidates[0].id);
  }, [candidates, boqId]);

  useEffect(() => {
    if (!boqId) return;
    let cancelled = false;
    api
      .get<BoqDetail>(`/api/v1/boqs/${boqId}`)
      .then((d) => {
        if (!cancelled) setItems(flattenBoqItems(d.items).filter((i) => i.level === "item"));
      })
      .catch(() => {
        if (!cancelled) setItems([]);
      });
    return () => {
      cancelled = true;
    };
  }, [boqId]);

  return { boqId, setBoqId, items, candidates };
}

function RecordDrawer({
  mode,
  projectId,
  boqs,
  onClose,
  onSaved,
}: {
  mode: "remeasure" | "ps" | null;
  projectId: string;
  boqs: BoqRow[] | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { boqId, setBoqId, items, candidates } = useBoqItems(boqs);
  const [itemId, setItemId] = useState("");
  const [quantity, setQuantity] = useState("");
  const [method, setMethod] = useState<string>("site_measure");
  const [measuredAt, setMeasuredAt] = useState(todayIso());
  const [note, setNote] = useState("");
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<string>("defined");
  const [allowance, setAllowance] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setError(null);
    setBusy(true);
    try {
      if (mode === "remeasure") {
        await api.post(`/api/v1/projects/${projectId}/remeasurements`, {
          boqItemId: itemId,
          remeasuredQuantity: parseNum(quantity),
          method,
          measuredAt,
          note: note || null,
        });
      } else {
        await api.post(`/api/v1/projects/${projectId}/provisional-sums`, {
          boqItemId: itemId,
          kind,
          title,
          allowance: parseNum(allowance) ?? 0,
        });
      }
      onSaved();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Failed to save");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Drawer
      open={mode !== null}
      title={mode === "remeasure" ? "Propose a remeasurement" : "Record a provisional sum"}
      onClose={onClose}
    >
      <ErrorAlert message={error} />
      <div className="space-y-3">
        <Field label="Bill">
          <Select value={boqId} onChange={(e) => setBoqId(e.target.value)}>
            {candidates.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name} ({b.status})
              </option>
            ))}
          </Select>
        </Field>
        <Field label="BQ item">
          <Select value={itemId} onChange={(e) => setItemId(e.target.value)}>
            <option value="">— choose an item —</option>
            {items.map((i) => (
              <option key={i.id} value={i.id}>
                {i.code} · {i.description.slice(0, 60)}
              </option>
            ))}
          </Select>
        </Field>

        {mode === "remeasure" ? (
          <>
            <Field label="Remeasured quantity">
              <Input
                value={quantity}
                inputMode="decimal"
                onChange={(e) => setQuantity(e.target.value)}
              />
            </Field>
            <Field label="Method">
              <Select value={method} onChange={(e) => setMethod(e.target.value)}>
                {METHODS.map((m) => (
                  <option key={m} value={m}>
                    {humanize(m)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Measured on">
              <Input
                type="date"
                value={measuredAt}
                onChange={(e) => setMeasuredAt(e.target.value)}
              />
            </Field>
            <Field label="Note">
              <Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
            </Field>
          </>
        ) : (
          <>
            <Field label="Title">
              <Input value={title} onChange={(e) => setTitle(e.target.value)} />
            </Field>
            <Field label="Kind">
              <Select value={kind} onChange={(e) => setKind(e.target.value)}>
                {PS_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {humanize(k)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Allowance">
              <Input
                value={allowance}
                inputMode="decimal"
                onChange={(e) => setAllowance(e.target.value)}
              />
            </Field>
          </>
        )}
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button disabled={busy || !itemId} onClick={() => void submit()}>
          {busy ? "Saving…" : "Save"}
        </Button>
      </div>
    </Drawer>
  );
}

function ExpenditureDrawer({
  sum,
  onClose,
  onSaved,
}: {
  sum: ProvisionalSumRow | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [rows, setRows] = useState<
    Array<{ id: string; description: string; amount: number; spentOn: string }>
  >([]);
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [spentOn, setSpentOn] = useState(todayIso());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!sum) return;
    try {
      const res = await api.get<{
        items: Array<{ id: string; description: string; amount: number; spentOn: string }>;
      }>(`/api/v1/provisional-sums/${sum.id}/expenditures`);
      setRows(res.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load expenditure");
    }
  }, [sum]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!sum) return null;

  return (
    <Drawer open title={`Expenditure — ${sum.title}`} onClose={onClose}>
      <ErrorAlert message={error} />
      <Card className="mb-4">
        <CardBody className="py-3">
          <div className="grid grid-cols-3 gap-2 text-center">
            <div>
              <div className="text-xs uppercase tracking-wide text-ink-400">Allowance</div>
              <div className="text-base font-semibold tabular-nums">
                {money(sum.allowance, sum.currency)}
              </div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-ink-400">Expended</div>
              <div className="text-base font-semibold tabular-nums">
                {money(sum.expendedTotal, sum.currency)}
              </div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-ink-400">Remaining</div>
              <div
                className={`text-base font-semibold tabular-nums ${
                  sum.allowance - sum.expendedTotal < 0 ? "text-red-600" : "text-emerald-600"
                }`}
              >
                {money(sum.allowance - sum.expendedTotal, sum.currency)}
              </div>
            </div>
          </div>
        </CardBody>
      </Card>

      <Table>
        <thead>
          <tr>
            <Th>Date</Th>
            <Th>Description</Th>
            <Th className="text-right">Amount</Th>
          </tr>
        </thead>
        <tbody className="divide-y divide-ink-100">
          {rows.map((r) => (
            <tr key={r.id}>
              <Td className="whitespace-nowrap">{formatDate(r.spentOn)}</Td>
              <Td>{r.description}</Td>
              <Td className="text-right tabular-nums">{money(r.amount, sum.currency)}</Td>
            </tr>
          ))}
          {rows.length === 0 ? (
            <tr>
              <Td colSpan={3} className="text-center text-sm text-ink-400">
                Nothing spent against this allowance yet.
              </Td>
            </tr>
          ) : null}
        </tbody>
      </Table>

      <div className="mt-4 space-y-2">
        <Field label="Description">
          <Input value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Amount">
            <Input value={amount} inputMode="decimal" onChange={(e) => setAmount(e.target.value)} />
          </Field>
          <Field label="Spent on">
            <Input type="date" value={spentOn} onChange={(e) => setSpentOn(e.target.value)} />
          </Field>
        </div>
        <div className="flex justify-end">
          <Button
            size="sm"
            disabled={busy || !description.trim() || parseNum(amount) == null}
            onClick={() => {
              setBusy(true);
              setError(null);
              api
                .post(`/api/v1/provisional-sums/${sum.id}/expenditures`, {
                  description,
                  amount: parseNum(amount),
                  spentOn,
                })
                .then(() => {
                  setDescription("");
                  setAmount("");
                  onSaved();
                })
                .catch((err: unknown) =>
                  setError(err instanceof ApiClientError ? err.message : "Failed to record"),
                )
                .finally(() => setBusy(false));
            }}
          >
            Record expenditure
          </Button>
        </div>
      </div>
    </Drawer>
  );
}
