/**
 * RETURNS — tax periods and the returns due for them (#803). Due dates come
 * from the regime library and are assurance Obligations, so the return clock
 * and the obligation register agree; the sweep flips an unfiled period to
 * overdue and raises a signal. Aggregates are bucketed by the period's
 * currency; anything else is counted as excluded and said so.
 */
import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  DataTable,
  Drawer,
  Field,
  Input,
  Select,
  Textarea,
  toast,
  type DataColumns,
} from "../../ui";
import { IconPlus } from "../../ui/icons";
import {
  DASH,
  LoadError,
  RETURN_KINDS,
  ReasonList,
  Row,
  count,
  dateTime,
  isoDate,
  money,
  periodTone,
  taxApi,
  titleCase,
  useAction,
  useProfile,
  useRegimeDef,
  useResource,
  type Paginated,
  type Period,
  type PeriodDetail,
} from "./taxShared";

function figure(value: number | null, currency: string, computed: boolean): string {
  if (!computed) return "not computed";
  if (value === null) return DASH;
  return money(value, currency);
}

export default function PeriodsTab({ projectId, onChanged }: { projectId: string; onChanged: () => void }) {
  const [status, setStatus] = useState("");
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  const params = new URLSearchParams({ page: "1", pageSize: "500" });
  if (status) params.set("status", status);
  const list = useResource<Paginated<Period>>(`/api/v1/projects/${projectId}/tax/periods?${params.toString()}`);

  const columns = useMemo<DataColumns<Period>>(
    () => [
      { id: "returnKind", header: "Return", accessor: (row) => titleCase(row.returnKind), type: "text", width: 130 },
      { id: "period", header: "Period", accessor: "periodStart", type: "date", width: 200, cell: ({ row }) => `${row.periodStart} → ${row.periodEnd}` },
      { id: "dueDate", header: "Due", accessor: "dueDate", type: "date", width: 110 },
      {
        id: "daysToDue",
        header: "Days to due",
        accessor: (row) => row.daysToDue ?? 0,
        type: "number",
        align: "right",
        width: 110,
        cell: ({ row }) =>
          row.status === "filed" || row.status === "paid" ? (
            <span className="text-content-subtle">{DASH}</span>
          ) : row.daysToDue === undefined ? (
            DASH
          ) : row.daysToDue < 0 ? (
            <span className="font-semibold text-danger-text">{Math.abs(row.daysToDue)} overdue</span>
          ) : (
            String(row.daysToDue)
          ),
      },
      { id: "status", header: "Status", accessor: "status", type: "text", width: 100, cell: ({ row }) => <Badge tone={periodTone(row.status)} size="xs" dot>{titleCase(row.status)}</Badge> },
      { id: "outputTax", header: "Output tax", accessor: (row) => row.outputTax ?? 0, type: "number", align: "right", width: 130, cell: ({ row }) => (row.returnKind === "vat" ? figure(row.outputTax, row.currency, row.computedAt !== null) : DASH) },
      { id: "inputTax", header: "Input tax", accessor: (row) => row.inputTax ?? 0, type: "number", align: "right", width: 130, cell: ({ row }) => (row.returnKind === "vat" ? figure(row.inputTax, row.currency, row.computedAt !== null) : DASH) },
      { id: "withheldTotal", header: "Withheld", accessor: (row) => row.withheldTotal ?? 0, type: "number", align: "right", width: 130, cell: ({ row }) => (row.returnKind === "vat" ? DASH : figure(row.withheldTotal, row.currency, row.computedAt !== null)) },
      { id: "netPayable", header: "Net payable", accessor: (row) => row.netPayable ?? 0, type: "number", align: "right", width: 130, cell: ({ row }) => <span className="font-semibold">{figure(row.netPayable, row.currency, row.computedAt !== null)}</span> },
      { id: "excludedCount", header: "Excluded", accessor: "excludedCount", type: "number", align: "right", width: 100, cell: ({ row }) => (row.excludedCount > 0 ? <span className="text-warning-text">{row.excludedCount} other-currency</span> : DASH) },
      { id: "filingReference", header: "Filing ref", accessor: (row) => row.filingReference ?? "", type: "code", width: 150, cell: ({ row }) => row.filingReference ?? DASH },
    ],
    [],
  );

  return (
    <div className="space-y-4">
      <Card>
        <CardBody className="flex flex-wrap items-end gap-3">
          <Field label="Status">
            <Select value={status} onChange={(e) => setStatus(e.target.value)} size="sm">
              <option value="">Any</option>
              {["open", "closed", "overdue", "filed", "paid"].map((s) => (
                <option key={s} value={s}>
                  {titleCase(s)}
                </option>
              ))}
            </Select>
          </Field>
          <div className="ml-auto">
            <Button icon={IconPlus} onClick={() => setCreating(true)}>
              New period
            </Button>
          </div>
        </CardBody>
      </Card>

      {list.error ? (
        <LoadError message={list.error} onRetry={list.reload} />
      ) : (
        <DataTable<Period>
          tableId="tax.periods"
          data={list.data?.items ?? []}
          columns={columns}
          getRowId={(row) => row.id}
          loading={list.loading && !list.data}
          height={520}
          rowHeight={44}
          stickyHeader
          exportFileName="tax-periods"
          empty={{
            title: "No tax periods",
            description: "Open a period and its due date becomes an obligation the platform watches. Compute it from the determinations and certificates inside the window, then file it with the authority's reference.",
            action: <Button onClick={() => setCreating(true)}>Open a period</Button>,
          }}
          onRowClick={({ row }) => setOpenId(row.id)}
          rowTone={(row) => (row.status === "overdue" ? "danger" : row.status === "open" && row.daysToDue !== undefined && row.daysToDue <= 14 ? "warning" : undefined)}
          aria-label="Tax periods"
        />
      )}

      <PeriodCreateDrawer
        projectId={projectId}
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={() => {
          setCreating(false);
          list.reload();
          onChanged();
        }}
      />
      <PeriodDrawer
        projectId={projectId}
        periodId={openId}
        onClose={() => setOpenId(null)}
        onChanged={() => {
          list.reload();
          onChanged();
        }}
      />
    </div>
  );
}

