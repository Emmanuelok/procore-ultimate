/**
 * SITE RECORDS — the Domain Z registers that decide whether the work can be
 * proved rather than merely claimed.
 *
 *   Concrete       a pour is irreversible; everything anybody will ever ask
 *                  about it is knowable for two hours and then only from the
 *                  record. The acceptance verdict is computed against the code
 *                  the pour names, never typed in.
 *   Welding & NDT  the weld map exists to answer one question quickly: when an
 *                  examination rejects a joint, what else did that welder make
 *                  to that procedure.
 *   Certificates   a certificate in a folder is not evidence; a certificate
 *                  somebody read and compared with the specification is.
 *   Calibration    a reading taken with an out-of-calibration instrument is not
 *                  a reading, and it is the first thing an auditor checks.
 *
 * Four registers, one tab, because on site they are the same job: proving what
 * went in.
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
  LoadError,
  NothingHere,
  ReasonList,
  RefusalNotice,
  isoDate,
  labelize,
  num,
  plural,
  useAction,
  useResource,
  type Resource,
} from "./qualityShared";
import type {
  ConcretePour,
  ConcretePourDetail,
  ConcreteSummary,
  Instrument,
  InstrumentSummary,
  MaterialCertificate,
  CertificateSummary,
  Paged,
  Weld,
  WeldDetail,
  WelderQualification,
  WeldingProcedure,
  WeldingSummary,
} from "./types";

export type RecordsSection = "concrete" | "welding" | "certificates" | "calibration";

const VERDICT_TONE: Record<string, "success" | "danger" | "warning" | "neutral"> = {
  accepted: "success",
  rejected: "danger",
  inconclusive: "warning",
  not_assessable: "neutral",
};

export default function RecordsTab({
  section,
  onSection,
  projectId,
  version,
  onMutated,
}: {
  section: RecordsSection;
  onSection: (section: RecordsSection) => void;
  projectId: string;
  version: number;
  onMutated: () => void;
}) {
  return (
    <div className="space-y-4">
      <SegmentedControl<RecordsSection>
        value={section}
        onChange={onSection}
        aria-label="Site record register"
        options={[
          { value: "concrete", label: "Concrete" },
          { value: "welding", label: "Welding & NDT" },
          { value: "certificates", label: "Material certificates" },
          { value: "calibration", label: "Calibration" },
        ]}
      />
      {section === "concrete" ? (
        <ConcretePanel projectId={projectId} version={version} onMutated={onMutated} />
      ) : section === "welding" ? (
        <WeldingPanel projectId={projectId} version={version} onMutated={onMutated} />
      ) : section === "certificates" ? (
        <CertificatePanel projectId={projectId} version={version} onMutated={onMutated} />
      ) : (
        <CalibrationPanel projectId={projectId} version={version} onMutated={onMutated} />
      )}
    </div>
  );
}

/* ================================================================== */
/* Concrete                                                            */
/* ================================================================== */

