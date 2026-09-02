/**
 * REWORK AND THE COST OF QUALITY (#1098–1100).
 *
 * Rework as one number is a rounding error nobody acts on. Rework split by
 * CAUSE is a management decision — late information is a client problem,
 * workmanship is a subcontract problem, design error is a professional
 * indemnity problem — and split by WHERE IT WAS CAUGHT it becomes the cost of
 * quality: the same defect found at inspection and found after handover is the
 * same mistake at ten times the price.
 *
 * Two honesty rules are visible on this screen rather than buried in the API:
 * money is bucketed by currency and never summed across them, and prevention
 * and appraisal are COUNTED rather than costed, because the platform does not
 * hold the inspection hours and a £0 would make the ratio flattering and false.
 */
import { useMemo, useState } from "react";
import {
  Badge,
  Button,
  DataTable,
  Field,
  Input,
  Modal,
  Select,
  Textarea,
  type DataColumns,
} from "../../ui";
import { IconPlus } from "../../ui/icons";
import { api } from "../../lib/api";
import {
  CountTile,
  LoadError,
  NothingHere,
  ReasonList,
  RefusalNotice,
  isoDate,
  labelize,
  money,
  num,
  plural,
  useAction,
  type Resource,
} from "./qualityShared";
import type { CostOfQuality, FirstTimeRight, Paged, ReworkItem, ReworkSummary } from "./types";

const CAUSES = [
  "design_error",
  "design_change",
  "late_information",
  "workmanship",
  "material_defect",
  "supervision",
  "coordination",
  "damage_by_others",
  "site_conditions",
  "client_change",
  "other",
];

const PHASES = [
  "during_works",
  "at_inspection",
  "at_commissioning",
  "at_handover",
  "post_handover",
];

