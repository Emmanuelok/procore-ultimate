/**
 * ONE INSPECTION AND TEST PLAN, opened over the register.
 *
 * The plan header is small on purpose. The SEQUENCE is the document: a chain
 * of activities in order, each with the point at which somebody else gets to
 * look, and a strip across the top that shows at a glance where the work is
 * currently stopped.
 *
 * The lifecycle bar carries the API's own segregation rule in words rather
 * than hiding it behind a disabled button: an ITP cannot be approved by the
 * person who authored or submitted it, and a plan the contractor approved for
 * itself agrees nothing with anybody.
 */
import { useMemo, useState } from "react";
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
import { IconPlus } from "../../ui/icons";
import { toneClass, type Tone } from "../../ui/tokens";
import { api } from "../../lib/api";
import ActivityCard, { isOverdueHoldPoint } from "./ActivityCard";
import {
  ITP_STATUS_TONE,
  INTERVENTION_LABEL,
  INTERVENTION_POINTS,
  INTERVENTION_TONE,
  Facts,
  LoadError,
  NothingHere,
  RESPONSIBLE_PARTIES,
  RefusalNotice,
  SectionTitle,
  dateTime,
  isoDate,
  labelize,
  nameOf,
  plural,
  useAction,
  useResource,
} from "./qualityShared";
import type { ItpActivity, ItpDetail } from "./types";

export default function ItpDrawer({
  itpId,
  projectId,
  users,
  onClose,
  onMutated,
}: {
  itpId: string | null;
  projectId: string;
  users: Map<string, string>;
  onClose: () => void;
  onMutated: () => void;
}) {
  const [nonce, setNonce] = useState(0);
  const detail = useResource<ItpDetail>(
    (signal) =>
      api.get<ItpDetail>(`/api/v1/projects/${projectId}/itps/${itpId}`, { signal }),
    [projectId, itpId, nonce],
    itpId !== null,
  );

  function refresh() {
    setNonce((n) => n + 1);
    onMutated();
  }

  return (
    <Drawer
      open={itpId !== null}
      onClose={onClose}
      size="xl"
      title={detail.data ? `${detail.data.reference} · ${detail.data.title}` : "Inspection and test plan"}
      description={
        detail.data
          ? `Revision ${detail.data.revision} · ${detail.data.activityCount} ${plural(detail.data.activityCount, "activity", "activities")}, ${detail.data.holdPointCount} hold ${plural(detail.data.holdPointCount, "point")}`
          : undefined
      }
      resizable
      resizeStorageKey="quality.itp.drawer"
    >
      {itpId === null ? null : detail.error ? (
        <div className="p-4">
          <LoadError message={detail.error} onRetry={detail.reload} title="This plan could not be loaded" />
        </div>
      ) : detail.loading && !detail.data ? (
        <div className="space-y-3 p-4">
          <Skeleton height={120} />
          <Skeleton height={220} />
          <Skeleton height={220} />
        </div>
      ) : detail.data ? (
        <ItpBody
          itp={detail.data}
          projectId={projectId}
          users={users}
          onMutated={refresh}
        />
      ) : null}
    </Drawer>
  );
}

/* ================================================================== */

