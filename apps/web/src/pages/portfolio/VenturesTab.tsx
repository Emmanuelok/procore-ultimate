/**
 * JOINT VENTURES, CONSORTIA AND SPVs (#1057–#1060).
 *
 * Two numbers on this screen are the ones an owner actually needs and neither
 * is obvious from the raw rows: OUR SHARE of what the venture has taken in,
 * and whether a board decision actually carried under the deed.
 *
 * The share register is shown as recorded. When the shares do not total 100%
 * the panel says so loudly rather than normalising them — a venture whose deed
 * adds to 97% is a real and expensive fact.
 */
import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  DataTable,
  Drawer,
  EmptyState,
  Field,
  Input,
  Select,
  Table,
  Td,
  Textarea,
  Th,
  toast,
  type DataColumns,
} from "../../ui";
import { IconPlus, IconUsers } from "../../ui/icons";
import {
  DASH,
  JV_DECISION_TYPES,
  JV_LIABILITY_BASES,
  JV_PARTNER_ROLES,
  JV_STRUCTURES,
  JV_TRANSACTION_KINDS,
  LoadError,
  ReasonList,
  Row,
  isoDate,
  money,
  moneyShort,
  num,
  pct,
  projectApi,
  statusTone,
  titleCase,
  useAction,
  useResource,
  type DecisionOutcome,
  type JvTransaction,
  type Paginated,
  type PartnerPosition,
  type Venture,
} from "./portfolioShared";

export default function VenturesTab({ projectId, onChanged }: { projectId: string; onChanged: () => void }) {
  const list = useResource<Paginated<Venture>>(
    `/api/v1/projects/${projectId}/portfolio/ventures?page=1&pageSize=100`,
  );
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title="Ventures on this project"
          subtitle="Partner shares, capital calls, distributions and deed governance. Every figure is in the venture's own currency; a transaction in another is excluded and counted."
          actions={
            <Button size="sm" icon={IconPlus} onClick={() => setCreating(true)}>
              New venture
            </Button>
          }
        />
        <CardBody flush>
          {list.error ? (
            <div className="p-4">
              <LoadError message={list.error} onRetry={list.reload} />
            </div>
          ) : !list.loading && (list.data?.items.length ?? 0) === 0 ? (
            <div className="p-4">
              <EmptyState
                icon={IconUsers}
                title="No venture on this project"
                description="Record the joint venture, consortium, SPV or alliance delivering this project and its partner shares, and the platform can compute your share, watch the capital calls and decide the board votes against the deed."
                action={<Button onClick={() => setCreating(true)}>Record a venture</Button>}
              />
            </div>
          ) : (
            <div className="divide-y divide-border">
              {(list.data?.items ?? []).map((v) => (
                <button
                  key={v.id}
                  type="button"
                  onClick={() => setOpenId(v.id)}
                  className="flex w-full flex-wrap items-center justify-between gap-3 p-4 text-left hover:bg-surface-hover"
                >
                  <div>
                    <div className="font-semibold text-content">{v.name}</div>
                    <div className="text-2xs text-content-subtle">
                      {titleCase(v.structure)} · {v.currency} · {num(v.summary.partnerCount)} partner
                      {v.summary.partnerCount === 1 ? "" : "s"}
                      {v.deedReference ? ` · ${v.deedReference}` : ""}
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-3 text-meta">
                    <span className="text-content-muted">
                      Our share{" "}
                      <span className="font-semibold text-content">
                        {v.summary.ourSharePercent === null ? DASH : pct(v.summary.ourSharePercent)}
                      </span>
                    </span>
                    <span className="text-content-muted">
                      Contributed{" "}
                      <span className="font-semibold text-content">
                        {moneyShort(v.summary.totalContributed, v.currency)}
                      </span>
                    </span>
                    {v.summary.overdueCallCount > 0 ? (
                      <Badge tone="danger" size="xs" dot>
                        {num(v.summary.overdueCallCount)} overdue call
                        {v.summary.overdueCallCount === 1 ? "" : "s"}
                      </Badge>
                    ) : null}
                    {!v.summary.sharesBalanced ? (
                      <Badge tone="warning" size="xs">
                        Shares total {pct(v.summary.shareTotalPercent)}
                      </Badge>
                    ) : null}
                    <Badge tone={statusTone(v.status)} size="xs">
                      {titleCase(v.status)}
                    </Badge>
                  </div>
                </button>
              ))}
            </div>
          )}
        </CardBody>
      </Card>

      <VentureDrawer
        projectId={projectId}
        jvId={openId}
        onClose={() => setOpenId(null)}
        onChanged={() => {
          list.reload();
          onChanged();
        }}
      />
      <VentureCreateDrawer
        projectId={projectId}
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(id) => {
          setCreating(false);
          list.reload();
          onChanged();
          setOpenId(id);
        }}
      />
    </div>
  );
}