export default function ReworkTab({
  rework,
  summary,
  costOfQuality,
  firstTimeRight,
  projectId,
  onMutated,
}: {
  rework: Resource<Paged<ReworkItem>>;
  summary: Resource<ReworkSummary>;
  costOfQuality: Resource<CostOfQuality>;
  firstTimeRight: Resource<FirstTimeRight>;
  projectId: string;
  onMutated: () => void;
}) {
  const [createOpen, setCreateOpen] = useState(false);
  const rows = rework.data?.items ?? [];
  const s = summary.data;
  const coq = costOfQuality.data;
  const ftr = firstTimeRight.data;

  const columns = useMemo<DataColumns<ReworkItem>>(
    () => [
      { id: "reference", header: "Ref", accessor: "reference", type: "text", sticky: "start", width: 110 },
      { id: "title", header: "What had to be done again", accessor: "title", type: "text", width: 280 },
      {
        id: "cause",
        header: "Cause",
        accessor: "causeCategory",
        type: "text",
        width: 170,
        cell: ({ row }) => (
          <Badge tone="neutral" size="xs" variant="outline">
            {labelize(row.causeCategory)}
          </Badge>
        ),
      },
      {
        id: "phase",
        header: "Caught",
        accessor: "discoveryPhase",
        type: "text",
        width: 160,
        cell: ({ row }) => (
          <Badge
            tone={row.discoveryPhase === "post_handover" ? "danger" : "neutral"}
            size="xs"
            variant={row.discoveryPhase === "post_handover" ? "solid" : "outline"}
          >
            {labelize(row.discoveryPhase)}
          </Badge>
        ),
      },
      { id: "trade", header: "Trade", accessor: (r) => r.trade ?? "", type: "text", width: 140 },
      {
        id: "cost",
        header: "Cost",
        accessor: (r) => r.totalCost ?? 0,
        type: "number",
        width: 150,
        align: "right",
        cell: ({ row }) =>
          row.totalCost === null ? (
            <span className="text-2xs italic text-content-subtle">unmeasured</span>
          ) : (
            <span className="text-2xs tabular-nums">
              {money(row.totalCost, row.currency)}
              <span className="ml-1 text-content-subtle">{labelize(row.costBasis)}</span>
            </span>
          ),
      },
      {
        id: "status",
        header: "Status",
        accessor: "status",
        type: "text",
        width: 130,
        cell: ({ row }) => (
          <Badge
            tone={
              row.status === "verified"
                ? "success"
                : row.status === "cancelled"
                  ? "neutral"
                  : "warning"
            }
            size="xs"
            dot
          >
            {labelize(row.status)}
          </Badge>
        ),
      },
      {
        id: "discovered",
        header: "Discovered",
        accessor: (r) => r.discoveredAt ?? "",
        type: "text",
        width: 120,
        cell: ({ row }) => <span className="text-2xs tabular-nums">{isoDate(row.discoveredAt)}</span>,
      },
    ],
    [],
  );

  return (
    <div className="space-y-4">
      {summary.error ? (
        <LoadError message={summary.error} onRetry={summary.reload} />
      ) : (
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
          <CountTile label="Rework items" value={s?.total ?? 0} />
          <CountTile label="Open" value={s?.open ?? 0} tone="warning" emphasis />
          <CountTile
            label="Carrying no cost"
            value={s?.uncostedItems ?? 0}
            tone="warning"
            emphasis
            hint="Counted, not costed — the money is unmeasured, not zero."
          />
          <CountTile label="Preventable" value={s?.preventable ?? 0} />
          <CountTile label="Backcharged" value={s?.backcharged ?? 0} />
        </div>
      )}

      {s && s.totals.length > 0 ? (
        <div className="rounded-md border border-border-subtle p-2.5">
          <div className="text-label uppercase tracking-wide text-content-subtle">
            Recorded rework cost
          </div>
          <div className="mt-1 flex flex-wrap gap-3">
            {s.totals.map((t) => (
              <div key={t.currency}>
                <div className="text-lg font-semibold tabular-nums text-content">
                  {money(t.amount, t.currency)}
                </div>
                <div className="text-2xs text-content-subtle">
                  {t.recordCount} {plural(t.recordCount, "item")} in {t.currency}
                </div>
              </div>
            ))}
          </div>
          <ReasonList reasons={s.reasons} className="mt-1" />
        </div>
      ) : null}

      {/* ---------------- cost of quality ---------------- */}
      {costOfQuality.error ? (
        <LoadError message={costOfQuality.error} onRetry={costOfQuality.reload} />
      ) : coq ? (
        <div className="rounded-md border border-border p-3">
          <h3 className="text-sm font-semibold text-content">Cost of quality</h3>
          <p className="mt-0.5 text-2xs text-content-subtle">
            Prevention and appraisal are what a quality system costs; internal and external failure
            are what not having one costs. The ratio between the last two is the number a board
            understands.
          </p>
          <div className="mt-2 grid gap-2 lg:grid-cols-4">
            {coq.buckets.map((b) => (
              <div key={b.bucket} className="rounded-md border border-border-subtle p-2.5">
                <div className="text-label uppercase tracking-wide text-content-subtle">
                  {b.label}
                </div>
                {b.money.length === 0 ? (
                  <div className="mt-1 text-sm">
                    <span className="font-semibold tabular-nums text-content">
                      {b.activityCount || b.recordCount}
                    </span>{" "}
                    <span className="text-2xs text-content-subtle">
                      {b.bucket === "prevention" || b.bucket === "appraisal" ? "activities" : "records"}
                    </span>
                    <div className="text-2xs italic text-content-subtle">no money recorded</div>
                  </div>
                ) : (
                  <div className="mt-1 space-y-0.5">
                    {b.money.map((m) => (
                      <div key={m.currency} className="text-sm font-semibold tabular-nums text-content">
                        {money(m.amount, m.currency)}
                      </div>
                    ))}
                    <div className="text-2xs text-content-subtle">
                      {b.costedRecordCount} of {b.recordCount} {plural(b.recordCount, "record")} costed
                    </div>
                  </div>
                )}
                <ReasonList reasons={b.reasons} className="mt-1" />
              </div>
            ))}
          </div>
          {coq.failureByCurrency.length > 0 ? (
            <ul className="mt-2 space-y-0.5 text-meta">
              {coq.failureByCurrency.map((f) => (
                <li key={f.currency}>
                  <span className="font-medium text-content">{f.currency}</span>{" "}
                  <span className="text-content-muted">
                    internal {money(f.internal, f.currency)}, external{" "}
                    {money(f.external, f.currency)}
                    {f.externalShare !== null
                      ? ` — ${num(f.externalShare, 1)}% of failure cost reached the owner`
                      : ""}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
          <ReasonList reasons={coq.reasons} className="mt-1" />
        </div>
      ) : null}

      {/* ---------------- first time right ---------------- */}
      {firstTimeRight.error ? (
        <LoadError message={firstTimeRight.error} onRetry={firstTimeRight.reload} />
      ) : ftr ? (
        <div className="rounded-md border border-border p-3">
          <h3 className="text-sm font-semibold text-content">First-time right, by trade</h3>
          <p className="mt-0.5 text-2xs text-content-subtle">
            Computed from the record: a checklist with any failed item is not first-time right
            whatever its headline result, because something had to be redone.
          </p>
          <div className="mt-1 text-meta">
            Overall:{" "}
            {ftr.overall.rate === null ? (
              <span className="italic text-content-subtle">not available</span>
            ) : (
              <span className="font-semibold tabular-nums text-content">
                {num(ftr.overall.rate, 1)}%
              </span>
            )}{" "}
            <span className="text-content-subtle">
              ({ftr.overall.right} of {ftr.overall.judged} judged)
            </span>
          </div>
          <ReasonList reasons={ftr.overall.reasons} className="mt-1" />
          {ftr.rows.length > 0 ? (
            <ul className="mt-2 space-y-1">
              {ftr.rows.map((r) => (
                <li key={r.key} className="text-meta">
                  <div className="flex items-center gap-2">
                    <span className="w-48 shrink-0 truncate font-medium text-content">{r.label}</span>
                    <div className="h-2 flex-1 overflow-hidden rounded-full bg-surface-sunken">
                      <div
                        className="h-full rounded-full bg-accent"
                        style={{ width: `${Math.max(0, Math.min(100, r.rate ?? 0))}%` }}
                      />
                    </div>
                    <span className="w-24 shrink-0 text-right tabular-nums text-content-muted">
                      {r.rate === null ? "—" : `${num(r.rate, 1)}%`} ({r.judged})
                    </span>
                  </div>
                  <ReasonList reasons={r.reasons} />
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-meta text-content-muted">
          {rework.data
            ? `${rework.data.total} ${plural(rework.data.total, "rework item")}`
            : "Loading the register…"}
        </p>
        <Button size="sm" icon={IconPlus} onClick={() => setCreateOpen(true)}>
          Record rework
        </Button>
      </div>

      {rework.error ? (
        <LoadError message={rework.error} onRetry={rework.reload} />
      ) : rows.length === 0 ? (
        <NothingHere
          title="No rework has been recorded"
          reason="Rework that is not recorded is rework that is paid for twice and learned from never. Every NCR disposition of rework or repair should leave a row here."
          action={
            <Button size="sm" icon={IconPlus} onClick={() => setCreateOpen(true)}>
              Record the first one
            </Button>
          }
        />
      ) : (
        <DataTable<ReworkItem>
          tableId="quality-rework"
          data={rows}
          columns={columns}
          getRowId={(row) => row.id}
          height={460}
          stickyHeader
          zebra
          filterRow
          exportFileName="rework-register"
          searchPlaceholder="Search rework"
          aria-label="Rework register"
          rowTone={(row) => (row.discoveryPhase === "post_handover" ? "danger" : undefined)}
        />
      )}

      {s && s.byCause.length > 0 ? (
        <div className="grid gap-2 lg:grid-cols-2">
          <GroupPanel title="By cause" groups={s.byCause} />
          <GroupPanel title="By trade" groups={s.byTrade} />
        </div>
      ) : null}

      <CreateRework
        open={createOpen}
        projectId={projectId}
        onClose={() => setCreateOpen(false)}
        onCreated={() => {
          setCreateOpen(false);
          onMutated();
        }}
      />
    </div>
  );
}

function GroupPanel({
  title,
  groups,
}: {
  title: string;
  groups: ReworkSummary["byCause"];
}) {
  return (
    <div className="rounded-md border border-border-subtle p-2.5">
      <div className="text-label uppercase tracking-wide text-content-subtle">{title}</div>
      <ul className="mt-1 space-y-1">
        {groups.map((g) => (
          <li key={g.key} className="text-meta">
            <span className="font-medium text-content">{labelize(g.key)}</span>{" "}
            <span className="text-content-muted">
              {g.items} {plural(g.items, "item")}
              {g.totals.length > 0
                ? ` · ${g.totals.map((t) => money(t.amount, t.currency)).join(" + ")}`
                : ""}
              {g.labourHours > 0 ? ` · ${num(g.labourHours, 0)} labour hours` : ""}
            </span>
            <ReasonList reasons={g.reasons} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function CreateRework({
  open,
  onClose,
  projectId,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  projectId: string;
  onCreated: () => void;
}) {
  const { busy, refusal, clear, run } = useAction();
  const [title, setTitle] = useState("");
  const [cause, setCause] = useState("workmanship");
  const [phase, setPhase] = useState("at_inspection");
  const [trade, setTrade] = useState("");
  const [labour, setLabour] = useState("");
  const [material, setMaterial] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [basis, setBasis] = useState("estimated");
  const [description, setDescription] = useState("");

  const numberOrNull = (v: string) => {
    if (v.trim() === "") return null;
    const parsed = Number(v);
    return Number.isFinite(parsed) ? parsed : null;
  };

  async function create() {
    const done = await run("create", () =>
      api.post(`/api/v1/projects/${projectId}/rework-items`, {
        title: title.trim(),
        description: description.trim() === "" ? null : description.trim(),
        causeCategory: cause,
        discoveryPhase: phase,
        trade: trade.trim() === "" ? null : trade.trim(),
        labourCost: numberOrNull(labour),
        materialCost: numberOrNull(material),
        currency,
        costBasis: basis,
      }),
    );
    if (done) {
      setTitle("");
      setTrade("");
      setLabour("");
      setMaterial("");
      setDescription("");
      onCreated();
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Record rework"
      description="The cause and the phase are the point: they decide who pays and how much it cost to find out. Leave a cost blank rather than guessing — an unmeasured cost is reported as unmeasured, never as zero."
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={busy === "create"}
            disabled={title.trim() === ""}
            onClick={create}
          >
            Record it
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <RefusalNotice refusal={refusal} onDismiss={clear} />
        <Field label="What had to be done again" required>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
        </Field>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Cause">
            <Select value={cause} onChange={(e) => setCause(e.target.value)}>
              {CAUSES.map((c) => (
                <option key={c} value={c}>
                  {labelize(c)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Caught at">
            <Select value={phase} onChange={(e) => setPhase(e.target.value)}>
              {PHASES.map((p) => (
                <option key={p} value={p}>
                  {labelize(p)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Trade">
            <Input value={trade} onChange={(e) => setTrade(e.target.value)} />
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-4">
          <Field label="Labour cost">
            <Input type="number" value={labour} onChange={(e) => setLabour(e.target.value)} />
          </Field>
          <Field label="Material cost">
            <Input type="number" value={material} onChange={(e) => setMaterial(e.target.value)} />
          </Field>
          <Field label="Currency">
            <Input value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} maxLength={3} />
          </Field>
          <Field label="Basis">
            <Select value={basis} onChange={(e) => setBasis(e.target.value)}>
              <option value="estimated">Estimated</option>
              <option value="quoted">Quoted</option>
              <option value="actual">Actual</option>
            </Select>
          </Field>
        </div>
        <Field label="What happened">
          <Textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}
