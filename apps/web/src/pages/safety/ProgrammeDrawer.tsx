/**
 * ONE PROGRAMME RECORD — and the three acts that make it worth anything.
 *
 * APPROVAL is by somebody other than the author. A method statement approved
 * by the person who wrote it is a document nobody checked, and the platform
 * refuses it.
 *
 * ACKNOWLEDGEMENT is the evidence an inspector actually relies on: proof that
 * the person doing the work had seen the RAMS, the permit or the policy. This
 * screen is explicit about WHO said it, because the API now is: a caller
 * acknowledges for themselves, a company owner or admin may record on somebody
 * else's behalf and the entry says so, and recording for a WORKER — who is not
 * a platform user and cannot press anything — needs a method that carries its
 * own evidence plus a written attestation of what was witnessed.
 *
 * SUPERSEDING issues a new version and says plainly that the old
 * acknowledgements do not carry forward. They cannot: nobody has read the new
 * document yet.
 */
import { useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  DescriptionList,
  Drawer,
  Field,
  Input,
  Select,
  Skeleton,
  Textarea,
  type DescriptionItem,
} from "../../ui";
import { IconCompliance } from "../../ui/icons";
import { api } from "../../lib/api";
import {
  EM_DASH,
  LoadError,
  RECORD_STATUS_TONE,
  RefusalNotice,
  SectionHeading,
  count,
  dateTime,
  isoDate,
  labelize,
  nameOf,
  useMutation,
  useResource,
  type ProgrammeRecord,
} from "./safetyShared";

/**
 * Methods that carry their own evidence. `verbal_confirmed` and an on-device
 * signature recorded BY SOMEBODY ELSE do not — they are one person's word that
 * another person read something, which is exactly what an inspector discounts —
 * so the API refuses them for a worker and this list matches it.
 */
const ATTESTABLE_METHODS = [
  "wet_signature",
  "biometric",
  "qr_scan",
  "badge_scan",
  "supervisor_attested",
];

const SELF_METHODS = ["on_device_signature", "wet_signature", "biometric", "qr_scan", "badge_scan"];

