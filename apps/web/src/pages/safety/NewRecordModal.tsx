/**
 * REPORTING SOMETHING.
 *
 * Two forms behind one modal, because the two things a site actually raises
 * in the moment are an incident and an observation.
 *
 * The incident form asks the minimum the API will accept and no more: type,
 * title, description, when it happened, and — for an injury — who was hurt.
 * Everything else (the injury detail, the reportability answers, the
 * investigation) belongs on the record once it exists, not in the way of
 * getting it recorded. The reportability determination runs on creation, so
 * the deadline exists from the first save.
 *
 * The observation form scores risk on both axes or on neither. A score with
 * one axis filled in is refused here rather than stored as a half-truth: the
 * API returns `risk: null` with a reason in that case, and a form that
 * encourages it is a form that fills the register with unscored rows.
 */
import { useEffect, useState } from "react";
import {
  Alert,
  Button,
  Field,
  Input,
  Modal,
  Select,
  Textarea,
  cx,
} from "../../ui";
import { api } from "../../lib/api";
import {
  RefusalNotice,
  labelize,
  useMutation,
} from "./safetyShared";

export type NewRecordKind = "incident" | "observation";

const INCIDENT_TYPES = [
  "injury",
  "occupational_illness",
  "near_miss",
  "property_damage",
  "environmental",
  "fire",
  "dangerous_occurrence",
  "security",
  "road_traffic",
  "utility_strike",
  "structural_failure",
  "public_impact",
];

const SEVERITIES = ["negligible", "minor", "serious", "major", "catastrophic"];

const CATEGORIES = [
  "ppe",
  "working_at_height",
  "housekeeping",
  "electrical",
  "excavation",
  "lifting_operations",
  "hot_works",
  "confined_space",
  "plant_and_equipment",
  "manual_handling",
  "hazardous_substances",
  "fire",
  "traffic_management",
  "temporary_works",
  "permit_compliance",
  "environmental",
  "welfare",
  "behaviour",
  "emergency_preparedness",
  "other",
];

const OBSERVATION_SEVERITIES = ["informational", "low", "medium", "high", "critical"];

const AXIS = [1, 2, 3, 4, 5];

const LIKELIHOOD_LABEL: Record<number, string> = {
  1: "1 · Rare",
  2: "2 · Unlikely",
  3: "3 · Possible",
  4: "4 · Likely",
  5: "5 · Almost certain",
};

const SEVERITY_LABEL: Record<number, string> = {
  1: "1 · Negligible",
  2: "2 · Minor",
  3: "3 · Moderate",
  4: "4 · Major",
  5: "5 · Catastrophic",
};

