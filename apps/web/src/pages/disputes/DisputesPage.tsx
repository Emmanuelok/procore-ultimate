/**
 * Dispute support workspace — spec Vol II Domain E / M15 (#321-357 subset):
 * dispute register across resolution forums (#321, #329, #334-337) with the
 * procedural deadline radar (#338), and the create flow that seeds the
 * dispute's procedural timetable — every dated step materializes as an
 * assurance Obligation server-side.
 */
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useParams } from "react-router-dom";
import { DISPUTE_KINDS } from "@constructos/shared";
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
  PageHeader,
  Select,
  Spinner,
  Table,
  Td,
  Th,
} from "../../ui";
import { formatDate, humanize } from "../format";
import {
  CountdownBadge,
  disputeStatusTone,
  dspLabel,
  fmtMoney,
  kindLabel,
  type ClaimLite,
  type ContractLite,
  type DisputeRow,
  type EntityLite,
  type ListResponse,
} from "./disputesShared";
import DisputeDrawer from "./DisputeDrawer";

const PAGE_SIZE = 25;

function radarChipClass(days: number): string {
  if (days < 0) return "bg-red-900 text-red-100";
  if (days <= 2) return "bg-red-100 text-red-800 ring-1 ring-red-200";
  if (days <= 7) return "bg-amber-100 text-amber-800 ring-1 ring-amber-200";
  return "bg-ink-100 text-ink-700 ring-1 ring-ink-200";
}

interface TimetableDraftRow {
  name: string;
  dueDate: string;
}

