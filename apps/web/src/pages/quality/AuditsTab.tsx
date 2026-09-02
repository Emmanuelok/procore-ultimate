/**
 * QUALITY AUDITS and the ISO 9001 EVIDENCE PACK (#1095–1096).
 *
 * An audit is worth keeping only for its findings, and a finding is worth
 * keeping only if it carries three things: the requirement (quoted), the
 * evidence seen, and the conclusion drawn. A register of conclusions with no
 * evidence is an opinion log, and it is the first thing a certification body
 * discounts — so the API refuses a non-conformity without them, and this
 * screen asks for them in that order.
 *
 * The evidence pack answers the other direction: "show me how you control
 * non-conforming output". Where the platform holds nothing for a clause it
 * says so. An unevidenced clause is never drawn as a compliant one.
 */
import { useMemo, useState } from "react";
import {
  Alert,
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
  nameOf,
  num,
  plural,
  useAction,
  useResource,
  type Resource,
} from "./qualityShared";
import type {
  AuditFinding,
  IsoEvidence,
  Paged,
  QualityAudit,
  QualityAuditDetail,
} from "./types";

const AUDIT_TYPES = [
  "internal",
  "external",
  "supplier",
  "process",
  "product",
  "system",
  "surveillance",
  "certification",
  "regulatory",
];

const FINDING_TYPES = [
  "major_nonconformity",
  "minor_nonconformity",
  "observation",
  "opportunity_for_improvement",
  "conformity",
];

const FINDING_TONE: Record<string, "danger" | "warning" | "info" | "success" | "neutral"> = {
  major_nonconformity: "danger",
  minor_nonconformity: "warning",
  observation: "info",
  opportunity_for_improvement: "neutral",
  conformity: "success",
};

