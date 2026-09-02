/**
 * PRIORITISATION — the MCDA model, the scores entered under it and the
 * ranking they produce (#424–#425).
 *
 * Three things this panel refuses to do, all of them deliberate:
 *  · it never shows a stored rank — the ranking is recomputed on every read,
 *    because a rank goes stale the moment another project is scored;
 *  · a project nobody has scored shows "not scored", never a zero — a
 *    fabricated zero reads as "scored badly", which is a different claim;
 *  · it prints the INFLUENCE of each criterion, so a heavily weighted
 *    criterion that changes nothing about the ranking is visible as such.
 */
import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  DataTable,
  Drawer,
  EmptyState,
  Field,
  Input,
  Select,
  Table,
  Td,
  Textarea,
  Th,
  toast,
  type DataColumns,
} from "../../ui";
import { IconPlus, IconTarget } from "../../ui/icons";
import {
  DASH,
  LoadError,
  ReasonList,
  Row,
  num,
  pct,
  portfolioApi,
  statusTone,
  titleCase,
  useAction,
  useIsCompanyAdmin,
  useProjects,
  useResource,
  type McdaRanked,
  type Paginated,
  type RankingResponse,
  type ScoringModel,
} from "./portfolioShared";

export default function PrioritisationTab() {
  const isAdmin = useIsCompanyAdmin();
  const models = useResource<Paginated<ScoringModel>>("/api/v1/portfolio/scoring-models?page=1&pageSize=100");
  const [modelId, setModelId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [scoring, setScoring] = useState(false);
  const [openRow, setOpenRow] = useState<McdaRanked | null>(null);
  const action = useAction();

  const activeId = modelId ?? models.data?.items[0]?.id ?? null;
  const detail = useResource<ScoringModel>(activeId ? `/api/v1/portfolio/scoring-models/${activeId}` : null);
  const ranking = useResource<RankingResponse>(
    activeId ? `/api/v1/portfolio/scoring-models/${activeId}/ranking` : null,
  );

  function reloadAll() {
    models.reload();
    detail.reload();
    ranking.reload();
  }

  const rankColumns = useMemo<DataColumns<McdaRanked>>(
    () => [
      {
        id: "rank",
        header: "Rank",
        accessor: (r) => r.rank ?? 9999,
        type: "number",
        align: "right",
        width: 80,
        cell: ({ row }) =>
          row.rank === null ? <span className="italic text-content-subtle">not scored</span> : String(row.rank),
      },
      { id: "projectName", header: "Project", accessor: "projectName", type: "text", width: 260 },
      {
        id: "stage",
        header: "Stage",
        accessor: (r) => r.stage ?? "",
        type: "text",
        width: 150,
        cell: ({ row }) => (row.stage ? titleCase(row.stage) : DASH),
      },
      {
        id: "score",
        header: "Score",
        accessor: (r) => r.score ?? -1,
        type: "number",
        align: "right",
        width: 100,
        cell: ({ row }) =>
          row.score === null ? (
            <span className="italic text-content-subtle">{DASH}</span>
          ) : (
            <span className="font-semibold">{row.score.toFixed(1)}</span>
          ),
      },
      {
        id: "coverage",
        header: "Coverage",
        accessor: (r) => r.coverage,
        type: "number",
        align: "right",
        width: 110,
        cell: ({ row }) => (
          <span className={row.coverage < 1 ? "text-warning-text" : undefined}>
            {pct(row.coverage * 100, 0)}
          </span>
        ),
      },
      {
        id: "scoredCriteria",
        header: "Criteria scored",
        accessor: "scoredCriteria",
        type: "number",
        align: "right",
        width: 130,
      },
      {
        id: "reasons",
        header: "Why",
        accessor: (r) => r.reasons.join(" "),
        type: "text",
        width: 420,
        cell: ({ row }) =>
          row.reasons.length === 0 ? (
            <span className="text-content-subtle">scored on every criterion</span>
          ) : (
            row.reasons[0]
          ),
      },
    ],
    [],
  );

  const model = detail.data;
  const run = ranking.data?.run ?? null;

  return (
    <div className="space-y-4">
      <Card>
        <CardBody className="flex flex-wrap items-end gap-3">
          <Field label="Scoring model" className="min-w-[18rem]">
            <Select
              value={activeId ?? ""}
              onChange={(e) => setModelId(e.target.value || null)}
              size="sm"
              disabled={(models.data?.items.length ?? 0) === 0}
            >
              {(models.data?.items ?? []).map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name} (v{m.version}, {m.status})
                </option>
              ))}
            </Select>
          </Field>
          {model ? (
            <div className="flex items-center gap-2 pb-1.5">
              <Badge tone={statusTone(model.status)} size="xs" dot>
                {titleCase(model.status)}
              </Badge>
              <span className="text-2xs text-content-subtle">
                {model.criteria.length} criteria · {num(model.scores?.length ?? 0)} project(s) scored
              </span>
            </div>
          ) : null}
          <div className="ml-auto flex gap-2">
            {isAdmin && model ? (
              <Button size="sm" icon={IconTarget} variant="secondary" onClick={() => setScoring(true)}>
                Score a project
              </Button>
            ) : null}
            {isAdmin ? (
              <Button size="sm" icon={IconPlus} onClick={() => setCreating(true)}>
                New model
              </Button>
            ) : null}
          </div>
        </CardBody>
      </Card>

      {models.error ? <LoadError message={models.error} onRetry={models.reload} /> : null}
      {!models.loading && (models.data?.items.length ?? 0) === 0 ? (
        <Card>
          <CardBody>
            <EmptyState
              icon={IconTarget}
              title="No scoring model yet"
              description="A model is a set of criteria with weights and a direction — strategic fit is a benefit, delivery risk is a cost. Score projects against it and the ranking is computed here, never stored."
              action={isAdmin ? <Button onClick={() => setCreating(true)}>Create a model</Button> : undefined}
            />
          </CardBody>
        </Card>
      ) : null}

      {model ? (
        <Card>
          <CardHeader
            title="Criteria and weights"
            subtitle="Weights are stored as entered and normalised at scoring time, so 1–5 importance values and percentages are equally valid."
          />
          <CardBody flush>
            <div className="overflow-x-auto">
              <Table>
                <thead>
                  <tr>
                    <Th>Criterion</Th>
                    <Th>Direction</Th>
                    <Th align="right">Weight</Th>
                    <Th align="right">Share of model</Th>
                    <Th align="right">Scale</Th>
                    <Th align="right">Rank changes if removed</Th>
                  </tr>
                </thead>
                <tbody>
                  {model.criteria.map((c) => {
                    const inf = run?.influence.find((i) => i.key === c.key);
                    const share = run?.criteria.find((x) => x.key === c.key)?.weightShare ?? null;
                    return (
                      <tr key={c.key}>
                        <Td>
                          <div className="font-medium text-content">{c.label}</div>
                          {c.description ? (
                            <div className="text-2xs text-content-subtle">{c.description}</div>
                          ) : null}
                        </Td>
                        <Td>
                          <Badge tone={c.direction === "cost" ? "warning" : "info"} size="xs">
                            {c.direction === "cost" ? "Cost (lower is better)" : "Benefit"}
                          </Badge>
                        </Td>
                        <Td align="right">{c.weight}</Td>
                        <Td align="right">{share === null ? DASH : pct(share * 100)}</Td>
                        <Td align="right">
                          {c.min}–{c.max}
                        </Td>
                        <Td align="right">
                          {inf === undefined ? (
                            DASH
                          ) : inf.rankChanges === 0 ? (
                            <span className="text-warning-text" title="This criterion carries weight but changes no decision">
                              none
                            </span>
                          ) : (
                            <span>
                              {inf.rankChanges}
                              {inf.changesLeader ? (
                                <span className="ml-1 text-2xs text-danger-text">changes the leader</span>
                              ) : null}
                            </span>
                          )}
                        </Td>
                      </tr>
                    );
                  })}
                </tbody>
              </Table>
            </div>
            {run && run.excludedCriteria.length > 0 ? (
              <div className="border-t border-border p-3">
                <div className="mb-1 text-2xs font-semibold uppercase tracking-wide text-content-subtle">
                  Criteria excluded from this run
                </div>
                <ReasonList reasons={run.excludedCriteria.map((c) => `${c.key}: ${c.reason}`)} />
              </div>
            ) : null}
          </CardBody>
        </Card>
      ) : null}

      {activeId ? (
        <Card>
          <CardHeader
            title="Ranking"
            subtitle={
              ranking.data
                ? `Computed ${ranking.data.method === "relative" ? "against the spread in this candidate set" : "against each criterion's declared scale"}, model version ${ranking.data.modelVersion}. Never stored — a stored rank is stale the moment another project is scored.`
                : undefined
            }
          />
          <CardBody flush>
            {ranking.error ? (
              <div className="p-4">
                <LoadError message={ranking.error} onRetry={ranking.reload} />
              </div>
            ) : (
              <DataTable<McdaRanked>
                tableId="portfolio.mcda-ranking"
                data={run?.ranked ?? []}
                columns={rankColumns}
                getRowId={(row) => row.projectId}
                loading={ranking.loading && !ranking.data}
                height={420}
                rowHeight={44}
                stickyHeader
                flush
                toolbar={false}
                onRowClick={({ row }) => setOpenRow(row)}
                rowTone={(row) => (row.rank === null ? "neutral" : undefined)}
                empty={{
                  title: "Nothing ranked yet",
                  description: "Score at least one project under this model and the ranking appears here.",
                }}
                aria-label="MCDA ranking"
              />
            )}
          </CardBody>
          {ranking.data ? (
            <CardBody className="border-t border-border">
              <ReasonList reasons={[...ranking.data.reasons, ...(run?.warnings ?? [])]} />
            </CardBody>
          ) : null}
        </Card>
      ) : null}

      <Drawer
        open={openRow !== null}
        onClose={() => setOpenRow(null)}
        size="md"
        title={openRow ? openRow.projectName : "Score"}
        description={
          openRow
            ? openRow.score === null
              ? "Not scored under this model"
              : `Score ${openRow.score.toFixed(1)} on ${pct(openRow.coverage * 100, 0)} of the model's weight`
            : undefined
        }
      >
        {openRow ? (
          <div className="space-y-4">
            <ReasonList reasons={openRow.reasons} />
            <div className="overflow-x-auto">
              <Table>
                <thead>
                  <tr>
                    <Th>Criterion</Th>
                    <Th align="right">Raw</Th>
                    <Th align="right">Normalised</Th>
                    <Th align="right">Weight share</Th>
                    <Th align="right">Contribution</Th>
                  </tr>
                </thead>
                <tbody>
                  {openRow.criteria.map((c) => (
                    <tr key={c.key}>
                      <Td>
                        <div className="font-medium text-content">{c.label}</div>
                        {c.rationale ? <div className="text-2xs text-content-subtle">{c.rationale}</div> : null}
                        {c.reason ? <div className="text-2xs text-warning-text">{c.reason}</div> : null}
                      </Td>
                      <Td align="right">{c.raw === null ? DASH : c.raw}</Td>
                      <Td align="right">{c.normalised === null ? DASH : c.normalised.toFixed(2)}</Td>
                      <Td align="right">{pct(c.weightShare * 100)}</Td>
                      <Td align="right">{c.contribution === null ? DASH : c.contribution.toFixed(1)}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </div>
          </div>
        ) : null}
      </Drawer>

      <ModelCreateDrawer
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(id) => {
          setCreating(false);
          setModelId(id);
          reloadAll();
        }}
      />
      {model ? (
        <ScoreDrawer
          open={scoring}
          model={model}
          onClose={() => setScoring(false)}
          onSaved={() => {
            setScoring(false);
            reloadAll();
          }}
        />
      ) : null}
      {action.error ? <Alert tone="danger" size="sm">{action.error}</Alert> : null}
    </div>
  );
}

