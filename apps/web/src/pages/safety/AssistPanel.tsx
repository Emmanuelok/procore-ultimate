/**
 * THE INVESTIGATION ASSISTANT, ON SCREEN (Vol I §6.4; Vol II X #1017–1019).
 *
 * Two halves, deliberately separated, because they fail differently.
 *
 * THE ASSEMBLY is deterministic and always loads: every observation raised on
 * this location or against this subcontractor in the ninety days before, the
 * inspections of that work, the briefings the crew received, the prior
 * incidents sharing the mechanism, the open actions and the safety documents
 * in force. It is the half an investigator actually needs and it does not
 * depend on an API key. When the AI layer is off, this is the whole panel and
 * it is still worth opening.
 *
 * THE READING is the model's, and it is a PROPOSAL. Nothing on this screen is
 * written to the incident until somebody ticks it and presses accept, and
 * acceptance carries the agent run id into the record so that a year later a
 * contributing factor can be traced to the run that suggested it and the
 * person who agreed. Every suggestion shows the records it was drawn from;
 * citations the model invented were dropped by the API before they reached
 * here, and the count is printed rather than hidden.
 *
 * THE WEAK-CONTROL WARNING is shown at the top, not the bottom. A proposal set
 * consisting only of briefings and PPE is the answer that produces the same
 * accident again, and the reader has to see that before they start ticking.
 */
import { useMemo, useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  Checkbox,
  Field,
  Input,
  Select,
  Skeleton,
} from "../../ui";
import { IconAi } from "../../ui/icons";
import { api } from "../../lib/api";
import {
  HIERARCHY_LABEL,
  HIERARCHY_ORDER,
  HierarchyBadge,
  LoadError,
  ReasonList,
  SectionHeading,
  addDays,
  count,
  decimal,
  errorMessage,
  isRefusal,
  labelize,
  today,
  useResource,
  type AssistContextResponse,
  type AssistDraftAction,
  type AssistFactor,
  type AssistRecordRef,
  type AssistResponse,
  type IncidentDetail,
} from "./safetyShared";

const CATEGORY_LABEL: Record<string, string> = {
  immediate: "Immediate",
  underlying: "Underlying",
  organisational: "Organisational",
};

