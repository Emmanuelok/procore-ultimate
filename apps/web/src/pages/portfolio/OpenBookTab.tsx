/**
 * OPEN-BOOK VERIFICATION, DISALLOWED COST AND AUDIT RIGHTS (#1063–#1066).
 *
 * This is the assurance end of the module and the page says so out loud:
 *
 *  · a cost verified by the person who claimed it is an assertion, not a
 *    verification, and the API refuses it — the panel explains why;
 *  · a disallowance with no contract clause is an opinion, and every read
 *    counts how many of them there are;
 *  · an extrapolation from a sample is labelled a PROJECTION with the sample
 *    and population it rests on, never a finding on the untested items.
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
import { IconAudit, IconPlus } from "../../ui/icons";
import {
  AUDIT_SUBJECT_TYPES,
  Basis,
  DASH,
  DEFINED_COST_COMPONENTS,
  DEFINED_COST_VERDICTS,
  DISALLOWED_CATEGORIES,
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
  type AuditRights,
  type DefinedCostItem,
  type DisallowedCost,
  type DisallowedListResponse,
  type Paginated,
  type Verification,
} from "./portfolioShared";

export default function OpenBookTab({ projectId, onChanged }: { projectId: string; onChanged: () => void }) {
  const verifications = useResource<Paginated<Verification>>(
    `/api/v1/projects/${projectId}/portfolio/verifications?page=1&pageSize=100`,
  );
  const disallowed = useResource<DisallowedListResponse>(
    `/api/v1/projects/${projectId}/portfolio/disallowed-costs?page=1&pageSize=200`,
  );
  const audits = useResource<Paginated<AuditRights>>(
    `/api/v1/projects/${projectId}/portfolio/audit-rights?page=1&pageSize=100`,
  );
  const [openVerification, setOpenVerification] = useState<string | null>(null);
  const [creating, setCreating] = useState<null | "verification" | "audit">(null);

  function reloadAll() {
    verifications.reload();
    disallowed.reload();
    audits.reload();
    onChanged();
  }

  const verificationColumns = useMemo<DataColumns<Verification>>(
    () => [
      { id: "reference", header: "Ref", accessor: "reference", type: "code", width: 100 },
      { id: "title", header: "Exercise", accessor: "title", type: "text", width: 260 },
      {
        id: "period",
        header: "Period",
        accessor: (r) => r.periodStart ?? "",
        type: "text",
        width: 190,
        cell: ({ row }) =>
          row.periodStart || row.periodEnd ? `${isoDate(row.periodStart)} → ${isoDate(row.periodEnd)}` : DASH,
      },
      {
        id: "status",
        header: "Status",
        accessor: "status",
        type: "text",
        width: 120,
        cell: ({ row }) => (
          <Badge tone={statusTone(row.status)} size="xs" dot>
            {titleCase(row.status)}
          </Badge>
        ),
      },
      {
        id: "claimedAmount",
        header: "Claimed",
        accessor: "claimedAmount",
        type: "number",
        align: "right",
        width: 140,
        cell: ({ row }) => moneyShort(row.claimedAmount, row.currency),
      },
      {
        id: "verifiedAmount",
        header: "Verified",
        accessor: "verifiedAmount",
        type: "number",
        align: "right",
        width: 140,
        cell: ({ row }) => moneyShort(row.verifiedAmount, row.currency),
      },
      {
        id: "disallowedAmount",
        header: "Disallowed",
        accessor: "disallowedAmount",
        type: "number",
        align: "right",
        width: 140,
        cell: ({ row }) =>
          row.disallowedAmount > 0 ? (
            <span className="font-semibold text-danger-text">{moneyShort(row.disallowedAmount, row.currency)}</span>
          ) : (
            DASH
          ),
      },
      {
        id: "plannedAt",
        header: "Planned",
        accessor: (r) => r.plannedAt ?? "",
        type: "date",
        width: 120,
        cell: ({ row }) => isoDate(row.plannedAt),
      },
    ],
    [],
  );

  const disallowedColumns = useMemo<DataColumns<DisallowedCost>>(
    () => [
      { id: "number", header: "No.", accessor: "number", type: "number", align: "right", width: 70, cell: ({ row }) => `DC-${String(row.number).padStart(3, "0")}` },
      { id: "description", header: "Description", accessor: "description", type: "text", width: 300 },
      {
        id: "category",
        header: "Ground",
        accessor: (r) => titleCase(r.category),
        type: "text",
        width: 200,
      },
      {
        id: "groundClause",
        header: "Clause",
        accessor: (r) => r.groundClause ?? "",
        type: "text",
        width: 140,
        cell: ({ row }) =>
          row.groundClause ?? <span className="italic text-warning-text">none cited</span>,
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
      {
        id: "status",
        header: "Status",
        accessor: "status",
        type: "text",
        width: 130,
        cell: ({ row }) => (
          <Badge tone={statusTone(row.status)} size="xs" dot>
            {titleCase(row.status)}
          </Badge>
        ),
      },
      {
        id: "responseDueAt",
        header: "Response due",
        accessor: (r) => r.responseDueAt ?? "",
        type: "date",
        width: 140,
        cell: ({ row }) => isoDate(row.responseDueAt),
      },
    ],
    [],
  );

  const auditColumns = useMemo<DataColumns<AuditRights>>(
    () => [
      { id: "reference", header: "Ref", accessor: "reference", type: "code", width: 110 },
      { id: "subjectName", header: "Subject", accessor: "subjectName", type: "text", width: 240 },
      { id: "clause", header: "Clause", accessor: (r) => r.clause ?? "", type: "text", width: 130, cell: ({ row }) => row.clause ?? DASH },
      { id: "noticeDate", header: "Notice", accessor: "noticeDate", type: "date", width: 120, cell: ({ row }) => isoDate(row.noticeDate) },
      {
        id: "scheduledDate",
        header: "Scheduled",
        accessor: (r) => r.scheduledDate ?? "",
        type: "date",
        width: 120,
        cell: ({ row }) => isoDate(row.scheduledDate),
      },
      {
        id: "status",
        header: "Status",
        accessor: "status",
        type: "text",
        width: 130,
        cell: ({ row }) => (
          <Badge tone={statusTone(row.status)} size="xs" dot>
            {titleCase(row.status)}
          </Badge>
        ),
      },
      {
        id: "records",
        header: "Records",
        accessor: (r) => r.recordsSummary?.outstanding ?? 0,
        type: "number",
        align: "right",
        width: 140,
        cell: ({ row }) =>
          row.recordsSummary
            ? `${row.recordsSummary.provided} / ${row.recordsSummary.requested} produced`
            : DASH,
      },
    ],
    [],
  );

  const summary = disallowed.data?.summary;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title="Open-book verifications"
          subtitle="Defined cost tested against the Schedule of Cost Components. A cost verified by whoever claimed it is refused: the claim and the test are not the same act."
          actions={
            <Button size="sm" icon={IconPlus} onClick={() => setCreating("verification")}>
              New verification
            </Button>
          }
        />
        <CardBody flush>
          {verifications.error ? (
            <div className="p-4">
              <LoadError message={verifications.error} onRetry={verifications.reload} />
            </div>
          ) : (
            <DataTable<Verification>
              tableId="portfolio.verifications"
              data={verifications.data?.items ?? []}
              columns={verificationColumns}
              getRowId={(row) => row.id}
              loading={verifications.loading && !verifications.data}
              height={300}
              rowHeight={44}
              stickyHeader
              flush
              toolbar={false}
              onRowClick={({ row }) => setOpenVerification(row.id)}
              empty={{
                title: "No verification carried out",
                description:
                  "An audit right that is never exercised is not a control. Plan a verification, add the claimed cost items, and give each one a verdict with its evidence.",
                action: <Button onClick={() => setCreating("verification")}>Plan a verification</Button>,
              }}
              aria-label="Open-book verifications"
            />
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Disallowed cost register"
          subtitle="A disallowance without a ground is an opinion and will not survive adjudication. The count of those is on this page deliberately."
        />
        <CardBody flush>
          {summary ? (
            <div className="flex flex-wrap gap-2 border-b border-border px-4 py-2 text-meta text-content-muted">
              {summary.byCurrency.map((b) => (
                <span key={b.currency} className="rounded-md border border-border bg-surface-raised px-2.5 py-1">
                  <span className="font-semibold text-content">{b.currency}</span> · raised {moneyShort(b.raised, null)} ·
                  outstanding {moneyShort(b.outstanding, null)} · deducted {moneyShort(b.deducted, null)}
                </span>
              ))}
              <span className="self-center text-2xs text-content-subtle">
                {num(summary.unresolved)} unresolved · {num(summary.overdueResponses)} past their response date ·{" "}
                {num(summary.withoutGround)} citing no clause
                {summary.oldestUnresolvedDays !== null
                  ? ` · oldest ${num(summary.oldestUnresolvedDays)} days`
                  : ""}
              </span>
            </div>
          ) : null}
          {disallowed.error ? (
            <div className="p-4">
              <LoadError message={disallowed.error} onRetry={disallowed.reload} />
            </div>
          ) : (
            <DataTable<DisallowedCost>
              tableId="portfolio.disallowed"
              data={disallowed.data?.items ?? []}
              columns={disallowedColumns}
              getRowId={(row) => row.id}
              loading={disallowed.loading && !disallowed.data}
              height={300}
              rowHeight={44}
              stickyHeader
              flush
              exportFileName="disallowed-costs"
              rowTone={(row) =>
                row.status === "disputed" ? "danger" : row.groundClause ? undefined : "warning"
              }
              empty={{
                title: "Nothing disallowed",
                description:
                  "Disallowances are usually raised from a verification verdict, so that the item, the ground and the amount stay tied together.",
              }}
              aria-label="Disallowed costs"
            />
          )}
          {summary ? (
            <div className="border-t border-border p-3">
              <ReasonList reasons={summary.reasons} />
            </div>
          ) : null}
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Audit rights"
          subtitle="The execution log for a contractual audit right: notice, access, records produced or refused. Refusal to produce records is itself a breach and is evidence in any later dispute."
          actions={
            <Button size="sm" icon={IconAudit} onClick={() => setCreating("audit")}>
              Give notice
            </Button>
          }
        />
        <CardBody flush>
          {audits.error ? (
            <div className="p-4">
              <LoadError message={audits.error} onRetry={audits.reload} />
            </div>
          ) : (
            <DataTable<AuditRights>
              tableId="portfolio.audit-rights"
              data={audits.data?.items ?? []}
              columns={auditColumns}
              getRowId={(row) => row.id}
              loading={audits.loading && !audits.data}
              height={260}
              rowHeight={44}
              stickyHeader
              flush
              toolbar={false}
              rowTone={(row) => (row.status === "obstructed" ? "danger" : undefined)}
              empty={{
                title: "No audit exercised",
                description:
                  "Giving notice under the audit clause raises an obligation on the counterparty to give access by the scheduled date; the sweep records an obstruction if it does not happen.",
              }}
              aria-label="Audit rights executions"
            />
          )}
        </CardBody>
      </Card>

      <VerificationDrawer
        projectId={projectId}
        verificationId={openVerification}
        onClose={() => setOpenVerification(null)}
        onChanged={reloadAll}
      />
      <CreateDrawer
        projectId={projectId}
        kind={creating}
        verifications={verifications.data?.items ?? []}
        onClose={() => setCreating(null)}
        onCreated={() => {
          setCreating(null);
          reloadAll();
        }}
      />
    </div>
  );
}

/* ============================ Verification =============================== */

