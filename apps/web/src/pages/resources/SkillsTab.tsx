/**
 * SKILLS & CERTIFICATION MATRIX (spec Vol I #692–696).
 *
 * The matrix keeps two states apart and shows both: the EVIDENCE state (did
 * anybody other than the claimant check?) and the VALIDITY state (is it still
 * in date?). A verified certificate expires exactly like an unverified one,
 * and a green tick that conflated the two is how an uncertificated operator
 * ends up on a machine.
 *
 * "No expiry recorded" renders as unknown, never as valid.
 */
import { useMemo, useState } from "react";
import { toast } from "sonner";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Field,
  Input,
  Modal,
  Select,
  Table,
  Td,
  Th,
} from "../../ui";
import { IconCompliance, IconPlus, IconUsers } from "../../ui/icons";
import {
  LoadError,
  Pill,
  ReasonList,
  Row,
  VALIDITY_TONE,
  count,
  dateOnly,
  percent,
  resourcesApi,
  severityTone,
  titleCase,
  useAction,
  useResource,
  type Paginated,
  type ResourceSkill,
  type SkillGap,
  type SkillsMatrix,
  type WorkerSkillRow,
} from "./resourcesShared";

export default function SkillsTab({
  projectId,
  onChanged,
}: {
  projectId: string;
  onChanged: () => void;
}) {
  const action = useAction();
  const [nonce, setNonce] = useState(0);
  const [onlyGaps, setOnlyGaps] = useState(false);
  const [recording, setRecording] = useState(false);

  const matrix = useResource<SkillsMatrix>(
    `/api/v1/projects/${projectId}/resources/skills-matrix?onlyGaps=${onlyGaps}&_=${nonce}`,
  );
  const gaps = useResource<{ total: number; items: SkillGap[]; reasons: string[] }>(
    `/api/v1/projects/${projectId}/resources/skill-gaps?_=${nonce}`,
  );
  const records = useResource<Paginated<WorkerSkillRow>>(
    `/api/v1/projects/${projectId}/worker-skills?pageSize=200&_=${nonce}`,
  );
  const skills = useResource<Paginated<ResourceSkill>>(
    "/api/v1/resource-skills?pageSize=200&status=active",
  );

  const bump = () => {
    setNonce((n) => n + 1);
    onChanged();
  };

  const m = matrix.data;
  const skillColumns = useMemo(() => m?.coverage.map((c) => c.skill) ?? [], [m]);

  return (
    <div className="space-y-4">
      {action.error ? (
        <Alert tone="danger" size="sm" onDismiss={action.clear}>
          {action.error}
        </Alert>
      ) : null}

      <Card>
        <CardHeader
          title="Coverage by ticket"
          subtitle="How many people on this project's register hold each certification, and how many of those are still in date"
          actions={
            <Button size="sm" icon={IconPlus} onClick={() => setRecording(true)}>
              Record a ticket
            </Button>
          }
        />
        <CardBody flush>
          {matrix.error ? (
            <div className="p-4">
              <LoadError message={matrix.error} onRetry={matrix.reload} />
            </div>
          ) : m && m.coverage.length > 0 ? (
            <Table dense>
              <thead>
                <tr>
                  <Th>Certification</Th>
                  <Th align="right">Holders</Th>
                  <Th align="right">Valid</Th>
                  <Th align="right">Expiring</Th>
                  <Th align="right">Expired</Th>
                  <Th align="right">No expiry</Th>
                  <Th align="right">Unverified</Th>
                  <Th align="right">Coverage</Th>
                </tr>
              </thead>
              <tbody>
                {m.coverage.map((c) => (
                  <tr key={c.skill.id} title={c.reasons.join(" ")}>
                    <Td>
                      <div className="font-medium text-content">
                        {c.skill.name}{" "}
                        {c.skill.isMandatory ? (
                          <Badge tone="danger" size="xs">
                            Mandatory
                          </Badge>
                        ) : null}
                      </div>
                      <div className="text-2xs text-content-subtle">
                        {c.skill.code} · {titleCase(c.skill.category)}
                      </div>
                    </Td>
                    <Td align="right">{count(c.workersHolding)}</Td>
                    <Td align="right">{count(c.valid)}</Td>
                    <Td align="right">{count(c.expiring)}</Td>
                    <Td align="right">{count(c.expired)}</Td>
                    <Td align="right">{count(c.unknownExpiry)}</Td>
                    <Td align="right">{count(c.unverified)}</Td>
                    <Td align="right">{percent(c.coveragePercent)}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          ) : (
            <div className="p-4">
              <EmptyState
                title="No matrix to build"
                hint={
                  m?.reasons[0] ??
                  "Define the tickets the work actually requires, then record who holds them."
                }
                icon={IconCompliance}
                size="sm"
              />
            </div>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="The matrix"
          subtitle="Evidence state and validity state are shown separately: a verified certificate expires like any other"
          actions={
            <label className="flex items-center gap-2 text-meta text-content">
              <input
                type="checkbox"
                checked={onlyGaps}
                onChange={(e) => setOnlyGaps(e.target.checked)}
              />
              Only rows with a problem
            </label>
          }
        />
        <CardBody flush>
          {m && m.rows.length > 0 ? (
            <div className="overflow-x-auto">
              <Table dense>
                <thead>
                  <tr>
                    <Th className="sticky left-0 z-10 bg-surface">Worker</Th>
                    {skillColumns.map((s) => (
                      <Th key={s.id} align="center" className="whitespace-nowrap">
                        {s.code}
                      </Th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {m.rows.map((r) => (
                    <tr key={r.worker.id}>
                      <Td className="sticky left-0 z-10 bg-surface">
                        <div className="font-medium text-content">{r.worker.fullName}</div>
                        <div className="text-2xs text-content-subtle">
                          {r.worker.reference}
                          {r.worker.trade ? ` · ${r.worker.trade}` : ""}
                          {r.gapCount > 0 ? ` · ${r.gapCount} gap(s)` : ""}
                        </div>
                      </Td>
                      {r.cells.map((c) => (
                        <Td key={c.skillId} align="center">
                          <span title={c.reason}>
                            {c.held ? (
                              <Badge tone={VALIDITY_TONE[c.validity] ?? "neutral"} size="xs">
                                {c.status === "verified" ? "✓" : "?"}{" "}
                                {c.daysToExpiry === null ? "—" : `${c.daysToExpiry}d`}
                              </Badge>
                            ) : (
                              <span className="text-2xs text-content-subtle">·</span>
                            )}
                          </span>
                        </Td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </Table>
            </div>
          ) : (
            <div className="p-4">
              <EmptyState
                title={onlyGaps ? "Nobody has a gap" : "Nobody on the register yet"}
                hint="The matrix reads the workforce register rather than keeping a second list of people."
                icon={IconUsers}
                size="sm"
              />
            </div>
          )}
        </CardBody>
        {m ? (
          <CardBody>
            <div className="grid gap-3 sm:grid-cols-4">
              <Row label="Workers">{count(m.totals.workers)}</Row>
              <Row label="Mandatory gaps">{count(m.totals.mandatoryGaps)}</Row>
              <Row label="Expired">{count(m.totals.expired)}</Row>
              <Row label="Unverified">{count(m.totals.unverified)}</Row>
            </div>
            <ReasonList reasons={m.reasons} className="mt-2" />
          </CardBody>
        ) : null}
      </Card>

      <Card>
        <CardHeader
          title="Booked without the ticket"
          subtitle="Including the one nobody catches by hand: a ticket that is valid today and lapses in week three of a six-week booking"
        />
        <CardBody>
          {gaps.error ? (
            <LoadError message={gaps.error} onRetry={gaps.reload} />
          ) : gaps.data && gaps.data.items.length > 0 ? (
            <ul className="space-y-2">
              {gaps.data.items.map((g) => (
                <li
                  key={`${g.assignmentId}-${g.skillId}`}
                  className="rounded-md border border-border-subtle bg-surface-raised p-3"
                >
                  <div className="mb-1 flex flex-wrap items-center gap-2">
                    <Pill status={g.kind} map={{ [g.kind]: severityTone(g.severity) }} />
                    <span className="text-meta font-medium text-content">{g.workerLabel}</span>
                    <span className="text-2xs text-content-subtle">
                      {g.skillName} · {g.assignmentReference}
                      {g.expiresAt ? ` · expires ${dateOnly(g.expiresAt)}` : ""}
                    </span>
                  </div>
                  <p className="text-2xs text-content-subtle">{g.explanation}</p>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState
              title="No gaps"
              hint={gaps.data?.reasons[0] ?? "Everybody booked holds what the work requires."}
              size="sm"
            />
          )}
          {gaps.data ? <ReasonList reasons={gaps.data.reasons} className="mt-2" /> : null}
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Every record"
          subtitle="Verification is a separate act by a separate person from the claim"
        />
        <CardBody flush>
          {records.error ? (
            <div className="p-3">
              <LoadError message={records.error} onRetry={records.reload} />
            </div>
          ) : records.data && records.data.items.length > 0 ? (
            <Table dense>
              <thead>
                <tr>
                  <Th>Worker</Th>
                  <Th>Ticket</Th>
                  <Th>Evidence</Th>
                  <Th>Validity</Th>
                  <Th>Expires</Th>
                  <Th align="right">Action</Th>
                </tr>
              </thead>
              <tbody>
                {records.data.items.map((r) => (
                  <tr key={r.id} title={r.validityReason}>
                    <Td>
                      {r.workerName}{" "}
                      <span className="text-2xs text-content-subtle">{r.workerReference}</span>
                    </Td>
                    <Td>
                      {r.skillName}
                      {r.isMandatory ? (
                        <Badge tone="danger" size="xs" className="ml-1">
                          Mandatory
                        </Badge>
                      ) : null}
                    </Td>
                    <Td>
                      <Badge tone={r.status === "verified" ? "success" : "warning"} size="xs">
                        {titleCase(r.status)}
                      </Badge>
                    </Td>
                    <Td>
                      <Badge tone={VALIDITY_TONE[r.validity] ?? "neutral"} size="xs">
                        {titleCase(r.validity)}
                      </Badge>
                    </Td>
                    <Td>{dateOnly(r.expiresAt)}</Td>
                    <Td align="right">
                      <Button
                        size="xs"
                        variant="ghost"
                        disabled={r.status === "verified"}
                        loading={action.busy === r.id}
                        onClick={async () => {
                          const res = await action.run(r.id, () =>
                            resourcesApi.verifyWorkerSkill(projectId, r.id, { decision: "verify" }),
                          );
                          if (res) {
                            toast.success("Verified");
                            bump();
                          }
                        }}
                      >
                        Verify
                      </Button>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          ) : (
            <div className="p-4">
              <EmptyState
                title="Nothing recorded"
                hint="Record the tickets people hold, then have somebody other than the person who entered them check the evidence."
                size="sm"
              />
            </div>
          )}
        </CardBody>
      </Card>

      <RecordTicketModal
        open={recording}
        projectId={projectId}
        skills={skills.data?.items ?? []}
        onClose={() => setRecording(false)}
        onSaved={() => {
          setRecording(false);
          bump();
        }}
      />
    </div>
  );
}

function RecordTicketModal({
  open,
  projectId,
  skills,
  onClose,
  onSaved,
}: {
  open: boolean;
  projectId: string;
  skills: ResourceSkill[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const action = useAction();
  const [workerId, setWorkerId] = useState("");
  const [skillId, setSkillId] = useState("");
  const [certificateRef, setCertificateRef] = useState("");
  const [issuedAt, setIssuedAt] = useState("");
  const [expiresAt, setExpiresAt] = useState("");

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Record a certification"
      description="Recording it is a claim. Somebody other than the person who records it has to verify the evidence before it counts as checked."
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            loading={action.busy === "save"}
            disabled={workerId.trim() === "" || skillId === ""}
            onClick={async () => {
              const res = await action.run("save", () =>
                resourcesApi.recordWorkerSkill(projectId, {
                  workerId: workerId.trim(),
                  skillId,
                  ...(certificateRef ? { certificateRef } : {}),
                  ...(issuedAt ? { issuedAt } : {}),
                  ...(expiresAt ? { expiresAt } : {}),
                }),
              );
              if (res) {
                toast.success("Recorded as a claim");
                setWorkerId("");
                setCertificateRef("");
                onSaved();
              }
            }}
          >
            Record
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        {action.error ? (
          <Alert tone="danger" size="sm" onDismiss={action.clear}>
            {action.error}
          </Alert>
        ) : null}
        <Field
          label="Worker id"
          required
          hint="From the workforce register — certifications are recorded against enrolled workers."
        >
          <Input value={workerId} onChange={(e) => setWorkerId(e.target.value)} />
        </Field>
        <Field label="Ticket" required>
          <Select value={skillId} onChange={(e) => setSkillId(e.target.value)}>
            <option value="">Choose…</option>
            {skills.map((s) => (
              <option key={s.id} value={s.id}>
                {s.code} — {s.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Certificate reference">
          <Input value={certificateRef} onChange={(e) => setCertificateRef(e.target.value)} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Issued">
            <Input type="date" value={issuedAt} onChange={(e) => setIssuedAt(e.target.value)} />
          </Field>
          <Field
            label="Expires"
            hint="Leaving this blank records the validity as unknown, which is not the same as “does not expire”."
          >
            <Input type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
          </Field>
        </div>
      </div>
    </Modal>
  );
}