function ConcretePanel({
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
  const [openId, setOpenId] = useState<string | null>(null);
  const pours = useResource<Paged<ConcretePour>>(
    (signal) => api.get<Paged<ConcretePour>>(`${base}/concrete-pours?page=1&pageSize=200`, { signal }),
    [base, version],
  );
  const summary = useResource<ConcreteSummary>(
    (signal) => api.get<ConcreteSummary>(`${base}/concrete-summary`, { signal }),
    [base, version],
  );
  const rows = pours.data?.items ?? [];
  const s = summary.data;

  const columns = useMemo<DataColumns<ConcretePour>>(
    () => [
      {
        id: "reference",
        header: "Pour",
        accessor: "reference",
        type: "text",
        sticky: "start",
        width: 130,
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
      { id: "name", header: "Element", accessor: "pourName", type: "text", width: 220 },
      { id: "grade", header: "Grade", accessor: (r) => r.specifiedGrade ?? "", type: "text", width: 110 },
      {
        id: "verdict",
        header: "Acceptance",
        headerTooltip:
          "Computed from the specimen results against the code the pour names — never typed in.",
        accessor: (r) => r.acceptanceVerdict ?? "not_assessed",
        type: "text",
        width: 170,
        cell: ({ row }) => (
          <Badge
            tone={VERDICT_TONE[row.acceptanceVerdict ?? ""] ?? "neutral"}
            size="xs"
            variant={row.acceptanceVerdict === "rejected" ? "solid" : "subtle"}
            dot
          >
            {row.acceptanceVerdict ? labelize(row.acceptanceVerdict) : "not assessed"}
          </Badge>
        ),
      },
      {
        id: "mean",
        header: "Mean / min",
        accessor: (r) => r.meanStrengthMpa ?? 0,
        type: "number",
        width: 140,
        align: "right",
        cell: ({ row }) =>
          row.meanStrengthMpa === null ? (
            <span className="text-2xs italic text-content-subtle">untested</span>
          ) : (
            <span className="text-2xs tabular-nums">
              {num(row.meanStrengthMpa, 1)} / {num(row.minStrengthMpa, 1)} MPa
            </span>
          ),
      },
      {
        id: "specimens",
        header: "Specimens",
        accessor: (r) => r.specimenCount,
        type: "number",
        width: 120,
        align: "right",
        cell: ({ row }) => (
          <span className="text-2xs tabular-nums">
            {row.testedSpecimenCount}/{row.specimenCount} tested
          </span>
        ),
      },
      {
        id: "poured",
        header: "Poured",
        accessor: (r) => r.pouredAt ?? r.plannedDate ?? "",
        type: "text",
        width: 130,
        cell: ({ row }) => (
          <span className="text-2xs tabular-nums">
            {row.pouredAt ? isoDate(row.pouredAt) : `planned ${isoDate(row.plannedDate)}`}
          </span>
        ),
      },
    ],
    [],
  );

  return (
    <div className="space-y-3">
      {summary.error ? (
        <LoadError message={summary.error} onRetry={summary.reload} />
      ) : (
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
          <CountTile label="Pours" value={s?.pours ?? 0} />
          <CountTile label="Failing acceptance" value={s?.failing ?? 0} tone="danger" emphasis />
          <CountTile
            label="Poured, untested"
            value={s?.untestedPours ?? 0}
            tone="warning"
            emphasis
            hint="Untested is not passing."
          />
          <CountTile label="Specimens awaiting a result" value={s?.specimensAwaitingResult ?? 0} />
          <CountTile
            label="Poured over an unreleased hold point"
            value={s?.pouredWithoutRelease ?? 0}
            tone="danger"
            emphasis
          />
        </div>
      )}

      {s && s.mixes.length > 0 ? (
        <div className="rounded-md border border-border-subtle p-2.5">
          <div className="text-label uppercase tracking-wide text-content-subtle">
            Statistical control by mix
          </div>
          <ul className="mt-1 space-y-1">
            {s.mixes.map((m) => (
              <li key={m.mixReference} className="text-meta">
                <span className="font-medium text-content">{m.mixReference}</span>{" "}
                <span className="text-content-muted">
                  {m.pours} {plural(m.pours, "pour")} ·{" "}
                  {m.resultCount === 0
                    ? "no results"
                    : `mean ${num(m.meanStrengthMpa, 1)} MPa, min ${num(m.minStrengthMpa, 1)} MPa${
                        m.standardDeviationMpa !== null ? `, σ ${num(m.standardDeviationMpa, 2)}` : ""
                      }`}
                  {m.specifiedStrengthMpa !== null ? ` · specified ${m.specifiedStrengthMpa} MPa` : ""}
                </span>
                <ReasonList reasons={m.reasons} />
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="flex justify-end">
        <Button size="sm" icon={IconPlus} onClick={() => setCreateOpen(true)}>
          Plan a pour
        </Button>
      </div>

      {pours.error ? (
        <LoadError message={pours.error} onRetry={pours.reload} />
      ) : rows.length === 0 ? (
        <NothingHere
          title="No concrete pour is recorded"
          reason="A pour record is made before the truck arrives and completed at the pour: the mix, the tickets, the fresh tests and the cubes. Afterwards none of it is knowable."
          action={
            <Button size="sm" icon={IconPlus} onClick={() => setCreateOpen(true)}>
              Plan the first pour
            </Button>
          }
        />
      ) : (
        <DataTable<ConcretePour>
          tableId="quality-pours"
          data={rows}
          columns={columns}
          getRowId={(row) => row.id}
          height={460}
          stickyHeader
          zebra
          filterRow
          exportFileName="concrete-pours"
          searchPlaceholder="Search pours"
          aria-label="Concrete pours"
          rowTone={(row) => (row.acceptanceVerdict === "rejected" ? "danger" : undefined)}
        />
      )}

      <PourModal
        pourId={openId}
        projectId={projectId}
        onClose={() => setOpenId(null)}
        onMutated={() => {
          pours.reload();
          summary.reload();
          onMutated();
        }}
      />
      <CreatePour
        open={createOpen}
        projectId={projectId}
        onClose={() => setCreateOpen(false)}
        onCreated={() => {
          setCreateOpen(false);
          pours.reload();
          summary.reload();
          onMutated();
        }}
      />
    </div>
  );
}

function CreatePour({
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
  const [pourName, setPourName] = useState("");
  const [grade, setGrade] = useState("");
  const [strength, setStrength] = useState("");
  const [code, setCode] = useState("en_206");
  const [mix, setMix] = useState("");
  const [plannedDate, setPlannedDate] = useState("");
  const [volume, setVolume] = useState("");

  async function create() {
    const parsedStrength = strength.trim() === "" ? null : Number(strength);
    const parsedVolume = volume.trim() === "" ? null : Number(volume);
    const done = await run("create", () =>
      api.post(`/api/v1/projects/${projectId}/concrete-pours`, {
        pourName: pourName.trim(),
        specifiedGrade: grade.trim() === "" ? null : grade.trim(),
        specifiedStrengthMpa:
          parsedStrength !== null && Number.isFinite(parsedStrength) ? parsedStrength : null,
        acceptanceCode: code,
        mixReference: mix.trim() === "" ? null : mix.trim(),
        plannedDate: plannedDate === "" ? null : plannedDate,
        volumeM3: parsedVolume !== null && Number.isFinite(parsedVolume) ? parsedVolume : null,
      }),
    );
    if (done) {
      setPourName("");
      setGrade("");
      setStrength("");
      setMix("");
      setVolume("");
      onCreated();
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Plan a pour"
      description="The acceptance code decides the arithmetic: EN 206 judges a running mean against fck + 4, ACI 318 judges averages of three against f'c. Applying the wrong one breaks out compliant concrete and leaves non-compliant concrete in."
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={busy === "create"}
            disabled={pourName.trim() === ""}
            onClick={create}
          >
            Create the pour record
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <RefusalNotice refusal={refusal} onDismiss={clear} />
        <Field label="Element" required>
          <Input
            value={pourName}
            onChange={(e) => setPourName(e.target.value)}
            placeholder="e.g. Level 3 slab, bay 2"
            autoFocus
          />
        </Field>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Grade">
            <Input value={grade} onChange={(e) => setGrade(e.target.value)} placeholder="C32/40" />
          </Field>
          <Field label="Characteristic strength (MPa)" hint="Without it nothing can be judged.">
            <Input type="number" value={strength} onChange={(e) => setStrength(e.target.value)} />
          </Field>
          <Field label="Acceptance code">
            <Select value={code} onChange={(e) => setCode(e.target.value)}>
              <option value="en_206">EN 206</option>
              <option value="bs_8500">BS 8500</option>
              <option value="aci_318">ACI 318</option>
              <option value="is_456">IS 456</option>
              <option value="specified_only">Specified strength only</option>
            </Select>
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Mix reference">
            <Input value={mix} onChange={(e) => setMix(e.target.value)} />
          </Field>
          <Field label="Planned date">
            <Input type="date" value={plannedDate} onChange={(e) => setPlannedDate(e.target.value)} />
          </Field>
          <Field label="Volume (m³)">
            <Input type="number" value={volume} onChange={(e) => setVolume(e.target.value)} />
          </Field>
        </div>
      </div>
    </Modal>
  );
}

function PourModal({
  pourId,
  projectId,
  onClose,
  onMutated,
}: {
  pourId: string | null;
  projectId: string;
  onClose: () => void;
  onMutated: () => void;
}) {
  const { busy, refusal, clear, run } = useAction();
  const [specimenRefs, setSpecimenRefs] = useState("");
  const [resultFor, setResultFor] = useState<string | null>(null);
  const [strength, setStrength] = useState("");
  const base = `/api/v1/projects/${projectId}/concrete-pours/${pourId ?? ""}`;
  const pour = useResource<ConcretePourDetail>(
    (signal) => api.get<ConcretePourDetail>(base, { signal }),
    [base],
    pourId !== null,
  );
  if (!pourId) return null;
  const p = pour.data;

  async function addSpecimens() {
    const refs = specimenRefs
      .split(/[,\s]+/)
      .map((r) => r.trim())
      .filter((r) => r !== "");
    if (refs.length === 0) return;
    const done = await run("specimens", () =>
      api.post(`${base}/specimens`, { specimens: refs.map((specimenRef) => ({ specimenRef })) }),
    );
    if (done) {
      setSpecimenRefs("");
      pour.reload();
      onMutated();
    }
  }

  async function recordResult(specimenId: string) {
    const parsed = Number(strength);
    if (!Number.isFinite(parsed)) return;
    const done = await run(`result-${specimenId}`, () =>
      api.post(`${base}/specimens/${specimenId}/result`, { strengthMpa: parsed }),
    );
    if (done) {
      setStrength("");
      setResultFor(null);
      pour.reload();
      onMutated();
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={p ? `${p.reference} — ${p.pourName}` : "Pour"}
      description="Specimens, statistics and the acceptance verdict, computed against the code this pour names."
      footer={
        <div className="flex justify-end">
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>
      }
    >
      {pour.error ? (
        <LoadError message={pour.error} onRetry={pour.reload} />
      ) : !p ? (
        <p className="text-meta text-content-muted">Loading…</p>
      ) : (
        <div className="space-y-3 text-meta">
          <RefusalNotice refusal={refusal} onDismiss={clear} />
          <div className="flex flex-wrap gap-1.5">
            <Badge tone={VERDICT_TONE[p.assessment.verdict] ?? "neutral"} size="xs" dot>
              {labelize(p.assessment.verdict)}
            </Badge>
            <Badge tone="neutral" size="xs" variant="outline">
              {labelize(p.assessment.code)}
            </Badge>
            {p.specifiedGrade ? (
              <Badge tone="neutral" size="xs" variant="outline">
                {p.specifiedGrade}
              </Badge>
            ) : null}
            {p.slump.passed === false ? (
              <Badge tone="danger" size="xs" variant="solid">
                slump outside the window
              </Badge>
            ) : null}
          </div>

          <ul className="space-y-1">
            {p.assessment.checks.map((c) => (
              <li key={c.name} className="rounded-md border border-border-subtle p-2">
                <div className="flex items-center gap-1.5">
                  <Badge
                    tone={c.passed === null ? "neutral" : c.passed ? "success" : "danger"}
                    size="xs"
                    dot
                  >
                    {c.passed === null ? "not applicable yet" : c.passed ? "met" : "not met"}
                  </Badge>
                  <span className="font-medium text-content">{c.name}</span>
                </div>
                <p className="mt-0.5 text-content-muted">
                  {c.observed} — against {c.requirement}
                </p>
              </li>
            ))}
          </ul>
          <ReasonList reasons={p.assessment.reasons} />
          <p className="text-2xs text-content-subtle">{p.slump.reason}</p>

          <div className="rounded-md border border-border-subtle p-2.5">
            <div className="text-label uppercase tracking-wide text-content-subtle">Specimens</div>
            {p.specimens.length === 0 ? (
              <p className="mt-1 text-content-muted">
                None cast. A pour with no specimens can never be shown to have made its strength.
              </p>
            ) : (
              <ul className="mt-1 space-y-1">
                {p.specimens.map((sp) => (
                  <li key={sp.id} className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-2xs">{sp.specimenRef}</span>
                    <Badge
                      tone={
                        sp.result === "pass"
                          ? "success"
                          : sp.result === "fail"
                            ? "danger"
                            : sp.result === "void"
                              ? "neutral"
                              : "warning"
                      }
                      size="xs"
                      dot
                    >
                      {labelize(sp.result)}
                    </Badge>
                    <span className="tabular-nums">
                      {sp.strengthMpa === null ? EM_DASH : `${num(sp.strengthMpa, 1)} MPa`}
                    </span>
                    <span className="text-2xs text-content-subtle">
                      {sp.testAgeDays} day{sp.testAgeDays === 1 ? "" : "s"}
                    </span>
                    {sp.result === "pending" ? (
                      resultFor === sp.id ? (
                        <span className="flex items-center gap-1">
                          <Input
                            className="w-24"
                            type="number"
                            value={strength}
                            onChange={(e) => setStrength(e.target.value)}
                            placeholder="MPa"
                          />
                          <Button
                            size="xs"
                            variant="primary"
                            loading={busy === `result-${sp.id}`}
                            onClick={() => recordResult(sp.id)}
                          >
                            Record
                          </Button>
                        </span>
                      ) : (
                        <Button size="xs" variant="ghost" onClick={() => setResultFor(sp.id)}>
                          Record the crush
                        </Button>
                      )
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-2 flex items-end gap-2">
              <Field label="Cast specimens" className="flex-1">
                <Input
                  value={specimenRefs}
                  onChange={(e) => setSpecimenRefs(e.target.value)}
                  placeholder="C1 C2 C3"
                />
              </Field>
              <Button size="sm" variant="secondary" loading={busy === "specimens"} onClick={addSpecimens}>
                Add
              </Button>
            </div>
          </div>

          {!p.pouredAt ? (
            <Alert tone="info" title="Not yet recorded as poured">
              Record the pour from site with its tickets and fresh tests. If its pre-pour hold point
              is unreleased the API refuses, and the refusal names the point.
            </Alert>
          ) : null}
        </div>
      )}
    </Modal>
  );
}

/* ================================================================== */
/* Welding                                                             */
/* ================================================================== */

function WeldingPanel({
  projectId,
  version,
  onMutated,
}: {
  projectId: string;
  version: number;
  onMutated: () => void;
}) {
  const base = `/api/v1/projects/${projectId}`;
  const [openId, setOpenId] = useState<string | null>(null);
  const welds = useResource<Paged<Weld>>(
    (signal) => api.get<Paged<Weld>>(`${base}/welds?page=1&pageSize=200`, { signal }),
    [base, version],
  );
  const summary = useResource<WeldingSummary>(
    (signal) => api.get<WeldingSummary>(`${base}/welding-summary`, { signal }),
    [base, version],
  );
  const quals = useResource<Paged<WelderQualification>>(
    (signal) =>
      api.get<Paged<WelderQualification>>(`${base}/welder-qualifications?page=1&pageSize=200`, {
        signal,
      }),
    [base, version],
  );
  const procedures = useResource<Paged<WeldingProcedure>>(
    (signal) =>
      api.get<Paged<WeldingProcedure>>(`${base}/welding-procedures?page=1&pageSize=200`, { signal }),
    [base, version],
  );

  const rows = welds.data?.items ?? [];
  const s = summary.data;

  const columns = useMemo<DataColumns<Weld>>(
    () => [
      {
        id: "reference",
        header: "Weld",
        accessor: "reference",
        type: "text",
        sticky: "start",
        width: 110,
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
      { id: "joint", header: "Joint", accessor: (r) => r.jointReference ?? "", type: "text", width: 160 },
      {
        id: "status",
        header: "Status",
        accessor: "status",
        type: "text",
        width: 150,
        cell: ({ row }) => (
          <Badge
            tone={
              row.status === "accepted"
                ? "success"
                : row.status === "rejected"
                  ? "danger"
                  : row.status === "repaired" || row.status === "cut_out"
                    ? "warning"
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
        id: "welder",
        header: "Welder",
        accessor: (r) => r.welderStamp ?? "",
        type: "text",
        width: 120,
        cell: ({ row }) =>
          row.welderStamp ? (
            <span className="font-mono text-2xs">{row.welderStamp}</span>
          ) : (
            <span className="text-2xs italic text-content-subtle">unattributed</span>
          ),
      },
      {
        id: "ndt",
        header: "NDT",
        accessor: (r) => r.ndtRecordCount,
        type: "number",
        width: 160,
        align: "right",
        cell: ({ row }) => (
          <span className="text-2xs tabular-nums">
            {row.ndtRecordCount} recorded
            {row.ndtRequiredPercent !== null && row.ndtRequiredPercent > 0 ? (
              <span
                className={
                  row.ndtRecordCount === 0 ? "ml-1 font-semibold text-danger" : "ml-1 text-content-subtle"
                }
              >
                · {row.ndtRequiredPercent}% required
              </span>
            ) : null}
          </span>
        ),
      },
      {
        id: "heats",
        header: "Heats",
        accessor: (r) => r.heatNumbers.join(", "),
        type: "text",
        width: 160,
      },
      {
        id: "repairs",
        header: "Repairs",
        accessor: (r) => r.repairCount,
        type: "number",
        width: 100,
        align: "right",
      },
    ],
    [],
  );

  return (
    <div className="space-y-3">
      {summary.error ? (
        <LoadError message={summary.error} onRetry={summary.reload} />
      ) : (
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
          <CountTile label="Joints" value={s?.programme.weldCount ?? 0} />
          <CountTile label="Welded" value={s?.programme.weldedCount ?? 0} />
          <div className="rounded-lg border border-border bg-surface-raised p-3">
            <div className="text-label uppercase tracking-wide text-content-subtle">NDT coverage</div>
            <div className="mt-1 text-xl font-semibold tabular-nums text-content">
              {s?.programme.ndtCoverage.value === null || s === null ? (
                <span className="text-sm italic text-content-subtle">not available</span>
              ) : (
                `${num(s?.programme.ndtCoverage.value, 1)}%`
              )}
            </div>
            <ReasonList reasons={s?.programme.ndtCoverage.reasons ?? []} className="mt-1" />
          </div>
          <div className="rounded-lg border border-border bg-surface-raised p-3">
            <div className="text-label uppercase tracking-wide text-content-subtle">Repair rate</div>
            <div className="mt-1 text-xl font-semibold tabular-nums text-content">
              {s?.programme.repairRate.value === null || s === null ? (
                <span className="text-sm italic text-content-subtle">not available</span>
              ) : (
                `${num(s?.programme.repairRate.value, 1)}%`
              )}
            </div>
            <ReasonList reasons={s?.programme.repairRate.reasons ?? []} className="mt-1" />
          </div>
          <CountTile
            label="Qualifications lapsed"
            value={s?.qualifications.expired ?? 0}
            tone="danger"
            emphasis
            hint="Joints made after the lapse are unattributable."
          />
        </div>
      )}

      {s && s.programme.coverageShortfalls.length > 0 ? (
        <Alert
          tone="warning"
          title={`${s.programme.coverageShortfalls.length} ${plural(s.programme.coverageShortfalls.length, "joint")} short of the required examination`}
        >
          <p className="text-meta">
            {s.programme.coverageShortfalls.map((c) => c.reference).join(", ")}. A joint buried
            before it is examined cannot be examined at all.
          </p>
        </Alert>
      ) : null}

      {s && s.welderPerformance.length > 0 ? (
        <div className="rounded-md border border-border-subtle p-2.5">
          <div className="text-label uppercase tracking-wide text-content-subtle">
            Repair rate by welder
          </div>
          <ul className="mt-1 space-y-0.5 text-meta">
            {s.welderPerformance.map((w) => (
              <li key={w.welderQualificationId}>
                <span className="font-medium text-content">{w.welderName}</span>
                {w.welderStamp ? <span className="font-mono text-2xs"> ({w.welderStamp})</span> : null}{" "}
                <span className="text-content-muted">
                  {w.weldCount} {plural(w.weldCount, "joint")}, {w.examinedCount} examined —{" "}
                  {w.repairRate.value === null ? "rate unmeasured" : `${num(w.repairRate.value, 1)}% rejected`}
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-1 text-2xs text-content-subtle">
            Most codes raise the examination percentage for a welder over a threshold, and lower it
            again only once the rate comes back down. Without the rate per welder that rule cannot be
            operated.
          </p>
        </div>
      ) : null}

      <div className="grid gap-2 lg:grid-cols-2">
        <ProcedureList projectId={projectId} procedures={procedures} onMutated={onMutated} />
        <QualificationList projectId={projectId} quals={quals} onMutated={onMutated} />
      </div>

      {welds.error ? (
        <LoadError message={welds.error} onRetry={welds.reload} />
      ) : rows.length === 0 ? (
        <NothingHere
          title="The weld map is empty"
          reason="One row per joint, naming the procedure it was welded to and the welder who made it — so that when an examination rejects one, what else that welder made is a query rather than an afternoon."
        />
      ) : (
        <DataTable<Weld>
          tableId="quality-welds"
          data={rows}
          columns={columns}
          getRowId={(row) => row.id}
          height={420}
          stickyHeader
          zebra
          filterRow
          exportFileName="weld-map"
          searchPlaceholder="Search joints, heats"
          aria-label="Weld map"
          rowTone={(row) =>
            row.status === "rejected"
              ? "danger"
              : row.ndtRequiredPercent !== null && row.ndtRequiredPercent > 0 && row.ndtRecordCount === 0
                ? "warning"
                : undefined
          }
        />
      )}

      <WeldModal
        weldId={openId}
        projectId={projectId}
        onClose={() => setOpenId(null)}
        onMutated={() => {
          welds.reload();
          summary.reload();
          onMutated();
        }}
      />
    </div>
  );
}

function ProcedureList({
  projectId,
  procedures,
  onMutated,
}: {
  projectId: string;
  procedures: Resource<Paged<WeldingProcedure>>;
  onMutated: () => void;
}) {
  const { busy, refusal, clear, run } = useAction();
  const rows = procedures.data?.items ?? [];
  return (
    <div className="rounded-md border border-border-subtle p-2.5">
      <div className="text-label uppercase tracking-wide text-content-subtle">
        Welding procedures
      </div>
      <RefusalNotice refusal={refusal} onDismiss={clear} />
      {rows.length === 0 ? (
        <p className="mt-1 text-meta text-content-muted">
          None recorded. A joint that names no procedure cannot be shown to have been welded to the
          qualified one.
        </p>
      ) : (
        <ul className="mt-1 space-y-1">
          {rows.map((w) => (
            <li key={w.id} className="flex flex-wrap items-center gap-1.5 text-meta">
              <span className="font-mono text-2xs">{w.wpsNumber}</span>
              <Badge tone={w.status === "approved" ? "success" : "neutral"} size="xs" dot>
                {labelize(w.status)}
              </Badge>
              <span className="text-content-muted">{w.title}</span>
              <span className="text-2xs text-content-subtle">
                {w.process.toUpperCase()}
                {w.pqrReference ? ` · PQR ${w.pqrReference}` : " · no PQR"}
              </span>
              {w.status === "draft" ? (
                <Button
                  size="xs"
                  variant="ghost"
                  loading={busy === w.id}
                  onClick={async () => {
                    const done = await run(w.id, () =>
                      api.post(`/api/v1/projects/${projectId}/welding-procedures/${w.id}/approve`, {}),
                    );
                    if (done) {
                      procedures.reload();
                      onMutated();
                    }
                  }}
                >
                  Approve
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function QualificationList({
  projectId,
  quals,
  onMutated,
}: {
  projectId: string;
  quals: Resource<Paged<WelderQualification>>;
  onMutated: () => void;
}) {
  const { busy, refusal, clear, run } = useAction();
  const rows = quals.data?.items ?? [];
  return (
    <div className="rounded-md border border-border-subtle p-2.5">
      <div className="text-label uppercase tracking-wide text-content-subtle">
        Welder qualifications
      </div>
      <RefusalNotice refusal={refusal} onDismiss={clear} />
      {rows.length === 0 ? (
        <p className="mt-1 text-meta text-content-muted">
          None recorded. A qualification lapses on continuity as well as on date, and both end it.
        </p>
      ) : (
        <ul className="mt-1 space-y-1">
          {rows.map((q) => (
            <li key={q.id} className="text-meta">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="font-medium text-content">{q.welderName}</span>
                {q.welderStamp ? <span className="font-mono text-2xs">{q.welderStamp}</span> : null}
                <Badge
                  tone={
                    q.status === "valid"
                      ? "success"
                      : q.status === "expiring"
                        ? "warning"
                        : "danger"
                  }
                  size="xs"
                  dot
                >
                  {labelize(q.status)}
                </Badge>
                {q.status !== "valid" ? (
                  <Button
                    size="xs"
                    variant="ghost"
                    loading={busy === q.id}
                    onClick={async () => {
                      const done = await run(q.id, () =>
                        api.post(
                          `/api/v1/projects/${projectId}/welder-qualifications/${q.id}/confirm-continuity`,
                          {},
                        ),
                      );
                      if (done) {
                        quals.reload();
                        onMutated();
                      }
                    }}
                  >
                    Confirm continuity
                  </Button>
                ) : null}
              </div>
              <ReasonList reasons={q.standing?.reasons ?? []} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function WeldModal({
  weldId,
  projectId,
  onClose,
  onMutated,
}: {
  weldId: string | null;
  projectId: string;
  onClose: () => void;
  onMutated: () => void;
}) {
  const { busy, refusal, clear, run } = useAction();
  const [method, setMethod] = useState("rt");
  const base = `/api/v1/projects/${projectId}/welds/${weldId ?? ""}`;
  const weld = useResource<WeldDetail>((signal) => api.get<WeldDetail>(base, { signal }), [base], weldId !== null);
  if (!weldId) return null;
  const w = weld.data;

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={w ? `${w.reference}${w.jointReference ? ` — ${w.jointReference}` : ""}` : "Joint"}
      description="The procedure, the welder, and every examination of this joint."
      footer={
        <div className="flex justify-end">
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>
      }
    >
      {weld.error ? (
        <LoadError message={weld.error} onRetry={weld.reload} />
      ) : !w ? (
        <p className="text-meta text-content-muted">Loading…</p>
      ) : (
        <div className="space-y-3 text-meta">
          <RefusalNotice refusal={refusal} onDismiss={clear} />
          <div className="flex flex-wrap gap-1.5">
            <Badge tone={w.compliance.compliant ? "success" : "danger"} size="xs" dot>
              {w.compliance.compliant ? "within the qualified envelope" : "outside the envelope"}
            </Badge>
            <Badge tone="neutral" size="xs" variant="outline">
              {labelize(w.status)}
            </Badge>
            {w.welderQualification ? (
              <Badge tone="neutral" size="xs" variant="outline">
                {w.welderQualification.welderName}
              </Badge>
            ) : null}
            {w.wps ? (
              <Badge tone="neutral" size="xs" variant="outline">
                {w.wps.wpsNumber}
              </Badge>
            ) : null}
          </div>
          <ul className="space-y-1">
            {w.compliance.checks.map((c) => (
              <li key={c.name} className="rounded-md border border-border-subtle p-2">
                <div className="flex items-center gap-1.5">
                  <Badge
                    tone={c.passed === null ? "neutral" : c.passed ? "success" : "danger"}
                    size="xs"
                    dot
                  >
                    {c.passed === null ? "cannot be checked" : c.passed ? "met" : "not met"}
                  </Badge>
                  <span className="font-medium text-content">{c.name}</span>
                </div>
                <p className="mt-0.5 text-content-muted">{c.detail}</p>
              </li>
            ))}
          </ul>

          <div className="rounded-md border border-border-subtle p-2.5">
            <div className="text-label uppercase tracking-wide text-content-subtle">
              Examinations
            </div>
            {w.ndtRecords.length === 0 ? (
              <p className="mt-1 text-content-muted">
                None recorded
                {w.ndtRequiredPercent
                  ? ` — the specification requires ${w.ndtRequiredPercent}% of joints in this class to be examined.`
                  : "."}
              </p>
            ) : (
              <ul className="mt-1 space-y-1">
                {w.ndtRecords.map((r) => (
                  <li key={r.id} className="flex flex-wrap items-center gap-1.5">
                    <span className="font-mono text-2xs">{r.reference}</span>
                    <Badge tone="neutral" size="xs" variant="outline">
                      {r.method.toUpperCase()}
                    </Badge>
                    <Badge
                      tone={
                        r.result === "accept"
                          ? "success"
                          : r.result === "reject"
                            ? "danger"
                            : "warning"
                      }
                      size="xs"
                      dot
                    >
                      {labelize(r.result)}
                    </Badge>
                    <span className="text-2xs text-content-subtle">
                      {r.performedByOrganisation ?? "organisation not recorded"}
                      {r.technicianLevel ? ` · level ${r.technicianLevel}` : ""}
                    </span>
                    {r.defectType ? (
                      <span className="text-2xs text-danger">{r.defectType}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
            {w.weldedAt ? (
              <div className="mt-2 flex items-end gap-2">
                <Field label="Request an examination" className="w-40">
                  <Select value={method} onChange={(e) => setMethod(e.target.value)}>
                    {["vt", "pt", "mt", "rt", "ut", "paut", "hardness"].map((m) => (
                      <option key={m} value={m}>
                        {m.toUpperCase()}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Button
                  size="sm"
                  variant="secondary"
                  loading={busy === "ndt"}
                  onClick={async () => {
                    const done = await run("ndt", () => api.post(`${base}/ndt`, { method }));
                    if (done) {
                      weld.reload();
                      onMutated();
                    }
                  }}
                >
                  Request
                </Button>
              </div>
            ) : null}
          </div>
        </div>
      )}
    </Modal>
  );
}

/* ================================================================== */
/* Certificates                                                        */
/* ================================================================== */

function CertificatePanel({
  projectId,
  version,
  onMutated,
}: {
  projectId: string;
  version: number;
  onMutated: () => void;
}) {
  const base = `/api/v1/projects/${projectId}`;
  const { busy, refusal, clear, run } = useAction();
  const certificates = useResource<Paged<MaterialCertificate>>(
    (signal) =>
      api.get<Paged<MaterialCertificate>>(`${base}/material-certificates?page=1&pageSize=200`, {
        signal,
      }),
    [base, version],
  );
  const summary = useResource<CertificateSummary>(
    (signal) => api.get<CertificateSummary>(`${base}/material-certificates-summary`, { signal }),
    [base, version],
  );
  const rows = certificates.data?.items ?? [];
  const s = summary.data;

  const columns = useMemo<DataColumns<MaterialCertificate>>(
    () => [
      { id: "reference", header: "Ref", accessor: "reference", type: "text", sticky: "start", width: 110 },
      {
        id: "certificateNumber",
        header: "Certificate",
        accessor: "certificateNumber",
        type: "text",
        width: 150,
      },
      { id: "material", header: "Material", accessor: "materialDescription", type: "text", width: 240 },
      {
        id: "heat",
        header: "Heat / batch",
        accessor: (r) => r.heatNumber ?? r.batchNumber ?? "",
        type: "text",
        width: 150,
        cell: ({ row }) =>
          row.heatNumber || row.batchNumber || row.castNumber ? (
            <span className="font-mono text-2xs">
              {row.heatNumber ?? row.batchNumber ?? row.castNumber}
            </span>
          ) : (
            <Badge tone="danger" size="xs" variant="outline">
              untraceable
            </Badge>
          ),
      },
      {
        id: "type",
        header: "Type",
        accessor: "certificateType",
        type: "text",
        width: 150,
        cell: ({ row }) => (
          <Badge tone={row.check.lotTraceable ? "neutral" : "warning"} size="xs" variant="outline">
            {labelize(row.certificateType.replace("en_10204_", "EN 10204 "))}
          </Badge>
        ),
      },
      {
        id: "verification",
        header: "Verification",
        accessor: "verificationStatus",
        type: "text",
        width: 200,
        cell: ({ row }) => (
          <span className="flex items-center gap-1.5">
            <Badge
              tone={
                row.verificationStatus === "verified"
                  ? "success"
                  : row.verificationStatus === "failed"
                    ? "danger"
                    : "warning"
              }
              size="xs"
              dot
            >
              {labelize(row.verificationStatus)}
            </Badge>
            {row.verificationStatus === "unverified" && row.requiredProperties.length > 0 ? (
              <Button
                size="xs"
                variant="ghost"
                loading={busy === row.id}
                onClick={async () => {
                  const done = await run(row.id, () =>
                    api.post(`${base}/material-certificates/${row.id}/verify`, {}),
                  );
                  if (done) {
                    certificates.reload();
                    summary.reload();
                    onMutated();
                  }
                }}
              >
                Verify
              </Button>
            ) : null}
          </span>
        ),
      },
    ],
    [base, busy, certificates, onMutated, run, summary],
  );

  return (
    <div className="space-y-3">
      <RefusalNotice refusal={refusal} onDismiss={clear} />
      {summary.error ? (
        <LoadError message={summary.error} onRetry={summary.reload} />
      ) : (
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <CountTile label="Certificates" value={s?.total ?? 0} />
          <CountTile
            label="Nobody has read"
            value={s?.unverified ?? 0}
            tone="warning"
            emphasis
            hint="Filed is not verified."
          />
          <CountTile label="Fail the specification" value={s?.failed ?? 0} tone="danger" emphasis />
          <CountTile
            label="Not traceable to a lot"
            value={s?.untraceable ?? 0}
            tone="warning"
            emphasis
            hint="A 2.2 document is not specific to the delivered cast."
          />
        </div>
      )}
      {s ? <ReasonList reasons={s.reasons} /> : null}

      {certificates.error ? (
        <LoadError message={certificates.error} onRetry={certificates.reload} />
      ) : rows.length === 0 ? (
        <NothingHere
          title="No material test certificate is recorded"
          reason="The register holds the certificate and the act of reading it: somebody has to compare the yield strength on the mill certificate with the one the specification demanded, and record that they did."
        />
      ) : (
        <DataTable<MaterialCertificate>
          tableId="quality-certificates"
          data={rows}
          columns={columns}
          getRowId={(row) => row.id}
          height={460}
          stickyHeader
          zebra
          filterRow
          exportFileName="material-certificates"
          searchPlaceholder="Search certificates, heats"
          aria-label="Material test certificates"
          rowTone={(row) =>
            row.verificationStatus === "failed"
              ? "danger"
              : row.verificationStatus === "unverified"
                ? "warning"
                : undefined
          }
        />
      )}
    </div>
  );
}

/* ================================================================== */
/* Calibration                                                         */
/* ================================================================== */

function CalibrationPanel({
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
  const instruments = useResource<Paged<Instrument>>(
    (signal) => api.get<Paged<Instrument>>(`${base}/instruments?page=1&pageSize=200`, { signal }),
    [base, version],
  );
  const summary = useResource<InstrumentSummary>(
    (signal) => api.get<InstrumentSummary>(`${base}/instruments-summary`, { signal }),
    [base, version],
  );
  const rows = instruments.data?.items ?? [];
  const s = summary.data;

  const columns = useMemo<DataColumns<Instrument>>(
    () => [
      { id: "reference", header: "Ref", accessor: "reference", type: "text", sticky: "start", width: 100 },
      { id: "name", header: "Instrument", accessor: "name", type: "text", width: 220 },
      {
        id: "serial",
        header: "Serial",
        accessor: (r) => r.serialNumber ?? "",
        type: "text",
        width: 140,
        cell: ({ row }) => <span className="font-mono text-2xs">{row.serialNumber}</span>,
      },
      {
        id: "due",
        header: "Calibration due",
        accessor: (r) => r.calibrationDueDate ?? "",
        type: "text",
        width: 180,
        cell: ({ row }) => (
          <span className="text-2xs tabular-nums">
            {isoDate(row.calibrationDueDate)}
            {row.standing.daysUntilDue !== null ? (
              <span
                className={
                  row.standing.daysUntilDue < 0
                    ? "ml-1 font-semibold text-danger"
                    : row.standing.daysUntilDue <= 30
                      ? "ml-1 font-semibold text-warning"
                      : "ml-1 text-content-subtle"
                }
              >
                · {row.standing.daysUntilDue} {plural(Math.abs(row.standing.daysUntilDue), "day")}
              </span>
            ) : null}
          </span>
        ),
      },
      {
        id: "status",
        header: "Standing",
        accessor: (r) => r.standing.status,
        type: "text",
        width: 190,
        cell: ({ row }) => (
          <div className="py-0.5">
            <Badge
              tone={
                row.standing.status === "in_service"
                  ? "success"
                  : row.standing.status === "due_soon"
                    ? "warning"
                    : "danger"
              }
              size="xs"
              dot
            >
              {labelize(row.standing.status)}
            </Badge>
            {!row.standing.usable ? (
              <span className="ml-1 text-2xs font-semibold text-danger">not usable</span>
            ) : null}
          </div>
        ),
      },
      {
        id: "certificate",
        header: "Certificate",
        accessor: (r) => r.certificateNumber ?? "",
        type: "text",
        width: 160,
        cell: ({ row }) =>
          row.certificateNumber ? (
            <span className="text-2xs">{row.certificateNumber}</span>
          ) : (
            <Badge tone="warning" size="xs" variant="outline">
              none recorded
            </Badge>
          ),
      },
    ],
    [],
  );

  return (
    <div className="space-y-3">
      {summary.error ? (
        <LoadError message={summary.error} onRetry={summary.reload} />
      ) : (
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <CountTile label="Instruments" value={s?.total ?? 0} />
          <CountTile label="Out of calibration" value={s?.overdue ?? 0} tone="danger" emphasis />
          <CountTile label="Due within 30 days" value={s?.dueSoon ?? 0} tone="warning" emphasis />
          <CountTile
            label="Not usable today"
            value={s?.unusable ?? 0}
            tone="danger"
            emphasis
            hint="A reading taken with one of these is not a reading."
          />
        </div>
      )}

      <div className="flex justify-end">
        <Button size="sm" icon={IconPlus} onClick={() => setCreateOpen(true)}>
          Register an instrument
        </Button>
      </div>

      {instruments.error ? (
        <LoadError message={instruments.error} onRetry={instruments.reload} />
      ) : rows.length === 0 ? (
        <NothingHere
          title="No instrument is registered"
          reason="Commissioning already refuses a pass recorded on an out-of-calibration meter. That refusal is only as good as the dates behind it, which is what this register holds."
          action={
            <Button size="sm" icon={IconPlus} onClick={() => setCreateOpen(true)}>
              Register the first one
            </Button>
          }
        />
      ) : (
        <DataTable<Instrument>
          tableId="quality-instruments"
          data={rows}
          columns={columns}
          getRowId={(row) => row.id}
          height={420}
          stickyHeader
          zebra
          filterRow
          exportFileName="calibration-register"
          searchPlaceholder="Search instruments"
          aria-label="Calibration register"
          rowTone={(row) =>
            row.standing.status === "overdue"
              ? "danger"
              : row.standing.status === "due_soon"
                ? "warning"
                : undefined
          }
        />
      )}

      <CreateInstrument
        open={createOpen}
        projectId={projectId}
        onClose={() => setCreateOpen(false)}
        onCreated={() => {
          setCreateOpen(false);
          instruments.reload();
          summary.reload();
          onMutated();
        }}
      />
    </div>
  );
}

function CreateInstrument({
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
  const [serial, setSerial] = useState("");
  const [interval, setIntervalMonths] = useState("12");
  const [lastCalibrated, setLastCalibrated] = useState("");
  const [certificate, setCertificate] = useState("");

  async function create() {
    const months = Number(interval);
    const done = await run("create", () =>
      api.post(`/api/v1/projects/${projectId}/instruments`, {
        name: name.trim(),
        serialNumber: serial.trim(),
        calibrationIntervalMonths: Number.isFinite(months) ? Math.round(months) : 12,
        lastCalibratedAt: lastCalibrated === "" ? null : lastCalibrated,
        certificateNumber: certificate.trim() === "" ? null : certificate.trim(),
      }),
    );
    if (done) {
      setName("");
      setSerial("");
      setLastCalibrated("");
      setCertificate("");
      onCreated();
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Register an instrument"
      description="The due date is derived from the certificate and the interval, not typed in — so an instrument cannot quietly be given a date its certificate does not support."
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={busy === "create"}
            disabled={name.trim() === "" || serial.trim() === ""}
            onClick={create}
          >
            Register it
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <RefusalNotice refusal={refusal} onDismiss={clear} />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Instrument" required>
            <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </Field>
          <Field label="Serial number" required hint="How a reading is traced back to a certificate.">
            <Input value={serial} onChange={(e) => setSerial(e.target.value)} />
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Interval (months)">
            <Input
              type="number"
              value={interval}
              onChange={(e) => setIntervalMonths(e.target.value)}
            />
          </Field>
          <Field label="Last calibrated">
            <Input
              type="date"
              value={lastCalibrated}
              onChange={(e) => setLastCalibrated(e.target.value)}
            />
          </Field>
          <Field label="Certificate number">
            <Input value={certificate} onChange={(e) => setCertificate(e.target.value)} />
          </Field>
        </div>
        <p className="text-2xs text-content-subtle">
          An instrument with no calibration recorded is treated as overdue rather than as in service:
          nothing shows it was ever calibrated.
        </p>
      </div>
    </Modal>
  );
}
