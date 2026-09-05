/**
 * Claims workspace (spec Domain D #304-320): four-limb
 * cause → effect → entitlement → quantum chain, prolongation build-up
 * (#299-301), chronology auto-assembly (#318) and independent assessment
 * (#310 — the self-assessment 403 surfaces as an info banner, not an error).
 */
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { CLAIM_KINDS } from "@constructos/shared";
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
import { formatDate, formatDateTime, formatMoney, humanize } from "../format";
import {
  CLAIM_NEXT_STATUSES,
  claimKindTone,
  claimStatusTone,
  clmLabel,
  deLabel,
  Drawer,
  InfoBanner,
  SectionTitle,
  TiaChip,
  type ClaimDetail,
  type ClaimRow,
  type SufficiencyResult,
  type ContractLite,
  type DelayEventRow,
  type ListResponse,
  type ProlongationResult,
} from "./forensicsShared";

const PAGE_SIZE = 25;

const CHAIN_LIMBS = [
  { key: "cause" as const, label: "Cause", hint: "What happened — the originating event(s)." },
  { key: "effect" as const, label: "Effect", hint: "How the works were actually impacted." },
  {
    key: "entitlement" as const,
    label: "Entitlement",
    hint: "The contractual / legal basis for relief.",
  },
  { key: "quantum" as const, label: "Quantum", hint: "The time and money consequences claimed." },
];

const SOURCE_TONES: Record<string, string> = {
  delay_event: "red",
  contract_event: "blue",
  rfi: "violet",
  daily_log: "gray",
  variation: "amber",
};

