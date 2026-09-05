/**
 * THE INCIDENT — the whole record, in the order an investigator and a
 * regulator actually read it.
 *
 *   Record          when, where, who, how — the fields a claim form and a
 *                   statutory notification both ask for, with the witnesses.
 *   Reportability   the determination: which regime, which rule, which
 *                   citation, the deadline, and — first — anything a human
 *                   still has to decide. Answering an open question here
 *                   re-runs the engine and can move the clock.
 *   Investigation   lead, method, root cause, contributing factors, findings.
 *                   Completion and sign-off are two acts by two people.
 *   Actions         what was raised off the back of it, and at which level of
 *                   the hierarchy of control.
 *   Briefings       the talks given BECAUSE of this — the loop closed.
 *
 * Nothing here decides anything the API decides. Every refusal is printed in
 * the server's own words, because a refusal like "an incident closed without
 * an approved investigation is a record that something happened and nothing
 * was learned" is the most useful sentence on the screen.
 */
import { useEffect, useMemo, useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  DescriptionList,
  Drawer,
  EmptyState,
  Field,
  Input,
  Select,
  Skeleton,
  Tabs,
  Textarea,
  Timeline,
  cx,
  type DescriptionItem,
} from "../../ui";
import { IconPlus, IconSafety, IconWarning } from "../../ui/icons";
import { api } from "../../lib/api";
import ActionList from "./ActionList";
import {
  EM_DASH,
  HIERARCHY_ORDER,
  HIERARCHY_LABEL,
  INCIDENT_SEVERITY_TONE,
  INCIDENT_STATUS_TONE,
  INVESTIGATION_STATUS_TONE,
  LoadError,
  NotificationCountdown,
  REGIME_LABEL,
  ReasonList,
  RefusalNotice,
  ReportabilityPanel,
  SectionHeading,
  count,
  dateTime,
  isoDate,
  labelize,
  money,
  nameOf,
  today,
  useMutation,
  useResource,
  type IncidentDetail,
  type ReportabilityResponse,
} from "./safetyShared";

type Section = "record" | "reportability" | "investigation" | "actions" | "briefings";

const SECTIONS: Array<{ value: Section; label: string }> = [
  { value: "record", label: "Record" },
  { value: "reportability", label: "Reportability" },
  { value: "investigation", label: "Investigation" },
  { value: "actions", label: "Actions" },
  { value: "briefings", label: "Briefings" },
];

const ROOT_CAUSE_METHODS = [
  "none",
  "five_whys",
  "fishbone",
  "taproot",
  "bowtie",
  "fault_tree",
  "icam",
];

const REGIMES = [
  "riddor",
  "osha",
  "eu_framework",
  "ilo",
  "environment_agency",
  "local_authority",
  "client_specific",
  "insurer",
];

const HOSPITAL_ADMISSIONS = [
  "none",
  "outpatient_or_ed_only",
  "inpatient_treatment",
  "inpatient_observation_only",
  "unknown",
];

export default function IncidentDrawer({
  projectId,
  incidentId,
  users,
  vendors,
  onClose,
  onMutated,
}: {
  projectId: string;
  incidentId: string | null;
  users: Map<string, string>;
  vendors: Map<string, string>;
  onClose: () => void;
  onMutated: () => void;
}) {
  const [section, setSection] = useState<Section>("record");
  const [version, setVersion] = useState(0);

  const detail = useResource<IncidentDetail>(
    (signal) =>
      api.get<IncidentDetail>(
        `/api/v1/projects/${projectId}/safety/incidents/${incidentId}`,
        { signal },
      ),
    [projectId, incidentId, version],
    incidentId !== null && projectId !== "",
  );

  const assessment = useResource<ReportabilityResponse>(
    (signal) =>
      api.get<ReportabilityResponse>(
        `/api/v1/projects/${projectId}/safety/incidents/${incidentId}/reportability`,
        { signal },
      ),
    [projectId, incidentId, version],
    incidentId !== null && projectId !== "" && section === "reportability",
  );

  const mutation = useMutation(() => {
    setVersion((n) => n + 1);
    onMutated();
  });

  useEffect(() => {
    if (incidentId === null) setSection("record");
  }, [incidentId]);

  const incident = detail.data;

  return (
    <Drawer
      open={incidentId !== null}
      onClose={onClose}
      size="xl"
      resizable
      resizeStorageKey="safety-incident-drawer"
      icon={IconSafety}
      tone={incident?.notification.missed ? "danger" : undefined}
      title={incident ? `${incident.reference} · ${incident.title}` : "Incident"}
      description={
        incident
          ? `${labelize(incident.incidentType)} · occurred ${dateTime(incident.occurredAt)}`
          : undefined
      }
      headerActions={
        incident ? (
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone={INCIDENT_STATUS_TONE[incident.status] ?? "neutral"} size="sm" dot>
              {labelize(incident.status)}
            </Badge>
            <Badge tone={INCIDENT_SEVERITY_TONE[incident.severity] ?? "neutral"} size="sm">
              {labelize(incident.severity)}
            </Badge>
          </div>
        ) : null
      }
    >
      {detail.error ? (
        <LoadError
          message={detail.error}
          onRetry={detail.reload}
          title="This incident could not be loaded"
        />
      ) : null}

      {mutation.refusal ? (
        <div className="mb-3">
          <RefusalNotice refusal={mutation.refusal} onDismiss={mutation.clear} />
        </div>
      ) : null}
      {mutation.error ? (
        <div className="mb-3">
          <Alert tone="danger" title="That action could not be completed" onDismiss={mutation.clear}>
            {mutation.error}
          </Alert>
        </div>
      ) : null}

      {detail.loading && !incident ? (
        <div className="space-y-3">
          <Skeleton height={120} />
          <Skeleton height={240} />
        </div>
      ) : incident ? (
        <div className="space-y-4">
          <ClockStrip incident={incident} />

          <Tabs
            items={SECTIONS.map((s) => ({
              value: s.value,
              label: s.label,
              ...(s.value === "actions" && incident.openActionCount > 0
                ? { count: incident.openActionCount, tone: "warning" as const }
                : {}),
            }))}
            value={section}
            onChange={setSection}
            size="sm"
            aria-label="Incident sections"
          />

          {section === "record" ? (
            <RecordSection incident={incident} users={users} vendors={vendors} />
          ) : section === "reportability" ? (
            <ReportabilitySection
              projectId={projectId}
              incident={incident}
              assessment={assessment.data}
              assessmentError={assessment.error}
              assessmentLoading={assessment.loading}
              onReloadAssessment={assessment.reload}
              mutation={mutation}
            />
          ) : section === "investigation" ? (
            <InvestigationSection
              projectId={projectId}
              incident={incident}
              users={users}
              mutation={mutation}
            />
          ) : section === "actions" ? (
            <ActionsSection projectId={projectId} incident={incident} mutation={mutation} />
          ) : (
            <BriefingsSection incident={incident} />
          )}

          <LifecycleFooter projectId={projectId} incident={incident} mutation={mutation} />
        </div>
      ) : null}
    </Drawer>
  );
}

