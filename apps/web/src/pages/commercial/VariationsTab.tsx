/**
 * Variations tab — variation register with valuation-basis discipline
 * (#168-171): BQ rates, pro-rata, star rates and dayworks.
 */
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { VARIATION_BASES } from "@constructos/shared";
import { api, ApiClientError } from "../../lib/api";
import {
  Badge,
  Button,
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
import { formatDate, humanize } from "../format";
import {
  Drawer,
  flattenBoqItems,
  money,
  padNo,
  parseNum,
  round2,
  todayIso,
  variationTone,
  type BoqRow,
  type FlatBoqItem,
  type ListResponse,
  type VariationRow,
} from "./commercialShared";

const STAR_RATE_HINT =
  "Tip: when the work is not comparable to a BQ item, value it as a star rate (fair valuation) instead.";

interface BuildUpRow {
  boqItemId: string;
  description: string;
  qty: string;
  rate: string;
}

const emptyRow: BuildUpRow = { boqItemId: "", description: "", qty: "1", rate: "" };

/* -------------------------------- Value modal ------------------------------ */

function ValueModal({
  variation,
  boqs,
  currency,
  onClose,
  onValued,
}: {
  variation: VariationRow;
  boqs: BoqRow[];
  currency: string;
  onClose: () => void;
  onValued: (updated: VariationRow) => void;
}) {
  const [basis, setBasis] = useState(variation.basis);
  const [agreedValue, setAgreedValue] = useState(
    variation.agreedValue !== null ? String(variation.agreedValue) : "",
  );
  const [rows, setRows] = useState<BuildUpRow[]>([{ ...emptyRow }]);
  const [withBuildUp, setWithBuildUp] = useState(
    variation.basis === "bq_rates" || variation.basis === "pro_rata",
  );
  const [boqId, setBoqId] = useState(boqs[0]?.id ?? "");
  const [items, setItems] = useState<FlatBoqItem[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showStarHint, setShowStarHint] = useState(false);

  const needsBqItems = basis === "bq_rates" || basis === "pro_rata";

  useEffect(() => {
    if (!boqId) {
      setItems([]);
      return;
    }
    setItems(null);
    api
      .get<{ items?: unknown }>(`/api/v1/boqs/${boqId}`)
      .then((res) => setItems(flattenBoqItems(res?.items).filter((i) => i.level === "item")))
      .catch(() => setItems([]));
  }, [boqId]);

  const itemById = useMemo(() => new Map((items ?? []).map((i) => [i.id, i])), [items]);

  const total = round2(
    rows.reduce((s, r) => {
      const q = Number(r.qty);
      const rate = Number(r.rate);
      return Number.isFinite(q) && Number.isFinite(rate) ? s + q * rate : s;
    }, 0),
  );

  function setRow(idx: number, patch: Partial<BuildUpRow>) {
    setRows((rs) => rs.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  }

  function pickItem(idx: number, itemId: string) {
    const item = itemById.get(itemId);
    setRows((rs) =>
      rs.map((r, i) =>
        i === idx
          ? {
              ...r,
              boqItemId: itemId,
              description: r.description || (item ? `${item.code} ${item.description}` : ""),
              rate: item?.rate !== null && item?.rate !== undefined ? String(item.rate) : r.rate,
            }
          : r,
      ),
    );
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setShowStarHint(false);
    setBusy(true);
    try {
      const payload: Record<string, unknown> = { basis };
      const av = parseNum(agreedValue);
      if (typeof av === "number") payload["agreedValue"] = av;
      if (withBuildUp) {
        const buildUp = rows
          .filter((r) => r.description.trim())
          .map((r) => ({
            ...(r.boqItemId ? { boqItemId: r.boqItemId } : {}),
            description: r.description.trim(),
            qty: Number(r.qty) || 0,
            rate: Number(r.rate) || 0,
          }));
        if (buildUp.length > 0) payload["buildUp"] = buildUp;
      }
      const updated = await api.post<VariationRow>(
        `/api/v1/variations/${variation.id}/value`,
        payload,
      );
      onValued(updated);
    } catch (err) {
      if (err instanceof ApiClientError) {
        setError(err.message);
        if (err.status === 400 && needsBqItems) setShowStarHint(true);
      } else {
        setError("Failed to value the variation.");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open title={`Value ${padNo("VO", variation.number)}`} onClose={onClose} wide>
      <ErrorAlert message={error} />
      {showStarHint ? <p className="mb-3 text-xs text-amber-700">{STAR_RATE_HINT}</p> : null}
      <form onSubmit={submit} className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <Field label="Valuation basis" hint="bq_rates demands exact BQ rates; star_rate is a fair valuation.">
            <Select value={basis} onChange={(e) => setBasis(e.target.value)}>
              {VARIATION_BASES.map((b) => (
                <option key={b} value={b}>
                  {humanize(b)}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label="Agreed value"
            hint={withBuildUp ? "Leave blank to use the build-up total." : undefined}
          >
            <Input
              inputMode="decimal"
              value={agreedValue}
              onChange={(e) => setAgreedValue(e.target.value)}
            />
          </Field>
        </div>

        <div className="rounded-md border border-ink-100 p-3">
          <label className="flex items-center gap-2 text-sm text-ink-700">
            <input
              type="checkbox"
              checked={withBuildUp}
              onChange={(e) => setWithBuildUp(e.target.checked)}
            />
            Build-up lines{" "}
            {needsBqItems ? (
              <span className="text-xs text-ink-400">
                ({basis === "bq_rates" ? "every line must reference a BQ item" : "reference BQ items"})
              </span>
            ) : null}
          </label>
          {withBuildUp ? (
            <div className="mt-3 space-y-2">
              {needsBqItems ? (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-ink-500">BQ items from</span>
                  <Select
                    className="w-64"
                    value={boqId}
                    onChange={(e) => setBoqId(e.target.value)}
                  >
                    {boqs.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.name}
                      </option>
                    ))}
                  </Select>
                  {items === null ? <span className="text-xs text-ink-400">Loading items…</span> : null}
                </div>
              ) : null}
              {rows.map((row, idx) => (
                <div key={idx} className="flex flex-wrap items-center gap-2">
                  {needsBqItems ? (
                    <Select
                      className="w-56"
                      value={row.boqItemId}
                      onChange={(e) => pickItem(idx, e.target.value)}
                    >
                      <option value="">— BQ item —</option>
                      {(items ?? []).map((i) => (
                        <option key={i.id} value={i.id}>
                          {i.code} · {i.description.slice(0, 50)}
                        </option>
                      ))}
                    </Select>
                  ) : null}
                  <Input
                    className="min-w-40 flex-1"
                    placeholder="Description"
                    value={row.description}
                    onChange={(e) => setRow(idx, { description: e.target.value })}
                  />
                  <Input
                    className="w-20 text-right"
                    inputMode="decimal"
                    placeholder="Qty"
                    value={row.qty}
                    onChange={(e) => setRow(idx, { qty: e.target.value })}
                  />
                  <Input
                    className="w-24 text-right"
                    inputMode="decimal"
                    placeholder="Rate"
                    value={row.rate}
                    onChange={(e) => setRow(idx, { rate: e.target.value })}
                  />
                  <span className="w-24 text-right text-sm tabular-nums text-ink-600">
                    {money(round2((Number(row.qty) || 0) * (Number(row.rate) || 0)), currency)}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setRows((rs) => rs.filter((_, i) => i !== idx))}
                    disabled={rows.length === 1}
                  >
                    ✕
                  </Button>
                </div>
              ))}
              <div className="flex items-center justify-between pt-1">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setRows((rs) => [...rs, { ...emptyRow }])}
                >
                  Add line
                </Button>
                <span className="text-sm font-medium tabular-nums text-ink-800">
                  Build-up total: {money(total, currency)}
                </span>
              </div>
            </div>
          ) : null}
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy}>
            {busy ? "Valuing…" : "Save valuation"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/* ------------------------------ Variations tab ----------------------------- */

export default function VariationsTab({
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
  const [rows, setRows] = useState<VariationRow[] | null>(null);
  const [totals, setTotals] = useState<{ agreed: number; pending: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<VariationRow | null>(null);
  const [drawerError, setDrawerError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [createOpen, setCreateOpen] = useState(false);
  const [valueOpen, setValueOpen] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [basis, setBasis] = useState<string>("bq_rates");
  const [clauseRef, setClauseRef] = useState("");
  const [costEstimate, setCostEstimate] = useState("");
  const [timeImpact, setTimeImpact] = useState("");

  const [instructionRef, setInstructionRef] = useState("");
  const [instructedAt, setInstructedAt] = useState(todayIso());

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api.get<
        ListResponse<VariationRow> & { totals?: { agreed: number; pending: number } }
      >(`/api/v1/projects/${projectId}/variations?pageSize=100`);
      setRows(res?.items ?? []);
      setTotals(res?.totals ?? null);
    } catch (err) {
      setRows([]);
      setError(err instanceof Error ? err.message : "Failed to load variations");
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  function afterChange(updated?: VariationRow) {
    if (updated) setSelected(updated);
    void load();
    onMutate();
  }

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setCreateError(null);
    setBusy(true);
    try {
      const payload: Record<string, unknown> = { title: title.trim(), basis };
      if (description.trim()) payload["description"] = description.trim();
      if (clauseRef.trim()) payload["clauseRef"] = clauseRef.trim();
      const est = parseNum(costEstimate);
      if (typeof est === "number") payload["costEstimate"] = est;
      const days = parseNum(timeImpact);
      if (typeof days === "number") payload["timeImpactDays"] = Math.trunc(days);
      const created = await api.post<VariationRow>(
        `/api/v1/projects/${projectId}/variations`,
        payload,
      );
      setCreateOpen(false);
      setTitle("");
      setDescription("");
      setClauseRef("");
      setCostEstimate("");
      setTimeImpact("");
      afterChange(created);
    } catch (err) {
      setCreateError(err instanceof ApiClientError ? err.message : "Failed to create the variation.");
    } finally {
      setBusy(false);
    }
  }

  async function setStatus(v: VariationRow, status: string, extra?: Record<string, unknown>) {
    setDrawerError(null);
    setBusy(true);
    try {
      const updated = await api.post<VariationRow>(`/api/v1/variations/${v.id}/status`, {
        status,
        ...extra,
      });
      afterChange(updated);
    } catch (err) {
      setDrawerError(err instanceof ApiClientError ? err.message : "Failed to update the status.");
    } finally {
      setBusy(false);
    }
  }

  const preAgreed = (s: string) => s === "proposed" || s === "instructed" || s === "valued";

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h2 className="text-sm font-semibold text-ink-900">Variation register</h2>
          {totals ? (
            <span className="text-xs text-ink-500">
              Agreed{" "}
              <span className="font-medium tabular-nums text-ink-800">
                {money(totals.agreed, currency)}
              </span>{" "}
              · Pending{" "}
              <span className="font-medium tabular-nums text-ink-800">
                {money(totals.pending, currency)}
              </span>
            </span>
          ) : null}
        </div>
        <Button onClick={() => setCreateOpen(true)}>New variation</Button>
      </div>
      <ErrorAlert message={error} />

      {rows === null ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No variations yet"
          hint="Record proposed changes here — each moves proposed → instructed → valued → agreed."
          action={<Button onClick={() => setCreateOpen(true)}>Raise the first variation</Button>}
        />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>No.</Th>
              <Th>Title</Th>
              <Th>Status</Th>
              <Th>Basis</Th>
              <Th className="text-right">Estimate</Th>
              <Th className="text-right">Agreed value</Th>
              <Th className="text-right">Time impact</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {rows.map((v) => (
              <tr
                key={v.id}
                className="cursor-pointer hover:bg-ink-50/60"
                onClick={() => {
                  setSelected(v);
                  setDrawerError(null);
                  setInstructionRef(v.instructionRef ?? "");
                  setInstructedAt(v.instructedAt ?? todayIso());
                }}
              >
                <Td className="whitespace-nowrap font-mono text-xs font-medium text-brand-700">
                  {padNo("VO", v.number)}
                </Td>
                <Td className="max-w-md truncate font-medium">{v.title}</Td>
                <Td>
                  <Badge tone={variationTone(v.status)}>{humanize(v.status)}</Badge>
                </Td>
                <Td>{humanize(v.basis)}</Td>
                <Td className="text-right tabular-nums">{money(v.costEstimate, currency)}</Td>
                <Td className="text-right font-medium tabular-nums">
                  {money(v.agreedValue, currency)}
                </Td>
                <Td className="text-right tabular-nums">
                  {v.timeImpactDays !== null && v.timeImpactDays !== undefined
                    ? `${v.timeImpactDays > 0 ? "+" : ""}${v.timeImpactDays}d`
                    : "—"}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      {/* ------------------------------ drawer ------------------------------ */}
      {selected ? (
        <Drawer
          open
          title={`${padNo("VO", selected.number)} — ${selected.title}`}
          onClose={() => setSelected(null)}
        >
          <ErrorAlert message={drawerError} />
          <div className="mb-3 flex items-center gap-2">
            <Badge tone={variationTone(selected.status)}>{humanize(selected.status)}</Badge>
            <Badge tone="gray">{humanize(selected.basis)}</Badge>
            {selected.clauseRef ? (
              <span className="text-xs text-ink-400">Clause {selected.clauseRef}</span>
            ) : null}
          </div>
          {selected.description ? (
            <p className="mb-4 text-sm text-ink-700">{selected.description}</p>
          ) : null}
          <dl className="mb-4 grid grid-cols-2 gap-3 text-sm">
            <div>
              <dt className="text-xs uppercase tracking-wide text-ink-400">Cost estimate</dt>
              <dd className="tabular-nums text-ink-800">{money(selected.costEstimate, currency)}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-ink-400">Agreed value</dt>
              <dd className="font-medium tabular-nums text-ink-900">
                {money(selected.agreedValue, currency)}
              </dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-ink-400">Time impact</dt>
              <dd className="text-ink-800">
                {selected.timeImpactDays !== null && selected.timeImpactDays !== undefined
                  ? `${selected.timeImpactDays} day${selected.timeImpactDays === 1 ? "" : "s"}`
                  : "—"}
              </dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-ink-400">Instruction</dt>
              <dd className="text-ink-800">
                {selected.instructionRef
                  ? `${selected.instructionRef} · ${formatDate(selected.instructedAt)}`
                  : "—"}
              </dd>
            </div>
          </dl>

          {selected.status === "proposed" ? (
            <div className="mb-4 space-y-2 rounded-md border border-ink-100 p-3">
              <h3 className="text-sm font-semibold text-ink-900">Instruct</h3>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Instruction ref">
                  <Input
                    value={instructionRef}
                    onChange={(e) => setInstructionRef(e.target.value)}
                    placeholder="AI-014 / PMI-3"
                  />
                </Field>
                <Field label="Instructed on">
                  <Input
                    type="date"
                    value={instructedAt}
                    onChange={(e) => setInstructedAt(e.target.value)}
                  />
                </Field>
              </div>
              <Button
                size="sm"
                disabled={busy || !instructionRef.trim() || !instructedAt}
                onClick={() =>
                  void setStatus(selected, "instructed", {
                    instructionRef: instructionRef.trim(),
                    instructedAt,
                  })
                }
              >
                Instruct variation
              </Button>
            </div>
          ) : null}

          <div className="flex flex-wrap gap-2">
            {selected.status === "instructed" || selected.status === "valued" ? (
              <Button size="sm" variant="secondary" disabled={busy} onClick={() => setValueOpen(true)}>
                {selected.status === "valued" ? "Revalue…" : "Value…"}
              </Button>
            ) : null}
            {selected.status === "instructed" &&
            (selected.agreedValue !== null || selected.costEstimate !== null) ? (
              <Button size="sm" disabled={busy} onClick={() => void setStatus(selected, "valued")}>
                Mark valued
              </Button>
            ) : null}
            {selected.status === "valued" ? (
              <Button size="sm" disabled={busy} onClick={() => void setStatus(selected, "agreed")}>
                Agree
              </Button>
            ) : null}
            {preAgreed(selected.status) ? (
              <>
                <Button
                  size="sm"
                  variant="danger"
                  disabled={busy}
                  onClick={() => void setStatus(selected, "rejected")}
                >
                  Reject
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => void setStatus(selected, "withdrawn")}
                >
                  Withdraw
                </Button>
              </>
            ) : (
              <span className="text-xs text-ink-400">
                This variation is {selected.status} — no further actions.
              </span>
            )}
          </div>
        </Drawer>
      ) : null}

      {/* ---------------------------- value modal ---------------------------- */}
      {selected && valueOpen ? (
        <ValueModal
          variation={selected}
          boqs={boqs ?? []}
          currency={currency}
          onClose={() => setValueOpen(false)}
          onValued={(updated) => {
            setValueOpen(false);
            afterChange(updated);
          }}
        />
      ) : null}

      {/* ---------------------------- create modal --------------------------- */}
      <Modal open={createOpen} title="New variation" onClose={() => setCreateOpen(false)} wide>
        <ErrorAlert message={createError} />
        <form onSubmit={onCreate} className="space-y-4">
          <Field label="Title">
            <Input
              required
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Substitute blockwork for insitu wall at L2"
            />
          </Field>
          <Field label="Description">
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} />
          </Field>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Field label="Valuation basis">
              <Select value={basis} onChange={(e) => setBasis(e.target.value)}>
                {VARIATION_BASES.map((b) => (
                  <option key={b} value={b}>
                    {humanize(b)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Clause ref">
              <Input
                value={clauseRef}
                onChange={(e) => setClauseRef(e.target.value)}
                placeholder="13.1"
              />
            </Field>
            <Field label="Cost estimate">
              <Input
                inputMode="decimal"
                value={costEstimate}
                onChange={(e) => setCostEstimate(e.target.value)}
              />
            </Field>
            <Field label="Time impact (days)">
              <Input
                inputMode="numeric"
                value={timeImpact}
                onChange={(e) => setTimeImpact(e.target.value)}
              />
            </Field>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !title.trim()}>
              {busy ? "Creating…" : "Create variation"}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