/* =============================== Detail =================================== */

function VentureDrawer({
  projectId,
  jvId,
  onClose,
  onChanged,
}: {
  projectId: string;
  jvId: string | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const detail = useResource<Venture>(
    jvId ? `/api/v1/projects/${projectId}/portfolio/ventures/${jvId}` : null,
  );
  const api = projectApi(projectId);
  const action = useAction();
  const [partnerForm, setPartnerForm] = useState<Record<string, string>>({});
  const [txForm, setTxForm] = useState<Record<string, string>>({ kind: "capital_call" });
  const [votes, setVotes] = useState<Record<string, string>>({});
  const [decisionForm, setDecisionForm] = useState<Record<string, string>>({ decisionType: "ordinary" });
  const [preview, setPreview] = useState<DecisionOutcome | null>(null);

  useEffect(() => {
    setPartnerForm({});
    setTxForm({ kind: "capital_call" });
    setVotes({});
    setDecisionForm({ decisionType: "ordinary" });
    setPreview(null);
    action.clear();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jvId]);

  const v = detail.data;

  const positionColumns = useMemo<DataColumns<PartnerPosition>>(
    () => [
      {
        id: "name",
        header: "Partner",
        accessor: "name",
        type: "text",
        width: 200,
        cell: ({ row }) => (
          <span>
            {row.name}
            {row.isSelf ? (
              <Badge tone="info" size="xs" className="ml-1">
                us
              </Badge>
            ) : null}
          </span>
        ),
      },
      { id: "role", header: "Role", accessor: (r) => titleCase(r.role), type: "text", width: 110 },
      {
        id: "sharePercent",
        header: "Share",
        accessor: "sharePercent",
        type: "number",
        align: "right",
        width: 90,
        cell: ({ row }) => pct(row.sharePercent),
      },
      {
        id: "contributed",
        header: "Contributed",
        accessor: "contributed",
        type: "number",
        align: "right",
        width: 140,
        cell: ({ row }) => moneyShort(row.contributed, v?.currency ?? null),
      },
      {
        id: "distributed",
        header: "Distributed",
        accessor: "distributed",
        type: "number",
        align: "right",
        width: 140,
        cell: ({ row }) => moneyShort(row.distributed, v?.currency ?? null),
      },
      {
        id: "outstandingCalls",
        header: "Outstanding",
        accessor: "outstandingCalls",
        type: "number",
        align: "right",
        width: 140,
        cell: ({ row }) => moneyShort(row.outstandingCalls, v?.currency ?? null),
      },
      {
        id: "overdueAmount",
        header: "Overdue",
        accessor: "overdueAmount",
        type: "number",
        align: "right",
        width: 140,
        cell: ({ row }) =>
          row.overdueAmount > 0 ? (
            <span className="font-semibold text-danger-text">
              {moneyShort(row.overdueAmount, v?.currency ?? null)}
            </span>
          ) : (
            DASH
          ),
      },
      {
        id: "uncalledCommitment",
        header: "Uncalled",
        accessor: (r) => r.uncalledCommitment ?? 0,
        type: "number",
        align: "right",
        width: 140,
        cell: ({ row }) =>
          row.uncalledCommitment === null ? (
            <span className="italic text-content-subtle">unknown</span>
          ) : (
            moneyShort(row.uncalledCommitment, v?.currency ?? null)
          ),
      },
    ],
    [v?.currency],
  );

  const txColumns = useMemo<DataColumns<JvTransaction>>(
    () => [
      { id: "kind", header: "Kind", accessor: (r) => titleCase(r.kind), type: "text", width: 190 },
      {
        id: "partner",
        header: "Partner",
        accessor: (r) => v?.partners?.find((p) => p.id === r.partnerId)?.name ?? r.partnerId,
        type: "text",
        width: 180,
      },
      {
        id: "amount",
        header: "Amount",
        accessor: "amount",
        type: "number",
        align: "right",
        width: 140,
        cell: ({ row }) => moneyShort(row.amount, row.currency),
      },
      { id: "dueDate", header: "Due", accessor: (r) => r.dueDate ?? "", type: "date", width: 110, cell: ({ row }) => isoDate(row.dueDate) },
      {
        id: "status",
        header: "Status",
        accessor: "status",
        type: "text",
        width: 110,
        cell: ({ row }) => (
          <Badge tone={statusTone(row.status)} size="xs" dot>
            {titleCase(row.status)}
          </Badge>
        ),
      },
      {
        id: "settledDate",
        header: "Settled",
        accessor: (r) => r.settledDate ?? "",
        type: "date",
        width: 110,
        cell: ({ row }) => isoDate(row.settledDate),
      },
    ],
    [v?.partners],
  );

  async function addPartner(e: FormEvent) {
    e.preventDefault();
    if (!jvId) return;
    const share = Number(partnerForm["sharePercent"] ?? "");
    const capital = Number(partnerForm["committedCapital"] ?? "");
    const res = await action.run("partner", () =>
      api.addPartner(jvId, {
        name: partnerForm["name"] ?? "",
        role: partnerForm["role"] ?? "partner",
        sharePercent: Number.isFinite(share) ? share : 0,
        committedCapital: partnerForm["committedCapital"] && Number.isFinite(capital) ? capital : undefined,
        liabilityBasis: partnerForm["liabilityBasis"] ?? "joint_and_several",
        isSelf: partnerForm["isSelf"] === "yes",
      }),
    );
    if (res) {
      toast.success("Partner added");
      setPartnerForm({});
      detail.reload();
      onChanged();
    }
  }

  async function addTransaction(e: FormEvent) {
    e.preventDefault();
    if (!jvId) return;
    const amount = Number(txForm["amount"] ?? "");
    const res = await action.run("tx", () =>
      api.createTransaction(jvId, {
        partnerId: txForm["partnerId"] ?? "",
        kind: txForm["kind"] ?? "capital_call",
        amount: Number.isFinite(amount) ? amount : 0,
        dueDate: txForm["dueDate"] || undefined,
        description: txForm["description"] || undefined,
      }),
    );
    if (res) {
      toast.success("Transaction recorded");
      setTxForm({ kind: "capital_call" });
      detail.reload();
      onChanged();
    }
  }

  async function txAction(txId: string, kind: "call" | "settle") {
    if (!jvId) return;
    const res = await action.run(`${kind}-${txId}`, () =>
      kind === "call" ? api.callTransaction(jvId, txId, {}) : api.settleTransaction(jvId, txId, {}),
    );
    if (res) {
      toast.success(kind === "call" ? "Called — an obligation now carries the deadline" : "Settled");
      detail.reload();
      onChanged();
    }
  }

  async function previewVote() {
    if (!jvId) return;
    const res = await action.run("preview", () =>
      api.previewVote(jvId, {
        decisionType: decisionForm["decisionType"] ?? "ordinary",
        votes: Object.entries(votes)
          .filter(([, val]) => val !== "")
          .map(([partnerId, vote]) => ({ partnerId, vote })),
      }),
    );
    if (res) setPreview(res);
  }

  async function recordDecision(e: FormEvent) {
    e.preventDefault();
    if (!jvId) return;
    const res = await action.run("decision", () =>
      api.recordDecision(jvId, {
        decisionType: decisionForm["decisionType"] ?? "ordinary",
        meetingDate: decisionForm["meetingDate"] ?? "",
        subject: decisionForm["subject"] ?? "",
        narrative: decisionForm["narrative"] || undefined,
        deedClause: decisionForm["deedClause"] || undefined,
        votes: Object.entries(votes)
          .filter(([, val]) => val !== "")
          .map(([partnerId, vote]) => ({ partnerId, vote })),
      }),
    );
    if (res) {
      toast.success(`Decision recorded — ${titleCase(res.decision.outcome)}`);
      setVotes({});
      setPreview(null);
      detail.reload();
      onChanged();
    }
  }

  return (
    <Drawer
      open={jvId !== null}
      onClose={onClose}
      size="xl"
      title={v ? v.name : "Venture"}
      description={v ? `${titleCase(v.structure)} · ${v.currency} · ${titleCase(v.status)}` : undefined}
    >
      {detail.error ? (
        <LoadError message={detail.error} onRetry={detail.reload} />
      ) : !v ? (
        <div className="text-meta text-content-subtle">Loading…</div>
      ) : (
        <div className="space-y-4">
          {action.error ? (
            <Alert tone="danger" size="sm">
              {action.error}
            </Alert>
          ) : null}
          {!v.summary.sharesBalanced ? (
            <Alert tone="warning" size="sm" title="The share register does not total 100%">
              {v.summary.warnings.join(" ")}
            </Alert>
          ) : null}

          <dl className="divide-y divide-border">
            <Row label="Deed">{v.deedReference ?? DASH}</Row>
            <Row label="Formed">{isoDate(v.formationDate)}</Row>
            <Row label="Quorum">
              {v.quorumPercent === null ? "not recorded — a vote is treated as quorate" : pct(v.quorumPercent)}
            </Row>
            <Row label="Reserved-matter threshold">
              {v.reservedMatterThresholdPercent === null
                ? "not recorded — unanimity of those present is applied"
                : pct(v.reservedMatterThresholdPercent)}
            </Row>
            <Row label="Our share">
              {v.summary.ourSharePercent === null ? (
                <span className="italic text-content-subtle">no partner is flagged as us</span>
              ) : (
                pct(v.summary.ourSharePercent)
              )}
            </Row>
            <Row label="Total contributed">{money(v.summary.totalContributed, v.currency)}</Row>
            <Row label="Total distributed">{money(v.summary.totalDistributed, v.currency)}</Row>
            <Row label="Outstanding calls">{money(v.summary.totalOutstandingCalls, v.currency)}</Row>
            <Row label="Overdue">
              <span className={v.summary.totalOverdueAmount > 0 ? "font-semibold text-danger-text" : undefined}>
                {money(v.summary.totalOverdueAmount, v.currency)}
              </span>
            </Row>
          </dl>
          <ReasonList reasons={v.summary.reasons} />

          <div>
            <div className="mb-1 text-2xs font-semibold uppercase tracking-wide text-content-subtle">
              Partner positions
            </div>
            <DataTable<PartnerPosition>
              tableId="portfolio.jv-positions"
              data={v.summary.positions}
              columns={positionColumns}
              getRowId={(row) => row.partnerId}
              height={220}
              rowHeight={40}
              stickyHeader
              toolbar={false}
              empty={{ title: "No partners on the register" }}
              aria-label="Partner positions"
            />
            <form onSubmit={addPartner} className="mt-2 grid gap-2 rounded-md border border-border p-2 sm:grid-cols-6">
              <Field label="Name" className="sm:col-span-2">
                <Input
                  value={partnerForm["name"] ?? ""}
                  onChange={(e) => setPartnerForm((f) => ({ ...f, name: e.target.value }))}
                  size="sm"
                  required
                />
              </Field>
              <Field label="Role">
                <Select
                  value={partnerForm["role"] ?? "partner"}
                  onChange={(e) => setPartnerForm((f) => ({ ...f, role: e.target.value }))}
                  size="sm"
                >
                  {JV_PARTNER_ROLES.map((r) => (
                    <option key={r} value={r}>
                      {titleCase(r)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Share %">
                <Input
                  type="number"
                  value={partnerForm["sharePercent"] ?? ""}
                  onChange={(e) => setPartnerForm((f) => ({ ...f, sharePercent: e.target.value }))}
                  size="sm"
                  min={0}
                  max={100}
                  step="0.01"
                  required
                />
              </Field>
              <Field label="Committed capital">
                <Input
                  type="number"
                  value={partnerForm["committedCapital"] ?? ""}
                  onChange={(e) => setPartnerForm((f) => ({ ...f, committedCapital: e.target.value }))}
                  size="sm"
                  min={0}
                  step="0.01"
                />
              </Field>
              <div className="flex items-end gap-2">
                <Field label="Is us?">
                  <Select
                    value={partnerForm["isSelf"] ?? "no"}
                    onChange={(e) => setPartnerForm((f) => ({ ...f, isSelf: e.target.value }))}
                    size="sm"
                  >
                    <option value="no">No</option>
                    <option value="yes">Yes</option>
                  </Select>
                </Field>
                <Button size="sm" type="submit" loading={action.busy === "partner"}>
                  Add
                </Button>
              </div>
            </form>
          </div>

          <div>
            <div className="mb-1 text-2xs font-semibold uppercase tracking-wide text-content-subtle">
              Contributions and distributions
            </div>
            <DataTable<JvTransaction>
              tableId="portfolio.jv-transactions"
              data={v.transactions ?? []}
              columns={txColumns}
              getRowId={(row) => row.id}
              height={220}
              rowHeight={40}
              stickyHeader
              toolbar={false}
              rowTone={(row) => (row.status === "overdue" ? "danger" : undefined)}
              empty={{ title: "No transactions recorded" }}
              aria-label="Venture transactions"
            />
            <div className="mt-2 space-y-1">
              {(v.transactions ?? [])
                .filter((t) => t.status === "planned" || t.status === "called" || t.status === "overdue")
                .map((t) => (
                  <div key={t.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-2 py-1">
                    <span className="text-meta text-content">
                      {titleCase(t.kind)} · {moneyShort(t.amount, t.currency)} ·{" "}
                      <span className="text-content-subtle">due {isoDate(t.dueDate)}</span>
                    </span>
                    <span className="flex gap-2">
                      {t.status === "planned" ? (
                        <Button
                          size="xs"
                          onClick={() => void txAction(t.id, "call")}
                          loading={action.busy === `call-${t.id}`}
                        >
                          Call
                        </Button>
                      ) : null}
                      <Button
                        size="xs"
                        variant="secondary"
                        onClick={() => void txAction(t.id, "settle")}
                        loading={action.busy === `settle-${t.id}`}
                      >
                        Settle
                      </Button>
                    </span>
                  </div>
                ))}
              <p className="text-2xs text-content-subtle">
                Calling a contribution raises an obligation with its deadline; the person who recorded a transaction
                cannot confirm it was settled.
              </p>
            </div>
            <form onSubmit={addTransaction} className="mt-2 grid gap-2 rounded-md border border-border p-2 sm:grid-cols-5">
              <Field label="Partner">
                <Select
                  value={txForm["partnerId"] ?? ""}
                  onChange={(e) => setTxForm((f) => ({ ...f, partnerId: e.target.value }))}
                  size="sm"
                  required
                >
                  <option value="">Choose</option>
                  {(v.partners ?? []).map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Kind">
                <Select
                  value={txForm["kind"] ?? "capital_call"}
                  onChange={(e) => setTxForm((f) => ({ ...f, kind: e.target.value }))}
                  size="sm"
                >
                  {JV_TRANSACTION_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {titleCase(k)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={`Amount (${v.currency})`}>
                <Input
                  type="number"
                  value={txForm["amount"] ?? ""}
                  onChange={(e) => setTxForm((f) => ({ ...f, amount: e.target.value }))}
                  size="sm"
                  min={0}
                  step="0.01"
                  required
                />
              </Field>
              <Field label="Due">
                <Input
                  type="date"
                  value={txForm["dueDate"] ?? ""}
                  onChange={(e) => setTxForm((f) => ({ ...f, dueDate: e.target.value }))}
                  size="sm"
                />
              </Field>
              <div className="flex items-end">
                <Button size="sm" type="submit" loading={action.busy === "tx"}>
                  Record
                </Button>
              </div>
            </form>
          </div>

          <div className="rounded-md border border-border p-3">
            <div className="mb-2 text-2xs font-semibold uppercase tracking-wide text-content-subtle">
              Board decision
            </div>
            <form onSubmit={recordDecision} className="space-y-2">
              <div className="grid gap-2 sm:grid-cols-3">
                <Field label="Type">
                  <Select
                    value={decisionForm["decisionType"] ?? "ordinary"}
                    onChange={(e) => setDecisionForm((f) => ({ ...f, decisionType: e.target.value }))}
                    size="sm"
                  >
                    {JV_DECISION_TYPES.map((d) => (
                      <option key={d} value={d}>
                        {titleCase(d)}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Meeting date" required>
                  <Input
                    type="date"
                    value={decisionForm["meetingDate"] ?? ""}
                    onChange={(e) => setDecisionForm((f) => ({ ...f, meetingDate: e.target.value }))}
                    size="sm"
                    required
                  />
                </Field>
                <Field label="Deed clause">
                  <Input
                    value={decisionForm["deedClause"] ?? ""}
                    onChange={(e) => setDecisionForm((f) => ({ ...f, deedClause: e.target.value }))}
                    size="sm"
                  />
                </Field>
              </div>
              <Field label="Subject" required>
                <Input
                  value={decisionForm["subject"] ?? ""}
                  onChange={(e) => setDecisionForm((f) => ({ ...f, subject: e.target.value }))}
                  size="sm"
                  required
                />
              </Field>
              <div className="grid gap-2 sm:grid-cols-2">
                {(v.partners ?? []).map((p) => (
                  <Field key={p.id} label={`${p.name} (${pct(p.sharePercent)})`}>
                    <Select
                      value={votes[p.id] ?? ""}
                      onChange={(e) => setVotes((x) => ({ ...x, [p.id]: e.target.value }))}
                      size="sm"
                    >
                      <option value="">Absent</option>
                      <option value="for">For</option>
                      <option value="against">Against</option>
                      <option value="abstain">Abstain</option>
                    </Select>
                  </Field>
                ))}
              </div>
              <Field label="Narrative">
                <Textarea
                  rows={2}
                  value={decisionForm["narrative"] ?? ""}
                  onChange={(e) => setDecisionForm((f) => ({ ...f, narrative: e.target.value }))}
                />
              </Field>
              <div className="flex gap-2">
                <Button size="sm" variant="secondary" onClick={() => void previewVote()} loading={action.busy === "preview"}>
                  Test the outcome
                </Button>
                <Button size="sm" type="submit" loading={action.busy === "decision"}>
                  Record the decision
                </Button>
              </div>
            </form>
            {preview ? (
              <div className="mt-2 rounded-md border border-border bg-surface-sunken p-2">
                <div className="mb-1 flex items-center gap-2">
                  <Badge tone={statusTone(preview.outcome)} size="xs" dot>
                    {titleCase(preview.outcome)}
                  </Badge>
                  <span className="text-2xs text-content-subtle">
                    {pct(preview.sharePresentPercent)} present · {pct(preview.shareForPercent)} for ·{" "}
                    {pct(preview.shareAgainstPercent)} against · {pct(preview.shareAbstainPercent)} abstained
                  </span>
                </div>
                <ReasonList reasons={preview.reasons} />
              </div>
            ) : null}
          </div>

          {v.decisions && v.decisions.length > 0 ? (
            <div>
              <div className="mb-1 text-2xs font-semibold uppercase tracking-wide text-content-subtle">
                Decision log
              </div>
              <div className="overflow-x-auto">
                <Table>
                  <thead>
                    <tr>
                      <Th>Date</Th>
                      <Th>Subject</Th>
                      <Th>Type</Th>
                      <Th align="right">Present</Th>
                      <Th align="right">For</Th>
                      <Th>Outcome</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {v.decisions.map((d) => (
                      <tr key={d.id}>
                        <Td>{isoDate(d.meetingDate)}</Td>
                        <Td>
                          {d.subject}
                          {d.deedClause ? (
                            <div className="text-2xs text-content-subtle">{d.deedClause}</div>
                          ) : null}
                        </Td>
                        <Td>{titleCase(d.decisionType)}</Td>
                        <Td align="right">{pct(d.sharePresentPercent)}</Td>
                        <Td align="right">{pct(d.shareForPercent)}</Td>
                        <Td>
                          <Badge tone={statusTone(d.outcome)} size="xs" dot>
                            {titleCase(d.outcome)}
                          </Badge>
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </div>
            </div>
          ) : null}
        </div>
      )}
    </Drawer>
  );
}

/* =============================== Create =================================== */

function VentureCreateDrawer({
  projectId,
  open,
  onClose,
  onCreated,
}: {
  projectId: string;
  open: boolean;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const action = useAction();
  const api = projectApi(projectId);
  const [form, setForm] = useState<Record<string, string>>({ structure: "joint_venture" });

  useEffect(() => {
    setForm({ structure: "joint_venture" });
    action.clear();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const set = (key: string, value: string) => setForm((f) => ({ ...f, [key]: value }));
  const numeric = (key: string): number | undefined => {
    const raw = form[key];
    if (raw === undefined || raw.trim() === "") return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    const res = await action.run("create", () =>
      api.createVenture({
        name: form["name"] ?? "",
        structure: form["structure"] ?? "joint_venture",
        currency: form["currency"] ?? "",
        formationDate: form["formationDate"] || undefined,
        endDate: form["endDate"] || undefined,
        deedReference: form["deedReference"] || undefined,
        jurisdiction: form["jurisdiction"] || undefined,
        registeredNumber: form["registeredNumber"] || undefined,
        quorumPercent: numeric("quorumPercent"),
        reservedMatterThresholdPercent: numeric("reservedMatterThresholdPercent"),
      }),
    );
    if (res) {
      toast.success("Venture recorded — add its partners and their shares next");
      onCreated(res.id);
    }
  }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      size="md"
      title="New venture"
      description="Record the deed's quorum and reserved-matter threshold. Without them the platform applies a stated default rather than a silent one."
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="portfolio-venture-create" loading={action.busy === "create"}>
            Save
          </Button>
        </div>
      }
    >
      <form id="portfolio-venture-create" onSubmit={submit} className="space-y-4">
        {action.error ? (
          <Alert tone="danger" size="sm">
            {action.error}
          </Alert>
        ) : null}
        <Field label="Name" required>
          <Input value={form["name"] ?? ""} onChange={(e) => set("name", e.target.value)} required />
        </Field>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Structure" required>
            <Select value={form["structure"] ?? "joint_venture"} onChange={(e) => set("structure", e.target.value)}>
              {JV_STRUCTURES.map((s) => (
                <option key={s} value={s}>
                  {titleCase(s)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Currency" required>
            <Input value={form["currency"] ?? ""} onChange={(e) => set("currency", e.target.value)} maxLength={3} required />
          </Field>
          <Field label="Jurisdiction">
            <Input value={form["jurisdiction"] ?? ""} onChange={(e) => set("jurisdiction", e.target.value)} />
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Formation date">
            <Input type="date" value={form["formationDate"] ?? ""} onChange={(e) => set("formationDate", e.target.value)} />
          </Field>
          <Field label="End date">
            <Input type="date" value={form["endDate"] ?? ""} onChange={(e) => set("endDate", e.target.value)} />
          </Field>
        </div>
        <Field label="Deed reference">
          <Input value={form["deedReference"] ?? ""} onChange={(e) => set("deedReference", e.target.value)} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Quorum %" hint="Share of the register that must be present for a vote to count">
            <Input
              type="number"
              value={form["quorumPercent"] ?? ""}
              onChange={(e) => set("quorumPercent", e.target.value)}
              min={0}
              max={100}
              step="0.01"
            />
          </Field>
          <Field label="Reserved-matter threshold %" hint="Often unanimity">
            <Input
              type="number"
              value={form["reservedMatterThresholdPercent"] ?? ""}
              onChange={(e) => set("reservedMatterThresholdPercent", e.target.value)}
              min={0}
              max={100}
              step="0.01"
            />
          </Field>
        </div>
        <Field label="Registered number">
          <Input value={form["registeredNumber"] ?? ""} onChange={(e) => set("registeredNumber", e.target.value)} />
        </Field>
        <p className="text-2xs text-content-subtle">
          Liability basis is recorded per partner ({JV_LIABILITY_BASES.map(titleCase).join(", ")}).
        </p>
      </form>
    </Drawer>
  );
}