export default function ProgrammeDrawer({
  recordId,
  users,
  vendors,
  onClose,
  onMutated,
}: {
  recordId: string | null;
  users: Map<string, string>;
  vendors: Map<string, string>;
  onClose: () => void;
  onMutated: () => void;
}) {
  const [version, setVersion] = useState(0);
  const [subject, setSubject] = useState<"me" | "user" | "worker">("me");
  const [subjectUserId, setSubjectUserId] = useState("");
  const [workerId, setWorkerId] = useState("");
  const [method, setMethod] = useState("on_device_signature");
  const [attestation, setAttestation] = useState("");
  const [newVersion, setNewVersion] = useState("");
  const [supersedeReason, setSupersedeReason] = useState("");

  const detail = useResource<ProgrammeRecord>(
    (signal) =>
      api.get<ProgrammeRecord>(
        `/api/v1/companies/current/safety/programme-records/${recordId}`,
        { signal },
      ),
    [recordId, version],
    recordId !== null,
  );

  const mutation = useMutation(() => {
    setVersion((n) => n + 1);
    onMutated();
  });

  const record = detail.data;
  const acknowledgements = record?.acknowledgements ?? [];

  const facts: DescriptionItem[] = record
    ? [
        { label: "Kind", value: labelize(record.recordKind) },
        { label: "Version", value: record.version ?? EM_DASH },
        {
          label: "Scope",
          value: record.projectId ? "This project" : "Company-wide",
          hint: "A company-level record applies across every project.",
        },
        { label: "Belongs to", value: record.vendorId ? nameOf(vendors, record.vendorId) : "Us" },
        { label: "Effective from", value: isoDate(record.effectiveFrom) },
        {
          label: "Expires",
          value: record.expiresAt
            ? `${isoDate(record.expiresAt)}${
                record.daysToExpiry === null
                  ? ""
                  : record.daysToExpiry < 0
                    ? ` · ${count(Math.abs(record.daysToExpiry))} days ago`
                    : ` · in ${count(record.daysToExpiry)} days`
              }`
            : "Does not expire",
          hint: record.isCriticalKind
            ? "This kind stops work when it lapses rather than merely dating a file."
            : undefined,
        },
        { label: "Review due", value: isoDate(record.reviewDueDate) },
        { label: "Regulatory reference", value: record.regulatoryReference ?? EM_DASH },
        {
          label: "Permit-to-work",
          value: record.sitePermitId ?? EM_DASH,
          hint: "The live authorisation in site operations. This record is the document it was issued against.",
        },
        {
          label: "Approved",
          value: record.approvedAt
            ? `${dateTime(record.approvedAt)} by ${nameOf(users, record.approvedBy)}`
            : "Not approved — it is a draft and nothing depends on it yet",
          span: 2,
        },
      ]
    : [];

  return (
    <Drawer
      open={recordId !== null}
      onClose={onClose}
      size="lg"
      icon={IconCompliance}
      tone={record?.isExpired ? "danger" : undefined}
      title={record ? `${record.reference} · ${record.title}` : "Programme record"}
      headerActions={
        record ? (
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone={RECORD_STATUS_TONE[record.status] ?? "neutral"} size="sm" dot>
              {labelize(record.status)}
            </Badge>
            {record.isExpired ? (
              <Badge tone="danger" size="sm">
                Expired
              </Badge>
            ) : null}
          </div>
        ) : null
      }
    >
      {detail.error ? (
        <LoadError
          message={detail.error}
          onRetry={detail.reload}
          title="This record could not be loaded"
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

      {detail.loading && !record ? (
        <Skeleton height={280} />
      ) : record ? (
        <div className="space-y-4">
          {record.isExpired ? (
            <Alert tone="danger" title="This record has lapsed">
              {record.isCriticalKind
                ? "The activity it authorised is now unauthorised. Renew it, supersede it, or stop the work — the register cannot make that choice."
                : "It is out of date. Anything relying on it is relying on a document that is no longer in force."}
            </Alert>
          ) : null}

          <DescriptionList items={facts} columns={2} dividers />

          {record.description ? (
            <p className="whitespace-pre-wrap text-meta text-content-muted">{record.description}</p>
          ) : null}

          {/* ---------------------------------------------------------- */}
          {record.status === "draft" || record.status === "in_review" ? (
            <section>
              <SectionHeading
                title="Approval"
                hint="By somebody other than the author. The platform refuses a self-approval — a document approved by the person who wrote it has been filed, not checked."
              />
              <Button
                size="sm"
                loading={mutation.busy === "approve"}
                onClick={() =>
                  void mutation.run("approve", "This record could not be approved", () =>
                    api.post(
                      `/api/v1/companies/current/safety/programme-records/${record.id}/approve`,
                      {},
                    ),
                  )
                }
              >
                Approve and bring into force
              </Button>
            </section>
          ) : null}

          {/* ---------------------------------------------------------- */}
          <section>
            <SectionHeading
              title={`Acknowledgements · ${count(record.acknowledgementCount)}`}
              hint={
                record.acknowledgementShortfall === null
                  ? "No target was set, so there is no shortfall to report."
                  : record.acknowledgementShortfall > 0
                    ? `${record.acknowledgementShortfall} still owed against the target set on this record.`
                    : "The target set on this record has been met."
              }
            />

            <Card>
              <CardBody className="space-y-3">
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Recording for">
                    <Select
                      value={subject}
                      onChange={(e) => {
                        const next = e.target.value;
                        setSubject(next === "user" ? "user" : next === "worker" ? "worker" : "me");
                        setMethod(next === "worker" ? "wet_signature" : "on_device_signature");
                      }}
                    >
                      <option value="me">Myself</option>
                      <option value="user">Another platform user (admins only)</option>
                      <option value="worker">A registered worker</option>
                    </Select>
                  </Field>
                  <Field label="Method">
                    <Select value={method} onChange={(e) => setMethod(e.target.value)}>
                      {(subject === "worker" ? ATTESTABLE_METHODS : SELF_METHODS).map((m) => (
                        <option key={m} value={m}>
                          {labelize(m)}
                        </option>
                      ))}
                    </Select>
                  </Field>
                </div>

                {subject === "user" ? (
                  <Field
                    label="User"
                    hint="Recording that somebody else has read a policy is an assertion about their knowledge — the platform limits it to a company owner or admin and stores who made it."
                  >
                    <Select
                      value={subjectUserId}
                      onChange={(e) => setSubjectUserId(e.target.value)}
                    >
                      <option value="">Choose a user</option>
                      {[...users.entries()].map(([id, name]) => (
                        <option key={id} value={id}>
                          {name}
                        </option>
                      ))}
                    </Select>
                  </Field>
                ) : null}

                {subject === "worker" ? (
                  <>
                    <Field
                      label="Worker id"
                      hint="From the workforce register — the same one that carries induction and site access."
                    >
                      <Input
                        value={workerId}
                        placeholder="wkr_…"
                        onChange={(e) => setWorkerId(e.target.value)}
                      />
                    </Field>
                    {method === "supervisor_attested" ? (
                      <Field
                        label="What was witnessed"
                        required
                        hint="The briefing given, the questions asked, the date and the place. 'Attested' with nothing behind it is the weakest evidence in the file."
                      >
                        <Textarea
                          rows={2}
                          value={attestation}
                          onChange={(e) => setAttestation(e.target.value)}
                        />
                      </Field>
                    ) : null}
                  </>
                ) : null}

                <Button
                  size="sm"
                  variant="secondary"
                  disabled={
                    (subject === "user" && subjectUserId === "") ||
                    (subject === "worker" && workerId.trim() === "") ||
                    (subject === "worker" &&
                      method === "supervisor_attested" &&
                      attestation.trim() === "")
                  }
                  loading={mutation.busy === "ack"}
                  onClick={() =>
                    void mutation.run("ack", "That acknowledgement could not be recorded", () =>
                      api.post(
                        `/api/v1/companies/current/safety/programme-records/${record.id}/acknowledge`,
                        {
                          ...(subject === "user" ? { userId: subjectUserId } : {}),
                          ...(subject === "worker" ? { workerId: workerId.trim() } : {}),
                          method,
                          ...(attestation.trim() ? { attestation: attestation.trim() } : {}),
                        },
                      ),
                    )
                  }
                >
                  Record the acknowledgement
                </Button>
              </CardBody>
            </Card>

            {acknowledgements.length > 0 ? (
              <ul className="mt-2 space-y-1">
                {acknowledgements.map((a, i) => (
                  <li
                    key={i}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-surface-raised px-2.5 py-1.5"
                  >
                    <span className="text-meta text-content">
                      {a.workerId ? `Worker ${a.workerId}` : nameOf(users, a.userId)}
                      <span className="block text-2xs text-content-subtle">
                        {dateTime(a.acknowledgedAt)} · {labelize(a.method)}
                        {a.attestation ? ` · "${a.attestation}"` : ""}
                      </span>
                    </span>
                    <Badge
                      tone={a.selfRecorded === false ? "warning" : "neutral"}
                      size="xs"
                      variant="outline"
                    >
                      {a.selfRecorded === false
                        ? `recorded by ${nameOf(users, a.recordedOnBehalf?.by ?? a.recordedBy)}`
                        : "self-recorded"}
                    </Badge>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-2xs text-content-subtle">
                Nobody has acknowledged this record. That is a statement about the briefing, not
                about the document.
              </p>
            )}
          </section>

          {/* ---------------------------------------------------------- */}
          {record.supersededById ? (
            <Alert tone="info" title="Superseded">
              A later version has replaced this one. It is kept because what was in force at a given
              date is a fact somebody may have to defend.
            </Alert>
          ) : (
            <section>
              <SectionHeading
                title="Supersede"
                hint="Issues a new version. The old acknowledgements do NOT carry forward — nobody has read the new document yet, and pretending otherwise is the single most common way a RAMS file becomes fiction."
              />
              <Card>
                <CardBody className="space-y-3">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="New version" required>
                      <Input
                        value={newVersion}
                        placeholder="2.0"
                        onChange={(e) => setNewVersion(e.target.value)}
                      />
                    </Field>
                    <Field label="Why" hint="What changed, in a line.">
                      <Input
                        value={supersedeReason}
                        onChange={(e) => setSupersedeReason(e.target.value)}
                      />
                    </Field>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={newVersion.trim() === ""}
                    loading={mutation.busy === "supersede"}
                    onClick={() =>
                      void mutation.run("supersede", "This record could not be superseded", () =>
                        api.post(
                          `/api/v1/companies/current/safety/programme-records/${record.id}/supersede`,
                          {
                            title: record.title,
                            version: newVersion.trim(),
                            ...(supersedeReason.trim() ? { reason: supersedeReason.trim() } : {}),
                          },
                        ),
                      )
                    }
                  >
                    Issue a new version
                  </Button>
                </CardBody>
              </Card>
            </section>
          )}
        </div>
      ) : null}
    </Drawer>
  );
}
