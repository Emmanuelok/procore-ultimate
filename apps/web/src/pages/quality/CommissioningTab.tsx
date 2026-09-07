/**
 * COMMISSIONING — the systems, as a hierarchy.
 *
 * "HVAC-L3-AHU01" hangs under "HVAC — Level 3" under "HVAC", so the register
 * is a tree rather than a list: a turnover package is assembled at whichever
 * level of that tree the owner accepts, and a flat list makes that decision
 * impossible to see.
 *
 * The ladder in the status column is a GATE, not a label. Nothing is
 * functionally tested before its pre-functional checks are complete, because a
 * functional test of a system that was never statically checked proves only
 * that it ran once. Where a system is not ready, this screen says WHY, using
 * the API's own `/readiness` blockers.
 */
import { useMemo, useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  DataTable,
  Field,
  Input,
  Modal,
  Select,
  Skeleton,
  Textarea,
  type DataColumns,
} from "../../ui";
import { IconPlus } from "../../ui/icons";
import { api } from "../../lib/api";
import {
  CX_LADDER,
  CX_STATUS_TONE,
  LoadError,
  NothingHere,
  RefusalNotice,
  TEST_RESULT_TONE,
  TEST_STATUS_TONE,
  isoDate,
  labelize,
  plural,
  useAction,
  useResource,
  type Resource,
} from "./qualityShared";
import type { CxSystem, CxTest, Paged } from "./types";

const CX_STATUSES = [...CX_LADDER, "on_hold"];
const CX_LEVELS = ["system", "subsystem", "equipment"];

export interface CxFilters {
  status: string;
  level: string;
  discipline: string;
  search: string;
}

export const EMPTY_CX_FILTERS: CxFilters = { status: "", level: "", discipline: "", search: "" };

interface TreeRow extends CxSystem {
  children?: TreeRow[];
}

/** Flat rows → a forest by parentId. Orphans stay at the root rather than
 *  vanishing: a system whose parent is filtered out still exists. */
function buildForest(rows: readonly CxSystem[]): TreeRow[] {
  const byId = new Map<string, TreeRow>(rows.map((r) => [r.id, { ...r, children: [] }]));
  const roots: TreeRow[] = [];
  for (const row of rows) {
    const node = byId.get(row.id)!;
    const parent = row.parentId ? byId.get(row.parentId) : undefined;
    if (parent) parent.children!.push(node);
    else roots.push(node);
  }
  const prune = (nodes: TreeRow[]): TreeRow[] =>
    nodes.map((n) => {
      const kids = prune(n.children ?? []);
      if (kids.length === 0) {
        const { children: _drop, ...rest } = n;
        return rest as TreeRow;
      }
      return { ...n, children: kids };
    });
  return prune(roots);
}

