/**
 * Worker register (#667-670, #674) — verified identity, employer, contract
 * language and agreed rate, with modern-slavery indicators raised against a
 * worker from the same screen (#671-675).
 */
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { LABOUR_RISK_INDICATORS, WORKER_STATUSES } from "@constructos/shared";
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
import { formatDate } from "../format";
import {
  IndicatorBadge,
  LoadError,
  VerifiedChip,
  fmtMoney,
  fmtNum,
  isoToday,
  label,
  severityTone,
  workerStatusTone,
  type ListResponse,
  type VendorRow,
  type WorkerDetail,
  type WorkerRow,
} from "./workforceShared";

const SOURCES = ["audit", "worker_report", "detector", "inspection"] as const;

export default function RegisterTab({
  projectId,
  vendors,
  onMutate,
}: {
  projectId: string;
  vendors: VendorRow[];
  onMutate: () => void;
}) {
  const base = `/api/v1/projects/${projectId}`;
  const [rows, setRows] = useState<WorkerRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [vendorFilter, setVendorFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [tradeFilter, setTradeFilter] = useState("");
  const [riskOnly, setRiskOnly] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    const params = new URLSearchParams({ pageSize: "200" });
    if (vendorFilter) params.set("vendorId", vendorFilter);
    if (statusFilter) params.set("status", statusFilter);
    if (tradeFilter.trim()) params.set("trade", tradeFilter.trim());
    if (riskOnly) params.set("riskFlagged", "true");
    try {
      const res = await api.get<ListResponse<WorkerRow>>(`${base}/workers?${params.toString()}`);
      setRows(res.items);
      setTotal(res.total);
    } catch (err) {
      setRows([]);
      setError(err instanceof Error ? err.message : "Failed to load the worker register");
    }
  }, [base, vendorFilter, statusFilter, tradeFilter, riskOnly]);

  useEffect(() => {
    void load();
  }, [load]);

  /* ------------------------------ create modal ----------------------------- */

  const [createOpen, setCreateOpen] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    reference: "",
    fullName: "",
    dateOfBirth: "",
    nationality: "",
    vendorId: "",
    trade: "",
    contractLanguage: "",
    recruitmentAgency: "",
    agreedDailyRate: "",
    currency: "USD",
    accommodationRef: "",
    inductedAt: isoToday(),
    idVerified: false,
    biometricEnrolled: false,
    contractIssued: false,
  });

  function openCreate() {
    setCreateError(null);
    setForm({
      reference: "",
      fullName: "",
      dateOfBirth: "",
      nationality: "",
      vendorId: vendors[0]?.id ?? "",
      trade: "",
      contractLanguage: "",
      recruitmentAgency: "",
      agreedDailyRate: "",
      currency: "USD",
      accommodationRef: "",
      inductedAt: isoToday(),
      idVerified: false,
      biometricEnrolled: false,
      contractIssued: false,
    });
    setCreateOpen(true);
  }

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setCreateError(null);
    setBusy(true);
    try {
      const payload: Record<string, unknown> = {
        reference: form.reference.trim(),
        fullName: form.fullName.trim(),
        idVerified: form.idVerified,
        biometricEnrolled: form.biometricEnrolled,
        contractIssued: form.contractIssued,
      };
      if (form.dateOfBirth) payload["dateOfBirth"] = form.dateOfBirth;
      if (form.nationality.trim()) payload["nationality"] = form.nationality.trim();
      if (form.vendorId) payload["vendorId"] = form.vendorId;
      if (form.trade.trim()) payload["trade"] = form.trade.trim();
      if (form.contractLanguage.trim()) payload["contractLanguage"] = form.contractLanguage.trim();
      if (form.recruitmentAgency.trim())
        payload["recruitmentAgency"] = form.recruitmentAgency.trim();
      if (form.agreedDailyRate) payload["agreedDailyRate"] = Number(form.agreedDailyRate);
      if (form.currency.trim()) payload["currency"] = form.currency.trim().toUpperCase();
      if (form.accommodationRef.trim()) payload["accommodationRef"] = form.accommodationRef.trim();
      if (form.inductedAt) payload["inductedAt"] = form.inductedAt;
      await api.post<WorkerRow>(`${base}/workers`, payload);
      setCreateOpen(false);
      await load();
      onMutate();
    } catch (err) {
      setCreateError(
        err instanceof ApiClientError ? err.message : "Failed to add the worker to the register.",
      );
    } finally {
      setBusy(false);
    }
  }

  /* ------------------------------ detail modal ----------------------------- */

  const [detail, setDetail] = useState<WorkerDetail | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);

  const loadDetail = useCallback(
    async (id: string) => {
      setDetailError(null);
      setDetail(null);
      try {
        setDetail(await api.get<WorkerDetail>(`${base}/workers/${id}`));
      } catch (err) {
        setDetailError(err instanceof Error ? err.message : "Failed to load the worker");
      }
    },
    [base],
  );

  useEffect(() => {
    if (detailId) void loadDetail(detailId);
  }, [detailId, loadDetail]);

  const [flagIndicator, setFlagIndicator] = useState<string>(LABOUR_RISK_INDICATORS[0]);
  const [flagSource, setFlagSource] = useState<string>("worker_report");
  const [flagDetail, setFlagDetail] = useState("");
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [resolution, setResolution] = useState("");

  async function resolveFlag(flagId: string) {
    if (!detailId || !resolution.trim()) return;
    setBusy(true);
    setDetailError(null);
    try {
      await api.post(`${base}/labour-risk-flags/${flagId}/resolve`, {
        resolution: resolution.trim(),
      });
      setResolvingId(null);
      setResolution("");
      await loadDetail(detailId);
      await load();
      onMutate();
    } catch (err) {
      setDetailError(
        err instanceof ApiClientError ? err.message : "Failed to resolve the indicator.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function raiseFlag() {
    if (!detailId) return;
    setBusy(true);
    setDetailError(null);
    try {
      await api.post(`${base}/labour-risk-flags`, {
        workerId: detailId,
        indicator: flagIndicator,
        source: flagSource,
        detail: flagDetail.trim() || null,
      });
      setFlagDetail("");
      await loadDetail(detailId);
      await load();
      onMutate();
    } catch (err) {
      setDetailError(err instanceof ApiClientError ? err.message : "Failed to raise the flag.");
    } finally {
      setBusy(false);
    }
  }

  async function changeStatus(status: string) {
    if (!detailId) return;
    setBusy(true);
    setDetailError(null);
    try {
      await api.post(`${base}/workers/${detailId}/status`, { status });
      await loadDetail(detailId);
      await load();
      onMutate();
    } catch (err) {
      setDetailError(err instanceof ApiClientError ? err.message : "Failed to change the status.");
    } finally {
      setBusy(false);
    }
  }

  /* --------------------------------- render -------------------------------- */

  const trades = [...new Set((rows ?? []).map((r) => r.trade).filter(Boolean))] as string[];

  return (
    <div>
      <Card className="mb-4">
        <CardBody className="flex flex-wrap items-end gap-3 py-3">
          <div className="w-48">
            <Field label="Employer">
              <Select value={vendorFilter} onChange={(e) => setVendorFilter(e.target.value)}>
                <option value="">All employers</option>
                {vendors.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <div className="w-40">
            <Field label="Status">
              <Select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
                <option value="">All statuses</option>
                {WORKER_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {label(s)}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <div className="w-40">
            <Field label="Trade">
              <Select value={tradeFilter} onChange={(e) => setTradeFilter(e.target.value)}>
                <option value="">All trades</option>
                {trades.map((t) => (
                  <option key={t} value={t}>
                    {label(t)}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <label className="flex items-center gap-2 pb-2 text-sm text-ink-700">
            <input
              type="checkbox"
              checked={riskOnly}
              onChange={(e) => setRiskOnly(e.target.checked)}
              className="h-4 w-4 rounded border-ink-300 text-brand-600 focus:ring-brand-500"
            />
            Open risk flags only
          </label>
          <div className="ml-auto pb-1">
            <Button onClick={openCreate}>Add worker</Button>
          </div>
        </CardBody>
      </Card>

      <ErrorAlert message={error} />

      {rows !== null && rows.length === 0 && error ? (
        <LoadError message={error} onRetry={() => void load()} />
      ) : rows === null ? (
        <Spinner label="Loading the worker register…" />
      ) : rows.length === 0 ? (
        <EmptyState
          title={riskOnly ? "No workers carry an open risk flag" : "No workers on the register"}
          hint={
            riskOnly
              ? "Every worker on this project is currently free of unresolved labour-rights indicators."
              : "Enrol workers with verified identity, employer and agreed rate — the register is what payroll is reconciled against."
          }
          action={riskOnly ? undefined : <Button onClick={openCreate}>Add the first worker</Button>}
        />
      ) : (
        <>
          <p className="mb-2 text-xs text-ink-500">
            {rows.length} of {total} worker{total === 1 ? "" : "s"}
          </p>
          <Table>
            <thead>
              <tr>
                <Th>Reference</Th>
                <Th>Worker</Th>
                <Th>Employer</Th>
                <Th>Trade</Th>
                <Th className="text-right">Agreed rate</Th>
                <Th>Verification</Th>
                <Th>Status</Th>
                <Th className="text-right">Flags</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {rows.map((w) => (
                <tr
                  key={w.id}
                  className="cursor-pointer hover:bg-ink-50"
                  onClick={() => setDetailId(w.id)}
                >
                  <Td className="font-mono text-xs tabular-nums text-ink-600">{w.reference}</Td>
                  <Td className="font-medium text-ink-900">{w.fullName}</Td>
                  <Td className="text-ink-600">{w.vendorName ?? "—"}</Td>
                  <Td className="text-ink-600">{label(w.trade)}</Td>
                  <Td className="text-right tabular-nums">
                    {w.agreedDailyRate === null ? (
                      <span className="text-ink-300" title="No agreed rate — wage checks abstain">
                        not set
                      </span>
                    ) : (
                      fmtMoney(w.agreedDailyRate, w.currency)
                    )}
                  </Td>
                  <Td>
                    <span className="flex flex-wrap gap-0.5">
                      <VerifiedChip ok={w.idVerified === 1} label="ID" />
                      <VerifiedChip ok={w.biometricEnrolled === 1} label="Bio" />
                      <VerifiedChip ok={w.contractIssued === 1} label="Contract" />
                    </span>
                  </Td>
                  <Td>
                    <Badge tone={workerStatusTone(w.status)}>{label(w.status)}</Badge>
                  </Td>
                  <Td className="text-right tabular-nums">
                    {w.openRiskFlags > 0 ? (
                      <span
                        title={`${w.openRiskFlags} unresolved labour-rights indicator${
                          w.openRiskFlags === 1 ? "" : "s"
                        } against this worker`}
                      >
                        <Badge tone="red">{w.openRiskFlags}</Badge>
                      </span>
                    ) : (
                      <span className="text-ink-300">0</span>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </>
      )}

      {/* ------------------------------ create modal ----------------------------- */}
      <Modal open={createOpen} title="Add worker" onClose={() => setCreateOpen(false)} wide>
        <ErrorAlert message={createError} />
        <form onSubmit={onCreate} className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Reference" hint="Badge or worker number — unique on this project.">
              <Input
                required
                value={form.reference}
                onChange={(e) => setForm({ ...form, reference: e.target.value })}
                placeholder="W-1042"
              />
            </Field>
            <Field label="Full name">
              <Input
                required
                value={form.fullName}
                onChange={(e) => setForm({ ...form, fullName: e.target.value })}
              />
            </Field>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field
              label="Date of birth"
              hint="The server refuses any date of birth under 18 at the induction date, and records the attempt as a critical signal (#670)."
            >
              <Input
                type="date"
                value={form.dateOfBirth}
                onChange={(e) => setForm({ ...form, dateOfBirth: e.target.value })}
              />
            </Field>
            <Field label="Nationality">
              <Input
                value={form.nationality}
                onChange={(e) => setForm({ ...form, nationality: e.target.value })}
              />
            </Field>
            <Field label="Inducted">
              <Input
                type="date"
                value={form.inductedAt}
                onChange={(e) => setForm({ ...form, inductedAt: e.target.value })}
              />
            </Field>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Employer (vendor)">
              <Select
                value={form.vendorId}
                onChange={(e) => setForm({ ...form, vendorId: e.target.value })}
              >
                <option value="">Unassigned</option>
                {vendors.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Trade">
              <Input
                value={form.trade}
                onChange={(e) => setForm({ ...form, trade: e.target.value })}
                placeholder="steelfixer"
              />
            </Field>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
            <Field label="Agreed daily rate" hint="Drives wage verification (#677).">
              <Input
                type="number"
                min="0"
                step="any"
                value={form.agreedDailyRate}
                onChange={(e) => setForm({ ...form, agreedDailyRate: e.target.value })}
              />
            </Field>
            <Field label="Currency">
              <Input
                maxLength={3}
                value={form.currency}
                onChange={(e) => setForm({ ...form, currency: e.target.value })}
              />
            </Field>
            <Field label="Contract language" hint="#674">
              <Input
                value={form.contractLanguage}
                onChange={(e) => setForm({ ...form, contractLanguage: e.target.value })}
                placeholder="Nepali"
              />
            </Field>
            <Field label="Accommodation">
              <Input
                value={form.accommodationRef}
                onChange={(e) => setForm({ ...form, accommodationRef: e.target.value })}
                placeholder="Camp 2 / Block C"
              />
            </Field>
          </div>
          <Field label="Recruitment agency" hint="Registered for audit (#673).">
            <Input
              value={form.recruitmentAgency}
              onChange={(e) => setForm({ ...form, recruitmentAgency: e.target.value })}
            />
          </Field>
          <div className="flex flex-wrap gap-4 rounded-md bg-ink-50 px-3 py-2.5">
            {(
              [
                ["idVerified", "Identity verified"],
                ["biometricEnrolled", "Biometric enrolled"],
                ["contractIssued", "Contract issued in the worker's language"],
              ] as const
            ).map(([key, text]) => (
              <label key={key} className="flex items-center gap-2 text-sm text-ink-700">
                <input
                  type="checkbox"
                  checked={form[key]}
                  onChange={(e) => setForm({ ...form, [key]: e.target.checked })}
                  className="h-4 w-4 rounded border-ink-300 text-brand-600 focus:ring-brand-500"
                />
                {text}
              </label>
            ))}
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="secondary" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Adding…" : "Add worker"}
            </Button>
          </div>
        </form>
      </Modal>

      {/* ------------------------------ detail modal ----------------------------- */}
      <Modal
        open={detailId !== null}
        title={detail ? `${detail.reference} — ${detail.fullName}` : "Worker"}
        onClose={() => {
          setDetailId(null);
          setDetail(null);
          setResolvingId(null);
          setResolution("");
        }}
        wide
      >
        <ErrorAlert message={detailError} />
        {detail === null ? (
          <Spinner />
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Detail label="Employer" value={detail.vendorName ?? "Unassigned"} />
              <Detail label="Trade" value={label(detail.trade)} />
              <Detail
                label="Age"
                value={detail.age === null ? "Not recorded" : `${detail.age} years`}
              />
              <Detail
                label="Agreed rate"
                value={
                  detail.agreedDailyRate === null
                    ? "Not set"
                    : `${fmtMoney(detail.agreedDailyRate, detail.currency)} / day`
                }
              />
              <Detail label="Nationality" value={detail.nationality ?? "—"} />
              <Detail label="Contract language" value={detail.contractLanguage ?? "—"} />
              <Detail label="Recruitment agency" value={detail.recruitmentAgency ?? "—"} />
              <Detail label="Accommodation" value={detail.accommodationRef ?? "—"} />
            </div>

            <div className="flex flex-wrap items-center gap-2 rounded-md bg-ink-50 px-3 py-2">
              <VerifiedChip ok={detail.idVerified === 1} label="Identity verified" />
              <VerifiedChip ok={detail.biometricEnrolled === 1} label="Biometric enrolled" />
              <VerifiedChip ok={detail.contractIssued === 1} label="Contract issued" />
              <span className="ml-auto flex items-center gap-2">
                <span className="text-xs text-ink-500">Status</span>
                <Select
                  value={detail.status}
                  disabled={busy}
                  onChange={(e) => void changeStatus(e.target.value)}
                  className="w-36"
                >
                  {WORKER_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {label(s)}
                    </option>
                  ))}
                </Select>
              </span>
            </div>

            <section>
              <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-ink-500">
                Labour-rights indicators
              </h3>
              {detail.riskFlags.length === 0 ? (
                <p className="rounded-md border border-dashed border-ink-200 px-3 py-2 text-xs text-ink-400">
                  No indicators raised against this worker.
                </p>
              ) : (
                <ul className="space-y-1.5">
                  {detail.riskFlags.map((f) => (
                    <li
                      key={f.id}
                      className="rounded-md bg-white px-3 py-2 text-xs ring-1 ring-ink-100"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <IndicatorBadge indicator={f.indicator} />
                        <Badge tone={severityTone(f.severity)}>{label(f.severity)}</Badge>
                        <span className="text-ink-600">via {label(f.source)}</span>
                        {f.detail ? <span className="text-ink-500">— {f.detail}</span> : null}
                        <span className="ml-auto flex items-center gap-2">
                          {f.resolvedAt ? (
                            <span title={f.resolution ?? undefined}>
                              <Badge tone="green">Resolved</Badge>
                            </span>
                          ) : (
                            <>
                              <Badge tone="red">Open</Badge>
                              <Button
                                size="sm"
                                variant="secondary"
                                onClick={() => {
                                  setResolution("");
                                  setResolvingId(resolvingId === f.id ? null : f.id);
                                }}
                              >
                                Resolve
                              </Button>
                            </>
                          )}
                        </span>
                      </div>
                      {f.resolvedAt && f.resolution ? (
                        <p className="mt-1 text-ink-500">Resolved: {f.resolution}</p>
                      ) : null}
                      {resolvingId === f.id ? (
                        <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-ink-100 pt-2">
                          <Input
                            className="min-w-56 flex-1"
                            autoFocus
                            value={resolution}
                            onChange={(e) => setResolution(e.target.value)}
                            placeholder="What was actually done — passports returned, debt written off, permit issued"
                          />
                          <Button
                            size="sm"
                            disabled={busy || !resolution.trim()}
                            onClick={() => void resolveFlag(f.id)}
                          >
                            {busy ? "Saving…" : "Save"}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setResolvingId(null)}
                          >
                            Cancel
                          </Button>
                          <span className="basis-full text-[11px] text-ink-400">
                            The signal stays on the register — only its disposition moves to
                            closed, with this note attached.
                          </span>
                        </div>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
              <div className="mt-2 flex flex-wrap items-end gap-2 rounded-md bg-ink-50 px-3 py-2.5">
                <div className="w-52">
                  <Field label="Raise indicator">
                    <Select
                      value={flagIndicator}
                      onChange={(e) => setFlagIndicator(e.target.value)}
                    >
                      {LABOUR_RISK_INDICATORS.map((i) => (
                        <option key={i} value={i}>
                          {label(i)}
                        </option>
                      ))}
                    </Select>
                  </Field>
                </div>
                <div className="w-40">
                  <Field label="Source">
                    <Select value={flagSource} onChange={(e) => setFlagSource(e.target.value)}>
                      {SOURCES.map((s) => (
                        <option key={s} value={s}>
                          {label(s)}
                        </option>
                      ))}
                    </Select>
                  </Field>
                </div>
                <div className="min-w-48 flex-1">
                  <Field label="Detail">
                    <Textarea
                      className="min-h-0 py-1.5"
                      rows={1}
                      value={flagDetail}
                      onChange={(e) => setFlagDetail(e.target.value)}
                      placeholder="What was observed, by whom, when"
                    />
                  </Field>
                </div>
                <Button size="sm" disabled={busy} onClick={() => void raiseFlag()}>
                  Raise
                </Button>
              </div>
            </section>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <section>
                <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-ink-500">
                  Recent site access
                </h3>
                {detail.recentAccess.length === 0 ? (
                  <p className="rounded-md border border-dashed border-ink-200 px-3 py-2 text-xs text-ink-400">
                    No access records ingested for this worker.
                  </p>
                ) : (
                  <ul className="max-h-44 space-y-1 overflow-y-auto text-xs">
                    {detail.recentAccess.map((a) => (
                      <li
                        key={a.id}
                        className="flex items-center justify-between rounded bg-white px-2.5 py-1.5 ring-1 ring-ink-100"
                      >
                        <span className="tabular-nums text-ink-700">{a.accessDate}</span>
                        <span className="tabular-nums text-ink-500">
                          {a.firstIn ?? "—"} → {a.lastOut ?? "—"}
                          {a.hoursOnSite !== null ? ` · ${fmtNum(a.hoursOnSite, 1)}h` : ""}
                        </span>
                        <span className="text-ink-400">{label(a.source)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
              <section>
                <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-ink-500">
                  Latest payroll
                </h3>
                {detail.latestPayroll === null ? (
                  <p className="rounded-md border border-dashed border-ink-200 px-3 py-2 text-xs text-ink-400">
                    No payroll ingested for this worker.
                  </p>
                ) : (
                  <div className="space-y-1 rounded-md bg-white px-3 py-2 text-xs ring-1 ring-ink-100">
                    <div className="flex justify-between">
                      <span className="text-ink-500">Period</span>
                      <span className="tabular-nums text-ink-800">
                        {formatDate(detail.latestPayroll.periodStart)} →{" "}
                        {formatDate(detail.latestPayroll.periodEnd)}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-ink-500">Days claimed</span>
                      <span className="tabular-nums text-ink-800">
                        {fmtNum(detail.latestPayroll.daysClaimed, 1)}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-ink-500">Gross / deductions</span>
                      <span className="tabular-nums text-ink-800">
                        {fmtMoney(detail.latestPayroll.grossPay, detail.latestPayroll.currency)} /{" "}
                        {fmtMoney(detail.latestPayroll.deductions, detail.latestPayroll.currency)}
                      </span>
                    </div>
                    <div className="flex justify-between font-semibold">
                      <span className="text-ink-600">Net paid</span>
                      <span className="tabular-nums text-ink-900">
                        {fmtMoney(detail.latestPayroll.netPay, detail.latestPayroll.currency)}
                      </span>
                    </div>
                    {detail.latestPayroll.wpsReference ? (
                      <div className="flex justify-between">
                        <span className="text-ink-500">WPS reference</span>
                        <span className="font-mono text-ink-700">
                          {detail.latestPayroll.wpsReference}
                        </span>
                      </div>
                    ) : null}
                  </div>
                )}
              </section>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

function Detail({ label: detailLabel, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[11px] font-medium uppercase tracking-wide text-ink-400">
        {detailLabel}
      </div>
      <div className="text-sm text-ink-800">{value}</div>
    </div>
  );
}