function ItpBody({
  itp,
  projectId,
  users,
  onMutated,
}: {
  itp: ItpDetail;
  projectId: string;
  users: Map<string, string>;
  onMutated: () => void;
}) {
  const { busy, refusal, clear, run } = useAction();
  const [approveOpen, setApproveOpen] = useState(false);
  const [authority, setAuthority] = useState("");
  const [decision, setDecision] = useState<"approved" | "approved_as_noted" | "rejected">("approved");
  const [comments, setComments] = useState("");
  const [addOpen, setAddOpen] = useState(false);

  const base = `/api/v1/projects/${projectId}/itps/${itp.id}`;
  const held = itp.activities.filter((a) => !a.mayProceed.allowed);
  const overdue = itp.activities.filter(isOverdueHoldPoint);
  const firstHeld = held[0];

  async function lifecycle(action: "submit" | "activate" | "close") {
    const done = await run(action, () => api.post(`${base}/${action}`, {}));
    if (done) onMutated();
  }

  async function approve() {
    const done = await run("approve", () =>
      api.post(`${base}/approve`, {
        decision,
        approvalAuthority: authority.trim(),
        comments: comments.trim() === "" ? null : comments.trim(),
      }),
    );
    if (done) {
      setApproveOpen(false);
      setAuthority("");
      setComments("");
      onMutated();
    }
  }

  return (
    <div className="space-y-5 p-4">
      <RefusalNotice refusal={refusal} onDismiss={clear} />

      {/* -------- where the work is stopped, first -------- */}
      {overdue.length > 0 ? (
        <Alert
          tone="danger"
          title={`${overdue.length} hold ${plural(overdue.length, "point")} on this plan ${plural(overdue.length, "is", "are")} unreleased past ${plural(overdue.length, "its", "their")} planned date`}
        >
          {overdue.map((a) => (
            <p key={a.id} className="mt-0.5">
              <span className="font-mono text-2xs">{a.activityCode ?? a.id.slice(-6)}</span>{" "}
              {a.activity} — planned {isoDate(a.plannedDate)}, still {labelize(a.status).toLowerCase()}.
            </p>
          ))}
        </Alert>
      ) : firstHeld ? (
        <Alert tone="warning" title="The sequence is currently stopped">
          <p>
            <strong>{firstHeld.activity}</strong> — {firstHeld.mayProceed.reasons.join(" ")}
          </p>
        </Alert>
      ) : itp.activities.length > 0 ? (
        <Alert tone="success" title="No point on this plan is currently holding the work" variant="subtle">
          Every intervention point is released, waived, closed or not applicable — or is a
          surveillance point, which records rather than gates.
        </Alert>
      ) : null}

      {/* -------- the plan -------- */}
      <section className="space-y-2.5">
        <SectionTitle
          title="The plan"
          hint="Agreed before the work starts. It is revised, never edited, once it is issued."
          actions={
            <Badge tone={ITP_STATUS_TONE[itp.status] ?? "neutral"} size="sm" dot>
              {labelize(itp.status)}
            </Badge>
          }
        />
        <Facts
          columns={3}
          items={[
            { label: "Reference", value: <span className="font-mono">{itp.reference}</span> },
            { label: "Revision", value: String(itp.revision) },
            { label: "Discipline", value: itp.discipline ? labelize(itp.discipline) : "not stated" },
            itp.workPackage ? { label: "Work package", value: itp.workPackage } : null,
            itp.specSectionCode ? { label: "Specification", value: itp.specSectionCode } : null,
            { label: "Author", value: nameOf(users, itp.createdBy) },
            {
              label: "Submitted",
              value: itp.submittedAt ? dateTime(itp.submittedAt) : "not submitted",
              hint: itp.submittedBy ? `by ${nameOf(users, itp.submittedBy)}` : undefined,
            },
            {
              label: "Approval",
              value: itp.approvedAt ? dateTime(itp.approvedAt) : "not approved",
              hint: itp.approvalAuthority
                ? `${itp.approvalAuthority}${itp.approvedBy ? ` · ${nameOf(users, itp.approvedBy)}` : ""}`
                : undefined,
            },
            {
              label: "Effective from",
              value: itp.effectiveFrom ? isoDate(itp.effectiveFrom) : "not set",
            },
          ]}
        />
        {itp.scopeOfWork ? (
          <p className="whitespace-pre-wrap text-meta text-content-muted">{itp.scopeOfWork}</p>
        ) : null}
        {itp.standardsReferences.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {itp.standardsReferences.map((s) => (
              <Badge key={s} tone="neutral" size="xs" variant="outline">
                {s}
              </Badge>
            ))}
          </div>
        ) : null}
        {itp.approvalComments ? (
          <Alert tone="info" size="sm" title="Approval comments" variant="subtle">
            <p className="whitespace-pre-wrap">{itp.approvalComments}</p>
          </Alert>
        ) : null}

        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Button
            size="sm"
            variant="secondary"
            disabled={itp.status !== "draft" && itp.status !== "rejected"}
            loading={busy === "submit"}
            onClick={() => lifecycle("submit")}
          >
            Submit for approval
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={itp.status !== "submitted"}
            onClick={() => setApproveOpen(true)}
          >
            Record an approval
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={itp.status !== "approved" && itp.status !== "approved_as_noted"}
            loading={busy === "activate"}
            onClick={() => lifecycle("activate")}
          >
            Make active
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={itp.status === "closed" || itp.status === "superseded"}
            loading={busy === "close"}
            onClick={() => lifecycle("close")}
          >
            Close the plan
          </Button>
        </div>
        <p className="text-2xs text-content-subtle">
          The approval is not the author&apos;s to give. The API refuses an approval by the person
          who wrote the plan and by the person who submitted it — a plan the contractor approved for
          itself agrees nothing with anybody.
        </p>
      </section>

      {/* -------- the sequence strip -------- */}
      {itp.activities.length > 0 ? (
        <section className="space-y-2">
          <SectionTitle
            title="The sequence"
            hint="In order. A hold point stops everything after it until it is released or waived."
          />
          <SequenceStrip activities={itp.activities} />
        </section>
      ) : null}

      {/* -------- the activities -------- */}
      <section className="space-y-3">
        <SectionTitle
          title={`Activities (${itp.activities.length})`}
          hint={`${itp.holdPoints.holdPointCount} hold ${plural(itp.holdPoints.holdPointCount, "point")}, ${itp.holdPoints.witnessPointCount} witness ${plural(itp.holdPoints.witnessPointCount, "point")}, ${itp.holdPoints.blockingActivityIds.length} currently holding the work.`}
          actions={
            <Button size="sm" variant="secondary" icon={IconPlus} onClick={() => setAddOpen(true)}>
              Add activity
            </Button>
          }
        />
        {itp.activities.length === 0 ? (
          <NothingHere
            title="This plan verifies nothing yet"
            reason="An ITP with no activities has no intervention points, so there is nothing for anybody to hold, witness or release. The API will refuse to submit it for approval until at least one activity exists."
            action={
              <Button size="sm" icon={IconPlus} onClick={() => setAddOpen(true)}>
                Add the first activity
              </Button>
            }
          />
        ) : (
          <div className="space-y-3">
            {itp.activities.map((a) => (
              <ActivityCard
                key={a.id}
                activity={a}
                users={users}
                projectId={projectId}
                onMutated={onMutated}
              />
            ))}
          </div>
        )}
      </section>

      {/* -------- approval dialog -------- */}
      <Modal
        open={approveOpen}
        onClose={() => setApproveOpen(false)}
        title={`Record an approval decision on ${itp.reference}`}
        description="The approving authority is the engineer or the client. Naming it is the point — an approval attributed to nobody in particular agrees nothing."
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setApproveOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={busy === "approve"}
              disabled={authority.trim().length === 0}
              onClick={approve}
            >
              Record the decision
            </Button>
          </div>
        }
      >
        <div className="space-y-3">
          <Field label="Decision" required>
            <Select
              value={decision}
              onChange={(e) =>
                setDecision(e.target.value as "approved" | "approved_as_noted" | "rejected")
              }
            >
              <option value="approved">Approved</option>
              <option value="approved_as_noted">Approved as noted</option>
              <option value="rejected">Rejected</option>
            </Select>
          </Field>
          <Field label="Approval authority" required hint="The organisation or role giving it.">
            <Input
              value={authority}
              onChange={(e) => setAuthority(e.target.value)}
              placeholder="e.g. Engineer — Arup"
            />
          </Field>
          <Field label="Comments">
            <Textarea rows={3} value={comments} onChange={(e) => setComments(e.target.value)} />
          </Field>
        </div>
      </Modal>

      <AddActivityModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        base={base}
        onCreated={onMutated}
        users={users}
      />
    </div>
  );
}

