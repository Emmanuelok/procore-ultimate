/**
 * ONE COMMISSIONING SYSTEM — its place in the tree, its readiness gate, and
 * the test records that prove it works.
 *
 * Two facts on a test record are worth more than the result itself, and both
 * are given their own space here:
 *
 *   THE WITNESS      a contractor's own signature on its own test is not
 *                    evidence; a second party watching it is. Third-party
 *                    witnesses — an insurer's engineer, a certifying authority
 *                    — are frequently not platform users, so they are recorded
 *                    by name and organisation and shown as such.
 *   THE INSTRUMENTS  a reading taken with an out-of-calibration meter is not a
 *                    reading, and it is the first thing an auditor checks. The
 *                    API refuses a pass recorded on an expired instrument; this
 *                    screen shows the calibration dates so it does not come as
 *                    a surprise at handover.
 *
 * Readings carry their own expected value and window, and are drawn against
 * them rather than reduced to a tick.
 */
import { useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Drawer,
  Field,
  Input,
  Modal,
  Select,
  Skeleton,
  Textarea,
} from "../../ui";
import { cx } from "../../ui/cx";
import { toneClass, type Tone } from "../../ui/tokens";
import { api } from "../../lib/api";
import {
  CX_LADDER,
  CX_STATUS_TONE,
  EM_DASH,
  Facts,
  LoadError,
  NothingHere,
  ReasonList,
  RefusalNotice,
  SectionTitle,
  TONE_RAIL,
  TEST_RESULT_TONE,
  TEST_STATUS_TONE,
  dateTime,
  isoDate,
  labelize,
  nameOf,
  num,
  plural,
  todayIso,
  useAction,
  useResource,
} from "./qualityShared";
import type { CxReading, CxSystemDetail, CxTest } from "./types";

const TEST_KINDS = [
  "prefunctional_checklist",
  "static_completion",
  "energisation",
  "loop_check",
  "pressure_test",
  "leak_test",
  "insulation_resistance",
  "earth_continuity",
  "flushing_and_chlorination",
  "functional_performance",
  "integrated_systems",
  "seasonal",
  "air_balance",
  "water_balance",
  "fire_alarm_verification",
  "energy_verification",
  "acoustic",
  "retest",
];

const TEST_RESULTS = ["pass", "pass_with_deficiencies", "fail", "aborted", "not_applicable"];

export default function SystemDrawer({
  systemId,
  projectId,
  users,
  onClose,
  onMutated,
}: {
  systemId: string | null;
  projectId: string;
  users: Map<string, string>;
  onClose: () => void;
  onMutated: () => void;
}) {
  const [nonce, setNonce] = useState(0);
  const detail = useResource<CxSystemDetail>(
    (signal) =>
      api.get<CxSystemDetail>(
        `/api/v1/projects/${projectId}/commissioning/systems/${systemId}`,
        { signal },
      ),
    [projectId, systemId, nonce],
    systemId !== null,
  );

  function refresh() {
    setNonce((n) => n + 1);
    onMutated();
  }

  return (
    <Drawer
      open={systemId !== null}
      onClose={onClose}
      size="xl"
      title={detail.data ? `${detail.data.systemCode} · ${detail.data.name}` : "Commissioning system"}
      description={
        detail.data
          ? `${labelize(detail.data.level)} · ${labelize(detail.data.status)}`
          : undefined
      }
      resizable
      resizeStorageKey="quality.system.drawer"
    >
      {systemId === null ? null : detail.error ? (
        <div className="p-4">
          <LoadError
            message={detail.error}
            onRetry={detail.reload}
            title="This system could not be loaded"
          />
        </div>
      ) : detail.loading && !detail.data ? (
        <div className="space-y-3 p-4">
          <Skeleton height={120} />
          <Skeleton height={180} />
          <Skeleton height={180} />
        </div>
      ) : detail.data ? (
        <SystemBody system={detail.data} projectId={projectId} users={users} onMutated={refresh} />
      ) : null}
    </Drawer>
  );
}

