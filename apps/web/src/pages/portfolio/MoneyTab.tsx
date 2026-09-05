/**
 * MONEY AUTHORITY — funding sources, multi-year appropriations, virements and
 * per-project allocations (#427–#434, #779–#780).
 *
 * The whole chain is on one screen because that is how an owner has to read
 * it: a facility is only meaningful against the appropriations drawn on it,
 * and an appropriation only against the allocations it authorises.
 *
 * Nothing here can be edited around a rule. A refusal from the API — headroom,
 * currency, self-approval — is printed verbatim rather than swallowed, because
 * the refusal is the useful part.
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
  Textarea,
  toast,
  type DataColumns,
} from "../../ui";
import { IconPlus } from "../../ui/icons";
import {
  CARRY_FORWARD_POLICIES,
  DASH,
  EXPENDITURE_CLASSES,
  FUNDING_KINDS,
  LoadError,
  ReasonList,
  Row,
  headroomTone,
  isoDate,
  money,
  moneyShort,
  num,
  pct,
  portfolioApi,
  statusTone,
  titleCase,
  useAction,
  useIsCompanyAdmin,
  useProjects,
  useResource,
  type Allocation,
  type Appropriation,
  type FundingSource,
  type Paginated,
  type Virement,
} from "./portfolioShared";

export default function MoneyTab({ onChanged }: { onChanged: () => void }) {
  const isAdmin = useIsCompanyAdmin();
  const sources = useResource<Paginated<FundingSource>>(
    "/api/v1/portfolio/funding-sources?page=1&pageSize=200",
  );
  const appropriations = useResource<Paginated<Appropriation>>(
    "/api/v1/portfolio/appropriations?page=1&pageSize=200",
  );
  const allocations = useResource<Paginated<Allocation>>(
    "/api/v1/portfolio/allocations?page=1&pageSize=200",
  );
  const virements = useResource<Paginated<Virement>>("/api/v1/portfolio/virements?page=1&pageSize=200");

  const [creating, setCreating] = useState<null | "source" | "appropriation" | "allocation" | "virement">(
    null,
  );
  const [openSource, setOpenSource] = useState<FundingSource | null>(null);
  const [openAppropriation, setOpenAppropriation] = useState<Appropriation | null>(null);
  const [openAllocation, setOpenAllocation] = useState<Allocation | null>(null);

  function reloadAll() {
    sources.reload();
    appropriations.reload();
    allocations.reload();
    virements.reload();
    onChanged();
  }

  const sourceColumns = useMemo<DataColumns<FundingSource>>(
    () => [
      { id: "name", header: "Facility", accessor: "name", type: "text", width: 240 },
      { id: "kind", header: "Kind", accessor: (r) => titleCase(r.kind), type: "text", width: 170 },
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
        id: "amount",
        header: "Facility",
        accessor: "amount",
        type: "number",
        align: "right",
        width: 150,
        cell: ({ row }) => moneyShort(row.amount, row.currency),
      },
      {
        id: "allocated",
        header: "Allocated",
        accessor: (r) => r.position.allocated,
        type: "number",
        align: "right",
        width: 150,
        cell: ({ row }) => moneyShort(row.position.allocated, row.currency),
      },
      {
        id: "headroom",
        header: "Headroom",
        accessor: (r) => r.position.headroom,
        type: "number",
        align: "right",
        width: 150,
        cell: ({ row }) => (
          <span
            className={headroomTone(row.position.headroom) === "danger" ? "font-semibold text-danger-text" : undefined}
          >
            {moneyShort(row.position.headroom, row.currency)}
          </span>
        ),
      },
      {
        id: "utilisation",
        header: "Used",
        accessor: (r) => r.position.utilisationPercent ?? 0,
        type: "number",
        align: "right",
        width: 90,
        cell: ({ row }) => pct(row.position.utilisationPercent, 0),
      },
      {
        id: "window",
        header: "Available",
        accessor: (r) => r.availableFrom ?? "",
        type: "text",
        width: 190,
        cell: ({ row }) =>
          row.availableFrom || row.availableTo
            ? `${isoDate(row.availableFrom)} → ${isoDate(row.availableTo)}`
            : DASH,
      },
    ],
    [],
  );

  const appropriationColumns = useMemo<DataColumns<Appropriation>>(
    () => [
      { id: "name", header: "Appropriation", accessor: "name", type: "text", width: 230 },
      { id: "fiscalYear", header: "Year", accessor: "fiscalYear", type: "text", width: 100 },
      {
        id: "status",
        header: "Status",
        accessor: "status",
        type: "text",
        width: 140,
        cell: ({ row }) => (
          <Badge tone={statusTone(row.status)} size="xs" dot>
            {titleCase(row.status)}
          </Badge>
        ),
      },
      {
        id: "authorised",
        header: "Authorised",
        accessor: (r) => r.position.authorised,
        type: "number",
        align: "right",
        width: 150,
        cell: ({ row }) => moneyShort(row.position.authorised, row.currency),
      },
      {
        id: "allocated",
        header: "Allocated",
        accessor: (r) => r.position.allocated,
        type: "number",
        align: "right",
        width: 150,
        cell: ({ row }) => moneyShort(row.position.allocated, row.currency),
      },
      {
        id: "uncommitted",
        header: "Uncommitted",
        accessor: (r) => r.position.uncommitted,
        type: "number",
        align: "right",
        width: 150,
        cell: ({ row }) => (
          <span
            className={
              row.position.overcommitted ? "font-semibold text-danger-text" : undefined
            }
          >
            {moneyShort(row.position.uncommitted, row.currency)}
          </span>
        ),
      },
      {
        id: "carry",
        header: "Carry-forward",
        accessor: "carryForwardPolicy",
        type: "text",
        width: 150,
        cell: ({ row }) => titleCase(row.carryForwardPolicy),
      },
      {
        id: "virementNet",
        header: "Net virement",
        accessor: "virementNet",
        type: "number",
        align: "right",
        width: 140,
        cell: ({ row }) => (row.virementNet === 0 ? DASH : moneyShort(row.virementNet, row.currency)),
      },
    ],
    [],
  );

  const allocationColumns = useMemo<DataColumns<Allocation>>(
    () => [
      {
        id: "projectName",
        header: "Project",
        accessor: (r) => r.projectName ?? r.projectId,
        type: "text",
        width: 240,
      },
      { id: "fiscalYear", header: "Year", accessor: (r) => r.fiscalYear ?? "", type: "text", width: 100, cell: ({ row }) => row.fiscalYear ?? DASH },
      {
        id: "expenditureClass",
        header: "Class",
        accessor: "expenditureClass",
        type: "text",
        width: 120,
        cell: ({ row }) => titleCase(row.expenditureClass),
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
        id: "amount",
        header: "Allocated",
        accessor: "amount",
        type: "number",
        align: "right",
        width: 150,
        cell: ({ row }) => moneyShort(row.amount, row.currency),
      },
      {
        id: "drawnAmount",
        header: "Drawn",
        accessor: "drawnAmount",
        type: "number",
        align: "right",
        width: 150,
        cell: ({ row }) => moneyShort(row.drawnAmount, row.currency),
      },
      {
        id: "remaining",
        header: "Remaining",
        accessor: (r) => r.remaining ?? r.amount - r.drawnAmount,
        type: "number",
        align: "right",
        width: 150,
        cell: ({ row }) => moneyShort(row.remaining ?? row.amount - row.drawnAmount, row.currency),
      },
      {
        id: "wholeLifeCost",
        header: "Whole-life cost",
        accessor: (r) => r.wholeLifeCost ?? 0,
        type: "number",
        align: "right",
        width: 160,
        cell: ({ row }) =>
          row.wholeLifeCost === null ? (
            <span className="italic text-content-subtle">not recorded</span>
          ) : (
            moneyShort(row.wholeLifeCost, row.currency)
          ),
      },
    ],
    [],
  );

  const virementColumns = useMemo<DataColumns<Virement>>(
    () => [
      {
        id: "amount",
        header: "Amount",
        accessor: "amount",
        type: "number",
        align: "right",
        width: 150,
        cell: ({ row }) => moneyShort(row.amount, row.currency),
      },
      { id: "reason", header: "Reason", accessor: "reason", type: "text", width: 420 },
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
        id: "decidedAt",
        header: "Decided",
        accessor: (r) => r.decidedAt ?? "",
        type: "datetime",
        width: 170,
        cell: ({ row }) => isoDate(row.decidedAt),
      },
    ],
    [],
  );

  const nameOfAppropriation = (id: string | null) =>
    appropriations.data?.items.find((a) => a.id === id)?.name ?? id ?? DASH;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title="Funding sources"
          subtitle="What the organisation may spend from. A facility is only spendable once it is committed or available, and allocations may not exceed it."
          actions={
            isAdmin ? (
              <Button size="sm" icon={IconPlus} onClick={() => setCreating("source")}>
                New facility
              </Button>
            ) : undefined
          }
        />
        <CardBody flush>
          {sources.error ? (
            <div className="p-4">
              <LoadError message={sources.error} onRetry={sources.reload} />
            </div>
          ) : (
            <DataTable<FundingSource>
              tableId="portfolio.funding-sources"
              data={sources.data?.items ?? []}
              columns={sourceColumns}
              getRowId={(row) => row.id}
              loading={sources.loading && !sources.data}
              height={300}
              rowHeight={44}
              stickyHeader
              flush
              toolbar={false}
              onRowClick={({ row }) => setOpenSource(row)}
              rowTone={(row) => (row.position.overdrawn ? "danger" : undefined)}
              empty={{
                title: "No funding sources",
                description:
                  "A funding source is the facility the money comes from — a grant, a loan, a bond, internal capital. Allocations draw on it and are refused once it is exhausted.",
                action: isAdmin ? <Button onClick={() => setCreating("source")}>Add a facility</Button> : undefined,
              }}
              aria-label="Funding sources"
            />
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Appropriations"
          subtitle="Authority for one fiscal year. Authorised = appropriated + carried in + net virement − carried out; carry-forward at year end follows the appropriation's declared policy, never a guess."
          actions={
            isAdmin ? (
              <Button size="sm" icon={IconPlus} onClick={() => setCreating("appropriation")}>
                New appropriation
              </Button>
            ) : undefined
          }
        />
        <CardBody flush>
          {appropriations.error ? (
            <div className="p-4">
              <LoadError message={appropriations.error} onRetry={appropriations.reload} />
            </div>
          ) : (
            <DataTable<Appropriation>
              tableId="portfolio.appropriations"
              data={appropriations.data?.items ?? []}
              columns={appropriationColumns}
              getRowId={(row) => row.id}
              loading={appropriations.loading && !appropriations.data}
              height={300}
              rowHeight={44}
              stickyHeader
              flush
              toolbar={false}
              onRowClick={({ row }) => setOpenAppropriation(row)}
              rowTone={(row) => (row.position.overcommitted ? "danger" : undefined)}
              empty={{
                title: "No appropriations",
                description:
                  "An appropriation is a year's spending authority. Allocations consume it, virements move it between years, and closing a year carries or lapses the balance according to its policy.",
                action: isAdmin ? (
                  <Button onClick={() => setCreating("appropriation")}>Add an appropriation</Button>
                ) : undefined,
              }}
              aria-label="Appropriations"
            />
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Allocations"
          subtitle="Authority attached to one project. An allocation may not be created or increased beyond the headroom of the appropriation or facility it draws on, and a change to an approved one clears the approval."
          actions={
            isAdmin ? (
              <Button size="sm" icon={IconPlus} onClick={() => setCreating("allocation")}>
                New allocation
              </Button>
            ) : undefined
          }
        />
        <CardBody flush>
          {allocations.error ? (
            <div className="p-4">
              <LoadError message={allocations.error} onRetry={allocations.reload} />
            </div>
          ) : (
            <DataTable<Allocation>
              tableId="portfolio.allocations"
              data={allocations.data?.items ?? []}
              columns={allocationColumns}
              getRowId={(row) => row.id}
              loading={allocations.loading && !allocations.data}
              height={340}
              rowHeight={44}
              stickyHeader
              flush
              toolbar={false}
              onRowClick={({ row }) => setOpenAllocation(row)}
              empty={{
                title: "No allocations",
                description:
                  "Allocate an appropriation or a facility to a project and its drawn position appears here. Nothing is allocated across currencies.",
                action: isAdmin ? (
                  <Button onClick={() => setCreating("allocation")}>Allocate funding</Button>
                ) : undefined,
              }}
              aria-label="Allocations"
            />
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Virements"
          subtitle="Authority moved between appropriations. The request and the decision are separate acts by different people, and both stay on the record."
          actions={
            isAdmin ? (
              <Button size="sm" icon={IconPlus} onClick={() => setCreating("virement")}>
                Propose a virement
              </Button>
            ) : undefined
          }
        />
        <CardBody flush>
          {virements.error ? (
            <div className="p-4">
              <LoadError message={virements.error} onRetry={virements.reload} />
            </div>
          ) : (
            <DataTable<Virement>
              tableId="portfolio.virements"
              data={virements.data?.items ?? []}
              columns={virementColumns}
              getRowId={(row) => row.id}
              loading={virements.loading && !virements.data}
              height={240}
              rowHeight={44}
              stickyHeader
              flush
              toolbar={false}
              empty={{ title: "No virements proposed" }}
              aria-label="Virements"
            />
          )}
          {isAdmin && virements.data ? (
            <div className="space-y-2 border-t border-border p-3">
              {virements.data.items
                .filter((v) => v.status === "proposed")
                .map((v) => (
                  <VirementDecision key={v.id} virement={v} onDecided={reloadAll} />
                ))}
            </div>
          ) : null}
        </CardBody>
      </Card>

      <SourceDrawer
        source={openSource}
        onClose={() => setOpenSource(null)}
        onChanged={reloadAll}
        isAdmin={isAdmin}
      />
      <AppropriationDrawer
        appropriation={openAppropriation}
        appropriations={appropriations.data?.items ?? []}
        onClose={() => setOpenAppropriation(null)}
        onChanged={reloadAll}
        isAdmin={isAdmin}
      />
      <AllocationDrawer
        allocation={openAllocation}
        appropriationName={nameOfAppropriation}
        onClose={() => setOpenAllocation(null)}
        onChanged={reloadAll}
        isAdmin={isAdmin}
      />
      <CreateDrawer
        kind={creating}
        onClose={() => setCreating(null)}
        onCreated={() => {
          setCreating(null);
          reloadAll();
        }}
        sources={sources.data?.items ?? []}
        appropriations={appropriations.data?.items ?? []}
      />
    </div>
  );
}

/* ============================== Decisions ================================= */