/* ================================================================== */
/* The sequence strip                                                  */
/* ================================================================== */

/**
 * The plan as a chain. Each segment is one activity in position order,
 * coloured by its intervention point and struck through with a bar where the
 * work is currently held. Nothing further along the chain than the first
 * blocking hold point can legitimately have happened.
 */
function SequenceStrip({ activities }: { activities: readonly ItpActivity[] }) {
  const firstBlockIndex = useMemo(
    () => activities.findIndex((a) => a.interventionPoint === "hold_point" && !a.mayProceed.allowed),
    [activities],
  );
  return (
    <div className="space-y-2">
      <ol className="flex flex-wrap items-stretch gap-1">
        {activities.map((a, index) => {
          const blocked = !a.mayProceed.allowed;
          const overdue = isOverdueHoldPoint(a);
          const tone: Tone = overdue
            ? "danger"
            : blocked
              ? a.interventionPoint === "hold_point"
                ? "danger"
                : "warning"
              : a.status === "waived"
                ? "highlight"
                : a.status === "released"
                  ? "success"
                  : (INTERVENTION_TONE[a.interventionPoint] ?? "neutral");
          const beyond = firstBlockIndex >= 0 && index > firstBlockIndex;
          return (
            <li
              key={a.id}
              className={cx(
                "flex min-w-[7rem] max-w-[13rem] flex-1 flex-col gap-0.5 rounded-md border px-2 py-1.5",
                toneClass(tone, "subtle"),
                toneClass(tone, "border"),
                overdue ? "ring-2 ring-offset-1 ring-offset-surface " + toneClass(tone, "ring") : "",
                beyond ? "opacity-60" : "",
              )}
              title={`${INTERVENTION_LABEL[a.interventionPoint] ?? a.interventionPoint} · ${labelize(a.status)}`}
            >
              <span className="truncate text-2xs font-semibold">
                {a.activityCode ? `${a.activityCode} · ` : ""}
                {a.activity}
              </span>
              <span className="text-2xs opacity-90">
                {INTERVENTION_LABEL[a.interventionPoint] ?? labelize(a.interventionPoint)}
              </span>
              <span className="text-2xs opacity-80">{labelize(a.status)}</span>
            </li>
          );
        })}
      </ol>
      {firstBlockIndex >= 0 ? (
        <p className="text-2xs text-content-subtle">
          Everything after position {firstBlockIndex + 1} is dimmed: the hold point at that position
          has not been released, so nothing beyond it should have proceeded.
        </p>
      ) : null}
    </div>
  );
}

