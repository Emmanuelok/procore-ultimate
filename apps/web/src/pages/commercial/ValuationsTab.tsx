/**
 * Valuations tab — interim valuations / payment applications (#162-167) and
 * certification with an application-vs-certificate variance statement (#179-180).
 */
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { VALUATION_BASES } from "@constructos/shared";
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
  Textarea,
  Th,
} from "../../ui";
import { formatDate, humanize } from "../format";
import {
  money,
  padNo,
  parseNum,
  qty,
  round2,
  todayIso,
  valuationStatusTone,
  type BoqRow,
  type ListResponse,
  type ValuationDetail,
  type ValuationRow,
} from "./commercialShared";

const SOD_MESSAGE =
  "Certification requires commercial admin and a different person than the submitter (segregation of duties).";

/* ------------------------------- Certify modal ----------------------------- */

function CertifyModal({
  valuation,
  currency,
  open,
  onClose,
  onCertified,
}: {
  valuation: ValuationDetail;
  currency: string;
  open: boolean;
  onClose: () => void;
  onCertified: () => void;
}) {
  const [workDone, setWorkDone] = useState(String(valuation.workDoneToDate));
  const [materials, setMaterials] = useState(
    String(round2(valuation.materialsOnSite + valuation.materialsOffSite)),
  );
  const [reason, setReason] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sodBlocked, setSodBlocked] = useState(false);

  const cwd = parseNum(workDone);
  const cmat = parseNum(materials);
  const valid = typeof cwd === "number" && typeof cmat === "number";
  const retention = valid ? round2((valuation.retentionPercent / 100) * (cwd + cmat)) : null;
  const netCertified =
    valid && retention !== null ? round2(cwd + cmat - retention - valuation.previousNet) : null;
  const variance = netCertified !== null ? round2(netCertified - valuation.netDue) : null;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSodBlocked(false);
    setBusy(true);
    try {
      const payload: Record<string, unknown> = {};
      if (typeof cwd === "number") payload["certifiedWorkDone"] = cwd;
      if (typeof cmat === "number") payload["certifiedMaterials"] = cmat;
      if (reason.trim()) payload["varianceReason"] = reason.trim();
      if (dueDate) payload["dueDate"] = dueDate;
      await api.post(`/api/v1/valuations/${valuation.id}/certify`, payload);
      onCertified();
    } catch (err) {
      if (err instanceof ApiClientError && err.status === 403) {
        setSodBlocked(true);
      } else {
        setError(err instanceof ApiClientError ? err.message : "Failed to certify.");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} title={`Certify ${padNo("VAL", valuation.number)}`} onClose={onClose}>
      {sodBlocked ? (
        <div className="mb-3 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800 ring-1 ring-amber-200">
          {SOD_MESSAGE}
        </div>
      ) : null}
      <ErrorAlert message={error} />
      <form onSubmit={submit} className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <Field label="Certified work done" hint={`Applied: ${money(valuation.workDoneToDate, currency)}`}>
            <Input
              inputMode="decimal"
              value={workDone}
              onChange={(e) => setWorkDone(e.target.value)}
            />
          </Field>
          <Field
            label="Certified materials"
            hint={`Applied: ${money(round2(valuation.materialsOnSite + valuation.materialsOffSite), currency)}`}
          >
            <Input
              inputMode="decimal"
              value={materials}
              onChange={(e) => setMaterials(e.target.value)}
            />
          </Field>
        </div>
        <div className="rounded-md bg-ink-50 p-3 text-sm">
          <div className="flex justify-between">
            <span className="text-ink-500">Retention ({valuation.retentionPercent}%)</span>
            <span className="tabular-nums">{retention !== null ? money(-retention, currency) : "—"}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-ink-500">Previous net certified</span>
            <span className="tabular-nums">{money(-valuation.previousNet, currency)}</span>
          </div>
          <div className="mt-1 flex justify-between border-t border-ink-200 pt-1 font-medium">
            <span>Net certified</span>
            <span className="tabular-nums">
              {netCertified !== null ? money(netCertified, currency) : "—"}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-ink-500">Variance vs application ({money(valuation.netDue, currency)})</span>
            <span
              className={
                variance === null || variance === 0
                  ? "tabular-nums text-ink-600"
                  : variance > 0
                    ? "tabular-nums font-medium text-emerald-600"
                    : "tabular-nums font-medium text-red-600"
              }
            >
              {variance === null ? "—" : `${variance > 0 ? "+" : ""}${money(variance, currency)}`}
            </span>
          </div>
        </div>
        <Field
          label="Variance reason"
          hint={variance !== null && variance !== 0 ? "Explain the difference from the application." : undefined}
        >
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        <Field label="Payment due date">
          <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
        </Field>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy || !valid}>
            {busy ? "Certifying…" : "Issue certificate"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/* ------------------------------ Valuations tab ----------------------------- */

export default function ValuationsTab({
  projectId,
  boqs,
  onMutate,
}: {
  projectId: string;
  boqs: BoqRow[] | null;
  onMutate: () => void;
}) {
  const [rows, setRows] = useState<ValuationRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ValuationDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [certifyOpen, setCertifyOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);

  const [boqId, setBoqId] = useState("");
  const [valuationDate, setValuationDate] = useState(todayIso());
  const [basis, setBasis] = useState<string>("remeasure");
  const [retention, setRetention] = useState("5");
  const [createError, setCreateError] = useState<string | null>(null);

  const [matOn, setMatOn] = useState("0");
  const [matOff, setMatOff] = useState("0");

  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;
  const detailRef = useRef(detail);
  detailRef.current = detail;
  const saveTimer = useRef<number | null>(null);

  const loadList = useCallback(async () => {
    setError(null);
    try {
      const res = await api.get<ListResponse<ValuationRow>>(
        `/api/v1/projects/${projectId}/valuations?pageSize=100`,
      );
      setRows(res?.items ?? []);
    } catch (err) {
      setRows([]);
      setError(err instanceof Error ? err.message : "Failed to load valuations");
    }
  }, [projectId]);

  const loadDetail = useCallback(async (id: string) => {
    setDetailError(null);
    try {
      const res = await api.get<ValuationDetail>(`/api/v1/valuations/${id}`);
      setDetail(res);
      setMatOn(String(res?.materialsOnSite ?? 0));
      setMatOff(String(res?.materialsOffSite ?? 0));
      setDrafts({});
    } catch (err) {
      setDetail(null);
      setDetailError(err instanceof Error ? err.message : "Failed to load the valuation");
    }
  }, []);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  useEffect(() => {
    if (selectedId) void loadDetail(selectedId);
    else setDetail(null);
  }, [selectedId, loadDetail]);

  const currencyOf = useCallback(
    (bId: string | undefined) => boqs?.find((b) => b.id === bId)?.currency ?? "USD",
    [boqs],
  );

  /* ------------------------------- line saves ------------------------------ */

  async function saveLines() {
    const d = detailRef.current;
    if (!d || d.status !== "draft") return;
    const entries = Object.entries(draftsRef.current);
    const lines: Record<string, unknown>[] = [];
    for (const [itemId, raw] of entries) {
      const n = parseNum(raw);
      if (typeof n !== "number") continue;
      if (d.basis === "remeasure") lines.push({ boqItemId: itemId, qtyToDate: Math.max(0, n) });
      else lines.push({ boqItemId: itemId, percentToDate: Math.min(100, Math.max(0, n)) });
    }
    if (lines.length === 0) return;
    setSaving(true);
    setDetailError(null);
    try {
      const res = await api.put<ValuationDetail>(`/api/v1/valuations/${d.id}/lines`, { lines });
      setDetail(res);
      setDrafts((cur) => {
        const next = { ...cur };
        for (const [k, v] of entries) if (next[k] === v) delete next[k];
        return next;
      });
    } catch (err) {
      setDetailError(err instanceof ApiClientError ? err.message : "Failed to save the lines.");
    } finally {
      setSaving(false);
    }
  }

  function onLineChange(itemId: string, raw: string) {
    setDrafts((d) => ({ ...d, [itemId]: raw }));
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => void saveLines(), 700);
  }

  function flushLines() {
    if (saveTimer.current !== null) {
      window.clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    void saveLines();
  }

  useEffect(
    () => () => {
      if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    },
    [],
  );

  async function saveMaterials() {
    const d = detailRef.current;
    if (!d || d.status !== "draft") return;
    const on = parseNum(matOn);
    const off = parseNum(matOff);
    const payload: Record<string, unknown> = {};
    if (typeof on === "number" && on !== d.materialsOnSite) payload["materialsOnSite"] = Math.max(0, on);
    if (typeof off === "number" && off !== d.materialsOffSite)
      payload["materialsOffSite"] = Math.max(0, off);
    if (Object.keys(payload).length === 0) return;
    setDetailError(null);
    try {
      const res = await api.patch<ValuationDetail>(`/api/v1/valuations/${d.id}`, payload);
      setDetail(res);
    } catch (err) {
      setDetailError(err instanceof ApiClientError ? err.message : "Failed to save materials.");
    }
  }

  async function submitValuation() {
    const d = detailRef.current;
    if (!d) return;
    setBusy(true);
    setDetailError(null);
    try {
      await api.post(`/api/v1/valuations/${d.id}/submit`);
      await loadDetail(d.id);
      await loadList();
      onMutate();
    } catch (err) {
      setDetailError(err instanceof ApiClientError ? err.message : "Failed to submit.");
    } finally {
      setBusy(false);
    }
  }

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setCreateError(null);
    setBusy(true);
    try {
      const payload: Record<string, unknown> = { boqId, valuationDate, basis };
      const r = parseNum(retention);
      if (typeof r === "number") payload["retentionPercent"] = Math.min(100, Math.max(0, r));
      const created = await api.post<ValuationDetail>(
        `/api/v1/projects/${projectId}/valuations`,
        payload,
      );
      setCreateOpen(false);
      await loadList();
      onMutate();
      if (created?.id) setSelectedId(created.id);
    } catch (err) {
      setCreateError(err instanceof ApiClientError ? err.message : "Failed to create the valuation.");
    } finally {
      setBusy(false);
    }
  }

  /* -------------------------------- list view ------------------------------ */

  if (!selectedId) {
    const usableBoqs = (boqs ?? []).filter((b) => b.status !== "draft");
    return (
      <div>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-ink-900">Interim valuations</h2>
          <Button onClick={() => setCreateOpen(true)}>New valuation</Button>
        </div>
        <ErrorAlert message={error} />
        {rows === null ? (
          <Spinner />
        ) : rows.length === 0 ? (
          <EmptyState
            title="No valuations yet"
            hint="Prepare the first interim valuation against an issued BoQ."
            action={<Button onClick={() => setCreateOpen(true)}>Create the first valuation</Button>}
          />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>No.</Th>
                <Th>Date</Th>
                <Th>Basis</Th>
                <Th>Status</Th>
                <Th className="text-right">Work done</Th>
                <Th className="text-right">Net due</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {rows.map((v) => (
                <tr
                  key={v.id}
                  className="cursor-pointer hover:bg-ink-50/60"
                  onClick={() => setSelectedId(v.id)}
                >
                  <Td className="whitespace-nowrap font-mono text-xs font-medium text-brand-700">
                    {padNo("VAL", v.number)}
                  </Td>
                  <Td className="whitespace-nowrap">{formatDate(v.valuationDate)}</Td>
                  <Td>{humanize(v.basis)}</Td>
                  <Td>
                    <Badge tone={valuationStatusTone(v.status)}>{humanize(v.status)}</Badge>
                  </Td>
                  <Td className="text-right tabular-nums">
                    {money(v.workDoneToDate, currencyOf(v.boqId))}
                  </Td>
                  <Td className="text-right font-medium tabular-nums">
                    {money(v.netDue, currencyOf(v.boqId))}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}

        <Modal open={createOpen} title="New valuation" onClose={() => setCreateOpen(false)}>
          <ErrorAlert message={createError} />
          <form onSubmit={onCreate} className="space-y-4">
            <Field
              label="Bill of Quantities"
              hint={usableBoqs.length === 0 ? "Issue a BoQ first — valuations run against an issued BQ." : undefined}
            >
              <Select required value={boqId} onChange={(e) => setBoqId(e.target.value)}>
                <option value="">— select —</option>
                {(usableBoqs.length > 0 ? usableBoqs : (boqs ?? [])).map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name} ({humanize(b.status)})
                  </option>
                ))}
              </Select>
            </Field>
            <div className="grid grid-cols-3 gap-4">
              <Field label="Valuation date">
                <Input
                  type="date"
                  required
                  value={valuationDate}
                  onChange={(e) => setValuationDate(e.target.value)}
                />
              </Field>
              <Field label="Basis">
                <Select value={basis} onChange={(e) => setBasis(e.target.value)}>
                  {VALUATION_BASES.map((b) => (
                    <option key={b} value={b}>
                      {humanize(b)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Retention %">
                <Input
                  inputMode="decimal"
                  value={retention}
                  onChange={(e) => setRetention(e.target.value)}
                />
              </Field>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setCreateOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy || !boqId}>
                {busy ? "Creating…" : "Create valuation"}
              </Button>
            </div>
          </form>
        </Modal>
      </div>
    );
  }

  /* ------------------------------- detail view ----------------------------- */

  const currency = currencyOf(detail?.boqId);
  const isDraft = detail?.status === "draft";
  const gross =
    detail !== null
      ? round2(detail.workDoneToDate + detail.materialsOnSite + detail.materialsOffSite)
      : 0;

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={() => setSelectedId(null)}>
            ← All valuations
          </Button>
          {detail ? (
            <>
              <h2 className="text-sm font-semibold text-ink-900">{padNo("VAL", detail.number)}</h2>
              <Badge tone={valuationStatusTone(detail.status)}>{humanize(detail.status)}</Badge>
              <span className="text-sm text-ink-500">
                {humanize(detail.basis)} · {formatDate(detail.valuationDate)} · retention{" "}
                {detail.retentionPercent}%
              </span>
            </>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          {saving ? <span className="text-xs text-ink-400">Saving…</span> : null}
          {detail && isDraft ? (
            <Button size="sm" disabled={busy} onClick={() => void submitValuation()}>
              Submit application
            </Button>
          ) : null}
          {detail && detail.status === "submitted" ? (
            <Button size="sm" disabled={busy} onClick={() => setCertifyOpen(true)}>
              Certify…
            </Button>
          ) : null}
        </div>
      </div>

      <ErrorAlert message={detailError} />

      {detail === null ? (
        <Spinner />
      ) : (
        <>
          {(detail.lines?.length ?? 0) === 0 ? (
            <EmptyState
              title="No valuation lines"
              hint="The BoQ has no leaf items to value — add measured items to the BQ first."
            />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Code</Th>
                  <Th>Description</Th>
                  <Th className="text-right">BQ qty</Th>
                  <Th className="text-right">BQ amount</Th>
                  <Th className="text-right">
                    {detail.basis === "remeasure" ? "Qty to date" : "% to date"}
                  </Th>
                  <Th className="text-right">Amount to date</Th>
                  <Th className="text-right">Previous</Th>
                  <Th className="text-right">This period</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {(detail.lines ?? []).map((l) => {
                  const raw =
                    drafts[l.boqItemId] ??
                    (detail.basis === "remeasure"
                      ? l.qtyToDate !== null
                        ? String(l.qtyToDate)
                        : ""
                      : l.percentToDate !== null
                        ? String(l.percentToDate)
                        : "");
                  return (
                    <tr key={l.id} className="hover:bg-ink-50/60">
                      <Td className="whitespace-nowrap font-mono text-xs">{l.code ?? "—"}</Td>
                      <Td>
                        {l.description ?? "—"}
                        {l.unit ? <span className="ml-1 text-xs text-ink-400">({l.unit})</span> : null}
                      </Td>
                      <Td className="text-right tabular-nums">{qty(l.boqQuantity ?? null)}</Td>
                      <Td className="text-right tabular-nums">{money(l.boqAmount ?? null, currency)}</Td>
                      <Td className="text-right">
                        {isDraft ? (
                          <input
                            type="text"
                            inputMode="decimal"
                            value={raw}
                            onChange={(e) => onLineChange(l.boqItemId, e.target.value)}
                            onBlur={flushLines}
                            className="w-24 rounded border border-ink-200 px-2 py-1 text-right text-sm tabular-nums focus:border-brand-500 focus:outline-none"
                          />
                        ) : (
                          <span className="tabular-nums">
                            {detail.basis === "remeasure"
                              ? qty(l.qtyToDate)
                              : l.percentToDate !== null
                                ? `${l.percentToDate}%`
                                : "—"}
                          </span>
                        )}
                      </Td>
                      <Td className="text-right tabular-nums">{money(l.amountToDate, currency)}</Td>
                      <Td className="text-right tabular-nums text-ink-500">
                        {money(l.previousAmount, currency)}
                      </Td>
                      <Td className="text-right font-medium tabular-nums">
                        {money(l.thisPeriod, currency)}
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          )}

          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <Card>
              <CardBody>
                <h3 className="mb-3 text-sm font-semibold text-ink-900">Materials</h3>
                <div className="grid grid-cols-2 gap-4">
                  <Field label="Materials on site (#166)">
                    <Input
                      inputMode="decimal"
                      value={matOn}
                      disabled={!isDraft}
                      onChange={(e) => setMatOn(e.target.value)}
                      onBlur={() => void saveMaterials()}
                    />
                  </Field>
                  <Field label="Materials off site (#167)">
                    <Input
                      inputMode="decimal"
                      value={matOff}
                      disabled={!isDraft}
                      onChange={(e) => setMatOff(e.target.value)}
                      onBlur={() => void saveMaterials()}
                    />
                  </Field>
                </div>
              </CardBody>
            </Card>
            <Card>
              <CardBody>
                <h3 className="mb-3 text-sm font-semibold text-ink-900">Application totals</h3>
                <dl className="space-y-1 text-sm">
                  <div className="flex justify-between">
                    <dt className="text-ink-500">Work done to date</dt>
                    <dd className="tabular-nums">{money(detail.workDoneToDate, currency)}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-ink-500">Materials on site</dt>
                    <dd className="tabular-nums">{money(detail.materialsOnSite, currency)}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-ink-500">Materials off site</dt>
                    <dd className="tabular-nums">{money(detail.materialsOffSite, currency)}</dd>
                  </div>
                  <div className="flex justify-between border-t border-ink-100 pt-1">
                    <dt className="text-ink-500">Gross valuation</dt>
                    <dd className="tabular-nums">{money(gross, currency)}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-ink-500">Retention held ({detail.retentionPercent}%)</dt>
                    <dd className="tabular-nums text-red-600">
                      −{money(detail.retentionHeld, currency)}
                    </dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-ink-500">Previous net certified</dt>
                    <dd className="tabular-nums text-red-600">
                      −{money(detail.previousNet, currency)}
                    </dd>
                  </div>
                  <div className="mt-1 flex items-center justify-between border-t border-ink-200 pt-2">
                    <dt className="text-sm font-semibold uppercase tracking-wide text-ink-900">
                      Net due
                    </dt>
                    <dd className="text-xl font-bold tabular-nums text-brand-700">
                      {money(detail.netDue, currency)}
                    </dd>
                  </div>
                </dl>
              </CardBody>
            </Card>
          </div>

          {certifyOpen ? (
            <CertifyModal
              valuation={detail}
              currency={currency}
              open={certifyOpen}
              onClose={() => setCertifyOpen(false)}
              onCertified={() => {
                setCertifyOpen(false);
                void loadDetail(detail.id);
                void loadList();
                onMutate();
              }}
            />
          ) : null}
        </>
      )}
    </div>
  );
}