function VirementDecision({ virement, onDecided }: { virement: Virement; onDecided: () => void }) {
  const action = useAction();
  const [note, setNote] = useState("");

  async function decide(outcome: "approved" | "rejected") {
    const res = await action.run(outcome, () =>
      portfolioApi.decideVirement(virement.id, { outcome, decisionNote: note || undefined }),
    );
    if (res) {
      toast.success(`Virement ${outcome}`);
      onDecided();
    }
  }

  return (
    <div className="rounded-md border border-border bg-surface-sunken p-3">
      <div className="mb-2 text-meta text-content">
        <span className="font-semibold">{money(virement.amount, virement.currency)}</span> — {virement.reason}
      </div>
      {action.error ? (
        <Alert tone="danger" size="sm" className="mb-2">
          {action.error}
        </Alert>
      ) : null}
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Decision note" className="min-w-[16rem] flex-1">
          <Input value={note} onChange={(e) => setNote(e.target.value)} size="sm" placeholder="Why" />
        </Field>
        <Button size="sm" onClick={() => void decide("approved")} loading={action.busy === "approved"}>
          Approve
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void decide("rejected")}
          loading={action.busy === "rejected"}
        >
          Reject
        </Button>
      </div>
      <p className="mt-1 text-2xs text-content-subtle">
        The person who requested a virement cannot decide it; the API refuses that outright.
      </p>
    </div>
  );
}

