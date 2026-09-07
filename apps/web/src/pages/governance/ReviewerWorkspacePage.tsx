/**
 * Independent reviewer workspace — company level (spec Vol I #410-411, #415).
 *
 * The person who signs a gate decision is not the person delivering the
 * project, so their working view is not a project page: it is every gate due
 * across the portfolio, every open condition of approval, and every
 * assurance action still outstanding, ranked by what falls over first.
 *
 * Scope honesty: the API returns only projects the caller holds governance
 * access on. When that scoping is in force the page says so, so an empty
 * list is never mistaken for "nothing to review".
 */
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiClientError } from "../../lib/api";
import {
  Badge,
  Card,
  CardBody,
  EmptyState,
  ErrorAlert,
  PageHeader,
  Spinner,
  Table,
  Td,
  Th,
} from "../../ui";
import { formatDate, humanize } from "../format";
import { DecisionChip, DueBadge, RagChip, SectionTitle } from "./governanceShared";

interface WorkspaceGate {
  id: string;
  projectId: string;
  projectName: string | null;
  gateNumber: number;
  name: string;
  status: string;
  plannedDate: string | null;
  daysToPlanned: number | null;
  criteria: number;
  evidenceRequired: number;
  latestReview: {
    id: string;
    decision: string;
    rag: string;
    reviewDate: string;
    evidencePackRoot: string | null;
  } | null;
}

interface WorkspaceCondition {
  projectId: string;
  projectName: string | null;
  reviewId: string;
  gateId: string;
  gateNumber: number | null;
  gateName: string | null;
  decision: string;
  conditionId: string;
  text: string;
  dueDate: string | null;
  obligationId: string;
  daysToDue: number | null;
}

interface WorkspaceAction {
  id: string;
  projectId: string;
  projectName: string | null;
  number: number;
  title: string;
  priority: string;
  status: string;
  ownerId: string | null;
  dueDate: string | null;
  daysToDue: number | null;
}

interface WorkspaceResponse {
  gates: WorkspaceGate[];
  conditions: WorkspaceCondition[];
  actions: WorkspaceAction[];
  projects: Array<{ id: string; name: string }>;
  scoped?: boolean;
  reason?: string;
}

