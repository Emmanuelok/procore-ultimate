/**
 * ONE CORRECTIVE ACTION, and its four separate acts.
 *
 *   Complete    the owner says the work is done, with evidence.
 *   Verify      somebody else agrees it was done. Never the completer.
 *   Effectiveness  a LATER judgement that the fix actually worked. This is
 *                  the one that is usually skipped, so it is given its own
 *                  panel rather than a checkbox.
 *   Close       only once the effectiveness verdict supports it.
 *
 * They are laid out in that order and the preconditions are printed, not
 * hidden behind a disabled button.
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
  cx,
  type DescriptionItem,
} from "../../ui";
import { IconWorkflow } from "../../ui/icons";
import { api } from "../../lib/api";
import {
  ACTION_STATUS_TONE,
  EFFECTIVENESS_TONE,
  EM_DASH,
  HIERARCHY_HINT,
  HIERARCHY_LABEL,
  HierarchyBadge,
  LoadError,
  ReasonList,
  RefusalNotice,
  SOURCE_LABEL,
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
  type CorrectiveAction,
} from "./safetyShared";

const VERDICTS = ["effective", "partially_effective", "not_effective"];

export default function ActionDrawer({
  projectId,
  actionId,
  users,
  vendors,
  onClose,
  onMutated,
}: {
  projectId: string;
  actionId: string | null;
  users: Map<string, string>;
  vendors: Map<string, string>;
  onClose: () => void;
  onMutated: () => void;
}) {
  const [version, setVersion] = useState(0);
  const detail = useResource<CorrectiveAction>(
    (signal) =>
      api.get<CorrectiveAction>(
        `/api/v1/projects/${projectId}/safety/corrective-actions/${actionId}`,
        { signal },
      ),
    [projectId, actionId, version],
    actionId !== null && projectId !== "",
  );

  const mutation = useMutation(() => {
    setVersion((n) => n + 1);
    onMutated();
  });

  const [completionNote, setCompletionNote] = useState("");
  const [verificationMethod, setVerificationMethod] = useState("");
  const [verdict, setVerdict] = useState("effective");
  const [effectivenessNote, setEffectivenessNote] = useState("");
  const [checkDate, setCheckDate] = useState(today());
  const [cancelReason, setCancelReason] = useState("");

  const action = detail.data;

  const facts: DescriptionItem[] = action
    ? [
        { label: "Raised from", value: `${SOURCE_LABEL[action.sourceType] ?? action.sourceType}${action.sourceReference ? ` · ${action.sourceReference}` : ""}` },
        { label: "Kind", value: labelize(action.actionKind) },
        {
          label: "Level of control",
          value: <HierarchyBadge value={action.hierarchyOfControl} size="sm" />,
          hint: action.hierarchyOfControl ? HIERARCHY_HINT[action.hierarchyOfControl] : undefined,
          span: 2,
        },
        { label: "Category", value: action.category ? labelize(action.category) : EM_DASH },
        { label: "Priority", value: labelize(action.priority) },
        {
          label: "Owner",
          value:
            action.ownerName ??
            (action.ownerId ? nameOf(users, action.ownerId) : null) ??
            (action.ownerVendorId ? nameOf(vendors, action.ownerVendorId) : null) ??
            EM_DASH,
        },
        {
          label: "Due",
          value: (
            <span className={cx(action.isOverdue && "text-danger-fg")}>
              {isoDate(action.dueDate)}
              {action.isOverdue ? ` · ${count(action.daysOverdue)} days overdue` : ""}
            </span>
          ),
          hint:
            action.revisedCount > 0
              ? `Revised ${action.revisedCount} time(s) from an original due date of ${isoDate(action.originalDueDate)}.`
              : undefined,
        },
        {
          label: "Cost to implement",
          value:
            action.costToImplement === null
              ? EM_DASH
              : money(action.costToImplement, action.currency ?? "USD"),
          hint: action.currency ? `Stated in ${action.currency}; never combined with another currency.` : undefined,
        },
        { label: "Completed", value: action.completedAt ? `${dateTime(action.completedAt)} by ${nameOf(users, action.completedBy)}` : EM_DASH, span: 2 },
        { label: "Verified", value: action.verifiedAt ? `${dateTime(action.verifiedAt)} by ${nameOf(users, action.verifiedBy)}` : "Not verified", span: 2 },
      ]
    : [];

  return (
    <Drawer
      open={actionId !== null}
      onClose={onClose}
      size="lg"
      icon={IconWorkflow}
      title={action ? `${action.reference} · ${action.title}` : "Corrective action"}
      description={action?.description ?? undefined}
      headerActions={
        action ? (
          <Badge tone={ACTION_STATUS_TONE[action.status] ?? "neutral"} size="sm" dot>
            {labelize(action.status)}
          </Badge>
        ) : null
      }
    >
      {detail.error ? (
        <LoadError message={detail.error} onRetry={detail.reload} title="This action could not be loaded" />
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

      {detail.loading && !action ? (
        <Skeleton height={280} />
      ) : action ? (
        <div className="space-y-4">
          {action.isWeakControl ? (
            <Alert tone="warning" title="This sits at the weak end of the hierarchy of control">
              {HIERARCHY_HINT[action.hierarchyOfControl ?? "administrative"]} Recording it is not a
              criticism — sometimes it is all that is available — but a register full of these will
              see the same incident again.
            </Alert>
          ) : null}

          <DescriptionList items={facts} columns={2} dividers />

          {action.completionNote ? (
            <Card variant="sunken">
              <CardBody>
                <p className="text-label uppercase text-content-subtle">Completion note</p>
                <p className="mt-1 whitespace-pre-wrap text-body text-content">
                  {action.completionNote}
                </p>
              </CardBody>
            </Card>
          ) : null}

          {/* ------------------------------------------------------------ */}
          <section>
            <SectionHeading
              title="1 · Completion"
              hint="The owner asserting the work is done. It moves the action, it does not close it."
            />
            {action.completedAt ? (
              <Alert tone="success" title={`Completed ${dateTime(action.completedAt)}`}>
                Recorded by {nameOf(users, action.completedBy)}.
              </Alert>
            ) : (
              <Card>
                <CardBody className="space-y-3">
                  <Field label="What was done?">
                    <Textarea
                      rows={3}
                      value={completionNote}
                      onChange={(e) => setCompletionNote(e.target.value)}
                    />
                  </Field>
                  <Button
                    size="sm"
                    disabled={completionNote.trim() === ""}
                    loading={mutation.busy === "complete"}
                    onClick={() =>
                      void mutation.run("complete", "This action could not be completed", () =>
                        api.post(
                          `/api/v1/projects/${projectId}/safety/corrective-actions/${action.id}/complete`,
                          { completionNote: completionNote.trim() },
                        ),
                      )
                    }
                  >
                    Mark complete
                  </Button>
                </CardBody>
              </Card>
            )}
          </section>

          {/* ------------------------------------------------------------ */}
          <section>
            <SectionHeading
              title="2 · Verification"
              hint="Somebody other than the person who completed it agreeing that it was done. The platform refuses a self-verification."
            />
            {action.verifiedAt ? (
              <Alert tone="success" title={`Verified ${dateTime(action.verifiedAt)}`}>
                By {nameOf(users, action.verifiedBy)} · {action.verificationMethod ?? "no method recorded"}
              </Alert>
            ) : (
              <Card>
                <CardBody className="space-y-3">
                  <Field
                    label="How was it verified?"
                    hint="Site inspection, photograph, a witnessed test — what the verifier actually did."
                  >
                    <Input
                      value={verificationMethod}
                      onChange={(e) => setVerificationMethod(e.target.value)}
                    />
                  </Field>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={verificationMethod.trim() === "" || !action.completedAt}
                    loading={mutation.busy === "verify"}
                    onClick={() =>
                      void mutation.run("verify", "This action could not be verified", () =>
                        api.post(
                          `/api/v1/projects/${projectId}/safety/corrective-actions/${action.id}/verify`,
                          { verificationMethod: verificationMethod.trim() },
                        ),
                      )
                    }
                  >
                    Verify completion
                  </Button>
                  {!action.completedAt ? (
                    <ReasonList
                      reasons={[
                        "There is nothing to verify yet — the action has not been recorded as complete.",
                      ]}
                    />
                  ) : null}
                </CardBody>
              </Card>
            )}
          </section>

          {/* ------------------------------------------------------------ */}
          <section>
            <SectionHeading
              title="3 · Did it actually work?"
              hint="The judgement that is usually skipped. Made later than closure, by a different person, against the thing the action was supposed to prevent."
              actions={
                <Badge
                  tone={EFFECTIVENESS_TONE[action.effectivenessVerdict] ?? "neutral"}
                  size="sm"
                  dot
                >
                  {labelize(action.effectivenessVerdict)}
                </Badge>
              }
            />
            {action.effectivenessVerdict !== "pending" ? (
              <Alert
                tone={action.effectivenessVerdict === "not_effective" ? "danger" : "success"}
                title={`Judged ${labelize(action.effectivenessVerdict)} on ${isoDate(action.effectivenessCheckDate)}`}
              >
                <p>{action.effectivenessNote ?? "No note recorded."}</p>
                <p className="mt-1 text-2xs text-content-muted">
                  Checked by {nameOf(users, action.effectivenessCheckedBy)}
                </p>
              </Alert>
            ) : (
              <Card>
                <CardBody className="space-y-3">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="Verdict">
                      <Select value={verdict} onChange={(e) => setVerdict(e.target.value)}>
                        {VERDICTS.map((v) => (
                          <option key={v} value={v}>
                            {labelize(v)}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field label="Check date">
                      <Input
                        type="date"
                        value={checkDate}
                        onChange={(e) => setCheckDate(e.target.value)}
                      />
                    </Field>
                  </div>
                  <Field label="On what evidence?">
                    <Textarea
                      rows={3}
                      value={effectivenessNote}
                      onChange={(e) => setEffectivenessNote(e.target.value)}
                    />
                  </Field>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={effectivenessNote.trim() === ""}
                    loading={mutation.busy === "effectiveness"}
                    onClick={() =>
                      void mutation.run(
                        "effectiveness",
                        "This effectiveness check could not be recorded",
                        () =>
                          api.post(
                            `/api/v1/projects/${projectId}/safety/corrective-actions/${action.id}/effectiveness-check`,
                            {
                              verdict,
                              checkDate,
                              note: effectivenessNote.trim(),
                            },
                          ),
                      )
                    }
                  >
                    Record the effectiveness check
                  </Button>
                </CardBody>
              </Card>
            )}
          </section>

          {/* ------------------------------------------------------------ */}
          <section>
            <SectionHeading title="4 · Closure" />
            {action.status === "closed" ? (
              <Alert tone="neutral" title={`Closed ${dateTime(action.closedAt)}`}>
                By {nameOf(users, action.closedBy)}.
              </Alert>
            ) : action.status === "cancelled" ? (
              <Alert tone="neutral" title="Cancelled">
                This action was withdrawn rather than completed.
              </Alert>
            ) : (
              <Card>
                <CardBody className="space-y-3">
                  {!action.canClose ? (
                    <ReasonList
                      reasons={[
                        "This action cannot be closed while its effectiveness verdict is pending or negative. Closing on completion alone records that something was done, not that it worked.",
                      ]}
                    />
                  ) : null}
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      size="sm"
                      disabled={!action.canClose}
                      loading={mutation.busy === "close"}
                      onClick={() =>
                        void mutation.run("close", "This action could not be closed", () =>
                          api.post(
                            `/api/v1/projects/${projectId}/safety/corrective-actions/${action.id}/close`,
                            {},
                          ),
                        )
                      }
                    >
                      Close the action
                    </Button>
                  </div>
                  <Field label="Or cancel it, with a reason">
                    <Input
                      value={cancelReason}
                      placeholder="Why is this action being withdrawn?"
                      onChange={(e) => setCancelReason(e.target.value)}
                    />
                  </Field>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={cancelReason.trim() === ""}
                    loading={mutation.busy === "cancel"}
                    onClick={() =>
                      void mutation.run("cancel", "This action could not be cancelled", () =>
                        api.post(
                          `/api/v1/projects/${projectId}/safety/corrective-actions/${action.id}/cancel`,
                          { reason: cancelReason.trim() },
                        ),
                      )
                    }
                  >
                    Cancel the action
                  </Button>
                </CardBody>
              </Card>
            )}
          </section>

          <p className="text-2xs text-content-subtle">
            {HIERARCHY_LABEL[action.hierarchyOfControl ?? "administrative"]} was chosen for this
            action. The register records that choice permanently so a programme can be judged on
            what it engineers out, not on how many actions it opened.
          </p>
        </div>
      ) : null}
    </Drawer>
  );
}
