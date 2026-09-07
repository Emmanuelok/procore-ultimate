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
  useReason,
  useResource,
  type Resource,
} from "./qualityShared";
import type {
  ConcretePour,
  ConcretePourDetail,
  ConcreteSummary,
  Instrument,
  InstrumentDetail,
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

/* ------------------------------------------------------------------ */
/* Vocabularies the API validates against — never free text in a form  */
/* ------------------------------------------------------------------ */

const WELD_PROCESSES = ["smaw", "gmaw", "fcaw", "gtaw", "saw", "esw", "stud", "resistance", "other"];
const NDT_METHODS = ["vt", "pt", "mt", "rt", "ut", "paut", "tofd", "et", "hardness", "ferrite", "leak"];
const CERTIFICATE_TYPES = [
  "en_10204_3_1",
  "en_10204_3_2",
  "en_10204_2_2",
  "en_10204_2_1",
  "mill_certificate",
  "conformity_declaration",
  "test_report",
  "other",
];
const CERTIFICATE_TYPE_LABEL: Record<string, string> = {
  en_10204_2_1: "EN 10204 2.1 — declaration of compliance (no test results)",
  en_10204_2_2: "EN 10204 2.2 — test report, NOT specific to the delivered lot",
  en_10204_3_1: "EN 10204 3.1 — manufacturer's certificate, lot specific",
  en_10204_3_2: "EN 10204 3.2 — countersigned by an independent inspector",
  mill_certificate: "Mill certificate",
  conformity_declaration: "Declaration of conformity",
  test_report: "Test report",
  other: "Other",
};
const CALIBRATION_RESULTS = ["pass", "adjusted", "fail", "limited_use"];
const INSTRUMENT_STATUSES = ["in_service", "out_of_service", "under_calibration", "lost", "retired"];

/** "a, b, c" or "a b c" → ["a","b","c"]; an empty box means "not recorded". */
function splitList(value: string): string[] {
  return value
    .split(/[,\n]+|\s{2,}/)
    .map((v) => v.trim())
    .filter((v) => v !== "");
}

/** A number box that has not been filled in is null — never 0. */
function numOrNull(value: string): number | null {
  if (value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

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
            <RecordPour
              base={base}
              onRecorded={() => {
                pour.reload();
                onMutated();
              }}
            />
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border-subtle p-2.5">
              <p className="text-2xs text-content-subtle">
                Poured {isoDate(p.pouredAt)}
                {p.slumpMm !== null ? ` · slump ${num(p.slumpMm, 0)} mm` : " · no slump recorded"}
                {p.batchNumbers && p.batchNumbers.length > 0
                  ? ` · batches ${p.batchNumbers.join(", ")}`
                  : " · no batch numbers recorded"}
              </p>
              <Button
                size="xs"
                variant="secondary"
                loading={busy === "assess"}
                onClick={async () => {
                  const done = await run("assess", () => api.post(`${base}/assess`, {}));
                  if (done) {
                    pour.reload();
                    onMutated();
                  }
                }}
              >
                Re-run the acceptance test
              </Button>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

/**
 * RECORDING THE POUR. Everything on this form is knowable for about two hours
 * and then only from this record — which is why the register refuses to let a
 * pour be "recorded" by ticking a box: the tickets, the fresh tests and the
 * ambient temperature are the pour.
 *
 * The pre-pour hold point is checked by the API, not here. If it is unreleased
 * the refusal names the point, and pouring anyway is a deliberate, reasoned act
 * (`proceedWithoutRelease`) rather than a silent one.
 */
function RecordPour({ base, onRecorded }: { base: string; onRecorded: () => void }) {
  const { busy, refusal, clear, run } = useAction();
  const [pouredAt, setPouredAt] = useState(new Date().toISOString().slice(0, 10));
  const [volume, setVolume] = useState("");
  const [slump, setSlump] = useState("");
  const [air, setAir] = useState("");
  const [concreteTemp, setConcreteTemp] = useState("");
  const [ambientTemp, setAmbientTemp] = useState("");
  const [batches, setBatches] = useState("");
  const [tickets, setTickets] = useState("");
  const [curing, setCuring] = useState("");
  const [proceed, setProceed] = useState(false);
  const [proceedReason, setProceedReason] = useState("");

  async function record() {
    const ticketRefs = splitList(tickets);
    const done = await run("pour", () =>
      api.post(`${base}/pour`, {
        pouredAt: `${pouredAt}T12:00:00.000Z`,
        volumeM3: numOrNull(volume),
        slumpMm: numOrNull(slump),
        airContentPct: numOrNull(air),
        concreteTempC: numOrNull(concreteTemp),
        ambientTempC: numOrNull(ambientTemp),
        batchNumbers: splitList(batches),
        deliveryTickets: ticketRefs.map((ticketNumber) => ({ ticketNumber })),
        curingMethod: curing.trim() === "" ? null : curing.trim(),
        ...(proceed
          ? { proceedWithoutRelease: true, proceedReason: proceedReason.trim() || null }
          : {}),
      }),
    );
    if (done) onRecorded();
  }

  return (
    <div className="rounded-md border border-warning/40 bg-warning/5 p-2.5">
      <div className="text-label uppercase tracking-wide text-content-subtle">Record the pour</div>
      <p className="mt-0.5 text-2xs text-content-subtle">
        Fresh tests and delivery tickets are knowable at the pour and never again. A pour recorded
        without them can be shown to have happened, but not to have complied.
      </p>
      <RefusalNotice refusal={refusal} onDismiss={clear} />
      <div className="mt-2 grid gap-2 sm:grid-cols-3">
        <Field label="Poured on" required>
          <Input type="date" value={pouredAt} onChange={(e) => setPouredAt(e.target.value)} />
        </Field>
        <Field label="Volume placed (m³)">
          <Input type="number" value={volume} onChange={(e) => setVolume(e.target.value)} />
        </Field>
        <Field label="Slump (mm)" hint="Judged against the specified window.">
          <Input type="number" value={slump} onChange={(e) => setSlump(e.target.value)} />
        </Field>
        <Field label="Air content (%)">
          <Input type="number" value={air} onChange={(e) => setAir(e.target.value)} />
        </Field>
        <Field label="Concrete temperature (°C)">
          <Input
            type="number"
            value={concreteTemp}
            onChange={(e) => setConcreteTemp(e.target.value)}
          />
        </Field>
        <Field label="Ambient temperature (°C)">
          <Input
            type="number"
            value={ambientTemp}
            onChange={(e) => setAmbientTemp(e.target.value)}
          />
        </Field>
      </div>
      <div className="mt-2 grid gap-2 sm:grid-cols-3">
        <Field label="Delivery tickets" hint="Comma separated.">
          <Input value={tickets} onChange={(e) => setTickets(e.target.value)} placeholder="T-4412, T-4413" />
        </Field>
        <Field label="Batch numbers" hint="Traceability back to the plant.">
          <Input value={batches} onChange={(e) => setBatches(e.target.value)} placeholder="B-9001" />
        </Field>
        <Field label="Curing method">
          <Input value={curing} onChange={(e) => setCuring(e.target.value)} placeholder="Polythene, 7 days" />
        </Field>
      </div>
      <label className="mt-2 flex items-start gap-2 text-2xs text-content-muted">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={proceed}
          onChange={(e) => setProceed(e.target.checked)}
        />
        <span>
          The pre-pour hold point is not released and the pour went ahead anyway. The API refuses
          otherwise; ticking this records the decision rather than hiding it.
        </span>
      </label>
      {proceed ? (
        <Field label="Why did the pour proceed?" required className="mt-1">
          <Textarea
            rows={2}
            value={proceedReason}
            onChange={(e) => setProceedReason(e.target.value)}
          />
        </Field>
      ) : null}
      <div className="mt-2 flex justify-end">
        <Button
          size="sm"
          variant="primary"
          loading={busy === "pour"}
          disabled={proceed && proceedReason.trim() === ""}
          onClick={record}
        >
          Record the pour
        </Button>
      </div>
    </div>
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

  const [createOpen, setCreateOpen] = useState(false);
  const rows = welds.data?.items ?? [];
  const s = summary.data;
  const procedureRows = procedures.data?.items ?? [];
  const qualRows = quals.data?.items ?? [];
  const reloadAll = () => {
    welds.reload();
    summary.reload();
    quals.reload();
    procedures.reload();
    onMutated();
  };

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

      <div className="flex justify-end">
        <Button size="sm" icon={IconPlus} onClick={() => setCreateOpen(true)}>
          Add a joint
        </Button>
      </div>

      {welds.error ? (
        <LoadError message={welds.error} onRetry={welds.reload} />
      ) : rows.length === 0 ? (
        <NothingHere
          title="The weld map is empty"
          reason="One row per joint, naming the procedure it was welded to and the welder who made it — so that when an examination rejects one, what else that welder made is a query rather than an afternoon."
          action={
            <Button size="sm" icon={IconPlus} onClick={() => setCreateOpen(true)}>
              Add the first joint
            </Button>
          }
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
        procedures={procedureRows}
        qualifications={qualRows}
        onClose={() => setOpenId(null)}
        onMutated={reloadAll}
      />
      <CreateWeld
        open={createOpen}
        projectId={projectId}
        procedures={procedureRows}
        onClose={() => setCreateOpen(false)}
        onCreated={() => {
          setCreateOpen(false);
          reloadAll();
        }}
      />
    </div>
  );
}

/**
 * A JOINT IS PLANNED BEFORE IT IS WELDED. The map row exists first — the
 * isometric, the material, the required examination percentage — so that the
 * welder and the procedure are recorded against something, and so that a joint
 * nobody welded is visible as an omission rather than absent.
 */
function CreateWeld({
  open,
  onClose,
  projectId,
  procedures,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  projectId: string;
  procedures: WeldingProcedure[];
  onCreated: () => void;
}) {
  const { busy, refusal, clear, run } = useAction();
  const [jointReference, setJointReference] = useState("");
  const [weldMapRef, setWeldMapRef] = useState("");
  const [jointType, setJointType] = useState("");
  const [isometricRef, setIsometricRef] = useState("");
  const [materialSpec, setMaterialSpec] = useState("");
  const [thickness, setThickness] = useState("");
  const [diameter, setDiameter] = useState("");
  const [heats, setHeats] = useState("");
  const [wpsId, setWpsId] = useState("");
  const [ndtPercent, setNdtPercent] = useState("");
  const [ndtMethods, setNdtMethods] = useState<string[]>([]);

  async function create() {
    const done = await run("create", () =>
      api.post(`/api/v1/projects/${projectId}/welds`, {
        jointReference: jointReference.trim() === "" ? null : jointReference.trim(),
        weldMapRef: weldMapRef.trim() === "" ? null : weldMapRef.trim(),
        jointType: jointType.trim() === "" ? null : jointType.trim(),
        isometricRef: isometricRef.trim() === "" ? null : isometricRef.trim(),
        materialSpec: materialSpec.trim() === "" ? null : materialSpec.trim(),
        thicknessMm: numOrNull(thickness),
        diameterMm: numOrNull(diameter),
        heatNumbers: splitList(heats),
        wpsId: wpsId === "" ? null : wpsId,
        ndtRequiredPercent: numOrNull(ndtPercent),
        ndtMethodsRequired: ndtMethods,
      }),
    );
    if (done) {
      setJointReference("");
      setWeldMapRef("");
      setHeats("");
      onCreated();
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add a joint to the weld map"
      description="The required examination percentage is recorded here because it is a specification fact, not an opinion formed later: a joint buried before it is examined cannot be examined at all."
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={busy === "create"}
            disabled={jointReference.trim() === "" && weldMapRef.trim() === ""}
            onClick={create}
          >
            Add the joint
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <RefusalNotice refusal={refusal} onDismiss={clear} />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Joint reference" hint="As it is called on the isometric.">
            <Input
              value={jointReference}
              onChange={(e) => setJointReference(e.target.value)}
              placeholder="FW-114"
              autoFocus
            />
          </Field>
          <Field label="Weld map reference">
            <Input value={weldMapRef} onChange={(e) => setWeldMapRef(e.target.value)} />
          </Field>
          <Field label="Joint type">
            <Input value={jointType} onChange={(e) => setJointType(e.target.value)} placeholder="Butt, full penetration" />
          </Field>
          <Field label="Isometric / line">
            <Input value={isometricRef} onChange={(e) => setIsometricRef(e.target.value)} />
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Material specification">
            <Input value={materialSpec} onChange={(e) => setMaterialSpec(e.target.value)} placeholder="P355NH" />
          </Field>
          <Field label="Thickness (mm)" hint="Checked against the qualified envelope.">
            <Input type="number" value={thickness} onChange={(e) => setThickness(e.target.value)} />
          </Field>
          <Field label="Diameter (mm)">
            <Input type="number" value={diameter} onChange={(e) => setDiameter(e.target.value)} />
          </Field>
        </div>
        <Field label="Heat numbers" hint="Comma separated — this is how a recall reaches the joint.">
          <Input value={heats} onChange={(e) => setHeats(e.target.value)} placeholder="H-4471, H-4472" />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Procedure (WPS)" hint="Approved procedures only; the API checks the envelope.">
            <Select value={wpsId} onChange={(e) => setWpsId(e.target.value)}>
              <option value="">Not yet decided</option>
              {procedures.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.wpsNumber} — {w.title}
                  {w.status === "approved" ? "" : ` (${w.status})`}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="NDT required (%)" hint="0 is a decision; blank is an unanswered question.">
            <Input type="number" value={ndtPercent} onChange={(e) => setNdtPercent(e.target.value)} />
          </Field>
        </div>
        <Field label="Required examination methods">
          <div className="flex flex-wrap gap-1.5">
            {NDT_METHODS.map((m) => (
              <label
                key={m}
                className="flex items-center gap-1 rounded-md border border-border-subtle px-1.5 py-0.5 text-2xs"
              >
                <input
                  type="checkbox"
                  checked={ndtMethods.includes(m)}
                  onChange={(e) =>
                    setNdtMethods((prev) =>
                      e.target.checked ? [...prev, m] : prev.filter((x) => x !== m),
                    )
                  }
                />
                {m.toUpperCase()}
              </label>
            ))}
          </div>
        </Field>
      </div>
    </Modal>
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
  const [createOpen, setCreateOpen] = useState(false);
  const rows = procedures.data?.items ?? [];
  return (
    <div className="rounded-md border border-border-subtle p-2.5">
      <div className="flex items-center justify-between gap-2">
        <div className="text-label uppercase tracking-wide text-content-subtle">
          Welding procedures
        </div>
        <Button size="xs" variant="ghost" icon={IconPlus} onClick={() => setCreateOpen(true)}>
          Add a WPS
        </Button>
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
      <CreateWps
        open={createOpen}
        projectId={projectId}
        onClose={() => setCreateOpen(false)}
        onCreated={() => {
          setCreateOpen(false);
          procedures.reload();
          onMutated();
        }}
      />
    </div>
  );
}

/**
 * A WPS is a range, not a document: process, material group, thickness and
 * diameter bounds. The joint is checked against those bounds, so a WPS filed
 * with no envelope can never confirm anything about a weld — which is why the
 * envelope fields are here rather than left to an attachment.
 */
function CreateWps({
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
  const [wpsNumber, setWpsNumber] = useState("");
  const [title, setTitle] = useState("");
  const [standard, setStandard] = useState("");
  const [process, setProcess] = useState("gtaw");
  const [baseMaterialGroup, setBaseMaterialGroup] = useState("");
  const [thicknessMin, setThicknessMin] = useState("");
  const [thicknessMax, setThicknessMax] = useState("");
  const [diameterMin, setDiameterMin] = useState("");
  const [diameterMax, setDiameterMax] = useState("");
  const [positions, setPositions] = useState("");
  const [pqr, setPqr] = useState("");

  async function create() {
    const done = await run("create", () =>
      api.post(`/api/v1/projects/${projectId}/welding-procedures`, {
        wpsNumber: wpsNumber.trim(),
        title: title.trim(),
        standard: standard.trim() === "" ? null : standard.trim(),
        process,
        baseMaterialGroup: baseMaterialGroup.trim() === "" ? null : baseMaterialGroup.trim(),
        thicknessMinMm: numOrNull(thicknessMin),
        thicknessMaxMm: numOrNull(thicknessMax),
        diameterMinMm: numOrNull(diameterMin),
        diameterMaxMm: numOrNull(diameterMax),
        positions: splitList(positions),
        pqrReference: pqr.trim() === "" ? null : pqr.trim(),
      }),
    );
    if (done) {
      setWpsNumber("");
      setTitle("");
      setPqr("");
      onCreated();
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add a welding procedure"
      description="Recorded as an envelope so a joint can be checked against it. A procedure with no PQR reference is a draft nobody qualified, and the register says so on the row."
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={busy === "create"}
            disabled={wpsNumber.trim() === "" || title.trim() === ""}
            onClick={create}
          >
            Add the procedure
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <RefusalNotice refusal={refusal} onDismiss={clear} />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="WPS number" required>
            <Input value={wpsNumber} onChange={(e) => setWpsNumber(e.target.value)} autoFocus />
          </Field>
          <Field label="Title" required>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Butt weld, P355NH, 8–20mm" />
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Process">
            <Select value={process} onChange={(e) => setProcess(e.target.value)}>
              {WELD_PROCESSES.map((p) => (
                <option key={p} value={p}>
                  {p.toUpperCase()}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Standard">
            <Input value={standard} onChange={(e) => setStandard(e.target.value)} placeholder="ISO 15614-1" />
          </Field>
          <Field label="PQR reference" hint="What qualified it.">
            <Input value={pqr} onChange={(e) => setPqr(e.target.value)} />
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Base material group">
            <Input
              value={baseMaterialGroup}
              onChange={(e) => setBaseMaterialGroup(e.target.value)}
              placeholder="1.2"
            />
          </Field>
          <Field label="Positions" hint="Comma separated, e.g. PA, PC, PF.">
            <Input value={positions} onChange={(e) => setPositions(e.target.value)} />
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-4">
          <Field label="Thickness min (mm)">
            <Input type="number" value={thicknessMin} onChange={(e) => setThicknessMin(e.target.value)} />
          </Field>
          <Field label="Thickness max (mm)">
            <Input type="number" value={thicknessMax} onChange={(e) => setThicknessMax(e.target.value)} />
          </Field>
          <Field label="Diameter min (mm)">
            <Input type="number" value={diameterMin} onChange={(e) => setDiameterMin(e.target.value)} />
          </Field>
          <Field label="Diameter max (mm)">
            <Input type="number" value={diameterMax} onChange={(e) => setDiameterMax(e.target.value)} />
          </Field>
        </div>
      </div>
    </Modal>
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
  const { ask, dialog } = useReason();
  const [createOpen, setCreateOpen] = useState(false);
  const rows = quals.data?.items ?? [];
  return (
    <div className="rounded-md border border-border-subtle p-2.5">
      <div className="flex items-center justify-between gap-2">
        <div className="text-label uppercase tracking-wide text-content-subtle">
          Welder qualifications
        </div>
        {dialog}
        <Button size="xs" variant="ghost" icon={IconPlus} onClick={() => setCreateOpen(true)}>
          Add a welder
        </Button>
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
                {q.status !== "suspended" && q.status !== "revoked" ? (
                  <Button
                    size="xs"
                    variant="ghost"
                    loading={busy === `suspend-${q.id}`}
                    onClick={async () => {
                      const reason = await ask({
                        title: `Suspend ${q.welderName}`,
                        description:
                          "A suspension stops this welder being recorded against new joints. It says nothing about the joints already made — those stay attributed, which is the point.",
                        label: "Why is the qualification suspended?",
                        confirmLabel: "Suspend it",
                        destructive: true,
                      });
                      if (!reason) return;
                      const done = await run(`suspend-${q.id}`, () =>
                        api.post(
                          `/api/v1/projects/${projectId}/welder-qualifications/${q.id}/suspend`,
                          { reason },
                        ),
                      );
                      if (done) {
                        quals.reload();
                        onMutated();
                      }
                    }}
                  >
                    Suspend
                  </Button>
                ) : null}
              </div>
              <ReasonList reasons={q.standing?.reasons ?? []} />
            </li>
          ))}
        </ul>
      )}
      <CreateQualification
        open={createOpen}
        projectId={projectId}
        onClose={() => setCreateOpen(false)}
        onCreated={() => {
          setCreateOpen(false);
          quals.reload();
          onMutated();
        }}
      />
    </div>
  );
}

/**
 * A qualification lapses on CONTINUITY as well as on date: a welder who has not
 * used the process for six months is no longer qualified in it whatever the
 * certificate says. Both dates are captured, because the register is asked
 * afterwards whether the person who made a joint was qualified on the day.
 */
function CreateQualification({
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
  const [welderName, setWelderName] = useState("");
  const [welderStamp, setWelderStamp] = useState("");
  const [certificateNumber, setCertificateNumber] = useState("");
  const [standard, setStandard] = useState("");
  const [processes, setProcesses] = useState<string[]>([]);
  const [positions, setPositions] = useState("");
  const [thicknessMin, setThicknessMin] = useState("");
  const [thicknessMax, setThicknessMax] = useState("");
  const [qualifiedFrom, setQualifiedFrom] = useState("");
  const [expiryDate, setExpiryDate] = useState("");
  const [continuityMonths, setContinuityMonths] = useState("6");

  async function create() {
    const months = numOrNull(continuityMonths);
    const done = await run("create", () =>
      api.post(`/api/v1/projects/${projectId}/welder-qualifications`, {
        welderName: welderName.trim(),
        welderStamp: welderStamp.trim() === "" ? null : welderStamp.trim(),
        certificateNumber: certificateNumber.trim() === "" ? null : certificateNumber.trim(),
        qualificationStandard: standard.trim() === "" ? null : standard.trim(),
        processes,
        positions: splitList(positions),
        thicknessMinMm: numOrNull(thicknessMin),
        thicknessMaxMm: numOrNull(thicknessMax),
        qualifiedFrom: qualifiedFrom === "" ? null : qualifiedFrom,
        expiryDate: expiryDate === "" ? null : expiryDate,
        ...(months !== null ? { continuityMonths: Math.round(months) } : {}),
      }),
    );
    if (done) {
      setWelderName("");
      setWelderStamp("");
      setCertificateNumber("");
      onCreated();
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Record a welder qualification"
      description="The stamp is what appears on the joint, so it is the field that makes a rejection traceable to everything else that welder made."
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={busy === "create"}
            disabled={welderName.trim() === ""}
            onClick={create}
          >
            Record it
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <RefusalNotice refusal={refusal} onDismiss={clear} />
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Welder" required>
            <Input value={welderName} onChange={(e) => setWelderName(e.target.value)} autoFocus />
          </Field>
          <Field label="Stamp" hint="As struck on the joint.">
            <Input value={welderStamp} onChange={(e) => setWelderStamp(e.target.value)} />
          </Field>
          <Field label="Certificate number">
            <Input
              value={certificateNumber}
              onChange={(e) => setCertificateNumber(e.target.value)}
            />
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Qualification standard">
            <Input value={standard} onChange={(e) => setStandard(e.target.value)} placeholder="ISO 9606-1" />
          </Field>
          <Field label="Positions" hint="Comma separated.">
            <Input value={positions} onChange={(e) => setPositions(e.target.value)} />
          </Field>
        </div>
        <Field label="Qualified processes">
          <div className="flex flex-wrap gap-1.5">
            {WELD_PROCESSES.map((pr) => (
              <label
                key={pr}
                className="flex items-center gap-1 rounded-md border border-border-subtle px-1.5 py-0.5 text-2xs"
              >
                <input
                  type="checkbox"
                  checked={processes.includes(pr)}
                  onChange={(e) =>
                    setProcesses((prev) =>
                      e.target.checked ? [...prev, pr] : prev.filter((x) => x !== pr),
                    )
                  }
                />
                {pr.toUpperCase()}
              </label>
            ))}
          </div>
        </Field>
        <div className="grid gap-3 sm:grid-cols-4">
          <Field label="Thickness min (mm)">
            <Input type="number" value={thicknessMin} onChange={(e) => setThicknessMin(e.target.value)} />
          </Field>
          <Field label="Thickness max (mm)">
            <Input type="number" value={thicknessMax} onChange={(e) => setThicknessMax(e.target.value)} />
          </Field>
          <Field label="Qualified from">
            <Input type="date" value={qualifiedFrom} onChange={(e) => setQualifiedFrom(e.target.value)} />
          </Field>
          <Field label="Expires">
            <Input type="date" value={expiryDate} onChange={(e) => setExpiryDate(e.target.value)} />
          </Field>
        </div>
        <Field
          label="Continuity period (months)"
          hint="A qualification lapses if the process is not used within this period, whatever the expiry date says."
        >
          <Input
            type="number"
            value={continuityMonths}
            onChange={(e) => setContinuityMonths(e.target.value)}
          />
        </Field>
      </div>
    </Modal>
  );
}

function WeldModal({
  weldId,
  projectId,
  procedures,
  qualifications,
  onClose,
  onMutated,
}: {
  weldId: string | null;
  projectId: string;
  procedures: WeldingProcedure[];
  qualifications: WelderQualification[];
  onClose: () => void;
  onMutated: () => void;
}) {
  const { busy, refusal, clear, run } = useAction();
  const [method, setMethod] = useState("rt");
  const [ndtOrganisation, setNdtOrganisation] = useState("");
  const [resultFor, setResultFor] = useState<string | null>(null);
  const [ndtResult, setNdtResult] = useState("accept");
  const [defectType, setDefectType] = useState("");
  const [reportNumber, setReportNumber] = useState("");
  const base = `/api/v1/projects/${projectId}/welds/${weldId ?? ""}`;
  const weld = useResource<WeldDetail>((signal) => api.get<WeldDetail>(base, { signal }), [base], weldId !== null);
  const reload = () => {
    weld.reload();
    onMutated();
  };
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
                    {r.result === "pending" ? (
                      resultFor === r.id ? (
                        <span className="flex flex-wrap items-end gap-1.5">
                          <Field label="Result" className="w-32">
                            <Select value={ndtResult} onChange={(e) => setNdtResult(e.target.value)}>
                              <option value="accept">Accept</option>
                              <option value="reject">Reject</option>
                              <option value="inconclusive">Inconclusive</option>
                            </Select>
                          </Field>
                          <Field label="Defect" className="w-40">
                            <Input
                              value={defectType}
                              onChange={(e) => setDefectType(e.target.value)}
                              placeholder="Lack of fusion"
                            />
                          </Field>
                          <Field label="Report no." className="w-32">
                            <Input
                              value={reportNumber}
                              onChange={(e) => setReportNumber(e.target.value)}
                            />
                          </Field>
                          <Button
                            size="xs"
                            variant="primary"
                            loading={busy === `ndt-result-${r.id}`}
                            onClick={async () => {
                              const done = await run(`ndt-result-${r.id}`, () =>
                                api.post(`${base}/ndt/${r.id}/result`, {
                                  result: ndtResult,
                                  defectType:
                                    ndtResult === "accept" || defectType.trim() === ""
                                      ? null
                                      : defectType.trim(),
                                  reportNumber:
                                    reportNumber.trim() === "" ? null : reportNumber.trim(),
                                }),
                              );
                              if (done) {
                                setResultFor(null);
                                setDefectType("");
                                setReportNumber("");
                                reload();
                              }
                            }}
                          >
                            Record
                          </Button>
                        </span>
                      ) : (
                        <Button size="xs" variant="ghost" onClick={() => setResultFor(r.id)}>
                          Record the examination result
                        </Button>
                      )
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
            {w.weldedAt ? (
              <div className="mt-2 flex flex-wrap items-end gap-2">
                <Field label="Request an examination" className="w-40">
                  <Select value={method} onChange={(e) => setMethod(e.target.value)}>
                    {NDT_METHODS.map((m) => (
                      <option key={m} value={m}>
                        {m.toUpperCase()}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Examining organisation" className="w-56">
                  <Input
                    value={ndtOrganisation}
                    onChange={(e) => setNdtOrganisation(e.target.value)}
                    placeholder="Who carries it out"
                  />
                </Field>
                <Button
                  size="sm"
                  variant="secondary"
                  loading={busy === "ndt"}
                  onClick={async () => {
                    const done = await run("ndt", () =>
                      api.post(`${base}/ndt`, {
                        method,
                        performedByOrganisation:
                          ndtOrganisation.trim() === "" ? null : ndtOrganisation.trim(),
                      }),
                    );
                    if (done) reload();
                  }}
                >
                  Request
                </Button>
              </div>
            ) : null}
          </div>

          <WeldLifecycle
            weld={w}
            base={base}
            qualifications={qualifications}
            procedures={procedures}
            onDone={reload}
          />
        </div>
      )}
    </Modal>
  );
}

/**
 * THE JOINT'S OWN LIFECYCLE: welded → visually inspected → examined → accepted,
 * or rejected and repaired. Each step names the person and the procedure,
 * because "the weld was fine" is not a record and a repair with no welder
 * against it re-creates the problem the map exists to solve.
 */
function WeldLifecycle({
  weld,
  base,
  qualifications,
  procedures,
  onDone,
}: {
  weld: WeldDetail;
  base: string;
  qualifications: WelderQualification[];
  procedures: WeldingProcedure[];
  onDone: () => void;
}) {
  const { busy, refusal, clear, run } = useAction();
  const [welderId, setWelderId] = useState(weld.welderQualificationId ?? "");
  const [wpsId, setWpsId] = useState(weld.wpsId ?? "");
  const [weldedAt, setWeldedAt] = useState(new Date().toISOString().slice(0, 10));
  const [heats, setHeats] = useState(weld.heatNumbers.join(", "));
  const [nonCompliant, setNonCompliant] = useState(false);
  const [nonComplianceReason, setNonComplianceReason] = useState("");
  const [visualNote, setVisualNote] = useState("");
  const [repairNote, setRepairNote] = useState("");
  const [cutOut, setCutOut] = useState(false);

  return (
    <div className="space-y-2">
      <RefusalNotice refusal={refusal} onDismiss={clear} />

      {!weld.weldedAt ? (
        <div className="rounded-md border border-border-subtle p-2.5">
          <div className="text-label uppercase tracking-wide text-content-subtle">
            Record the weld
          </div>
          <p className="mt-0.5 text-2xs text-content-subtle">
            The welder and the procedure are checked against the qualified envelope. A joint made
            outside it can still be recorded — knowingly, with a reason — because pretending it was
            compliant is worse than recording that it was not.
          </p>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            <Field label="Welder" required>
              <Select value={welderId} onChange={(e) => setWelderId(e.target.value)}>
                <option value="">Choose the welder</option>
                {qualifications.map((q) => (
                  <option key={q.id} value={q.id}>
                    {q.welderName}
                    {q.welderStamp ? ` (${q.welderStamp})` : ""} — {q.status}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Procedure (WPS)">
              <Select value={wpsId} onChange={(e) => setWpsId(e.target.value)}>
                <option value="">Use the one on the joint</option>
                {procedures.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.wpsNumber} — {p.title}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Welded on">
              <Input type="date" value={weldedAt} onChange={(e) => setWeldedAt(e.target.value)} />
            </Field>
            <Field label="Heat numbers" hint="Comma separated.">
              <Input value={heats} onChange={(e) => setHeats(e.target.value)} />
            </Field>
          </div>
          <label className="mt-2 flex items-start gap-2 text-2xs text-content-muted">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={nonCompliant}
              onChange={(e) => setNonCompliant(e.target.checked)}
            />
            <span>
              Record it even though it falls outside the qualified envelope. The API refuses
              otherwise, and the reason is stored on the joint.
            </span>
          </label>
          {nonCompliant ? (
            <Field label="Why was it welded outside the envelope?" required className="mt-1">
              <Textarea
                rows={2}
                value={nonComplianceReason}
                onChange={(e) => setNonComplianceReason(e.target.value)}
              />
            </Field>
          ) : null}
          <div className="mt-2 flex justify-end">
            <Button
              size="sm"
              variant="primary"
              loading={busy === "weld"}
              disabled={welderId === "" || (nonCompliant && nonComplianceReason.trim() === "")}
              onClick={async () => {
                const done = await run("weld", () =>
                  api.post(`${base}/weld`, {
                    welderQualificationId: welderId,
                    ...(wpsId === "" ? {} : { wpsId }),
                    weldedAt,
                    heatNumbers: splitList(heats),
                    ...(nonCompliant
                      ? {
                          recordNonCompliant: true,
                          nonComplianceReason: nonComplianceReason.trim(),
                        }
                      : {}),
                  }),
                );
                if (done) onDone();
              }}
            >
              Record the weld
            </Button>
          </div>
        </div>
      ) : null}

      {weld.weldedAt && weld.visualResult === null ? (
        <div className="rounded-md border border-border-subtle p-2.5">
          <div className="text-label uppercase tracking-wide text-content-subtle">
            Visual inspection
          </div>
          <p className="mt-0.5 text-2xs text-content-subtle">
            Every code requires the visual before any other examination; it is also the one that
            catches most of what is wrong.
          </p>
          <Field label="Note" className="mt-2">
            <Input
              value={visualNote}
              onChange={(e) => setVisualNote(e.target.value)}
              placeholder="Profile, undercut, spatter…"
            />
          </Field>
          <div className="mt-2 flex justify-end gap-2">
            <Button
              size="sm"
              variant="danger"
              loading={busy === "visual-reject"}
              onClick={async () => {
                const done = await run("visual-reject", () =>
                  api.post(`${base}/visual`, {
                    result: "reject",
                    note: visualNote.trim() === "" ? null : visualNote.trim(),
                  }),
                );
                if (done) onDone();
              }}
            >
              Reject
            </Button>
            <Button
              size="sm"
              variant="primary"
              loading={busy === "visual-accept"}
              onClick={async () => {
                const done = await run("visual-accept", () =>
                  api.post(`${base}/visual`, {
                    result: "accept",
                    note: visualNote.trim() === "" ? null : visualNote.trim(),
                  }),
                );
                if (done) onDone();
              }}
            >
              Accept
            </Button>
          </div>
        </div>
      ) : null}

      {weld.status === "rejected" ? (
        <div className="rounded-md border border-danger/40 bg-danger/5 p-2.5">
          <div className="text-label uppercase tracking-wide text-content-subtle">
            Repair or cut out
          </div>
          <p className="mt-0.5 text-2xs text-content-subtle">
            A repair is counted in the repair rate for this welder, which is what drives the
            examination percentage upwards. Cutting the joint out is not a repair: the joint was
            removed and re-made.
          </p>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            <Field label="Welder making the repair">
              <Select value={welderId} onChange={(e) => setWelderId(e.target.value)}>
                <option value="">Same as the original</option>
                {qualifications.map((q) => (
                  <option key={q.id} value={q.id}>
                    {q.welderName}
                    {q.welderStamp ? ` (${q.welderStamp})` : ""}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Note">
              <Input value={repairNote} onChange={(e) => setRepairNote(e.target.value)} />
            </Field>
          </div>
          <label className="mt-2 flex items-center gap-2 text-2xs text-content-muted">
            <input type="checkbox" checked={cutOut} onChange={(e) => setCutOut(e.target.checked)} />
            The joint was cut out and re-made rather than repaired.
          </label>
          <div className="mt-2 flex justify-end">
            <Button
              size="sm"
              variant="primary"
              loading={busy === "repair"}
              onClick={async () => {
                const done = await run("repair", () =>
                  api.post(`${base}/repair`, {
                    ...(welderId === "" ? {} : { welderQualificationId: welderId }),
                    cutOut,
                    note: repairNote.trim() === "" ? null : repairNote.trim(),
                  }),
                );
                if (done) onDone();
              }}
            >
              {cutOut ? "Record the cut-out" : "Record the repair"}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
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
  const [createOpen, setCreateOpen] = useState(false);
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

      <div className="flex justify-end">
        <Button size="sm" icon={IconPlus} onClick={() => setCreateOpen(true)}>
          File a certificate
        </Button>
      </div>

      {certificates.error ? (
        <LoadError message={certificates.error} onRetry={certificates.reload} />
      ) : rows.length === 0 ? (
        <NothingHere
          title="No material test certificate is recorded"
          reason="The register holds the certificate and the act of reading it: somebody has to compare the yield strength on the mill certificate with the one the specification demanded, and record that they did."
          action={
            <Button size="sm" icon={IconPlus} onClick={() => setCreateOpen(true)}>
              File the first one
            </Button>
          }
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

      <CreateCertificate
        open={createOpen}
        projectId={projectId}
        onClose={() => setCreateOpen(false)}
        onCreated={() => {
          setCreateOpen(false);
          certificates.reload();
          summary.reload();
          onMutated();
        }}
      />
    </div>
  );
}

/**
 * FILING A CERTIFICATE is two acts, and the form keeps them apart: what the
 * SPECIFICATION demands, and what the CERTIFICATE says. Verification then
 * compares the two and is refused to the person who filed it. Without the
 * required properties there is nothing to compare, so the register would hold a
 * PDF and call it evidence.
 */
function CreateCertificate({
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
  const [certificateNumber, setCertificateNumber] = useState("");
  const [certificateType, setCertificateType] = useState("en_10204_3_1");
  const [materialDescription, setMaterialDescription] = useState("");
  const [materialGrade, setMaterialGrade] = useState("");
  const [standard, setStandard] = useState("");
  const [heatNumber, setHeatNumber] = useState("");
  const [batchNumber, setBatchNumber] = useState("");
  const [manufacturer, setManufacturer] = useState("");
  const [quantity, setQuantity] = useState("");
  const [unit, setUnit] = useState("");
  const [issuedAt, setIssuedAt] = useState("");
  const [properties, setProperties] = useState<
    Array<{ property: string; min: string; max: string; measured: string; unit: string }>
  >([{ property: "", min: "", max: "", measured: "", unit: "" }]);

  const filled = properties.filter((p) => p.property.trim() !== "");

  async function create() {
    const done = await run("create", () =>
      api.post(`/api/v1/projects/${projectId}/material-certificates`, {
        certificateNumber: certificateNumber.trim(),
        certificateType,
        materialDescription: materialDescription.trim(),
        materialGrade: materialGrade.trim() === "" ? null : materialGrade.trim(),
        standard: standard.trim() === "" ? null : standard.trim(),
        heatNumber: heatNumber.trim() === "" ? null : heatNumber.trim(),
        batchNumber: batchNumber.trim() === "" ? null : batchNumber.trim(),
        manufacturer: manufacturer.trim() === "" ? null : manufacturer.trim(),
        quantity: numOrNull(quantity),
        unit: unit.trim() === "" ? null : unit.trim(),
        issuedAt: issuedAt === "" ? null : issuedAt,
        requiredProperties: filled.map((p) => ({
          property: p.property.trim(),
          min: numOrNull(p.min),
          max: numOrNull(p.max),
          unit: p.unit.trim() === "" ? null : p.unit.trim(),
        })),
        measuredProperties: filled
          .filter((p) => p.measured.trim() !== "")
          .map((p) => ({
            property: p.property.trim(),
            value: numOrNull(p.measured),
            unit: p.unit.trim() === "" ? null : p.unit.trim(),
          })),
      }),
    );
    if (done) {
      setCertificateNumber("");
      setMaterialDescription("");
      setHeatNumber("");
      setBatchNumber("");
      setProperties([{ property: "", min: "", max: "", measured: "", unit: "" }]);
      onCreated();
    }
  }

  function setRow(index: number, patch: Partial<(typeof properties)[number]>) {
    setProperties((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title="File a material test certificate"
      description="A 2.2 document is a test report on the grade, not on the delivered cast; a 3.1 is specific to the lot and a 3.2 is countersigned by somebody independent. The register records which one arrived, because the three are not interchangeable."
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={busy === "create"}
            disabled={certificateNumber.trim() === "" || materialDescription.trim() === ""}
            onClick={create}
          >
            File it
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <RefusalNotice refusal={refusal} onDismiss={clear} />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Certificate number" required>
            <Input
              value={certificateNumber}
              onChange={(e) => setCertificateNumber(e.target.value)}
              autoFocus
            />
          </Field>
          <Field label="Document type" hint="Traceability to the delivered lot depends on it.">
            <Select value={certificateType} onChange={(e) => setCertificateType(e.target.value)}>
              {CERTIFICATE_TYPES.map((t) => (
                <option key={t} value={t}>
                  {CERTIFICATE_TYPE_LABEL[t] ?? labelize(t)}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="Material" required>
          <Input
            value={materialDescription}
            onChange={(e) => setMaterialDescription(e.target.value)}
            placeholder="S355J2 plate, 20mm"
          />
        </Field>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Grade">
            <Input value={materialGrade} onChange={(e) => setMaterialGrade(e.target.value)} />
          </Field>
          <Field label="Standard">
            <Input value={standard} onChange={(e) => setStandard(e.target.value)} placeholder="EN 10025-2" />
          </Field>
          <Field label="Manufacturer / mill">
            <Input value={manufacturer} onChange={(e) => setManufacturer(e.target.value)} />
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-4">
          <Field label="Heat / cast number" hint="What a recall is traced by.">
            <Input value={heatNumber} onChange={(e) => setHeatNumber(e.target.value)} />
          </Field>
          <Field label="Batch number">
            <Input value={batchNumber} onChange={(e) => setBatchNumber(e.target.value)} />
          </Field>
          <Field label="Quantity">
            <Input type="number" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
          </Field>
          <Field label="Unit">
            <Input value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="t" />
          </Field>
        </div>
        <Field label="Issued">
          <Input type="date" value={issuedAt} onChange={(e) => setIssuedAt(e.target.value)} />
        </Field>

        <div className="rounded-md border border-border-subtle p-2.5">
          <div className="text-label uppercase tracking-wide text-content-subtle">
            What the specification demands, and what the certificate says
          </div>
          <p className="mt-0.5 text-2xs text-content-subtle">
            Verification compares the two, so a certificate filed with no required properties can
            never be verified — it can only be stored.
          </p>
          <div className="mt-2 space-y-2">
            {properties.map((row, i) => (
              <div key={i} className="grid gap-2 sm:grid-cols-5">
                <Field label={i === 0 ? "Property" : ""}>
                  <Input
                    value={row.property}
                    onChange={(e) => setRow(i, { property: e.target.value })}
                    placeholder="Yield strength"
                  />
                </Field>
                <Field label={i === 0 ? "Min" : ""}>
                  <Input
                    type="number"
                    value={row.min}
                    onChange={(e) => setRow(i, { min: e.target.value })}
                  />
                </Field>
                <Field label={i === 0 ? "Max" : ""}>
                  <Input
                    type="number"
                    value={row.max}
                    onChange={(e) => setRow(i, { max: e.target.value })}
                  />
                </Field>
                <Field label={i === 0 ? "Measured" : ""}>
                  <Input
                    type="number"
                    value={row.measured}
                    onChange={(e) => setRow(i, { measured: e.target.value })}
                  />
                </Field>
                <Field label={i === 0 ? "Unit" : ""}>
                  <Input value={row.unit} onChange={(e) => setRow(i, { unit: e.target.value })} />
                </Field>
              </div>
            ))}
          </div>
          <Button
            size="xs"
            variant="ghost"
            icon={IconPlus}
            className="mt-1"
            onClick={() =>
              setProperties((prev) => [
                ...prev,
                { property: "", min: "", max: "", measured: "", unit: "" },
              ])
            }
          >
            Add a property
          </Button>
        </div>
      </div>
    </Modal>
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
  const [openId, setOpenId] = useState<string | null>(null);
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
      <InstrumentModal
        instrumentId={openId}
        projectId={projectId}
        onClose={() => setOpenId(null)}
        onMutated={() => {
          instruments.reload();
          summary.reload();
          onMutated();
        }}
      />
    </div>
  );
}

/**
 * ONE INSTRUMENT, its certificates and its standing.
 *
 * Recording a calibration is the only way an instrument comes back into
 * service after a failure: the API refuses a bare status change, because an
 * instrument returned to service on somebody's say-so reads afterwards as a
 * calibrated one, and every reading taken with it inherits a certificate that
 * does not exist.
 */
function InstrumentModal({
  instrumentId,
  projectId,
  onClose,
  onMutated,
}: {
  instrumentId: string | null;
  projectId: string;
  onClose: () => void;
  onMutated: () => void;
}) {
  const { busy, refusal, clear, run } = useAction();
  const base = `/api/v1/projects/${projectId}/instruments/${instrumentId ?? ""}`;
  const instrument = useResource<InstrumentDetail>(
    (signal) => api.get<InstrumentDetail>(base, { signal }),
    [base],
    instrumentId !== null,
  );
  const [calibratedAt, setCalibratedAt] = useState(new Date().toISOString().slice(0, 10));
  const [result, setResult] = useState("pass");
  const [certificateNumber, setCertificateNumber] = useState("");
  const [organisation, setOrganisation] = useState("");
  const [technician, setTechnician] = useState("");
  const [asFound, setAsFound] = useState("");
  const [asLeft, setAsLeft] = useState("");
  const [status, setStatus] = useState("out_of_service");
  const [statusReason, setStatusReason] = useState("");
  if (!instrumentId) return null;
  const row = instrument.data;

  const reload = () => {
    instrument.reload();
    onMutated();
  };

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={row ? `${row.reference} — ${row.name}` : "Instrument"}
      description="Its certificates, its standing today, and the two acts that change either."
      footer={
        <div className="flex justify-end">
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>
      }
    >
      {instrument.error ? (
        <LoadError message={instrument.error} onRetry={instrument.reload} />
      ) : !row ? (
        <p className="text-meta text-content-muted">Loading…</p>
      ) : (
        <div className="space-y-3 text-meta">
          <RefusalNotice refusal={refusal} onDismiss={clear} />
          <div className="flex flex-wrap items-center gap-1.5">
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
              <Badge tone="danger" size="xs" variant="solid">
                not usable for a reading today
              </Badge>
            ) : null}
            <span className="font-mono text-2xs">{row.serialNumber}</span>
            <span className="text-2xs text-content-subtle">
              due {isoDate(row.calibrationDueDate)} · every {row.calibrationIntervalMonths} months
            </span>
          </div>
          <ReasonList reasons={row.standing.reasons} />
          {row.outOfServiceReason ? (
            <Alert tone="warning" title="Out of service">
              {row.outOfServiceReason}
            </Alert>
          ) : null}

          <div className="rounded-md border border-border-subtle p-2.5">
            <div className="text-label uppercase tracking-wide text-content-subtle">
              Calibration history
            </div>
            {row.history.length === 0 ? (
              <p className="mt-1 text-content-muted">
                None recorded. An instrument with no calibration behind it is treated as overdue
                rather than as in service, because nothing shows it was ever calibrated.
              </p>
            ) : (
              <ul className="mt-1 space-y-1">
                {row.history.map((h) => (
                  <li key={h.id} className="flex flex-wrap items-center gap-1.5">
                    <span className="tabular-nums">{isoDate(h.calibratedAt)}</span>
                    <Badge
                      tone={
                        h.result === "pass"
                          ? "success"
                          : h.result === "fail"
                            ? "danger"
                            : "warning"
                      }
                      size="xs"
                      dot
                    >
                      {labelize(h.result)}
                    </Badge>
                    <span className="text-2xs text-content-subtle">
                      {h.certificateNumber ?? "no certificate number"}
                      {h.calibratedByOrganisation ? ` · ${h.calibratedByOrganisation}` : ""}
                      {h.calibrationDueDate ? ` · next due ${isoDate(h.calibrationDueDate)}` : ""}
                    </span>
                    {h.asFoundCondition ? (
                      <span className="text-2xs text-content-muted">
                        as found: {h.asFoundCondition}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="rounded-md border border-border-subtle p-2.5">
            <div className="text-label uppercase tracking-wide text-content-subtle">
              Record a calibration
            </div>
            <p className="mt-0.5 text-2xs text-content-subtle">
              A FAIL takes the instrument out of service and names the window of readings its
              failure puts in doubt — which is the answer to the question an auditor actually asks.
            </p>
            <div className="mt-2 grid gap-2 sm:grid-cols-3">
              <Field label="Calibrated on" required>
                <Input
                  type="date"
                  value={calibratedAt}
                  onChange={(e) => setCalibratedAt(e.target.value)}
                />
              </Field>
              <Field label="Result">
                <Select value={result} onChange={(e) => setResult(e.target.value)}>
                  {CALIBRATION_RESULTS.map((r) => (
                    <option key={r} value={r}>
                      {labelize(r)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Certificate number">
                <Input
                  value={certificateNumber}
                  onChange={(e) => setCertificateNumber(e.target.value)}
                />
              </Field>
              <Field label="Calibrated by">
                <Input value={organisation} onChange={(e) => setOrganisation(e.target.value)} />
              </Field>
              <Field label="Technician">
                <Input value={technician} onChange={(e) => setTechnician(e.target.value)} />
              </Field>
              <Field label="As found" hint="What the instrument read before adjustment.">
                <Input value={asFound} onChange={(e) => setAsFound(e.target.value)} />
              </Field>
            </div>
            <Field label="As left" className="mt-2">
              <Input value={asLeft} onChange={(e) => setAsLeft(e.target.value)} />
            </Field>
            <div className="mt-2 flex justify-end">
              <Button
                size="sm"
                variant="primary"
                loading={busy === "calibrate"}
                onClick={async () => {
                  const done = await run("calibrate", () =>
                    api.post(`${base}/calibrate`, {
                      calibratedAt,
                      result,
                      certificateNumber:
                        certificateNumber.trim() === "" ? null : certificateNumber.trim(),
                      calibratedByOrganisation:
                        organisation.trim() === "" ? null : organisation.trim(),
                      technicianName: technician.trim() === "" ? null : technician.trim(),
                      asFoundCondition: asFound.trim() === "" ? null : asFound.trim(),
                      asLeftCondition: asLeft.trim() === "" ? null : asLeft.trim(),
                    }),
                  );
                  if (done) {
                    setCertificateNumber("");
                    setAsFound("");
                    setAsLeft("");
                    reload();
                  }
                }}
              >
                Record the calibration
              </Button>
            </div>
          </div>

          <div className="rounded-md border border-border-subtle p-2.5">
            <div className="text-label uppercase tracking-wide text-content-subtle">
              Change its standing
            </div>
            <p className="mt-0.5 text-2xs text-content-subtle">
              Withdrawing an instrument affects every reading it was used for, so it carries a
              reason. Returning one to service after a failed calibration is refused: record the
              passing calibration instead.
            </p>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              <Field label="Standing">
                <Select value={status} onChange={(e) => setStatus(e.target.value)}>
                  {INSTRUMENT_STATUSES.map((st) => (
                    <option key={st} value={st}>
                      {labelize(st)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Reason" hint="Required for anything but a return to service.">
                <Input value={statusReason} onChange={(e) => setStatusReason(e.target.value)} />
              </Field>
            </div>
            <div className="mt-2 flex justify-end">
              <Button
                size="sm"
                variant="secondary"
                loading={busy === "status"}
                disabled={status !== "in_service" && statusReason.trim() === ""}
                onClick={async () => {
                  const done = await run("status", () =>
                    api.post(`${base}/status`, {
                      status,
                      reason: statusReason.trim() === "" ? null : statusReason.trim(),
                    }),
                  );
                  if (done) {
                    setStatusReason("");
                    reload();
                  }
                }}
              >
                Record it
              </Button>
            </div>
          </div>
        </div>
      )}
    </Modal>
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
