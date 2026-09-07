/**
 * ONE INSPECTION — the answers, item by item, against the template that was
 * actually in force when it was performed.
 *
 * Items marked critical are shown as critical whether they passed or failed,
 * because "92%" and "92% with the edge protection item failed" are different
 * inspections and the second one is not a pass.
 *
 * Review is a separate act by a separate person: the inspector cannot review
 * their own walk. The platform refuses it; this screen says so up front rather
 * than after the click.
 */
import { useMemo, useState } from "react";
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
  Skeleton,
  Textarea,
  cx,
  type DescriptionItem,
} from "../../ui";
import { IconInspection } from "../../ui/icons";
import { api } from "../../lib/api";
import ActionList from "./ActionList";
import InspectionAnswerForm from "./InspectionAnswerForm";
import {
  EM_DASH,
  INSPECTION_RESULT_TONE,
  INSPECTION_STATUS_TONE,
  LoadError,
  ReasonList,
  RefusalNotice,
  SectionHeading,
  count,
  dateTime,
  decimal,
  isoDate,
  labelize,
  nameOf,
  useMutation,
  useResource,
  type InspectionDetail,
  type TemplateItemSpec,
} from "./safetyShared";

export default function InspectionDrawer({
  projectId,
  inspectionId,
  users,
  vendors,
  onClose,
  onMutated,
}: {
  projectId: string;
  inspectionId: string | null;
  users: Map<string, string>;
  vendors: Map<string, string>;
  onClose: () => void;
  onMutated: () => void;
}) {
  const [version, setVersion] = useState(0);
  const [reviewNote, setReviewNote] = useState("");

  const detail = useResource<InspectionDetail>(
    (signal) =>
      api.get<InspectionDetail>(
        `/api/v1/projects/${projectId}/safety/inspections/${inspectionId}`,
        { signal },
      ),
    [projectId, inspectionId, version],
    inspectionId !== null && projectId !== "",
  );

  const mutation = useMutation(() => {
    setVersion((n) => n + 1);
    onMutated();
  });

  const inspection = detail.data;

  const itemsById = useMemo(() => {
    const map = new Map<string, TemplateItemSpec>();
    for (const item of inspection?.template?.items ?? []) map.set(item.id, item);
    return map;
  }, [inspection]);

  const facts: DescriptionItem[] = inspection
    ? [
        { label: "Type", value: labelize(inspection.inspectionType) },
        {
          label: "Form used",
          value: inspection.template
            ? `${inspection.template.name} · v${inspection.templateVersion ?? inspection.template.version}`
            : "No template — free-form",
          hint: "The version is stamped at completion so a later revision cannot rewrite what was inspected.",
          span: 2,
        },
        {
          label: "Inspector",
          value:
            inspection.inspectorName ??
            (inspection.inspectorId ? nameOf(users, inspection.inspectorId) : EM_DASH),
        },
        { label: "Party inspected", value: inspection.vendorId ? nameOf(vendors, inspection.vendorId) : EM_DASH },
        { label: "Location", value: inspection.locationText ?? EM_DASH },
        { label: "Scheduled", value: isoDate(inspection.scheduledFor) },
        { label: "Performed", value: dateTime(inspection.performedAt) },
        {
          label: "Re-inspection due",
          value: inspection.nextDueDate ? (
            <span className={cx(inspection.reInspectionOverdue && "text-danger-fg")}>
              {isoDate(inspection.nextDueDate)}
              {inspection.reInspectionOverdue
                ? ` · ${count(inspection.daysOverdue)} days overdue`
                : ""}
            </span>
          ) : (
            EM_DASH
          ),
        },
        {
          label: "Accompanied by",
          value:
            (inspection.accompaniedBy ?? []).length === 0
              ? "Walked alone"
              : inspection.accompaniedBy
                  .map((a) => [a.name, a.organisation].filter(Boolean).join(" — "))
                  .join("; "),
          span: 2,
          hint: "Who walked with the inspector. An inspection nobody from the party being inspected attended is one nobody has to accept.",
        },
        {
          label: "Reviewed",
          value: inspection.reviewedAt
            ? `${dateTime(inspection.reviewedAt)} by ${nameOf(users, inspection.reviewedBy)}`
            : "Not reviewed",
          span: 2,
        },
      ]
    : [];

  return (
    <Drawer
      open={inspectionId !== null}
      onClose={onClose}
      size="lg"
      icon={IconInspection}
      tone={inspection?.criticalDefectCount ? "danger" : undefined}
      title={inspection ? `${inspection.reference} · ${inspection.title}` : "Inspection"}
      headerActions={
        inspection ? (
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone={INSPECTION_STATUS_TONE[inspection.status] ?? "neutral"} size="sm" dot>
              {labelize(inspection.status)}
            </Badge>
            {inspection.result ? (
              <Badge tone={INSPECTION_RESULT_TONE[inspection.result] ?? "neutral"} size="sm">
                {labelize(inspection.result)}
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
          title="This inspection could not be loaded"
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

      {detail.loading && !inspection ? (
        <Skeleton height={280} />
      ) : inspection ? (
        <div className="space-y-4">
          {inspection.criticalDefectCount > 0 ? (
            <Alert
              tone="danger"
              title={`${count(inspection.criticalDefectCount)} critical item${inspection.criticalDefectCount === 1 ? "" : "s"} failed`}
            >
              A critical item failing fails the whole inspection whatever the percentage says. The
              score below is reported for completeness, not as a verdict.
            </Alert>
          ) : null}

          <div className="grid gap-3 sm:grid-cols-3">
            <Card variant="sunken">
              <CardBody>
                <p className="text-label uppercase text-content-subtle">Score</p>
                <p className="mt-1 text-display-xs font-semibold tabular-nums text-content">
                  {inspection.scorePercent === null
                    ? "No score"
                    : `${decimal(inspection.scorePercent, 1)}%`}
                </p>
                <p className="text-2xs text-content-muted">
                  {inspection.scorePercent === null
                    ? "Either the inspection has not been completed, or the template scores nothing by design."
                    : `${decimal(inspection.score ?? 0, 1)} of ${decimal(inspection.maxScore ?? 0, 1)} available`}
                </p>
              </CardBody>
            </Card>
            <Card variant="sunken">
              <CardBody>
                <p className="text-label uppercase text-content-subtle">Defects</p>
                <p className="mt-1 text-display-xs font-semibold tabular-nums text-content">
                  {count(inspection.defectCount)}
                </p>
                <p className="text-2xs text-content-muted">
                  {count(inspection.criticalDefectCount)} of them critical
                </p>
              </CardBody>
            </Card>
            <Card variant="sunken">
              <CardBody>
                <p className="text-label uppercase text-content-subtle">Open actions</p>
                <p className="mt-1 text-display-xs font-semibold tabular-nums text-content">
                  {count(inspection.openActionCount)}
                </p>
                <p className="text-2xs text-content-muted">
                  Raised from the defects and held in the project-wide register
                </p>
              </CardBody>
            </Card>
          </div>

          <DescriptionList items={facts} columns={2} dividers />

          {/* ------------------------------------------------------------ */}
          {inspection.status === "scheduled" ||
          inspection.status === "in_progress" ||
          inspection.status === "overdue" ? (
            <InspectionAnswerForm
              projectId={projectId}
              inspection={inspection}
              users={users}
              onCompleted={() => {
                setVersion((n) => n + 1);
                onMutated();
              }}
            />
          ) : null}

          {/* ------------------------------------------------------------ */}
          <section>
            <SectionHeading
              title="Answers"
              hint="Keyed to the template items as they stood at the version stamped on this inspection."
            />
            {(inspection.responses ?? []).length === 0 ? (
              <EmptyState
                size="sm"
                title="This inspection has not been answered"
                hint="It is scheduled but not performed. An empty answer set is not a pass — it is a walk that has not happened."
              />
            ) : (
              <ul className="space-y-1.5">
                {inspection.responses.map((r, i) => {
                  const item = r.itemId ? itemsById.get(r.itemId) : undefined;
                  const failed = r.isPass === false;
                  const na = r.isPass === null || r.isPass === undefined;
                  return (
                    <li
                      key={r.itemId ?? i}
                      className={cx(
                        "rounded-md border px-2.5 py-2",
                        failed && item?.isCritical
                          ? "border-danger-border bg-danger-subtle/50"
                          : failed
                            ? "border-warning-border bg-warning-subtle/40"
                            : "border-border bg-surface-raised",
                      )}
                    >
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <span className="min-w-0 text-meta text-content">
                          {item?.text ?? r.itemId ?? "Unmatched item"}
                          {item?.section ? (
                            <span className="block text-2xs text-content-subtle">
                              {item.section}
                            </span>
                          ) : null}
                        </span>
                        <span className="flex shrink-0 items-center gap-1.5">
                          {item?.isCritical ? (
                            <Badge tone="danger" size="xs" variant="outline">
                              Critical
                            </Badge>
                          ) : null}
                          <Badge
                            tone={na ? "neutral" : failed ? "danger" : "success"}
                            size="xs"
                            dot
                          >
                            {na ? "Not applicable" : failed ? "Fail" : "Pass"}
                          </Badge>
                        </span>
                      </div>
                      {r.note ? (
                        <p className="mt-1 text-2xs text-content-muted">{r.note}</p>
                      ) : null}
                      {r.response ? (
                        <p className="mt-1 text-2xs text-content-subtle">{r.response}</p>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {/* ------------------------------------------------------------ */}
          <section>
            <SectionHeading title={`Corrective actions · ${count(inspection.actions.length)}`} />
            <ActionList
              actions={inspection.actions}
              emptyTitle="No corrective action from this inspection"
              emptyHint="If every defect was closed out on the spot, the answers should say so. Defects recorded with nothing raised leave the register unable to show anybody fixed them."
            />
          </section>

          {/* ------------------------------------------------------------ */}
          <section>
            <SectionHeading
              title="Review"
              hint="A second person reading the walk. The platform refuses a review by the inspector — an inspection reviewed by the person who performed it has been filed, not checked."
            />
            {inspection.reviewedAt ? (
              <Alert tone="success" title={`Reviewed ${dateTime(inspection.reviewedAt)}`}>
                By {nameOf(users, inspection.reviewedBy)}.
              </Alert>
            ) : (
              <Card>
                <CardBody className="space-y-3">
                  {inspection.status === "scheduled" ? (
                    <ReasonList
                      reasons={[
                        "This inspection has not been performed yet, so there is nothing to review.",
                      ]}
                    />
                  ) : null}
                  <Field label="Review note">
                    <Textarea
                      rows={2}
                      value={reviewNote}
                      onChange={(e) => setReviewNote(e.target.value)}
                    />
                  </Field>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={inspection.status === "scheduled"}
                      loading={mutation.busy === "review"}
                      onClick={() =>
                        void mutation.run("review", "This inspection could not be reviewed", () =>
                          api.post(
                            `/api/v1/projects/${projectId}/safety/inspections/${inspection.id}/review`,
                            { ...(reviewNote.trim() ? { note: reviewNote.trim() } : {}) },
                          ),
                        )
                      }
                    >
                      Record the review
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={inspection.status === "scheduled"}
                      loading={mutation.busy === "review-close"}
                      onClick={() =>
                        void mutation.run(
                          "review-close",
                          "This inspection could not be reviewed and closed",
                          () =>
                            api.post(
                              `/api/v1/projects/${projectId}/safety/inspections/${inspection.id}/review`,
                              {
                                ...(reviewNote.trim() ? { note: reviewNote.trim() } : {}),
                                close: true,
                              },
                            ),
                        )
                      }
                    >
                      Review and close
                    </Button>
                  </div>
                </CardBody>
              </Card>
            )}
          </section>
        </div>
      ) : null}
    </Drawer>
  );
}