function VerificationDrawer({
  projectId,
  verificationId,
  onClose,
  onChanged,
}: {
  projectId: string;
  verificationId: string | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const detail = useResource<Verification>(
    verificationId ? `/api/v1/projects/${projectId}/portfolio/verifications/${verificationId}` : null,
  );
  const api = projectApi(projectId);
  const action = useAction();
  const [itemForm, setItemForm] = useState<Record<string, string>>({ component: "people" });
  const [verdictFor, setVerdictFor] = useState<DefinedCostItem | null>(null);
  const [findings, setFindings] = useState("");

  useEffect(() => {
    setItemForm({ component: "people" });
    setVerdictFor(null);
    setFindings("");
    action.clear();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [verificationId]);

  const v = detail.data;
  const totals = v?.totals ?? null;

  const itemColumns = useMemo<DataColumns<DefinedCostItem>>(
    () => [
      { id: "component", header: "Component", accessor: (r) => titleCase(r.component), type: "text", width: 190 },
      { id: "description", header: "Item", accessor: "description", type: "text", width: 280 },
      {
        id: "claimedAmount",
        header: "Claimed",
        accessor: "claimedAmount",
        type: "number",
        align: "right",
        width: 140,
        cell: ({ row }) => moneyShort(row.claimedAmount, row.currency),
      },
      {
        id: "verifiedAmount",
        header: "Verified",
        accessor: "verifiedAmount",
        type: "number",
        align: "right",
        width: 140,
        cell: ({ row }) => (row.verdict === "pending" ? DASH : moneyShort(row.verifiedAmount, row.currency)),
      },
      {
        id: "verdict",
        header: "Verdict",
        accessor: "verdict",
        type: "text",
        width: 170,
        cell: ({ row }) => (
          <Badge
            tone={
              row.verdict === "verified"
                ? "success"
                : row.verdict === "disallowed" || row.verdict === "partially_disallowed"
                  ? "danger"
                  : row.verdict === "queried"
                    ? "warning"
                    : "neutral"
            }
            size="xs"
            dot
          >
            {titleCase(row.verdict)}
          </Badge>
        ),
      },
      {
        id: "evidence",
        header: "Evidence",
        accessor: (r) => r.evidenceRef ?? "",
        type: "text",
        width: 220,
        cell: ({ row }) =>
          row.evidenceRef ?? (
            <span className="italic text-warning-text">no evidence reference</span>
          ),
      },
    ],
    [],
  );

  async function addItem(e: FormEvent) {
    e.preventDefault();
    if (!verificationId) return;
    const claimed = Number(itemForm["claimedAmount"] ?? "");
    const res = await action.run("item", () =>
      api.addItems(verificationId, {
        component: itemForm["component"] ?? "people",
        description: itemForm["description"] ?? "",
        claimedAmount: Number.isFinite(claimed) ? claimed : 0,
        evidenceRef: itemForm["evidenceRef"] || undefined,
        contractHeading: itemForm["contractHeading"] || undefined,
      }),
    );
    if (res) {
      toast.success("Item added; the header totals are recomputed");
      setItemForm({ component: "people" });
      detail.reload();
      onChanged();
    }
  }

  async function report() {
    if (!verificationId) return;
    const res = await action.run("report", () =>
      api.setVerificationStatus(verificationId, { status: "reported", findings }),
    );
    if (res) {
      toast.success("Verification reported");
      detail.reload();
      onChanged();
    }
  }

  async function setStatus(status: string) {
    if (!verificationId) return;
    const res = await action.run(status, () => api.setVerificationStatus(verificationId, { status }));
    if (res) {
      toast.success(`Marked ${status.replace(/_/g, " ")}`);
      detail.reload();
      onChanged();
    }
  }

  return (
    <Drawer
      open={verificationId !== null}
      onClose={onClose}
      size="xl"
      title={v ? `${v.reference} — ${v.title}` : "Verification"}
      description={v ? `${v.currency} · ${titleCase(v.status)}` : undefined}
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
          <dl className="divide-y divide-border">
            <Row label="Claimed for the period">{money(v.claimedAmount, v.currency)}</Row>
            <Row label="Tested">{money(totals?.claimed ?? 0, v.currency)}</Row>
            <Row label="Untested" hint="claimed on the header less the items examined">
              {money(v.untestedAmount ?? 0, v.currency)}
            </Row>
            <Row label="Verified">{money(v.verifiedAmount, v.currency)}</Row>
            <Row label="Queried">{money(v.queriedAmount, v.currency)}</Row>
            <Row label="Disallowed">
              <span className={v.disallowedAmount > 0 ? "font-semibold text-danger-text" : undefined}>
                {money(v.disallowedAmount, v.currency)}
              </span>
            </Row>
            <Row label="Pending a verdict">{money(v.pendingAmount, v.currency)}</Row>
            <Row label="Verification rate">{pct(totals?.verificationRatePercent ?? null)}</Row>
            <Row label="Audit clause">{v.auditRightsClause ?? DASH}</Row>
            <Row label="Planned">{isoDate(v.plannedAt)}</Row>
          </dl>
          {totals ? <ReasonList reasons={totals.reasons} /> : null}

          {totals && totals.byComponent.length > 0 ? (
            <div>
              <div className="mb-1 text-2xs font-semibold uppercase tracking-wide text-content-subtle">
                By Schedule of Cost Components heading
              </div>
              <div className="overflow-x-auto">
                <Table>
                  <thead>
                    <tr>
                      <Th>Component</Th>
                      <Th align="right">Items</Th>
                      <Th align="right">Claimed</Th>
                      <Th align="right">Verified</Th>
                      <Th align="right">Disallowed</Th>
                      <Th align="right">Rate</Th>
                      <Th align="right">No evidence</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {totals.byComponent.map((c) => (
                      <tr key={c.component}>
                        <Td>{titleCase(c.component)}</Td>
                        <Td align="right">{num(c.items)}</Td>
                        <Td align="right">{moneyShort(c.claimed, v.currency)}</Td>
                        <Td align="right">{moneyShort(c.verified, v.currency)}</Td>
                        <Td align="right">{moneyShort(c.disallowed, v.currency)}</Td>
                        <Td align="right">{pct(c.verificationRatePercent)}</Td>
                        <Td align="right">
                          {c.itemsWithoutEvidence > 0 ? (
                            <span className="text-warning-text">{num(c.itemsWithoutEvidence)}</span>
                          ) : (
                            DASH
                          )}
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </div>
            </div>
          ) : null}

          {v.extrapolation ? (
            <div className="rounded-md border border-border p-3">
              <div className="mb-1 flex items-center justify-between">
                <span className="text-2xs font-semibold uppercase tracking-wide text-content-subtle">
                  Sampling extrapolation
                </span>
                <Badge tone={v.extrapolation.extrapolable ? "info" : "warning"} size="xs">
                  {v.extrapolation.extrapolable ? "Projection available" : "Not extrapolable"}
                </Badge>
              </div>
              {v.extrapolation.extrapolable ? (
                <dl className="divide-y divide-border">
                  <Row label="Observed disallowance rate">{pct(v.extrapolation.observedRatePercent)}</Row>
                  <Row label="Untested value">{money(v.extrapolation.untestedValue, v.currency)}</Row>
                  <Row label="Projected disallowance" hint="a projection from a sample, not a finding">
                    {money(v.extrapolation.projectedDisallowance, v.currency)}
                  </Row>
                  <Row label="Value coverage">{pct(v.extrapolation.coveragePercent)}</Row>
                </dl>
              ) : null}
              <Basis lines={v.extrapolation.basis} title="Basis" />
              <ReasonList reasons={v.extrapolation.reasons} className="mt-2" />
            </div>
          ) : null}

          <div>
            <div className="mb-1 text-2xs font-semibold uppercase tracking-wide text-content-subtle">
              Defined cost items ({v.items?.length ?? 0})
            </div>
            <DataTable<DefinedCostItem>
              tableId="portfolio.defined-cost"
              data={v.items ?? []}
              columns={itemColumns}
              getRowId={(row) => row.id}
              height={260}
              rowHeight={40}
              stickyHeader
              toolbar={false}
              onRowClick={({ row }) => setVerdictFor(row)}
              rowTone={(row) =>
                row.verdict === "disallowed" || row.verdict === "partially_disallowed"
                  ? "danger"
                  : row.verdict === "queried"
                    ? "warning"
                    : undefined
              }
              empty={{ title: "No items tested yet" }}
              aria-label="Defined cost items"
            />
            {v.status !== "reported" && v.status !== "closed" ? (
              <form onSubmit={addItem} className="mt-2 grid gap-2 rounded-md border border-border p-2 sm:grid-cols-6">
                <Field label="Component">
                  <Select
                    value={itemForm["component"] ?? "people"}
                    onChange={(e) => setItemForm((f) => ({ ...f, component: e.target.value }))}
                    size="sm"
                  >
                    {DEFINED_COST_COMPONENTS.map((c) => (
                      <option key={c} value={c}>
                        {titleCase(c)}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Description" className="sm:col-span-2">
                  <Input
                    value={itemForm["description"] ?? ""}
                    onChange={(e) => setItemForm((f) => ({ ...f, description: e.target.value }))}
                    size="sm"
                    required
                  />
                </Field>
                <Field label={`Claimed (${v.currency})`}>
                  <Input
                    type="number"
                    value={itemForm["claimedAmount"] ?? ""}
                    onChange={(e) => setItemForm((f) => ({ ...f, claimedAmount: e.target.value }))}
                    size="sm"
                    min={0}
                    step="0.01"
                    required
                  />
                </Field>
                <Field label="Evidence ref" hint="What the verifier looked at">
                  <Input
                    value={itemForm["evidenceRef"] ?? ""}
                    onChange={(e) => setItemForm((f) => ({ ...f, evidenceRef: e.target.value }))}
                    size="sm"
                  />
                </Field>
                <div className="flex items-end">
                  <Button size="sm" type="submit" loading={action.busy === "item"}>
                    Add
                  </Button>
                </div>
              </form>
            ) : null}
          </div>

          {v.status !== "closed" ? (
            <div className="space-y-2 border-t border-border pt-3">
              {v.status === "planned" ? (
                <Button size="sm" onClick={() => void setStatus("in_progress")} loading={action.busy === "in_progress"}>
                  Start the verification
                </Button>
              ) : null}
              {v.status === "in_progress" ? (
                <>
                  <Field label="Findings" required>
                    <Textarea rows={3} value={findings} onChange={(e) => setFindings(e.target.value)} />
                  </Field>
                  <Button size="sm" disabled={!findings.trim()} onClick={() => void report()} loading={action.busy === "report"}>
                    Report
                  </Button>
                  <p className="text-2xs text-content-subtle">
                    A report is refused while any tested item is still pending a verdict: it would overstate what was
                    verified.
                  </p>
                </>
              ) : null}
              {v.status === "reported" ? (
                <Button size="sm" variant="ghost" onClick={() => void setStatus("closed")} loading={action.busy === "closed"}>
                  Close
                </Button>
              ) : null}
            </div>
          ) : null}

          <VerdictDrawer
            projectId={projectId}
            verificationId={verificationId}
            item={verdictFor}
            currency={v.currency}
            onClose={() => setVerdictFor(null)}
            onChanged={() => {
              detail.reload();
              onChanged();
            }}
          />
        </div>
      )}
    </Drawer>
  );
}

function VerdictDrawer({
  projectId,
  verificationId,
  item,
  currency,
  onClose,
  onChanged,
}: {
  projectId: string;
  verificationId: string | null;
  item: DefinedCostItem | null;
  currency: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const api = projectApi(projectId);
  const action = useAction();
  const [verdict, setVerdict] = useState("verified");
  const [verifiedAmount, setVerifiedAmount] = useState("");
  const [note, setNote] = useState("");
  const [category, setCategory] = useState("not_defined_cost");
  const [clause, setClause] = useState("");
  const [responseDueAt, setResponseDueAt] = useState("");

  useEffect(() => {
    setVerdict(item?.verdict === "pending" ? "verified" : (item?.verdict ?? "verified"));
    setVerifiedAmount(item ? String(item.claimedAmount) : "");
    setNote(item?.verifierNote ?? "");
    setClause("");
    setResponseDueAt("");
    action.clear();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item?.id]);

  const raisesDisallowance = verdict === "disallowed" || verdict === "partially_disallowed";

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!verificationId || !item) return;
    const body: Record<string, unknown> = { verdict, verifierNote: note || undefined };
    if (verdict === "verified" || verdict === "partially_disallowed") {
      const n = Number(verifiedAmount);
      if (Number.isFinite(n)) body["verifiedAmount"] = n;
    }
    if (raisesDisallowance) {
      body["disallowance"] = {
        category,
        groundClause: clause || undefined,
        responseDueAt: responseDueAt || undefined,
      };
    }
    const res = await action.run("verdict", () => api.setVerdict(verificationId, item.id, body));
    if (res) {
      toast.success(
        res.disallowedCostId
          ? "Verdict recorded and the disallowance raised on the register"
          : "Verdict recorded",
      );
      onChanged();
      onClose();
    }
  }

  return (
    <Drawer
      open={item !== null}
      onClose={onClose}
      size="md"
      title={item ? item.description : "Verdict"}
      description={item ? `${titleCase(item.component)} · ${money(item.claimedAmount, item.currency)} claimed` : undefined}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="portfolio-verdict" loading={action.busy === "verdict"}>
            Record the verdict
          </Button>
        </div>
      }
    >
      {item ? (
        <form id="portfolio-verdict" onSubmit={submit} className="space-y-4">
          {action.error ? (
            <Alert tone="danger" size="sm">
              {action.error}
            </Alert>
          ) : null}
          <Alert tone="info" size="sm">
            The person who recorded this claimed cost cannot verify it. A cost verified by its own claimant is an
            assertion, not a verification.
          </Alert>
          <Field label="Verdict" required>
            <Select value={verdict} onChange={(e) => setVerdict(e.target.value)}>
              {DEFINED_COST_VERDICTS.map((v) => (
                <option key={v} value={v}>
                  {titleCase(v)}
                </option>
              ))}
            </Select>
          </Field>
          {verdict === "verified" || verdict === "partially_disallowed" ? (
            <Field
              label={`Verified amount (${currency})`}
              required={verdict === "partially_disallowed"}
              hint={
                verdict === "partially_disallowed"
                  ? "The balance of the claim is what is disallowed."
                  : "Defaults to the full amount claimed."
              }
            >
              <Input
                type="number"
                value={verifiedAmount}
                onChange={(e) => setVerifiedAmount(e.target.value)}
                min={0}
                max={item.claimedAmount}
                step="0.01"
              />
            </Field>
          ) : null}
          <Field label="Verifier's note">
            <Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
          {raisesDisallowance ? (
            <div className="space-y-3 rounded-md border border-border p-3">
              <div className="text-2xs font-semibold uppercase tracking-wide text-content-subtle">
                Raise the disallowance
              </div>
              <Field label="Ground" required>
                <Select value={category} onChange={(e) => setCategory(e.target.value)}>
                  {DISALLOWED_CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {titleCase(c)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field
                label="Contract clause"
                hint="A disallowance without a clause is an opinion and will not survive adjudication."
              >
                <Input value={clause} onChange={(e) => setClause(e.target.value)} />
              </Field>
              <Field label="Response due by" hint="Becomes an obligation the platform watches">
                <Input type="date" value={responseDueAt} onChange={(e) => setResponseDueAt(e.target.value)} />
              </Field>
            </div>
          ) : null}
        </form>
      ) : null}
    </Drawer>
  );
}

/* =============================== Create =================================== */

function CreateDrawer({
  projectId,
  kind,
  verifications,
  onClose,
  onCreated,
}: {
  projectId: string;
  kind: null | "verification" | "audit";
  verifications: Verification[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const api = projectApi(projectId);
  const action = useAction();
  const [form, setForm] = useState<Record<string, string>>({});

  useEffect(() => {
    setForm({});
    action.clear();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind]);

  const set = (key: string, value: string) => setForm((f) => ({ ...f, [key]: value }));
  const numeric = (key: string): number | undefined => {
    const raw = form[key];
    if (raw === undefined || raw.trim() === "") return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (kind === "verification") {
      const res = await action.run("create", () =>
        api.createVerification({
          title: form["title"] ?? "",
          currency: form["currency"] ?? "",
          claimedAmount: numeric("claimedAmount") ?? 0,
          periodStart: form["periodStart"] || undefined,
          periodEnd: form["periodEnd"] || undefined,
          plannedAt: form["plannedAt"] || undefined,
          auditRightsClause: form["auditRightsClause"] || undefined,
          methodology: form["methodology"] || undefined,
          verifierName: form["verifierName"] || undefined,
          sampling: {
            basis: form["samplingBasis"] || undefined,
            populationCount: numeric("populationCount"),
            populationValue: numeric("populationValue"),
            sampleCount: numeric("sampleCount"),
            confidence: numeric("confidence"),
          },
        }),
      );
      if (res) {
        toast.success(`${res.reference} planned`);
        onCreated();
      }
      return;
    }
    if (kind === "audit") {
      const res = await action.run("create", () =>
        api.createAudit({
          reference: form["reference"] ?? "",
          subjectType: form["subjectType"] ?? "commitment",
          subjectName: form["subjectName"] ?? "",
          contractReference: form["contractReference"] || undefined,
          clause: form["clause"] || undefined,
          scope: form["scope"] ?? "",
          auditorName: form["auditorName"] || undefined,
          verificationId: form["verificationId"] || undefined,
          noticeDate: form["noticeDate"] || undefined,
          noticeDays: numeric("noticeDays"),
          scheduledDate: form["scheduledDate"] || undefined,
        }),
      );
      if (res) {
        toast.success("Notice recorded — the counterparty's duty to give access is now an obligation");
        onCreated();
      }
    }
  }

  return (
    <Drawer
      open={kind !== null}
      onClose={onClose}
      size="md"
      title={kind === "verification" ? "Plan an open-book verification" : "Give notice under the audit clause"}
      description={
        kind === "verification"
          ? "Record the sampling plan: without a population value the observed rate cannot be projected beyond the items tested, and the platform will say so rather than guess."
          : "A scheduled date makes the counterparty's duty to give access an obligation the sweep can breach."
      }
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="portfolio-openbook-create" loading={action.busy === "create"}>
            Save
          </Button>
        </div>
      }
    >
      <form id="portfolio-openbook-create" onSubmit={submit} className="space-y-4">
        {action.error ? (
          <Alert tone="danger" size="sm">
            {action.error}
          </Alert>
        ) : null}

        {kind === "verification" ? (
          <>
            <Field label="Title" required>
              <Input value={form["title"] ?? ""} onChange={(e) => set("title", e.target.value)} required />
            </Field>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Currency" required>
                <Input value={form["currency"] ?? ""} onChange={(e) => set("currency", e.target.value)} maxLength={3} required />
              </Field>
              <Field label="Claimed for the period">
                <Input
                  type="number"
                  value={form["claimedAmount"] ?? ""}
                  onChange={(e) => set("claimedAmount", e.target.value)}
                  min={0}
                  step="0.01"
                />
              </Field>
              <Field label="Planned start">
                <Input type="date" value={form["plannedAt"] ?? ""} onChange={(e) => set("plannedAt", e.target.value)} />
              </Field>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Period start">
                <Input type="date" value={form["periodStart"] ?? ""} onChange={(e) => set("periodStart", e.target.value)} />
              </Field>
              <Field label="Period end">
                <Input type="date" value={form["periodEnd"] ?? ""} onChange={(e) => set("periodEnd", e.target.value)} />
              </Field>
            </div>
            <Field label="Audit rights clause">
              <Input value={form["auditRightsClause"] ?? ""} onChange={(e) => set("auditRightsClause", e.target.value)} />
            </Field>
            <Field label="Verifier">
              <Input value={form["verifierName"] ?? ""} onChange={(e) => set("verifierName", e.target.value)} />
            </Field>
            <Field label="Methodology">
              <Textarea rows={2} value={form["methodology"] ?? ""} onChange={(e) => set("methodology", e.target.value)} />
            </Field>
            <div className="grid gap-3 sm:grid-cols-5">
              <Field label="Sampling basis">
                <Input value={form["samplingBasis"] ?? ""} onChange={(e) => set("samplingBasis", e.target.value)} size="sm" />
              </Field>
              <Field label="Population count">
                <Input
                  type="number"
                  value={form["populationCount"] ?? ""}
                  onChange={(e) => set("populationCount", e.target.value)}
                  size="sm"
                  min={0}
                />
              </Field>
              <Field label="Population value">
                <Input
                  type="number"
                  value={form["populationValue"] ?? ""}
                  onChange={(e) => set("populationValue", e.target.value)}
                  size="sm"
                  min={0}
                  step="0.01"
                />
              </Field>
              <Field label="Sample count">
                <Input
                  type="number"
                  value={form["sampleCount"] ?? ""}
                  onChange={(e) => set("sampleCount", e.target.value)}
                  size="sm"
                  min={0}
                />
              </Field>
              <Field label="Confidence %">
                <Input
                  type="number"
                  value={form["confidence"] ?? ""}
                  onChange={(e) => set("confidence", e.target.value)}
                  size="sm"
                  min={0}
                  max={100}
                />
              </Field>
            </div>
          </>
        ) : null}

        {kind === "audit" ? (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Reference" required>
                <Input value={form["reference"] ?? ""} onChange={(e) => set("reference", e.target.value)} required />
              </Field>
              <Field label="Subject type">
                <Select value={form["subjectType"] ?? "commitment"} onChange={(e) => set("subjectType", e.target.value)}>
                  {AUDIT_SUBJECT_TYPES.map((s) => (
                    <option key={s} value={s}>
                      {titleCase(s)}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <Field label="Subject" required>
              <Input value={form["subjectName"] ?? ""} onChange={(e) => set("subjectName", e.target.value)} required />
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Contract reference">
                <Input
                  value={form["contractReference"] ?? ""}
                  onChange={(e) => set("contractReference", e.target.value)}
                />
              </Field>
              <Field label="Clause">
                <Input value={form["clause"] ?? ""} onChange={(e) => set("clause", e.target.value)} />
              </Field>
            </div>
            <Field label="Scope" required>
              <Textarea rows={3} value={form["scope"] ?? ""} onChange={(e) => set("scope", e.target.value)} required />
            </Field>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Notice date">
                <Input type="date" value={form["noticeDate"] ?? ""} onChange={(e) => set("noticeDate", e.target.value)} />
              </Field>
              <Field label="Notice days" hint="What the clause requires">
                <Input
                  type="number"
                  value={form["noticeDays"] ?? ""}
                  onChange={(e) => set("noticeDays", e.target.value)}
                  min={0}
                />
              </Field>
              <Field label="Scheduled date">
                <Input
                  type="date"
                  value={form["scheduledDate"] ?? ""}
                  onChange={(e) => set("scheduledDate", e.target.value)}
                />
              </Field>
            </div>
            <Field label="Auditor">
              <Input value={form["auditorName"] ?? ""} onChange={(e) => set("auditorName", e.target.value)} />
            </Field>
            <Field label="Linked verification">
              <Select value={form["verificationId"] ?? ""} onChange={(e) => set("verificationId", e.target.value)}>
                <option value="">None</option>
                {verifications.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.reference} — {v.title}
                  </option>
                ))}
              </Select>
            </Field>
          </>
        ) : null}
      </form>
    </Drawer>
  );
}
