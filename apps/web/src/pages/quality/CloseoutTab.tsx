/**
 * CLOSEOUT — the year after handover.
 *
 * Five registers that only start to matter on the day the contractor drives
 * off site, which is exactly why they are usually kept in a spreadsheet and
 * lost:
 *
 *   Defects liability   the clock that starts at handover and ends on a date
 *                       somebody has to be told about. The deadline is an
 *                       Obligation in the assurance register, not a reminder
 *                       this screen invents.
 *   Guarantees          what the plant was promised to do, what it actually
 *                       measured, and what the shortfall costs. An UNMEASURED
 *                       guarantee is drawn as unmeasured — never as met.
 *   Training            the part of handover that is not paper.
 *   Spares              what the owner is contractually owed and has not been
 *                       given.
 *   Post-occupancy      whether the design intent survived, measured in use
 *                       rather than asserted at practical completion.
 *
 * Two honesty rules are visible rather than buried: money is bucketed by
 * currency and never summed across them, and an energy variance with only one
 * of its two numbers reports as unknown rather than as zero.
 */
import { useMemo, useState } from "react";
import {
  Badge,
  Button,
  DataTable,
  Field,
  Input,
  Modal,
  SegmentedControl,
  Select,
  Textarea,
  type DataColumns,
} from "../../ui";
import { IconPlus } from "../../ui/icons";
import { api } from "../../lib/api";
import {
  CountTile,
  EM_DASH,
  FigureText,
  LoadError,
  NothingHere,
  ReasonList,
  RefusalNotice,
  isoDate,
  labelize,
  money,
  nameOf,
  num,
  plural,
  useAction,
  useResource,
  type Resource,
} from "./qualityShared";
import type {
  CloseoutSummary,
  Dlp,
  DlpDetail,
  Paged,
  PerformanceGuarantee,
  Poe,
  SparePart,
  TrainingRecord,
} from "./types";

export type CloseoutSection = "dlp" | "guarantees" | "training" | "spares" | "poe";

const GUARANTEE_OPERATORS = ["at_least", "at_most", "equals", "between"];
const TRAINING_KINDS = [
  "classroom",
  "hands_on",
  "handover_walkthrough",
  "video",
  "refresher",
  "vendor_delivered",
];
const SPARE_CATEGORIES = [
  "commissioning_spare",
  "operational_spare",
  "consumable",
  "special_tool",
  "strategic_spare",
  "test_equipment",
];
const POE_KINDS = [
  "soft_landings_review",
  "occupant_survey",
  "energy_review",
  "defects_review",
  "seasonal_review",
  "performance_review",
];
const DEFECT_SEVERITIES = ["critical", "major", "minor", "observation"];

const DLP_TONE: Record<string, "neutral" | "info" | "warning" | "success" | "danger"> = {
  not_started: "neutral",
  active: "info",
  expiring: "warning",
  expired: "danger",
  extended: "warning",
  closed: "success",
};

const GUARANTEE_TONE: Record<string, "neutral" | "info" | "warning" | "success" | "danger"> = {
  declared: "neutral",
  under_test: "info",
  met: "success",
  not_met: "danger",
  waived: "warning",
  superseded: "neutral",
};