export default function DisputesPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const base = `/api/v1/projects/${projectId}`;

  const [items, setItems] = useState<DisputeRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!projectId) return;
    setError(null);
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
      const list = await api.get<ListResponse<DisputeRow>>(`${base}/disputes?${params}`);
      setItems(list.items);
      setTotal(list.total);
    } catch (err) {
      setItems([]);
      setError(err instanceof Error ? err.message : "Failed to load disputes");
    }
  }, [base, projectId, page]);

  useEffect(() => {
    void load();
  }, [load]);

  /* ----------------------------- create modal ----------------------------- */

  const [createOpen, setCreateOpen] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cTitle, setCTitle] = useState("");
  const [cKind, setCKind] = useState("adjudication");
  const [cForum, setCForum] = useState("");
  const [cRules, setCRules] = useState("");
  const [cContractId, setCContractId] = useState("");
  const [cClaimIds, setCClaimIds] = useState<string[]>([]);
  const [cCounterpartyId, setCCounterpartyId] = useState("");
  const [cAmount, setCAmount] = useState("");
  const [cCurrency, setCCurrency] = useState("GBP");
  const [cSteps, setCSteps] = useState<TimetableDraftRow[]>([]);
  const [contracts, setContracts] = useState<ContractLite[]>([]);
  const [claims, setClaims] = useState<ClaimLite[]>([]);
  const [entities, setEntities] = useState<EntityLite[]>([]);

  function openCreate() {
    setCreateError(null);
    setCTitle("");
    setCKind("adjudication");
    setCForum("");
    setCRules("");
    setCContractId("");
    setCClaimIds([]);
    setCCounterpartyId("");
    setCAmount("");
    setCCurrency("GBP");
    setCSteps([]);
    setCreateOpen(true);
    void (async () => {
      try {
        const [con, clm, ent] = await Promise.all([
          api.get<ListResponse<ContractLite>>(`${base}/contracts?pageSize=100`),
          api.get<ListResponse<ClaimLite>>(`${base}/claims?pageSize=100`),
          api.get<ListResponse<EntityLite>>(`/api/v1/entities?pageSize=100`),
        ]);
        setContracts(con.items);
        setClaims(clm.items);
        setEntities(ent.items);
      } catch {
        // optional pickers — the form still works without them
      }
    })();
  }

  function toggleClaim(id: string) {
    setCClaimIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  function setStep(i: number, patch: Partial<TimetableDraftRow>) {
    setCSteps((prev) => prev.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));
  }

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setCreateError(null);
    setBusy(true);
    try {
      const payload: Record<string, unknown> = { title: cTitle.trim(), kind: cKind };
      if (cForum.trim()) payload["forum"] = cForum.trim();
      if (cRules.trim()) payload["rules"] = cRules.trim();
      if (cContractId) payload["contractId"] = cContractId;
      if (cClaimIds.length > 0) payload["claimIds"] = cClaimIds;
      if (cCounterpartyId) payload["counterpartyEntityId"] = cCounterpartyId;
      if (cAmount.trim() !== "") payload["amountInDispute"] = Number(cAmount) || 0;
      const cur = cCurrency.trim().toUpperCase();
      if (cur) payload["currency"] = cur;
      const steps = cSteps
        .filter((s) => s.name.trim())
        .map((s) => ({
          name: s.name.trim(),
          ...(s.dueDate ? { dueDate: s.dueDate } : {}),
        }));
      if (steps.length > 0) payload["timetable"] = steps;
      const created = await api.post<DisputeRow>(`${base}/disputes`, payload);
      setCreateOpen(false);
      setPage(1);
      await load();
      setSelectedId(created.id);
    } catch (err) {
      setCreateError(err instanceof ApiClientError ? err.message : "Failed to create the dispute.");
    } finally {
      setBusy(false);
    }
  }

  /* --------------------------------- drawer --------------------------------- */

  const [selectedId, setSelectedId] = useState<string | null>(null);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const radar = (items ?? []).filter(
    (d) => d.nextDeadline !== null && d.daysToNext !== null && d.daysToNext <= 14,
  );

  if (!projectId) return null;

  return (
    <div>
      <PageHeader
        title="Disputes"
        subtitle="Adjudication, DAAB, arbitration and litigation support — timetables, pleadings, hearing bundles and settlement"
        actions={<Button onClick={openCreate}>New dispute</Button>}
      />

      {/* Deadline radar (#338) */}
      {radar.length > 0 ? (
        <Card className="mb-4 border-l-4 border-l-amber-500">
          <CardBody className="py-3">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-500">
              Deadline radar — procedural timetable deadlines inside 14 days
            </div>
            <div className="flex flex-wrap gap-2">
              {radar.map((d) => (
                <button
                  key={d.id}
                  type="button"
                  onClick={() => setSelectedId(d.id)}
                  title={`${dspLabel(d.number)} ${d.title} — next deadline ${formatDate(d.nextDeadline)}`}
                  className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${radarChipClass(d.daysToNext ?? 0)}`}
                >
                  <span className="font-mono">{dspLabel(d.number)}</span>
                  <span className="max-w-40 truncate">{d.title}</span>
                  <span className="font-semibold whitespace-nowrap tabular-nums">
                    {(d.daysToNext ?? 0) < 0
                      ? "OVERDUE"
                      : d.daysToNext === 0
                        ? "due today"
                        : `${d.daysToNext}d`}
                  </span>
                </button>
              ))}
            </div>
          </CardBody>
        </Card>
      ) : null}

      <ErrorAlert message={error} />

      {/* Register */}
      {items === null ? (
        <Spinner />
      ) : items.length === 0 ? (
        <EmptyState
          title="No disputes yet"
          hint="Open a dispute file to track the procedural timetable, the pleadings register, hearing bundles and settlement offers in one place."
          action={<Button onClick={openCreate}>Open the first dispute file</Button>}
        />
      ) : (
        <>
          <Table>
            <thead>
              <tr>
                <Th>No.</Th>
                <Th>Title</Th>
                <Th>Kind</Th>
                <Th>Forum</Th>
                <Th className="text-right">In dispute</Th>
                <Th>Status</Th>
                <Th>Next deadline</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {items.map((d) => (
                <tr
                  key={d.id}
                  className="cursor-pointer hover:bg-ink-50/60"
                  onClick={() => setSelectedId(d.id)}
                >
                  <Td className="whitespace-nowrap font-mono text-xs text-ink-500">
                    {dspLabel(d.number)}
                  </Td>
                  <Td className="max-w-64">
                    <span className="block truncate font-medium text-ink-900">{d.title}</span>
                  </Td>
                  <Td>
                    <Badge tone="blue">{kindLabel(d.kind)}</Badge>
                  </Td>
                  <Td className="max-w-40">
                    <span className="block truncate text-xs text-ink-500">{d.forum ?? "—"}</span>
                  </Td>
                  <Td className="whitespace-nowrap text-right font-medium tabular-nums">
                    {fmtMoney(d.amountInDispute, d.currency)}
                  </Td>
                  <Td>
                    <Badge tone={disputeStatusTone(d.status)}>{humanize(d.status)}</Badge>
                  </Td>
                  <Td className="whitespace-nowrap">
                    {d.nextDeadline ? (
                      <span className="inline-flex items-center gap-2">
                        <span className="text-xs">{formatDate(d.nextDeadline)}</span>
                        <CountdownBadge days={d.daysToNext} />
                      </span>
                    ) : (
                      <span className="text-xs text-ink-300">—</span>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>

          <div className="mt-4 flex items-center justify-between text-sm text-ink-500">
            <span>
              {total} dispute{total === 1 ? "" : "s"} · page {page} of {totalPages}
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
      <Modal open={createOpen} title="New dispute" onClose={() => setCreateOpen(false)} wide>
        <ErrorAlert message={createError} />
        <form onSubmit={onCreate} className="space-y-4">
          <Field label="Title">
            <Input
              required
              value={cTitle}
              onChange={(e) => setCTitle(e.target.value)}
              placeholder="Adjudication — interim payment application no. 14"
            />
          </Field>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field label="Kind">
              <Select value={cKind} onChange={(e) => setCKind(e.target.value)}>
                {DISPUTE_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {kindLabel(k)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Forum" hint="TCC, ICC, RICS nomination…">
              <Input value={cForum} onChange={(e) => setCForum(e.target.value)} />
            </Field>
            <Field label="Rules" hint="Institutional rules reference (#337).">
              <Input
                value={cRules}
                onChange={(e) => setCRules(e.target.value)}
                placeholder="ICC 2021, UNCITRAL…"
              />
            </Field>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
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
            <Field label="Counterparty">
              <Select value={cCounterpartyId} onChange={(e) => setCCounterpartyId(e.target.value)}>
                <option value="">None</option>
                {entities.map((en) => (
                  <option key={en.id} value={en.id}>
                    {en.name}
                  </option>
                ))}
              </Select>
            </Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Amount in dispute">
                <Input
                  type="number"
                  min="0"
                  step="any"
                  value={cAmount}
                  onChange={(e) => setCAmount(e.target.value)}
                />
              </Field>
              <Field label="Currency">
                <Input
                  value={cCurrency}
                  maxLength={3}
                  onChange={(e) => setCCurrency(e.target.value)}
                  placeholder="GBP"
                />
              </Field>
            </div>
          </div>

          {/* Linked forensic claims */}
          <Field
            label={`Linked claims (${cClaimIds.length} selected)`}
            hint="Forensic claims referred into this dispute."
          >
            {claims.length === 0 ? (
              <p className="rounded-md bg-ink-50 px-3 py-2 text-xs text-ink-400">
                No forensic claims in this project.
              </p>
            ) : (
              <div className="max-h-36 space-y-1 overflow-y-auto rounded-md border border-ink-200 p-2">
                {claims.map((c) => (
                  <label key={c.id} className="flex cursor-pointer items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={cClaimIds.includes(c.id)}
                      onChange={() => toggleClaim(c.id)}
                      className="rounded border-ink-300 text-brand-600 focus:ring-brand-500"
                    />
                    <span className="font-mono text-xs text-ink-400">
                      CLM-{String(c.number).padStart(3, "0")}
                    </span>
                    <span className="truncate text-ink-800">{c.title}</span>
                  </label>
                ))}
              </div>
            )}
          </Field>

          {/* Timetable repeater (#330, #338) */}
          <div>
            <div className="mb-1 flex items-center justify-between">
              <span className="text-xs font-medium text-ink-600">Procedural timetable</span>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => setCSteps((prev) => [...prev, { name: "", dueDate: "" }])}
              >
                Add step
              </Button>
            </div>
            {cSteps.length === 0 ? (
              <p className="rounded-md bg-ink-50 px-3 py-2 text-xs text-ink-400">
                No steps yet — each dated step materializes an assurance obligation so the deadline
                is tracked in both registers.
              </p>
            ) : (
              <div className="space-y-2">
                {cSteps.map((s, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <Input
                      value={s.name}
                      onChange={(e) => setStep(i, { name: e.target.value })}
                      placeholder={`Step ${i + 1} — e.g. Referral served`}
                      className="flex-1"
                    />
                    <Input
                      type="date"
                      value={s.dueDate}
                      onChange={(e) => setStep(i, { dueDate: e.target.value })}
                      className="w-40"
                    />
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`Remove step ${i + 1}`}
                      onClick={() => setCSteps((prev) => prev.filter((_, idx) => idx !== i))}
                    >
                      ✕
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Creating…" : "Open dispute file"}
            </Button>
          </div>
        </form>
      </Modal>

      {/* --------------------------------- drawer --------------------------------- */}
      {selectedId ? (
        <DisputeDrawer
          projectId={projectId}
          disputeId={selectedId}
          onClose={() => setSelectedId(null)}
          onChanged={() => void load()}
        />
      ) : null}
    </div>
  );
}