/* ========================================================================== */
/* The clock, above everything                                                 */
/* ========================================================================== */

function ClockStrip({ incident }: { incident: IncidentDetail }) {
  const n = incident.notification;
  if (!n.required && n.needsHumanReview !== true) return null;

  return (
    <Card
      variant="sunken"
      accent={n.missed ? "danger" : n.needsHumanReview === true ? "warning" : "info"}
    >
      <CardBody className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-label uppercase text-content-subtle">
            {n.needsHumanReview === true
              ? "Determination not settled"
              : "Statutory notification owed"}
          </p>
          <p className="mt-1 text-body text-content">
            {n.regimes.length > 0
              ? n.regimes.map((r) => REGIME_LABEL[r] ?? r).join(" and ")
              : "No regime has been resolved for this project."}
          </p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {n.riddorCategory ? (
              <Badge size="xs" variant="outline" tone="neutral">
                RIDDOR · {labelize(n.riddorCategory)}
              </Badge>
            ) : null}
            {n.oshaCaseType ? (
              <Badge size="xs" variant="outline" tone="neutral">
                OSHA · {labelize(n.oshaCaseType)}
              </Badge>
            ) : null}
            {n.obligationId ? (
              <Badge size="xs" variant="outline" tone="info">
                Bound to the obligations register
              </Badge>
            ) : null}
          </div>
        </div>
        <NotificationCountdown dueAt={n.dueAt} notifiedAt={n.notifiedAt} />
      </CardBody>
    </Card>
  );
}

/* ========================================================================== */
/* Record                                                                      */
/* ========================================================================== */