export default function AuditsTab({
  audits,
  findings,
  evidence,
  projectId,
  users,
  onMutated,
}: {
  audits: Resource<Paged<QualityAudit>>;
  findings: Resource<Paged<AuditFinding>>;
  evidence: Resource<IsoEvidence>;
  projectId: string;
  users: Map<string, string>;
  onMutated: () => void;
}) {
  const [createOpen, setCreateOpen] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const rows = audits.data?.items ?? [];
  const findingRows = findings.data?.items ?? [];
  const pack = evidence.data;
  const today = new Date().toISOString().slice(0, 10);
  const overdue = findingRows.filter((f) => f.dueDate !== null && f.dueDate < today);

  const columns = useMemo<DataColumns<QualityAudit>>(
    () => [
      {
        id: "reference",
        header: "Ref",
        accessor: "reference",
        type: "text",
        sticky: "start",
        width: 100,
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
      { id: "title", header: "Audit", accessor: "title", type: "text", width: 260 },
      {
        id: "type",
        header: "Type",
        accessor: "auditType",
        type: "text",
        width: 130,
        cell: ({ row }) => (
          <Badge tone="neutral" size="xs" variant="outline">
            {labelize(row.auditType)}
          </Badge>
        ),
      },
      {
        id: "status",
        header: "Status",
        accessor: "status",
        type: "text",
        width: 160,
        cell: ({ row }) => (
          <Badge tone={row.status === "closed" ? "success" : "info"} size="xs" dot>
            {labelize(row.status)}
          </Badge>
        ),
      },
      {
        id: "findings",
        header: "Findings",
        accessor: (r) => r.findingCount,
        type: "number",
        width: 200,
        cell: ({ row }) => (
          <span className="flex flex-wrap items-center gap-1">
            {row.majorFindingCount > 0 ? (
              <Badge tone="danger" size="xs" variant="solid">
                {row.majorFindingCount} major
              </Badge>
            ) : null}
            {row.minorFindingCount > 0 ? (
              <Badge tone="warning" size="xs">
                {row.minorFindingCount} minor
              </Badge>
            ) : null}
            {row.observationCount > 0 ? (
              <Badge tone="info" size="xs" variant="outline">
                {row.observationCount} obs
              </Badge>
            ) : null}
            {row.findingCount === 0 ? (
              <span className="text-2xs italic text-content-subtle">none recorded</span>
            ) : null}
          </span>
        ),
      },
      {
        id: "open",
        header: "Open",
        accessor: (r) => r.openFindingCount,
        type: "number",
        width: 90,
        align: "right",
      },
      {
        id: "conformity",
        header: "Conformity",
        accessor: (r) => r.conformityPercent ?? 0,
        type: "number",
        width: 120,
        align: "right",
        cell: ({ row }) =>
          row.conformityPercent === null ? (
            <span className="text-2xs italic text-content-subtle">no findings</span>
          ) : (
            <span className="text-2xs tabular-nums">{num(row.conformityPercent, 0)}%</span>
          ),
      },
      {
        id: "planned",
        header: "Planned",
        accessor: (r) => r.plannedDate ?? "",
        type: "text",
        width: 120,
        cell: ({ row }) => <span className="text-2xs tabular-nums">{isoDate(row.plannedDate)}</span>,
      },
    ],
    [],
  );

  return (
    <div className="space-y-4">
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <CountTile label="Audits" value={audits.data?.total ?? 0} />
        <CountTile label="Open findings" value={findingRows.filter((f) => f.status !== "closed" && f.status !== "verified").length} tone="warning" emphasis />
        <CountTile
          label="Major non-conformities"
          value={findingRows.filter((f) => f.findingType === "major_nonconformity").length}
          tone="danger"
          emphasis
        />
        <CountTile label="Past their close-out date" value={overdue.length} tone="danger" emphasis />
      </div>

      {overdue.length > 0 ? (
        <Alert tone="danger" title={`${overdue.length} ${plural(overdue.length, "finding")} past the close-out date`}>
          <ul className="space-y-0.5 text-meta">
            {overdue.slice(0, 6).map((f) => (
              <li key={f.id}>
                <span className="font-mono">{f.reference}</span> ({labelize(f.findingType)}) — due{" "}
                {isoDate(f.dueDate)}, still {labelize(f.status).toLowerCase()}.
              </li>
            ))}
          </ul>
        </Alert>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-meta text-content-muted">
          {audits.data
            ? `${audits.data.total} ${plural(audits.data.total, "audit")} on this project`
            : "Loading the register…"}
        </p>
        <Button size="sm" icon={IconPlus} onClick={() => setCreateOpen(true)}>
          Plan an audit
        </Button>
      </div>

      {audits.error ? (
        <LoadError message={audits.error} onRetry={audits.reload} />
      ) : rows.length === 0 ? (
        <NothingHere
          title="No audit has been planned"
          reason="An internal audit is what tells you the system is being followed rather than merely written down. Its findings — with the requirement quoted and the evidence recorded — are what a certification body reads."
          action={
            <Button size="sm" icon={IconPlus} onClick={() => setCreateOpen(true)}>
              Plan the first audit
            </Button>
          }
        />
      ) : (
        <DataTable<QualityAudit>
          tableId="quality-audits"
          data={rows}
          columns={columns}
          getRowId={(row) => row.id}
          height={380}
          stickyHeader
          zebra
          filterRow
          exportFileName="quality-audits"
          searchPlaceholder="Search audits"
          aria-label="Quality audits"
          rowTone={(row) => (row.majorFindingCount > 0 ? "danger" : undefined)}
        />
      )}

      {/* ---------------- ISO 9001 evidence ---------------- */}
      {evidence.error ? (
        <LoadError message={evidence.error} onRetry={evidence.reload} />
      ) : pack ? (
        <div className="rounded-md border border-border p-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="text-sm font-semibold text-content">{pack.standard} evidence</h3>
            <span className="text-meta text-content-muted">
              {pack.coverage.clausesEvidenced} of {pack.coverage.clausesReported} clauses have
              records here
            </span>
          </div>
          <div className="mt-2 grid gap-2 lg:grid-cols-2">
            {pack.clauses.map((c) => (
              <div
                key={c.clause}
                className="rounded-md border border-border-subtle p-2.5"
              >
                <div className="flex items-center gap-1.5">
                  <Badge tone={c.evidenced ? "success" : "warning"} size="xs" dot>
                    {c.evidenced ? "records held" : "unevidenced here"}
                  </Badge>
                  <span className="text-2xs font-semibold text-content">{c.title}</span>
                </div>
                <p className="mt-0.5 text-2xs text-content-muted">{c.question}</p>
                <ul className="mt-1 flex flex-wrap gap-1">
                  {c.records.map((r) => (
                    <li key={r.kind}>
                      <Badge tone={r.count > 0 ? "neutral" : "warning"} size="xs" variant="outline">
                        {r.kind}: {r.count}
                      </Badge>
                    </li>
                  ))}
                </ul>
                <ReasonList reasons={c.reasons} className="mt-1" />
              </div>
            ))}
          </div>
          <ReasonList reasons={pack.reasons} className="mt-2" />
        </div>
      ) : null}

      <CreateAudit
        open={createOpen}
        projectId={projectId}
        users={users}
        onClose={() => setCreateOpen(false)}
        onCreated={() => {
          setCreateOpen(false);
          onMutated();
        }}
      />
      <AuditModal
        auditId={openId}
        projectId={projectId}
        users={users}
        onClose={() => setOpenId(null)}
        onMutated={onMutated}
      />
    </div>
  );
}

/* ================================================================== */

function CreateAudit({
  open,
  onClose,
  projectId,
  users,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  projectId: string;
  users: Map<string, string>;
  onCreated: () => void;
}) {
  const { busy, refusal, clear, run } = useAction();
  const [title, setTitle] = useState("");
  const [auditType, setAuditType] = useState("internal");
  const [standard, setStandard] = useState("ISO 9001:2015");
  const [scope, setScope] = useState("");
  const [leadAuditorId, setLeadAuditorId] = useState("");
  const [plannedDate, setPlannedDate] = useState("");

  async function create() {
    const done = await run("create", () =>
      api.post(`/api/v1/projects/${projectId}/quality-audits`, {
        title: title.trim(),
        auditType,
        standard: standard.trim() === "" ? null : standard.trim(),
        scope: scope.trim() === "" ? null : scope.trim(),
        leadAuditorId: leadAuditorId === "" ? null : leadAuditorId,
        plannedDate: plannedDate === "" ? null : plannedDate,
      }),
    );
    if (done) {
      setTitle("");
      setScope("");
      onCreated();
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Plan an audit"
      description="The scope is what makes the findings mean something: an audit of everything finds nothing."
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
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Type">
            <Select value={auditType} onChange={(e) => setAuditType(e.target.value)}>
              {AUDIT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {labelize(t)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Standard">
            <Input value={standard} onChange={(e) => setStandard(e.target.value)} />
          </Field>
          <Field label="Planned date">
            <Input type="date" value={plannedDate} onChange={(e) => setPlannedDate(e.target.value)} />
          </Field>
        </div>
        <Field label="Lead auditor" hint="Independent of the area being audited, by definition.">
          <Select value={leadAuditorId} onChange={(e) => setLeadAuditorId(e.target.value)}>
            <option value="">— not named yet —</option>
            {[...users.entries()].map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Scope">
          <Textarea rows={2} value={scope} onChange={(e) => setScope(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

/* ================================================================== */

function AuditModal({
  auditId,
  projectId,
  users,
  onClose,
  onMutated,
}: {
  auditId: string | null;
  projectId: string;
  users: Map<string, string>;
  onClose: () => void;
  onMutated: () => void;
}) {
  const { busy, refusal, clear, run } = useAction();
  const [addOpen, setAddOpen] = useState(false);
  const base = `/api/v1/projects/${projectId}/quality-audits/${auditId ?? ""}`;
  const audit = useResource<QualityAuditDetail>(
    (signal) => api.get<QualityAuditDetail>(base, { signal }),
    [base],
    auditId !== null,
  );
  if (!auditId) return null;
  const a = audit.data;

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={a ? `${a.reference} — ${a.title}` : "Audit"}
      description="Findings carry the requirement, the evidence and the conclusion. The API refuses a non-conformity without the first two."
      footer={
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          {a && a.status !== "closed" ? (
            <>
              <Button size="sm" variant="secondary" icon={IconPlus} onClick={() => setAddOpen(true)}>
                Add a finding
              </Button>
              <Button
                size="sm"
                variant="secondary"
                loading={busy === "report"}
                onClick={async () => {
                  const done = await run("report", () =>
                    api.post(`${base}/status`, { status: "report_issued" }),
                  );
                  if (done) {
                    audit.reload();
                    onMutated();
                  }
                }}
              >
                Issue the report
              </Button>
              <Button
                size="sm"
                variant="primary"
                loading={busy === "close"}
                onClick={async () => {
                  const done = await run("close", () => api.post(`${base}/close`, {}));
                  if (done) {
                    audit.reload();
                    onMutated();
                  }
                }}
              >
                Close the audit
              </Button>
            </>
          ) : null}
        </div>
      }
    >
      {audit.error ? (
        <LoadError message={audit.error} onRetry={audit.reload} />
      ) : !a ? (
        <p className="text-meta text-content-muted">Loading…</p>
      ) : (
        <div className="space-y-3 text-meta">
          <RefusalNotice refusal={refusal} onDismiss={clear} />
          <div className="flex flex-wrap gap-1.5">
            <Badge tone="neutral" size="xs" dot>
              {labelize(a.status)}
            </Badge>
            <Badge tone="neutral" size="xs" variant="outline">
              {labelize(a.auditType)}
            </Badge>
            {a.standard ? (
              <Badge tone="neutral" size="xs" variant="outline">
                {a.standard}
              </Badge>
            ) : null}
            {a.leadAuditorId ? (
              <Badge tone="accent" size="xs" variant="outline">
                lead: {nameOf(users, a.leadAuditorId)}
              </Badge>
            ) : null}
          </div>
          {a.scope ? <p className="whitespace-pre-wrap text-content">{a.scope}</p> : null}

          {a.findings.length === 0 ? (
            <p className="text-content-muted">
              No finding recorded. An audit report with no findings — not even a conformity —
              records that nobody looked, not that nothing was wrong.
            </p>
          ) : (
            <ul className="space-y-2">
              {a.findings.map((f) => (
                <FindingCard
                  key={f.id}
                  finding={f}
                  projectId={projectId}
                  users={users}
                  onMutated={() => {
                    audit.reload();
                    onMutated();
                  }}
                />
              ))}
            </ul>
          )}

          <AddFinding
            open={addOpen}
            base={base}
            users={users}
            onClose={() => setAddOpen(false)}
            onCreated={() => {
              setAddOpen(false);
              audit.reload();
              onMutated();
            }}
          />
        </div>
      )}
    </Modal>
  );
}

function FindingCard({
  finding,
  projectId,
  users,
  onMutated,
}: {
  finding: AuditFinding;
  projectId: string;
  users: Map<string, string>;
  onMutated: () => void;
}) {
  const { busy, refusal, clear, run } = useAction();
  const [response, setResponse] = useState("");
  const [rootCause, setRootCause] = useState("");
  const [evidence, setEvidence] = useState("");
  const base = `/api/v1/projects/${projectId}/audit-findings/${finding.id}`;
  const open = finding.status !== "closed" && finding.status !== "verified";

  return (
    <li className="rounded-md border border-border-subtle p-2.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-mono text-2xs">{finding.reference}</span>
        <Badge tone={FINDING_TONE[finding.findingType] ?? "neutral"} size="xs" variant="solid">
          {labelize(finding.findingType)}
        </Badge>
        <Badge tone={open ? "warning" : "success"} size="xs" dot>
          {labelize(finding.status)}
        </Badge>
        {finding.clauseReference ? (
          <span className="text-2xs text-content-subtle">clause {finding.clauseReference}</span>
        ) : null}
        {finding.dueDate ? (
          <span className="text-2xs text-content-subtle">due {isoDate(finding.dueDate)}</span>
        ) : null}
      </div>
      <p className="mt-1 whitespace-pre-wrap text-content">{finding.description}</p>
      {finding.requirement ? (
        <p className="mt-1 text-2xs text-content-muted">
          <span className="font-semibold">Requirement:</span> {finding.requirement}
        </p>
      ) : null}
      {finding.evidence ? (
        <p className="mt-0.5 text-2xs text-content-muted">
          <span className="font-semibold">Evidence:</span> {finding.evidence}
        </p>
      ) : null}
      {finding.rootCause ? (
        <p className="mt-0.5 text-2xs text-content-muted">
          <span className="font-semibold">Root cause:</span> {finding.rootCause}
        </p>
      ) : null}
      {finding.verifiedBy ? (
        <p className="mt-0.5 text-2xs text-content-subtle">
          Verified by {nameOf(users, finding.verifiedBy)} — {finding.verificationEvidence}
        </p>
      ) : null}
      <RefusalNotice refusal={refusal} onDismiss={clear} />
      {open ? (
        <div className="mt-2 space-y-2">
          {finding.status === "open" ? (
            <>
              <Field label="Response">
                <Textarea rows={2} value={response} onChange={(e) => setResponse(e.target.value)} />
              </Field>
              <Field
                label="Root cause"
                hint="Required to agree an action on a non-conformity: correcting the symptom is why the same finding comes back next year."
              >
                <Input value={rootCause} onChange={(e) => setRootCause(e.target.value)} />
              </Field>
              <Button
                size="xs"
                variant="secondary"
                loading={busy === "respond"}
                disabled={response.trim() === ""}
                onClick={async () => {
                  const done = await run("respond", () =>
                    api.post(`${base}/respond`, {
                      response: response.trim(),
                      rootCause: rootCause.trim() === "" ? null : rootCause.trim(),
                      agreed: true,
                    }),
                  );
                  if (done) {
                    setResponse("");
                    setRootCause("");
                    onMutated();
                  }
                }}
              >
                Agree the action
              </Button>
            </>
          ) : (
            <>
              <Field label="Verification evidence" hint="What you actually saw that closed it.">
                <Textarea rows={2} value={evidence} onChange={(e) => setEvidence(e.target.value)} />
              </Field>
              <Button
                size="xs"
                variant="primary"
                loading={busy === "verify"}
                disabled={evidence.trim() === ""}
                onClick={async () => {
                  const done = await run("verify", () =>
                    api.post(`${base}/verify`, { verificationEvidence: evidence.trim() }),
                  );
                  if (done) {
                    setEvidence("");
                    onMutated();
                  }
                }}
              >
                Verify and close
              </Button>
            </>
          )}
        </div>
      ) : null}
    </li>
  );
}

function AddFinding({
  open,
  onClose,
  base,
  users,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  base: string;
  users: Map<string, string>;
  onCreated: () => void;
}) {
  const { busy, refusal, clear, run } = useAction();
  const [findingType, setFindingType] = useState("minor_nonconformity");
  const [description, setDescription] = useState("");
  const [requirement, setRequirement] = useState("");
  const [evidence, setEvidence] = useState("");
  const [clause, setClause] = useState("");
  const [responsibleUserId, setResponsibleUserId] = useState("");
  const [dueDate, setDueDate] = useState("");
  const nonConformity = findingType.endsWith("nonconformity");

  async function create() {
    const done = await run("create", () =>
      api.post(`${base}/findings`, {
        findingType,
        description: description.trim(),
        requirement: requirement.trim() === "" ? null : requirement.trim(),
        evidence: evidence.trim() === "" ? null : evidence.trim(),
        clauseReference: clause.trim() === "" ? null : clause.trim(),
        responsibleUserId: responsibleUserId === "" ? null : responsibleUserId,
        dueDate: dueDate === "" ? null : dueDate,
      }),
    );
    if (done) {
      setDescription("");
      setRequirement("");
      setEvidence("");
      setClause("");
      onCreated();
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add a finding"
      description="A non-conformity must quote the requirement it departs from and record the evidence seen. Without them it cannot be answered, and cannot be defended if it is challenged."
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={busy === "create"}
            disabled={
              description.trim() === "" ||
              (nonConformity && (requirement.trim() === "" || evidence.trim() === ""))
            }
            onClick={create}
          >
            Record the finding
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <RefusalNotice refusal={refusal} onDismiss={clear} />
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Type">
            <Select value={findingType} onChange={(e) => setFindingType(e.target.value)}>
              {FINDING_TYPES.map((t) => (
                <option key={t} value={t}>
                  {labelize(t)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Clause">
            <Input value={clause} onChange={(e) => setClause(e.target.value)} placeholder="8.5.1" />
          </Field>
          <Field label="Close out by">
            <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          </Field>
        </div>
        <Field label="Finding" required>
          <Textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <Field label="Requirement" required={nonConformity} hint="Quoted, not paraphrased.">
          <Textarea rows={2} value={requirement} onChange={(e) => setRequirement(e.target.value)} />
        </Field>
        <Field label="Evidence seen" required={nonConformity}>
          <Textarea rows={2} value={evidence} onChange={(e) => setEvidence(e.target.value)} />
        </Field>
        <Field label="Responsible">
          <Select value={responsibleUserId} onChange={(e) => setResponsibleUserId(e.target.value)}>
            <option value="">— unassigned —</option>
            {[...users.entries()].map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </Select>
        </Field>
      </div>
    </Modal>
  );
}
