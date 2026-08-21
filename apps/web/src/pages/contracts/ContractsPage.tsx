import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { CONTRACT_FORMS, CONTRACT_STATUSES, NEC_OPTIONS } from "@constructos/shared";
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
  Textarea,
  Th,
} from "../../ui";
import { formatDate, formatMoney, humanize } from "../format";
import {
  administratorLabel,
  contractStatusTone,
  formLabel,
  isNecForm,
  type ContractRow,
  type DeadlineItem,
  type ListResponse,
} from "./contractsShared";

const PAGE_SIZE = 25;

interface CreateForm {
  name: string;
  form: string;
  necOption: string;
  employer: string;
  contractor: string;
  administrator: string;
  baseDate: string;
  commencementDate: string;
  completionDate: string;
  currency: string;
  contractSum: string;
  retentionPercent: string;
  defectsPeriodMonths: string;
  ldRatePerDay: string;
  ldCap: string;
}

const emptyForm: CreateForm = {
  name: "",
  form: "fidic_red_2017",
  necOption: "A",
  employer: "",
  contractor: "",
  administrator: "",
  baseDate: "",
  commencementDate: "",
  completionDate: "",
  currency: "USD",
  contractSum: "",
  retentionPercent: "",
  defectsPeriodMonths: "",
  ldRatePerDay: "",
  ldCap: "",
};

interface PcRow {
  clauseRef: string;
  amendment: string;
}