export default function ClaimsTab({
  projectId,
  focusId,
}: {
  projectId: string;
  /** deep link from ⌘K search: open this claim's drawer once, on arrival */
  focusId?: string | null;
}) {
  const base = `/api/v1/projects/${projectId}`;

  const [items, setItems] = useState<ClaimRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
      const res = await api.get<ListResponse<ClaimRow>>(`${base}/claims?${params}`);
      setItems(res.items);
      setTotal(res.total);
    } catch (err) {
      setItems([]);
      setError(err instanceof Error ? err.message : "Failed to load claims");
    }
  }, [base, page]);

  useEffect(() => {
    void load();
  }, [load]);

  /* ----------------------------- create modal ----------------------------- */

  const [createOpen, setCreateOpen] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cTitle, setCTitle] = useState("");
  const [cKind, setCKind] = useState("delay");
  const [cContractId, setCContractId] = useState("");
  const [cClauseRef, setCClauseRef] = useState("");
  const [cDays, setCDays] = useState("");
  const [cAmount, setCAmount] = useState("");
  const [cEventIds, setCEventIds] = useState<string[]>([]);
  const [contracts, setContracts] = useState<ContractLite[]>([]);
  const [eventPool, setEventPool] = useState<DelayEventRow[]>([]);

  async function openCreate() {
    setCreateError(null);
    setCTitle("");
    setCKind("delay");
    setCContractId("");
    setCClauseRef("");
    setCDays("");
    setCAmount("");
    setCEventIds([]);
    setCreateOpen(true);
    try {
      const [con, ev] = await Promise.all([
        api.get<ListResponse<ContractLite>>(`${base}/contracts?pageSize=100`),
        api.get<ListResponse<DelayEventRow>>(`${base}/delay-events?pageSize=100`),
      ]);
      setContracts(con.items);
      setEventPool(ev.items);
    } catch {
      // optional pickers — the claim can be created without links
    }
  }

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setCreateError(null);
    setBusy(true);
    try {
      const payload: Record<string, unknown> = { title: cTitle.trim(), kind: cKind };
      if (cContractId) payload["contractId"] = cContractId;
      if (cClauseRef.trim()) payload["clauseRef"] = cClauseRef.trim();
      if (cDays.trim() && Number.isFinite(Number(cDays))) {
        payload["daysClaimed"] = Math.round(Number(cDays));
      }
      if (cAmount.trim() && Number.isFinite(Number(cAmount))) {
        payload["amountClaimed"] = Number(cAmount);
      }
      if (cEventIds.length > 0) payload["delayEventIds"] = cEventIds;
      const created = await api.post<ClaimRow>(`${base}/claims`, payload);
      setCreateOpen(false);
      setPage(1);
      await load();
      await openDrawer(created.id);
    } catch (err) {
      setCreateError(err instanceof ApiClientError ? err.message : "Failed to create the claim.");
    } finally {
      setBusy(false);
    }
  }

  /* ------------------------------ workspace drawer ------------------------------ */

  const [selected, setSelected] = useState<ClaimDetail | null>(null);
  const [drawerError, setDrawerError] = useState<string | null>(null);
  const [drawerInfo, setDrawerInfo] = useState<string | null>(null);

  const [chain, setChain] = useState<Record<string, string>>({});
  const [chainBusy, setChainBusy] = useState(false);

  const [proDays, setProDays] = useState("");
  const [proRate, setProRate] = useState("");
  const [proBusy, setProBusy] = useState(false);
  const [proResult, setProResult] = useState<ProlongationResult | null>(null);
  const [proError, setProError] = useState<string | null>(null);

  const [chronoBusy, setChronoBusy] = useState(false);

  /* --- claim assurance: sufficiency, valuation, Scott Schedule, package --- */
  const [sufficiency, setSufficiency] = useState<SufficiencyResult | null>(null);
  const [sufficiencyBusy, setSufficiencyBusy] = useState(false);
  const [valuation, setValuation] = useState({ best: "", likely: "", worst: "", probability: "" });
  const [valuationBusy, setValuationBusy] = useState(false);
  const [scottBusy, setScottBusy] = useState(false);
  const [packageInfo, setPackageInfo] = useState<{ ready: boolean; missing: string[] } | null>(null);

  const [reasonFor, setReasonFor] = useState<string | null>(null);
  const [reasonText, setReasonText] = useState("");
  const [assessOpen, setAssessOpen] = useState(false);
  const [assessDays, setAssessDays] = useState("");
  const [assessAmount, setAssessAmount] = useState("");
  const [statusBusy, setStatusBusy] = useState(false);

  async function openDrawer(id: string) {
    setDrawerError(null);
    setDrawerInfo(null);
    setProResult(null);
    setProError(null);
    try {
      const detail = await api.get<ClaimDetail>(`${base}/claims/${id}`);
      setSelected(detail);
      setChain({
        cause: detail.chain.cause ?? "",
        effect: detail.chain.effect ?? "",
        entitlement: detail.chain.entitlement ?? "",
        quantum: detail.chain.quantum ?? "",
      });
      const compDays = detail.delayEvents
        .filter((ev) => ev.compensable === 1)
        .reduce((sum, ev) => sum + ev.durationDays, 0);
      setProDays(
        detail.prolongation?.compensableDays !== undefined
          ? String(detail.prolongation.compensableDays)
          : compDays > 0
            ? String(compDays)
            : detail.daysClaimed !== null
              ? String(detail.daysClaimed)
              : "",
      );
      setProRate(
        detail.prolongation?.prelimsRatePerDay !== undefined
          ? String(detail.prolongation.prelimsRatePerDay)
          : "",
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load the claim");
    }
  }

  /*
   * Arriving from company search (or any link that names a claim) opens that
   * claim. Once per id: reopening after the user closes the drawer would trap
   * them on the record they just dismissed.
   */
  const openedFocus = useRef<string | null>(null);
  useEffect(() => {
    if (!focusId || openedFocus.current === focusId) return;
    openedFocus.current = focusId;
    void openDrawer(focusId);
    // openDrawer is stable for a given base; the id is what drives this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusId, base]);

  async function refresh() {
    if (selected) await openDrawer(selected.id);
    await load();
  }

  async function saveChain() {
    if (!selected) return;
    setDrawerError(null);
    setChainBusy(true);
    try {
      const body: Record<string, string> = {};
      for (const limb of CHAIN_LIMBS) {
        const v = (chain[limb.key] ?? "").trim();
        if (v) body[limb.key] = v;
      }
      await api.patch(`${base}/claims/${selected.id}`, { chain: body });
      await refresh();
    } catch (err) {
      setDrawerError(err instanceof ApiClientError ? err.message : "Failed to save the chain.");
    } finally {
      setChainBusy(false);
    }
  }

  async function calcProlongation() {
    if (!selected) return;
    setProError(null);
    setProResult(null);
    setProBusy(true);
    try {
      const body: Record<string, unknown> = { compensableDays: Math.round(Number(proDays) || 0) };
      if (proRate.trim() && Number.isFinite(Number(proRate))) {
        body["prelimsRatePerDay"] = Number(proRate);
      }
      const res = await api.post<ProlongationResult>(`${base}/forensics/prolongation`, body);
      setProResult(res);
    } catch (err) {
      setProError(
        err instanceof ApiClientError ? err.message : "Prolongation calculation failed.",
      );
    } finally {
      setProBusy(false);
    }
  }

  async function applyToQuantum() {
    if (!selected || !proResult) return;
    setDrawerError(null);
    try {
      await api.patch(`${base}/claims/${selected.id}`, {
        amountClaimed: proResult.amount,
        prolongation: {
          compensableDays: proResult.compensableDays,
          prelimsRatePerDay: proResult.prelimsRatePerDay,
          amount: proResult.amount,
          derivation: proResult.derivation,
        },
      });
      await refresh();
    } catch (err) {
      setDrawerError(
        err instanceof ApiClientError ? err.message : "Failed to apply the prolongation amount.",
      );
    }
  }

  async function generateChronology() {
    if (!selected) return;
    setDrawerError(null);
    setChronoBusy(true);
    try {
      await api.post(`${base}/claims/${selected.id}/chronology`);
      await refresh();
    } catch (err) {
      setDrawerError(
        err instanceof ApiClientError ? err.message : "Chronology generation failed.",
      );
    } finally {
      setChronoBusy(false);
    }
  }

  async function scoreSufficiency() {
    if (!selected) return;
    setDrawerError(null);
    setSufficiencyBusy(true);
    try {
      const res = await api.post<SufficiencyResult>(`${base}/claims/${selected.id}/sufficiency`);
      setSufficiency(res);
      await refresh();
    } catch (err) {
      setDrawerError(err instanceof ApiClientError ? err.message : "Record scoring failed.");
    } finally {
      setSufficiencyBusy(false);
    }
  }

  async function saveValuation() {
    if (!selected) return;
    setDrawerError(null);
    setValuationBusy(true);
    try {
      const num = (v: string) => (v.trim() === "" ? null : Number(v));
      await api.put(`${base}/claims/${selected.id}/valuation`, {
        quantumBest: num(valuation.best),
        quantumLikely: num(valuation.likely),
        quantumWorst: num(valuation.worst),
        successProbability: num(valuation.probability),
      });
      await refresh();
    } catch (err) {
      setDrawerError(err instanceof ApiClientError ? err.message : "The valuation could not be saved.");
    } finally {
      setValuationBusy(false);
    }
  }

  async function generateScottSchedule() {
    if (!selected) return;
    setDrawerError(null);
    setScottBusy(true);
    try {
      await api.post(`${base}/claims/${selected.id}/scott-schedule`);
      await refresh();
    } catch (err) {
      setDrawerError(err instanceof ApiClientError ? err.message : "The Scott Schedule could not be generated.");
    } finally {
      setScottBusy(false);
    }
  }

  async function checkPackage() {
    if (!selected) return;
    setDrawerError(null);
    try {
      const res = await api.get<{ completeness: { ready: boolean; missing: string[] } }>(
        `${base}/claims/${selected.id}/package`,
      );
      setPackageInfo(res.completeness);
    } catch (err) {
      setDrawerError(err instanceof ApiClientError ? err.message : "The package could not be assembled.");
    }
  }

  async function transition(status: string, extra?: Record<string, unknown>) {
    if (!selected) return;
    setDrawerError(null);
    setDrawerInfo(null);
    setStatusBusy(true);
    try {
      await api.post(`${base}/claims/${selected.id}/status`, { status, ...extra });
      setAssessOpen(false);
      await refresh();
    } catch (err) {
      if (err instanceof ApiClientError && err.status === 403) {
        // determination independence (#310) — informational, not a failure
        setAssessOpen(false);
        setDrawerInfo(err.message);
      } else {
        setDrawerError(err instanceof ApiClientError ? err.message : "Status change failed.");
      }
    } finally {
      setStatusBusy(false);
    }
  }

  function onAssess(e: FormEvent) {
    e.preventDefault();
    const extra: Record<string, unknown> = {};
    if (assessDays.trim() && Number.isFinite(Number(assessDays))) {
      extra["daysAssessed"] = Math.round(Number(assessDays));
    }
    if (assessAmount.trim() && Number.isFinite(Number(assessAmount))) {
      extra["amountAssessed"] = Number(assessAmount);
    }
    void transition("assessed", extra);
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const chainEditable = selected?.status === "draft";

  /* --------------------------------- render --------------------------------- */

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <p className="text-sm text-ink-500">
          Every claim must stand on the four-limb chain: cause → effect → entitlement → quantum.
        </p>
        <Button onClick={() => void openCreate()}>New claim</Button>
      </div>

      <ErrorAlert message={error} />

      {items === null ? (
        <Spinner />
      ) : items.length === 0 ? (
        <EmptyState
          title="No claims yet"
          hint="Assemble delay events into a claim with an explicit cause-effect-entitlement-quantum narrative."
          action={<Button onClick={() => void openCreate()}>Create the first claim</Button>}
        />
      ) : (
        <>
          <Table>
            <thead>
              <tr>
                <Th>No.</Th>
                <Th>Title</Th>
                <Th>Kind</Th>
                <Th className="text-right">Days (claimed / assessed)</Th>
                <Th className="text-right">Amount (claimed / assessed)</Th>
                <Th>Status</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {items.map((c) => (
                <tr
                  key={c.id}
                  className="cursor-pointer hover:bg-ink-50/60"
                  onClick={() => void openDrawer(c.id)}
                >
                  <Td className="whitespace-nowrap font-mono text-xs text-ink-500">
                    {clmLabel(c.number)}
                  </Td>
                  <Td className="max-w-64">
                    <span className="block truncate font-medium text-ink-900">{c.title}</span>
                  </Td>
                  <Td>
                    <Badge tone={claimKindTone(c.kind)}>{humanize(c.kind)}</Badge>
                  </Td>
                  <Td className="whitespace-nowrap text-right tabular-nums">
                    {c.daysClaimed ?? "—"}
                    <span className="text-ink-300"> / </span>
                    {c.daysAssessed ?? "—"}
                  </Td>
                  <Td className="whitespace-nowrap text-right tabular-nums">
                    {c.amountClaimed !== null ? formatMoney(c.amountClaimed) : "—"}
                    <span className="text-ink-300"> / </span>
                    {c.amountAssessed !== null ? formatMoney(c.amountAssessed) : "—"}
                  </Td>
                  <Td>
                    <Badge tone={claimStatusTone(c.status)}>{humanize(c.status)}</Badge>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>

          <div className="mt-4 flex items-center justify-between text-sm text-ink-500">
            <span>
              {total} claim{total === 1 ? "" : "s"} · page {page} of {totalPages}
            </span>
            <div className="flex gap-2">
              <Button
                variant="secondary"
                size="sm"
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                Previous
              </Button>
              <Button
                variant="secondary"
                size="sm"
                disabled={page >= totalPages}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
              </Button>
            </div>
          </div>
        </>
      )}

      {/* ------------------------------ create modal ------------------------------ */}
      <Modal open={createOpen} title="New claim" onClose={() => setCreateOpen(false)} wide>
        <ErrorAlert message={createError} />
        <form onSubmit={onCreate} className="space-y-4">
          <Field label="Title">
            <Input
              required
              value={cTitle}
              onChange={(e) => setCTitle(e.target.value)}
              placeholder="EOT & prolongation — late design release Zone B"
            />
          </Field>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field label="Kind">
              <Select value={cKind} onChange={(e) => setCKind(e.target.value)}>
                {CLAIM_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {humanize(k)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Contract">
              <Select value={cContractId} onChange={(e) => setCContractId(e.target.value)}>
                <option value="">None</option>
                {contracts.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Clause ref">
              <Input
                value={cClauseRef}
                onChange={(e) => setCClauseRef(e.target.value)}
                placeholder="20.2"
              />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Days claimed">
              <Input
                type="number"
                min="0"
                step="1"
                value={cDays}
                onChange={(e) => setCDays(e.target.value)}
              />
            </Field>
            <Field label="Amount claimed">
              <Input
                type="number"
                min="0"
                step="any"
                value={cAmount}
                onChange={(e) => setCAmount(e.target.value)}
              />
            </Field>
          </div>
          <fieldset className="rounded-md border border-ink-200 p-3">
            <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-ink-500">
              Supporting delay events
            </legend>
            {eventPool.length === 0 ? (
              <p className="text-xs text-ink-400">No delay events registered yet.</p>
            ) : (
              <div className="max-h-40 space-y-1 overflow-y-auto">
                {eventPool.map((ev) => (
                  <label key={ev.id} className="flex items-center gap-2 text-sm text-ink-700">
                    <input
                      type="checkbox"
                      checked={cEventIds.includes(ev.id)}
                      onChange={() =>
                        setCEventIds((ids) =>
                          ids.includes(ev.id)
                            ? ids.filter((i) => i !== ev.id)
                            : [...ids, ev.id],
                        )
                      }
                      className="h-4 w-4 rounded border-ink-300 text-brand-600 focus:ring-brand-500"
                    />
                    <span className="font-mono text-xs text-ink-400">{deLabel(ev.number)}</span>
                    <span className="truncate">{ev.title}</span>
                    <span className="text-xs text-ink-400">{ev.durationDays}d</span>
                  </label>
                ))}
              </div>
            )}
          </fieldset>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Creating…" : "Create claim"}
            </Button>
          </div>
        </form>
      </Modal>

      {/* ----------------------------- workspace drawer ----------------------------- */}
      {selected ? (
        <Drawer onClose={() => setSelected(null)} wide>
          <div className="mb-4 flex items-start justify-between gap-3">
            <div>
              <div className="mb-1 flex items-center gap-2">
                <span className="font-mono text-xs text-ink-400">{clmLabel(selected.number)}</span>
                <Badge tone={claimKindTone(selected.kind)}>{humanize(selected.kind)}</Badge>
                <Badge tone={claimStatusTone(selected.status)}>{humanize(selected.status)}</Badge>
                {selected.clauseRef ? (
                  <span className="font-mono text-xs text-ink-400">cl. {selected.clauseRef}</span>
                ) : null}
              </div>
              <h2 className="text-base font-semibold text-ink-900">{selected.title}</h2>
              <p className="mt-0.5 text-xs text-ink-400">
                Claimed {selected.daysClaimed ?? "—"}d ·{" "}
                {selected.amountClaimed !== null ? formatMoney(selected.amountClaimed) : "—"}
                {selected.status === "assessed" ||
                selected.status === "agreed" ||
                selected.status === "rejected"
                  ? ` — assessed ${selected.daysAssessed ?? "—"}d · ${
                      selected.amountAssessed !== null
                        ? formatMoney(selected.amountAssessed)
                        : "—"
                    }`
                  : ""}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setSelected(null)}
              className="rounded p-1 text-ink-400 hover:bg-ink-100 hover:text-ink-700"
              aria-label="Close"
            >
              ✕
            </button>
          </div>

          <ErrorAlert message={drawerError} />
          <InfoBanner message={drawerInfo} />

          {/* Four-limb chain */}
          <div className="mb-4 rounded-lg border border-ink-100 p-4">
            <div className="mb-2 flex items-center justify-between">
              <div className="text-sm font-semibold text-ink-900">
                Cause → Effect → Entitlement → Quantum
              </div>
              {chainEditable ? (
                <Button size="sm" onClick={() => void saveChain()} disabled={chainBusy}>
                  {chainBusy ? "Saving…" : "Save chain"}
                </Button>
              ) : (
                <span className="text-xs text-ink-400">frozen after submission</span>
              )}
            </div>
            <div className="space-y-3">
              {CHAIN_LIMBS.map((limb) => (
                <Field key={limb.key} label={limb.label} hint={chainEditable ? limb.hint : undefined}>
                  <Textarea
                    value={chain[limb.key] ?? ""}
                    onChange={(e) => setChain((c) => ({ ...c, [limb.key]: e.target.value }))}
                    disabled={!chainEditable}
                    className="min-h-16"
                    placeholder={limb.hint}
                  />
                </Field>
              ))}
            </div>
          </div>

          {/* Linked delay events */}
          <div className="mb-4">
            <SectionTitle>Linked delay events ({selected.delayEvents.length})</SectionTitle>
            {selected.delayEvents.length === 0 ? (
              <p className="text-xs text-ink-400">No delay events linked.</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {selected.delayEvents.map((ev) => (
                  <span
                    key={ev.id}
                    title={`${ev.title} — ${humanize(ev.cause)}, ${ev.durationDays}d from ${formatDate(ev.startDate)}`}
                    className="inline-flex items-center gap-1.5 rounded-full bg-ink-100 px-2.5 py-1 text-xs font-medium text-ink-700"
                  >
                    <span className="font-mono">{deLabel(ev.number)}</span>
                    <span className="max-w-40 truncate">{ev.title}</span>
                    <TiaChip deltaDays={ev.tiaResult?.completionDeltaDays ?? null} />
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* Prolongation widget */}
          <div className="mb-4 rounded-lg border border-ink-100 p-4">
            <div className="mb-2 text-sm font-semibold text-ink-900">Prolongation build-up</div>
            <ErrorAlert message={proError} />
            <div className="flex flex-wrap items-end gap-3">
              <div className="w-40">
                <Field label="Compensable days">
                  <Input
                    type="number"
                    min="0"
                    step="1"
                    value={proDays}
                    onChange={(e) => setProDays(e.target.value)}
                  />
                </Field>
              </div>
              <div className="w-44">
                <Field label="Prelims rate / day" hint="Blank = derive from BQ prelims">
                  <Input
                    type="number"
                    min="0"
                    step="any"
                    value={proRate}
                    onChange={(e) => setProRate(e.target.value)}
                  />
                </Field>
              </div>
              <Button
                size="sm"
                variant="secondary"
                className="mb-5"
                onClick={() => void calcProlongation()}
                disabled={proBusy || !proDays.trim()}
              >
                {proBusy ? "Calculating…" : "Calculate"}
              </Button>
            </div>
            {proResult ? (
              <div className="mt-2 rounded-md bg-emerald-50 px-3 py-2 ring-1 ring-emerald-200">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-lg font-bold text-emerald-800">
                    {formatMoney(proResult.amount)}
                  </span>
                  <Button size="sm" onClick={() => void applyToQuantum()}>
                    Apply to quantum
                  </Button>
                </div>
                <p className="mt-1 text-xs text-emerald-700">{proResult.derivation}</p>
              </div>
            ) : selected.prolongation?.amount !== undefined ? (
              <p className="mt-2 text-xs text-ink-500">
                Saved build-up: {formatMoney(selected.prolongation.amount)} —{" "}
                {selected.prolongation.derivation ?? ""}
              </p>
            ) : null}
          </div>

          {/* Chronology */}
          <div className="mb-4 rounded-lg border border-ink-100 p-4">
            <div className="mb-2 flex items-center justify-between">
              <div className="text-sm font-semibold text-ink-900">Chronology</div>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => void generateChronology()}
                disabled={chronoBusy}
              >
                {chronoBusy ? "Assembling…" : selected.chronology ? "Regenerate" : "Generate chronology"}
              </Button>
            </div>
            {selected.chronology && selected.chronology.length > 0 ? (
              <>
                <p className="mb-2 text-xs text-ink-400">
                  {selected.chronology.length} entries · assembled from platform records{" "}
                  {selected.chronologyAt ? formatDateTime(selected.chronologyAt) : ""}
                </p>
                <ol className="relative ml-2 max-h-72 space-y-0 overflow-y-auto border-l border-ink-200 pl-4">
                  {selected.chronology.map((item, i) => (
                    <li key={i} className="relative py-1.5">
                      <span className="absolute -left-[21px] top-2.5 h-2 w-2 rounded-full bg-brand-500" />
                      <div className="flex items-center gap-2 text-sm">
                        <span className="whitespace-nowrap font-mono text-xs text-ink-400">
                          {formatDate(item.date)}
                        </span>
                        <Badge tone={SOURCE_TONES[item.source] ?? "gray"}>
                          {humanize(item.source)}
                        </Badge>
                        <span className="font-mono text-xs text-ink-400">{item.ref}</span>
                      </div>
                      <div className="text-sm text-ink-800">{item.title}</div>
                    </li>
                  ))}
                </ol>
              </>
            ) : (
              <p className="text-xs text-ink-400">
                No chronology yet — auto-assemble one from delay events, contract notices, RFIs,
                daily-log delay entries and instructed variations.
              </p>
            )}
          </div>

          {/* Claim assurance: does the record actually support the claim? */}
          <div className="rounded-lg border border-ink-100 p-4">
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="text-sm font-semibold text-ink-900">Record sufficiency</div>
              <Button size="sm" variant="secondary" disabled={sufficiencyBusy} onClick={() => void scoreSufficiency()}>
                {sufficiencyBusy ? "Scoring…" : "Score the record"}
              </Button>
            </div>
            {sufficiency ? (
              <div className="space-y-2">
                <div className="text-sm text-ink-800">
                  Overall {Math.round(sufficiency.overallScore * 100)}% — presence, independence,
                  contemporaneity and coverage of the contemporaneous record.
                </div>
                <div className="flex flex-wrap gap-1">
                  {sufficiency.limbs.map((l) => (
                    <Badge key={l.key} tone={l.present ? (l.score >= 0.6 ? "green" : "amber") : "red"}>
                      {l.key} {Math.round(l.score * 100)}%
                    </Badge>
                  ))}
                </div>
                {sufficiency.gaps.length > 0 ? (
                  <div className="text-xs text-amber-700">
                    Record gaps:{" "}
                    {sufficiency.gaps
                      .slice(0, 4)
                      .map((g) => `${g.from} → ${g.to} (${g.days}d, no daily log)`)
                      .join("; ")}
                    {sufficiency.gaps.length > 4 ? ` and ${sufficiency.gaps.length - 4} more` : ""}
                  </div>
                ) : null}
                {sufficiency.missingNotices.length > 0 ? (
                  <div className="text-xs text-red-700">
                    {sufficiency.missingNotices.map((n) => `${n.title}: ${n.reason}`).join("; ")}
                  </div>
                ) : null}
                {sufficiency.reasons.length > 0 ? (
                  <ul className="ml-4 list-disc text-xs text-ink-500">
                    {sufficiency.reasons.map((r) => (
                      <li key={r}>{r}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : (
              <p className="text-xs text-ink-400">
                Not scored yet. Scoring reports which limbs are thin, which delay days have no daily
                log behind them, and which events were never noticed inside the contract time bar.
              </p>
            )}
          </div>

          {/* Valuation range and provision (#312-313) */}
          <div className="rounded-lg border border-ink-100 p-4">
            <div className="mb-2 text-sm font-semibold text-ink-900">
              Valuation range & provision
              {selected.currency ? (
                <span className="ml-2 text-xs font-normal text-ink-400">{selected.currency}</span>
              ) : null}
            </div>
            <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
              <Field label="Best">
                <Input
                  inputMode="decimal"
                  value={valuation.best}
                  onChange={(e) => setValuation({ ...valuation, best: e.target.value })}
                  placeholder={selected.quantumBest !== null && selected.quantumBest !== undefined ? String(selected.quantumBest) : ""}
                />
              </Field>
              <Field label="Likely">
                <Input
                  inputMode="decimal"
                  value={valuation.likely}
                  onChange={(e) => setValuation({ ...valuation, likely: e.target.value })}
                  placeholder={selected.quantumLikely !== null && selected.quantumLikely !== undefined ? String(selected.quantumLikely) : ""}
                />
              </Field>
              <Field label="Worst">
                <Input
                  inputMode="decimal"
                  value={valuation.worst}
                  onChange={(e) => setValuation({ ...valuation, worst: e.target.value })}
                  placeholder={selected.quantumWorst !== null && selected.quantumWorst !== undefined ? String(selected.quantumWorst) : ""}
                />
              </Field>
              <Field label="P(success) 0-1">
                <Input
                  inputMode="decimal"
                  value={valuation.probability}
                  onChange={(e) => setValuation({ ...valuation, probability: e.target.value })}
                  placeholder={
                    selected.successProbability !== null && selected.successProbability !== undefined
                      ? String(selected.successProbability)
                      : ""
                  }
                />
              </Field>
            </div>
            <div className="mt-2 flex items-center gap-3">
              <Button size="sm" disabled={valuationBusy} onClick={() => void saveValuation()}>
                {valuationBusy ? "Saving…" : "Save valuation"}
              </Button>
              <span className="text-xs text-ink-600">
                Provision:{" "}
                {selected.provisionAmount === null || selected.provisionAmount === undefined ? (
                  <span className="text-ink-400">— no likely value or probability recorded</span>
                ) : (
                  <strong>{selected.provisionAmount}</strong>
                )}
              </span>
            </div>
          </div>

          {/* Submission package */}
          <div className="rounded-lg border border-ink-100 p-4">
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="text-sm font-semibold text-ink-900">Submission package</div>
              <div className="flex gap-2">
                <Button size="sm" variant="secondary" disabled={scottBusy} onClick={() => void generateScottSchedule()}>
                  {scottBusy ? "Generating…" : "Scott Schedule"}
                </Button>
                <Button size="sm" variant="secondary" onClick={() => void checkPackage()}>
                  Check readiness
                </Button>
              </div>
            </div>
            <p className="text-xs text-ink-400">
              The Scott Schedule fills the claimant columns from the register and leaves the
              respondent and tribunal columns empty — this platform does not write the other side's
              case.
            </p>
            {selected.scottSchedule ? (
              <div className="mt-1 text-xs text-ink-600">
                {selected.scottSchedule.length} item
                {selected.scottSchedule.length === 1 ? "" : "s"} generated.
              </div>
            ) : null}
            {packageInfo ? (
              packageInfo.ready ? (
                <div className="mt-2 text-xs text-emerald-700">
                  The package is complete: chronology, sufficiency, analysis and quantum are all
                  linked.
                </div>
              ) : (
                <ul className="mt-2 ml-4 list-disc text-xs text-amber-700">
                  {packageInfo.missing.map((m) => (
                    <li key={m}>{m}</li>
                  ))}
                </ul>
              )
            ) : null}
          </div>

          {/* Status actions */}
          <div className="rounded-lg border border-ink-100 p-4">
            <div className="mb-2 text-sm font-semibold text-ink-900">Lifecycle</div>
            <div className="flex flex-wrap gap-2">
              {(CLAIM_NEXT_STATUSES[selected.status] ?? []).map((next) =>
                next === "assessed" ? (
                  <Button
                    key={next}
                    size="sm"
                    disabled={statusBusy}
                    onClick={() => {
                      setAssessDays(selected.daysClaimed !== null ? String(selected.daysClaimed) : "");
                      setAssessAmount(
                        selected.amountClaimed !== null ? String(selected.amountClaimed) : "",
                      );
                      setAssessOpen(true);
                    }}
                  >
                    Assess…
                  </Button>
                ) : (
                  <Button
                    key={next}
                    size="sm"
                    variant={
                      next === "rejected" || next === "withdrawn"
                        ? "danger"
                        : next === "agreed"
                          ? "primary"
                          : "secondary"
                    }
                    disabled={statusBusy}
                    onClick={() => {
                      if (next === "draft" || next === "withdrawn") {
                        setReasonFor(next);
                        setReasonText("");
                        return;
                      }
                      void transition(next);
                    }}
                  >
                    {next === "submitted"
                      ? "Submit"
                      : next === "agreed"
                        ? "Agree"
                        : next === "rejected"
                          ? "Reject"
                          : next === "draft"
                            ? "Revise (clears the assessment)…"
                            : "Withdraw"}
                  </Button>
                ),
              )}
              {(CLAIM_NEXT_STATUSES[selected.status] ?? []).length === 0 ? (
                <span className="text-xs text-ink-400">
                  This claim is {humanize(selected.status).toLowerCase()} — no further transitions.
                </span>
              ) : null}
            </div>
          </div>
        </Drawer>
      ) : null}

      {/* ------------------------------- assess modal ------------------------------- */}
      {/* ------------------------------ reason modal ------------------------------ */}
      <Modal
        open={reasonFor !== null}
        title={reasonFor === "draft" ? "Revise this claim" : "Withdraw this claim"}
        onClose={() => setReasonFor(null)}
      >
        <p className="mb-3 text-sm text-ink-500">
          {reasonFor === "draft"
            ? "Taking the claim back to draft clears the recorded assessment — an assessed figure must never survive against changed numbers. The reason is written to the ledger."
            : "Withdrawing removes this claim from the register's open position. The reason is written to the ledger."}
        </p>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            const status = reasonFor;
            if (!status) return;
            setReasonFor(null);
            void transition(status, { reason: reasonText.trim() });
          }}
        >
          <Field label="Reason">
            <Textarea
              rows={3}
              value={reasonText}
              onChange={(e) => setReasonText(e.target.value)}
              required
              placeholder={
                reasonFor === "draft"
                  ? "Quantum restated after the measured mile."
                  : "Raised in error — duplicated by CLM-004."
              }
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setReasonFor(null)}>
              Cancel
            </Button>
            <Button type="submit" disabled={statusBusy || reasonText.trim().length === 0}>
              {statusBusy ? "Recording…" : "Confirm"}
            </Button>
          </div>
        </form>
      </Modal>

      <Modal open={assessOpen} title="Assess claim" onClose={() => setAssessOpen(false)}>
        <p className="mb-3 text-sm text-ink-500">
          Record the independent determination. The assessor must not be the user who prepared the
          claim.
        </p>
        <form onSubmit={onAssess} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <Field label="Days assessed">
              <Input
                type="number"
                min="0"
                step="1"
                value={assessDays}
                onChange={(e) => setAssessDays(e.target.value)}
              />
            </Field>
            <Field label="Amount assessed">
              <Input
                type="number"
                min="0"
                step="any"
                value={assessAmount}
                onChange={(e) => setAssessAmount(e.target.value)}
              />
            </Field>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setAssessOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={statusBusy}>
              {statusBusy ? "Recording…" : "Record assessment"}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
