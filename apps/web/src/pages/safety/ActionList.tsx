/**
 * A compact list of corrective actions, used inside every drawer that can
 * raise one (incident, observation, inspection).
 *
 * Each row leads with the level of control chosen, because that is the fact
 * that distinguishes a fix from a gesture: "toolbox talk on ladder use" and
 * "ladders removed, mobile tower issued" are both actions, and only one of
 * them survives the operative having a bad morning.
 */
import { Badge, Card, CardBody, EmptyState } from "../../ui";
import {
  ACTION_STATUS_TONE,
  EFFECTIVENESS_TONE,
  HierarchyBadge,
  count,
  isoDate,
  labelize,
  type CorrectiveAction,
} from "./safetyShared";

export default function ActionList({
  actions,
  emptyTitle,
  emptyHint,
  onOpen,
}: {
  actions: readonly CorrectiveAction[];
  emptyTitle: string;
  emptyHint: string;
  onOpen?: (id: string) => void;
}) {
  if (actions.length === 0) {
    return <EmptyState size="sm" title={emptyTitle} hint={emptyHint} />;
  }

  return (
    <ul className="space-y-2">
      {actions.map((action) => (
        <li key={action.id}>
          <Card
            accent={action.isOverdue ? "danger" : action.isWeakControl ? "warning" : undefined}
            interactive={onOpen !== undefined}
            onClick={onOpen ? () => onOpen(action.id) : undefined}
          >
            <CardBody className="space-y-1.5">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-body font-medium text-content">
                    <span className="font-mono text-2xs text-content-muted">
                      {action.reference}
                    </span>{" "}
                    {action.title}
                  </p>
                  <p className="mt-0.5 text-2xs text-content-subtle">
                    {labelize(action.actionKind)} · owner{" "}
                    {action.ownerName ?? action.ownerId ?? action.ownerVendorId ?? "unassigned"} ·
                    due {isoDate(action.dueDate)}
                  </p>
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                  <HierarchyBadge value={action.hierarchyOfControl} />
                  <Badge tone={ACTION_STATUS_TONE[action.status] ?? "neutral"} size="xs" dot>
                    {labelize(action.status)}
                  </Badge>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-1.5">
                {action.isOverdue ? (
                  <Badge tone="danger" size="xs">
                    {count(action.daysOverdue)} days overdue
                  </Badge>
                ) : null}
                <Badge
                  tone={EFFECTIVENESS_TONE[action.effectivenessVerdict] ?? "neutral"}
                  size="xs"
                  variant="outline"
                >
                  Effectiveness · {labelize(action.effectivenessVerdict)}
                </Badge>
                {action.revisedCount > 0 ? (
                  <Badge tone="warning" size="xs" variant="outline">
                    Due date revised ×{action.revisedCount}
                  </Badge>
                ) : null}
              </div>

              {action.effectivenessOutstanding && action.completedAt ? (
                <p className="text-2xs text-content-muted">
                  Completed {isoDate(action.completedAt)} but not yet shown to have worked. An action
                  closed on evidence of completion has not been proven effective.
                </p>
              ) : null}
            </CardBody>
          </Card>
        </li>
      ))}
    </ul>
  );
}
