/**
 * ONE OBSERVATION.
 *
 * The three things this screen is for:
 *
 *  · The risk score, with the matrix band's own guidance beneath it — and no
 *    score at all where an axis was left blank.
 *  · The work stoppage. "Work was stopped" with no account of what was put in
 *    place, and no record of when the site went back to work, is worse than no
 *    record; lifting it is a distinct act requiring the controls to be named.
 *  · Closure — by someone other than the observer, and blocked while a
 *    stoppage is unresolved unless a reason is given.
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
import { IconEye } from "../../ui/icons";
import { api } from "../../lib/api";
import ActionList from "./ActionList";
import {
  EM_DASH,
  HIERARCHY_LABEL,
  HIERARCHY_ORDER,
  LoadError,
  OBSERVATION_STATUS_TONE,
  ReasonList,
  RefusalNotice,
  RiskBadge,
  SAFETY_SEVERITY_TONE,
  SectionHeading,
  count,
  dateTime,
  isoDate,
  labelize,
  nameOf,
  today,
  useMutation,
  useResource,
  type ObservationDetail,
} from "./safetyShared";

export default function ObservationDrawer({
  projectId,
  observationId,
  users,
  vendors,
  onClose,
  onMutated,
}: {
  projectId: string;
  observationId: string | null;
  users: Map<string, string>;
  vendors: Map<string, string>;
  onClose: () => void;
  onMutated: () => void;
}) {
  const [version, setVersion] = useState(0);
  const detail = useResource<ObservationDetail>(
    (signal) =>
      api.get<ObservationDetail>(
        `/api/v1/projects/${projectId}/safety/observations/${observationId}`,
        { signal },
      ),
    [projectId, observationId, version],
    observationId !== null && projectId !== "",
  );
  const mutation = useMutation(() => {
    setVersion((n) => n + 1);
    onMutated();
  });

  const [assigneeId, setAssigneeId] = useState("");
  const [dueDate, setDueDate] = useState(today());
  const [controls, setControls] = useState("");
  const [closeNote, setCloseNote] = useState("");
  const [stoppageReason, setStoppageReason] = useState("");
  const [actionTitle, setActionTitle] = useState("");
  const [actionHierarchy, setActionHierarchy] = useState("engineering");
  const [actionOwner, setActionOwner] = useState("");
  const [actionDue, setActionDue] = useState(today());

  const o = detail.data;

  const facts: DescriptionItem[] = o
    ? [
        { label: "Kind", value: labelize(o.kind) },
        { label: "Category", value: labelize(o.category) },
        {
          label: "Potential severity",
          value: (
            <Badge tone={SAFETY_SEVERITY_TONE[o.severity] ?? "neutral"} size="xs">
              {labelize(o.severity)}
            </Badge>
          ),
          hint: "How bad the outcome COULD have been — the only useful ranking for something that has not yet hurt anyone.",
        },
        {
          label: "Risk score",
          value: <RiskBadge risk={o.risk} reasons={o.riskReasons} size="sm" />,
          hint: o.risk
            ? `${o.risk.label}. ${o.risk.guidance}`
            : "Both axes must be scored for a 5×5 score to exist.",
          span: 2,
        },
        { label: "Observed", value: dateTime(o.observedAt) },
        { label: "Location", value: o.locationText ?? EM_DASH },
        { label: "Party observed", value: o.vendorId ? nameOf(vendors, o.vendorId) : EM_DASH },
        { label: "Trade", value: o.trade ?? EM_DASH },
        { label: "Raised by", value: nameOf(users, o.createdBy) },
        {
          label: "Assigned to",
          value: o.assigneeId ? nameOf(users, o.assigneeId) : "Nobody yet",
        },
        {
          label: "Due",
          value: o.dueDate
            ? `${isoDate(o.dueDate)}${o.isOverdue ? ` · ${count(o.daysOverdue)} days overdue` : ""}`
            : "No date set",
        },
        { label: "Immediate action taken", value: o.immediateActionTaken ?? EM_DASH, span: 2 },
      ]
    : [];

  return (
    <Drawer
      open={observationId !== null}
      onClose={onClose}
      size="lg"
      icon={IconEye}
      tone={o?.workStoppedAndNotResumed ? "danger" : undefined}
      title={o ? `${o.reference} · ${o.title}` : "Observation"}
      headerActions={
        o ? (
          <Badge tone={OBSERVATION_STATUS_TONE[o.status] ?? "neutral"} size="sm" dot>
            {labelize(o.status)}
          </Badge>
        ) : null
      }
    >
      {detail.error ? (
        <LoadError
          message={detail.error}
          onRetry={detail.reload}
          title="This observation could not be loaded"
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

      {detail.loading && !o ? (
        <Skeleton height={280} />
      ) : o ? (
        <div className="space-y-4">
          {o.workStoppedAndNotResumed ? (
            <Alert tone="danger" title="Work was stopped and has not been recorded as resumed">
              The stoppage is the first fact an enforcement officer asks about. Lifting it below
              requires naming the controls that are now in place — a site recorded as still stopped
              while it is actually working is a worse record than none.
            </Alert>
          ) : null}

          {o.description ? (
            <Card variant="sunken">
              <CardBody>
                <p className="whitespace-pre-wrap text-body text-content">{o.description}</p>
              </CardBody>
            </Card>
          ) : null}

          <DescriptionList items={facts} columns={2} dividers />

          {/* ------------------------------------------------------------ */}
          {o.status !== "closed" && o.status !== "void" ? (
            <section>
              <SectionHeading
                title="Assign an owner"
                hint="An observation with no name and no date is a note, not a control."
              />
              <Card>
                <CardBody className="grid gap-3 sm:grid-cols-3">
                  <Field label="Assignee">
                    <Input
                      value={assigneeId}
                      placeholder="user id"
                      onChange={(e) => setAssigneeId(e.target.value)}
                    />
                  </Field>
                  <Field label="Due date">
                    <Input
                      type="date"
                      value={dueDate}
                      onChange={(e) => setDueDate(e.target.value)}
                    />
                  </Field>
                  <div className="flex items-end">
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={assigneeId.trim() === ""}
                      loading={mutation.busy === "assign"}
                      onClick={() =>
                        void mutation.run("assign", "This observation could not be assigned", () =>
                          api.post(
                            `/api/v1/projects/${projectId}/safety/observations/${o.id}/assign`,
                            { assigneeId: assigneeId.trim(), dueDate },
                          ),
                        )
                      }
                    >
                      Assign
                    </Button>
                  </div>
                </CardBody>
              </Card>
            </section>
          ) : null}

          {/* ------------------------------------------------------------ */}
          {o.workStopped ? (
            <section>
              <SectionHeading
                title="Work stoppage"
                hint={
                  o.workResumedAt
                    ? `Work resumed ${dateTime(o.workResumedAt)}.`
                    : "Still recorded as stopped."
                }
              />
              {o.workResumedAt ? (
                <Alert tone="success" title="Resumed">
                  {dateTime(o.workResumedAt)}
                </Alert>
              ) : (
                <Card>
                  <CardBody className="space-y-3">
                    <Field
                      label="What controls are now in place?"
                      hint="This is the record that the site went back to work on something other than optimism."
                    >
                      <Textarea
                        rows={3}
                        value={controls}
                        onChange={(e) => setControls(e.target.value)}
                      />
                    </Field>
                    <Button
                      size="sm"
                      disabled={controls.trim() === ""}
                      loading={mutation.busy === "resume"}
                      onClick={() =>
                        void mutation.run(
                          "resume",
                          "Work could not be recorded as resumed",
                          () =>
                            api.post(
                              `/api/v1/projects/${projectId}/safety/observations/${o.id}/resume-work`,
                              { controlsInPlace: controls.trim() },
                            ),
                        )
                      }
                    >
                      Record that work resumed
                    </Button>
                  </CardBody>
                </Card>
              )}
            </section>
          ) : null}

          {/* ------------------------------------------------------------ */}
          <section>
            <SectionHeading
              title={`Corrective actions · ${count(o.actions.length)}`}
              actions={null}
            />
            <Card className="mb-2">
              <CardBody className="grid gap-3 sm:grid-cols-2">
                <Field label="Raise an action" className="sm:col-span-2">
                  <Input
                    value={actionTitle}
                    placeholder="What has to change?"
                    onChange={(e) => setActionTitle(e.target.value)}
                  />
                </Field>
                <Field label="Level of control">
                  <Select
                    value={actionHierarchy}
                    onChange={(e) => setActionHierarchy(e.target.value)}
                  >
                    {HIERARCHY_ORDER.map((h, i) => (
                      <option key={h} value={h}>
                        {i + 1}. {HIERARCHY_LABEL[h]}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Owner">
                  <Input value={actionOwner} onChange={(e) => setActionOwner(e.target.value)} />
                </Field>
                <Field label="Due">
                  <Input
                    type="date"
                    value={actionDue}
                    onChange={(e) => setActionDue(e.target.value)}
                  />
                </Field>
                <div className="flex items-end">
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={actionTitle.trim() === "" || actionOwner.trim() === ""}
                    loading={mutation.busy === "raise"}
                    onClick={() =>
                      void mutation.run("raise", "This action could not be raised", async () => {
                        await api.post(
                          `/api/v1/projects/${projectId}/safety/corrective-actions`,
                          {
                            sourceType: "observation",
                            sourceId: o.id,
                            title: actionTitle.trim(),
                            hierarchyOfControl: actionHierarchy,
                            ownerName: actionOwner.trim(),
                            dueDate: actionDue,
                          },
                        );
                        setActionTitle("");
                        setActionOwner("");
                      })
                    }
                  >
                    Raise
                  </Button>
                </div>
              </CardBody>
            </Card>
            <ActionList
              actions={o.actions}
              emptyTitle="No corrective action from this observation"
              emptyHint="If the immediate action taken was enough, the record should say so. An observation closed with nothing raised and nothing explained is indistinguishable from one nobody read."
            />
          </section>

          {/* ------------------------------------------------------------ */}
          <section>
            <SectionHeading
              title="Closure"
              hint="Closure is a second act, never by the observer. What was found and what was done about it are two different people's statements."
            />
            {o.closedAt ? (
              <Alert tone="neutral" title={`Closed ${dateTime(o.closedAt)}`}>
                By {nameOf(users, o.closedBy)}.
              </Alert>
            ) : (
              <Card>
                <CardBody className="space-y-3">
                  {o.workStoppedAndNotResumed ? (
                    <ReasonList
                      reasons={[
                        "Work on this observation is recorded as stopped and has not been resumed. Closing it in that state needs an explicit reason, because the register would otherwise carry a live stoppage nobody is looking at.",
                      ]}
                    />
                  ) : null}
                  <Field label="Closing note">
                    <Textarea
                      rows={3}
                      value={closeNote}
                      onChange={(e) => setCloseNote(e.target.value)}
                    />
                  </Field>
                  {o.workStoppedAndNotResumed ? (
                    <Field label="Why is it being closed with the stoppage still open?">
                      <Input
                        value={stoppageReason}
                        onChange={(e) => setStoppageReason(e.target.value)}
                      />
                    </Field>
                  ) : null}
                  <Button
                    size="sm"
                    disabled={closeNote.trim() === ""}
                    loading={mutation.busy === "close"}
                    onClick={() =>
                      void mutation.run("close", "This observation could not be closed", () =>
                        api.post(
                          `/api/v1/projects/${projectId}/safety/observations/${o.id}/close`,
                          {
                            note: closeNote.trim(),
                            ...(stoppageReason.trim()
                              ? { workNotResumedReason: stoppageReason.trim() }
                              : {}),
                          },
                        ),
                      )
                    }
                  >
                    Close the observation
                  </Button>
                </CardBody>
              </Card>
            )}
          </section>
        </div>
      ) : null}
    </Drawer>
  );
}