/* =============================== Create =================================== */

interface DraftCriterion {
  key: string;
  label: string;
  weight: string;
  direction: "benefit" | "cost";
  min: string;
  max: string;
}

const BLANK: DraftCriterion = { key: "", label: "", weight: "10", direction: "benefit", min: "0", max: "10" };

function ModelCreateDrawer({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const action = useAction();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [normalisation, setNormalisation] = useState("fixed_scale");
  const [criteria, setCriteria] = useState<DraftCriterion[]>([
    { ...BLANK, key: "strategic_fit", label: "Strategic fit", weight: "40" },
    { ...BLANK, key: "deliverability", label: "Deliverability", weight: "30" },
    { ...BLANK, key: "whole_life_cost", label: "Whole-life cost", weight: "30", direction: "cost", max: "100" },
  ]);

  useEffect(() => {
    if (!open) return;
    action.clear();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function update(index: number, patch: Partial<DraftCriterion>) {
    setCriteria((list) => list.map((c, i) => (i === index ? { ...c, ...patch } : c)));
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    const body = {
      name,
      description: description || undefined,
      normalisation,
      criteria: criteria.map((c) => ({
        key: c.key.trim(),
        label: c.label.trim() || c.key.trim(),
        weight: Number(c.weight) || 0,
        direction: c.direction,
        min: Number(c.min) || 0,
        max: Number(c.max) || 10,
      })),
    };
    const res = await action.run("create", () => portfolioApi.createModel(body));
    if (res) {
      toast.success("Scoring model created");
      onCreated(res.id);
    }
  }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      size="lg"
      title="New scoring model"
      description="A cost criterion is inverted during normalisation, so enter whole-life cost as the cost it is rather than remembering to score it backwards."
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="portfolio-model-create" loading={action.busy === "create"}>
            Create
          </Button>
        </div>
      }
    >
      <form id="portfolio-model-create" onSubmit={submit} className="space-y-4">
        {action.error ? (
          <Alert tone="danger" size="sm">
            {action.error}
          </Alert>
        ) : null}
        <Field label="Name" required>
          <Input value={name} onChange={(e) => setName(e.target.value)} required />
        </Field>
        <Field label="Description">
          <Textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <Field
          label="Normalisation"
          hint="Relative normalisation compares candidates against each other, and is honest about the fact that its ranks move when the candidate set does."
        >
          <Select value={normalisation} onChange={(e) => setNormalisation(e.target.value)}>
            <option value="fixed_scale">Fixed scale (each criterion's declared min/max)</option>
            <option value="relative">Relative (the spread actually observed)</option>
          </Select>
        </Field>

        <div>
          <div className="mb-2 flex items-center justify-between">
            <span className="text-2xs font-semibold uppercase tracking-wide text-content-subtle">Criteria</span>
            <Button size="xs" variant="ghost" onClick={() => setCriteria((l) => [...l, { ...BLANK }])}>
              Add criterion
            </Button>
          </div>
          <div className="space-y-2">
            {criteria.map((c, i) => (
              <div key={i} className="grid gap-2 rounded-md border border-border p-2 sm:grid-cols-6">
                <Field label="Key" className="sm:col-span-1">
                  <Input value={c.key} onChange={(e) => update(i, { key: e.target.value })} size="sm" required />
                </Field>
                <Field label="Label" className="sm:col-span-2">
                  <Input value={c.label} onChange={(e) => update(i, { label: e.target.value })} size="sm" />
                </Field>
                <Field label="Weight">
                  <Input
                    type="number"
                    value={c.weight}
                    onChange={(e) => update(i, { weight: e.target.value })}
                    size="sm"
                    min={0}
                  />
                </Field>
                <Field label="Direction">
                  <Select
                    value={c.direction}
                    onChange={(e) => update(i, { direction: e.target.value as "benefit" | "cost" })}
                    size="sm"
                  >
                    <option value="benefit">Benefit</option>
                    <option value="cost">Cost</option>
                  </Select>
                </Field>
                <div className="grid grid-cols-2 gap-1">
                  <Field label="Min">
                    <Input type="number" value={c.min} onChange={(e) => update(i, { min: e.target.value })} size="sm" />
                  </Field>
                  <Field label="Max">
                    <Input type="number" value={c.max} onChange={(e) => update(i, { max: e.target.value })} size="sm" />
                  </Field>
                </div>
              </div>
            ))}
          </div>
        </div>
      </form>
    </Drawer>
  );
}

function ScoreDrawer({
  open,
  model,
  onClose,
  onSaved,
}: {
  open: boolean;
  model: ScoringModel;
  onClose: () => void;
  onSaved: () => void;
}) {
  const action = useAction();
  const projects = useProjects();
  const [projectId, setProjectId] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});
  const [rationale, setRationale] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!open) return;
    setProjectId("");
    setValues({});
    setRationale({});
    action.clear();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!projectId) return;
    const existing = model.scores?.find((s) => s.projectId === projectId);
    setValues(
      existing
        ? Object.fromEntries(Object.entries(existing.scores).map(([k, v]) => [k, String(v)]))
        : {},
    );
    setRationale(existing?.rationale ?? {});
  }, [projectId, model.scores]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const scores: Record<string, number> = {};
    for (const c of model.criteria) {
      const raw = values[c.key];
      if (raw === undefined || raw.trim() === "") continue;
      const n = Number(raw);
      if (Number.isFinite(n)) scores[c.key] = n;
    }
    const res = await action.run("score", () =>
      portfolioApi.putScores(model.id, projectId, { scores, rationale }),
    );
    if (res !== null) {
      toast.success("Scores saved; the ranking is recomputed on read");
      onSaved();
    }
  }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      size="md"
      title="Score a project"
      description="Leave a criterion blank rather than guessing. An unscored criterion lowers the project's coverage and is named on the ranking; a guessed one silently moves the decision."
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="portfolio-score" loading={action.busy === "score"} disabled={!projectId}>
            Save scores
          </Button>
        </div>
      }
    >
      <form id="portfolio-score" onSubmit={submit} className="space-y-4">
        {action.error ? (
          <Alert tone="danger" size="sm">
            {action.error}
          </Alert>
        ) : null}
        <Field label="Project" required>
          <Select value={projectId} onChange={(e) => setProjectId(e.target.value)} required>
            <option value="">Choose a project</option>
            {(projects.data?.items ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </Field>
        {model.criteria.map((c) => (
          <div key={c.key} className="rounded-md border border-border p-2">
            <div className="mb-1 flex items-center justify-between gap-2">
              <span className="text-meta font-medium text-content">{c.label}</span>
              <Badge tone={c.direction === "cost" ? "warning" : "info"} size="xs">
                {c.direction === "cost" ? "lower is better" : "higher is better"}
              </Badge>
            </div>
            <div className="grid gap-2 sm:grid-cols-3">
              <Field label={`Score (${c.min}–${c.max})`}>
                <Input
                  type="number"
                  value={values[c.key] ?? ""}
                  onChange={(e) => setValues((v) => ({ ...v, [c.key]: e.target.value }))}
                  size="sm"
                  min={c.min}
                  max={c.max}
                />
              </Field>
              <Field label="Why this score" className="sm:col-span-2">
                <Input
                  value={rationale[c.key] ?? ""}
                  onChange={(e) => setRationale((r) => ({ ...r, [c.key]: e.target.value }))}
                  size="sm"
                />
              </Field>
            </div>
          </div>
        ))}
        <Row label="Model version">v{model.version}</Row>
      </form>
    </Drawer>
  );
}