function numberOrUndefined(raw: string): number | undefined {
  if (!raw.trim()) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/** Radar chip tone by days remaining (negative = the bar has fallen). */
function radarChipClass(days: number): string {
  if (days < 0) return "bg-red-900 text-red-100";
  if (days <= 5) return "bg-red-100 text-red-800 ring-1 ring-red-200";
  if (days <= 14) return "bg-amber-100 text-amber-800 ring-1 ring-amber-200";
  return "bg-ink-100 text-ink-700 ring-1 ring-ink-200";
}

export default function ContractsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const base = `/api/v1/projects/${projectId}/contracts`;

  const [items, setItems] = useState<ContractRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState("");
  const [deadlines, setDeadlines] = useState<DeadlineItem[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState<CreateForm>(emptyForm);
  const [pcs, setPcs] = useState<PcRow[]>([]);
  const [createError, setCreateError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!projectId) return;
    setError(null);
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
      if (status) params.set("status", status);
      const [list, radar] = await Promise.all([
        api.get<ListResponse<ContractRow>>(`${base}?${params}`),
        api.get<{ items: DeadlineItem[] }>(`${base}/deadlines?days=30`),
      ]);
      setItems(list.items);
      setTotal(list.total);
      setDeadlines(radar.items ?? []);
    } catch (err) {
      setItems([]);
      setError(err instanceof Error ? err.message : "Failed to load contracts");
    }
  }, [base, projectId, page, status]);

  useEffect(() => {
    void load();
  }, [load]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  function set<K extends keyof CreateForm>(key: K, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function setPc(index: number, key: keyof PcRow, value: string) {
    setPcs((rows) => rows.map((r, i) => (i === index ? { ...r, [key]: value } : r)));
  }

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setCreateError(null);
    setBusy(true);
    try {
      const parties: Record<string, string> = {};
      if (form.employer.trim()) parties["employer"] = form.employer.trim();
      if (form.contractor.trim()) parties["contractor"] = form.contractor.trim();
      if (form.administrator.trim()) parties["administrator"] = form.administrator.trim();
      const particulars = pcs
        .map((p) => ({ clauseRef: p.clauseRef.trim(), amendment: p.amendment.trim() }))
        .filter((p) => p.clauseRef && p.amendment);
      const payload: Record<string, unknown> = {
        name: form.name.trim(),
        form: form.form,
        parties,
        currency: form.currency.trim().toUpperCase() || "USD",
      };
      if (isNecForm(form.form)) payload["necOption"] = form.necOption;
      if (form.baseDate) payload["baseDate"] = form.baseDate;
      if (form.commencementDate) payload["commencementDate"] = form.commencementDate;
      if (form.completionDate) payload["completionDate"] = form.completionDate;
      const contractSum = numberOrUndefined(form.contractSum);
      if (contractSum !== undefined) payload["contractSum"] = contractSum;
      const retention = numberOrUndefined(form.retentionPercent);
      if (retention !== undefined) payload["retentionPercent"] = retention;
      const defects = numberOrUndefined(form.defectsPeriodMonths);
      if (defects !== undefined) payload["defectsPeriodMonths"] = Math.round(defects);
      const ldRate = numberOrUndefined(form.ldRatePerDay);
      if (ldRate !== undefined) payload["ldRatePerDay"] = ldRate;
      const ldCap = numberOrUndefined(form.ldCap);
      if (ldCap !== undefined) payload["ldCap"] = ldCap;
      if (particulars.length > 0) payload["particularConditions"] = particulars;

      const created = await api.post<ContractRow>(base, payload);
      setCreateOpen(false);
      setForm(emptyForm);
      setPcs([]);
      navigate(`/projects/${projectId}/contracts/${created.id}`);
    } catch (err) {
      setCreateError(
        err instanceof ApiClientError ? err.message : "Failed to create the contract.",
      );
    } finally {
      setBusy(false);
    }
  }

  const adminLabel = administratorLabel(form.form);

  return (
    <div>
      <PageHeader
        title="Contracts"
        subtitle="Standard-form contract administration — clauses, notices and time bars"
        actions={<Button onClick={() => setCreateOpen(true)}>New contract</Button>}
      />

      {deadlines.length > 0 ? (
        <Card className="mb-4 border-l-4 border-l-amber-500">
          <CardBody className="py-3">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-500">
              Time-bar radar — notice deadlines inside 30 days
            </div>
            <div className="flex flex-wrap gap-2">
              {deadlines.map((d) => (
                <button
                  key={d.id}
                  type="button"
                  onClick={() =>
                    navigate(`/projects/${projectId}/contracts/${d.contractId}?tab=events`)
                  }
                  title={`${d.contractName ?? "Contract"} — ${d.title} (deadline ${formatDate(d.noticeDeadline)})`}
                  className={`inline-flex max-w-full items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${radarChipClass(d.daysRemaining)}`}
                >
                  {d.clauseRef ? <span className="font-mono">{d.clauseRef}</span> : null}
                  <span className="truncate">{d.title}</span>
                  <span className="font-semibold whitespace-nowrap">
                    {d.daysRemaining < 0
                      ? "TIME BARRED"
                      : d.daysRemaining === 0
                        ? "due today"
                        : `${d.daysRemaining}d`}
                  </span>
                </button>
              ))}
            </div>
          </CardBody>
        </Card>
      ) : null}

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="w-44">
          <Select
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              setPage(1);
            }}
          >
            <option value="">All statuses</option>
            {CONTRACT_STATUSES.map((s) => (
              <option key={s} value={s}>
                {humanize(s)}
              </option>
            ))}
          </Select>
        </div>
      </div>

      <ErrorAlert message={error} />

      {items === null ? (
        <Spinner />
      ) : items.length === 0 ? (
        <EmptyState
          title={status ? "No contracts match the filter" : "No contracts yet"}
          hint={
            status
              ? "Try clearing the status filter."
              : "Instantiate a standard form (FIDIC, NEC, JCT) to unlock clause intelligence and the time-bar engine."
          }
          action={
            !status ? (
              <Button onClick={() => setCreateOpen(true)}>Create the first contract</Button>
            ) : undefined
          }
        />
      ) : (
        <>
          <Table>
            <thead>
              <tr>
                <Th>Name</Th>
                <Th>Form</Th>
                <Th>NEC option</Th>
                <Th>Status</Th>
                <Th className="text-right">Contract sum</Th>
                <Th>Completion</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {items.map((c) => (
                <tr key={c.id} className="hover:bg-ink-50/60">
                  <Td>
                    <Link
                      to={`/projects/${projectId}/contracts/${c.id}`}
                      className="font-medium text-brand-700 hover:text-brand-800"
                    >
                      {c.name}
                    </Link>
                  </Td>
                  <Td>
                    <Badge tone="blue">{formLabel(c.form)}</Badge>
                  </Td>
                  <Td>
                    {c.necOption ? <Badge tone="violet">Option {c.necOption}</Badge> : "—"}
                  </Td>
                  <Td>
                    <Badge tone={contractStatusTone(c.status)}>{humanize(c.status)}</Badge>
                  </Td>
                  <Td className="whitespace-nowrap text-right tabular-nums">
                    {formatMoney(c.contractSum, c.currency)}
                  </Td>
                  <Td className="whitespace-nowrap">{formatDate(c.completionDate)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>

          <div className="mt-4 flex items-center justify-between text-sm text-ink-500">
            <span>
              {total} contract{total === 1 ? "" : "s"} · page {page} of {totalPages}
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

      <Modal open={createOpen} title="New contract" onClose={() => setCreateOpen(false)} wide>
        <ErrorAlert message={createError} />
        <form onSubmit={onCreate} className="space-y-4">
          <Field label="Contract name">
            <Input
              required
              value={form.name}
              onChange={(e) => set("name", e.target.value)}
              placeholder="Main works contract — Riverside STP"
            />
          </Field>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Standard form">
              <Select value={form.form} onChange={(e) => set("form", e.target.value)}>
                {CONTRACT_FORMS.map((f) => (
                  <option key={f} value={f}>
                    {formLabel(f)}
                  </option>
                ))}
              </Select>
            </Field>
            {isNecForm(form.form) ? (
              <Field label="NEC main option" hint="A priced · B bill · C/D target · E/F cost">
                <Select value={form.necOption} onChange={(e) => set("necOption", e.target.value)}>
                  {NEC_OPTIONS.map((o) => (
                    <option key={o} value={o}>
                      Option {o}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : null}
          </div>

          <fieldset className="rounded-md border border-ink-200 p-3">
            <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-ink-500">
              Parties
            </legend>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <Field label="Employer">
                <Input
                  value={form.employer}
                  onChange={(e) => set("employer", e.target.value)}
                  placeholder="Employer / client"
                />
              </Field>
              <Field label="Contractor">
                <Input
                  value={form.contractor}
                  onChange={(e) => set("contractor", e.target.value)}
                  placeholder="Main contractor"
                />
              </Field>
              <Field label={adminLabel}>
                <Input
                  value={form.administrator}
                  onChange={(e) => set("administrator", e.target.value)}
                  placeholder={adminLabel}
                />
              </Field>
            </div>
          </fieldset>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field label="Base date">
              <Input
                type="date"
                value={form.baseDate}
                onChange={(e) => set("baseDate", e.target.value)}
              />
            </Field>
            <Field label="Commencement date">
              <Input
                type="date"
                value={form.commencementDate}
                onChange={(e) => set("commencementDate", e.target.value)}
              />
            </Field>
            <Field label="Completion date">
              <Input
                type="date"
                value={form.completionDate}
                onChange={(e) => set("completionDate", e.target.value)}
              />
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Field label="Currency">
              <Input
                value={form.currency}
                maxLength={3}
                onChange={(e) => set("currency", e.target.value)}
                placeholder="USD"
              />
            </Field>
            <Field label="Contract sum">
              <Input
                type="number"
                min="0"
                step="any"
                value={form.contractSum}
                onChange={(e) => set("contractSum", e.target.value)}
              />
            </Field>
            <Field label="Retention %">
              <Input
                type="number"
                min="0"
                max="100"
                step="any"
                value={form.retentionPercent}
                onChange={(e) => set("retentionPercent", e.target.value)}
              />
            </Field>
            <Field label="Defects period (months)">
              <Input
                type="number"
                min="0"
                step="1"
                value={form.defectsPeriodMonths}
                onChange={(e) => set("defectsPeriodMonths", e.target.value)}
              />
            </Field>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="LD rate / day" hint="Liquidated damages accrued per day of delay.">
              <Input
                type="number"
                min="0"
                step="any"
                value={form.ldRatePerDay}
                onChange={(e) => set("ldRatePerDay", e.target.value)}
              />
            </Field>
            <Field label="LD cap" hint="Aggregate cap on liquidated damages.">
              <Input
                type="number"
                min="0"
                step="any"
                value={form.ldCap}
                onChange={(e) => set("ldCap", e.target.value)}
              />
            </Field>
          </div>

          <fieldset className="rounded-md border border-ink-200 p-3">
            <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-ink-500">
              Particular Conditions
            </legend>
            <p className="mb-3 text-xs text-ink-400">
              Clause-level amendments overlaid on the standard form. Amended clauses are flagged in
              the clause register.
            </p>
            {pcs.length === 0 ? (
              <p className="mb-3 text-xs text-ink-400">No amendments recorded.</p>
            ) : (
              <div className="space-y-3">
                {pcs.map((p, i) => (
                  <div key={i} className="flex items-start gap-3">
                    <div className="w-28 shrink-0">
                      <Input
                        value={p.clauseRef}
                        onChange={(e) => setPc(i, "clauseRef", e.target.value)}
                        placeholder="20.2"
                        aria-label={`Amended clause reference ${i + 1}`}
                      />
                    </div>
                    <div className="flex-1">
                      <Textarea
                        value={p.amendment}
                        onChange={(e) => setPc(i, "amendment", e.target.value)}
                        placeholder="Text of the amendment…"
                        className="min-h-16"
                        aria-label={`Amendment text ${i + 1}`}
                      />
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setPcs((rows) => rows.filter((_, j) => j !== i))}
                    >
                      Remove
                    </Button>
                  </div>
                ))}
              </div>
            )}
            <div className="mt-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setPcs((rows) => [...rows, { clauseRef: "", amendment: "" }])}
              >
                Add amendment
              </Button>
            </div>
          </fieldset>

          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Creating…" : "Create contract"}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
