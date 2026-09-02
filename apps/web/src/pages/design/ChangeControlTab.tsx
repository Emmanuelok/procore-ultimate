/**
 * CHANGE CONTROL — design change notices, per-discipline impact assessment
 * and the freeze register (#255, #890–#896).
 *
 * The authorisation level is computed, not typed. Cost is bucketed by
 * currency and never added across them; time is the longest single-discipline
 * impact, not the sum. Whether a change was post-freeze is stamped at
 * submission and never recomputed.
 */
import { useMemo, useState, type FormEvent } from "react";
import { toast } from "sonner";
import {
  DCN_AUTHORISATION_LEVELS,
  DCN_CLASSIFICATIONS,
  DCN_ORIGINATORS,
  DCN_STATUSES,
  DESIGN_DISCIPLINES,
} from "@constructos/shared";
import { Alert, Badge, Button, Card, CardBody, Drawer, EmptyState, Field, Input, Select, Skeleton, Textarea } from "../../ui";
import { DataTable, type DataColumns } from "../../ui/data";
import { IconChangeOrder, IconLock, IconPlus } from "../../ui/icons";
import { api } from "../../lib/api";
import {
  AUTHORISATION_TONE,
  CurrencyRail,
  DCN_STATUS_TONE,
  EM_DASH,
  KeyValue,
  LoadError,
  ReasonList,
  RefusalNotice,
  SectionHeading,
  dateTime,
  isoDate,
  labelize,
  money,
  num,
  optionList,
  useAction,
  useResource,
  type ChangeNoticeDetail,
  type ChangeNoticeRow,
  type FreezeRow,
  type ListResponse,
  type Lookups,
} from "./designShared";

