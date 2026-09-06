/**
 * FRAMEWORKS — agreements, lots, appointed suppliers and mini-competitions
 * (#1053–#1054).
 *
 * The number that matters on this screen is HEADROOM: what can still be called
 * off before the agreement runs out of value or of time. Both are shown, and
 * both refuse to be computed where the framework is silent — an uncapped
 * framework says so rather than showing an infinite headroom.
 *
 * The evaluation of a mini-competition is called "indicated", never "winner":
 * the award is a decision a person records, with a reason, and awarding away
 * from the arithmetic is legitimate as long as it is visible.
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
  Progress,
  Select,
  Table,
  Td,
  Textarea,
  Th,
  toast,
  type DataColumns,
} from "../../ui";
import { IconPlus, IconProcurement } from "../../ui/icons";
import {
  AWARD_MODES,
  DASH,
  EditButton,
  EditForm,
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
  useResource,
  useVendors,
  utilisationTone,
  type EditFieldSpec,
  type Framework,
  type FrameworkDetail,
  type FrameworkLot,
  type FrameworkSupplier,
  type MiniCompetition,
  type MiniCompetitionEvaluation,
  type Paginated,
} from "./portfolioShared";

/* ============================ Edit field sets ============================= */

const FRAMEWORK_FIELDS: readonly EditFieldSpec[] = [
  { key: "title", label: "Title", type: "text", wide: true },
  { key: "contractingAuthority", label: "Contracting authority", type: "text", nullable: true },
  { key: "awardMode", label: "Award mode", type: "select", options: AWARD_MODES },
  {
    key: "maximumValue",
    label: "Maximum value",
    type: "number",
    min: 0,
    step: 0.01,
    nullable: true,
    hint: "Blank means uncapped, and the register says so rather than showing an infinite headroom.",
  },
  {
    key: "directAwardThreshold",
    label: "Direct-award threshold",
    type: "number",
    min: 0,
    step: 0.01,
    nullable: true,
    hint: "Checked again when an order is ISSUED, not only when it is drafted.",
  },
  { key: "startDate", label: "Start", type: "date", nullable: true },
  { key: "endDate", label: "End", type: "date", nullable: true },
  { key: "extensionToDate", label: "Extension to", type: "date", nullable: true },
  { key: "rulesReference", label: "Rules reference", type: "text", nullable: true, wide: true },
];

const LOT_FIELDS: readonly EditFieldSpec[] = [
  { key: "title", label: "Lot title", type: "text", wide: true },
  { key: "ceilingValue", label: "Ceiling", type: "number", min: 0, step: 0.01, nullable: true },
  {
    key: "awardMode",
    label: "Award mode",
    type: "select",
    options: AWARD_MODES,
    nullable: true,
    placeholder: "Follow the framework",
  },
  { key: "description", label: "Description", type: "textarea", nullable: true, wide: true },
];

const SUPPLIER_FIELDS: readonly EditFieldSpec[] = [
  { key: "supplierName", label: "Supplier name", type: "text", wide: true },
  { key: "rank", label: "Rank", type: "number", min: 1, step: 1, nullable: true },
  {
    key: "status",
    label: "Status",
    type: "select",
    options: ["appointed", "suspended", "removed", "expired"],
  },
  {
    key: "suspendedReason",
    label: "Reason",
    type: "textarea",
    nullable: true,
    wide: true,
    hint: "Suspending or removing an appointed supplier requires a reason; the appointment is a contractual position.",
  },
];

export default function FrameworksTab({ onChanged }: { onChanged: () => void }) {
  const isAdmin = useIsCompanyAdmin();
  const list = useResource<Paginated<Framework>>("/api/v1/portfolio/frameworks?page=1&pageSize=100");
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const columns = useMemo<DataColumns<Framework>>(
    () => [
      { id: "reference", header: "Reference", accessor: "reference", type: "code", width: 170 },
      { id: "title", header: "Framework", accessor: "title", type: "text", width: 280 },
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
        id: "ceiling",
        header: "Maximum",
        accessor: (r) => r.maximumValue ?? 0,
        type: "number",
        align: "right",
        width: 160,
        cell: ({ row }) =>
          row.maximumValue === null ? (
            <span className="italic text-content-subtle">uncapped</span>
          ) : (
            moneyShort(row.maximumValue, row.currency)
          ),
      },
      {
        id: "ordered",
        header: "Called off",
        accessor: (r) => r.utilisation.ordered,
        type: "number",
        align: "right",
        width: 150,
        cell: ({ row }) => moneyShort(row.utilisation.ordered, row.currency),
      },
      {
        id: "headroom",
        header: "Headroom",
        accessor: (r) => r.utilisation.headroom ?? 0,
        type: "number",
        align: "right",
        width: 150,
        cell: ({ row }) =>
          row.utilisation.headroom === null ? (
            <span className="italic text-content-subtle">not computable</span>
          ) : (
            <span
              className={
                headroomTone(row.utilisation.headroom) === "danger" ? "font-semibold text-danger-text" : undefined
              }
            >
              {moneyShort(row.utilisation.headroom, row.currency)}
            </span>
          ),
      },
      {
        id: "expiry",
        header: "Expires",
        accessor: (r) => r.utilisation.expiresOn ?? "",
        type: "date",
        width: 190,
        cell: ({ row }) =>
          row.utilisation.expiresOn ? (
            <span
              className={
                row.utilisation.daysToExpiry !== null && row.utilisation.daysToExpiry <= 90
                  ? "font-semibold text-warning-text"
                  : undefined
              }
            >
              {isoDate(row.utilisation.expiresOn)}
              {row.utilisation.daysToExpiry !== null ? (
                <span className="ml-1 text-2xs text-content-subtle">
                  {row.utilisation.daysToExpiry < 0
                    ? `${Math.abs(row.utilisation.daysToExpiry)}d ago`
                    : `in ${row.utilisation.daysToExpiry}d`}
                </span>
              ) : null}
            </span>
          ) : (
            <span className="italic text-content-subtle">open-ended</span>
          ),
      },
      { id: "lots", header: "Lots", accessor: (r) => r.lotCount ?? 0, type: "number", align: "right", width: 80 },
    ],
    [],
  );

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title="Framework agreements"
          subtitle="What may be bought without a fresh procurement, and how much of it is left. A call-off in another currency cannot consume a framework's ceiling and is excluded with a reason."
          actions={
            isAdmin ? (
              <Button size="sm" icon={IconPlus} onClick={() => setCreating(true)}>
                New framework
              </Button>
            ) : undefined
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
                icon={IconProcurement}
                title="No frameworks"
                description="A framework agreement is what lets a project buy without running a full procurement. Record its ceiling, its lots and its appointed suppliers, and every call-off is checked against them."
                action={isAdmin ? <Button onClick={() => setCreating(true)}>Add a framework</Button> : undefined}
              />
            </div>
          ) : (
            <DataTable<Framework>
              tableId="portfolio.frameworks"
              data={list.data?.items ?? []}
              columns={columns}
              getRowId={(row) => row.id}
              loading={list.loading && !list.data}
              height={360}
              rowHeight={44}
              stickyHeader
              flush
              toolbar={false}
              onRowClick={({ row }) => setOpenId(row.id)}
              rowTone={(row) =>
                row.utilisation.breached
                  ? "danger"
                  : row.utilisation.daysToExpiry !== null && row.utilisation.daysToExpiry <= 90
                    ? "warning"
                    : undefined
              }
              empty={{ title: "No frameworks" }}
              aria-label="Framework agreements"
            />
          )}
        </CardBody>
      </Card>

      <FrameworkDrawer
        frameworkId={openId}
        onClose={() => setOpenId(null)}
        onChanged={() => {
          list.reload();
          onChanged();
        }}
        isAdmin={isAdmin}
      />
      <FrameworkCreateDrawer
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={() => {
          setCreating(false);
          list.reload();
          onChanged();
        }}
      />
    </div>
  );
}