export default function ReviewerWorkspacePage() {
  const [data, setData] = useState<WorkspaceResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .get<WorkspaceResponse>("/api/v1/governance/reviewer-workspace")
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setData({ gates: [], conditions: [], actions: [], projects: [] });
        setError(
          err instanceof ApiClientError ? err.message : "Could not load the reviewer workspace",
        );
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (data === null && error === null) return <Spinner label="Loading reviewer workspace…" />;

  const gates = data?.gates ?? [];
  const conditions = data?.conditions ?? [];
  const actions = data?.actions ?? [];
  const overdueConditions = conditions.filter((c) => (c.daysToDue ?? 1) < 0).length;
  const overdueActions = actions.filter((a) => (a.daysToDue ?? 1) < 0).length;

  function projectLink(projectId: string, name: string | null, tab: string) {
    return (
      <Link
        to={`/projects/${projectId}/governance?tab=${tab}`}
        className="font-medium text-brand-700 hover:text-brand-800"
      >
        {name ?? projectId}
      </Link>
    );
  }

  return (
    <div>
      <PageHeader
        title="Reviewer workspace"
        subtitle="Gates awaiting decision, conditions of approval and assurance actions across every project you assure"
      />

      <ErrorAlert message={error} />

      {data?.reason ? (
        <div className="mb-4 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800 ring-1 ring-amber-200">
          {data.reason}
        </div>
      ) : null}

      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Card>
          <CardBody className="px-4 py-3">
            <div className="text-xl font-bold tabular-nums text-ink-900">{gates.length}</div>
            <div className="text-xs font-medium uppercase tracking-wide text-ink-400">
              Gates open
            </div>
          </CardBody>
        </Card>
        <Card>
          <CardBody className="px-4 py-3">
            <div
              className={`text-xl font-bold tabular-nums ${
                overdueConditions > 0 ? "text-red-700" : "text-ink-900"
              }`}
            >
              {conditions.length}
            </div>
            <div className="text-xs font-medium uppercase tracking-wide text-ink-400">
              Open conditions{overdueConditions > 0 ? ` · ${overdueConditions} overdue` : ""}
            </div>
          </CardBody>
        </Card>
        <Card>
          <CardBody className="px-4 py-3">
            <div
              className={`text-xl font-bold tabular-nums ${
                overdueActions > 0 ? "text-red-700" : "text-ink-900"
              }`}
            >
              {actions.length}
            </div>
            <div className="text-xs font-medium uppercase tracking-wide text-ink-400">
              Assurance actions{overdueActions > 0 ? ` · ${overdueActions} overdue` : ""}
            </div>
          </CardBody>
        </Card>
        <Card>
          <CardBody className="px-4 py-3">
            <div className="text-xl font-bold tabular-nums text-ink-900">
              {data?.projects.length ?? 0}
            </div>
            <div className="text-xs font-medium uppercase tracking-wide text-ink-400">
              Projects{data?.scoped ? " in scope" : ""}
            </div>
          </CardBody>
        </Card>
      </div>

      {/* ---------------------------------- gates --------------------------------- */}
      <div className="mb-6">
        <SectionTitle>Gates awaiting a decision</SectionTitle>
        {gates.length === 0 ? (
          <EmptyState
            title="No gates awaiting decision"
            hint="Every stage gate in scope has been decided, or none has been defined yet."
          />
        ) : (
          <Card>
            <CardBody>
              <Table>
                <thead>
                  <tr>
                    <Th>Project</Th>
                    <Th>Gate</Th>
                    <Th>Planned</Th>
                    <Th>Criteria</Th>
                    <Th>Latest review</Th>
                    <Th>Evidence pack</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-100">
                  {gates.map((g) => (
                    <tr key={g.id}>
                      <Td className="text-sm">
                        {projectLink(g.projectId, g.projectName, "stage-gates")}
                      </Td>
                      <Td className="text-sm">
                        <span className="font-mono text-xs text-ink-500">G{g.gateNumber}</span>{" "}
                        {g.name}
                        <div className="mt-0.5">
                          <Badge tone={g.status === "in_review" ? "amber" : "gray"}>
                            {humanize(g.status)}
                          </Badge>
                        </div>
                      </Td>
                      <Td className="whitespace-nowrap">
                        {g.plannedDate ? (
                          <>
                            <div className="text-xs text-ink-600">{formatDate(g.plannedDate)}</div>
                            <DueBadge days={g.daysToPlanned} />
                          </>
                        ) : (
                          <span className="text-xs text-ink-400">not scheduled</span>
                        )}
                      </Td>
                      <Td className="whitespace-nowrap text-xs text-ink-600">
                        {g.criteria} · {g.evidenceRequired} need evidence
                      </Td>
                      <Td>
                        {g.latestReview ? (
                          <div className="flex flex-wrap items-center gap-1.5">
                            <RagChip rag={g.latestReview.rag} />
                            <DecisionChip decision={g.latestReview.decision} />
                            <span className="text-[11px] text-ink-400">
                              {formatDate(g.latestReview.reviewDate)}
                            </span>
                          </div>
                        ) : (
                          <span className="text-xs text-ink-400">never reviewed</span>
                        )}
                      </Td>
                      <Td className="font-mono text-[11px] text-ink-500">
                        {g.latestReview?.evidencePackRoot ? (
                          <span title={g.latestReview.evidencePackRoot}>
                            {g.latestReview.evidencePackRoot.slice(0, 12)}…
                          </span>
                        ) : (
                          <span className="text-ink-300">—</span>
                        )}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </CardBody>
          </Card>
        )}
      </div>

      {/* -------------------------------- conditions ------------------------------- */}
      <div className="mb-6">
        <SectionTitle>Open conditions of approval</SectionTitle>
        {conditions.length === 0 ? (
          <p className="rounded-md bg-ink-50 px-3 py-2 text-xs text-ink-500 ring-1 ring-ink-100">
            No gate decision in scope carries an outstanding condition.
          </p>
        ) : (
          <Card>
            <CardBody>
              <Table>
                <thead>
                  <tr>
                    <Th>Project</Th>
                    <Th>Gate</Th>
                    <Th>Condition</Th>
                    <Th>Decision</Th>
                    <Th>Due</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-100">
                  {conditions.map((c) => (
                    <tr key={c.conditionId}>
                      <Td className="text-sm">
                        {projectLink(c.projectId, c.projectName, "stage-gates")}
                      </Td>
                      <Td className="whitespace-nowrap text-xs text-ink-600">
                        {c.gateNumber === null ? "—" : `G${c.gateNumber}`} {c.gateName ?? ""}
                      </Td>
                      <Td className="text-sm text-ink-800">{c.text}</Td>
                      <Td>
                        <DecisionChip decision={c.decision} />
                      </Td>
                      <Td className="whitespace-nowrap">
                        <DueBadge days={c.daysToDue} />
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </CardBody>
          </Card>
        )}
      </div>

      {/* --------------------------------- actions --------------------------------- */}
      <div>
        <SectionTitle>Outstanding assurance actions</SectionTitle>
        {actions.length === 0 ? (
          <p className="rounded-md bg-ink-50 px-3 py-2 text-xs text-ink-500 ring-1 ring-ink-100">
            No open assurance actions in scope.
          </p>
        ) : (
          <Card>
            <CardBody>
              <Table>
                <thead>
                  <tr>
                    <Th>Project</Th>
                    <Th>Action</Th>
                    <Th>Priority</Th>
                    <Th>Status</Th>
                    <Th>Due</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-100">
                  {actions.map((a) => (
                    <tr key={a.id}>
                      <Td className="text-sm">
                        {projectLink(a.projectId, a.projectName, "assurance-actions")}
                      </Td>
                      <Td className="text-sm">
                        <span className="font-mono text-xs text-ink-500">
                          AA-{String(a.number).padStart(3, "0")}
                        </span>{" "}
                        {a.title}
                      </Td>
                      <Td>
                        <Badge
                          tone={
                            a.priority === "critical"
                              ? "red"
                              : a.priority === "essential"
                                ? "amber"
                                : "gray"
                          }
                        >
                          {humanize(a.priority)}
                        </Badge>
                      </Td>
                      <Td>
                        <Badge tone={a.status === "overdue" ? "red" : "amber"}>
                          {humanize(a.status)}
                        </Badge>
                      </Td>
                      <Td className="whitespace-nowrap">
                        <DueBadge days={a.daysToDue} />
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </CardBody>
          </Card>
        )}
      </div>
    </div>
  );
}