/* ================================================================== */
/* Add activity                                                        */
/* ================================================================== */

function AddActivityModal({
  open,
  onClose,
  base,
  onCreated,
  users,
}: {
  open: boolean;
  onClose: () => void;
  base: string;
  onCreated: () => void;
  users: Map<string, string>;
}) {
  const { busy, refusal, clear, run } = useAction();
  const [activity, setActivity] = useState("");
  const [activityCode, setActivityCode] = useState("");
  const [interventionPoint, setInterventionPoint] = useState<string>("hold_point");
  const [responsibleParty, setResponsibleParty] = useState<string>("contractor");
  const [noticeHours, setNoticeHours] = useState("");
  const [plannedDate, setPlannedDate] = useState("");
  const [criteria, setCriteria] = useState("");
  /*
   * The party is a TOKEN, not free text. The API validates it against
   * ITP_RESPONSIBLE_PARTIES, so a typed "Engineer" — or "eng", or anything a
   * human would write — came back as a 400 the form could not explain, and a
   * hold point could not be created from this screen at all without guessing
   * the vocabulary. It is a select over the same list the API accepts.
   */
  const [party, setParty] = useState<string>("engineer");
  const [partyName, setPartyName] = useState("");
  /** the strongest nomination: a platform user, who alone may then release */
  const [partyUserId, setPartyUserId] = useState("");

  async function create() {
    const parsedHours = noticeHours.trim() === "" ? null : Number(noticeHours);
    // The API takes an integer; a decimal typed here used to fail validation.
    const hours =
      parsedHours !== null && Number.isFinite(parsedHours) ? Math.round(parsedHours) : null;
    const created = await run("add", () =>
      api.post(`${base}/activities`, {
        activity: activity.trim(),
        activityCode: activityCode.trim() === "" ? null : activityCode.trim(),
        interventionPoint,
        responsibleParty,
        noticePeriodHours: hours,
        plannedDate: plannedDate === "" ? null : plannedDate,
        acceptanceCriteria: criteria.trim() === "" ? null : criteria.trim(),
        verifyingParties: releasable
          ? [
              {
                party,
                interventionPoint,
                name: partyName.trim() === "" ? null : partyName.trim(),
                userId: partyUserId === "" ? null : partyUserId,
              },
            ]
          : [],
      }),
    );
    if (created) {
      setActivity("");
      setActivityCode("");
      setCriteria("");
      setParty("engineer");
      setPartyName("");
      setPartyUserId("");
      onClose();
      onCreated();
    }
  }

  const releasable = interventionPoint !== "surveillance_point";

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add an activity to the plan"
      description="The intervention point is the decision that matters — it says who gets to stop the work, and whether they can stop it at all."
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={busy === "add"}
            disabled={activity.trim().length === 0}
            onClick={create}
          >
            Add the activity
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <RefusalNotice refusal={refusal} onDismiss={clear} />
        <div className="grid gap-3 sm:grid-cols-[1fr_8rem]">
          <Field label="Activity" required>
            <Input
              value={activity}
              onChange={(e) => setActivity(e.target.value)}
              placeholder="e.g. Pre-pour reinforcement inspection"
              autoFocus
            />
          </Field>
          <Field label="Code">
            <Input value={activityCode} onChange={(e) => setActivityCode(e.target.value)} />
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Intervention point" required>
            <Select
              value={interventionPoint}
              onChange={(e) => setInterventionPoint(e.target.value)}
            >
              {INTERVENTION_POINTS.map((p) => (
                <option key={p} value={p}>
                  {INTERVENTION_LABEL[p] ?? labelize(p)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Responsible party">
            <Select
              value={responsibleParty}
              onChange={(e) => setResponsibleParty(e.target.value)}
            >
              {RESPONSIBLE_PARTIES.map((p) => (
                <option key={p} value={p}>
                  {labelize(p)}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label="Notice period (hours)"
            hint="Leave blank if the contract sets none — the platform will then say the notice period cannot be computed rather than assuming zero."
          >
            <Input
              type="number"
              min={0}
              value={noticeHours}
              onChange={(e) => setNoticeHours(e.target.value)}
              disabled={!releasable}
            />
          </Field>
          <Field label="Planned date">
            <Input
              type="date"
              value={plannedDate}
              onChange={(e) => setPlannedDate(e.target.value)}
            />
          </Field>
        </div>
        <Field label="Acceptance criteria">
          <Textarea rows={2} value={criteria} onChange={(e) => setCriteria(e.target.value)} />
        </Field>
        {releasable ? (
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field
                label="Verifying party"
                required
                hint="Who holds this point. A hold point with none is refused: a point held by nobody in particular cannot be released by anybody in particular."
              >
                <Select value={party} onChange={(e) => setParty(e.target.value)}>
                  {RESPONSIBLE_PARTIES.map((p) => (
                    <option key={p} value={p}>
                      {labelize(p)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field
                label="Nominated user"
                hint="The strongest form of nomination: only this user may release the point. Leave blank when the verifier is an organisation with no account here."
              >
                <Select value={partyUserId} onChange={(e) => setPartyUserId(e.target.value)}>
                  <option value="">— organisation only —</option>
                  {[...users.entries()].map(([id, name]) => (
                    <option key={id} value={id}>
                      {name}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <Field label="Named individual">
              <Input
                value={partyName}
                onChange={(e) => setPartyName(e.target.value)}
                placeholder="e.g. A. Engineer, Notified Body Ltd"
              />
            </Field>
          </div>
        ) : (
          <p className="text-2xs text-content-subtle">
            A surveillance point is continuous monitoring: nobody is summoned to it, so it takes no
            notice period and carries no release.
          </p>
        )}
      </div>
    </Modal>
  );
}