/* ================================= Create ================================= */

function PeriodCreateDrawer({ projectId, open, onClose, onCreated }: { projectId: string; open: boolean; onClose: () => void; onCreated: () => void }) {
  const action = useAction();
  const profile = useProfile(projectId);
  const regime = profile.data?.resolved.regime ?? null;
  const def = useRegimeDef(regime);
  const [returnKind, setReturnKind] = useState("vat");
  const [periodStart, setPeriodStart] = useState("");
  const [periodEnd, setPeriodEnd] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [currency, setCurrency] = useState("");
  const [notes, setNotes] = useState("");

  useEffect(() => {
    if (!open) return;
    setReturnKind(def.data?.returns[0]?.kind ?? "vat");
    setPeriodStart("");
    setPeriodEnd("");
    setDueDate("");
    setCurrency("");
    setNotes("");
    action.clear();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, def.data?.regime]);

  const known = def.data?.returns.find((r) => r.kind === returnKind) ?? null;

  async function submit(e: FormEvent) {
    e.preventDefault();
    const body: Record<string, unknown> = { returnKind, periodStart };
    if (periodEnd) body["periodEnd"] = periodEnd;
    if (dueDate) body["dueDate"] = dueDate;
    if (currency.trim()) body["currency"] = currency.trim().toUpperCase();
    if (notes.trim()) body["notes"] = notes.trim();
    const created = await action.run("create", () => taxApi.createPeriod(projectId, body));
    if (created) {
      toast.success(`Period opened — due ${created.dueDate}`);
      onCreated();
    }
  }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      size="md"
      title="Open a tax period"
      description="The period end and due date follow the regime library unless you state them; the due date becomes an obligation."
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="tax-period-create" loading={action.busy === "create"} disabled={!regime}>
            Open period
          </Button>
        </div>
      }
    >
      <form id="tax-period-create" onSubmit={submit} className="space-y-4">
        {action.error ? <Alert tone="danger" size="sm">{action.error}</Alert> : null}
        {!regime ? (
          <Alert tone="warning" size="sm">
            This project has no resolved regime; save a profile on the Overview tab first.
          </Alert>
        ) : null}
        <Field label="Return" required hint={known ? `${known.name}: ${titleCase(known.cadence)}, due ${known.dueDaysAfterPeriodEnd} days after the period end (${known.citation})` : "Not in the library for this regime — state the period end and due date"}>
          <Select value={returnKind} onChange={(e) => setReturnKind(e.target.value)}>
            {RETURN_KINDS.map((k) => (
              <option key={k} value={k}>
                {titleCase(k)}
                {def.data?.returns.some((r) => r.kind === k) ? "" : " (explicit dates)"}
              </option>
            ))}
          </Select>
        </Field>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Period start" required>
            <Input type="date" value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} required />
          </Field>
          <Field label="Period end" hint={known ? "Derived if blank" : undefined} required={!known}>
            <Input type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} />
          </Field>
          <Field label="Due date" hint={known ? "Derived if blank" : undefined} required={!known}>
            <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          </Field>
        </div>
        <Field label="Currency" hint={`Defaults to the profile's (${profile.data?.profile?.currency ?? def.data?.currency ?? DASH}); only figures in this currency aggregate`}>
          <Input value={currency} onChange={(e) => setCurrency(e.target.value)} maxLength={3} />
        </Field>
        <Field label="Notes">
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
        </Field>
      </form>
    </Drawer>
  );
}

