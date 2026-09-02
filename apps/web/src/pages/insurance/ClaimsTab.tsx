/**
 * Claims (#783-789) — the notification clock.
 *
 * Everything in this tab is arranged around one distinction: the deadline runs
 * from the date the insured became AWARE, not from the date of the incident.
 * Awareness is the trigger in every standard wording, and the gap between the
 * two dates is exactly where good claims die. The create form makes the reader
 * enter both and shows what each one does.
 */
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { INSURANCE_CLAIM_STATUSES } from "@constructos/shared";
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
import ClaimDrawer from "./ClaimDrawer";
import {
  CLAIM_STATUS_LABELS,
  DeadlineChip,
  Disclosure,
  Pager,
  StatCard,
  addDaysIso,
  claimTone,
  errMsg,
  fmtMoney,
  policyTypeLabel,
  type ClaimCreated,
  type ClaimRow,
  type FocusRequest,
  type InsuranceSummary,
  type ListResponse,
  type PolicyRow,
} from "./insuranceShared";

const PAGE_SIZE = 25;

export default function ClaimsTab({
  projectId,
  focus,
}: {
  projectId: string;
  focus: FocusRequest | null;
}) {
  const base = `/api/v1/projects/${projectId}`;

  const [statusFilter, setStatusFilter] = useState("");
  const [policyFilter, setPolicyFilter] = useState("");
  const [notifiedFilter, setNotifiedFilter] = useState("");
  const [page, setPage] = useState(1);

  const [items, setItems] = useState<ClaimRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [policies, setPolicies] = useState<PolicyRow[]>([]);
  const [summary, setSummary] = useState<InsuranceSummary["claims"] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
      if (statusFilter) params.set("status", statusFilter);
      if (policyFilter) params.set("policyId", policyFilter);
      if (notifiedFilter) params.set("notified", notifiedFilter);
      const res = await api.get<ListResponse<ClaimRow>>(`${base}/insurance/claims?${params}`);
      setItems(res.items);
      setTotal(res.total);
    } catch (err) {
      setItems([]);
      setError(errMsg(err, "Failed to load claims"));
    }
  }, [base, notifiedFilter, page, policyFilter, statusFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadSummary = useCallback(async () => {
    try {
      const res = await api.get<InsuranceSummary>(`${base}/insurance/summary`);
      setSummary(res.claims);
    } catch {
      setSummary(null); // the register still stands on its own
    }
  }, [base]);

  useEffect(() => {
    void loadSummary();
  }, [loadSummary]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api.get<ListResponse<PolicyRow>>(
          `${base}/insurance/policies?pageSize=200`,
        );
        if (!cancelled) setPolicies(res.items);
      } catch {
        // picker degrades
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [base]);

  useEffect(() => {
    if (focus?.recordId) setSelectedId(focus.recordId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus]);

  /* -------------------------------- create -------------------------------- */

  const [createOpen, setCreateOpen] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<ClaimCreated | null>(null);
  const [form, setForm] = useState({
    policyId: "",
    title: "",
    description: "",
    incidentDate: "",
    awareDate: "",
    quantum: "",
    reserve: "",
    currency: "",
    insurerRef: "",
    lossAdjuster: "",
  });

  function openCreate() {
    setCreateError(null);
    setForm({
      policyId: policyFilter,
      title: "",
      description: "",
      incidentDate: "",
      awareDate: "",
      quantum: "",
      reserve: "",
      currency: "",
      insurerRef: "",
      lossAdjuster: "",
    });
    setCreateOpen(true);
  }

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setCreateError(null);
    setBusy(true);
    try {
      const payload: Record<string, unknown> = {
        policyId: form.policyId,
        title: form.title.trim(),
        incidentDate: form.incidentDate,
        awareDate: form.awareDate,
        description: form.description.trim() || null,
        quantum: form.quantum === "" ? null : Number(form.quantum),
        reserve: form.reserve === "" ? null : Number(form.reserve),
        insurerRef: form.insurerRef.trim() || null,
        lossAdjuster: form.lossAdjuster.trim() || null,
      };
      if (form.currency.trim()) payload["currency"] = form.currency.trim().toUpperCase();
      const res = await api.post<ClaimCreated>(`${base}/insurance/claims`, payload);
      setCreated(res);
      setCreateOpen(false);
      setPage(1);
      await load();
      await loadSummary();
    } catch (err) {
      setCreateError(errMsg(err, "Failed to record the claim"));
    } finally {
      setBusy(false);
    }
  }

  const selectedPolicy = policies.find((p) => p.id === form.policyId) ?? null;
  const awareBeforeIncident =
    form.incidentDate !== "" && form.awareDate !== "" && form.awareDate < form.incidentDate;
  const previewDue =
    selectedPolicy?.notificationDays !== null &&
    selectedPolicy?.notificationDays !== undefined &&
    form.awareDate
      ? addDaysIso(form.awareDate, selectedPolicy.notificationDays)
      : null;

  return (
    <div>
      {/* ------------------------------- headline ------------------------------- */}
      {summary ? (
        <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatCard label="Claims" value={summary.total} />
          <StatCard
            label="Not yet notified"
            value={summary.notificationsOutstanding}
            tone={summary.notificationsOutstanding > 0 ? "red" : "green"}
            hint="The insurer has not been told"
          />
          <StatCard
            label="Notified late"
            value={summary.notificationsMissed}
            tone={summary.notificationsMissed > 0 ? "red" : undefined}
            hint="Notified after the computed deadline"
          />
          <StatCard
            label="No deadline computed"
            value={summary.notificationDeadlineUnknown}
            tone={summary.notificationDeadlineUnknown > 0 ? "amber" : undefined}
            hint="Policy records no notification period"
          />
        </div>
      ) : null}

      {summary?.note ? (
        <div className="mb-4">
          <Disclosure label="claims.note — returned verbatim by the API" tone="amber">
            {summary.note}
          </Disclosure>
        </div>
      ) : null}

      {created ? (
        <div className="mb-4 rounded-lg border-l-4 border-l-red-500 bg-white p-3 shadow-sm ring-1 ring-ink-100">
          <div className="text-sm font-semibold text-ink-900">
            {created.number} recorded — notification is the next act, and it is the one that
            matters
          </div>
          <div className="mt-2">
            <Disclosure
              label="notificationRule.note — returned verbatim by the API"
              tone={created.notificationRule.notificationDueAt ? "brand" : "red"}
            >
              {created.notificationRule.note}
            </Disclosure>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-ink-600">
            <span>
              Deadline:{" "}
              <strong>
                {created.notificationRule.notificationDueAt
                  ? formatDate(created.notificationRule.notificationDueAt)
                  : "none computed"}
              </strong>
            </span>
            <span>
              Obligation:{" "}
              {created.notificationRule.obligationId ? (
                <code className="text-[11px]">{created.notificationRule.obligationId}</code>
              ) : (
                "none created"
              )}
            </span>
            <Button size="sm" variant="secondary" onClick={() => setSelectedId(created.id)}>
              Open the claim
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setCreated(null)}>
              Dismiss
            </Button>
          </div>
        </div>
      ) : null}

      {/* -------------------------------- filters -------------------------------- */}
      <Card className="mb-4">
        <CardBody className="flex flex-wrap items-end gap-3 py-3">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-ink-600">Status</span>
            <Select
              value={statusFilter}
              onChange={(e) => {
                setStatusFilter(e.target.value);
                setPage(1);
              }}
              className="w-52"
            >
              <option value="">All statuses</option>
              {INSURANCE_CLAIM_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {CLAIM_STATUS_LABELS[s] ?? s}
                </option>
              ))}
            </Select>
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-ink-600">Policy</span>
            <Select
              value={policyFilter}
              onChange={(e) => {
                setPolicyFilter(e.target.value);
                setPage(1);
              }}
              className="w-64"
            >
              <option value="">All policies</option>
              {policies.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.number} · {policyTypeLabel(p.policyType)}
                </option>
              ))}
            </Select>
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-ink-600">Notified</span>
            <Select
              value={notifiedFilter}
              onChange={(e) => {
                setNotifiedFilter(e.target.value);
                setPage(1);
              }}
              className="w-44"
            >
              <option value="">All</option>
              <option value="false">Not yet notified</option>
              <option value="true">Notified</option>
            </Select>
          </label>
          <div className="grow" />
          <Button onClick={openCreate}>Record a claim</Button>
        </CardBody>
      </Card>

      <ErrorAlert message={error} />

      {items === null ? (
        <Spinner />
      ) : items.length === 0 ? (
        <EmptyState
          title="No claims recorded"
          hint="Record the loss as soon as you are aware of it — the notification clock starts on awareness, whether or not anything is recorded here."
          action={<Button onClick={openCreate}>Record the first claim</Button>}
        />
      ) : (
        <>
          <Table>
            <thead>
              <tr>
                <Th>No.</Th>
                <Th>Claim</Th>
                <Th>Incident</Th>
                <Th>Aware</Th>
                <Th>Notification</Th>
                <Th className="text-right">Reserve</Th>
                <Th>Status</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {items.map((c) => {
                const overdue =
                  c.notificationOutstanding &&
                  c.daysToNotificationDue !== null &&
                  c.daysToNotificationDue < 0;
                return (
                  <tr
                    key={c.id}
                    className={`cursor-pointer hover:bg-ink-50/60 ${
                      overdue || c.notifiedLate ? "bg-red-50/60" : ""
                    }`}
                    onClick={() => setSelectedId(c.id)}
                  >
                    <Td className="whitespace-nowrap font-mono text-xs text-ink-500">{c.number}</Td>
                    <Td>
                      <div className="text-sm font-medium text-ink-900">{c.title}</div>
                      {c.lossAdjuster ? (
                        <div className="text-[11px] text-ink-400">{c.lossAdjuster}</div>
                      ) : null}
                    </Td>
                    <Td className="whitespace-nowrap text-xs">{formatDate(c.incidentDate)}</Td>
                    <Td className="whitespace-nowrap text-xs">
                      {formatDate(c.awareDate)}
                      {c.awareDate !== c.incidentDate ? (
                        <span
                          className="ml-1 text-[10px] text-ink-400"
                          title="The notification clock runs from this date, not from the incident date."
                        >
                          ← clock
                        </span>
                      ) : null}
                    </Td>
                    <Td className="whitespace-nowrap">
                      {c.notifiedLate ? (
                        <span className="inline-flex items-center rounded bg-red-900 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-red-50">
                          notified late
                        </span>
                      ) : c.notificationOutstanding ? (
                        <DeadlineChip
                          days={c.daysToNotificationDue}
                          fatal
                          unknownLabel="no deadline computed"
                          unknownTitle="The policy records no notificationDays, so no deadline was computed and no obligation exists. This is not the same as having time."
                        />
                      ) : (
                        <span className="text-xs text-emerald-700">
                          notified {formatDate(c.notifiedAt)}
                        </span>
                      )}
                      {c.notificationDueAt ? (
                        <div className="mt-0.5 text-[11px] text-ink-400">
                          due {formatDate(c.notificationDueAt)}
                        </div>
                      ) : null}
                    </Td>
                    <Td className="whitespace-nowrap text-right tabular-nums">
                      {c.reserve === null ? (
                        <span className="text-xs text-ink-400">not set</span>
                      ) : (
                        fmtMoney(c.reserve, c.currency, 0)
                      )}
                    </Td>
                    <Td className="whitespace-nowrap">
                      <Badge tone={claimTone(c.status)}>
                        {CLAIM_STATUS_LABELS[c.status] ?? c.status}
                      </Badge>
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
          <Pager page={page} total={total} pageSize={PAGE_SIZE} noun="claim" onPage={setPage} />
        </>
      )}

      {/* ------------------------------ create modal ------------------------------ */}
      <Modal open={createOpen} title="Record a claim" onClose={() => setCreateOpen(false)} wide>
        <ErrorAlert message={createError} />
        <form onSubmit={onCreate} className="space-y-4">
          <Field label="Policy" hint="A draft or cancelled policy cannot carry a claim.">
            <Select
              required
              value={form.policyId}
              onChange={(e) => setForm({ ...form, policyId: e.target.value })}
            >
              <option value="">Choose the policy on risk…</option>
              {policies.map((p) => {
                const blocked = p.status === "draft" || p.status === "cancelled";
                return (
                  <option key={p.id} value={p.id} disabled={blocked}>
                    {p.number} · {policyTypeLabel(p.policyType)} · {p.insurer}
                    {p.notificationDays === null
                      ? " · no notification period recorded"
                      : ` · notify within ${p.notificationDays}d`}
                    {blocked ? ` · ${p.status} — cannot carry a claim` : ""}
                  </option>
                );
              })}
            </Select>
          </Field>

          <Field label="Title">
            <Input
              required
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              placeholder="Water ingress to level 3 fit-out"
            />
          </Field>

          {/* the distinction that decides the claim */}
          <div className="rounded-lg bg-brand-50 p-3 ring-1 ring-brand-100">
            <div className="text-sm font-semibold text-brand-900">
              Two different dates. Only one of them starts the clock.
            </div>
            <div className="mt-2 grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field
                label="Incident date"
                hint="When the insured event actually happened. It fixes which policy was on risk."
              >
                <Input
                  type="date"
                  required
                  value={form.incidentDate}
                  onChange={(e) => setForm({ ...form, incidentDate: e.target.value })}
                />
              </Field>
              <Field
                label="Aware date — the clock runs from here"
                hint="When the insured first became aware of the loss or of circumstances that might give rise to a claim. This is the trigger in the standard wordings."
              >
                <Input
                  type="date"
                  required
                  value={form.awareDate}
                  onChange={(e) => setForm({ ...form, awareDate: e.target.value })}
                />
              </Field>
            </div>
            {awareBeforeIncident ? (
              <div className="mt-2 rounded-md bg-red-50 px-3 py-2 text-xs text-red-800 ring-1 ring-red-200">
                The aware date falls before the incident date — the insured cannot become aware of a
                loss before it happens. The API will refuse this.
              </div>
            ) : null}
            {selectedPolicy && selectedPolicy.notificationDays === null ? (
              <div className="mt-2 rounded-md bg-red-50 px-3 py-2 text-xs leading-relaxed text-red-900 ring-1 ring-red-200">
                {selectedPolicy.number} records no notification period, so no deadline will be
                computed and no obligation will be created for this claim. Nothing here will warn
                you when notification is due. Read the wording and set the policy's notification
                days first if you can.
              </div>
            ) : null}
            {previewDue ? (
              <div className="mt-2 rounded-md bg-white px-3 py-2 text-xs text-brand-900 ring-1 ring-brand-100">
                Indicative deadline: notification due by <strong>{formatDate(previewDue)}</strong> —{" "}
                {selectedPolicy?.notificationDays} day(s) from the aware date. The authoritative
                deadline and its obligation are computed by the API when the claim is saved.
              </div>
            ) : null}
          </div>

          <Field label="Description">
            <Textarea
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
            />
          </Field>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
            <Field label="Quantum" hint="Estimated value of the loss.">
              <Input
                type="number"
                min={0}
                step="any"
                value={form.quantum}
                onChange={(e) => setForm({ ...form, quantum: e.target.value })}
              />
            </Field>
            <Field label="Reserve" hint="What you are carrying for it in the accounts.">
              <Input
                type="number"
                min={0}
                step="any"
                value={form.reserve}
                onChange={(e) => setForm({ ...form, reserve: e.target.value })}
              />
            </Field>
            <Field label="Currency" hint="Defaults to the policy's currency.">
              <Input
                maxLength={3}
                value={form.currency}
                onChange={(e) => setForm({ ...form, currency: e.target.value })}
                placeholder={selectedPolicy?.currency ?? ""}
              />
            </Field>
            <Field label="Insurer reference">
              <Input
                value={form.insurerRef}
                onChange={(e) => setForm({ ...form, insurerRef: e.target.value })}
              />
            </Field>
          </div>

          <Field label="Loss adjuster">
            <Input
              value={form.lossAdjuster}
              onChange={(e) => setForm({ ...form, lossAdjuster: e.target.value })}
            />
          </Field>

          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Recording…" : "Record claim"}
            </Button>
          </div>
        </form>
      </Modal>

      {selectedId ? (
        <ClaimDrawer
          projectId={projectId}
          claimId={selectedId}
          onClose={() => setSelectedId(null)}
          onChanged={() => {
            void load();
            void loadSummary();
          }}
        />
      ) : null}
    </div>
  );
}