export default function ChangeControlTab({
  projectId,
  lookups,
  onChanged,
}: {
  projectId: string;
  lookups: Lookups;
  onChanged: () => void;
}) {
  const base = `/api/v1/projects/${projectId}/design`;
  const [status, setStatus] = useState("");
  const [classification, setClassification] = useState("");
  const [postFreezeOnly, setPostFreezeOnly] = useState(false);
  const query = new URLSearchParams({ pageSize: "500" });
  if (status) query.set("status", status);
  if (classification) query.set("classification", classification);
  if (postFreezeOnly) query.set("postFreeze", "true");
  const notices = useResource<ListResponse<ChangeNoticeRow>>(`${base}/change-notices?${query.toString()}`);
  const freezes = useResource<ListResponse<FreezeRow>>(`${base}/freezes?pageSize=200`);
  const [createOpen, setCreateOpen] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const detail = useResource<ChangeNoticeDetail>(openId ? `${base}/change-notices/${openId}` : null);
  const action = useAction();

  function changed() {
    notices.reload();
    freezes.reload();
    detail.reload();
    onChanged();
  }

  const packageRef = useMemo(() => new Map(lookups.packages.map((p) => [p.id, p.reference])), [lookups.packages]);

  const exposure = useMemo(() => {
    const map: Record<string, number> = {};
    for (const notice of notices.data?.items ?? []) {
      if (notice.assessedCost === null) continue;
      if (["draft", "rejected", "withdrawn"].includes(notice.status)) continue;
      const currency = notice.currency || "USD";
      map[currency] = Math.round(((map[currency] ?? 0) + notice.assessedCost) * 100) / 100;
    }
    return map;
  }, [notices.data]);

  const columns = useMemo<DataColumns<ChangeNoticeRow>>(
    () => [
      { id: "reference", header: "Ref", accessor: "reference", type: "code", sticky: "start", width: 100, mono: true },
      { id: "title", header: "Change", accessor: "title", type: "text", width: 250 },
      {
        id: "package",
        header: "Package",
        accessor: (row) => (row.packageId ? packageRef.get(row.packageId) ?? row.packageId : ""),
        type: "text",
        width: 110,
      },
      {
        id: "classification",
        header: "Classification",
        accessor: "classification",
        type: "status",
        width: 160,
        groupable: true,
        cell: ({ row }) => (
          <Badge tone={row.classification === "design_change" ? "warning" : "neutral"} size="xs">
            {labelize(row.classification)}
          </Badge>
        ),
      },
      {
        id: "originator",
        header: "Originator",
        accessor: "originator",
        type: "text",
        width: 120,
        groupable: true,
        cell: ({ row }) => labelize(row.originator),
      },
      {
        id: "status",
        header: "Status",
        accessor: "status",
        type: "status",
        width: 120,
        groupable: true,
        cell: ({ row }) => (
          <span className="inline-flex items-center gap-1.5">
            <Badge tone={DCN_STATUS_TONE[row.status] ?? "neutral"} size="xs" dot>
              {labelize(row.status)}
            </Badge>
            {row.isPostFreeze === 1 ? <IconLock className="h-3.5 w-3.5 text-danger-fg" aria-label="Post-freeze" /> : null}
          </span>
        ),
      },
      {
        id: "requiredAuthorisation",
        header: "Needs",
        accessor: "requiredAuthorisation",
        type: "status",
        width: 150,
        cell: ({ row }) => (
          <span title={row.authorisationBasis ?? undefined}>
            <Badge tone={AUTHORISATION_TONE[row.requiredAuthorisation] ?? "neutral"} size="xs">
              {labelize(row.requiredAuthorisation)}
            </Badge>
          </span>
        ),
      },
      {
        id: "assessedCost",
        header: "Assessed cost",
        accessor: (row) => row.assessedCost,
        type: "number",
        width: 150,
        cell: ({ row }) =>
          row.assessedCost === null ? (
            <span className="italic text-content-subtle">
              {row.impactCurrencies.length > 1 ? `${row.impactCurrencies.length} currencies` : "not assessed"}
            </span>
          ) : (
            money(row.assessedCost, row.currency)
          ),
      },
      {
        id: "assessedTimeDays",
        header: "Time (d)",
        accessor: (row) => row.assessedTimeDays,
        type: "number",
        width: 100,
        signColor: true,
      },
      { id: "impactCount", header: "Assessments", accessor: "impactCount", type: "number", width: 120 },
      {
        id: "submittedAt",
        header: "Submitted",
        accessor: (row) => row.submittedAt ?? "",
        type: "date",
        width: 130,
        cell: ({ row }) => (row.submittedAt ? isoDate(row.submittedAt) : <span className="italic text-content-subtle">draft</span>),
      },
    ],
    [packageRef],
  );

  return (
    <div className="space-y-4">
      {action.refusal ? <RefusalNotice refusal={action.refusal} onDismiss={action.clear} /> : null}

      <CurrencyRail
        map={exposure}
        label="Assessed design change exposure"
        note={
          Object.keys(exposure).length > 1
            ? "Reported per currency and never added: a single total would need an FX rate and a date. Draft, rejected and withdrawn notices are excluded."
            : "Draft, rejected and withdrawn notices are excluded."
        }
      />

      <FreezeRegister base={base} freezes={freezes} lookups={lookups} action={action} onChanged={changed} />

      <Card>
        <CardBody>
          <SectionHeading
            title="Design change notices"
            hint="Design development is the design maturing inside its stage and carries no entitlement; a design change alters something already fixed and does. The originator carries the cost — a designer's own change is not an owner variation, and the platform refuses to raise one."
            actions={
              <>
                <Select size="sm" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status filter">
                  <option value="">All statuses</option>
                  {DCN_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {labelize(s)}
                    </option>
                  ))}
                </Select>
                <Select size="sm" value={classification} onChange={(e) => setClassification(e.target.value)} aria-label="Classification filter">
                  <option value="">All classifications</option>
                  {DCN_CLASSIFICATIONS.map((c) => (
                    <option key={c} value={c}>
                      {labelize(c)}
                    </option>
                  ))}
                </Select>
                <Button size="sm" variant={postFreezeOnly ? "primary" : "secondary"} onClick={() => setPostFreezeOnly((v) => !v)}>
                  Post-freeze only
                </Button>
                <Button size="sm" leadingIcon={IconPlus} onClick={() => setCreateOpen(true)}>
                  Raise a change notice
                </Button>
              </>
            }
          />
          {notices.error ? <LoadError message={notices.error} onRetry={notices.reload} /> : null}
          <DataTable<ChangeNoticeRow>
            tableId="design-change-notices"
            data={notices.data?.items ?? []}
            columns={columns}
            getRowId={(row) => row.id}
            loading={notices.loading && !notices.data}
            height={520}
            stickyHeader
            filterRow
            exportFileName="design-change-notices"
            searchPlaceholder="Search by reference or title…"
            defaultSort={[{ id: "reference", desc: true }]}
            onRowClick={({ row }) => setOpenId(row.id)}
            rowTone={(row) => (row.isPostFreeze === 1 ? "danger" : row.status === "submitted" || row.status === "assessing" ? "warning" : undefined)}
            empty={{
              title: "No design change notice",
              description: "A DCN is the upstream half of change control: what happens before a change event costs money.",
              action: (
                <Button size="sm" onClick={() => setCreateOpen(true)}>
                  Raise the first notice
                </Button>
              ),
            }}
          />
        </CardBody>
      </Card>

      <NoticeForm
        base={base}
        open={createOpen}
        lookups={lookups}
        onClose={() => setCreateOpen(false)}
        onCreated={() => {
          setCreateOpen(false);
          changed();
        }}
      />
      <NoticeDrawer base={base} noticeId={openId} detail={detail} lookups={lookups} onClose={() => setOpenId(null)} onChanged={changed} />
    </div>
  );
}