/* =============================== Drawers ================================== */

function SourceDrawer({
  source,
  onClose,
  onChanged,
  isAdmin,
}: {
  source: FundingSource | null;
  onClose: () => void;
  onChanged: () => void;
  isAdmin: boolean;
}) {
  const action = useAction();
  if (!source) return <Drawer open={false} onClose={onClose} title="Facility" />;
  const p = source.position;

  async function setStatus(status: string) {
    if (!source) return;
    const res = await action.run(status, () => portfolioApi.setSourceStatus(source.id, status));
    if (res) {
      toast.success(`Facility marked ${status}`);
      onChanged();
      onClose();
    }
  }

  return (
    <Drawer
      open
      onClose={onClose}
      size="md"
      title={source.name}
      description={`${titleCase(source.kind)} · ${source.currency} · ${titleCase(source.status)}`}
    >
      <div className="space-y-4">
        {action.error ? (
          <Alert tone="danger" size="sm">
            {action.error}
          </Alert>
        ) : null}
        <dl className="divide-y divide-border">
          <Row label="Provider">{source.provider ?? DASH}</Row>
          <Row label="Reference">{source.reference ?? DASH}</Row>
          <Row label="Expenditure class">{titleCase(source.expenditureClass)}</Row>
          <Row label="Facility">{money(source.amount, source.currency)}</Row>
          <Row label="Allocated">{money(p.allocated, p.currency)}</Row>
          <Row label="Drawn">{money(p.drawn, p.currency)}</Row>
          <Row label="Headroom" hint={p.overdrawn ? `Over-allocated by ${money(p.overdrawnBy, p.currency)}` : undefined}>
            <span className={p.overdrawn ? "font-semibold text-danger-text" : undefined}>
              {money(p.headroom, p.currency)}
            </span>
          </Row>
          <Row label="Utilisation">{pct(p.utilisationPercent)}</Row>
          <Row label="Available">
            {source.availableFrom || source.availableTo
              ? `${isoDate(source.availableFrom)} → ${isoDate(source.availableTo)}`
              : DASH}
          </Row>
        </dl>
        {source.conditions.length > 0 ? (
          <div>
            <div className="mb-1 text-2xs font-semibold uppercase tracking-wide text-content-subtle">
              Conditions ({source.conditions.length})
            </div>
            <ul className="space-y-1">
              {source.conditions.map((c, i) => (
                <li key={c.id ?? i} className="flex items-start gap-2 text-meta">
                  <Badge tone={c.met ? "success" : "warning"} size="xs">
                    {c.met ? "Met" : "Open"}
                  </Badge>
                  <span className="text-content">
                    {c.text}
                    {c.dueDate ? <span className="text-content-subtle"> · due {isoDate(c.dueDate)}</span> : null}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <ReasonList reasons={p.reasons} />
        {isAdmin ? (
          <div className="flex flex-wrap gap-2">
            {["committed", "available", "withdrawn", "closed"]
              .filter((s) => s !== source.status)
              .map((s) => (
                <Button key={s} size="sm" variant="ghost" onClick={() => void setStatus(s)} loading={action.busy === s}>
                  Mark {s}
                </Button>
              ))}
          </div>
        ) : null}
      </div>
    </Drawer>
  );
}

function AppropriationDrawer({
  appropriation,
  appropriations,
  onClose,
  onChanged,
  isAdmin,
}: {
  appropriation: Appropriation | null;
  appropriations: Appropriation[];
  onClose: () => void;
  onChanged: () => void;
  isAdmin: boolean;
}) {
  const action = useAction();
  const [successor, setSuccessor] = useState("");

  useEffect(() => {
    setSuccessor("");
    action.clear();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appropriation?.id]);

  if (!appropriation) return <Drawer open={false} onClose={onClose} title="Appropriation" />;
  const p = appropriation.position;
  const a = appropriation;

  async function approve() {
    const res = await action.run("approve", () => portfolioApi.approveAppropriation(a.id));
    if (res) {
      toast.success("Appropriation approved");
      onChanged();
      onClose();
    }
  }

  async function close() {
    const res = await action.run("close", () =>
      portfolioApi.closeAppropriation(a.id, successor ? { successorAppropriationId: successor } : {}),
    );
    if (res) {
      toast.success(
        res.carriedForward > 0
          ? `Year closed — ${money(res.carriedForward, a.currency)} carried forward`
          : res.lapsed > 0
            ? `Year closed — ${money(res.lapsed, a.currency)} lapsed under the policy`
            : "Year closed",
      );
      onChanged();
      onClose();
    }
  }

  const candidates = appropriations.filter(
    (x) => x.id !== a.id && x.currency === a.currency && !["closed", "lapsed", "carried_forward"].includes(x.status),
  );

  return (
    <Drawer
      open
      onClose={onClose}
      size="md"
      title={a.name}
      description={`${a.fiscalYear} · ${a.currency} · ${titleCase(a.status)}`}
    >
      <div className="space-y-4">
        {action.error ? (
          <Alert tone="danger" size="sm">
            {action.error}
          </Alert>
        ) : null}
        <dl className="divide-y divide-border">
          <Row label="Appropriated">{money(a.appropriatedAmount, a.currency)}</Row>
          <Row label="Carried in">{money(a.carriedForwardIn, a.currency)}</Row>
          <Row label="Net virement">{money(a.virementNet, a.currency)}</Row>
          <Row label="Carried out">{money(a.carriedForwardOut, a.currency)}</Row>
          <Row label="Authorised" hint="appropriated + carried in + net virement − carried out">
            <span className="font-semibold">{money(p.authorised, a.currency)}</span>
          </Row>
          <Row label="Allocated" hint={`${num(p.allocationCount)} allocation(s)`}>
            {money(p.allocated, a.currency)}
          </Row>
          <Row label="Uncommitted">
            <span className={p.overcommitted ? "font-semibold text-danger-text" : undefined}>
              {money(p.uncommitted, a.currency)}
            </span>
          </Row>
          <Row label="Drawn">{money(p.drawn, a.currency)}</Row>
          <Row label="Carry-forward policy">{titleCase(a.carryForwardPolicy)}</Row>
          <Row label="Eligible to carry">{money(p.carryForwardEligible, a.currency)}</Row>
          <Row label="Approved">{a.approvedAt ? isoDate(a.approvedAt) : "not yet approved"}</Row>
        </dl>
        <ReasonList reasons={p.reasons} />
        {isAdmin ? (
          <div className="space-y-3">
            {a.status === "draft" ? (
              <div>
                <Button size="sm" onClick={() => void approve()} loading={action.busy === "approve"}>
                  Approve this appropriation
                </Button>
                <p className="mt-1 text-2xs text-content-subtle">
                  The person who drafted it cannot approve it; a different owner or admin must.
                </p>
              </div>
            ) : null}
            {!["closed", "lapsed", "carried_forward", "draft"].includes(a.status) ? (
              <div className="rounded-md border border-border p-3">
                <div className="mb-2 text-2xs font-semibold uppercase tracking-wide text-content-subtle">
                  Close the year
                </div>
                <Field
                  label="Carry the balance into"
                  hint={
                    a.carryForwardPolicy === "lapse"
                      ? "This appropriation's policy is to lapse: the unspent balance is lost at the boundary."
                      : "A carry-forward has to land somewhere to remain authority."
                  }
                >
                  <Select
                    value={successor}
                    onChange={(e) => setSuccessor(e.target.value)}
                    size="sm"
                    disabled={a.carryForwardPolicy === "lapse"}
                  >
                    <option value="">Do not carry forward</option>
                    {candidates.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name} ({c.fiscalYear})
                      </option>
                    ))}
                  </Select>
                </Field>
                <Button size="sm" className="mt-2" onClick={() => void close()} loading={action.busy === "close"}>
                  Close {a.fiscalYear}
                </Button>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </Drawer>
  );
}

function AllocationDrawer({
  allocation,
  appropriationName,
  onClose,
  onChanged,
  isAdmin,
}: {
  allocation: Allocation | null;
  appropriationName: (id: string | null) => string;
  onClose: () => void;
  onChanged: () => void;
  isAdmin: boolean;
}) {
  const action = useAction();
  const [drawAmount, setDrawAmount] = useState("");
  const [cancelReason, setCancelReason] = useState("");

  useEffect(() => {
    setDrawAmount("");
    setCancelReason("");
    action.clear();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allocation?.id]);

  if (!allocation) return <Drawer open={false} onClose={onClose} title="Allocation" />;
  const a = allocation;

  async function approve() {
    const res = await action.run("approve", () => portfolioApi.approveAllocation(a.id));
    if (res) {
      toast.success("Allocation approved");
      onChanged();
      onClose();
    }
  }

  async function draw() {
    const amount = Number(drawAmount);
    if (!Number.isFinite(amount) || amount <= 0) return;
    const res = await action.run("draw", () => portfolioApi.drawAllocation(a.id, { amount }));
    if (res) {
      toast.success(`Drawn — ${money(res.drawnAmount, res.currency)} to date`);
      onChanged();
      onClose();
    }
  }

  async function cancel() {
    const res = await action.run("cancel", () => portfolioApi.cancelAllocation(a.id, cancelReason));
    if (res) {
      toast.success("Allocation cancelled and the authority released");
      onChanged();
      onClose();
    }
  }

  return (
    <Drawer
      open
      onClose={onClose}
      size="md"
      title={a.projectName ?? a.projectId}
      description={`${money(a.amount, a.currency)} · ${titleCase(a.expenditureClass)} · ${titleCase(a.status)}`}
    >
      <div className="space-y-4">
        {action.error ? (
          <Alert tone="danger" size="sm">
            {action.error}
          </Alert>
        ) : null}
        <dl className="divide-y divide-border">
          <Row label="Fiscal year">{a.fiscalYear ?? DASH}</Row>
          <Row label="Appropriation">{appropriationName(a.appropriationId)}</Row>
          <Row label="Allocated">{money(a.amount, a.currency)}</Row>
          <Row label="Drawn">{money(a.drawnAmount, a.currency)}</Row>
          <Row label="Remaining">{money(a.remaining ?? a.amount - a.drawnAmount, a.currency)}</Row>
          <Row label="Whole-life cost" hint="Committed at approval (#434)">
            {a.wholeLifeCost === null ? "not recorded" : money(a.wholeLifeCost, a.currency)}
          </Row>
          <Row label="Approved">{a.approvedAt ? isoDate(a.approvedAt) : "not yet approved"}</Row>
        </dl>
        {a.notes ? <p className="text-meta text-content-muted">{a.notes}</p> : null}
        {isAdmin ? (
          <div className="space-y-3">
            {a.status === "planned" ? (
              <div>
                <Button size="sm" onClick={() => void approve()} loading={action.busy === "approve"}>
                  Approve
                </Button>
                <p className="mt-1 text-2xs text-content-subtle">
                  The person who proposed an allocation cannot approve it.
                </p>
              </div>
            ) : null}
            {a.status === "approved" || a.status === "drawn" ? (
              <div className="flex items-end gap-2">
                <Field label="Record a draw" className="flex-1">
                  <Input
                    type="number"
                    value={drawAmount}
                    onChange={(e) => setDrawAmount(e.target.value)}
                    size="sm"
                    min={0}
                    step="0.01"
                  />
                </Field>
                <Button size="sm" onClick={() => void draw()} loading={action.busy === "draw"}>
                  Draw
                </Button>
              </div>
            ) : null}
            {a.status !== "cancelled" && a.drawnAmount === 0 ? (
              <div className="flex items-end gap-2">
                <Field label="Cancel and release" className="flex-1">
                  <Input
                    value={cancelReason}
                    onChange={(e) => setCancelReason(e.target.value)}
                    size="sm"
                    placeholder="Reason"
                  />
                </Field>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={!cancelReason.trim()}
                  onClick={() => void cancel()}
                  loading={action.busy === "cancel"}
                >
                  Cancel
                </Button>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </Drawer>
  );
}

/* ================================ Create ================================== */

function CreateDrawer({
  kind,
  onClose,
  onCreated,
  sources,
  appropriations,
}: {
  kind: null | "source" | "appropriation" | "allocation" | "virement";
  onClose: () => void;
  onCreated: () => void;
  sources: FundingSource[];
  appropriations: Appropriation[];
}) {
  const action = useAction();
  const projects = useProjects();
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
    if (kind === "source") {
      const body = {
        name: form["name"] ?? "",
        kind: form["kind"] ?? "government_grant",
        provider: form["provider"] || undefined,
        currency: form["currency"] ?? "",
        amount: numeric("amount") ?? 0,
        expenditureClass: form["expenditureClass"] ?? "capital",
        availableFrom: form["availableFrom"] || undefined,
        availableTo: form["availableTo"] || undefined,
        notes: form["notes"] || undefined,
      };
      const res = await action.run("create", () => portfolioApi.createSource(body));
      if (res) {
        toast.success("Facility recorded");
        onCreated();
      }
      return;
    }
    if (kind === "appropriation") {
      const body = {
        name: form["name"] ?? "",
        fiscalYear: form["fiscalYear"] ?? "",
        fundingSourceId: form["fundingSourceId"] || undefined,
        currency: form["currency"] ?? "",
        appropriatedAmount: numeric("appropriatedAmount") ?? 0,
        expenditureClass: form["expenditureClass"] ?? "capital",
        carryForwardPolicy: form["carryForwardPolicy"] ?? "request",
        periodStart: form["periodStart"] || undefined,
        periodEnd: form["periodEnd"] || undefined,
      };
      const res = await action.run("create", () => portfolioApi.createAppropriation(body));
      if (res) {
        toast.success("Appropriation drafted — a second admin must approve it");
        onCreated();
      }
      return;
    }
    if (kind === "allocation") {
      const body = {
        projectId: form["projectId"] ?? "",
        appropriationId: form["appropriationId"] || undefined,
        fundingSourceId: form["fundingSourceId"] || undefined,
        fiscalYear: form["fiscalYear"] || undefined,
        currency: form["currency"] ?? "",
        amount: numeric("amount") ?? 0,
        expenditureClass: form["expenditureClass"] ?? "capital",
        wholeLifeCost: numeric("wholeLifeCost"),
      };
      const res = await action.run("create", () => portfolioApi.createAllocation(body));
      if (res) {
        toast.success("Allocation created");
        onCreated();
      }
      return;
    }
    if (kind === "virement") {
      const body = {
        fromAppropriationId: form["fromAppropriationId"] ?? "",
        toAppropriationId: form["toAppropriationId"] ?? "",
        amount: numeric("amount") ?? 0,
        reason: form["reason"] ?? "",
      };
      const res = await action.run("create", () => portfolioApi.createVirement(body));
      if (res) {
        toast.success("Virement proposed — a second admin must decide it");
        onCreated();
      }
    }
  }

  const title =
    kind === "source"
      ? "New funding source"
      : kind === "appropriation"
        ? "New appropriation"
        : kind === "allocation"
          ? "Allocate funding to a project"
          : "Propose a virement";

  return (
    <Drawer
      open={kind !== null}
      onClose={onClose}
      size="md"
      title={title}
      description={
        kind === "allocation"
          ? "An allocation must name the appropriation or facility it draws on, and cannot exceed its headroom."
          : kind === "virement"
            ? "Both appropriations must be in the same currency; authority is never moved across currencies."
            : undefined
      }
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="portfolio-money-create" loading={action.busy === "create"}>
            Save
          </Button>
        </div>
      }
    >
      <form id="portfolio-money-create" onSubmit={submit} className="space-y-4">
        {action.error ? (
          <Alert tone="danger" size="sm">
            {action.error}
          </Alert>
        ) : null}

        {kind === "source" ? (
          <>
            <Field label="Name" required>
              <Input value={form["name"] ?? ""} onChange={(e) => set("name", e.target.value)} required />
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Kind" required>
                <Select value={form["kind"] ?? "government_grant"} onChange={(e) => set("kind", e.target.value)}>
                  {FUNDING_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {titleCase(k)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Provider">
                <Input value={form["provider"] ?? ""} onChange={(e) => set("provider", e.target.value)} />
              </Field>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Currency" required hint="ISO 4217">
                <Input
                  value={form["currency"] ?? ""}
                  onChange={(e) => set("currency", e.target.value)}
                  maxLength={3}
                  required
                />
              </Field>
              <Field label="Facility value" required>
                <Input
                  type="number"
                  value={form["amount"] ?? ""}
                  onChange={(e) => set("amount", e.target.value)}
                  min={0}
                  step="0.01"
                  required
                />
              </Field>
              <Field label="Class">
                <Select
                  value={form["expenditureClass"] ?? "capital"}
                  onChange={(e) => set("expenditureClass", e.target.value)}
                >
                  {EXPENDITURE_CLASSES.map((c) => (
                    <option key={c} value={c}>
                      {titleCase(c)}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Available from">
                <Input type="date" value={form["availableFrom"] ?? ""} onChange={(e) => set("availableFrom", e.target.value)} />
              </Field>
              <Field label="Available to">
                <Input type="date" value={form["availableTo"] ?? ""} onChange={(e) => set("availableTo", e.target.value)} />
              </Field>
            </div>
            <Field label="Notes">
              <Textarea rows={3} value={form["notes"] ?? ""} onChange={(e) => set("notes", e.target.value)} />
            </Field>
          </>
        ) : null}

        {kind === "appropriation" ? (
          <>
            <Field label="Name" required>
              <Input value={form["name"] ?? ""} onChange={(e) => set("name", e.target.value)} required />
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Fiscal year" required hint='As the owner writes it, e.g. "2026/27"'>
                <Input value={form["fiscalYear"] ?? ""} onChange={(e) => set("fiscalYear", e.target.value)} required />
              </Field>
              <Field label="Funding source" hint="The facility this authority draws on">
                <Select
                  value={form["fundingSourceId"] ?? ""}
                  onChange={(e) => {
                    set("fundingSourceId", e.target.value);
                    const s = sources.find((x) => x.id === e.target.value);
                    if (s) set("currency", s.currency);
                  }}
                >
                  <option value="">None</option>
                  {sources.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name} ({s.currency})
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Currency" required>
                <Input value={form["currency"] ?? ""} onChange={(e) => set("currency", e.target.value)} maxLength={3} required />
              </Field>
              <Field label="Appropriated" required>
                <Input
                  type="number"
                  value={form["appropriatedAmount"] ?? ""}
                  onChange={(e) => set("appropriatedAmount", e.target.value)}
                  min={0}
                  step="0.01"
                  required
                />
              </Field>
              <Field label="Carry-forward policy" hint="What happens to an unspent balance at year end">
                <Select
                  value={form["carryForwardPolicy"] ?? "request"}
                  onChange={(e) => set("carryForwardPolicy", e.target.value)}
                >
                  {CARRY_FORWARD_POLICIES.map((c) => (
                    <option key={c} value={c}>
                      {titleCase(c)}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Period start">
                <Input type="date" value={form["periodStart"] ?? ""} onChange={(e) => set("periodStart", e.target.value)} />
              </Field>
              <Field label="Period end">
                <Input type="date" value={form["periodEnd"] ?? ""} onChange={(e) => set("periodEnd", e.target.value)} />
              </Field>
              <Field label="Class">
                <Select
                  value={form["expenditureClass"] ?? "capital"}
                  onChange={(e) => set("expenditureClass", e.target.value)}
                >
                  {EXPENDITURE_CLASSES.map((c) => (
                    <option key={c} value={c}>
                      {titleCase(c)}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
          </>
        ) : null}

        {kind === "allocation" ? (
          <>
            <Field label="Project" required>
              <Select value={form["projectId"] ?? ""} onChange={(e) => set("projectId", e.target.value)} required>
                <option value="">Choose a project</option>
                {(projects.data?.items ?? []).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Appropriation">
                <Select
                  value={form["appropriationId"] ?? ""}
                  onChange={(e) => {
                    set("appropriationId", e.target.value);
                    const a = appropriations.find((x) => x.id === e.target.value);
                    if (a) {
                      set("currency", a.currency);
                      set("fiscalYear", a.fiscalYear);
                    }
                  }}
                >
                  <option value="">None</option>
                  {appropriations
                    .filter((a) => a.status === "approved" || a.status === "committed")
                    .map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name} ({a.fiscalYear}, {a.currency})
                      </option>
                    ))}
                </Select>
              </Field>
              <Field label="Funding source">
                <Select value={form["fundingSourceId"] ?? ""} onChange={(e) => set("fundingSourceId", e.target.value)}>
                  <option value="">None</option>
                  {sources.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name} ({s.currency})
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <div className="grid gap-3 sm:grid-cols-4">
              <Field label="Currency" required>
                <Input value={form["currency"] ?? ""} onChange={(e) => set("currency", e.target.value)} maxLength={3} required />
              </Field>
              <Field label="Amount" required>
                <Input
                  type="number"
                  value={form["amount"] ?? ""}
                  onChange={(e) => set("amount", e.target.value)}
                  min={0}
                  step="0.01"
                  required
                />
              </Field>
              <Field label="Fiscal year">
                <Input value={form["fiscalYear"] ?? ""} onChange={(e) => set("fiscalYear", e.target.value)} />
              </Field>
              <Field label="Class">
                <Select
                  value={form["expenditureClass"] ?? "capital"}
                  onChange={(e) => set("expenditureClass", e.target.value)}
                >
                  {EXPENDITURE_CLASSES.map((c) => (
                    <option key={c} value={c}>
                      {titleCase(c)}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <Field label="Whole-life cost" hint="Committed at approval (#434); optional but it is the number that matters later">
              <Input
                type="number"
                value={form["wholeLifeCost"] ?? ""}
                onChange={(e) => set("wholeLifeCost", e.target.value)}
                min={0}
                step="0.01"
              />
            </Field>
          </>
        ) : null}

        {kind === "virement" ? (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="From" required>
                <Select
                  value={form["fromAppropriationId"] ?? ""}
                  onChange={(e) => set("fromAppropriationId", e.target.value)}
                  required
                >
                  <option value="">Choose</option>
                  {appropriations.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name} ({a.fiscalYear}, {a.currency})
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="To" required>
                <Select
                  value={form["toAppropriationId"] ?? ""}
                  onChange={(e) => set("toAppropriationId", e.target.value)}
                  required
                >
                  <option value="">Choose</option>
                  {appropriations.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name} ({a.fiscalYear}, {a.currency})
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <Field label="Amount" required>
              <Input
                type="number"
                value={form["amount"] ?? ""}
                onChange={(e) => set("amount", e.target.value)}
                min={0}
                step="0.01"
                required
              />
            </Field>
            <Field label="Reason" required>
              <Textarea rows={3} value={form["reason"] ?? ""} onChange={(e) => set("reason", e.target.value)} required />
            </Field>
          </>
        ) : null}
      </form>
    </Drawer>
  );
}