export default function CommissioningTab({
  systems,
  filters,
  onFilters,
  projectId,
  onOpen,
  onMutated,
}: {
  systems: Resource<Paged<CxSystem>>;
  filters: CxFilters;
  onFilters: (next: CxFilters) => void;
  projectId: string;
  onOpen: (systemId: string) => void;
  onMutated: () => void;
}) {
  const [createOpen, setCreateOpen] = useState(false);
  const [systemCode, setSystemCode] = useState("");
  const [name, setName] = useState("");
  const [level, setLevel] = useState("system");
  const [parentId, setParentId] = useState("");
  const [discipline, setDiscipline] = useState("");
  const [description, setDescription] = useState("");
  const { busy, refusal, clear, run } = useAction();

  const rows = systems.data?.items ?? [];
  const forest = useMemo(() => buildForest(rows), [rows]);
  const withoutAsset = rows.filter((s) => !s.assetId);
  const onHold = rows.filter((s) => s.status === "on_hold");
  const deficiencies = rows.reduce((n, s) => n + s.openDeficiencyCount, 0);

  const columns = useMemo<DataColumns<TreeRow>>(
    () => [
      {
        id: "systemCode",
        header: "System",
        accessor: "systemCode",
        type: "text",
        sticky: "start",
        width: 260,
        mono: true,
        cell: ({ row }) => (
          <div className="min-w-0 py-0.5">
            <span className="block truncate font-mono text-2xs text-content-subtle">
              {row.systemCode}
            </span>
            <span className="block truncate font-medium">{row.name}</span>
          </div>
        ),
      },
      {
        id: "level",
        header: "Level",
        accessor: "level",
        type: "enum",
        width: 110,
        groupable: true,
        options: CX_LEVELS.map((l) => ({ value: l, text: labelize(l), label: labelize(l) })),
        cell: ({ row }) => (
          <Badge tone="neutral" size="xs" variant="outline">
            {labelize(row.level)}
          </Badge>
        ),
      },
      {
        id: "discipline",
        header: "Discipline",
        accessor: (row) => row.discipline ?? "",
        type: "enum",
        width: 130,
        groupable: true,
        cell: ({ row }) =>
          row.discipline ? labelize(row.discipline) : <span className="text-content-subtle">—</span>,
      },
      {
        id: "status",
        header: "Ladder position",
        headerTooltip:
          "Forward-only. A system does not become less commissioned; if work has stopped it goes on hold.",
        accessor: "status",
        type: "status",
        width: 200,
        groupable: true,
        options: CX_STATUSES.map((s) => ({
          value: s,
          text: labelize(s),
          label: labelize(s),
          tone: CX_STATUS_TONE[s] ?? "neutral",
        })),
        cell: ({ row }) => (
          <div className="min-w-0 py-0.5">
            <Badge tone={CX_STATUS_TONE[row.status] ?? "neutral"} size="xs" dot>
              {labelize(row.status)}
            </Badge>
            {row.status !== "on_hold" ? (
              <span className="mt-0.5 block text-2xs text-content-subtle">
                rung {CX_LADDER.indexOf(row.status) + 1} of {CX_LADDER.length}
              </span>
            ) : null}
          </div>
        ),
      },
      {
        id: "percentComplete",
        header: "Complete",
        accessor: "percentComplete",
        type: "percent",
        width: 130,
        progress: true,
      },
      {
        id: "prefunctional",
        header: "Pre-functional",
        accessor: "prefunctionalTestCount",
        type: "number",
        width: 130,
        align: "right",
        aggregate: "sum",
        cell: ({ row }) =>
          row.prefunctionalTestCount === 0 ? (
            <span className="text-2xs italic text-content-subtle">none</span>
          ) : (
            <span className="tabular-nums">{row.prefunctionalTestCount}</span>
          ),
      },
      {
        id: "functional",
        header: "Functional",
        accessor: "functionalTestCount",
        type: "number",
        width: 110,
        align: "right",
        aggregate: "sum",
      },
      {
        id: "deficiencies",
        header: "Open deficiencies",
        accessor: "openDeficiencyCount",
        type: "number",
        width: 150,
        align: "right",
        aggregate: "sum",
        cell: ({ row }) =>
          row.openDeficiencyCount === 0 ? (
            <span className="text-content-subtle">—</span>
          ) : (
            <Badge tone="warning" size="xs">
              {row.openDeficiencyCount}
            </Badge>
          ),
      },
      {
        id: "asset",
        header: "Twin asset",
        headerTooltip:
          "Commissioning hands over INTO the twin's asset register. A system with no asset has nothing to hand over into.",
        accessor: (row) => row.assetId ?? "",
        type: "text",
        width: 150,
        cell: ({ row }) =>
          row.assetId ? (
            <span className="font-mono text-2xs">{row.assetId}</span>
          ) : (
            <span className="text-2xs italic text-warning-fg">not bound</span>
          ),
      },
      {
        id: "planned",
        header: "Planned completion",
        accessor: (row) => row.plannedCompletionDate ?? "",
        type: "date",
        width: 150,
        cell: ({ row }) =>
          row.plannedCompletionDate ? (
            <span className="tabular-nums">{isoDate(row.plannedCompletionDate)}</span>
          ) : (
            <span className="text-content-subtle">no date</span>
          ),
      },
    ],
    [],
  );

  async function create() {
    const created = await run("create", () =>
      api.post<CxSystem>(`/api/v1/projects/${projectId}/commissioning/systems`, {
        systemCode: systemCode.trim(),
        name: name.trim(),
        level,
        parentId: parentId === "" ? null : parentId,
        discipline: discipline.trim() === "" ? null : discipline.trim(),
        description: description.trim() === "" ? null : description.trim(),
      }),
    );
    if (created) {
      setCreateOpen(false);
      setSystemCode("");
      setName("");
      setDescription("");
      onMutated();
      onOpen(created.id);
    }
  }

  if (systems.error) {
    return (
      <LoadError
        message={systems.error}
        onRetry={systems.reload}
        title="The commissioning register could not be loaded"
      />
    );
  }

  return (
    <div className="space-y-4">
      {withoutAsset.length > 0 && rows.length > 0 ? (
        <Alert
          tone="warning"
          title={`${withoutAsset.length} ${plural(withoutAsset.length, "system")} ${plural(withoutAsset.length, "is", "are")} not bound to a twin asset`}
        >
          {withoutAsset
            .slice(0, 12)
            .map((s) => s.systemCode)
            .join(", ")}
          {withoutAsset.length > 12 ? `, and ${withoutAsset.length - 12} more` : ""}. Commissioning
          hands over INTO the twin&apos;s asset register rather than keeping a second one — a system
          with no asset behind it has nothing to hand over into when the owner accepts it.
        </Alert>
      ) : null}

      {onHold.length > 0 ? (
        <Alert tone="danger" title={`${onHold.length} ${plural(onHold.length, "system")} on hold`}>
          {onHold.map((s) => `${s.systemCode} (${s.name})`).join(", ")}
        </Alert>
      ) : null}

      <Card>
        <CardBody className="grid gap-3 md:grid-cols-4">
          <Field label="Ladder position">
            <Select
              value={filters.status}
              onChange={(e) => onFilters({ ...filters, status: e.target.value })}
            >
              <option value="">Every position</option>
              {CX_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {labelize(s)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Level">
            <Select
              value={filters.level}
              onChange={(e) => onFilters({ ...filters, level: e.target.value })}
            >
              <option value="">Every level</option>
              {CX_LEVELS.map((l) => (
                <option key={l} value={l}>
                  {labelize(l)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Discipline">
            <Input
              value={filters.discipline}
              onChange={(e) => onFilters({ ...filters, discipline: e.target.value })}
              placeholder="e.g. mechanical"
            />
          </Field>
          <Field label="Search names">
            <Input
              value={filters.search}
              onChange={(e) => onFilters({ ...filters, search: e.target.value })}
            />
          </Field>
        </CardBody>
      </Card>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-meta text-content-muted">
          {systems.data
            ? `${systems.data.total} ${plural(systems.data.total, "system")} · ${deficiencies} open ${plural(deficiencies, "deficiency", "deficiencies")}`
            : "Loading the register…"}
        </p>
        <Button size="sm" icon={IconPlus} onClick={() => setCreateOpen(true)}>
          Add a system
        </Button>
      </div>

      {filters.status || filters.level || filters.discipline || filters.search ? (
        <p className="text-2xs text-content-subtle">
          Filters are applied on the server, so a child whose parent does not match is shown at the
          root rather than hidden. The hierarchy you see is the filtered set, not the whole tree.
        </p>
      ) : null}

      {systems.loading && rows.length === 0 ? (
        <Skeleton height={420} />
      ) : rows.length === 0 ? (
        <NothingHere
          title="No commissionable system is registered on this project"
          reason={
            filters.status || filters.level || filters.discipline || filters.search
              ? "Nothing matches the filters above. Clear them to see the whole tree."
              : "Nothing has been declared commissionable, so there is nothing to test, nothing to witness and nothing to hand over. A turnover package assembled now would name no systems."
          }
          action={
            <Button size="sm" icon={IconPlus} onClick={() => setCreateOpen(true)}>
              Register the first system
            </Button>
          }
        />
      ) : (
        <DataTable<TreeRow>
          tableId="quality-commissioning"
          data={forest}
          columns={columns}
          getRowId={(row) => row.id}
          getSubRows={(row) => row.children}
          treeColumnId="systemCode"
          defaultExpanded
          height={560}
          stickyHeader
          showFooter
          zebra
          filterRow
          exportFileName="commissioning-systems"
          searchPlaceholder="Search systems"
          aria-label="Commissioning systems"
          rowTone={(row) =>
            row.status === "on_hold"
              ? "danger"
              : row.openDeficiencyCount > 0
                ? "warning"
                : row.status === "accepted" || row.status === "turned_over"
                  ? "success"
                  : undefined
          }
          onRowClick={({ row }) => onOpen(row.id)}
        />
      )}

      {rows.length > 0 ? (
        <TestRegister projectId={projectId} version={systems.data?.total ?? 0} onOpen={onOpen} />
      ) : null}

      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="Register a commissionable system"
        description="Systems decompose. The level says how far down the tree this row sits, so a turnover package can later be assembled at the right granularity."
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={busy === "create"}
              disabled={systemCode.trim().length === 0 || name.trim().length === 0}
              onClick={create}
            >
              Register it
            </Button>
          </div>
        }
      >
        <div className="space-y-3">
          <RefusalNotice refusal={refusal} onDismiss={clear} />
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="System code" required hint="The site-facing code, e.g. HVAC-L3-AHU01.">
              <Input
                value={systemCode}
                onChange={(e) => setSystemCode(e.target.value)}
                autoFocus
              />
            </Field>
            <Field label="Name" required>
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Level">
              <Select value={level} onChange={(e) => setLevel(e.target.value)}>
                {CX_LEVELS.map((l) => (
                  <option key={l} value={l}>
                    {labelize(l)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Sits under">
              <Select value={parentId} onChange={(e) => setParentId(e.target.value)}>
                <option value="">Nothing — a root system</option>
                {rows.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.systemCode} · {s.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Field label="Discipline">
            <Input value={discipline} onChange={(e) => setDiscipline(e.target.value)} />
          </Field>
          <Field label="Description">
            <Textarea
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>
        </div>
      </Modal>
    </div>
  );
}

/**
 * EVERY TEST ON THE PROJECT, ACROSS THE SYSTEMS.
 *
 * The system drawer answers "is this system proven?". This answers the other
 * question a commissioning manager asks every morning: "what is outstanding
 * anywhere?" — the pre-functional records nobody has performed, the functional
 * tests that failed, the passes waiting for an owner's acceptance. Without it
 * the list endpoint existed and the only way to see a project's tests was to
 * open the systems one at a time.
 *
 * A failed test is drawn as a failure and an unperformed one as unperformed;
 * neither is rolled into a percentage, because the useful unit here is the
 * named record somebody has to go and do.
 */
function TestRegister({
  projectId,
  version,
  onOpen,
}: {
  projectId: string;
  version: number;
  onOpen: (systemId: string) => void;
}) {
  const [phase, setPhase] = useState("");
  const [status, setStatus] = useState("");
  const [result, setResult] = useState("");
  const query = [
    "page=1",
    "pageSize=200",
    phase === "" ? "" : `phase=${phase}`,
    status === "" ? "" : `status=${status}`,
    result === "" ? "" : `result=${result}`,
  ]
    .filter((p) => p !== "")
    .join("&");
  const url = `/api/v1/projects/${projectId}/commissioning/test-records?${query}`;
  const tests = useResource<Paged<CxTest>>(
    (signal) => api.get<Paged<CxTest>>(url, { signal }),
    [url, version],
  );
  const rows = tests.data?.items ?? [];

  return (
    <section className="space-y-2 rounded-md border border-border-subtle p-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h3 className="text-label uppercase tracking-wide text-content-subtle">
            Tests across every system
          </h3>
          <p className="text-2xs text-content-subtle">
            {tests.data
              ? `${tests.data.total} ${plural(tests.data.total, "record")}${tests.data.total > rows.length ? ` · showing the first ${rows.length}` : ""}`
              : "Loading the test register…"}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Field label="Phase">
            <Select value={phase} onChange={(e) => setPhase(e.target.value)}>
              <option value="">Both phases</option>
              <option value="prefunctional">Pre-functional</option>
              <option value="functional">Functional</option>
              <option value="unclassified">Unclassified</option>
            </Select>
          </Field>
          <Field label="Status">
            <Select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">Every status</option>
              {["scheduled", "in_progress", "complete", "retest_required", "accepted", "void"].map(
                (s) => (
                  <option key={s} value={s}>
                    {labelize(s)}
                  </option>
                ),
              )}
            </Select>
          </Field>
          <Field label="Result">
            <Select value={result} onChange={(e) => setResult(e.target.value)}>
              <option value="">Any result</option>
              {["pass", "pass_with_deficiencies", "fail", "aborted"].map((r) => (
                <option key={r} value={r}>
                  {labelize(r)}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </div>

      {tests.error ? (
        <LoadError
          message={tests.error}
          onRetry={tests.reload}
          title="The test register could not be loaded"
        />
      ) : rows.length === 0 ? (
        <p className="text-meta text-content-muted">
          {phase || status || result
            ? "No test matches these filters. That is a statement about the filters, not about the systems."
            : "No test record exists on any system yet, so nothing on this project has been proved to work — only registered as something that will have to be."}
        </p>
      ) : (
        <ul className="space-y-1">
          {rows.map((t) => (
            <li
              key={t.id}
              className="flex flex-wrap items-center gap-1.5 rounded border border-border-subtle px-2 py-1 text-meta"
            >
              <span className="font-mono text-2xs">{t.reference}</span>
              <Badge tone="neutral" size="xs" variant="outline">
                {labelize(t.testKind)}
              </Badge>
              <span className="min-w-0 flex-1 truncate">{t.title}</span>
              <Badge tone={TEST_STATUS_TONE[t.status] ?? "neutral"} size="xs" dot>
                {labelize(t.status)}
              </Badge>
              {t.result ? (
                <Badge tone={TEST_RESULT_TONE[t.result] ?? "neutral"} size="xs" variant="solid">
                  {labelize(t.result)}
                </Badge>
              ) : (
                <span className="text-2xs italic text-content-subtle">not performed</span>
              )}
              {t.witnessedAt === null && t.result !== null ? (
                <span className="text-2xs text-warning-fg">no witness</span>
              ) : null}
              <span className="text-2xs text-content-subtle">
                {t.scheduledFor ? isoDate(t.scheduledFor) : "no date"}
              </span>
              <Button size="xs" variant="ghost" onClick={() => onOpen(t.systemId)}>
                Open the system
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