export default function AssistPanel({
  projectId,
  incident,
  onMutated,
}: {
  projectId: string;
  incident: IncidentDetail;
  onMutated: () => void;
}) {
  const [assist, setAssist] = useState<AssistResponse | null>(null);
  const [askBusy, setAskBusy] = useState(false);
  const [askError, setAskError] = useState<string | null>(null);
  const [aiUnavailable, setAiUnavailable] = useState<string | null>(null);
  const [pickedFactors, setPickedFactors] = useState<Set<number>>(() => new Set());
  const [pickedActions, setPickedActions] = useState<Set<number>>(() => new Set());
  const [actionOwners, setActionOwners] = useState<Record<number, string>>({});
  const [actionDates, setActionDates] = useState<Record<number, string>>({});
  const [actionLevels, setActionLevels] = useState<Record<number, string>>({});
  const [acceptBusy, setAcceptBusy] = useState(false);
  const [acceptError, setAcceptError] = useState<string | null>(null);
  const [accepted, setAccepted] = useState<{ factors: number; actions: number; warning: string | null } | null>(
    null,
  );

  const ctx = useResource<AssistContextResponse>(
    (signal) =>
      api.get<AssistContextResponse>(
        `/api/v1/projects/${projectId}/safety/incidents/${incident.id}/assist/context`,
        { signal },
      ),
    [projectId, incident.id],
    projectId !== "",
  );

  const groups = useMemo(() => {
    const c = ctx.data?.context;
    if (!c) return [];
    return [
      {
        key: "priorObservations",
        title: "Observations on this location or this subcontractor, in the 90 days before",
        refs: c.priorObservations,
        empty:
          "None. That is a statement about the REGISTER: a site with no observations before a serious incident is either exceptionally safe or not reporting.",
      },
      {
        key: "priorIncidents",
        title: "Prior incidents sharing the mechanism",
        refs: c.priorIncidents,
        empty: "None recorded on this project.",
      },
      {
        key: "inspections",
        title: "Inspections of this work",
        refs: c.inspections,
        empty: "No inspection of this work is recorded.",
      },
      {
        key: "briefings",
        title: "Briefings the crew received",
        refs: c.briefings,
        empty: "No toolbox talk attendance is recorded for this crew.",
      },
      {
        key: "openActions",
        title: "Corrective actions still open on this project",
        refs: c.openActions,
        empty: "None open.",
      },
      {
        key: "programmeRecords",
        title: "Safety documents in force",
        refs: c.programmeRecords,
        empty: "No programme record applies to this work.",
      },
    ];
  }, [ctx.data]);

  const body = assist?.assist ?? null;

  async function ask() {
    setAskBusy(true);
    setAskError(null);
    setAiUnavailable(null);
    setAccepted(null);
    try {
      const res = await api.post<AssistResponse>(
        `/api/v1/projects/${projectId}/safety/incidents/${incident.id}/assist`,
        {},
      );
      setAssist(res);
      setPickedFactors(new Set());
      setPickedActions(new Set());
    } catch (err: unknown) {
      const status = (err as { status?: number } | null)?.status;
      if (status === 503) {
        setAiUnavailable(
          "The AI layer is not configured on this deployment, so no reading of the pattern is " +
            "available. Everything above is unaffected: it is assembled from records this platform " +
            "holds, with nothing inferred.",
        );
      } else if (isRefusal(err)) {
        setAskError(errorMessage(err, "The assistant refused"));
      } else {
        setAskError(errorMessage(err, "The assistant could not be run"));
      }
    } finally {
      setAskBusy(false);
    }
  }

  async function accept() {
    if (!body || !assist?.runId) return;
    setAcceptBusy(true);
    setAcceptError(null);
    try {
      const factors = [...pickedFactors]
        .map((i) => body.contributingFactors[i])
        .filter((f): f is AssistFactor => f != null)
        .map((f) => ({
          factor: f.factor,
          category: f.category,
          ...(f.note ? { note: f.note } : {}),
          sourceIds: f.sourceIds,
        }));
      const actions = [...pickedActions]
        .map((i) => ({ i, a: body.draftActions[i] }))
        .filter((x): x is { i: number; a: AssistDraftAction } => x.a != null)
        .map(({ i, a }) => ({
          title: a.title,
          ...(a.description ? { description: a.description } : {}),
          hierarchyOfControl:
            actionLevels[i] ?? a.hierarchyOfControl ?? "administrative",
          dueDate: actionDates[i] ?? addDays(today(), a.targetDays ?? 14),
          ...(actionOwners[i]?.trim() ? { ownerId: actionOwners[i]!.trim() } : {}),
          sourceIds: a.sourceIds,
        }));
      const res = await api.post<{
        contributingFactorsAccepted: number;
        actionsCreated: Array<{ id: string }>;
        warning: string | null;
      }>(`/api/v1/projects/${projectId}/safety/incidents/${incident.id}/assist/accept`, {
        runId: assist.runId,
        ...(factors.length > 0 ? { contributingFactors: factors } : {}),
        ...(actions.length > 0 ? { actions } : {}),
      });
      setAccepted({
        factors: res.contributingFactorsAccepted,
        actions: res.actionsCreated.length,
        warning: res.warning,
      });
      setPickedFactors(new Set());
      setPickedActions(new Set());
      onMutated();
    } catch (err: unknown) {
      setAcceptError(errorMessage(err, "Nothing was accepted"));
    } finally {
      setAcceptBusy(false);
    }
  }

  const nothingPicked = pickedFactors.size === 0 && pickedActions.size === 0;
  const frozen = incident.status === "closed" || incident.status === "void";

  return (
    <div className="space-y-4">
      <SectionHeading
        title="Investigation assistant"
        hint="A reader, not an investigator. It cites the record behind every suggestion and writes nothing until a human accepts it."
        actions={
          <Button
            size="sm"
            variant="secondary"
            loading={askBusy}
            disabled={ctx.data?.aiAvailable === false || frozen}
            onClick={() => void ask()}
          >
            {body ? "Ask again" : "Ask the assistant"}
          </Button>
        }
      />

      {frozen ? (
        <Alert tone="info" size="sm" title="This incident is closed">
          The assembly below is still readable. Nothing can be accepted onto a signed-off
          investigation — reopen the incident first.
        </Alert>
      ) : null}

      {ctx.data && !ctx.data.aiAvailable ? (
        <Alert tone="info" size="sm" title="The AI layer is not configured">
          {ctx.data.note}
        </Alert>
      ) : null}
      {aiUnavailable ? (
        <Alert tone="info" size="sm" title="No reading is available">
          {aiUnavailable}
        </Alert>
      ) : null}
      {askError ? (
        <Alert tone="danger" title="The assistant could not be run" onDismiss={() => setAskError(null)}>
          {askError}
        </Alert>
      ) : null}

      {/* ------------------------------------------------------------ */}
      {ctx.error ? (
        <LoadError
          message={ctx.error}
          onRetry={ctx.reload}
          title="The records around this incident could not be assembled"
        />
      ) : ctx.loading && !ctx.data ? (
        <Skeleton height={220} />
      ) : ctx.data ? (
        <Card>
          <CardBody className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-meta font-medium text-content">
                What the platform holds around {ctx.data.reference}
              </p>
              <Badge tone="neutral" size="xs" variant="outline">
                Deterministic · nothing inferred
              </Badge>
            </div>
            {ctx.data.context.openQuestions.length > 0 ? (
              <Alert tone="warning" size="sm" title="Statutory questions still open on this case">
                <ReasonList reasons={ctx.data.context.openQuestions} />
              </Alert>
            ) : null}
            {groups.map((g) => (
              <RefGroup key={g.key} title={g.title} refs={g.refs} empty={g.empty} />
            ))}
            {ctx.data.context.witnesses.length > 0 ? (
              <div>
                <p className="text-2xs font-medium uppercase tracking-wide text-content-subtle">
                  Witnesses
                </p>
                <ul className="mt-1 space-y-1">
                  {ctx.data.context.witnesses.map((w, i) => (
                    <li key={i} className="rounded-md border border-border bg-surface-raised p-2 text-2xs">
                      <span className="font-medium text-content">
                        {w.name}
                        {w.organisation ? ` · ${w.organisation}` : ""}
                      </span>
                      <span className="mt-0.5 block text-content-muted">
                        {w.statement ?? "Statement not transcribed."}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </CardBody>
        </Card>
      ) : null}

      {/* ------------------------------------------------------------ */}
      {body ? (
        <div className="space-y-3">
          {body.onlyWeakControls || body.weakControlNote ? (
            <Alert tone="warning" title="Every control proposed sits at the weak end">
              {body.weakControlNote ??
                "A briefing, a procedure or an item of kit depends on the person at the sharp end " +
                  "doing the right thing every time under production pressure. Before accepting any " +
                  "of these, ask what would have to change for the hazard to be designed out, " +
                  "guarded or isolated."}
            </Alert>
          ) : null}

          <div className="flex flex-wrap items-center gap-2 text-2xs text-content-muted">
            <IconAi className="size-3.5" aria-hidden />
            <span>
              Run {assist?.runId ?? "—"} ·{" "}
              {body.confidence === null ? "no confidence stated" : `confidence ${decimal(body.confidence * 100, 0)}%`}
            </span>
            {body.droppedCitations > 0 ? (
              <Badge tone="danger" size="xs" variant="outline">
                {count(body.droppedCitations)} fabricated citation(s) dropped
              </Badge>
            ) : null}
          </div>
          {body.summary ? (
            <p className="whitespace-pre-wrap text-meta text-content-muted">{body.summary}</p>
          ) : null}
          {body.notes.length > 0 ? <ReasonList reasons={body.notes} /> : null}

          {accepted ? (
            <Alert tone="success" title="Accepted onto the incident">
              {count(accepted.factors)} contributing factor(s) and {count(accepted.actions)} corrective
              action(s) were written, each carrying this run id as their provenance.
              {accepted.warning ? ` ${accepted.warning}` : ""}
            </Alert>
          ) : null}
          {acceptError ? (
            <Alert tone="danger" title="Nothing was accepted" onDismiss={() => setAcceptError(null)}>
              {acceptError}
            </Alert>
          ) : null}

          {/* -------------------------------------------------------- */}
          <section className="space-y-2">
            <SectionHeading
              title={`Contributing factors · ${count(body.contributingFactors.length)}`}
              hint="Tick the ones that survive scrutiny. An immediate cause on its own describes the event; the underlying and organisational ones are what produce the next."
            />
            {body.contributingFactors.length === 0 ? (
              <p className="text-2xs text-content-subtle">None proposed.</p>
            ) : (
              body.contributingFactors.map((f, i) => (
                <div key={i} className="rounded-lg border border-border bg-surface-raised p-2.5">
                  <Checkbox
                    size="sm"
                    disabled={frozen}
                    checked={pickedFactors.has(i)}
                    onChange={(e) =>
                      setPickedFactors((prev) => {
                        const next = new Set(prev);
                        if (e.target.checked) next.add(i);
                        else next.delete(i);
                        return next;
                      })
                    }
                    label={
                      <span className="text-meta text-content">
                        {f.factor}{" "}
                        <Badge tone="neutral" size="xs" variant="outline">
                          {CATEGORY_LABEL[f.category] ?? labelize(f.category)}
                        </Badge>
                      </span>
                    }
                    description={f.note ?? undefined}
                  />
                  <Citations refs={f.sourceIds} unsourced={f.unsourced} dropped={f.droppedIds} />
                </div>
              ))
            )}
          </section>

          {/* -------------------------------------------------------- */}
          {body.rootCauseHypotheses.length > 0 ? (
            <section className="space-y-2">
              <SectionHeading
                title="Root-cause hypotheses"
                hint="Ranked, with what would test each one. A hypothesis is not a finding; nothing here is written to the incident."
              />
              {body.rootCauseHypotheses.map((h, i) => (
                <div key={i} className="rounded-lg border border-border bg-surface-raised p-2.5">
                  <p className="text-meta font-medium text-content">
                    {h.rank ? `${h.rank}. ` : ""}
                    {h.hypothesis}
                  </p>
                  {h.reasoning ? (
                    <p className="mt-1 text-2xs text-content-muted">{h.reasoning}</p>
                  ) : null}
                  {h.testableBy ? (
                    <p className="mt-1 text-2xs text-content-subtle">
                      <span className="font-medium">Test it by:</span> {h.testableBy}
                    </p>
                  ) : null}
                  <Citations refs={h.sourceIds} unsourced={h.unsourced} dropped={h.droppedIds} />
                </div>
              ))}
            </section>
          ) : null}

          {/* -------------------------------------------------------- */}
          {body.openQuestions.length > 0 ? (
            <section className="space-y-2">
              <SectionHeading
                title="Questions for the site"
                hint="Phrased so somebody on the job today can answer them."
              />
              <ul className="space-y-1">
                {body.openQuestions.map((q, i) => (
                  <li key={i} className="rounded-md border border-border bg-surface-raised p-2 text-2xs">
                    <span className="block font-medium text-content">{q.question}</span>
                    {q.why ? <span className="block text-content-muted">{q.why}</span> : null}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {/* -------------------------------------------------------- */}
          <section className="space-y-2">
            <SectionHeading
              title={`Draft corrective actions · ${count(body.draftActions.length)}`}
              hint="Accepting one raises it in the project's corrective-action register with this run recorded as its origin."
            />
            {body.draftActions.length === 0 ? (
              <p className="text-2xs text-content-subtle">None proposed.</p>
            ) : (
              body.draftActions.map((a, i) => (
                <div key={i} className="space-y-2 rounded-lg border border-border bg-surface-raised p-2.5">
                  <Checkbox
                    size="sm"
                    disabled={frozen}
                    checked={pickedActions.has(i)}
                    onChange={(e) =>
                      setPickedActions((prev) => {
                        const next = new Set(prev);
                        if (e.target.checked) next.add(i);
                        else next.delete(i);
                        return next;
                      })
                    }
                    label={<span className="text-meta text-content">{a.title}</span>}
                    description={a.description ?? undefined}
                  />
                  <div className="flex flex-wrap items-center gap-2">
                    {a.hierarchyOfControl ? (
                      <HierarchyBadge value={a.hierarchyOfControl} />
                    ) : (
                      <Badge tone="warning" size="xs" variant="outline">
                        Level not set
                      </Badge>
                    )}
                    {a.hierarchyReason ? (
                      <span className="text-2xs text-content-subtle">{a.hierarchyReason}</span>
                    ) : null}
                  </div>
                  {pickedActions.has(i) ? (
                    <div className="grid gap-2 sm:grid-cols-3">
                      <Field label="Level of control">
                        <Select
                          value={actionLevels[i] ?? a.hierarchyOfControl ?? "administrative"}
                          onChange={(e) =>
                            setActionLevels((prev) => ({ ...prev, [i]: e.target.value }))
                          }
                        >
                          {HIERARCHY_ORDER.map((h, n) => (
                            <option key={h} value={h}>
                              {n + 1}. {HIERARCHY_LABEL[h]}
                            </option>
                          ))}
                        </Select>
                      </Field>
                      <Field label="Owner (user id)" hint="Optional — an action with a date and no name is a wish.">
                        <Input
                          value={actionOwners[i] ?? ""}
                          placeholder="usr_…"
                          onChange={(e) =>
                            setActionOwners((prev) => ({ ...prev, [i]: e.target.value }))
                          }
                        />
                      </Field>
                      <Field label="Due date">
                        <Input
                          type="date"
                          value={actionDates[i] ?? addDays(today(), a.targetDays ?? 14)}
                          onChange={(e) =>
                            setActionDates((prev) => ({ ...prev, [i]: e.target.value }))
                          }
                        />
                      </Field>
                    </div>
                  ) : null}
                  <Citations refs={a.sourceIds} unsourced={a.unsourced} dropped={a.droppedIds} />
                </div>
              ))
            )}
          </section>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              disabled={nothingPicked || frozen}
              loading={acceptBusy}
              onClick={() => void accept()}
            >
              Accept {count(pickedFactors.size)} factor(s) and {count(pickedActions.size)} action(s)
            </Button>
            <span className="text-2xs text-content-subtle">
              Nothing above has been written. Acceptance is a separate, ledgered act carrying this
              run id.
            </span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function RefGroup({
  title,
  refs,
  empty,
}: {
  title: string;
  refs: AssistRecordRef[];
  empty: string;
}) {
  return (
    <div>
      <p className="text-2xs font-medium uppercase tracking-wide text-content-subtle">
        {title} · {count(refs.length)}
      </p>
      {refs.length === 0 ? (
        <p className="mt-1 text-2xs text-content-subtle">{empty}</p>
      ) : (
        <ul className="mt-1 space-y-1">
          {refs.map((r) => (
            <li key={r.id} className="rounded-md border border-border bg-surface-raised p-2 text-2xs">
              <span className="flex flex-wrap items-center gap-1.5">
                <span className="font-mono text-2xs text-content-subtle">{r.reference}</span>
                <span className="font-medium text-content">{r.label}</span>
              </span>
              <span className="mt-0.5 block text-content-muted">{r.summary}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Citations({
  refs,
  unsourced,
  dropped,
}: {
  refs: string[];
  unsourced: boolean;
  dropped: string[];
}) {
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1">
      {unsourced ? (
        <Badge tone="warning" size="xs" variant="outline">
          Unsourced — nothing in the platform supports this yet
        </Badge>
      ) : (
        refs.map((id) => (
          <Badge key={id} tone="neutral" size="xs" variant="outline">
            <span className="font-mono">{id}</span>
          </Badge>
        ))
      )}
      {dropped.length > 0 ? (
        <Badge tone="danger" size="xs" variant="outline">
          {count(dropped.length)} citation(s) named records that were never in the prompt and were
          dropped
        </Badge>
      ) : null}
    </div>
  );
}