/* ================================= Detail ================================= */

function PeriodDrawer({ projectId, periodId, onClose, onChanged }: { projectId: string; periodId: string | null; onClose: () => void; onChanged: () => void }) {
  const detail = useResource<PeriodDetail>(periodId ? `/api/v1/projects/${projectId}/tax/periods/${periodId}` : null);
  const action = useAction();
  const p = detail.data;
  const [filingReference, setFilingReference] = useState("");
  const [filedAt, setFiledAt] = useState("");
  const [reopenReason, setReopenReason] = useState("");

  useEffect(() => {
    setFilingReference("");
    setFiledAt("");
    setReopenReason("");
    action.clear();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [periodId]);

  async function compute() {
    if (!p) return;
    const res = await action.run("compute", () => taxApi.computePeriod(projectId, p.id));
    if (res) {
      toast.success("Period computed");
      detail.reload();
      onChanged();
    }
  }

  async function file(e: FormEvent) {
    e.preventDefault();
    if (!p) return;
    const body: Record<string, unknown> = { filingReference: filingReference.trim() };
    if (filedAt) body["filedAt"] = new Date(filedAt).toISOString();
    const res = await action.run("file", () => taxApi.filePeriod(projectId, p.id, body));
    if (res) {
      toast.success("Return filed; obligation satisfied");
      detail.reload();
      onChanged();
    }
  }

  async function reopen(e: FormEvent) {
    e.preventDefault();
    if (!p) return;
    const res = await action.run("reopen", () => taxApi.reopenPeriod(projectId, p.id, reopenReason.trim()));
    if (res) {
      toast.success("Return re-opened; the filing reference was cleared");
      detail.reload();
      onChanged();
    }
  }

  async function markPaid() {
    if (!p) return;
    const res = await action.run("paid", () => taxApi.markPeriodPaid(projectId, p.id));
    if (res) {
      toast.success("Period marked paid");
      detail.reload();
      onChanged();
    }
  }

  const isVat = p?.returnKind === "vat";
  const computed = p ? p.computedAt !== null : false;
  const basisNote = p && typeof p.live.computeBasis["note"] === "string" ? (p.live.computeBasis["note"] as string) : null;

  return (
    <Drawer
      open={periodId !== null}
      onClose={onClose}
      size="lg"
      title={p ? `${titleCase(p.returnKind)} — ${p.periodStart} → ${p.periodEnd}` : "Period"}
      description={p?.returnDef ? `${p.returnDef.name} (${p.returnDef.citation})` : undefined}
    >
      {detail.loading && !p ? <div className="text-meta text-content-subtle">Loading…</div> : null}
      {detail.error ? <LoadError message={detail.error} onRetry={detail.reload} /> : null}
      {p ? (
        <div className="space-y-5">
          {action.error ? <Alert tone="danger" size="sm">{action.error}</Alert> : null}
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={periodTone(p.status)} size="sm" dot>
              {titleCase(p.status)}
            </Badge>
            <Badge tone="neutral" size="sm">
              {p.regime.toUpperCase()} · {p.currency}
            </Badge>
            {p.obligation ? (
              <Badge tone={p.obligation.status === "breached" ? "danger" : p.obligation.status === "satisfied" ? "success" : "info"} size="sm">
                Obligation {titleCase(p.obligation.status)}
              </Badge>
            ) : null}
          </div>

          <dl className="divide-y divide-border">
            <Row label="Return due">{isoDate(p.dueDate)}</Row>
            {p.paymentDueDate ? <Row label="Payment due">{isoDate(p.paymentDueDate)}</Row> : null}
            {p.filedAt ? (
              <Row label="Filed" hint={p.filingReference ? `Ref ${p.filingReference}` : undefined}>
                {dateTime(p.filedAt)}
              </Row>
            ) : null}
            {p.paidAt ? <Row label="Paid">{dateTime(p.paidAt)}</Row> : null}
            {p.notes ? <Row label="Notes">{p.notes}</Row> : null}
          </dl>

          <section className="space-y-2 rounded-md border border-border p-3">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-semibold text-content">Aggregates</h3>
              <span className="text-2xs text-content-subtle">{computed ? `computed ${dateTime(p.computedAt)}` : "not yet computed"}</span>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <div className="mb-1 text-2xs font-semibold uppercase tracking-wide text-content-subtle">On record</div>
                <dl className="divide-y divide-border">
                  {isVat ? (
                    <>
                      <Row label="Output tax">{figure(p.outputTax, p.currency, computed)}</Row>
                      <Row label="Input tax">{figure(p.inputTax, p.currency, computed)}</Row>
                      <Row label="of which self-accounted">{figure(p.selfAccountedTax, p.currency, computed)}</Row>
                    </>
                  ) : (
                    <Row label="Withheld">{figure(p.withheldTotal, p.currency, computed)}</Row>
                  )}
                  <Row label="Net payable">
                    <span className="font-semibold">{figure(p.netPayable, p.currency, computed)}</span>
                  </Row>
                  <Row label="Records">
                    {count(p.determinationCount)} determinations · {count(p.certificateCount)} certificates
                  </Row>
                  <Row label="Excluded (other currency)">{count(p.excludedCount)}</Row>
                </dl>
              </div>
              <div>
                <div className="mb-1 text-2xs font-semibold uppercase tracking-wide text-content-subtle">Live now</div>
                <dl className="divide-y divide-border">
                  {isVat ? (
                    <>
                      <Row label="Output tax">{money(p.live.outputTax, p.currency)}</Row>
                      <Row label="Input tax">{money(p.live.inputTax, p.currency)}</Row>
                      <Row label="of which self-accounted">{money(p.live.selfAccountedTax, p.currency)}</Row>
                    </>
                  ) : (
                    <Row label="Withheld">{money(p.live.withheldTotal, p.currency)}</Row>
                  )}
                  <Row label="Net payable">
                    <span className="font-semibold">{money(p.live.netPayable, p.currency)}</span>
                  </Row>
                  <Row label="Records">
                    {count(p.live.determinationCount)} determinations · {count(p.live.certificateCount)} certificates
                  </Row>
                  <Row label="Excluded (other currency)">{count(p.live.excludedCount)}</Row>
                </dl>
              </div>
            </div>
            {basisNote ? <ReasonList reasons={[basisNote]} /> : null}
            {p.status !== "filed" && p.status !== "paid" ? (
              <Button size="sm" variant="secondary" onClick={() => void compute()} loading={action.busy === "compute"}>
                {computed ? "Recompute" : "Compute"}
              </Button>
            ) : (
              <div className="text-2xs text-content-subtle">
                These are the figures that were {p.status}
                {p.filingReference ? ` under reference ${p.filingReference}` : ""}, so they are frozen. Live now moves as
                determinations and certificates change; re-open the return to correct what was submitted.
              </div>
            )}
          </section>

          {p.status !== "filed" && p.status !== "paid" ? (
            <form onSubmit={file} className="space-y-3 rounded-md border border-border p-3">
              <h3 className="text-sm font-semibold text-content">File the return</h3>
              {!computed ? <Alert tone="info" size="sm">Compute the period first so the filed figures are on record.</Alert> : null}
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Filing reference" required hint="Authority receipt / submission id">
                  <Input value={filingReference} onChange={(e) => setFilingReference(e.target.value)} required />
                </Field>
                <Field label="Filed at" hint="Back-entry only, never in the future; lateness is measured from when the filing is recorded here">
                  <Input type="datetime-local" value={filedAt} onChange={(e) => setFiledAt(e.target.value)} />
                </Field>
              </div>
              <Button type="submit" size="sm" disabled={!computed || filingReference.trim() === ""} loading={action.busy === "file"}>
                Record filing
              </Button>
            </form>
          ) : null}

          {p.status === "filed" ? (
            <section className="space-y-2 rounded-md border border-border p-3">
              <h3 className="text-sm font-semibold text-content">Payment</h3>
              <Button size="sm" onClick={() => void markPaid()} loading={action.busy === "paid"}>
                Mark paid
              </Button>
            </section>
          ) : null}

          {p.status === "filed" || p.status === "paid" ? (
            <form onSubmit={reopen} className="space-y-2 rounded-md border border-border p-3">
              <h3 className="text-sm font-semibold text-content">Re-open</h3>
              <Alert tone="warning" size="sm">
                Re-opening clears the filing reference and the filed/paid stamps and puts the obligation back on the
                clock. Nothing keeps a submission on top of numbers that changed: correct, recompute and file again.
              </Alert>
              <Field label="Reason" required>
                <Textarea value={reopenReason} onChange={(e) => setReopenReason(e.target.value)} rows={2} required />
              </Field>
              <Button
                type="submit"
                size="sm"
                variant="danger"
                disabled={reopenReason.trim().length === 0}
                loading={action.busy === "reopen"}
              >
                Re-open the return
              </Button>
            </form>
          ) : null}
        </div>
      ) : null}
    </Drawer>
  );
}