function nowLocalInput(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}`;
}

export default function NewRecordModal({
  projectId,
  kind,
  onClose,
  onCreated,
}: {
  projectId: string;
  kind: NewRecordKind | null;
  onClose: () => void;
  onCreated: (kind: NewRecordKind, id: string) => void;
}) {
  const mutation = useMutation(() => {
    /* the caller refreshes; nothing to do here */
  });

  /* --- incident --- */
  const [incidentType, setIncidentType] = useState("near_miss");
  const [severity, setSeverity] = useState("minor");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [occurredAt, setOccurredAt] = useState(nowLocalInput());
  const [injuredPersonName, setInjuredPersonName] = useState("");
  const [workStopped, setWorkStopped] = useState(false);
  const [immediateAction, setImmediateAction] = useState("");

  /* --- observation --- */
  const [obsKind, setObsKind] = useState("negative");
  const [category, setCategory] = useState("other");
  const [obsSeverity, setObsSeverity] = useState("low");
  const [likelihood, setLikelihood] = useState<string>("");
  const [riskSeverity, setRiskSeverity] = useState<string>("");

  useEffect(() => {
    if (kind === null) {
      setTitle("");
      setDescription("");
      setInjuredPersonName("");
      setImmediateAction("");
      setWorkStopped(false);
      setLikelihood("");
      setRiskSeverity("");
      mutation.clear();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind]);

  const needsPerson = incidentType === "injury";
  const halfScored = (likelihood === "") !== (riskSeverity === "");

  async function createIncident() {
    const created = await api.post<{ id: string }>(
      `/api/v1/projects/${projectId}/safety/incidents`,
      {
        incidentType,
        severity,
        title: title.trim(),
        description: description.trim(),
        occurredAt: new Date(occurredAt).toISOString(),
        ...(injuredPersonName.trim() ? { injuredPersonName: injuredPersonName.trim() } : {}),
        ...(workStopped ? { workStopped: true } : {}),
        ...(immediateAction.trim() ? { immediateActionTaken: immediateAction.trim() } : {}),
      },
    );
    onCreated("incident", created.id);
  }

  async function createObservation() {
    const created = await api.post<{ id: string }>(
      `/api/v1/projects/${projectId}/safety/observations`,
      {
        kind: obsKind,
        category,
        severity: obsSeverity,
        title: title.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
        observedAt: new Date(occurredAt).toISOString(),
        ...(likelihood ? { riskLikelihood: Number(likelihood) } : {}),
        ...(riskSeverity ? { riskSeverity: Number(riskSeverity) } : {}),
        ...(workStopped ? { workStopped: true } : {}),
        ...(immediateAction.trim() ? { immediateActionTaken: immediateAction.trim() } : {}),
      },
    );
    onCreated("observation", created.id);
  }

  const incidentValid =
    title.trim() !== "" &&
    description.trim() !== "" &&
    occurredAt !== "" &&
    (!needsPerson || injuredPersonName.trim() !== "") &&
    (!workStopped || immediateAction.trim() !== "");

  const observationValid =
    title.trim() !== "" &&
    occurredAt !== "" &&
    !halfScored &&
    (!workStopped || immediateAction.trim() !== "") &&
    !(workStopped && obsKind === "positive");

  return (
    <Modal
      open={kind !== null}
      onClose={onClose}
      title={kind === "incident" ? "Report an incident" : "Record an observation"}
      size="lg"
      footer={
        <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={kind === "incident" ? !incidentValid : !observationValid}
            loading={mutation.busy !== null}
            onClick={() =>
              void mutation.run(
                "create",
                kind === "incident"
                  ? "This incident could not be reported"
                  : "This observation could not be recorded",
                kind === "incident" ? createIncident : createObservation,
              )
            }
          >
            {kind === "incident" ? "Report the incident" : "Record it"}
          </Button>
        </div>
      }
    >
      {mutation.refusal ? (
        <div className="mb-3">
          <RefusalNotice refusal={mutation.refusal} onDismiss={mutation.clear} />
        </div>
      ) : null}
      {mutation.error ? (
        <div className="mb-3">
          <Alert tone="danger" title="That could not be saved" onDismiss={mutation.clear}>
            {mutation.error}
          </Alert>
        </div>
      ) : null}

      {kind === "incident" ? (
        <div className="space-y-3">
          <Alert tone="info" title="The statutory clock starts here">
            Saving runs the reportability engine against the project's jurisdiction. Where a test is
            met the notification deadline is computed and stored immediately; where a test cannot be
            decided you will be told which fact is missing rather than given a clean bill.
          </Alert>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Type" required>
              <Select value={incidentType} onChange={(e) => setIncidentType(e.target.value)}>
                {INCIDENT_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {labelize(t)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Outcome severity" hint="How bad it actually was, as an insurer bands it.">
              <Select value={severity} onChange={(e) => setSeverity(e.target.value)}>
                {SEVERITIES.map((s) => (
                  <option key={s} value={s}>
                    {labelize(s)}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          <Field label="Title" required>
            <Input
              value={title}
              placeholder="One line an investigator will recognise it by"
              onChange={(e) => setTitle(e.target.value)}
            />
          </Field>

          <Field
            label="What happened"
            required
            hint="Written now, while it is remembered. A narrative reconstructed six months later is reconstructed wrongly."
          >
            <Textarea rows={4} value={description} onChange={(e) => setDescription(e.target.value)} />
          </Field>

          <Field
            label="When it occurred"
            required
            hint="Not when it was reported. The gap between the two is stored as evidence and is itself a finding."
          >
            <Input
              type="datetime-local"
              value={occurredAt}
              onChange={(e) => setOccurredAt(e.target.value)}
            />
          </Field>

          {needsPerson ? (
            <Field
              label="Injured person"
              required
              hint="A name is enough to record it. Where the person is in the worker register, bind their worker id on the incident afterwards — that register carries their induction and site access."
            >
              <Input
                value={injuredPersonName}
                onChange={(e) => setInjuredPersonName(e.target.value)}
              />
            </Field>
          ) : null}

          <StoppageFields
            workStopped={workStopped}
            setWorkStopped={setWorkStopped}
            immediateAction={immediateAction}
            setImmediateAction={setImmediateAction}
          />
        </div>
      ) : kind === "observation" ? (
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Kind" hint="Positives are worth recording — the ratio is the point.">
              <Select value={obsKind} onChange={(e) => setObsKind(e.target.value)}>
                <option value="negative">Negative — a hazard</option>
                <option value="positive">Positive — good practice</option>
              </Select>
            </Field>
            <Field label="Category">
              <Select value={category} onChange={(e) => setCategory(e.target.value)}>
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {labelize(c)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Potential severity" hint="How bad it COULD have been.">
              <Select value={obsSeverity} onChange={(e) => setObsSeverity(e.target.value)}>
                {OBSERVATION_SEVERITIES.map((s) => (
                  <option key={s} value={s}>
                    {labelize(s)}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          <Field label="Title" required>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} />
          </Field>

          <Field label="Detail">
            <Textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
          </Field>

          <Field label="When it was observed" required>
            <Input
              type="datetime-local"
              value={occurredAt}
              onChange={(e) => setOccurredAt(e.target.value)}
            />
          </Field>

          <div
            className={cx(
              "rounded-lg border p-3",
              halfScored ? "border-warning-border bg-warning-subtle/40" : "border-border",
            )}
          >
            <p className="text-label uppercase text-content-subtle">Risk score (5×5)</p>
            <div className="mt-2 grid gap-3 sm:grid-cols-2">
              <Field label="Likelihood">
                <Select value={likelihood} onChange={(e) => setLikelihood(e.target.value)}>
                  <option value="">Not scored</option>
                  {AXIS.map((n) => (
                    <option key={n} value={String(n)}>
                      {LIKELIHOOD_LABEL[n]}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Severity">
                <Select value={riskSeverity} onChange={(e) => setRiskSeverity(e.target.value)}>
                  <option value="">Not scored</option>
                  {AXIS.map((n) => (
                    <option key={n} value={String(n)}>
                      {SEVERITY_LABEL[n]}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            {halfScored ? (
              <p className="mt-2 text-2xs text-warning-fg">
                Score both axes or neither. One axis alone produces no score — the platform will
                store the observation with no risk figure and a reason saying which axis is missing,
                and a register of half-scored rows cannot be ranked.
              </p>
            ) : likelihood && riskSeverity ? (
              <p className="mt-2 text-2xs text-content-muted">
                Scores {Number(likelihood) * Number(riskSeverity)} of 25. The band and its guidance
                are computed by the platform, not here.
              </p>
            ) : (
              <p className="mt-2 text-2xs text-content-subtle">
                Leave both blank if nobody has made the judgement. That is recorded honestly as
                "not scored" rather than defaulted to a low number.
              </p>
            )}
          </div>

          {workStopped && obsKind === "positive" ? (
            <Alert tone="warning" title="Work cannot be stopped on a positive observation">
              A stoppage is a response to a hazard. Recording one against a commendation makes the
              register unreadable, and the platform refuses it.
            </Alert>
          ) : null}

          <StoppageFields
            workStopped={workStopped}
            setWorkStopped={setWorkStopped}
            immediateAction={immediateAction}
            setImmediateAction={setImmediateAction}
          />
        </div>
      ) : null}
    </Modal>
  );
}

function StoppageFields({
  workStopped,
  setWorkStopped,
  immediateAction,
  setImmediateAction,
}: {
  workStopped: boolean;
  setWorkStopped: (v: boolean) => void;
  immediateAction: string;
  setImmediateAction: (v: string) => void;
}) {
  return (
    <>
      <Field
        label="Was work stopped?"
        hint="The first fact an enforcement officer asks about."
      >
        <Select
          value={workStopped ? "true" : "false"}
          onChange={(e) => setWorkStopped(e.target.value === "true")}
        >
          <option value="false">No</option>
          <option value="true">Yes — work was stopped</option>
        </Select>
      </Field>
      <Field
        label="What was done at the time"
        required={workStopped}
        hint={
          workStopped
            ? "Required. \"Work was stopped\" with no account of why or what was put in place is worse than no record at all."
            : "Optional, but the immediate response is the part nobody remembers afterwards."
        }
      >
        <Textarea
          rows={2}
          value={immediateAction}
          onChange={(e) => setImmediateAction(e.target.value)}
        />
      </Field>
    </>
  );
}