/* ============================ Framework detail ============================ */

function FrameworkDrawer({
  frameworkId,
  onClose,
  onChanged,
  isAdmin,
}: {
  frameworkId: string | null;
  onClose: () => void;
  onChanged: () => void;
  isAdmin: boolean;
}) {
  const detail = useResource<FrameworkDetail>(
    frameworkId ? `/api/v1/portfolio/frameworks/${frameworkId}` : null,
  );
  const vendors = useVendors();
  const action = useAction();
  const [lotForm, setLotForm] = useState<Record<string, string>>({});
  const [supplierForm, setSupplierForm] = useState<Record<string, string>>({});
  const [openCompetition, setOpenCompetition] = useState<string | null>(null);
  const [newCompetition, setNewCompetition] = useState(false);
  const [editingFramework, setEditingFramework] = useState(false);
  const [editingLot, setEditingLot] = useState<FrameworkLot | null>(null);
  const [editingSupplier, setEditingSupplier] = useState<FrameworkSupplier | null>(null);

  useEffect(() => {
    setLotForm({});
    setSupplierForm({});
    setEditingFramework(false);
    setEditingLot(null);
    setEditingSupplier(null);
    setNewCompetition(false);
    action.clear();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frameworkId]);

  const fw = detail.data;

  async function addLot(e: FormEvent) {
    e.preventDefault();
    if (!frameworkId) return;
    const ceiling = Number(lotForm["ceilingValue"] ?? "");
    const res = await action.run("lot", () =>
      portfolioApi.createLot(frameworkId, {
        lotNumber: lotForm["lotNumber"] ?? "",
        title: lotForm["title"] ?? "",
        ceilingValue: Number.isFinite(ceiling) && lotForm["ceilingValue"] ? ceiling : undefined,
        awardMode: lotForm["awardMode"] || undefined,
      }),
    );
    if (res) {
      toast.success(`Lot ${res.lotNumber} added`);
      setLotForm({});
      detail.reload();
      onChanged();
    }
  }

  async function addSupplier(e: FormEvent) {
    e.preventDefault();
    if (!frameworkId) return;
    const rank = Number(supplierForm["rank"] ?? "");
    const res = await action.run("supplier", () =>
      portfolioApi.addSupplier(frameworkId, {
        supplierName: supplierForm["supplierName"] ?? "",
        vendorId: supplierForm["vendorId"] || undefined,
        lotId: supplierForm["lotId"] || undefined,
        rank: Number.isFinite(rank) && supplierForm["rank"] ? rank : undefined,
      }),
    );
    if (res) {
      toast.success("Supplier appointed");
      setSupplierForm({});
      detail.reload();
      onChanged();
    }
  }

  async function saveFramework(patch: Record<string, unknown>) {
    if (!frameworkId) return;
    const res = await action.run("edit", () => portfolioApi.patchFramework(frameworkId, patch));
    if (res) {
      toast.success("Framework updated");
      setEditingFramework(false);
      detail.reload();
      onChanged();
    }
  }

  async function saveLot(patch: Record<string, unknown>) {
    if (!frameworkId || !editingLot) return;
    const res = await action.run("edit-lot", () => portfolioApi.patchLot(frameworkId, editingLot.id, patch));
    if (res) {
      toast.success(`Lot ${res.lotNumber} updated`);
      setEditingLot(null);
      detail.reload();
      onChanged();
    }
  }

  async function saveSupplier(patch: Record<string, unknown>) {
    if (!frameworkId || !editingSupplier) return;
    const res = await action.run("edit-supplier", () =>
      portfolioApi.patchSupplier(frameworkId, editingSupplier.id, patch),
    );
    if (res) {
      toast.success("Appointment updated");
      setEditingSupplier(null);
      detail.reload();
      onChanged();
    }
  }

  async function setStatus(status: string) {
    if (!frameworkId) return;
    const reason = status === "suspended" || status === "terminated" ? window.prompt(`Why is the framework being ${status}?`) : undefined;
    if ((status === "suspended" || status === "terminated") && !reason) return;
    const res = await action.run(status, () =>
      portfolioApi.setFrameworkStatus(frameworkId, status, reason ?? undefined),
    );
    if (res) {
      toast.success(`Framework marked ${status}`);
      detail.reload();
      onChanged();
    }
  }

  return (
    <Drawer
      open={frameworkId !== null}
      onClose={onClose}
      size="xl"
      title={fw ? `${fw.reference} — ${fw.title}` : "Framework"}
      description={fw ? `${titleCase(fw.awardMode)} · ${fw.currency} · ${titleCase(fw.status)}` : undefined}
    >
      {detail.error ? (
        <LoadError message={detail.error} onRetry={detail.reload} />
      ) : !fw ? (
        <div className="text-meta text-content-subtle">Loading…</div>
      ) : (
        <div className="space-y-4">
          {action.error ? (
            <Alert tone="danger" size="sm">
              {action.error}
            </Alert>
          ) : null}

          {isAdmin ? (
            <div className="flex justify-end">
              <EditButton editing={editingFramework} onToggle={() => setEditingFramework((v) => !v)} />
            </div>
          ) : null}
          {editingFramework ? (
            <EditForm
              key={fw.id}
              fields={FRAMEWORK_FIELDS}
              initial={fw as unknown as Record<string, unknown>}
              busy={action.busy === "edit"}
              onSubmit={saveFramework}
              onCancel={() => setEditingFramework(false)}
              note="Reference and currency are fixed: they identify the agreement the orders already placed were called off."
            />
          ) : null}

          <div className="rounded-md border border-border p-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <span className="text-2xs font-semibold uppercase tracking-wide text-content-subtle">Consumption</span>
              <Badge tone={fw.utilisation.breached ? "danger" : "success"} size="xs" dot>
                {fw.utilisation.breached
                  ? `Over ceiling by ${moneyShort(fw.utilisation.breachedBy, fw.currency)}`
                  : fw.utilisation.headroom === null
                    ? "No ceiling declared"
                    : `${moneyShort(fw.utilisation.headroom, fw.currency)} headroom`}
              </Badge>
            </div>
            {fw.utilisation.utilisationPercent !== null ? (
              <Progress
                value={Math.min(fw.utilisation.utilisationPercent, 100)}
                tone={utilisationTone(fw.utilisation.utilisationPercent) ?? "success"}
                aria-label="Framework utilisation"
              />
            ) : null}
            <dl className="mt-2 divide-y divide-border">
              <Row label="Maximum value">
                {fw.maximumValue === null ? "uncapped — stated, not assumed" : money(fw.maximumValue, fw.currency)}
              </Row>
              <Row label="Called off" hint={`${num(fw.utilisation.callOffCount)} consuming order(s)`}>
                {money(fw.utilisation.ordered, fw.currency)}
              </Row>
              <Row label="Certified">{money(fw.utilisation.certified, fw.currency)}</Row>
              <Row label="Direct-award threshold">
                {fw.directAwardThreshold === null
                  ? "none — every call-off must be competed"
                  : money(fw.directAwardThreshold, fw.currency)}
              </Row>
              <Row label="Term">
                {isoDate(fw.startDate)} → {isoDate(fw.endDate)}
                {fw.extensionToDate ? ` (extendable to ${isoDate(fw.extensionToDate)})` : ""}
              </Row>
              <Row label="Live call-offs at expiry">{num(fw.utilisation.liveCallOffsAtExpiry)}</Row>
              <Row label="Rules">{fw.rulesReference ?? DASH}</Row>
            </dl>
            <ReasonList reasons={fw.utilisation.reasons} className="mt-2" />
          </div>

          <div>
            <div className="mb-1 text-2xs font-semibold uppercase tracking-wide text-content-subtle">
              Lots ({fw.lots.length})
            </div>
            {fw.utilisation.lots.length === 0 ? (
              <p className="text-meta text-content-subtle">
                No lots. Call-offs are measured against the framework's own ceiling.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <thead>
                    <tr>
                      <Th>Lot</Th>
                      <Th>Title</Th>
                      <Th align="right">Ceiling</Th>
                      <Th align="right">Ordered</Th>
                      <Th align="right">Headroom</Th>
                      <Th align="right">Used</Th>
                      {isAdmin ? <Th /> : null}
                    </tr>
                  </thead>
                  <tbody>
                    {fw.utilisation.lots.map((l) => (
                      <tr key={l.lotId}>
                        <Td>{l.lotNumber}</Td>
                        <Td>{l.title}</Td>
                        <Td align="right">
                          {l.ceiling === null ? <span className="italic text-content-subtle">none</span> : moneyShort(l.ceiling, l.currency)}
                        </Td>
                        <Td align="right">{moneyShort(l.ordered, l.currency)}</Td>
                        <Td align="right">
                          {l.headroom === null ? (
                            DASH
                          ) : (
                            <span className={l.breached ? "font-semibold text-danger-text" : undefined}>
                              {moneyShort(l.headroom, l.currency)}
                            </span>
                          )}
                        </Td>
                        <Td align="right">{pct(l.utilisationPercent, 0)}</Td>
                        {isAdmin ? (
                          <Td align="right">
                            <Button
                              size="xs"
                              variant="ghost"
                              onClick={() => {
                                const row = fw.lots.find((x) => x.id === l.lotId);
                                if (row) setEditingSupplier(null);
                                setEditingLot(row ?? null);
                              }}
                            >
                              Edit
                            </Button>
                          </Td>
                        ) : null}
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </div>
            )}
            {editingLot ? (
              <div className="mt-2">
                <EditForm
                  key={editingLot.id}
                  fields={LOT_FIELDS}
                  initial={editingLot as unknown as Record<string, unknown>}
                  busy={action.busy === "edit-lot"}
                  submitLabel={`Save lot ${editingLot.lotNumber}`}
                  onSubmit={saveLot}
                  onCancel={() => setEditingLot(null)}
                  note="The lot number identifies the lot the orders already placed were called off, so it is not editable here."
                />
              </div>
            ) : null}
            {isAdmin ? (
              <form onSubmit={addLot} className="mt-2 grid gap-2 rounded-md border border-border p-2 sm:grid-cols-5">
                <Field label="Lot number">
                  <Input
                    value={lotForm["lotNumber"] ?? ""}
                    onChange={(e) => setLotForm((f) => ({ ...f, lotNumber: e.target.value }))}
                    size="sm"
                    required
                  />
                </Field>
                <Field label="Title" className="sm:col-span-2">
                  <Input
                    value={lotForm["title"] ?? ""}
                    onChange={(e) => setLotForm((f) => ({ ...f, title: e.target.value }))}
                    size="sm"
                    required
                  />
                </Field>
                <Field label={`Ceiling (${fw.currency})`}>
                  <Input
                    type="number"
                    value={lotForm["ceilingValue"] ?? ""}
                    onChange={(e) => setLotForm((f) => ({ ...f, ceilingValue: e.target.value }))}
                    size="sm"
                    min={0}
                  />
                </Field>
                <div className="flex items-end">
                  <Button size="sm" type="submit" loading={action.busy === "lot"}>
                    Add lot
                  </Button>
                </div>
              </form>
            ) : null}
          </div>

          <div>
            <div className="mb-1 text-2xs font-semibold uppercase tracking-wide text-content-subtle">
              Appointed suppliers ({fw.suppliers.length})
            </div>
            {fw.suppliers.length === 0 ? (
              <p className="text-meta text-content-subtle">No suppliers appointed yet.</p>
            ) : (
              <ul className="space-y-1">
                {fw.suppliers.map((s) => (
                  <li key={s.id} className="flex items-center justify-between gap-2 rounded-md border border-border px-2 py-1">
                    <span className="text-meta text-content">
                      {s.rank ? <span className="mr-1 text-content-subtle">#{s.rank}</span> : null}
                      {s.supplierName}
                      {s.lotId ? (
                        <span className="ml-1 text-2xs text-content-subtle">
                          lot {fw.lots.find((l) => l.id === s.lotId)?.lotNumber ?? s.lotId}
                        </span>
                      ) : null}
                    </span>
                    <span className="flex items-center gap-2">
                      <Badge tone={statusTone(s.status)} size="xs">
                        {titleCase(s.status)}
                      </Badge>
                      {isAdmin ? (
                        <Button
                          size="xs"
                          variant="ghost"
                          onClick={() => {
                            setEditingLot(null);
                            setEditingSupplier(s);
                          }}
                        >
                          Edit
                        </Button>
                      ) : null}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {editingSupplier ? (
              <div className="mt-2">
                <EditForm
                  key={editingSupplier.id}
                  fields={SUPPLIER_FIELDS}
                  initial={editingSupplier as unknown as Record<string, unknown>}
                  busy={action.busy === "edit-supplier"}
                  submitLabel="Save appointment"
                  onSubmit={saveSupplier}
                  onCancel={() => setEditingSupplier(null)}
                />
              </div>
            ) : null}
            {isAdmin ? (
              <form onSubmit={addSupplier} className="mt-2 grid gap-2 rounded-md border border-border p-2 sm:grid-cols-5">
                <Field label="Supplier name" className="sm:col-span-2">
                  <Input
                    value={supplierForm["supplierName"] ?? ""}
                    onChange={(e) => setSupplierForm((f) => ({ ...f, supplierName: e.target.value }))}
                    size="sm"
                    required
                  />
                </Field>
                <Field label="Vendor record">
                  <Select
                    value={supplierForm["vendorId"] ?? ""}
                    onChange={(e) => {
                      const v = vendors.data?.items.find((x) => x.id === e.target.value);
                      setSupplierForm((f) => ({
                        ...f,
                        vendorId: e.target.value,
                        supplierName: v ? v.name : (f["supplierName"] ?? ""),
                      }));
                    }}
                    size="sm"
                  >
                    <option value="">None</option>
                    {(vendors.data?.items ?? []).map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Lot">
                  <Select
                    value={supplierForm["lotId"] ?? ""}
                    onChange={(e) => setSupplierForm((f) => ({ ...f, lotId: e.target.value }))}
                    size="sm"
                  >
                    <option value="">Whole framework</option>
                    {fw.lots.map((l) => (
                      <option key={l.id} value={l.id}>
                        Lot {l.lotNumber}
                      </option>
                    ))}
                  </Select>
                </Field>
                <div className="flex items-end">
                  <Button size="sm" type="submit" loading={action.busy === "supplier"}>
                    Appoint
                  </Button>
                </div>
              </form>
            ) : null}
          </div>

          <div>
            <div className="mb-1 flex items-center justify-between gap-2">
              <span className="text-2xs font-semibold uppercase tracking-wide text-content-subtle">
                Mini-competitions ({fw.miniCompetitions.length})
              </span>
              {isAdmin ? (
                <Button size="xs" variant="ghost" icon={IconPlus} onClick={() => setNewCompetition(true)}>
                  New competition
                </Button>
              ) : null}
            </div>
            {fw.miniCompetitions.length === 0 ? (
              <p className="text-meta text-content-subtle">
                None run under this framework. A competition invites appointed suppliers, records what each
                one answered, and ranks them — the award is still a decision a person takes against that.
              </p>
            ) : (
              <ul className="space-y-1">
                {fw.miniCompetitions.map((c) => (
                  <li key={c.id}>
                    <button
                      type="button"
                      onClick={() => setOpenCompetition(c.id)}
                      className="flex w-full items-center justify-between gap-2 rounded-md border border-border px-2 py-1 text-left hover:bg-surface-hover"
                    >
                      <span className="text-meta text-content">
                        <span className="font-mono text-2xs text-content-subtle">{c.reference}</span> {c.title}
                      </span>
                      <span className="flex items-center gap-2">
                        {c.awardValue !== null ? (
                          <span className="text-2xs text-content-subtle">{moneyShort(c.awardValue, c.currency)}</span>
                        ) : null}
                        <Badge tone={statusTone(c.status)} size="xs">
                          {titleCase(c.status)}
                        </Badge>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {isAdmin ? (
            <div className="flex flex-wrap gap-2 border-t border-border pt-3">
              {["live", "suspended", "expired", "terminated"]
                .filter((s) => s !== fw.status)
                .map((s) => (
                  <Button key={s} size="sm" variant="ghost" onClick={() => void setStatus(s)} loading={action.busy === s}>
                    Mark {s}
                  </Button>
                ))}
            </div>
          ) : null}

          <CompetitionDrawer
            competitionId={openCompetition}
            onClose={() => setOpenCompetition(null)}
            onChanged={() => {
              detail.reload();
              onChanged();
            }}
            isAdmin={isAdmin}
          />

          <CompetitionCreateDrawer
            open={newCompetition}
            framework={fw}
            onClose={() => setNewCompetition(false)}
            onCreated={(id) => {
              setNewCompetition(false);
              detail.reload();
              onChanged();
              setOpenCompetition(id);
            }}
          />
        </div>
      )}
    </Drawer>
  );
}

/* ============================ Mini-competition ============================ */

function CompetitionDrawer({
  competitionId,
  onClose,
  onChanged,
  isAdmin,
}: {
  competitionId: string | null;
  onClose: () => void;
  onChanged: () => void;
  isAdmin: boolean;
}) {
  const detail = useResource<
    MiniCompetition & { evaluation: MiniCompetitionEvaluation; invitedSuppliers?: FrameworkSupplier[] }
  >(competitionId ? `/api/v1/portfolio/mini-competitions/${competitionId}` : null);
  const action = useAction();
  const [awardNote, setAwardNote] = useState("");
  const [awardSupplier, setAwardSupplier] = useState("");
  const [awardValue, setAwardValue] = useState("");
  const [responseSupplier, setResponseSupplier] = useState("");
  const [responsePrice, setResponsePrice] = useState("");
  const [responseNote, setResponseNote] = useState("");
  const [responseScores, setResponseScores] = useState<Record<string, string>>({});
  const [responseWithdrawn, setResponseWithdrawn] = useState(false);

  useEffect(() => {
    setAwardNote("");
    setAwardSupplier("");
    setAwardValue("");
    setResponseSupplier("");
    setResponsePrice("");
    setResponseNote("");
    setResponseScores({});
    setResponseWithdrawn(false);
    action.clear();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [competitionId]);

  const c = detail.data;

  async function issue() {
    if (!competitionId) return;
    const res = await action.run("issue", () => portfolioApi.issueCompetition(competitionId));
    if (res) {
      toast.success("Competition issued to the invited suppliers");
      detail.reload();
      onChanged();
    }
  }

  async function cancel() {
    if (!competitionId) return;
    const reason = window.prompt("Why is this competition being cancelled?");
    if (!reason) return;
    const res = await action.run("cancel", () =>
      portfolioApi.cancelCompetition(competitionId, { reason, outcome: "cancelled" }),
    );
    if (res) {
      toast.success("Competition cancelled with its reason on the ledger");
      detail.reload();
      onChanged();
    }
  }

  async function recordResponse(e: FormEvent) {
    e.preventDefault();
    if (!competitionId) return;
    const price = responsePrice.trim() === "" ? null : Number(responsePrice);
    const scores: Record<string, number> = {};
    for (const [key, raw] of Object.entries(responseScores)) {
      if (raw.trim() === "") continue;
      const parsed = Number(raw);
      if (Number.isFinite(parsed)) scores[key] = parsed;
    }
    const res = await action.run("response", () =>
      portfolioApi.recordResponse(competitionId, {
        supplierId: responseSupplier,
        price: price !== null && Number.isFinite(price) ? price : null,
        scores,
        withdrawn: responseWithdrawn,
        note: responseNote || undefined,
      }),
    );
    if (res) {
      toast.success(responseWithdrawn ? "Withdrawal recorded" : "Response recorded and re-evaluated");
      setResponseSupplier("");
      setResponsePrice("");
      setResponseNote("");
      setResponseScores({});
      setResponseWithdrawn(false);
      detail.reload();
      onChanged();
    }
  }

  async function award(e: FormEvent) {
    e.preventDefault();
    if (!competitionId) return;
    const value = Number(awardValue);
    const res = await action.run("award", () =>
      portfolioApi.awardCompetition(competitionId, {
        supplierId: awardSupplier,
        awardValue: Number.isFinite(value) ? value : 0,
        decisionNote: awardNote,
      }),
    );
    if (res) {
      toast.success(
        res.awardedAgainstIndication
          ? "Awarded — and the fact that it went against the arithmetic is on the ledger"
          : "Awarded",
      );
      detail.reload();
      onChanged();
    }
  }

  return (
    <Drawer
      open={competitionId !== null}
      onClose={onClose}
      size="lg"
      title={c ? `${c.reference} — ${c.title}` : "Mini-competition"}
      description={c ? `${titleCase(c.status)} · ${c.currency}` : undefined}
    >
      {detail.error ? (
        <LoadError message={detail.error} onRetry={detail.reload} />
      ) : !c ? (
        <div className="text-meta text-content-subtle">Loading…</div>
      ) : (
        <div className="space-y-4">
          {action.error ? (
            <Alert tone="danger" size="sm">
              {action.error}
            </Alert>
          ) : null}
          <dl className="divide-y divide-border">
            <Row label="Estimated value">
              {c.estimatedValue === null ? DASH : money(c.estimatedValue, c.currency)}
            </Row>
            <Row label="Issued">{isoDate(c.issuedAt)}</Row>
            <Row label="Responses due">{isoDate(c.responsesDueAt)}</Row>
            <Row label="Invited">{num(c.invitedSupplierIds.length)}</Row>
            {c.awardedSupplierName ? (
              <Row label="Awarded to" hint={c.decisionNote ?? undefined}>
                {c.awardedSupplierName} — {money(c.awardValue, c.currency)}
              </Row>
            ) : null}
          </dl>

          <div>
            <div className="mb-1 text-2xs font-semibold uppercase tracking-wide text-content-subtle">
              Evaluation
            </div>
            {c.evaluation.responses.length === 0 ? (
              <p className="text-meta text-content-subtle">No responses recorded.</p>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <thead>
                    <tr>
                      <Th align="right">Rank</Th>
                      <Th>Supplier</Th>
                      <Th align="right">Price</Th>
                      <Th align="right">Price score</Th>
                      <Th align="right">Quality</Th>
                      <Th align="right">Total</Th>
                      <Th>Notes</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {c.evaluation.responses.map((r) => (
                      <tr key={r.supplierId}>
                        <Td align="right">{r.rank ?? DASH}</Td>
                        <Td>
                          {r.supplierName}
                          {c.evaluation.indicatedWinnerId === r.supplierId ? (
                            <Badge tone="info" size="xs" className="ml-1">
                              indicated
                            </Badge>
                          ) : null}
                        </Td>
                        <Td align="right">{r.price === null ? DASH : moneyShort(r.price, c.currency)}</Td>
                        <Td align="right">{r.priceScore === null ? DASH : r.priceScore.toFixed(1)}</Td>
                        <Td align="right">{r.qualityScore === null ? DASH : r.qualityScore.toFixed(1)}</Td>
                        <Td align="right">
                          {r.totalScore === null ? DASH : <span className="font-semibold">{r.totalScore.toFixed(1)}</span>}
                        </Td>
                        <Td>
                          {r.reasons.length === 0 ? (
                            <span className="text-content-subtle">{DASH}</span>
                          ) : (
                            <span className="text-2xs text-warning-text">{r.reasons.join("; ")}</span>
                          )}
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </div>
            )}
            <p className="mt-1 text-2xs text-content-subtle">
              The arithmetic indicates; it does not decide. The award is a decision a person records, with a reason,
              and awarding against the indication is recorded as such.
            </p>
            <ReasonList reasons={c.evaluation.warnings} className="mt-1" />
          </div>

          {isAdmin && c.status === "draft" ? (
            <div className="rounded-md border border-border p-3">
              <div className="mb-1 text-2xs font-semibold uppercase tracking-wide text-content-subtle">
                Issue
              </div>
              <p className="mb-2 text-meta text-content-muted">
                Issuing sends the competition to the {num(c.invitedSupplierIds.length)} invited supplier(s).
                A competition with nobody invited cannot be issued, and neither can one under a framework
                that is not live.
              </p>
              <Button size="sm" onClick={() => void issue()} loading={action.busy === "issue"}>
                Issue this competition
              </Button>
            </div>
          ) : null}

          {isAdmin && (c.status === "issued" || c.status === "evaluating") ? (
            <form onSubmit={recordResponse} className="space-y-2 rounded-md border border-border p-3">
              <div className="text-2xs font-semibold uppercase tracking-wide text-content-subtle">
                Record a response
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                <Field label="Supplier" required>
                  <Select
                    value={responseSupplier}
                    onChange={(e) => setResponseSupplier(e.target.value)}
                    size="sm"
                    required
                  >
                    <option value="">Choose</option>
                    {(c.invitedSuppliers ?? []).map((sup) => (
                      <option key={sup.id} value={sup.id}>
                        {sup.supplierName}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label={`Price (${c.currency})`} hint="Leave blank where the supplier gave no price; it is not scored as zero.">
                  <Input
                    type="number"
                    value={responsePrice}
                    onChange={(e) => setResponsePrice(e.target.value)}
                    size="sm"
                    min={0}
                    step="0.01"
                  />
                </Field>
              </div>
              {c.evaluationCriteria.filter((crit) => !crit.isPrice).length > 0 ? (
                <div className="grid gap-2 sm:grid-cols-3">
                  {c.evaluationCriteria
                    .filter((crit) => !crit.isPrice)
                    .map((crit) => (
                      <Field key={crit.key} label={`${crit.label} (weight ${crit.weight})`}>
                        <Input
                          type="number"
                          value={responseScores[crit.key] ?? ""}
                          onChange={(e) =>
                            setResponseScores((prev) => ({ ...prev, [crit.key]: e.target.value }))
                          }
                          size="sm"
                          step="0.1"
                        />
                      </Field>
                    ))}
                </div>
              ) : (
                <p className="text-2xs text-content-subtle">
                  This competition declares no quality criteria, so the evaluation is on price alone and says so.
                </p>
              )}
              <Field label="Note">
                <Input value={responseNote} onChange={(e) => setResponseNote(e.target.value)} size="sm" />
              </Field>
              <label className="flex items-center gap-2 text-meta text-content">
                <input
                  type="checkbox"
                  checked={responseWithdrawn}
                  onChange={(e) => setResponseWithdrawn(e.target.checked)}
                />
                Record this as a withdrawal rather than an offer
              </label>
              <Button size="sm" type="submit" loading={action.busy === "response"} disabled={!responseSupplier}>
                Record response
              </Button>
              <p className="text-2xs text-content-subtle">
                Recording a response re-runs the evaluation immediately, so the table above always reflects
                what has actually been received.
              </p>
            </form>
          ) : null}

          {isAdmin && (c.status === "evaluating" || c.status === "issued") ? (
            <form onSubmit={award} className="space-y-2 rounded-md border border-border p-3">
              <div className="text-2xs font-semibold uppercase tracking-wide text-content-subtle">Award</div>
              <div className="grid gap-2 sm:grid-cols-2">
                <Field label="Supplier" required>
                  <Select value={awardSupplier} onChange={(e) => setAwardSupplier(e.target.value)} size="sm" required>
                    <option value="">Choose</option>
                    {c.evaluation.responses.map((r) => (
                      <option key={r.supplierId} value={r.supplierId}>
                        {r.supplierName}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label={`Award value (${c.currency})`} required>
                  <Input
                    type="number"
                    value={awardValue}
                    onChange={(e) => setAwardValue(e.target.value)}
                    size="sm"
                    min={0}
                    step="0.01"
                    required
                  />
                </Field>
              </div>
              <Field label="Decision note" required hint="Why this supplier. The person who ran the competition cannot award it.">
                <Textarea rows={2} value={awardNote} onChange={(e) => setAwardNote(e.target.value)} required />
              </Field>
              <Button size="sm" type="submit" loading={action.busy === "award"}>
                Record the award
              </Button>
            </form>
          ) : null}

          {isAdmin && !["awarded", "cancelled", "abandoned"].includes(c.status) ? (
            <div className="border-t border-border pt-3">
              <Button size="sm" variant="ghost" onClick={() => void cancel()} loading={action.busy === "cancel"}>
                Cancel this competition
              </Button>
            </div>
          ) : null}
        </div>
      )}
    </Drawer>
  );
}

/* ======================= Mini-competition — create ======================== */

interface DraftEvaluationCriterion {
  key: string;
  label: string;
  weight: string;
  isPrice: boolean;
}

const BLANK_CRITERION: DraftEvaluationCriterion = { key: "", label: "", weight: "10", isPrice: false };

/**
 * Creating a competition is where #1054 begins: who was invited, on what
 * terms, and against which criteria. Without this the award form further down
 * could never succeed, because the API refuses an award to a supplier that
 * never answered.
 */
function CompetitionCreateDrawer({
  open,
  framework,
  onClose,
  onCreated,
}: {
  open: boolean;
  framework: FrameworkDetail;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const action = useAction();
  const [form, setForm] = useState<Record<string, string>>({});
  const [invited, setInvited] = useState<string[]>([]);
  const [criteria, setCriteria] = useState<DraftEvaluationCriterion[]>([
    { key: "price", label: "Price", weight: "60", isPrice: true },
    { key: "quality", label: "Quality", weight: "40", isPrice: false },
  ]);

  useEffect(() => {
    if (!open) return;
    setForm({});
    setInvited([]);
    setCriteria([
      { key: "price", label: "Price", weight: "60", isPrice: true },
      { key: "quality", label: "Quality", weight: "40", isPrice: false },
    ]);
    action.clear();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const set = (key: string, value: string) => setForm((f) => ({ ...f, [key]: value }));
  const appointable = framework.suppliers.filter((sup) => sup.status === "appointed");
  const lotFilter = form["lotId"] ?? "";
  const eligible = lotFilter
    ? appointable.filter((sup) => sup.lotId === lotFilter || sup.lotId === null)
    : appointable;

  async function submit(e: FormEvent) {
    e.preventDefault();
    const estimated = Number(form["estimatedValue"] ?? "");
    const res = await action.run("create", () =>
      portfolioApi.createCompetition({
        reference: form["reference"] ?? "",
        title: form["title"] ?? "",
        scope: form["scope"] || undefined,
        frameworkId: framework.id,
        lotId: form["lotId"] || undefined,
        currency: framework.currency,
        estimatedValue:
          form["estimatedValue"] && Number.isFinite(estimated) ? estimated : undefined,
        invitedSupplierIds: invited,
        responsesDueAt: form["responsesDueAt"] || undefined,
        evaluationCriteria: criteria
          .filter((crit) => crit.key.trim() !== "")
          .map((crit) => ({
            key: crit.key.trim(),
            label: crit.label.trim() || crit.key.trim(),
            weight: Number(crit.weight) || 0,
            isPrice: crit.isPrice,
          })),
      }),
    );
    if (res) {
      toast.success("Competition drafted — issue it when the invitation goes out");
      onCreated(res.id);
    }
  }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      size="lg"
      title={`New mini-competition under ${framework.reference}`}
      description={`${framework.currency} · invitations are limited to suppliers appointed to this framework`}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="portfolio-competition-create" loading={action.busy === "create"}>
            Create draft
          </Button>
        </div>
      }
    >
      <form id="portfolio-competition-create" onSubmit={submit} className="space-y-4">
        {action.error ? (
          <Alert tone="danger" size="sm">
            {action.error}
          </Alert>
        ) : null}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Reference" required>
            <Input value={form["reference"] ?? ""} onChange={(e) => set("reference", e.target.value)} required />
          </Field>
          <Field label="Lot">
            <Select
              value={form["lotId"] ?? ""}
              onChange={(e) => {
                set("lotId", e.target.value);
                setInvited([]);
              }}
            >
              <option value="">Whole framework</option>
              {framework.lots.map((l) => (
                <option key={l.id} value={l.id}>
                  Lot {l.lotNumber} — {l.title}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="Title" required>
          <Input value={form["title"] ?? ""} onChange={(e) => set("title", e.target.value)} required />
        </Field>
        <Field label="Scope">
          <Textarea rows={3} value={form["scope"] ?? ""} onChange={(e) => set("scope", e.target.value)} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={`Estimated value (${framework.currency})`}>
            <Input
              type="number"
              value={form["estimatedValue"] ?? ""}
              onChange={(e) => set("estimatedValue", e.target.value)}
              min={0}
              step="0.01"
            />
          </Field>
          <Field label="Responses due">
            <Input
              type="date"
              value={form["responsesDueAt"] ?? ""}
              onChange={(e) => set("responsesDueAt", e.target.value)}
            />
          </Field>
        </div>

        <div>
          <div className="mb-1 text-2xs font-semibold uppercase tracking-wide text-content-subtle">
            Invite ({invited.length} selected)
          </div>
          {eligible.length === 0 ? (
            <Alert tone="warning" size="sm">
              No appointed supplier is available for this lot. Appoint suppliers to the framework first — a
              competition run among nobody is not a competition.
            </Alert>
          ) : (
            <ul className="space-y-1">
              {eligible.map((sup) => (
                <li key={sup.id}>
                  <label className="flex items-center gap-2 rounded-md border border-border px-2 py-1 text-meta text-content">
                    <input
                      type="checkbox"
                      checked={invited.includes(sup.id)}
                      onChange={(e) =>
                        setInvited((list) =>
                          e.target.checked ? [...list, sup.id] : list.filter((x) => x !== sup.id),
                        )
                      }
                    />
                    {sup.rank ? <span className="text-content-subtle">#{sup.rank}</span> : null}
                    {sup.supplierName}
                  </label>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div>
          <div className="mb-2 flex items-center justify-between">
            <span className="text-2xs font-semibold uppercase tracking-wide text-content-subtle">
              Evaluation criteria
            </span>
            <Button
              size="xs"
              variant="ghost"
              onClick={() => setCriteria((l) => [...l, { ...BLANK_CRITERION }])}
            >
              Add criterion
            </Button>
          </div>
          <div className="space-y-2">
            {criteria.map((crit, i) => (
              <div key={i} className="grid items-end gap-2 rounded-md border border-border p-2 sm:grid-cols-5">
                <Field label="Key">
                  <Input
                    value={crit.key}
                    onChange={(e) =>
                      setCriteria((l) => l.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))
                    }
                    size="sm"
                  />
                </Field>
                <Field label="Label" className="sm:col-span-2">
                  <Input
                    value={crit.label}
                    onChange={(e) =>
                      setCriteria((l) => l.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))
                    }
                    size="sm"
                  />
                </Field>
                <Field label="Weight">
                  <Input
                    type="number"
                    value={crit.weight}
                    onChange={(e) =>
                      setCriteria((l) => l.map((x, j) => (j === i ? { ...x, weight: e.target.value } : x)))
                    }
                    size="sm"
                    min={0}
                  />
                </Field>
                <label className="flex items-center gap-2 pb-2 text-meta text-content">
                  <input
                    type="checkbox"
                    checked={crit.isPrice}
                    onChange={(e) =>
                      setCriteria((l) => l.map((x, j) => (j === i ? { ...x, isPrice: e.target.checked } : x)))
                    }
                  />
                  Price
                </label>
              </div>
            ))}
          </div>
          <p className="mt-1 text-2xs text-content-subtle">
            The price criterion is scored from the prices actually offered; the rest are scored by the
            evaluators. A supplier that gave no price is named as unscored, never scored as zero.
          </p>
        </div>
      </form>
    </Drawer>
  );
}

/* =============================== Create =================================== */

function FrameworkCreateDrawer({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const action = useAction();
  const [form, setForm] = useState<Record<string, string>>({});

  useEffect(() => {
    setForm({});
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
      portfolioApi.createFramework({
        reference: form["reference"] ?? "",
        title: form["title"] ?? "",
        contractingAuthority: form["contractingAuthority"] || undefined,
        currency: form["currency"] ?? "",
        maximumValue: numeric("maximumValue"),
        awardMode: form["awardMode"] ?? "mini_competition",
        directAwardThreshold: numeric("directAwardThreshold"),
        startDate: form["startDate"] || undefined,
        endDate: form["endDate"] || undefined,
        extensionToDate: form["extensionToDate"] || undefined,
        rulesReference: form["rulesReference"] || undefined,
      }),
    );
    if (res) {
      toast.success("Framework recorded as a draft — mark it live to call off it");
      onCreated();
    }
  }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      size="md"
      title="New framework agreement"
      description="A framework with no declared maximum is uncapped, and this platform says so rather than showing an infinite headroom."
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="portfolio-framework-create" loading={action.busy === "create"}>
            Save
          </Button>
        </div>
      }
    >
      <form id="portfolio-framework-create" onSubmit={submit} className="space-y-4">
        {action.error ? (
          <Alert tone="danger" size="sm">
            {action.error}
          </Alert>
        ) : null}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Reference" required>
            <Input value={form["reference"] ?? ""} onChange={(e) => set("reference", e.target.value)} required />
          </Field>
          <Field label="Currency" required>
            <Input value={form["currency"] ?? ""} onChange={(e) => set("currency", e.target.value)} maxLength={3} required />
          </Field>
        </div>
        <Field label="Title" required>
          <Input value={form["title"] ?? ""} onChange={(e) => set("title", e.target.value)} required />
        </Field>
        <Field label="Contracting authority" hint="When the framework is someone else's to call off">
          <Input
            value={form["contractingAuthority"] ?? ""}
            onChange={(e) => set("contractingAuthority", e.target.value)}
          />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Maximum value" hint="Leave blank for uncapped">
            <Input
              type="number"
              value={form["maximumValue"] ?? ""}
              onChange={(e) => set("maximumValue", e.target.value)}
              min={0}
              step="0.01"
            />
          </Field>
          <Field label="Award mode" required>
            <Select value={form["awardMode"] ?? "mini_competition"} onChange={(e) => set("awardMode", e.target.value)}>
              {AWARD_MODES.map((m) => (
                <option key={m} value={m}>
                  {titleCase(m)}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="Direct-award threshold" hint="A direct award above this is refused with the rule that bites">
          <Input
            type="number"
            value={form["directAwardThreshold"] ?? ""}
            onChange={(e) => set("directAwardThreshold", e.target.value)}
            min={0}
            step="0.01"
          />
        </Field>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Start">
            <Input type="date" value={form["startDate"] ?? ""} onChange={(e) => set("startDate", e.target.value)} />
          </Field>
          <Field label="End">
            <Input type="date" value={form["endDate"] ?? ""} onChange={(e) => set("endDate", e.target.value)} />
          </Field>
          <Field label="Extension to">
            <Input
              type="date"
              value={form["extensionToDate"] ?? ""}
              onChange={(e) => set("extensionToDate", e.target.value)}
            />
          </Field>
        </div>
        <Field label="Rules reference" hint="The call-off procedure this framework is governed by">
          <Input value={form["rulesReference"] ?? ""} onChange={(e) => set("rulesReference", e.target.value)} />
        </Field>
      </form>
    </Drawer>
  );
}