/* ------------------------------------------------------------------ */

function FreezeRegister({
  base,
  freezes,
  lookups,
  action,
  onChanged,
}: {
  base: string;
  freezes: ReturnType<typeof useResource<ListResponse<FreezeRow>>>;
  lookups: Lookups;
  action: ReturnType<typeof useAction>;
  onChanged: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [scope, setScope] = useState("package");
  const [packageId, setPackageId] = useState("");
  const [title, setTitle] = useState("");
  const [reason, setReason] = useState("");
  const [level, setLevel] = useState("client");

  async function declare(e: FormEvent) {
    e.preventDefault();
    const payload: Record<string, unknown> = { scope, title: title.trim(), requiredAuthorisation: level };
    if (scope === "package") payload["packageId"] = packageId;
    if (reason.trim()) payload["reason"] = reason.trim();
    const r = await action.run("freeze", () => api.post(`${base}/freezes`, payload));
    if (r) {
      toast.success("Design freeze declared");
      setTitle("");
      setAdding(false);
      onChanged();
    }
  }

  async function lift(freezeId: string) {
    const liftReason = window.prompt("Why is the freeze being lifted?");
    if (!liftReason) return;
    const r = await action.run(`lift-${freezeId}`, () => api.post(`${base}/freezes/${freezeId}/lift`, { reason: liftReason }));
    if (r) {
      toast.success("Freeze lifted");
      onChanged();
    }
  }

  const rows = freezes.data?.items ?? [];
  const packageName = new Map(lookups.packages.map((p) => [p.id, `${p.reference} — ${p.name}`]));

  return (
    <Card>
      <CardBody>
        <SectionHeading
          title="Design freezes"
          hint="A freeze is what makes 'post-freeze change' a fact rather than an opinion. Lifting one is a distinct, ledgered act — a freeze is never deleted, and a change raised while it held stays post-freeze afterwards."
          actions={
            <Button size="sm" variant="secondary" leadingIcon={IconLock} onClick={() => setAdding((v) => !v)}>
              Declare a freeze
            </Button>
          }
        />
        {freezes.error ? <LoadError message={freezes.error} onRetry={freezes.reload} /> : null}
        {adding ? (
          <form onSubmit={(e) => void declare(e)} className="mb-3 grid gap-2 rounded-lg border border-border-subtle bg-surface-sunken p-3 sm:grid-cols-4">
            <Field label="Scope">
              <Select value={scope} onChange={(e) => setScope(e.target.value)}>
                <option value="package">Package</option>
                <option value="project">Whole project</option>
              </Select>
            </Field>
            {scope === "package" ? (
              <Field label="Package">
                <Select value={packageId} onChange={(e) => setPackageId(e.target.value)}>
                  {optionList(lookups.packages, (p) => `${p.reference} — ${p.name}`, "— choose —").map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : null}
            <Field label="Title">
              <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Stage 4 freeze" />
            </Field>
            <Field label="Authorisation a change then needs">
              <Select value={level} onChange={(e) => setLevel(e.target.value)}>
                {DCN_AUTHORISATION_LEVELS.map((l) => (
                  <option key={l} value={l}>
                    {labelize(l)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Reason" className="sm:col-span-3">
              <Input value={reason} onChange={(e) => setReason(e.target.value)} />
            </Field>
            <div className="flex items-end">
              <Button type="submit" size="sm" loading={action.busy === "freeze"} disabled={!title.trim() || (scope === "package" && !packageId)}>
                Declare
              </Button>
            </div>
          </form>
        ) : null}
        {rows.length === 0 ? (
          <EmptyState icon={IconLock} title="Nothing is frozen" description="Without a freeze, every change is 'design development' and nothing is protected from late change." />
        ) : (
          <ul className="divide-y divide-border-subtle">
            {rows.map((freeze) => (
              <li key={freeze.id} className="flex flex-wrap items-center justify-between gap-3 py-2">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-meta font-medium text-content">{freeze.title}</span>
                    <Badge tone={freeze.status === "active" ? "danger" : "neutral"} size="xs" dot>
                      {labelize(freeze.status)}
                    </Badge>
                    <Badge tone="neutral" size="xs">
                      {labelize(freeze.scope)}
                    </Badge>
                  </div>
                  <div className="text-2xs text-content-muted">
                    {freeze.packageId ? `${packageName.get(freeze.packageId) ?? freeze.packageId} · ` : ""}
                    from {dateTime(freeze.effectiveFrom)} · a change then needs {labelize(freeze.requiredAuthorisation).toLowerCase()} authorisation
                    {freeze.status === "lifted" ? ` · lifted ${dateTime(freeze.liftedAt)}: ${freeze.liftReason ?? ""}` : ""}
                  </div>
                </div>
                {freeze.status === "active" ? (
                  <Button size="xs" variant="ghost" loading={action.busy === `lift-${freeze.id}`} onClick={() => void lift(freeze.id)}>
                    Lift
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}

/* ------------------------------------------------------------------ */

function NoticeForm({
  base,
  open,
  lookups,
  onClose,
  onCreated,
}: {
  base: string;
  open: boolean;
  lookups: Lookups;
  onClose: () => void;
  onCreated: () => void;
}) {
  const action = useAction();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [packageId, setPackageId] = useState("");
  const [discipline, setDiscipline] = useState("multi_discipline");
  const [classification, setClassification] = useState("design_change");
  const [originator, setOriginator] = useState("client");
  const [needByDate, setNeedByDate] = useState("");
  const [currency, setCurrency] = useState("USD");

  async function submit(e: FormEvent) {
    e.preventDefault();
    const payload: Record<string, unknown> = {
      title: title.trim(),
      discipline,
      classification,
      originator,
      currency: currency.toUpperCase(),
    };
    if (description.trim()) payload["description"] = description.trim();
    if (packageId) payload["packageId"] = packageId;
    if (needByDate) payload["needByDate"] = needByDate;
    const r = await action.run("create", () => api.post<ChangeNoticeRow>(`${base}/change-notices`, payload));
    if (r) {
      toast.success(`${r.reference} raised in draft`);
      setTitle("");
      setDescription("");
      onCreated();
    }
  }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      size="md"
      title="Raise a design change notice"
      description="Classify it honestly: design development is already paid for, a design change is not. The classification and the originator decide who carries the cost."
    >
      <form onSubmit={(e) => void submit(e)} className="space-y-3">
        {action.refusal ? <RefusalNotice refusal={action.refusal} onDismiss={action.clear} /> : null}
        <Field label="Title" required>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={200} />
        </Field>
        <Field label="What is changing, and why">
          <Textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Classification" hint="Design development carries no entitlement.">
            <Select value={classification} onChange={(e) => setClassification(e.target.value)}>
              {DCN_CLASSIFICATIONS.map((c) => (
                <option key={c} value={c}>
                  {labelize(c)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Originator" hint="Who drove the change; the cost is attributed here.">
            <Select value={originator} onChange={(e) => setOriginator(e.target.value)}>
              {DCN_ORIGINATORS.map((o) => (
                <option key={o} value={o}>
                  {labelize(o)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Package">
            <Select value={packageId} onChange={(e) => setPackageId(e.target.value)}>
              {optionList(lookups.packages, (p) => `${p.reference} — ${p.name}`).map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Discipline">
            <Select value={discipline} onChange={(e) => setDiscipline(e.target.value)}>
              {DESIGN_DISCIPLINES.map((d) => (
                <option key={d} value={d}>
                  {labelize(d)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Needed by">
            <Input type="date" value={needByDate} onChange={(e) => setNeedByDate(e.target.value)} />
          </Field>
          <Field label="Currency">
            <Input value={currency} onChange={(e) => setCurrency(e.target.value)} maxLength={3} />
          </Field>
        </div>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={action.busy === "create"} disabled={!title.trim()}>
            Raise in draft
          </Button>
        </div>
      </form>
    </Drawer>
  );
}

/* ------------------------------------------------------------------ */

function NoticeDrawer({
  base,
  noticeId,
  detail,
  lookups,
  onClose,
  onChanged,
}: {
  base: string;
  noticeId: string | null;
  detail: ReturnType<typeof useResource<ChangeNoticeDetail>>;
  lookups: Lookups;
  onClose: () => void;
  onChanged: () => void;
}) {
  const action = useAction();
  const [impactDiscipline, setImpactDiscipline] = useState("architectural");
  const [impactSummary, setImpactSummary] = useState("");
  const [impactCost, setImpactCost] = useState("");
  const [impactCurrency, setImpactCurrency] = useState("USD");
  const [impactDays, setImpactDays] = useState("");
  const [impactHours, setImpactHours] = useState("");
  const [approveLevel, setApproveLevel] = useState("");
  const row = detail.data;

  async function addImpact(e: FormEvent) {
    e.preventDefault();
    const payload: Record<string, unknown> = {
      discipline: impactDiscipline,
      summary: impactSummary.trim(),
      currency: impactCurrency.toUpperCase(),
    };
    if (impactCost.trim()) payload["costImpact"] = Number(impactCost);
    if (impactDays.trim()) payload["timeImpactDays"] = Number(impactDays);
    if (impactHours.trim()) payload["reworkHours"] = Number(impactHours);
    const r = await action.run("impact", () => api.post(`${base}/change-notices/${noticeId}/impacts`, payload));
    if (r) {
      toast.success("Impact assessment recorded");
      setImpactSummary("");
      setImpactCost("");
      setImpactDays("");
      setImpactHours("");
      onChanged();
    }
  }

  async function removeImpact(impactId: string) {
    const r = await action.run(`remove-${impactId}`, () => api.del(`${base}/change-notices/${noticeId}/impacts/${impactId}`));
    if (r) onChanged();
  }

  async function submit() {
    const r = await action.run("submit", () => api.post<{ isPostFreeze: number }>(`${base}/change-notices/${noticeId}/submit`, {}));
    if (r) {
      toast.success(r.isPostFreeze === 1 ? "Submitted — and it lands after a design freeze" : "Submitted");
      onChanged();
    }
  }

  async function approve() {
    const level = approveLevel || row?.requiredAuthorisation || "design_lead";
    const r = await action.run("approve", () => api.post(`${base}/change-notices/${noticeId}/approve`, { authorisationLevel: level }));
    if (r) {
      toast.success("Approved");
      onChanged();
    }
  }

  async function reject() {
    const reason = window.prompt("Why is it rejected?");
    if (!reason) return;
    const r = await action.run("reject", () => api.post(`${base}/change-notices/${noticeId}/reject`, { reason }));
    if (r) onChanged();
  }

  async function withdraw() {
    const reason = window.prompt("Why is it being withdrawn?");
    if (!reason) return;
    const r = await action.run("withdraw", () => api.post(`${base}/change-notices/${noticeId}/withdraw`, { reason }));
    if (r) onChanged();
  }

  async function implement(raiseChangeEvent: boolean) {
    const r = await action.run("implement", () =>
      api.post<{ changeEventId: string | null }>(`${base}/change-notices/${noticeId}/implement`, { raiseChangeEvent }),
    );
    if (r) {
      toast.success(r.changeEventId ? "Implemented and a change event raised" : "Implemented with no change event");
      onChanged();
    }
  }

  const packageName = new Map(lookups.packages.map((p) => [p.id, `${p.reference} — ${p.name}`]));

  return (
    <Drawer open={noticeId !== null} onClose={onClose} size="lg" title={row ? `${row.reference} — ${row.title}` : "Design change notice"}>
      <div className="space-y-4">
        {action.refusal ? <RefusalNotice refusal={action.refusal} onDismiss={action.clear} /> : null}
        {detail.error ? <LoadError message={detail.error} onRetry={detail.reload} /> : null}
        {detail.loading && !row ? <Skeleton className="h-40 w-full" /> : null}
        {row ? (
          <>
            <KeyValue
              items={[
                { label: "Status", value: <Badge tone={DCN_STATUS_TONE[row.status] ?? "neutral"} size="xs" dot>{labelize(row.status)}</Badge> },
                { label: "Classification", value: labelize(row.classification) },
                { label: "Originator", value: labelize(row.originator) },
                { label: "Package", value: row.packageId ? packageName.get(row.packageId) ?? row.packageId : EM_DASH },
                { label: "Submitted", value: row.submittedAt ? dateTime(row.submittedAt) : "still in draft" },
                { label: "Approved", value: row.approvedAt ? dateTime(row.approvedAt) : EM_DASH },
                { label: "Needed by", value: isoDate(row.needByDate) },
                { label: "Change event", value: row.changeEventId ?? "none raised" },
              ]}
            />
            {row.description ? <p className="text-meta text-content-muted">{row.description}</p> : null}

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-lg border border-border-subtle bg-surface-sunken p-3">
                <div className="text-2xs uppercase tracking-wide text-content-subtle">Assessed impact</div>
                {row.rollup.currencies.length === 0 ? (
                  <p className="mt-1 text-meta italic text-content-subtle">Nothing has been assessed.</p>
                ) : row.rollup.cost !== null ? (
                  <div className="mt-1 text-display-xs font-semibold tabular-nums text-content">
                    {money(row.rollup.cost, row.rollup.currencies[0] ?? row.currency)}
                  </div>
                ) : (
                  <div className="mt-1 flex flex-wrap gap-x-4">
                    {Object.entries(row.rollup.costByCurrency).map(([currency, value]) => (
                      <div key={currency}>
                        <div className="text-body font-semibold tabular-nums text-content">{money(value, currency)}</div>
                        <div className="text-2xs uppercase text-content-subtle">{currency}</div>
                      </div>
                    ))}
                  </div>
                )}
                <div className="mt-1 text-meta text-content-muted">
                  {row.rollup.timeDays === null ? "no time impact assessed" : `${num(row.rollup.timeDays)} day programme impact`}
                  {row.rollup.reworkHours !== null ? ` · ${num(row.rollup.reworkHours, 1)} rework hours` : ""}
                </div>
                <p className="mt-1 text-2xs text-content-muted">{row.rollup.timeBasis}</p>
                <ReasonList reasons={row.rollup.costReasons} className="mt-1" />
              </div>

              <div className="rounded-lg border border-border-subtle bg-surface-sunken p-3">
                <div className="text-2xs uppercase tracking-wide text-content-subtle">Authorisation required</div>
                <div className="mt-1">
                  <Badge tone={AUTHORISATION_TONE[row.authorisation.level] ?? "neutral"} size="sm" dot>
                    {labelize(row.authorisation.level)}
                  </Badge>
                </div>
                <ReasonList reasons={row.authorisation.reasons} className="mt-1.5" />
                {row.freeze.isPostFreeze ? (
                  <Alert tone="danger" title="Post-freeze change" size="sm" className="mt-2">
                    {row.freeze.basis}
                  </Alert>
                ) : (
                  <p className="mt-1.5 text-2xs text-content-muted">{row.freeze.basis}</p>
                )}
              </div>
            </div>

            <div className="rounded-lg border border-border-subtle p-3">
              <div className="text-2xs uppercase tracking-wide text-content-subtle">Entitlement</div>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <Badge tone={row.entitlement.carriesEntitlement ? "warning" : "neutral"} size="xs" dot>
                  {row.entitlement.carriesEntitlement ? "carries entitlement" : "no entitlement"}
                </Badge>
                <Badge tone="neutral" size="xs">
                  cost carried by {labelize(row.entitlement.costCarrier)}
                </Badge>
                {row.entitlement.raisesChangeEvent ? (
                  <Badge tone="info" size="xs">
                    a change event is warranted
                  </Badge>
                ) : null}
              </div>
              <ReasonList reasons={row.entitlement.reasons} className="mt-1.5" />
            </div>

            <div>
              <SectionHeading
                title={`Impact assessments (${row.impacts.length})`}
                hint="One per discipline. Cost is bucketed by currency; time is the longest single impact, because disciplines working in parallel do not add."
              />
              {row.impacts.length === 0 ? (
                <EmptyState icon={IconChangeOrder} title="No discipline has assessed this change" description="A change nobody has assessed cannot be approved: approving it would be approving an unknown number." />
              ) : (
                <ul className="divide-y divide-border-subtle">
                  {row.impacts.map((impact) => (
                    <li key={impact.id} className="flex flex-wrap items-start justify-between gap-3 py-2">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge tone="neutral" size="xs">
                            {labelize(impact.discipline)}
                          </Badge>
                          <span className="text-meta tabular-nums text-content">
                            {impact.costImpact === null ? <span className="italic text-content-subtle">no cost</span> : money(impact.costImpact, impact.currency)}
                          </span>
                          {impact.timeImpactDays !== null ? <span className="text-meta text-content-muted">{num(impact.timeImpactDays)} d</span> : null}
                          {impact.reworkHours !== null ? <span className="text-meta text-content-muted">{num(impact.reworkHours, 1)} h rework</span> : null}
                        </div>
                        <p className="mt-0.5 text-meta text-content-muted">{impact.summary}</p>
                        {impact.riskNote ? <p className="text-2xs text-content-subtle">{impact.riskNote}</p> : null}
                      </div>
                      {row.status === "draft" || row.status === "submitted" || row.status === "assessing" ? (
                        <Button size="xs" variant="ghost" loading={action.busy === `remove-${impact.id}`} onClick={() => void removeImpact(impact.id)}>
                          Remove
                        </Button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}

              {row.status === "draft" || row.status === "submitted" || row.status === "assessing" ? (
                <form onSubmit={(e) => void addImpact(e)} className="mt-3 grid gap-2 rounded-lg border border-border-subtle p-3 sm:grid-cols-6">
                  <Field label="Discipline" className="sm:col-span-2">
                    <Select value={impactDiscipline} onChange={(e) => setImpactDiscipline(e.target.value)}>
                      {DESIGN_DISCIPLINES.map((d) => (
                        <option key={d} value={d}>
                          {labelize(d)}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Cost">
                    <Input type="number" value={impactCost} onChange={(e) => setImpactCost(e.target.value)} />
                  </Field>
                  <Field label="Currency">
                    <Input value={impactCurrency} onChange={(e) => setImpactCurrency(e.target.value)} maxLength={3} />
                  </Field>
                  <Field label="Days">
                    <Input type="number" value={impactDays} onChange={(e) => setImpactDays(e.target.value)} />
                  </Field>
                  <Field label="Rework hours">
                    <Input type="number" value={impactHours} onChange={(e) => setImpactHours(e.target.value)} />
                  </Field>
                  <Field label="What the change does to this discipline" className="sm:col-span-5">
                    <Input value={impactSummary} onChange={(e) => setImpactSummary(e.target.value)} />
                  </Field>
                  <div className="flex items-end">
                    <Button type="submit" size="sm" loading={action.busy === "impact"} disabled={!impactSummary.trim()}>
                      Assess
                    </Button>
                  </div>
                </form>
              ) : null}
            </div>

            <div className="flex flex-wrap items-end gap-2 rounded-lg border border-border-subtle p-3">
              {row.status === "draft" ? (
                <>
                  <Button size="sm" loading={action.busy === "submit"} onClick={() => void submit()}>
                    Submit for authorisation
                  </Button>
                  <Button size="sm" variant="ghost" loading={action.busy === "withdraw"} onClick={() => void withdraw()}>
                    Withdraw
                  </Button>
                </>
              ) : null}
              {row.status === "submitted" || row.status === "assessing" ? (
                <>
                  <Field label="Approving at">
                    <Select value={approveLevel || row.requiredAuthorisation} onChange={(e) => setApproveLevel(e.target.value)}>
                      {DCN_AUTHORISATION_LEVELS.map((l) => (
                        <option key={l} value={l}>
                          {labelize(l)}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Button size="sm" loading={action.busy === "approve"} onClick={() => void approve()}>
                    Approve
                  </Button>
                  <Button size="sm" variant="ghost" loading={action.busy === "reject"} onClick={() => void reject()}>
                    Reject
                  </Button>
                  <Button size="sm" variant="ghost" loading={action.busy === "withdraw"} onClick={() => void withdraw()}>
                    Withdraw
                  </Button>
                </>
              ) : null}
              {row.status === "approved" ? (
                <>
                  <Button size="sm" loading={action.busy === "implement"} onClick={() => void implement(row.entitlement.raisesChangeEvent)}>
                    {row.entitlement.raisesChangeEvent ? "Implement and raise a change event" : "Implement (no change event)"}
                  </Button>
                  {row.entitlement.raisesChangeEvent ? (
                    <Button size="sm" variant="ghost" onClick={() => void implement(false)}>
                      Implement without a change event
                    </Button>
                  ) : null}
                </>
              ) : null}
              {row.rejectionReason ? <p className="text-meta text-danger-fg">Rejected: {row.rejectionReason}</p> : null}
              {row.withdrawnReason ? <p className="text-meta text-content-muted">Withdrawn: {row.withdrawnReason}</p> : null}
            </div>
          </>
        ) : null}
      </div>
    </Drawer>
  );
}