/* ================================================================== */

function SystemBody({
  system,
  projectId,
  users,
  onMutated,
}: {
  system: CxSystemDetail;
  projectId: string;
  users: Map<string, string>;
  onMutated: () => void;
}) {
  const { busy, refusal, clear, run } = useAction();
  const [addOpen, setAddOpen] = useState(false);

  const readiness = system.functionalReadiness;
  const pre = system.testRecords.filter((t) => t.phase === "prefunctional");
  const functional = system.testRecords.filter((t) => t.phase === "functional");
  const unclassified = system.testRecords.filter(
    (t) => t.phase !== "prefunctional" && t.phase !== "functional",
  );

  async function accept() {
    const done = await run("accept", () =>
      api.post(`/api/v1/projects/${projectId}/commissioning/systems/${system.id}/accept`, {}),
    );
    if (done) onMutated();
  }

  return (
    <div className="space-y-5 p-4">
      <RefusalNotice refusal={refusal} onDismiss={clear} />

      {/* -------- the gate -------- */}
      <section className="space-y-2.5">
        <SectionTitle
          title="Readiness for functional testing"
          hint="The ladder is a gate, not a label. This is the API's own answer, not a guess."
        />
        {readiness.allowed ? (
          <Alert tone="success" variant="subtle" title="Pre-functional checks are complete">
            Functional testing may proceed on {system.systemCode}.
          </Alert>
        ) : (
          <Alert tone="warning" title="Functional testing is not yet permitted on this system">
            <ReasonList reasons={readiness.blockers} className="text-content-muted" />
          </Alert>
        )}
        <Ladder status={system.status} />
      </section>

      {/* -------- the system -------- */}
      <section className="space-y-2.5">
        <SectionTitle title="The system" />
        <Facts
          columns={3}
          items={[
            { label: "Code", value: <span className="font-mono">{system.systemCode}</span> },
            { label: "Reference", value: <span className="font-mono">{system.reference}</span> },
            { label: "Level", value: labelize(system.level) },
            { label: "Discipline", value: system.discipline ? labelize(system.discipline) : "not stated" },
            {
              label: "Twin asset",
              value: system.assetId ?? "not bound",
              hint: system.assetId
                ? "Commissioning hands over into this asset rather than into a second register."
                : "Nothing to hand over into. Register the asset in the twin before acceptance.",
            },
            {
              label: "IFC element bindings",
              value:
                system.ifcGlobalIds.length === 0
                  ? "none"
                  : `${system.ifcGlobalIds.length} ${plural(system.ifcGlobalIds.length, "GUID")}`,
            },
            {
              label: "Cx agent",
              value: system.cxAgentId ? nameOf(users, system.cxAgentId) : "not nominated",
              hint: "Acceptance is refused to the Cx agent who tested it.",
            },
            {
              label: "Complete",
              value: `${num(system.percentComplete, 0)}%`,
            },
            {
              label: "Open deficiencies",
              value: String(system.openDeficiencies.count),
              hint:
                system.openDeficiencies.count > 0
                  ? `${system.openDeficiencies.punchItemIds.length} punch ${plural(system.openDeficiencies.punchItemIds.length, "item")}, ${system.openDeficiencies.ncrIds.length} ${plural(system.openDeficiencies.ncrIds.length, "NCR")}`
                  : undefined,
            },
            {
              label: "Planned energisation",
              value: system.plannedEnergisation ? isoDate(system.plannedEnergisation) : "no date",
            },
            {
              label: "Planned completion",
              value: system.plannedCompletionDate ? isoDate(system.plannedCompletionDate) : "no date",
            },
            {
              label: "Accepted",
              value: system.acceptedAt ? dateTime(system.acceptedAt) : "not accepted",
              hint: system.acceptedBy ? `by ${nameOf(users, system.acceptedBy)}` : undefined,
            },
          ]}
        />
        {system.description ? (
          <p className="whitespace-pre-wrap text-meta text-content-muted">{system.description}</p>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="primary"
            loading={busy === "accept"}
            disabled={!["functional_complete", "seasonal_pending"].includes(system.status)}
            onClick={accept}
          >
            Accept the system
          </Button>
          <span className="text-2xs text-content-subtle">
            Owner acceptance — never the Cx agent who tested it, and only once functional testing is
            complete. Accepting earlier accepts a system nobody has finished proving.
          </span>
        </div>
      </section>

      {/* -------- children -------- */}
      {system.children.length > 0 ? (
        <section className="space-y-2">
          <SectionTitle title={`Sits above ${system.children.length} ${plural(system.children.length, "system")}`} />
          <ul className="flex flex-wrap gap-1.5">
            {system.children.map((child) => (
              <li key={child.id}>
                <Badge tone={CX_STATUS_TONE[child.status] ?? "neutral"} size="xs" variant="outline">
                  {child.systemCode} · {labelize(child.status)}
                </Badge>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* -------- tests -------- */}
      <section className="space-y-3">
        <SectionTitle
          title={`Test records (${system.testRecords.length})`}
          hint="Pre-functional first. A functional test of a system that was never statically checked proves only that it ran once."
          actions={
            <Button size="sm" variant="secondary" onClick={() => setAddOpen(true)}>
              New test record
            </Button>
          }
        />
        {system.testRecords.length === 0 ? (
          <NothingHere
            title="No test record exists on this system"
            reason="Nothing has been proved about it. The readiness gate above is refusing functional testing for exactly that reason, and a turnover package containing this system would carry no commissioning evidence."
            action={
              <Button size="sm" onClick={() => setAddOpen(true)}>
                Record the first test
              </Button>
            }
          />
        ) : (
          <div className="space-y-4">
            <TestGroup
              title="Pre-functional"
              hint="Static, pre-energisation checks. These gate everything after them."
              tests={pre}
              users={users}
              projectId={projectId}
              onMutated={onMutated}
            />
            <TestGroup
              title="Functional"
              hint="Only meaningful once the system is live."
              tests={functional}
              users={users}
              projectId={projectId}
              onMutated={onMutated}
            />
            {unclassified.length > 0 ? (
              <TestGroup
                title="Unclassified"
                hint="A retest whose parent record cannot be resolved sits here rather than being guessed into a phase."
                tests={unclassified}
                users={users}
                projectId={projectId}
                onMutated={onMutated}
              />
            ) : null}
          </div>
        )}
      </section>

      <NewTestModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        projectId={projectId}
        systemId={system.id}
        onDone={onMutated}
      />
    </div>
  );
}

/* ================================================================== */

function Ladder({ status }: { status: string }) {
  const index = CX_LADDER.indexOf(status);
  const onHold = status === "on_hold";
  return (
    <div className="space-y-1">
      <ol className="flex flex-wrap gap-1">
        {CX_LADDER.map((rung, i) => {
          const reached = !onHold && index >= 0 && i <= index;
          const current = !onHold && i === index;
          return (
            <li
              key={rung}
              className={cx(
                "rounded px-1.5 py-1 text-2xs",
                current
                  ? cx(toneClass(CX_STATUS_TONE[rung] ?? "accent", "solid"), "font-semibold")
                  : reached
                    ? toneClass("success", "subtle")
                    : "bg-surface-sunken text-content-subtle",
              )}
            >
              {labelize(rung)}
            </li>
          );
        })}
      </ol>
      {onHold ? (
        <p className="text-2xs font-medium text-danger-fg">
          This system is on hold. The ladder is otherwise forward-only — a system does not become
          less commissioned.
        </p>
      ) : null}
    </div>
  );
}

function TestGroup({
  title,
  hint,
  tests,
  users,
  projectId,
  onMutated,
}: {
  title: string;
  hint: string;
  tests: readonly CxTest[];
  users: Map<string, string>;
  projectId: string;
  onMutated: () => void;
}) {
  return (
    <div className="space-y-2">
      <div>
        <h4 className="text-label uppercase tracking-wide text-content-subtle">
          {title} ({tests.length})
        </h4>
        <p className="text-2xs text-content-subtle">{hint}</p>
      </div>
      {tests.length === 0 ? (
        <p className="rounded-md border border-dashed border-border p-2.5 text-2xs text-content-subtle">
          No {title.toLowerCase()} record on this system.
        </p>
      ) : (
        <div className="space-y-2">
          {tests.map((t) => (
            <TestCard
              key={t.id}
              test={t}
              users={users}
              projectId={projectId}
              onMutated={onMutated}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function TestCard({
  test,
  users,
  projectId,
  onMutated,
}: {
  test: CxTest;
  users: Map<string, string>;
  projectId: string;
  onMutated: () => void;
}) {
  const { busy, refusal, clear, run } = useAction();
  const [resultOpen, setResultOpen] = useState(false);
  const [witnessOpen, setWitnessOpen] = useState(false);
  const [result, setResult] = useState("pass");
  const [witnessName, setWitnessName] = useState("");
  const [witnessOrg, setWitnessOrg] = useState("");
  const [thirdParty, setThirdParty] = useState("");

  const base = `/api/v1/projects/${projectId}/commissioning/test-records/${test.id}`;
  const today = todayIso();
  const expired = test.instruments.filter(
    (i) => i.calibrationDueDate !== null && i.calibrationDueDate !== undefined && i.calibrationDueDate < today,
  );
  const witnessed = test.witnessedAt !== null;
  const tone: Tone = test.result ? (TEST_RESULT_TONE[test.result] ?? "neutral") : "neutral";

  async function recordResult() {
    const done = await run("result", () => api.post(`${base}/result`, { result }));
    if (done) {
      setResultOpen(false);
      onMutated();
    }
  }

  async function recordWitness() {
    const done = await run("witness", () =>
      api.post(`${base}/witness`, {
        witnessedByName: witnessName.trim() === "" ? null : witnessName.trim(),
        witnessedByOrganisation: witnessOrg.trim() === "" ? null : witnessOrg.trim(),
        thirdPartyWitness: thirdParty.trim() === "" ? null : thirdParty.trim(),
      }),
    );
    if (done) {
      setWitnessOpen(false);
      onMutated();
    }
  }

  async function accept() {
    const done = await run("accept", () => api.post(`${base}/accept`, {}));
    if (done) onMutated();
  }

  return (
    <div
      className={cx(
        "rounded-lg border border-l-4 border-border bg-surface-raised p-3",
        TONE_RAIL[expired.length > 0 ? "danger" : tone],
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-mono text-2xs text-content-subtle">{test.reference}</span>
            <Badge tone="neutral" size="xs" variant="outline">
              {labelize(test.testKind)}
            </Badge>
            <Badge tone={TEST_STATUS_TONE[test.status] ?? "neutral"} size="xs" dot>
              {labelize(test.status)}
            </Badge>
            {test.result ? (
              <Badge tone={tone} size="xs" variant="solid">
                {labelize(test.result)}
              </Badge>
            ) : (
              <Badge tone="neutral" size="xs" variant="outline">
                no result yet
              </Badge>
            )}
            {test.retestOfId ? (
              <Badge tone="info" size="xs" variant="outline">
                retest
              </Badge>
            ) : null}
          </div>
          <p className="mt-1 text-sm font-medium">{test.title}</p>
          {test.testProcedureRef ? (
            <p className="text-2xs text-content-subtle">Procedure {test.testProcedureRef}</p>
          ) : null}
        </div>
      </div>

      {expired.length > 0 ? (
        <Alert tone="danger" size="sm" className="mt-2" title="Instrument out of calibration">
          {expired
            .map(
              (i) =>
                `${i.name ?? i.serial ?? "instrument"} (serial ${i.serial ?? "unknown"}) — calibration ran out ${i.calibrationDueDate}`,
            )
            .join("; ")}
          . A reading taken with an out-of-calibration meter is not a reading, and the API refuses a
          pass recorded on one.
        </Alert>
      ) : null}

      <div className="mt-2 grid gap-2.5 lg:grid-cols-2">
        <div className="rounded-md border border-border-subtle bg-surface-sunken p-2.5">
          <p className="text-label uppercase tracking-wide text-content-subtle">Performed</p>
          <div className="mt-1 space-y-0.5 text-2xs">
            <p>{test.performedAt ? dateTime(test.performedAt) : "not yet performed"}</p>
            <p className="text-content-muted">
              {test.performedByName ??
                (test.performedBy ? nameOf(users, test.performedBy) : "nobody recorded")}
              {test.contractorRepName ? ` · ${test.contractorRepName}` : ""}
            </p>
          </div>
        </div>
        <div
          className={cx(
            "rounded-md border p-2.5",
            witnessed
              ? cx(toneClass("success", "subtle"), toneClass("success", "border"))
              : cx(toneClass("warning", "subtle"), toneClass("warning", "border")),
          )}
        >
          <p className="text-label uppercase tracking-wide">Witness</p>
          {witnessed ? (
            <div className="mt-1 space-y-0.5 text-2xs">
              <p className="font-medium">
                {test.thirdPartyWitness ??
                  test.witnessedByName ??
                  (test.witnessedBy ? nameOf(users, test.witnessedBy) : EM_DASH)}
              </p>
              <p>
                {test.witnessedByOrganisation ??
                  (test.thirdPartyWitness ? "third party, no platform account" : "same company")}
              </p>
              <p className="tabular-nums opacity-80">{dateTime(test.witnessedAt)}</p>
            </div>
          ) : (
            <p className="mt-1 text-2xs">
              Not witnessed. A contractor&apos;s own signature on its own test is not evidence — a
              second party watching it is.
            </p>
          )}
        </div>
      </div>

      {test.readings.length > 0 ? (
        <div className="mt-2">
          <p className="text-label uppercase tracking-wide text-content-subtle">
            Readings ({test.readings.length})
          </p>
          <ul className="mt-1 space-y-1">
            {test.readings.map((r, i) => (
              <ReadingRow key={`${r.point ?? "point"}-${i}`} reading={r} />
            ))}
          </ul>
        </div>
      ) : null}

      {test.deficiencyCount > 0 ? (
        <p className="mt-2 text-2xs text-warning-fg">
          {test.deficiencyCount} {plural(test.deficiencyCount, "deficiency", "deficiencies")} raised
          from this test, as punch items or NCRs in the project registers — not held inline here.
        </p>
      ) : null}

      <RefusalNotice refusal={refusal} onDismiss={clear} className="mt-2" />

      <div className="mt-2 flex flex-wrap gap-2 border-t border-border-subtle pt-2">
        <Button
          size="sm"
          variant="secondary"
          disabled={test.status === "accepted"}
          onClick={() => setResultOpen(true)}
        >
          Record the result
        </Button>
        <Button size="sm" variant="secondary" onClick={() => setWitnessOpen(true)}>
          Record a witness
        </Button>
        <Button
          size="sm"
          variant="ghost"
          loading={busy === "accept"}
          disabled={test.status !== "complete"}
          onClick={accept}
        >
          Accept
        </Button>
      </div>

      <Modal
        open={resultOpen}
        onClose={() => setResultOpen(false)}
        title={`Record the result of ${test.reference}`}
        description="pass_with_deficiencies is the honest state most functional tests end in: the system works, a snag list exists, and turnover is conditional on it."
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setResultOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" loading={busy === "result"} onClick={recordResult}>
              Record it
            </Button>
          </div>
        }
      >
        <Field label="Result" required>
          <Select value={result} onChange={(e) => setResult(e.target.value)}>
            {TEST_RESULTS.map((r) => (
              <option key={r} value={r}>
                {labelize(r)}
              </option>
            ))}
          </Select>
        </Field>
      </Modal>

      <Modal
        open={witnessOpen}
        onClose={() => setWitnessOpen(false)}
        title={`Record a witness on ${test.reference}`}
        description="A witness from within the platform must be somebody other than the performer. A third-party witness — an insurer's engineer, a certifying authority — is recorded by name because they have no account here."
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setWitnessOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" loading={busy === "witness"} onClick={recordWitness}>
              Record the witness
            </Button>
          </div>
        }
      >
        <div className="space-y-3">
          <Field label="Witness name">
            <Input value={witnessName} onChange={(e) => setWitnessName(e.target.value)} />
          </Field>
          <Field label="Organisation">
            <Input value={witnessOrg} onChange={(e) => setWitnessOrg(e.target.value)} />
          </Field>
          <Field
            label="Third-party witness"
            hint="Fill this in only where the witness is not a platform user. Doing so records them by name instead of attributing the witness to your account."
          >
            <Textarea rows={2} value={thirdParty} onChange={(e) => setThirdParty(e.target.value)} />
          </Field>
        </div>
      </Modal>
    </div>
  );
}

/** One reading, against its own window. */
function ReadingRow({ reading }: { reading: CxReading }) {
  const unit = reading.unit ? ` ${reading.unit}` : "";
  const tone: Tone =
    reading.pass === true ? "success" : reading.pass === false ? "danger" : "info";
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 rounded border border-border-subtle px-2 py-1 text-2xs">
      <span className="min-w-0 font-medium">{reading.point ?? "unnamed point"}</span>
      <span className="flex flex-wrap items-center gap-3 tabular-nums">
        <span>
          <span className="text-content-subtle">expected </span>
          {reading.expected === null || reading.expected === undefined
            ? "none"
            : `${num(reading.expected, 3)}${unit}`}
        </span>
        <span>
          <span className="text-content-subtle">window </span>
          {reading.lower === null || reading.lower === undefined ? "open" : num(reading.lower, 3)}
          {" … "}
          {reading.upper === null || reading.upper === undefined ? "open" : num(reading.upper, 3)}
        </span>
        <span className="font-semibold">
          <span className="font-normal text-content-subtle">measured </span>
          {reading.measured === null || reading.measured === undefined
            ? "no reading"
            : `${num(reading.measured, 3)}${unit}`}
        </span>
        <Badge tone={tone} size="xs" variant={reading.pass === null ? "outline" : "solid"}>
          {reading.pass === true ? "in tolerance" : reading.pass === false ? "out of tolerance" : "not judgeable"}
        </Badge>
      </span>
      {reading.reasons && reading.reasons.length > 0 ? (
        <ReasonList reasons={reading.reasons} className="basis-full" />
      ) : null}
    </li>
  );
}

function NewTestModal({
  open,
  onClose,
  projectId,
  systemId,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  projectId: string;
  systemId: string;
  onDone: () => void;
}) {
  const { busy, refusal, clear, run } = useAction();
  const [title, setTitle] = useState("");
  const [testKind, setTestKind] = useState("prefunctional_checklist");
  const [scheduledFor, setScheduledFor] = useState("");

  async function submit() {
    const done = await run("create", () =>
      api.post(`/api/v1/projects/${projectId}/commissioning/test-records`, {
        systemId,
        testKind,
        title: title.trim(),
        scheduledFor: scheduledFor === "" ? null : scheduledFor,
      }),
    );
    if (done) {
      onClose();
      setTitle("");
      onDone();
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New test record"
      description="Pre-functional and functional records share one register; the kind decides which half of the ladder this belongs to."
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={busy === "create"}
            disabled={title.trim().length === 0}
            onClick={submit}
          >
            Create it
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <RefusalNotice refusal={refusal} onDismiss={clear} />
        <Field label="Title" required>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
        </Field>
        <Field label="Test kind" required>
          <Select value={testKind} onChange={(e) => setTestKind(e.target.value)}>
            {TEST_KINDS.map((k) => (
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
    </Modal>
  );
}