const numberOrNull = (value: string): number | null => {
  if (value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

export default function CloseoutTab({
  section,
  onSection,
  projectId,
  version,
  users,
  onMutated,
}: {
  section: CloseoutSection;
  onSection: (section: CloseoutSection) => void;
  projectId: string;
  version: number;
  users: Map<string, string>;
  onMutated: () => void;
}) {
  const base = `/api/v1/projects/${projectId}`;
  const summary = useResource<CloseoutSummary>(
    (signal) => api.get<CloseoutSummary>(`${base}/closeout-summary`, { signal }),
    [base, version],
  );
  const s = summary.data;

  return (
    <div className="space-y-4">
      {summary.error ? (
        <LoadError message={summary.error} onRetry={summary.reload} />
      ) : (
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
          <CountTile
            label="Liability periods"
            value={s?.dlps.total ?? 0}
            hint={
              s && s.dlps.expiringWithin60Days.length > 0
                ? `${s.dlps.expiringWithin60Days.length} ending within 60 days`
                : "The clock the retention hangs on."
            }
          />
          <CountTile
            label="Open defects"
            value={s?.dlps.openDefects ?? 0}
            tone="warning"
            emphasis
            hint="Reported in the period and not yet made good and verified."
          />
          <CountTile
            label="Guarantees not met"
            value={s?.guarantees.notMet ?? 0}
            tone="danger"
            emphasis
            hint={
              s
                ? `${s.guarantees.unmeasured} unmeasured — unmeasured is not met`
                : undefined
            }
          />
          <CountTile
            label="Training outstanding"
            value={s?.training.outstanding ?? 0}
            tone="warning"
            emphasis
            hint={s ? `${s.training.attendees} people trained so far` : undefined}
          />
          <CountTile
            label="Spares outstanding"
            value={s?.spares.outstanding ?? 0}
            tone="warning"
            emphasis
            hint={s ? `${s.spares.handedOver} of ${s.spares.total} handed over` : undefined}
          />
        </div>
      )}

      {s && s.dlps.handedOverPackagesWithoutAPeriod.length > 0 ? (
        <div className="rounded-md border border-warning-border bg-warning-subtle p-2.5">
          <div className="text-label uppercase tracking-wide text-content-subtle">
            Handed over with no liability period recorded
          </div>
          <p className="mt-1 text-2xs text-content-muted">
            {s.dlps.handedOverPackagesWithoutAPeriod
              .map((p) => `${p.reference}${p.handedOverAt ? ` (${isoDate(p.handedOverAt)})` : ""}`)
              .join(", ")}
            . The contract almost certainly gives the owner a period against these; without a row
            here nobody is told when it ends.
          </p>
        </div>
      ) : null}

      <SegmentedControl<CloseoutSection>
        value={section}
        onChange={onSection}
        aria-label="Closeout register"
        options={[
          { value: "dlp", label: "Defects liability" },
          { value: "guarantees", label: "Guarantees" },
          { value: "training", label: "Training" },
          { value: "spares", label: "Spares" },
          { value: "poe", label: "Post-occupancy" },
        ]}
      />

      {section === "dlp" ? (
        <DlpPanel projectId={projectId} version={version} users={users} onMutated={onMutated} />
      ) : section === "guarantees" ? (
        <GuaranteePanel
          projectId={projectId}
          version={version}
          summary={summary}
          users={users}
          onMutated={onMutated}
        />
      ) : section === "training" ? (
        <TrainingPanel projectId={projectId} version={version} onMutated={onMutated} />
      ) : section === "spares" ? (
        <SparesPanel projectId={projectId} version={version} onMutated={onMutated} />
      ) : (
        <PoePanel projectId={projectId} version={version} onMutated={onMutated} />
      )}
    </div>
  );
}

/* ================================================================== */
/* Defects liability                                                   */
/* ================================================================== */

function DlpPanel({
  projectId,
  version,
  users,
  onMutated,
}: {
  projectId: string;
  version: number;
  users: Map<string, string>;
  onMutated: () => void;
}) {
  const base = `/api/v1/projects/${projectId}`;
  const [createOpen, setCreateOpen] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const dlps = useResource<Paged<Dlp>>(
    (signal) => api.get<Paged<Dlp>>(`${base}/dlps?page=1&pageSize=200`, { signal }),
    [base, version],
  );
  const rows = dlps.data?.items ?? [];

  const columns = useMemo<DataColumns<Dlp>>(
    () => [
      {
        id: "reference",
        header: "Ref",
        accessor: "reference",
        type: "text",
        sticky: "start",
        width: 120,
        cell: ({ row }) => (
          <button
            type="button"
            className="font-mono text-2xs font-semibold text-accent underline-offset-2 hover:underline"
            onClick={() => setOpenId(row.id)}
          >
            {row.reference}
          </button>
        ),
      },
      { id: "name", header: "Scope", accessor: "name", type: "text", width: 240 },
      {
        id: "status",
        header: "Standing",
        accessor: (r) => r.standing.status,
        type: "text",
        width: 140,
        cell: ({ row }) => (
          <Badge
            tone={DLP_TONE[row.standing.status] ?? "neutral"}
            size="xs"
            dot
            variant={row.standing.status === "expired" ? "solid" : "subtle"}
          >
            {labelize(row.standing.status)}
          </Badge>
        ),
      },
      {
        id: "ends",
        header: "Ends",
        accessor: (r) => r.extendedToDate ?? r.endDate,
        type: "text",
        width: 150,
        cell: ({ row }) => (
          <span className="text-2xs tabular-nums">
            {isoDate(row.extendedToDate ?? row.endDate)}
            {row.standing.daysRemaining !== null ? (
              <span className="ml-1 text-content-subtle">
                {row.standing.daysRemaining < 0
                  ? `${Math.abs(row.standing.daysRemaining)}d ago`
                  : `in ${row.standing.daysRemaining}d`}
              </span>
            ) : null}
          </span>
        ),
      },
      {
        id: "defects",
        header: "Defects",
        accessor: (r) => r.openDefectCount,
        type: "number",
        width: 120,
        align: "right",
        cell: ({ row }) => (
          <span className="text-2xs tabular-nums">
            {row.openDefectCount} open / {row.defectCount}
          </span>
        ),
      },
      {
        id: "retention",
        header: "Retention",
        accessor: (r) => r.retentionAmount ?? 0,
        type: "number",
        width: 160,
        align: "right",
        cell: ({ row }) =>
          row.retentionAmount === null ? (
            <span className="text-2xs italic text-content-subtle">not recorded</span>
          ) : (
            <span className="text-2xs tabular-nums">
              {money(row.retentionAmount, row.currency)}
              {row.retentionReleaseDate ? (
                <span className="ml-1 text-content-subtle">
                  due {isoDate(row.retentionReleaseDate)}
                </span>
              ) : null}
            </span>
          ),
      },
    ],
    [],
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-meta text-content-muted">
          {dlps.data
            ? `${dlps.data.total} ${plural(dlps.data.total, "liability period")}`
            : "Loading the register…"}
        </p>
        <Button size="sm" icon={IconPlus} onClick={() => setCreateOpen(true)}>
          Record a period
        </Button>
      </div>

      {dlps.error ? (
        <LoadError message={dlps.error} onRetry={dlps.reload} />
      ) : rows.length === 0 ? (
        <NothingHere
          title="No defects liability period is being tracked"
          reason="A period that nobody is tracking ends silently, and with it the owner's right to have work made good. Record it at handover and the end date becomes an obligation somebody is told about."
          action={
            <Button size="sm" icon={IconPlus} onClick={() => setCreateOpen(true)}>
              Record the first one
            </Button>
          }
        />
      ) : (
        <DataTable<Dlp>
          tableId="quality-dlps"
          data={rows}
          columns={columns}
          getRowId={(row) => row.id}
          height={420}
          stickyHeader
          zebra
          filterRow
          exportFileName="defects-liability-periods"
          searchPlaceholder="Search periods"
          aria-label="Defects liability periods"
          rowTone={(row) =>
            row.standing.status === "expired"
              ? "danger"
              : row.standing.status === "expiring"
                ? "warning"
                : undefined
          }
        />
      )}

      <CreateDlp
        open={createOpen}
        projectId={projectId}
        onClose={() => setCreateOpen(false)}
        onCreated={() => {
          setCreateOpen(false);
          onMutated();
        }}
      />
      <DlpDetailModal
        id={openId}
        projectId={projectId}
        users={users}
        version={version}
        onClose={() => setOpenId(null)}
        onMutated={onMutated}
      />
    </div>
  );
}

function CreateDlp({
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
  const [name, setName] = useState("");
  const [startDate, setStartDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [months, setMonths] = useState("12");
  const [clause, setClause] = useState("");
  const [retention, setRetention] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [scope, setScope] = useState("");

  async function create() {
    const parsedMonths = Number(months);
    const done = await run("create", () =>
      api.post(`/api/v1/projects/${projectId}/dlps`, {
        name: name.trim(),
        scopeDescription: scope.trim() === "" ? null : scope.trim(),
        startDate,
        durationMonths: Number.isFinite(parsedMonths) ? Math.round(parsedMonths) : 12,
        contractClause: clause.trim() === "" ? null : clause.trim(),
        retentionAmount: numberOrNull(retention),
        currency,
      }),
    );
    if (done) {
      setName("");
      setScope("");
      setClause("");
      setRetention("");
      onCreated();
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Record a defects liability period"
      description="The end date becomes an obligation in the assurance register, so somebody is told before it runs out rather than after. Give the clause it comes from — the period is a contractual right, not a courtesy."
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={busy === "create"}
            disabled={name.trim() === "" || startDate === ""}
            onClick={create}
          >
            Record it
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <RefusalNotice refusal={refusal} onDismiss={clear} />
        <Field label="What the period covers" required>
          <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </Field>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Starts" required hint="Usually the date of practical completion.">
            <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
          </Field>
          <Field label="Months" hint="The end date is computed from this.">
            <Input type="number" value={months} onChange={(e) => setMonths(e.target.value)} />
          </Field>
          <Field label="Contract clause">
            <Input
              value={clause}
              onChange={(e) => setClause(e.target.value)}
              placeholder="e.g. 11.1"
            />
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label="Retention held"
            hint="Leave blank rather than guessing — an unrecorded amount reports as unrecorded."
          >
            <Input type="number" value={retention} onChange={(e) => setRetention(e.target.value)} />
          </Field>
          <Field label="Currency">
            <Input
              value={currency}
              onChange={(e) => setCurrency(e.target.value.toUpperCase().slice(0, 3))}
            />
          </Field>
        </div>
        <Field label="Scope">
          <Textarea rows={3} value={scope} onChange={(e) => setScope(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

function DlpDetailModal({
  id,
  projectId,
  users,
  version,
  onClose,
  onMutated,
}: {
  id: string | null;
  projectId: string;
  users: Map<string, string>;
  version: number;
  onClose: () => void;
  onMutated: () => void;
}) {
  const base = `/api/v1/projects/${projectId}`;
  const { busy, refusal, clear, run } = useAction();
  const [defectTitle, setDefectTitle] = useState("");
  const [severity, setSeverity] = useState("minor");
  const [reportedBy, setReportedBy] = useState("");
  const detail = useResource<DlpDetail>(
    (signal) => api.get<DlpDetail>(`${base}/dlps/${id}`, { signal }),
    [base, id, version],
    id !== null,
  );
  const row = detail.data;

  async function reportDefect() {
    const done = await run("defect", () =>
      api.post(`${base}/dlps/${id}/defects`, {
        title: defectTitle.trim(),
        severity,
        reportedByName: reportedBy.trim() === "" ? null : reportedBy.trim(),
      }),
    );
    if (done) {
      setDefectTitle("");
      setReportedBy("");
      detail.reload();
      onMutated();
    }
  }

  async function setDefectStatus(defectId: string, status: string) {
    const done = await run(`status-${defectId}`, () =>
      api.post(`${base}/dlp-defects/${defectId}/status`, { status }),
    );
    if (done) {
      detail.reload();
      onMutated();
    }
  }

  return (
    <Modal
      open={id !== null}
      onClose={onClose}
      title={row ? `${row.reference} — ${row.name}` : "Defects liability period"}
      size="lg"
    >
      {detail.error ? (
        <LoadError message={detail.error} onRetry={detail.reload} />
      ) : !row ? (
        <p className="text-meta text-content-muted">Loading…</p>
      ) : (
        <div className="space-y-3">
          <RefusalNotice refusal={refusal} onDismiss={clear} />
          <div className="rounded-md border border-border-subtle p-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={DLP_TONE[row.standing.status] ?? "neutral"} size="xs" dot>
                {labelize(row.standing.status)}
              </Badge>
              <span className="text-2xs text-content-muted">
                {isoDate(row.startDate)} → {isoDate(row.extendedToDate ?? row.endDate)}
                {row.extendedToDate ? " (extended)" : ""}
              </span>
            </div>
            <ReasonList reasons={row.standing.reasons} className="mt-1" />
            {row.extensionReason ? (
              <p className="mt-1 text-2xs text-content-muted">
                Extension: {row.extensionReason}
              </p>
            ) : null}
          </div>

          <div className="rounded-md border border-border-subtle p-2.5">
            <div className="text-label uppercase tracking-wide text-content-subtle">
              Report a defect
            </div>
            <div className="mt-2 grid gap-2 sm:grid-cols-4">
              <div className="sm:col-span-2">
                <Field label="What is wrong">
                  <Input
                    value={defectTitle}
                    onChange={(e) => setDefectTitle(e.target.value)}
                    placeholder="e.g. AHU-02 fan bearing noise"
                  />
                </Field>
              </div>
              <Field label="Severity">
                <Select value={severity} onChange={(e) => setSeverity(e.target.value)}>
                  {DEFECT_SEVERITIES.map((sv) => (
                    <option key={sv} value={sv}>
                      {labelize(sv)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Reported by">
                <Input
                  value={reportedBy}
                  onChange={(e) => setReportedBy(e.target.value)}
                  placeholder="Occupier, FM…"
                />
              </Field>
            </div>
            <div className="mt-2 flex justify-end">
              <Button
                size="sm"
                variant="secondary"
                loading={busy === "defect"}
                disabled={defectTitle.trim() === ""}
                onClick={reportDefect}
              >
                Report it
              </Button>
            </div>
          </div>

          {row.defects.length === 0 ? (
            <p className="text-2xs text-content-subtle">
              No defect has been reported in this period. That is a fact about the reporting, not
              yet a fact about the building.
            </p>
          ) : (
            <ul className="space-y-1.5">
              {row.defects.map((d) => (
                <li key={d.id} className="rounded-md border border-border-subtle p-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-2xs font-semibold text-content">
                      {d.reference}
                    </span>
                    <Badge
                      tone={d.severity === "critical" || d.severity === "major" ? "danger" : "neutral"}
                      size="xs"
                    >
                      {labelize(d.severity)}
                    </Badge>
                    <Badge
                      tone={
                        d.status === "verified"
                          ? "success"
                          : d.status === "disputed"
                            ? "warning"
                            : d.status === "rejected"
                              ? "neutral"
                              : "info"
                      }
                      size="xs"
                      dot
                    >
                      {labelize(d.status)}
                    </Badge>
                    <span className="text-2xs text-content">{d.title}</span>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-2xs text-content-subtle">
                    <span>reported {isoDate(d.reportedAt)}</span>
                    {d.reportedByName ? <span>by {d.reportedByName}</span> : null}
                    {d.verifiedBy ? <span>verified by {nameOf(users, d.verifiedBy)}</span> : null}
                    {d.status !== "verified" && d.status !== "rejected" ? (
                      <div className="ml-auto flex gap-1">
                        {d.status === "reported" ? (
                          <Button
                            size="xs"
                            variant="ghost"
                            loading={busy === `status-${d.id}`}
                            onClick={() => setDefectStatus(d.id, "accepted")}
                          >
                            Accept
                          </Button>
                        ) : null}
                        {d.status !== "rectified" ? (
                          <Button
                            size="xs"
                            variant="ghost"
                            loading={busy === `status-${d.id}`}
                            onClick={() => setDefectStatus(d.id, "rectified")}
                          >
                            Rectified
                          </Button>
                        ) : (
                          <Button
                            size="xs"
                            variant="secondary"
                            loading={busy === `status-${d.id}`}
                            onClick={() => setDefectStatus(d.id, "verified")}
                          >
                            Verify
                          </Button>
                        )}
                      </div>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Modal>
  );
}

/* ================================================================== */
/* Performance guarantees                                              */
/* ================================================================== */

function GuaranteePanel({
  projectId,
  version,
  summary,
  users,
  onMutated,
}: {
  projectId: string;
  version: number;
  summary: Resource<CloseoutSummary>;
  users: Map<string, string>;
  onMutated: () => void;
}) {
  const base = `/api/v1/projects/${projectId}`;
  const [createOpen, setCreateOpen] = useState(false);
  const [measuring, setMeasuring] = useState<PerformanceGuarantee | null>(null);
  const { busy, refusal, clear, run } = useAction();
  const guarantees = useResource<Paged<PerformanceGuarantee>>(
    (signal) =>
      api.get<Paged<PerformanceGuarantee>>(`${base}/performance-guarantees?page=1&pageSize=200`, {
        signal,
      }),
    [base, version],
  );
  const rows = guarantees.data?.items ?? [];
  const exposure = summary.data?.guarantees.exposure;

  async function verify(id: string) {
    const done = await run(`verify-${id}`, () =>
      api.post(`${base}/performance-guarantees/${id}/verify`, {}),
    );
    if (done) {
      guarantees.reload();
      onMutated();
    }
  }

  const columns = useMemo<DataColumns<PerformanceGuarantee>>(
    () => [
      { id: "reference", header: "Ref", accessor: "reference", type: "text", sticky: "start", width: 110 },
      { id: "parameter", header: "Parameter", accessor: "parameter", type: "text", width: 220 },
      {
        id: "guaranteed",
        header: "Guaranteed",
        accessor: (r) => r.guaranteedValue ?? 0,
        type: "text",
        width: 170,
        cell: ({ row }) => (
          <span className="text-2xs tabular-nums">
            {labelize(row.operator)}{" "}
            {row.operator === "between"
              ? `${num(row.guaranteedMin)} – ${num(row.guaranteedMax)}`
              : num(row.guaranteedValue)}{" "}
            {row.unit ?? ""}
          </span>
        ),
      },
      {
        id: "measured",
        header: "Measured",
        accessor: (r) => r.measuredValue ?? 0,
        type: "text",
        width: 150,
        cell: ({ row }) =>
          row.measuredValue === null ? (
            <span className="text-2xs italic text-content-subtle">unmeasured</span>
          ) : (
            <span className="text-2xs tabular-nums">
              {num(row.measuredValue)} {row.unit ?? ""}
            </span>
          ),
      },
      {
        id: "status",
        header: "Standing",
        accessor: "status",
        type: "text",
        width: 130,
        cell: ({ row }) => (
          <Badge
            tone={GUARANTEE_TONE[row.status] ?? "neutral"}
            size="xs"
            dot
            variant={row.status === "not_met" ? "solid" : "subtle"}
          >
            {labelize(row.status)}
          </Badge>
        ),
      },
      {
        id: "ld",
        header: "LD exposure",
        headerTooltip:
          "Computed from the shortfall and the contract rate, capped where the contract caps it. Never typed in.",
        accessor: (r) => r.ldAmount ?? 0,
        type: "number",
        width: 170,
        align: "right",
        cell: ({ row }) =>
          row.ldAmount === null ? (
            <span className="text-2xs italic text-content-subtle">
              {row.shortfall === null ? EM_DASH : "no rate"}
            </span>
          ) : (
            <span className="text-2xs tabular-nums">
              {money(row.ldAmount, row.currency)}
              {row.assessment?.ldCapped ? (
                <span className="ml-1 text-content-subtle">capped</span>
              ) : null}
            </span>
          ),
      },
      {
        id: "actions",
        header: "",
        accessor: () => "",
        type: "text",
        width: 160,
        cell: ({ row }) => (
          <div className="flex gap-1">
            {row.status !== "waived" ? (
              <Button size="xs" variant="ghost" onClick={() => setMeasuring(row)}>
                {row.measuredValue === null ? "Measure" : "Re-measure"}
              </Button>
            ) : null}
            {row.measuredValue !== null && row.verifiedAt === null ? (
              <Button
                size="xs"
                variant="secondary"
                loading={busy === `verify-${row.id}`}
                onClick={() => verify(row.id)}
              >
                Verify
              </Button>
            ) : null}
          </div>
        ),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [busy],
  );

  return (
    <div className="space-y-3">
      <RefusalNotice refusal={refusal} onDismiss={clear} />

      {exposure ? (
        <div className="rounded-md border border-border p-3">
          <h3 className="text-sm font-semibold text-content">Liquidated damages exposure</h3>
          <p className="mt-0.5 text-2xs text-content-subtle">
            One figure per currency. A shortfall with no contract rate is listed rather than priced,
            and an unmeasured guarantee is listed rather than assumed met — both would otherwise
            read as an exposure of nothing.
          </p>
          {exposure.byCurrency.length === 0 ? (
            <p className="mt-1 text-sm italic text-content-subtle">not available</p>
          ) : (
            <div className="mt-1 flex flex-wrap gap-4">
              {exposure.byCurrency.map((c) => (
                <div key={c.currency}>
                  <div className="text-lg font-semibold tabular-nums text-danger">
                    {money(c.amount, c.currency)}
                  </div>
                  <div className="text-2xs text-content-subtle">
                    {c.guarantees} {plural(c.guarantees, "guarantee")}
                    {c.capped > 0 ? ` · ${c.capped} at the cap` : ""}
                  </div>
                </div>
              ))}
            </div>
          )}
          {exposure.unpricedShortfalls.length > 0 ? (
            <p className="mt-1.5 text-2xs text-content-muted">
              Shortfalls with no rate:{" "}
              {exposure.unpricedShortfalls.map((u) => `${u.reference} (${u.parameter})`).join(", ")}
            </p>
          ) : null}
          {exposure.unmeasured.length > 0 ? (
            <p className="mt-1 text-2xs text-content-muted">
              Never measured:{" "}
              {exposure.unmeasured.map((u) => `${u.reference} (${u.parameter})`).join(", ")}
            </p>
          ) : null}
          <ReasonList reasons={exposure.reasons} className="mt-1" />
        </div>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-meta text-content-muted">
          {guarantees.data
            ? `${guarantees.data.total} ${plural(guarantees.data.total, "guarantee")}`
            : "Loading the register…"}
        </p>
        <Button size="sm" icon={IconPlus} onClick={() => setCreateOpen(true)}>
          Declare a guarantee
        </Button>
      </div>

      {guarantees.error ? (
        <LoadError message={guarantees.error} onRetry={guarantees.reload} />
      ) : rows.length === 0 ? (
        <NothingHere
          title="No performance guarantee is being tracked"
          reason="A guarantee that is not in a register is one nobody measures, and an unmeasured guarantee is met by default — which is exactly the outcome the clause was written to prevent."
          action={
            <Button size="sm" icon={IconPlus} onClick={() => setCreateOpen(true)}>
              Declare the first one
            </Button>
          }
        />
      ) : (
        <DataTable<PerformanceGuarantee>
          tableId="quality-guarantees"
          data={rows}
          columns={columns}
          getRowId={(row) => row.id}
          height={420}
          stickyHeader
          zebra
          filterRow
          exportFileName="performance-guarantees"
          searchPlaceholder="Search guarantees"
          aria-label="Performance guarantees"
          rowTone={(row) => (row.status === "not_met" ? "danger" : undefined)}
        />
      )}

      {rows.some((r) => r.verifiedBy) ? (
        <p className="text-2xs text-content-subtle">
          Verified readings are attributed:{" "}
          {rows
            .filter((r) => r.verifiedBy)
            .map((r) => `${r.reference} by ${nameOf(users, r.verifiedBy)}`)
            .join(", ")}
          . A verifier may not be the person who took the reading.
        </p>
      ) : null}

      <CreateGuarantee
        open={createOpen}
        projectId={projectId}
        onClose={() => setCreateOpen(false)}
        onCreated={() => {
          setCreateOpen(false);
          guarantees.reload();
          onMutated();
        }}
      />
      <MeasureGuarantee
        guarantee={measuring}
        projectId={projectId}
        onClose={() => setMeasuring(null)}
        onDone={() => {
          setMeasuring(null);
          guarantees.reload();
          onMutated();
        }}
      />
    </div>
  );
}

function CreateGuarantee({
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
  const [parameter, setParameter] = useState("");
  const [operator, setOperator] = useState("at_least");
  const [value, setValue] = useState("");
  const [min, setMin] = useState("");
  const [max, setMax] = useState("");
  const [unit, setUnit] = useState("");
  const [rate, setRate] = useState("");
  const [rateUnit, setRateUnit] = useState("");
  const [cap, setCap] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [clause, setClause] = useState("");

  async function create() {
    const done = await run("create", () =>
      api.post(`/api/v1/projects/${projectId}/performance-guarantees`, {
        title: title.trim(),
        parameter: parameter.trim(),
        operator,
        guaranteedValue: operator === "between" ? null : numberOrNull(value),
        guaranteedMin: operator === "between" ? numberOrNull(min) : null,
        guaranteedMax: operator === "between" ? numberOrNull(max) : null,
        unit: unit.trim() === "" ? null : unit.trim(),
        ldRatePerUnit: numberOrNull(rate),
        ldRateUnit: rateUnit.trim() === "" ? null : rateUnit.trim(),
        ldCapAmount: numberOrNull(cap),
        currency,
        contractClause: clause.trim() === "" ? null : clause.trim(),
      }),
    );
    if (done) {
      setTitle("");
      setParameter("");
      setValue("");
      setMin("");
      setMax("");
      onCreated();
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Declare a performance guarantee"
      description="The rate and the cap are what turn a shortfall into a number. Without them the platform records the shortfall and says the exposure is unpriced — it does not invent a rate."
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={busy === "create"}
            disabled={title.trim() === "" || parameter.trim() === ""}
            onClick={create}
          >
            Declare it
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <RefusalNotice refusal={refusal} onDismiss={clear} />
        <Field label="Title" required>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Parameter" required hint="e.g. chiller COP, air leakage rate">
            <Input value={parameter} onChange={(e) => setParameter(e.target.value)} />
          </Field>
          <Field label="Comparison">
            <Select value={operator} onChange={(e) => setOperator(e.target.value)}>
              {GUARANTEE_OPERATORS.map((op) => (
                <option key={op} value={op}>
                  {labelize(op)}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        {operator === "between" ? (
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Minimum">
              <Input type="number" value={min} onChange={(e) => setMin(e.target.value)} />
            </Field>
            <Field label="Maximum">
              <Input type="number" value={max} onChange={(e) => setMax(e.target.value)} />
            </Field>
            <Field label="Unit">
              <Input value={unit} onChange={(e) => setUnit(e.target.value)} />
            </Field>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Guaranteed value">
              <Input type="number" value={value} onChange={(e) => setValue(e.target.value)} />
            </Field>
            <Field label="Unit">
              <Input value={unit} onChange={(e) => setUnit(e.target.value)} />
            </Field>
          </div>
        )}
        <div className="grid gap-3 sm:grid-cols-4">
          <Field label="LD rate per unit">
            <Input type="number" value={rate} onChange={(e) => setRate(e.target.value)} />
          </Field>
          <Field label="Rate unit" hint="e.g. per kW shortfall">
            <Input value={rateUnit} onChange={(e) => setRateUnit(e.target.value)} />
          </Field>
          <Field label="Cap">
            <Input type="number" value={cap} onChange={(e) => setCap(e.target.value)} />
          </Field>
          <Field label="Currency">
            <Input
              value={currency}
              onChange={(e) => setCurrency(e.target.value.toUpperCase().slice(0, 3))}
            />
          </Field>
        </div>
        <Field label="Contract clause">
          <Input value={clause} onChange={(e) => setClause(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

function MeasureGuarantee({
  guarantee,
  projectId,
  onClose,
  onDone,
}: {
  guarantee: PerformanceGuarantee | null;
  projectId: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const { busy, refusal, clear, run } = useAction();
  const [value, setValue] = useState("");
  const [note, setNote] = useState("");

  async function measure() {
    const parsed = numberOrNull(value);
    if (parsed === null || !guarantee) return;
    const done = await run("measure", () =>
      api.post(`/api/v1/projects/${projectId}/performance-guarantees/${guarantee.id}/measure`, {
        measuredValue: parsed,
        note: note.trim() === "" ? null : note.trim(),
      }),
    );
    if (done) {
      setValue("");
      setNote("");
      onDone();
    }
  }

  return (
    <Modal
      open={guarantee !== null}
      onClose={onClose}
      title={guarantee ? `Measure ${guarantee.reference}` : "Measure"}
      description="Record what the plant actually did. Whether it met the guarantee, and what the shortfall costs, is computed from the contract — not chosen here."
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={busy === "measure"}
            disabled={numberOrNull(value) === null}
            onClick={measure}
          >
            Record the reading
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <RefusalNotice refusal={refusal} onDismiss={clear} />
        {guarantee ? (
          <p className="text-2xs text-content-muted">
            Guaranteed: {labelize(guarantee.operator)}{" "}
            {guarantee.operator === "between"
              ? `${num(guarantee.guaranteedMin)} – ${num(guarantee.guaranteedMax)}`
              : num(guarantee.guaranteedValue)}{" "}
            {guarantee.unit ?? ""}
          </p>
        ) : null}
        <Field label="Measured value" required>
          <Input type="number" value={value} onChange={(e) => setValue(e.target.value)} autoFocus />
        </Field>
        <Field label="Note">
          <Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

/* ================================================================== */
/* Training                                                            */
/* ================================================================== */

function TrainingPanel({
  projectId,
  version,
  onMutated,
}: {
  projectId: string;
  version: number;
  onMutated: () => void;
}) {
  const base = `/api/v1/projects/${projectId}`;
  const [createOpen, setCreateOpen] = useState(false);
  const [delivering, setDelivering] = useState<TrainingRecord | null>(null);
  const { busy, refusal, clear, run } = useAction();
  const training = useResource<Paged<TrainingRecord>>(
    (signal) =>
      api.get<Paged<TrainingRecord>>(`${base}/training-records?page=1&pageSize=200`, { signal }),
    [base, version],
  );
  const rows = training.data?.items ?? [];

  async function accept(id: string) {
    const done = await run(`accept-${id}`, () =>
      api.post(`${base}/training-records/${id}/accept`, {}),
    );
    if (done) {
      training.reload();
      onMutated();
    }
  }

  const columns = useMemo<DataColumns<TrainingRecord>>(
    () => [
      { id: "reference", header: "Ref", accessor: "reference", type: "text", sticky: "start", width: 110 },
      { id: "title", header: "Session", accessor: "title", type: "text", width: 250 },
      {
        id: "kind",
        header: "Kind",
        accessor: "trainingKind",
        type: "text",
        width: 170,
        cell: ({ row }) => (
          <Badge tone="neutral" size="xs" variant="outline">
            {labelize(row.trainingKind)}
          </Badge>
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
              row.status === "accepted"
                ? "success"
                : row.status === "delivered"
                  ? "info"
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
        id: "attendees",
        header: "Attendees",
        accessor: (r) => r.attendeeCount,
        type: "number",
        width: 130,
        align: "right",
        cell: ({ row }) => (
          <span className="text-2xs tabular-nums">
            {row.attendeeCount}
            {row.competencyAssessed ? (
              <span className="ml-1 text-success">assessed</span>
            ) : null}
          </span>
        ),
      },
      {
        id: "when",
        header: "When",
        accessor: (r) => r.deliveredAt ?? r.scheduledFor ?? "",
        type: "text",
        width: 150,
        cell: ({ row }) => (
          <span className="text-2xs tabular-nums">
            {row.deliveredAt
              ? isoDate(row.deliveredAt)
              : row.scheduledFor
                ? `planned ${isoDate(row.scheduledFor)}`
                : EM_DASH}
          </span>
        ),
      },
      {
        id: "actions",
        header: "",
        accessor: () => "",
        type: "text",
        width: 150,
        cell: ({ row }) => (
          <div className="flex gap-1">
            {row.status === "planned" || row.status === "scheduled" ? (
              <Button size="xs" variant="ghost" onClick={() => setDelivering(row)}>
                Record delivery
              </Button>
            ) : null}
            {row.status === "delivered" ? (
              <Button
                size="xs"
                variant="secondary"
                loading={busy === `accept-${row.id}`}
                onClick={() => accept(row.id)}
              >
                Accept
              </Button>
            ) : null}
          </div>
        ),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [busy],
  );

  return (
    <div className="space-y-3">
      <RefusalNotice refusal={refusal} onDismiss={clear} />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-meta text-content-muted">
          {training.data
            ? `${training.data.total} ${plural(training.data.total, "training session")}`
            : "Loading the register…"}
        </p>
        <Button size="sm" icon={IconPlus} onClick={() => setCreateOpen(true)}>
          Plan a session
        </Button>
      </div>

      {training.error ? (
        <LoadError message={training.error} onRetry={training.reload} />
      ) : rows.length === 0 ? (
        <NothingHere
          title="No operator training is recorded"
          reason="A turnover package that hands over manuals but no trained operators has handed over paper. The register names who was trained, on what, and who accepted it."
          action={
            <Button size="sm" icon={IconPlus} onClick={() => setCreateOpen(true)}>
              Plan the first session
            </Button>
          }
        />
      ) : (
        <DataTable<TrainingRecord>
          tableId="quality-training"
          data={rows}
          columns={columns}
          getRowId={(row) => row.id}
          height={420}
          stickyHeader
          zebra
          filterRow
          exportFileName="operator-training"
          searchPlaceholder="Search training"
          aria-label="Operator training records"
        />
      )}

      <CreateTraining
        open={createOpen}
        projectId={projectId}
        onClose={() => setCreateOpen(false)}
        onCreated={() => {
          setCreateOpen(false);
          training.reload();
          onMutated();
        }}
      />
      <DeliverTraining
        record={delivering}
        projectId={projectId}
        onClose={() => setDelivering(null)}
        onDone={() => {
          setDelivering(null);
          training.reload();
          onMutated();
        }}
      />
    </div>
  );
}

function CreateTraining({
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
  const [kind, setKind] = useState("hands_on");
  const [trainer, setTrainer] = useState("");
  const [organisation, setOrganisation] = useState("");
  const [scheduledFor, setScheduledFor] = useState("");
  const [hours, setHours] = useState("");

  async function create() {
    const done = await run("create", () =>
      api.post(`/api/v1/projects/${projectId}/training-records`, {
        title: title.trim(),
        trainingKind: kind,
        trainerName: trainer.trim() === "" ? null : trainer.trim(),
        trainerOrganisation: organisation.trim() === "" ? null : organisation.trim(),
        scheduledFor: scheduledFor === "" ? null : scheduledFor,
        durationHours: numberOrNull(hours),
      }),
    );
    if (done) {
      setTitle("");
      setTrainer("");
      setOrganisation("");
      onCreated();
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Plan an operator training session"
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
            Plan it
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <RefusalNotice refusal={refusal} onDismiss={clear} />
        <Field label="What is being taught" required>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
        </Field>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Kind">
            <Select value={kind} onChange={(e) => setKind(e.target.value)}>
              {TRAINING_KINDS.map((k) => (
                <option key={k} value={k}>
                  {labelize(k)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Scheduled for">
            <Input
              type="date"
              value={scheduledFor}
              onChange={(e) => setScheduledFor(e.target.value)}
            />
          </Field>
          <Field label="Hours">
            <Input type="number" value={hours} onChange={(e) => setHours(e.target.value)} />
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Trainer">
            <Input value={trainer} onChange={(e) => setTrainer(e.target.value)} />
          </Field>
          <Field label="Organisation">
            <Input value={organisation} onChange={(e) => setOrganisation(e.target.value)} />
          </Field>
        </div>
      </div>
    </Modal>
  );
}

function DeliverTraining({
  record,
  projectId,
  onClose,
  onDone,
}: {
  record: TrainingRecord | null;
  projectId: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const { busy, refusal, clear, run } = useAction();
  const [names, setNames] = useState("");
  const [organisation, setOrganisation] = useState("");
  const [assessed, setAssessed] = useState(false);

  const attendees = names
    .split("\n")
    .map((n) => n.trim())
    .filter((n) => n !== "");

  async function deliver() {
    if (!record) return;
    const done = await run("deliver", () =>
      api.post(`/api/v1/projects/${projectId}/training-records/${record.id}/deliver`, {
        attendees: attendees.map((name) => ({
          name,
          organisation: organisation.trim() === "" ? null : organisation.trim(),
        })),
        competencyAssessed: assessed,
      }),
    );
    if (done) {
      setNames("");
      setOrganisation("");
      setAssessed(false);
      onDone();
    }
  }

  return (
    <Modal
      open={record !== null}
      onClose={onClose}
      title={record ? `Record delivery of ${record.reference}` : "Record delivery"}
      description="The attendee list is the record. A session delivered to nobody named is a session nobody can show was delivered."
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={busy === "deliver"}
            disabled={attendees.length === 0}
            onClick={deliver}
          >
            Record it
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <RefusalNotice refusal={refusal} onDismiss={clear} />
        <Field label="Attendees" required hint="One name per line.">
          <Textarea rows={6} value={names} onChange={(e) => setNames(e.target.value)} autoFocus />
        </Field>
        <Field label="Organisation">
          <Input value={organisation} onChange={(e) => setOrganisation(e.target.value)} />
        </Field>
        <label className="flex items-center gap-2 text-meta text-content">
          <input
            type="checkbox"
            checked={assessed}
            onChange={(e) => setAssessed(e.target.checked)}
            className="h-3.5 w-3.5"
          />
          Competency was assessed, not merely attended
        </label>
      </div>
    </Modal>
  );
}

/* ================================================================== */
/* Spares                                                              */
/* ================================================================== */

function SparesPanel({
  projectId,
  version,
  onMutated,
}: {
  projectId: string;
  version: number;
  onMutated: () => void;
}) {
  const base = `/api/v1/projects/${projectId}`;
  const [createOpen, setCreateOpen] = useState(false);
  const [receiving, setReceiving] = useState<SparePart | null>(null);
  const { busy, refusal, clear, run } = useAction();
  const spares = useResource<Paged<SparePart>>(
    (signal) => api.get<Paged<SparePart>>(`${base}/spare-parts?page=1&pageSize=200`, { signal }),
    [base, version],
  );
  const rows = spares.data?.items ?? [];

  async function handover(id: string) {
    const done = await run(`handover-${id}`, () =>
      api.post(`${base}/spare-parts/${id}/handover`, {}),
    );
    if (done) {
      spares.reload();
      onMutated();
    }
  }

  const columns = useMemo<DataColumns<SparePart>>(
    () => [
      { id: "reference", header: "Ref", accessor: "reference", type: "text", sticky: "start", width: 110 },
      { id: "description", header: "Item", accessor: "description", type: "text", width: 250 },
      {
        id: "category",
        header: "Category",
        accessor: "category",
        type: "text",
        width: 180,
        cell: ({ row }) => (
          <Badge tone="neutral" size="xs" variant="outline">
            {labelize(row.category)}
          </Badge>
        ),
      },
      {
        id: "quantity",
        header: "Delivered",
        accessor: (r) => r.quantityDelivered,
        type: "number",
        width: 150,
        align: "right",
        cell: ({ row }) => (
          <span className="text-2xs tabular-nums">
            {num(row.quantityDelivered, 0)}
            {row.quantityRequired === null ? (
              <span className="ml-1 italic text-content-subtle">of an unrecorded requirement</span>
            ) : (
              <span className="ml-1 text-content-subtle">of {num(row.quantityRequired, 0)}</span>
            )}
          </span>
        ),
      },
      {
        id: "status",
        header: "Status",
        accessor: "status",
        type: "text",
        width: 140,
        cell: ({ row }) => (
          <Badge
            tone={
              row.status === "handed_over"
                ? "success"
                : row.status === "outstanding"
                  ? "danger"
                  : row.status === "delivered"
                    ? "info"
                    : "neutral"
            }
            size="xs"
            dot
          >
            {labelize(row.status)}
          </Badge>
        ),
      },
      {
        id: "actions",
        header: "",
        accessor: () => "",
        type: "text",
        width: 170,
        cell: ({ row }) => (
          <div className="flex gap-1">
            {row.status !== "handed_over" ? (
              <Button size="xs" variant="ghost" onClick={() => setReceiving(row)}>
                Receive
              </Button>
            ) : null}
            {row.status === "delivered" ? (
              <Button
                size="xs"
                variant="secondary"
                loading={busy === `handover-${row.id}`}
                onClick={() => handover(row.id)}
              >
                Hand over
              </Button>
            ) : null}
          </div>
        ),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [busy],
  );

  return (
    <div className="space-y-3">
      <RefusalNotice refusal={refusal} onDismiss={clear} />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-meta text-content-muted">
          {spares.data
            ? `${spares.data.total} ${plural(spares.data.total, "spare part line")}`
            : "Loading the register…"}
        </p>
        <Button size="sm" icon={IconPlus} onClick={() => setCreateOpen(true)}>
          Add a required spare
        </Button>
      </div>

      {spares.error ? (
        <LoadError message={spares.error} onRetry={spares.reload} />
      ) : rows.length === 0 ? (
        <NothingHere
          title="No spares are being tracked"
          reason="Spares are contractual: the owner is owed them and usually finds out they were never delivered on the day one is needed. Record what the specification requires and the gap becomes visible before handover, not after."
          action={
            <Button size="sm" icon={IconPlus} onClick={() => setCreateOpen(true)}>
              Add the first line
            </Button>
          }
        />
      ) : (
        <DataTable<SparePart>
          tableId="quality-spares"
          data={rows}
          columns={columns}
          getRowId={(row) => row.id}
          height={420}
          stickyHeader
          zebra
          filterRow
          exportFileName="spare-parts"
          searchPlaceholder="Search spares"
          aria-label="Spare parts register"
          rowTone={(row) => (row.status === "outstanding" ? "danger" : undefined)}
        />
      )}

      <CreateSpare
        open={createOpen}
        projectId={projectId}
        onClose={() => setCreateOpen(false)}
        onCreated={() => {
          setCreateOpen(false);
          spares.reload();
          onMutated();
        }}
      />
      <ReceiveSpare
        part={receiving}
        projectId={projectId}
        onClose={() => setReceiving(null)}
        onDone={() => {
          setReceiving(null);
          spares.reload();
          onMutated();
        }}
      />
    </div>
  );
}

function CreateSpare({
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
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState("operational_spare");
  const [partNumber, setPartNumber] = useState("");
  const [manufacturer, setManufacturer] = useState("");
  const [quantity, setQuantity] = useState("");
  const [unit, setUnit] = useState("");
  const [leadTime, setLeadTime] = useState("");

  async function create() {
    const done = await run("create", () =>
      api.post(`/api/v1/projects/${projectId}/spare-parts`, {
        description: description.trim(),
        category,
        partNumber: partNumber.trim() === "" ? null : partNumber.trim(),
        manufacturer: manufacturer.trim() === "" ? null : manufacturer.trim(),
        quantityRequired: numberOrNull(quantity),
        unit: unit.trim() === "" ? null : unit.trim(),
        leadTimeWeeks: numberOrNull(leadTime),
      }),
    );
    if (done) {
      setDescription("");
      setPartNumber("");
      setManufacturer("");
      setQuantity("");
      onCreated();
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add a required spare"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={busy === "create"}
            disabled={description.trim() === ""}
            onClick={create}
          >
            Add it
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <RefusalNotice refusal={refusal} onDismiss={clear} />
        <Field label="Item" required>
          <Input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            autoFocus
          />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Category">
            <Select value={category} onChange={(e) => setCategory(e.target.value)}>
              {SPARE_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {labelize(c)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Part number">
            <Input value={partNumber} onChange={(e) => setPartNumber(e.target.value)} />
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-4">
          <Field label="Manufacturer">
            <Input value={manufacturer} onChange={(e) => setManufacturer(e.target.value)} />
          </Field>
          <Field label="Quantity required">
            <Input type="number" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
          </Field>
          <Field label="Unit">
            <Input value={unit} onChange={(e) => setUnit(e.target.value)} />
          </Field>
          <Field label="Lead time (weeks)">
            <Input type="number" value={leadTime} onChange={(e) => setLeadTime(e.target.value)} />
          </Field>
        </div>
      </div>
    </Modal>
  );
}

function ReceiveSpare({
  part,
  projectId,
  onClose,
  onDone,
}: {
  part: SparePart | null;
  projectId: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const { busy, refusal, clear, run } = useAction();
  const [quantity, setQuantity] = useState("");
  const [location, setLocation] = useState("");

  async function receive() {
    const parsed = numberOrNull(quantity);
    if (parsed === null || !part) return;
    const done = await run("receive", () =>
      api.post(`/api/v1/projects/${projectId}/spare-parts/${part.id}/receive`, {
        quantityDelivered: parsed,
        storageLocation: location.trim() === "" ? null : location.trim(),
      }),
    );
    if (done) {
      setQuantity("");
      setLocation("");
      onDone();
    }
  }

  return (
    <Modal
      open={part !== null}
      onClose={onClose}
      title={part ? `Receive ${part.reference}` : "Receive"}
      description="Record what arrived and where it was put. A spare nobody can find is a spare nobody has."
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={busy === "receive"}
            disabled={numberOrNull(quantity) === null}
            onClick={receive}
          >
            Record receipt
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <RefusalNotice refusal={refusal} onDismiss={clear} />
        {part ? (
          <p className="text-2xs text-content-muted">
            {part.description} —{" "}
            {part.quantityRequired === null
              ? "the required quantity is unrecorded"
              : `${num(part.quantityDelivered, 0)} of ${num(part.quantityRequired, 0)} delivered so far`}
          </p>
        ) : null}
        <Field label="Quantity delivered (cumulative)" required>
          <Input
            type="number"
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
            autoFocus
          />
        </Field>
        <Field label="Storage location">
          <Input value={location} onChange={(e) => setLocation(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

/* ================================================================== */
/* Post-occupancy evaluation                                           */
/* ================================================================== */

function PoePanel({
  projectId,
  version,
  onMutated,
}: {
  projectId: string;
  version: number;
  onMutated: () => void;
}) {
  const base = `/api/v1/projects/${projectId}`;
  const [createOpen, setCreateOpen] = useState(false);
  const [completing, setCompleting] = useState<Poe | null>(null);
  const evaluations = useResource<Paged<Poe>>(
    (signal) => api.get<Paged<Poe>>(`${base}/poe?page=1&pageSize=200`, { signal }),
    [base, version],
  );
  const rows = evaluations.data?.items ?? [];

  const columns = useMemo<DataColumns<Poe>>(
    () => [
      { id: "reference", header: "Ref", accessor: "reference", type: "text", sticky: "start", width: 110 },
      { id: "title", header: "Evaluation", accessor: "title", type: "text", width: 230 },
      {
        id: "kind",
        header: "Kind",
        accessor: "poeKind",
        type: "text",
        width: 190,
        cell: ({ row }) => (
          <Badge tone="neutral" size="xs" variant="outline">
            {labelize(row.poeKind)}
          </Badge>
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
              row.status === "complete"
                ? "success"
                : row.status === "in_progress"
                  ? "info"
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
        id: "satisfaction",
        header: "Satisfaction",
        accessor: (r) => r.satisfactionScore ?? 0,
        type: "number",
        width: 150,
        align: "right",
        cell: ({ row }) =>
          row.satisfactionScore === null ? (
            <span className="text-2xs italic text-content-subtle">not surveyed</span>
          ) : (
            <span className="text-2xs tabular-nums">
              {num(row.satisfactionScore, 1)}
              {row.satisfactionScale ? (
                <span className="ml-1 text-content-subtle">{row.satisfactionScale}</span>
              ) : null}
            </span>
          ),
      },
      {
        id: "energy",
        header: "Energy vs design",
        headerTooltip:
          "Actual against design. With only one of the two numbers the variance is unknown — it is never drawn as zero.",
        accessor: (r) => r.energyVariance.value ?? 0,
        type: "number",
        width: 200,
        align: "right",
        cell: ({ row }) => (
          <FigureText
            figure={row.energyVariance}
            hideReasons
            className="text-2xs tabular-nums"
            render={(v) => `${v > 0 ? "+" : ""}${num(v, 1)}%`}
          />
        ),
      },
      {
        id: "actions",
        header: "",
        accessor: () => "",
        type: "text",
        width: 130,
        cell: ({ row }) =>
          row.status === "complete" || row.status === "cancelled" ? null : (
            <Button size="xs" variant="ghost" onClick={() => setCompleting(row)}>
              Complete
            </Button>
          ),
      },
    ],
    [],
  );

  return (
    <div className="space-y-3">
      <p className="text-2xs text-content-subtle">
        Soft landings and post-occupancy evaluation ask the only question practical completion never
        does: did the building work once people were in it. Energy actuals are compared with the
        design figure the project was sold on, and where either is missing the variance is reported
        as unknown.
      </p>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-meta text-content-muted">
          {evaluations.data
            ? `${evaluations.data.total} ${plural(evaluations.data.total, "evaluation")}`
            : "Loading the register…"}
        </p>
        <Button size="sm" icon={IconPlus} onClick={() => setCreateOpen(true)}>
          Plan an evaluation
        </Button>
      </div>

      {evaluations.error ? (
        <LoadError message={evaluations.error} onRetry={evaluations.reload} />
      ) : rows.length === 0 ? (
        <NothingHere
          title="No post-occupancy evaluation is planned"
          reason="Without one, the last thing anybody records about this building is the day it was handed over — and the design intent is never tested against how it actually performed."
          action={
            <Button size="sm" icon={IconPlus} onClick={() => setCreateOpen(true)}>
              Plan the first one
            </Button>
          }
        />
      ) : (
        <DataTable<Poe>
          tableId="quality-poe"
          data={rows}
          columns={columns}
          getRowId={(row) => row.id}
          height={420}
          stickyHeader
          zebra
          filterRow
          exportFileName="post-occupancy-evaluations"
          searchPlaceholder="Search evaluations"
          aria-label="Post-occupancy evaluations"
        />
      )}

      {rows.some((r) => r.findings) ? (
        <div className="rounded-md border border-border-subtle p-2.5">
          <div className="text-label uppercase tracking-wide text-content-subtle">Findings</div>
          <ul className="mt-1 space-y-1.5">
            {rows
              .filter((r) => r.findings)
              .map((r) => (
                <li key={r.id} className="text-2xs">
                  <span className="font-mono font-semibold text-content">{r.reference}</span>{" "}
                  <span className="whitespace-pre-wrap text-content-muted">{r.findings}</span>
                  {r.recommendations ? (
                    <div className="mt-0.5 whitespace-pre-wrap text-content-subtle">
                      Recommends: {r.recommendations}
                    </div>
                  ) : null}
                </li>
              ))}
          </ul>
        </div>
      ) : null}

      <CreatePoe
        open={createOpen}
        projectId={projectId}
        onClose={() => setCreateOpen(false)}
        onCreated={() => {
          setCreateOpen(false);
          evaluations.reload();
          onMutated();
        }}
      />
      <CompletePoe
        poe={completing}
        projectId={projectId}
        onClose={() => setCompleting(null)}
        onDone={() => {
          setCompleting(null);
          evaluations.reload();
          onMutated();
        }}
      />
    </div>
  );
}

function CreatePoe({
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
  const [kind, setKind] = useState("soft_landings_review");
  const [scheduledFor, setScheduledFor] = useState("");
  const [designValue, setDesignValue] = useState("");
  const [energyUnit, setEnergyUnit] = useState("kWh/m²/yr");
  const [organisation, setOrganisation] = useState("");

  async function create() {
    const done = await run("create", () =>
      api.post(`/api/v1/projects/${projectId}/poe`, {
        title: title.trim(),
        poeKind: kind,
        scheduledFor: scheduledFor === "" ? null : scheduledFor,
        energyDesignValue: numberOrNull(designValue),
        energyUnit: energyUnit.trim() === "" ? null : energyUnit.trim(),
        conductedByOrganisation: organisation.trim() === "" ? null : organisation.trim(),
      }),
    );
    if (done) {
      setTitle("");
      setDesignValue("");
      setOrganisation("");
      onCreated();
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Plan a post-occupancy evaluation"
      description="Record the design energy figure now, while somebody still knows what it was. Without it the actual reading later has nothing to be compared with, and the variance reports as unknown."
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
            Plan it
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <RefusalNotice refusal={refusal} onDismiss={clear} />
        <Field label="Title" required>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Kind">
            <Select value={kind} onChange={(e) => setKind(e.target.value)}>
              {POE_KINDS.map((k) => (
                <option key={k} value={k}>
                  {labelize(k)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Scheduled for">
            <Input
              type="date"
              value={scheduledFor}
              onChange={(e) => setScheduledFor(e.target.value)}
            />
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Design energy value">
            <Input
              type="number"
              value={designValue}
              onChange={(e) => setDesignValue(e.target.value)}
            />
          </Field>
          <Field label="Energy unit">
            <Input value={energyUnit} onChange={(e) => setEnergyUnit(e.target.value)} />
          </Field>
          <Field label="Conducted by">
            <Input value={organisation} onChange={(e) => setOrganisation(e.target.value)} />
          </Field>
        </div>
      </div>
    </Modal>
  );
}

function CompletePoe({
  poe,
  projectId,
  onClose,
  onDone,
}: {
  poe: Poe | null;
  projectId: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const { busy, refusal, clear, run } = useAction();
  const [invites, setInvites] = useState("");
  const [responses, setResponses] = useState("");
  const [score, setScore] = useState("");
  const [energyActual, setEnergyActual] = useState("");
  const [findings, setFindings] = useState("");
  const [recommendations, setRecommendations] = useState("");

  const intOrNull = (v: string): number | null => {
    const parsed = numberOrNull(v);
    return parsed === null ? null : Math.round(parsed);
  };

  async function complete() {
    if (!poe) return;
    const done = await run("complete", () =>
      api.post(`/api/v1/projects/${projectId}/poe/${poe.id}/complete`, {
        surveyInviteCount: intOrNull(invites),
        surveyResponseCount: intOrNull(responses),
        satisfactionScore: numberOrNull(score),
        energyActualValue: numberOrNull(energyActual),
        findings: findings.trim() === "" ? null : findings.trim(),
        recommendations: recommendations.trim() === "" ? null : recommendations.trim(),
      }),
    );
    if (done) {
      setInvites("");
      setResponses("");
      setScore("");
      setEnergyActual("");
      setFindings("");
      setRecommendations("");
      onDone();
    }
  }

  return (
    <Modal
      open={poe !== null}
      onClose={onClose}
      title={poe ? `Complete ${poe.reference}` : "Complete evaluation"}
      description="Leave a figure blank rather than guessing it. A blank reports as not measured; a guess reports as a fact."
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy === "complete"} onClick={complete}>
            Complete it
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <RefusalNotice refusal={refusal} onDismiss={clear} />
        {poe && poe.energyDesignValue !== null ? (
          <p className="text-2xs text-content-muted">
            Design energy: {num(poe.energyDesignValue, 1)} {poe.energyUnit ?? ""}
          </p>
        ) : null}
        <div className="grid gap-3 sm:grid-cols-4">
          <Field label="Surveys sent">
            <Input type="number" value={invites} onChange={(e) => setInvites(e.target.value)} />
          </Field>
          <Field label="Responses">
            <Input type="number" value={responses} onChange={(e) => setResponses(e.target.value)} />
          </Field>
          <Field label="Satisfaction score">
            <Input type="number" value={score} onChange={(e) => setScore(e.target.value)} />
          </Field>
          <Field label="Energy actual">
            <Input
              type="number"
              value={energyActual}
              onChange={(e) => setEnergyActual(e.target.value)}
            />
          </Field>
        </div>
        <Field label="Findings">
          <Textarea rows={4} value={findings} onChange={(e) => setFindings(e.target.value)} />
        </Field>
        <Field label="Recommendations">
          <Textarea
            rows={3}
            value={recommendations}
            onChange={(e) => setRecommendations(e.target.value)}
          />
        </Field>
      </div>
    </Modal>
  );
}