function RecordSection({
  incident,
  users,
  vendors,
}: {
  incident: IncidentDetail;
  users: Map<string, string>;
  vendors: Map<string, string>;
}) {
  const when: DescriptionItem[] = [
    { label: "Occurred", value: dateTime(incident.occurredAt) },
    { label: "Discovered", value: dateTime(incident.discoveredAt) },
    { label: "Reported", value: dateTime(incident.reportedAt) },
    {
      label: "Reporting delay",
      value:
        incident.reportingDelayHours === null ? (
          <span className="text-content-muted">Not computed</span>
        ) : (
          <span className={cx(incident.reportingDelayHours > 24 && "text-warning-fg")}>
            {count(Math.round(incident.reportingDelayHours))} hours
          </span>
        ),
      hint: "The gap between the event and the report. Late reporting is itself a finding, so it is stored rather than quietly corrected.",
    },
    { label: "Shift", value: incident.shift ? labelize(incident.shift) : EM_DASH },
    {
      label: "Hours into shift",
      value: incident.hoursIntoShift === null ? EM_DASH : `${incident.hoursIntoShift}`,
      hint: "Fatigue analysis reads this field.",
    },
    { label: "Location", value: incident.locationText ?? EM_DASH, span: 2 },
    { label: "Activity at the time", value: incident.activityAtTime ?? EM_DASH, span: 2 },
    { label: "Weather", value: incident.weatherConditions ?? EM_DASH },
    { label: "Lighting", value: incident.lightingConditions ?? EM_DASH },
  ];

  const person: DescriptionItem[] = [
    {
      label: "Injured person",
      value: incident.injuredPersonDisplayName ?? incident.injuredPersonName ?? EM_DASH,
      hint: incident.workerId
        ? "In the worker register — the same one that carries induction and site access."
        : "Not in any register; recorded by name only.",
    },
    {
      label: "Relationship",
      value: incident.injuredPersonType ? labelize(incident.injuredPersonType) : EM_DASH,
      hint: "Determines whose duty and whose insurer.",
    },
    { label: "Employer", value: incident.vendorId ? nameOf(vendors, incident.vendorId) : EM_DASH },
    { label: "Trade", value: incident.injuredPersonTrade ?? EM_DASH },
    { label: "Age", value: incident.injuredPersonAge === null ? EM_DASH : `${incident.injuredPersonAge}` },
    {
      label: "Years of experience",
      value: incident.yearsExperience === null ? EM_DASH : `${incident.yearsExperience}`,
    },
    {
      label: "Days since induction",
      value: incident.daysSinceInduction === null ? EM_DASH : count(incident.daysSinceInduction),
    },
  ];

  const injury: DescriptionItem[] = [
    {
      label: "Treatment level",
      value: incident.treatmentLevel ? labelize(incident.treatmentLevel) : EM_DASH,
      hint: "The boundary between first aid and medical treatment is the most audited judgement in incident reporting.",
    },
    { label: "Nature", value: incident.injuryNature ? labelize(incident.injuryNature) : EM_DASH },
    {
      label: "Body part",
      value: [incident.bodyPart, ...(incident.additionalBodyParts ?? [])]
        .filter(Boolean)
        .map((b) => labelize(b as string))
        .join(", ") || EM_DASH,
    },
    { label: "Mechanism", value: incident.mechanism ? labelize(incident.mechanism) : EM_DASH },
    { label: "Treatment provider", value: incident.treatmentProvider ?? EM_DASH },
    { label: "Hospital", value: incident.hospitalName ?? EM_DASH },
    {
      label: "Lost time",
      value: incident.isLostTime ? (
        <Badge tone="danger" size="xs">
          {incident.lostTimeDays === null
            ? "Yes, days not yet recorded"
            : `${count(incident.lostTimeDays)} days`}
        </Badge>
      ) : (
        "No"
      ),
    },
    {
      label: "Restricted duty",
      value:
        incident.restrictedDutyDays === null ? EM_DASH : `${count(incident.restrictedDutyDays)} days`,
    },
    { label: "Return to work", value: isoDate(incident.returnToWorkDate) },
  ];

  const response: DescriptionItem[] = [
    { label: "Immediate cause", value: incident.immediateCause ?? EM_DASH, span: 2 },
    { label: "Immediate action taken", value: incident.immediateActionTaken ?? EM_DASH, span: 2 },
    {
      label: "Work stopped",
      value: incident.workStopped ? (
        <Badge tone={incident.workResumedAt ? "neutral" : "danger"} size="xs" dot>
          {incident.workResumedAt ? `Resumed ${dateTime(incident.workResumedAt)}` : "Still stopped"}
        </Badge>
      ) : (
        "No"
      ),
      hint: "The first fact an enforcement officer asks about.",
    },
    {
      label: "Emergency services attended",
      value: incident.emergencyServicesAttended ? "Yes" : "No",
    },
    {
      label: "Third party involved",
      value: incident.thirdPartyInvolved ? incident.thirdPartyDetail ?? "Yes" : "No",
      span: 2,
    },
    {
      label: "Estimated cost",
      value:
        incident.estimatedCost === null
          ? EM_DASH
          : money(incident.estimatedCost, incident.currency),
      hint: `Stated in ${incident.currency}. Costs are never combined across currencies.`,
    },
    {
      label: "Actual cost",
      value: incident.actualCost === null ? EM_DASH : money(incident.actualCost, incident.currency),
    },
  ];

  return (
    <div className="space-y-4">
      <Card>
        <CardBody>
          <p className="whitespace-pre-wrap text-body text-content">{incident.description}</p>
        </CardBody>
      </Card>

      <section>
        <SectionHeading title="When and where" />
        <DescriptionList items={when} columns={2} dividers />
      </section>

      <section>
        <SectionHeading
          title="The person"
          hint="Workers are not duplicated here — a registered worker is referenced, and only somebody in no register at all falls back to a name."
        />
        <DescriptionList items={person} columns={2} dividers />
      </section>

      <section>
        <SectionHeading title="The injury" />
        <DescriptionList items={injury} columns={2} dividers />
      </section>

      <section>
        <SectionHeading title="Immediate response" />
        <DescriptionList items={response} columns={2} dividers />
      </section>

      <section>
        <SectionHeading
          title={`Witnesses · ${count(incident.witnessCount)}`}
          hint="A witness recorded a year later is a witness who cannot be found."
        />
        {(incident.witnesses ?? []).length === 0 ? (
          <EmptyState
            size="sm"
            title="No witness was recorded"
            hint="Either nobody saw it, or nobody was asked at the time. Those are different facts, and only one of them can still be fixed."
          />
        ) : (
          <div className="grid gap-2 sm:grid-cols-2">
            {incident.witnesses.map((w, i) => (
              <Card key={i} variant="sunken">
                <CardBody>
                  <p className="text-body font-medium text-content">{w.name ?? "Unnamed"}</p>
                  <p className="text-2xs text-content-muted">
                    {[w.organisation, w.contact].filter(Boolean).join(" · ") || "No contact recorded"}
                  </p>
                  {w.statementFileId ? (
                    <Badge tone="success" size="xs" variant="outline" className="mt-1.5">
                      Statement on file
                    </Badge>
                  ) : (
                    <Badge tone="warning" size="xs" variant="outline" className="mt-1.5">
                      No statement taken
                    </Badge>
                  )}
                </CardBody>
              </Card>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

/* ========================================================================== */
/* Reportability                                                               */
/* ========================================================================== */

type Mutation = ReturnType<typeof useMutation>;

const TRI = [
  { value: "", label: "Unknown — not answered" },
  { value: "true", label: "Yes" },
  { value: "false", label: "No" },
];

function triValue(v: string): boolean | null {
  if (v === "true") return true;
  if (v === "false") return false;
  return null;
}

function ReportabilitySection({
  projectId,
  incident,
  assessment,
  assessmentError,
  assessmentLoading,
  onReloadAssessment,
  mutation,
}: {
  projectId: string;
  incident: IncidentDetail;
  assessment: ReportabilityResponse | null;
  assessmentError: string | null;
  assessmentLoading: boolean;
  onReloadAssessment: () => void;
  mutation: Mutation;
}) {
  const facts = (assessment?.facts ?? {}) as Record<string, unknown>;
  const readBool = (key: string): string => {
    const v = facts[key];
    return v === true ? "true" : v === false ? "false" : "";
  };

  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [regimes, setRegimes] = useState<string[]>(incident.reportableRegimes ?? []);
  const [notifyRegime, setNotifyRegime] = useState<string>(incident.reportableRegimes[0] ?? "riddor");
  const [notifyReference, setNotifyReference] = useState("");
  const [notifyMethod, setNotifyMethod] = useState("");

  useEffect(() => {
    if (!assessment) return;
    setAnswers({
      hospitalAdmission: String(facts["hospitalAdmission"] ?? "unknown"),
      dangerousOccurrenceClass: String(facts["dangerousOccurrenceClass"] ?? ""),
      medicalTreatmentBeyondFirstAid: readBool("medicalTreatmentBeyondFirstAid"),
      lossOfConsciousness: readBool("lossOfConsciousness"),
      permanentSightLoss: readBool("permanentSightLoss"),
      lossOfAnEye: readBool("lossOfAnEye"),
      seriousBurn: readBool("seriousBurn"),
      enclosedSpace: readBool("enclosedSpace"),
      occupationalDiseaseDiagnosed: readBool("occupationalDiseaseDiagnosed"),
      gasIncident: readBool("gasIncident"),
      underOurDayToDayControl: readBool("underOurDayToDayControl"),
      workRelated: readBool("workRelated"),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assessment]);

  const determination = assessment?.current ?? incident.reportability;

  const unanswered = useMemo(
    () => (determination?.openQuestions ?? []).length,
    [determination],
  );

  async function reassess() {
    const payload: Record<string, unknown> = {};
    if (regimes.length > 0) payload["regimes"] = regimes;
    const inputs: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(answers)) {
      if (key === "hospitalAdmission") {
        if (value) inputs[key] = value;
      } else if (key === "dangerousOccurrenceClass") {
        inputs[key] = value === "" ? null : value;
      } else {
        inputs[key] = triValue(value);
      }
    }
    payload["reportabilityInputs"] = inputs;
    await api.post(
      `/api/v1/projects/${projectId}/safety/incidents/${incident.id}/reportability`,
      payload,
    );
    onReloadAssessment();
  }

  return (
    <div className="space-y-4">
      {assessmentError ? (
        <LoadError
          message={assessmentError}
          onRetry={onReloadAssessment}
          title="The determination could not be recomputed"
        />
      ) : null}

      {assessmentLoading && !assessment ? (
        <Skeleton height={280} />
      ) : (
        <ReportabilityPanel
          determination={determination}
          notification={incident.notification}
          regimeBasis={assessment?.regimeBasis}
        />
      )}

      {assessment && stale(assessment) ? (
        <Alert tone="warning" title="The stored classification differs from the current facts">
          <p>
            The incident carries {assessment.stored.isReportable ? "a reportable" : "a not-reportable"}{" "}
            classification, and the same rules run against today's facts produce{" "}
            {assessment.current.isReportable ? "a reportable" : "a not-reportable"} one. Re-run the
            assessment below to write the new determination — and its deadline — onto the record.
          </p>
        </Alert>
      ) : null}

      {/* ---------------------------------------------------------------- */}
      <InjuryFactsCard
        projectId={projectId}
        incident={incident}
        mutation={mutation}
        onSaved={onReloadAssessment}
      />

      {/* ---------------------------------------------------------------- */}
      <section>
        <SectionHeading
          title="The assessment answers"
          hint="These are the facts a statutory test turns on and a narrative cannot supply. Each one left unanswered is a rule the engine will report as undecided rather than guess."
          actions={
            unanswered > 0 ? (
              <Badge tone="warning" size="sm" dot>
                {count(unanswered)} open question{unanswered === 1 ? "" : "s"}
              </Badge>
            ) : null
          }
        />
        <Card>
          <CardBody className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field
                label="Hospital admission"
                hint="OSHA's in-patient test turns on admission for treatment, not attendance."
              >
                <Select
                  value={answers["hospitalAdmission"] ?? "unknown"}
                  onChange={(e) =>
                    setAnswers({ ...answers, hospitalAdmission: e.target.value })
                  }
                >
                  {HOSPITAL_ADMISSIONS.map((h) => (
                    <option key={h} value={h}>
                      {labelize(h)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field
                label="RIDDOR Schedule 2 class"
                hint="Only where a dangerous occurrence is asserted. Leave blank otherwise."
              >
                <Input
                  value={answers["dangerousOccurrenceClass"] ?? ""}
                  placeholder="sch2_para_1_lifting_equipment"
                  onChange={(e) =>
                    setAnswers({ ...answers, dangerousOccurrenceClass: e.target.value })
                  }
                />
              </Field>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              {(
                [
                  ["workRelated", "Arose out of or in connection with work"],
                  ["medicalTreatmentBeyondFirstAid", "Treatment beyond the first-aid list"],
                  ["lossOfConsciousness", "Loss of consciousness"],
                  ["permanentSightLoss", "Permanent loss or reduction of sight"],
                  ["lossOfAnEye", "Loss of an eye"],
                  ["seriousBurn", "Burn over 10% of the body, or to eyes / airway / organs"],
                  ["enclosedSpace", "Working in an enclosed space"],
                  ["occupationalDiseaseDiagnosed", "Written diagnosis received"],
                  ["gasIncident", "Reportable gas incident"],
                  ["underOurDayToDayControl", "Under our day-to-day control"],
                ] as Array<[string, string]>
              ).map(([key, label]) => (
                <Field key={key} label={label}>
                  <Select
                    value={answers[key] ?? ""}
                    onChange={(e) => setAnswers({ ...answers, [key]: e.target.value })}
                  >
                    {TRI.map((t) => (
                      <option key={t.value} value={t.value}>
                        {t.label}
                      </option>
                    ))}
                  </Select>
                </Field>
              ))}
            </div>

            <Field
              label="Regimes to assess"
              hint="Leave every box clear to let the project's country decide. A GB site with a US parent reports under both, and only a human knows that."
            >
              <div className="flex flex-wrap gap-1.5">
                {REGIMES.map((r) => {
                  const on = regimes.includes(r);
                  return (
                    <Button
                      key={r}
                      type="button"
                      size="xs"
                      variant={on ? "primary" : "outline"}
                      onClick={() =>
                        setRegimes(on ? regimes.filter((x) => x !== r) : [...regimes, r])
                      }
                    >
                      {REGIME_LABEL[r] ?? r}
                    </Button>
                  );
                })}
              </div>
            </Field>

            <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
              <Button
                size="sm"
                loading={mutation.busy === "reassess"}
                onClick={() =>
                  void mutation.run(
                    "reassess",
                    "The determination could not be re-run",
                    reassess,
                  )
                }
              >
                Re-run the determination
              </Button>
              <span className="text-2xs text-content-muted">
                Writing new answers recomputes the classification, the category and the deadline,
                and records the change on the ledger.
              </span>
            </div>
          </CardBody>
        </Card>
      </section>

      {/* ---------------------------------------------------------------- */}
      <section>
        <SectionHeading
          title="Notification to the regulator"
          hint="ONE DUTY PER REGIME. An incident answerable to two authorities owes two notifications, on two clocks, to two bodies, on two forms — and discharging one discharges nothing of the other."
        />

        {incident.notification.duties && incident.notification.duties.length > 0 ? (
          <ul className="mb-3 space-y-1.5">
            {incident.notification.duties.map((duty) => (
              <li
                key={duty.regime}
                className={cx(
                  "rounded-md border px-2.5 py-2",
                  duty.state === "missed"
                    ? "border-danger-border bg-danger-subtle/50"
                    : duty.state === "notified_late"
                      ? "border-warning-border bg-warning-subtle/40"
                      : "border-border bg-surface-raised",
                )}
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <span className="min-w-0">
                    <span className="block text-meta font-medium text-content">
                      {REGIME_LABEL[duty.regime] ?? duty.regime}
                      {duty.authority ? (
                        <span className="font-normal text-content-muted"> — {duty.authority}</span>
                      ) : null}
                    </span>
                    {duty.citation ? (
                      <span className="block text-2xs text-content-subtle">{duty.citation}</span>
                    ) : null}
                  </span>
                  <Badge
                    tone={
                      duty.state === "missed"
                        ? "danger"
                        : duty.state === "notified_late"
                          ? "warning"
                          : duty.state === "notified"
                            ? "success"
                            : "info"
                    }
                    size="xs"
                    dot
                  >
                    {labelize(duty.state)}
                  </Badge>
                </div>
                <p className="mt-1 text-2xs text-content-muted">
                  {duty.state === "notified" || duty.state === "notified_late"
                    ? `Notified ${dateTime(duty.notifiedAt)}${
                        duty.reference ? ` · ${duty.reference}` : ""
                      }${duty.hoursLate !== null ? ` · ${duty.hoursLate} hour(s) late` : ""}`
                    : duty.dueAt
                      ? `Due ${dateTime(duty.dueAt)}${
                          duty.hoursRemaining !== null
                            ? ` · ${duty.hoursRemaining} hour(s) left`
                            : duty.hoursLate !== null
                              ? ` · ${duty.hoursLate} hour(s) past it`
                              : ""
                        }`
                      : "No deadline is recorded against this regime."}
                </p>
                {duty.state === "missed" && duty.consequenceIfMissed ? (
                  <p className="mt-1 text-2xs text-danger-fg">{duty.consequenceIfMissed}</p>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}

        {incident.notification.reasons && incident.notification.reasons.length > 0 ? (
          <ReasonList reasons={incident.notification.reasons} className="mb-3" />
        ) : null}
        {incident.notification.notifications.length > 0 ? (
          <Timeline
            timeFormat="absolute"
            items={incident.notification.notifications.map((n, i) => ({
              id: `${n.regime ?? i}`,
              title: REGIME_LABEL[n.regime ?? ""] ?? n.regime ?? "Notification",
              timestamp: n.notifiedAt ?? null,
              description: [n.method, n.reference].filter(Boolean).join(" · ") || undefined,
              tone: "success" as const,
            }))}
            aria-label="Notifications made"
          />
        ) : (
          <EmptyState
            size="sm"
            icon={IconWarning}
            tone={incident.isReportable ? "danger" : "neutral"}
            title="No notification has been recorded"
            hint={
              incident.isReportable
                ? "This incident is classified reportable. Until a notification is recorded here the duty is live, and the incident cannot be closed."
                : "None is owed on the facts held. If the facts change, reassess before assuming that still holds."
            }
          />
        )}

        <Card className="mt-3">
          <CardBody className="grid gap-3 sm:grid-cols-3">
            <Field label="Regime">
              <Select value={notifyRegime} onChange={(e) => setNotifyRegime(e.target.value)}>
                {REGIMES.map((r) => (
                  <option key={r} value={r}>
                    {REGIME_LABEL[r] ?? r}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Regulator reference">
              <Input
                value={notifyReference}
                placeholder="F2508 submission id"
                onChange={(e) => setNotifyReference(e.target.value)}
              />
            </Field>
            <Field label="Method">
              <Input
                value={notifyMethod}
                placeholder="Online form / telephone"
                onChange={(e) => setNotifyMethod(e.target.value)}
              />
            </Field>
            <div className="sm:col-span-3">
              <Button
                size="sm"
                loading={mutation.busy === "notify"}
                onClick={() =>
                  void mutation.run("notify", "This notification could not be recorded", () =>
                    api.post(
                      `/api/v1/projects/${projectId}/safety/incidents/${incident.id}/notify-regulator`,
                      {
                        regime: notifyRegime,
                        ...(notifyReference ? { reference: notifyReference } : {}),
                        ...(notifyMethod ? { method: notifyMethod } : {}),
                      },
                    ),
                  )
                }
              >
                Record the notification
              </Button>
            </div>
          </CardBody>
        </Card>
      </section>
    </div>
  );
}

function stale(assessment: ReportabilityResponse): boolean {
  return assessment.stored.isReportable !== assessment.current.isReportable;
}

/* ========================================================================== */
/* Investigation                                                               */
/* ========================================================================== */

function InvestigationSection({
  projectId,
  incident,
  users,
  mutation,
}: {
  projectId: string;
  incident: IncidentDetail;
  users: Map<string, string>;
  mutation: Mutation;
}) {
  const inv = incident.investigation;
  const [leadId, setLeadId] = useState(inv.leadId ?? "");
  const [dueDate, setDueDate] = useState(inv.dueDate ?? "");
  const [method, setMethod] = useState(inv.rootCauseMethod);
  const [rootCause, setRootCause] = useState(inv.rootCause ?? "");
  const [findings, setFindings] = useState(inv.findings ?? "");
  const [factors, setFactors] = useState(inv.contributingFactors ?? []);
  const [newFactor, setNewFactor] = useState("");
  const [newFactorCategory, setNewFactorCategory] = useState("");

  const locked = inv.status === "complete";

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={INVESTIGATION_STATUS_TONE[inv.status] ?? "neutral"} size="sm" dot>
          {labelize(inv.status)}
        </Badge>
        {inv.isOverdue ? (
          <Badge tone="danger" size="sm">
            {count(inv.daysOverdue)} days past the due date
          </Badge>
        ) : null}
        {inv.approvedBy ? (
          <Badge tone="success" size="sm" variant="outline">
            Signed off by {nameOf(users, inv.approvedBy)} · {dateTime(inv.approvedAt)}
          </Badge>
        ) : null}
      </div>

      {locked ? (
        <Alert tone="info" title="This investigation is complete and signed off">
          Its findings can no longer be amended. Changing a signed-off conclusion without a record
          that it changed is exactly what the lock exists to prevent — reopen the incident instead.
        </Alert>
      ) : null}

      <Card>
        <CardBody className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label="Investigation lead"
              hint="Must not be the line manager of the injured person."
            >
              <Input
                value={leadId}
                placeholder="user id"
                disabled={locked}
                onChange={(e) => setLeadId(e.target.value)}
              />
            </Field>
            <Field label="Due date">
              <Input
                type="date"
                value={dueDate}
                disabled={locked}
                onChange={(e) => setDueDate(e.target.value)}
              />
            </Field>
          </div>

          <Field
            label="Root cause method"
            hint="&quot;We asked around&quot; is not a method. A conclusion reached without one cannot be tested by anybody else."
          >
            <Select
              value={method}
              disabled={locked}
              onChange={(e) => setMethod(e.target.value as typeof method)}
            >
              {ROOT_CAUSE_METHODS.map((m) => (
                <option key={m} value={m}>
                  {m === "none" ? "None recorded" : labelize(m)}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Root cause">
            <Textarea
              rows={3}
              value={rootCause}
              disabled={locked}
              placeholder="The condition which, if removed, would have prevented this."
              onChange={(e) => setRootCause(e.target.value)}
            />
          </Field>

          <Field
            label="Contributing factors"
            hint="An incident with a single cause and nothing around it has been described, not investigated. The organisational factors are the ones that produce the next one."
          >
            <div className="space-y-2">
              {factors.length === 0 ? (
                <p className="text-meta text-content-subtle">None recorded yet.</p>
              ) : (
                <ul className="space-y-1.5">
                  {factors.map((f, i) => (
                    <li
                      key={i}
                      className="flex items-start justify-between gap-2 rounded-md border border-border bg-surface-raised px-2.5 py-1.5"
                    >
                      <span className="min-w-0">
                        <span className="block text-meta text-content">{f.factor}</span>
                        {f.category ? (
                          <span className="block text-2xs text-content-subtle">
                            {f.category}
                          </span>
                        ) : null}
                      </span>
                      {locked ? null : (
                        <Button
                          size="xs"
                          variant="ghost"
                          onClick={() => setFactors(factors.filter((_, j) => j !== i))}
                        >
                          Remove
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {locked ? null : (
                <div className="flex flex-wrap gap-2">
                  <Input
                    value={newFactor}
                    placeholder="Factor"
                    className="min-w-52 flex-1"
                    onChange={(e) => setNewFactor(e.target.value)}
                  />
                  <Input
                    value={newFactorCategory}
                    placeholder="Category (organisational, task, environment…)"
                    className="min-w-52 flex-1"
                    onChange={(e) => setNewFactorCategory(e.target.value)}
                  />
                  <Button
                    size="sm"
                    variant="secondary"
                    leadingIcon={IconPlus}
                    disabled={newFactor.trim() === ""}
                    onClick={() => {
                      setFactors([
                        ...factors,
                        {
                          factor: newFactor.trim(),
                          ...(newFactorCategory ? { category: newFactorCategory } : {}),
                        },
                      ]);
                      setNewFactor("");
                      setNewFactorCategory("");
                    }}
                  >
                    Add
                  </Button>
                </div>
              )}
            </div>
          </Field>

          <Field label="Findings">
            <Textarea
              rows={5}
              value={findings}
              disabled={locked}
              placeholder="What the investigation concluded, and on what evidence."
              onChange={(e) => setFindings(e.target.value)}
            />
          </Field>

          {locked ? null : (
            <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
              <Button
                size="sm"
                variant="secondary"
                loading={mutation.busy === "investigation"}
                onClick={() =>
                  void mutation.run(
                    "investigation",
                    "The investigation could not be saved",
                    () =>
                      api.post(
                        `/api/v1/projects/${projectId}/safety/incidents/${incident.id}/investigation`,
                        {
                          investigationLeadId: leadId || null,
                          investigationDueDate: dueDate || null,
                          rootCauseMethod: method,
                          rootCause: rootCause || null,
                          contributingFactors: factors,
                          investigationFindings: findings || null,
                        },
                      ),
                  )
                }
              >
                Save the investigation
              </Button>
              <Button
                size="sm"
                loading={mutation.busy === "complete"}
                disabled={inv.status === "not_started" || inv.status === "under_review"}
                onClick={() =>
                  void mutation.run(
                    "complete",
                    "The investigation cannot be completed yet",
                    () =>
                      api.post(
                        `/api/v1/projects/${projectId}/safety/incidents/${incident.id}/investigation/complete`,
                        {},
                      ),
                  )
                }
              >
                Submit for sign-off
              </Button>
              <Button
                size="sm"
                variant="outline"
                loading={mutation.busy === "approve"}
                disabled={inv.status !== "under_review"}
                onClick={() =>
                  void mutation.run(
                    "approve",
                    "This investigation cannot be signed off",
                    () =>
                      api.post(
                        `/api/v1/projects/${projectId}/safety/incidents/${incident.id}/investigation/approve`,
                        {},
                      ),
                  )
                }
              >
                Sign off
              </Button>
            </div>
          )}

          <p className="text-2xs text-content-subtle">
            Sign-off is a second act by a second person: the platform refuses an approval by the
            investigation lead. Completion is a claim; sign-off is somebody else agreeing with it.
          </p>
        </CardBody>
      </Card>
    </div>
  );
}

/* ========================================================================== */
/* Actions and briefings                                                       */
/* ========================================================================== */

function ActionsSection({
  projectId,
  incident,
  mutation,
}: {
  projectId: string;
  incident: IncidentDetail;
  mutation: Mutation;
}) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [hierarchy, setHierarchy] = useState("engineering");
  const [ownerName, setOwnerName] = useState("");
  const [dueDate, setDueDate] = useState(today());

  return (
    <div className="space-y-3">
      <SectionHeading
        title={`Corrective actions · ${count(incident.actions.length)}`}
        hint="Raised off this incident and held in the one project-wide register, alongside those from observations, inspections and quality NCRs."
        actions={
          <Button size="sm" variant={open ? "ghost" : "secondary"} onClick={() => setOpen(!open)}>
            {open ? "Cancel" : "Raise an action"}
          </Button>
        }
      />

      {open ? (
        <Card>
          <CardBody className="grid gap-3 sm:grid-cols-2">
            <Field label="Title" className="sm:col-span-2">
              <Input value={title} onChange={(e) => setTitle(e.target.value)} />
            </Field>
            <Field
              label="Level of control"
              hint="Recorded because eliminating a hazard and retraining an operative are not equivalent."
            >
              <Select value={hierarchy} onChange={(e) => setHierarchy(e.target.value)}>
                {HIERARCHY_ORDER.map((h, i) => (
                  <option key={h} value={h}>
                    {i + 1}. {HIERARCHY_LABEL[h]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Owner" hint="An action with a date and no name is a wish.">
              <Input value={ownerName} onChange={(e) => setOwnerName(e.target.value)} />
            </Field>
            <Field label="Due date">
              <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
            </Field>
            <div className="sm:col-span-2">
              <Button
                size="sm"
                disabled={title.trim() === "" || ownerName.trim() === ""}
                loading={mutation.busy === "raise-action"}
                onClick={() =>
                  void mutation.run("raise-action", "This action could not be raised", async () => {
                    await api.post(`/api/v1/projects/${projectId}/safety/corrective-actions`, {
                      sourceType: "incident",
                      sourceId: incident.id,
                      title: title.trim(),
                      hierarchyOfControl: hierarchy,
                      ownerName: ownerName.trim(),
                      dueDate,
                    });
                    setOpen(false);
                    setTitle("");
                    setOwnerName("");
                  })
                }
              >
                Raise the action
              </Button>
            </div>
          </CardBody>
        </Card>
      ) : null}

      <ActionList
        actions={incident.actions}
        emptyTitle="No corrective action has been raised from this incident"
        emptyHint="An incident investigated and closed with nothing raised is an incident nobody acted on. If the control was already adequate, say so in the findings rather than leaving the register silent."
      />
    </div>
  );
}

function BriefingsSection({ incident }: { incident: IncidentDetail }) {
  return (
    <div className="space-y-3">
      <SectionHeading
        title="Briefings given because of this incident"
        hint="A toolbox talk linked back to the incident is the evidence that a lesson was actually pushed to the people it concerned — not merely written down."
      />
      {incident.briefings.length === 0 ? (
        <EmptyState
          size="sm"
          title="No briefing has been linked to this incident"
          hint="Nothing on this project cites this incident as its reason. Either the lesson has not been passed on, or the talk that passed it on was not linked back — and from the register they look identical."
        />
      ) : (
        <Timeline
          timeFormat="absolute"
          items={incident.briefings.map((b) => ({
            id: b.id,
            title: `${b.reference} · ${b.title}`,
            timestamp: `${b.talkDate}T00:00:00Z`,
            description: `${count(b.attendeeCount)} attendees · ${labelize(b.status)}`,
            tone: b.status === "verified" ? ("success" as const) : ("info" as const),
          }))}
          aria-label="Briefings linked to this incident"
        />
      )}
    </div>
  );
}

/* ========================================================================== */
/* Lifecycle                                                                   */
/* ========================================================================== */

function LifecycleFooter({
  projectId,
  incident,
  mutation,
}: {
  projectId: string;
  incident: IncidentDetail;
  mutation: Mutation;
}) {
  const [closeNote, setCloseNote] = useState("");
  const [reopenReason, setReopenReason] = useState("");

  const blockers: string[] = [];
  if (incident.investigation.status !== "complete") {
    blockers.push(
      `The investigation is \`${incident.investigation.status}\`. An incident closed without an approved investigation is a record that something happened and nothing was learned.`,
    );
  }
  /* Per DUTY, not per column. The old check read a single derived
   * `regulator_notified_at`, so filing the F2508 on a dual-regime incident
   * made the screen say closure was available while the OSHA duty was live. */
  const owedDuties = (incident.notification.duties ?? []).filter(
    (d) => d.state === "outstanding" || d.state === "missed",
  );
  if (incident.isReportable && owedDuties.length > 0) {
    blockers.push(
      `${owedDuties.length} statutory notification duty/duties are undischarged (${owedDuties
        .map((d) => `${d.regime} — ${labelize(d.state)}`)
        .join("; ")}). Closing it would take a live statutory duty off the register.`,
    );
  } else if (incident.isReportable && (incident.notification.duties ?? []).length === 0 && !incident.notification.notifiedAt) {
    blockers.push(
      "This incident is classified reportable and no notification has been recorded. Closing it would take a live statutory duty off the register.",
    );
  }
  if (incident.openActionCount > 0) {
    blockers.push(
      `${count(incident.openActionCount)} corrective action(s) are still open against it.`,
    );
  }

  const closed = incident.status === "closed";

  return (
    <Card variant="sunken">
      <CardBody className="space-y-3">
        <SectionHeading
          title="Lifecycle"
          hint="Report → investigate → sign off → close. Each step has a precondition, and the platform states it rather than greying a button out silently."
        />

        {closed ? (
          <>
            <Alert tone="neutral" title={`Closed ${dateTime(incident.closedAt)}`}>
              Reopening is recorded and counted — this incident has been reopened{" "}
              {count(incident.reopenedCount)} time{incident.reopenedCount === 1 ? "" : "s"}.
            </Alert>
            <Field label="Why is it being reopened?">
              <Textarea
                rows={2}
                value={reopenReason}
                onChange={(e) => setReopenReason(e.target.value)}
              />
            </Field>
            <Button
              size="sm"
              variant="outline"
              disabled={reopenReason.trim() === ""}
              loading={mutation.busy === "reopen"}
              onClick={() =>
                void mutation.run("reopen", "This incident could not be reopened", () =>
                  api.post(
                    `/api/v1/projects/${projectId}/safety/incidents/${incident.id}/reopen`,
                    { reason: reopenReason.trim() },
                  ),
                )
              }
            >
              Reopen the incident
            </Button>
          </>
        ) : (
          <>
            {blockers.length > 0 ? (
              <div className="rounded-lg border border-warning-border bg-warning-subtle/50 p-3">
                <p className="text-label uppercase text-warning-fg">
                  This incident cannot be closed yet
                </p>
                <ReasonList reasons={blockers} className="mt-1" />
              </div>
            ) : null}
            <Field label="Closing note">
              <Textarea
                rows={2}
                value={closeNote}
                placeholder="What was learned, and what changed as a result."
                onChange={(e) => setCloseNote(e.target.value)}
              />
            </Field>
            <Button
              size="sm"
              disabled={closeNote.trim() === ""}
              loading={mutation.busy === "close"}
              onClick={() =>
                void mutation.run("close", "This incident could not be closed", () =>
                  api.post(`/api/v1/projects/${projectId}/safety/incidents/${incident.id}/close`, {
                    note: closeNote.trim(),
                  }),
                )
              }
            >
              Close the incident
            </Button>
          </>
        )}
      </CardBody>
    </Card>
  );
}

/* ========================================================================== */
/* The injury facts the statutory tests turn on                                */
/* ========================================================================== */

const TREATMENT_LEVELS = [
  "none",
  "first_aid",
  "medical_treatment",
  "emergency_department",
  "hospitalised",
  "fatality",
];

const INJURY_NATURES = [
  "laceration",
  "contusion",
  "fracture",
  "sprain_strain",
  "burn_thermal",
  "burn_chemical",
  "amputation",
  "crush",
  "puncture",
  "foreign_body",
  "dislocation",
  "concussion",
  "electric_shock",
  "asphyxiation",
  "hearing_loss",
  "respiratory",
  "dermatitis",
  "heat_illness",
  "hypothermia",
  "psychological",
  "multiple",
  "other",
];

const BODY_PARTS = [
  "head",
  "eye",
  "face",
  "neck",
  "shoulder",
  "arm",
  "elbow",
  "wrist",
  "hand",
  "finger",
  "chest",
  "abdomen",
  "back_upper",
  "back_lower",
  "hip",
  "leg",
  "knee",
  "ankle",
  "foot",
  "toe",
  "internal",
  "multiple",
  "not_applicable",
];

/**
 * The columns the reportability engine actually reads.
 *
 * These are the facts that decide whether a report is owed at all — an ankle
 * FRACTURE is a RIDDOR Schedule 1 specified injury whatever the days off are;
 * nine days away crosses the over-seven-day test and five does not; a case
 * moved from days-away to restricted duty leaves TRIR unchanged and DART
 * unchanged too. They arrive over days, from the clinic and from the person's
 * return, and until this form existed they could only be corrected through the
 * API — which meant the deadline on the register was frozen at whatever was
 * known in the first hour.
 *
 * Saving reassesses. If the corrected facts mean nothing is reportable any
 * more, the obligation the first assessment raised is withdrawn on the
 * register rather than left open against an incident the safety register says
 * is not reportable.
 */
function InjuryFactsCard({
  projectId,
  incident,
  mutation,
  onSaved,
}: {
  projectId: string;
  incident: IncidentDetail;
  mutation: Mutation;
  onSaved: () => void;
}) {
  const [treatmentLevel, setTreatmentLevel] = useState(incident.treatmentLevel ?? "");
  const [injuryNature, setInjuryNature] = useState(incident.injuryNature ?? "");
  const [bodyPart, setBodyPart] = useState(incident.bodyPart ?? "");
  const [isLostTime, setIsLostTime] = useState(incident.isLostTime);
  const [lostTimeDays, setLostTimeDays] = useState(
    incident.lostTimeDays === null ? "" : String(incident.lostTimeDays),
  );
  const [restrictedDutyDays, setRestrictedDutyDays] = useState(
    incident.restrictedDutyDays === null ? "" : String(incident.restrictedDutyDays),
  );
  const [returnToWorkDate, setReturnToWorkDate] = useState(incident.returnToWorkDate ?? "");

  useEffect(() => {
    setTreatmentLevel(incident.treatmentLevel ?? "");
    setInjuryNature(incident.injuryNature ?? "");
    setBodyPart(incident.bodyPart ?? "");
    setIsLostTime(incident.isLostTime);
    setLostTimeDays(incident.lostTimeDays === null ? "" : String(incident.lostTimeDays));
    setRestrictedDutyDays(
      incident.restrictedDutyDays === null ? "" : String(incident.restrictedDutyDays),
    );
    setReturnToWorkDate(incident.returnToWorkDate ?? "");
  }, [incident]);

  const editable = incident.status !== "closed" && incident.status !== "void";

  async function save() {
    await api.patch(`/api/v1/projects/${projectId}/safety/incidents/${incident.id}`, {
      treatmentLevel: treatmentLevel === "" ? null : treatmentLevel,
      injuryNature: injuryNature === "" ? null : injuryNature,
      bodyPart: bodyPart === "" ? null : bodyPart,
      isLostTime,
      lostTimeDays: lostTimeDays === "" ? null : Number(lostTimeDays),
      restrictedDutyDays: restrictedDutyDays === "" ? null : Number(restrictedDutyDays),
      returnToWorkDate: returnToWorkDate === "" ? null : returnToWorkDate,
    });
    await api.post(
      `/api/v1/projects/${projectId}/safety/incidents/${incident.id}/reportability`,
      {},
    );
    onSaved();
  }

  return (
    <section>
      <SectionHeading
        title="The injury facts"
        hint="What the statutory tests actually turn on. They arrive over days — from the clinic, and from the person's return — and correcting them here reassesses the classification and the deadline rather than leaving both frozen at what was known in the first hour."
      />
      <Card>
        <CardBody className="space-y-3">
          {!editable ? (
            <Alert tone="info" size="sm" title="This incident is closed">
              Its facts cannot be amended. Reopen it first — an investigated incident whose facts
              change after closure is a different incident, and the classification computed from
              those facts has to be recomputed on the record.
            </Alert>
          ) : null}

          <div className="grid gap-3 sm:grid-cols-3">
            <Field
              label="Treatment level"
              hint="OSHA's recordability test turns on treatment beyond the closed first-aid list; RIDDOR's on admission."
            >
              <Select
                value={treatmentLevel}
                disabled={!editable}
                onChange={(e) => setTreatmentLevel(e.target.value)}
              >
                <option value="">Not recorded</option>
                {TREATMENT_LEVELS.map((t) => (
                  <option key={t} value={t}>
                    {labelize(t)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Nature of injury">
              <Select
                value={injuryNature}
                disabled={!editable}
                onChange={(e) => setInjuryNature(e.target.value)}
              >
                <option value="">Not recorded</option>
                {INJURY_NATURES.map((t) => (
                  <option key={t} value={t}>
                    {labelize(t)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Body part">
              <Select
                value={bodyPart}
                disabled={!editable}
                onChange={(e) => setBodyPart(e.target.value)}
              >
                <option value="">Not recorded</option>
                {BODY_PARTS.map((t) => (
                  <option key={t} value={t}>
                    {labelize(t)}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          <div className="grid gap-3 sm:grid-cols-4">
            <Field label="Lost time">
              <Select
                value={isLostTime ? "true" : "false"}
                disabled={!editable}
                onChange={(e) => setIsLostTime(e.target.value === "true")}
              >
                <option value="false">No days away</option>
                <option value="true">Days away from work</option>
              </Select>
            </Field>
            <Field
              label="Days away"
              hint="Over seven crosses RIDDOR reg. 4(3); over three is a recording duty only."
            >
              <Input
                type="number"
                min={0}
                value={lostTimeDays}
                disabled={!editable}
                onChange={(e) => setLostTimeDays(e.target.value)}
              />
            </Field>
            <Field
              label="Restricted / transferred days"
              hint="A case moved from days-away to restricted duty leaves DART unchanged — which is the point of publishing both."
            >
              <Input
                type="number"
                min={0}
                value={restrictedDutyDays}
                disabled={!editable}
                onChange={(e) => setRestrictedDutyDays(e.target.value)}
              />
            </Field>
            <Field label="Returned to work">
              <Input
                type="date"
                value={returnToWorkDate}
                disabled={!editable}
                onChange={(e) => setReturnToWorkDate(e.target.value)}
              />
            </Field>
          </div>

          <Button
            size="sm"
            variant="secondary"
            disabled={!editable}
            loading={mutation.busy === "injury-facts"}
            onClick={() =>
              void mutation.run(
                "injury-facts",
                "The injury facts could not be amended",
                save,
              )
            }
          >
            Save and reassess
          </Button>
        </CardBody>
      </Card>
    </section>
  );
}
