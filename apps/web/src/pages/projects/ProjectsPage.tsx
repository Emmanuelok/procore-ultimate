/**
 * PORTFOLIO — /projects
 *
 * Every project in the company, on the new DataTable: multi-sort, a per-column
 * filter row, a composable filter builder, a column picker, CSV export and
 * saved views, plus a card view for the days you want to look at projects
 * rather than read them.
 *
 * ---------------------------------------------------------------------------
 * TWO RULES THIS PAGE OBEYS
 *
 *  1. MONEY IS NEVER SUMMED ACROSS CURRENCIES. The aggregate rail is one card
 *     per currency. There is no grand total and there is no column footer on
 *     the value column, because a project list holding USD and AED rows has no
 *     honest total — there is no rate on the record.
 *
 *  2. A PROJECT WITH NO RECORDED VALUE IS NOT A ZERO. Those projects are
 *     counted separately and named in the aggregate card, so the total below is
 *     understood as "the value we hold", not "the value of the portfolio".
 */
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { PROJECT_STAGES } from "@constructos/shared";
import { ApiClientError, api } from "../../lib/api";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  Checkbox,
  DataTable,
  Drawer,
  EmptyState,
  ErrorAlert,
  PageHeader,
  Progress,
  SearchInput,
  SegmentedControl,
  Select,
  Skeleton,
  toast,
  type DataColumns,
  type DataOption,
  type DataView,
} from "../../ui";
import {
  IconGridView,
  IconLocation,
  IconPlus,
  IconProject,
  IconTableView,
} from "../../ui/icons";
import { cx } from "../../ui/cx";
import { toneClass } from "../../ui/tokens";
import {
  DASH,
  count as formatCount,
  daysBetween,
  isoDate,
  money,
  stageLabel,
  stageTone,
  todayIso,
  useResource,
  type Paginated,
  type ProjectRecord,
} from "../../layouts/project/lib";
import {
  EMPTY_PROJECT_FORM,
  ProjectFormFields,
  buildProjectPayload,
  validateProjectForm,
  type ProjectFormValues,
} from "../../layouts/project/ProjectForm";

const PAGE_SIZE = 200;
/** Five requests of 200. Past this the list is truncated and says so. */
const MAX_PAGES = 5;

interface PortfolioRow {
  id: string;
  name: string;
  programme: string | null;
}

/* ========================================================================== */
/* Loading                                                                    */
/* ========================================================================== */

interface AllProjects {
  items: ProjectRecord[];
  total: number;
  truncated: boolean;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

/**
 * The whole list, so sorting, filtering and grouping happen in the grid rather
 * than as a round trip per keystroke. Paged in 200s and capped, with the cap
 * surfaced rather than silently swallowing rows.
 */
function useAllProjects(): AllProjects {
  const [items, setItems] = useState<ProjectRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;

    async function run() {
      setLoading(true);
      setError(null);
      try {
        const collected: ProjectRecord[] = [];
        let page = 1;
        let serverTotal = 0;
        for (; page <= MAX_PAGES; page += 1) {
          const params = new URLSearchParams({
            page: String(page),
            pageSize: String(PAGE_SIZE),
          });
          const res = await api.get<Paginated<ProjectRecord>>(`/api/v1/projects?${params}`, {
            signal: controller.signal,
          });
          serverTotal = res.total;
          collected.push(...res.items);
          if (collected.length >= res.total || res.items.length === 0) break;
        }
        if (cancelled) return;
        setItems(collected);
        setTotal(serverTotal);
        setTruncated(collected.length < serverTotal);
      } catch (err) {
        if (cancelled || controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : "The project list could not be read.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void run();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [nonce]);

  return {
    items,
    total,
    truncated,
    loading,
    error,
    reload: useCallback(() => setNonce((n) => n + 1), []),
  };
}

/* ========================================================================== */
/* Page                                                                       */
/* ========================================================================== */

type ViewMode = "table" | "cards";

const STAGE_OPTIONS: DataOption[] = PROJECT_STAGES.map((stage) => ({
  value: stage,
  text: stageLabel(stage),
  label: stageLabel(stage),
  tone: stageTone(stage),
}));

const BUILT_IN_VIEWS: DataView[] = [
  {
    id: "builtin-all",
    name: "All projects",
    builtIn: true,
    state: { columnFilters: [], sorting: [{ id: "name", desc: false }] },
  },
  {
    id: "builtin-live",
    name: "In construction",
    builtIn: true,
    state: {
      columnFilters: [{ id: "stage", value: ["course_of_construction"] }],
      sorting: [{ id: "finishDate", desc: false }],
    },
  },
  {
    id: "builtin-preconstruction",
    name: "Pre-construction & bidding",
    builtIn: true,
    state: {
      columnFilters: [{ id: "stage", value: ["bidding", "pre_construction"] }],
      sorting: [{ id: "startDate", desc: false }],
    },
  },
  {
    id: "builtin-closing",
    name: "Warranty & closed",
    builtIn: true,
    state: {
      columnFilters: [{ id: "stage", value: ["warranty", "closed"] }],
      sorting: [{ id: "finishDate", desc: true }],
    },
  },
];

export default function ProjectsPage() {
  const projects = useAllProjects();
  const portfolios = useResource<Paginated<PortfolioRow>>(
    "/api/v1/portfolios?page=1&pageSize=200",
  );

  const [view, setView] = useState<ViewMode>("table");
  const [createOpen, setCreateOpen] = useState(false);

  const portfolioName = useMemo(() => {
    const map = new Map<string, string>();
    for (const row of portfolios.data?.items ?? []) map.set(row.id, row.name);
    return map;
  }, [portfolios.data]);

  const columns: DataColumns<ProjectRecord> = useMemo(
    () => [
      {
        id: "name",
        header: "Project",
        accessor: "name",
        type: "text",
        sticky: "start",
        width: 260,
        searchable: true,
        cell: ({ row, value }) => (
          <span className="flex min-w-0 flex-col leading-tight">
            <span className="truncate font-medium text-content">{String(value ?? DASH)}</span>
            {row.number ? (
              <span className="truncate font-mono text-2xs text-content-subtle">{row.number}</span>
            ) : null}
          </span>
        ),
      },
      {
        id: "stage",
        header: "Stage",
        accessor: "stage",
        type: "status",
        width: 160,
        groupable: true,
        options: STAGE_OPTIONS,
        filter: { kind: "enum", options: STAGE_OPTIONS },
        cell: ({ value }) => (
          <Badge tone={stageTone(String(value))} size="xs" dot variant="subtle">
            {stageLabel(String(value))}
          </Badge>
        ),
      },
      {
        id: "portfolio",
        header: "Portfolio",
        accessor: (row) => (row.portfolioId ? (portfolioName.get(row.portfolioId) ?? "Unknown") : ""),
        type: "enum",
        width: 150,
        groupable: true,
        emptyText: "Unassigned",
      },
      {
        id: "location",
        header: "Location",
        accessor: (row) => [row.city, row.country].filter(Boolean).join(", "),
        type: "text",
        width: 180,
        searchable: true,
      },
      {
        id: "startDate",
        header: "Start",
        accessor: "startDate",
        type: "date",
        width: 120,
      },
      {
        id: "finishDate",
        header: "Finish",
        accessor: "finishDate",
        type: "date",
        width: 120,
      },
      {
        id: "daysRemaining",
        header: "Days left",
        headerTooltip:
          "Days from today to the recorded finish date. Blank when no finish date is recorded — that is unknown, not zero.",
        accessor: (row) => daysBetween(todayIso(), row.finishDate),
        type: "number",
        width: 110,
        align: "right",
        aggregate: "none",
        cell: ({ value }) => {
          if (typeof value !== "number") return <span className="text-content-disabled">{DASH}</span>;
          return (
            <span className={cx("tabular-nums", value < 0 && toneClass("danger", "text"))}>
              {value < 0 ? `${formatCount(Math.abs(value))} late` : formatCount(value)}
            </span>
          );
        },
      },
      {
        id: "currency",
        header: "Currency",
        accessor: "currency",
        type: "enum",
        width: 100,
        groupable: true,
      },
      {
        id: "value",
        header: "Value",
        headerTooltip:
          "The value recorded on the project record, in that project's own currency. There is deliberately no column total: these rows are in different currencies.",
        accessor: "value",
        // Deliberately `number`, not `currency`: the DataTable's currency type
        // takes ONE ISO code for the whole column, and these rows carry their
        // own. Rendering them all as USD would misstate every non-USD project.
        type: "number",
        width: 150,
        align: "right",
        aggregate: "none",
        sortDescFirst: true,
        cell: ({ row, value }) =>
          value === null || value === undefined ? (
            <span className="text-content-disabled" title="No value recorded on this project">
              {DASH}
            </span>
          ) : (
            <span className="tabular-nums">{money(Number(value), row.currency)}</span>
          ),
        toCsv: ({ value }) => (typeof value === "number" ? value : null),
      },
      {
        id: "type",
        header: "Type",
        accessor: "type",
        type: "text",
        width: 150,
        defaultHidden: true,
      },
      {
        id: "department",
        header: "Department",
        accessor: "department",
        type: "text",
        width: 150,
        groupable: true,
        defaultHidden: true,
      },
      {
        id: "updatedAt",
        header: "Updated",
        accessor: "updatedAt",
        type: "datetime",
        width: 160,
        defaultHidden: true,
      },
    ],
    [portfolioName],
  );

  return (
    <div className="space-y-4">
      <PageHeader
        title="Projects"
        icon={IconProject}
        subtitle={
          projects.loading
            ? "Reading the portfolio…"
            : `${formatCount(projects.total)} project${projects.total === 1 ? "" : "s"} in this company`
        }
        actions={
          <>
            <SegmentedControl
              size="sm"
              aria-label="View mode"
              value={view}
              onChange={setView}
              options={[
                { value: "table", label: "Table", icon: IconTableView },
                { value: "cards", label: "Cards", icon: IconGridView },
              ]}
            />
            <Button leadingIcon={IconPlus} onClick={() => setCreateOpen(true)}>
              New project
            </Button>
          </>
        }
      />

      <ErrorAlert message={projects.error} onRetry={projects.reload} />

      {projects.truncated ? (
        <Alert tone="warning" size="sm" title="This list is truncated">
          The company holds {formatCount(projects.total)} projects and this page loaded the first{" "}
          {formatCount(projects.items.length)}. The aggregates and the grid below describe the
          loaded rows only.
        </Alert>
      ) : null}

      <PortfolioAggregates projects={projects.items} loading={projects.loading} />

      {view === "table" ? (
        <DataTable<ProjectRecord>
          tableId="projects"
          data={projects.items}
          columns={columns}
          getRowId={(row) => row.id}
          loading={projects.loading}
          error={projects.error}
          onRetry={projects.reload}
          height={560}
          stickyHeader
          filterRow
          zebra={false}
          gridLines
          defaultSort={[{ id: "name", desc: false }]}
          builtInViews={BUILT_IN_VIEWS}
          searchPlaceholder="Search projects by name, number or location…"
          exportFileName="projects"
          rowHref={(row) => `/projects/${row.id}`}
          rowLabel={(row) => `Open ${row.name}`}
          aria-label="Projects"
          empty={{
            icon: IconProject,
            title: "No projects yet",
            description:
              "A project is the container for every drawing, RFI, commitment and invoice on a job. Create the first one to start.",
            action: (
              <Button leadingIcon={IconPlus} onClick={() => setCreateOpen(true)}>
                Create your first project
              </Button>
            ),
          }}
          emptyFiltered={{
            icon: IconProject,
            title: "No project matches these filters",
            description:
              "Clear the filter row, or switch to a different saved view from the toolbar.",
          }}
        />
      ) : (
        <ProjectCards
          projects={projects.items}
          loading={projects.loading}
          onCreate={() => setCreateOpen(true)}
        />
      )}

      <CreateProjectDrawer
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={projects.reload}
      />
    </div>
  );
}

/* ========================================================================== */
/* Aggregates                                                                 */
/* ========================================================================== */

interface CurrencyBucket {
  currency: string;
  projects: number;
  withValue: number;
  withoutValue: number;
  total: number;
}

function PortfolioAggregates({
  projects,
  loading,
}: {
  projects: ProjectRecord[];
  loading: boolean;
}) {
  const buckets = useMemo<CurrencyBucket[]>(() => {
    const map = new Map<string, CurrencyBucket>();
    for (const project of projects) {
      const code = (project.currency || "USD").toUpperCase();
      let bucket = map.get(code);
      if (!bucket) {
        bucket = { currency: code, projects: 0, withValue: 0, withoutValue: 0, total: 0 };
        map.set(code, bucket);
      }
      bucket.projects += 1;
      if (project.value === null || project.value === undefined) {
        bucket.withoutValue += 1;
      } else {
        bucket.withValue += 1;
        bucket.total += project.value;
      }
    }
    return [...map.values()].sort((a, b) => b.total - a.total || a.currency.localeCompare(b.currency));
  }, [projects]);

  const stageCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const project of projects) {
      map.set(project.stage, (map.get(project.stage) ?? 0) + 1);
    }
    return PROJECT_STAGES.map((stage) => ({ stage, n: map.get(stage) ?? 0 })).filter(
      (entry) => entry.n > 0,
    );
  }, [projects]);

  if (loading) {
    return (
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 3 }).map((_, index) => (
          <Card key={index}>
            <CardBody className="space-y-2">
              <Skeleton height={10} width="40%" radius="sm" />
              <Skeleton height={24} width="70%" radius="md" />
              <Skeleton height={10} width="55%" radius="sm" />
            </CardBody>
          </Card>
        ))}
      </div>
    );
  }

  if (projects.length === 0) return null;

  return (
    <div className="space-y-3">
      {buckets.length > 1 ? (
        <Alert tone="info" size="sm" title={`This portfolio holds ${buckets.length} currencies`}>
          One card per currency, and no grand total. {buckets.map((b) => b.currency).join(", ")}{" "}
          cannot be added together — there is no exchange rate on these records, and inventing one
          would make the headline number a fabrication.
        </Alert>
      ) : null}

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {buckets.map((bucket) => (
          <Card key={bucket.currency}>
            <CardBody className="space-y-1">
              <div className="flex items-center justify-between">
                <span className="text-label uppercase text-content-subtle">
                  Recorded value · {bucket.currency}
                </span>
                <Badge tone="neutral" size="xs">
                  {bucket.projects} project{bucket.projects === 1 ? "" : "s"}
                </Badge>
              </div>
              <div className="text-display-xs font-semibold tabular-nums tracking-[-0.02em] text-content">
                {bucket.withValue === 0 ? (
                  <span className="text-sm font-normal italic text-content-subtle">
                    not available
                  </span>
                ) : (
                  money(bucket.total, bucket.currency)
                )}
              </div>
              <p className="text-2xs leading-snug text-content-subtle">
                {bucket.withValue === 0
                  ? `None of the ${bucket.projects} ${bucket.currency} project${bucket.projects === 1 ? " carries" : "s carry"} a recorded value, so there is no total to state.`
                  : bucket.withoutValue > 0
                    ? `Sum of ${bucket.withValue} project${bucket.withValue === 1 ? "" : "s"}. EXCLUDES ${bucket.withoutValue} with no recorded value — those are unknown, not zero.`
                    : `Sum of all ${bucket.withValue} project${bucket.withValue === 1 ? "" : "s"} in ${bucket.currency}.`}
              </p>
            </CardBody>
          </Card>
        ))}

        <Card>
          <CardBody className="space-y-2">
            <span className="text-label uppercase text-content-subtle">By stage</span>
            <div className="space-y-1.5">
              {stageCounts.map((entry) => (
                <div key={entry.stage} className="flex items-center gap-2">
                  <span className="w-32 shrink-0 truncate text-meta text-content-muted">
                    {stageLabel(entry.stage)}
                  </span>
                  <Progress
                    value={(entry.n / projects.length) * 100}
                    size="xs"
                    tone={stageTone(entry.stage)}
                    className="flex-1"
                    aria-label={`${stageLabel(entry.stage)}: ${entry.n} of ${projects.length}`}
                  />
                  <span className="w-6 shrink-0 text-right text-meta tabular-nums text-content">
                    {entry.n}
                  </span>
                </div>
              ))}
            </div>
          </CardBody>
        </Card>
      </div>
    </div>
  );
}

/* ========================================================================== */
/* Cards                                                                      */
/* ========================================================================== */

function ProjectCards({
  projects,
  loading,
  onCreate,
}: {
  projects: ProjectRecord[];
  loading: boolean;
  onCreate: () => void;
}) {
  const [search, setSearch] = useState("");
  const [stage, setStage] = useState("");

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return projects.filter((project) => {
      if (stage && project.stage !== stage) return false;
      if (!needle) return true;
      return (
        project.name.toLowerCase().includes(needle) ||
        (project.number ?? "").toLowerCase().includes(needle) ||
        (project.city ?? "").toLowerCase().includes(needle) ||
        (project.country ?? "").toLowerCase().includes(needle)
      );
    });
  }, [projects, search, stage]);

  if (loading) {
    return (
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: 6 }).map((_, index) => (
          <Card key={index}>
            <CardBody className="space-y-3">
              <Skeleton height={14} width="70%" radius="sm" />
              <Skeleton height={10} width="45%" radius="sm" />
              <Skeleton height={28} radius="md" />
            </CardBody>
          </Card>
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="w-72">
          <SearchInput
            value={search}
            onValueChange={setSearch}
            placeholder="Search projects…"
            size="sm"
            aria-label="Search projects"
          />
        </div>
        <div className="w-52">
          <Select value={stage} onChange={(event) => setStage(event.target.value)} size="sm">
            <option value="">All stages</option>
            {PROJECT_STAGES.map((value) => (
              <option key={value} value={value}>
                {stageLabel(value)}
              </option>
            ))}
          </Select>
        </div>
        <span className="text-meta text-content-subtle">
          {formatCount(filtered.length)} of {formatCount(projects.length)}
        </span>
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          icon={IconProject}
          title={
            projects.length === 0 ? "No projects yet" : "No project matches these filters"
          }
          hint={
            projects.length === 0
              ? "A project is the container for every drawing, RFI, commitment and invoice on a job."
              : "Clear the search box or choose a different stage."
          }
          action={
            projects.length === 0 ? (
              <Button leadingIcon={IconPlus} onClick={onCreate}>
                Create your first project
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {filtered.map((project) => (
            <ProjectCard key={project.id} project={project} />
          ))}
        </div>
      )}
    </div>
  );
}

function ProjectCard({ project }: { project: ProjectRecord }) {
  const total = daysBetween(project.startDate, project.finishDate);
  const gone = daysBetween(project.startDate, todayIso());
  const elapsed =
    total !== null && gone !== null && total > 0
      ? Math.max(0, Math.min(100, (gone / total) * 100))
      : null;
  const remaining = daysBetween(todayIso(), project.finishDate);

  return (
    <Link to={`/projects/${project.id}`} className="focus-ring block rounded-lg outline-none">
      <Card interactive className="h-full">
        <CardBody className="flex h-full flex-col gap-3">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <h3 className="truncate text-sm font-semibold text-content">{project.name}</h3>
              <p className="mt-0.5 truncate font-mono text-2xs text-content-subtle">
                {project.number ?? "No project number"}
              </p>
            </div>
            <Badge tone={stageTone(project.stage)} size="xs" dot className="shrink-0">
              {stageLabel(project.stage)}
            </Badge>
          </div>

          <div className="flex items-center gap-1.5 text-meta text-content-muted">
            <IconLocation size={13} aria-hidden="true" className="shrink-0 text-content-disabled" />
            <span className="truncate">
              {[project.city, project.country].filter(Boolean).join(", ") || "No location recorded"}
            </span>
          </div>

          <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-meta">
            <div>
              <div className="text-2xs uppercase text-content-subtle">Start</div>
              <div className="tabular-nums text-content">{isoDate(project.startDate)}</div>
            </div>
            <div>
              <div className="text-2xs uppercase text-content-subtle">Finish</div>
              <div className="tabular-nums text-content">{isoDate(project.finishDate)}</div>
            </div>
          </div>

          <div className="mt-auto space-y-2">
            {elapsed === null ? (
              <p className="text-2xs italic text-content-subtle">
                No start and finish pair is recorded, so no elapsed time can be shown.
              </p>
            ) : (
              <div>
                <div className="mb-1 flex items-baseline justify-between text-2xs text-content-subtle">
                  <span>Time elapsed — not progress</span>
                  <span className="tabular-nums">
                    {remaining === null
                      ? DASH
                      : remaining < 0
                        ? `${formatCount(Math.abs(remaining))} days past`
                        : `${formatCount(remaining)} days left`}
                  </span>
                </div>
                <Progress
                  value={elapsed}
                  size="xs"
                  tone={remaining !== null && remaining < 0 ? "danger" : "accent"}
                  aria-label="Share of the recorded programme that has elapsed"
                />
              </div>
            )}

            <div className="flex items-baseline justify-between border-t border-border-subtle pt-2">
              <span className="text-2xs uppercase text-content-subtle">Recorded value</span>
              <span className="text-meta font-semibold tabular-nums text-content">
                {project.value === null || project.value === undefined ? (
                  <span className="font-normal italic text-content-subtle">not recorded</span>
                ) : (
                  money(project.value, project.currency)
                )}
              </span>
            </div>
          </div>
        </CardBody>
      </Card>
    </Link>
  );
}

/* ========================================================================== */
/* Create                                                                     */
/* ========================================================================== */

function CreateProjectDrawer({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const navigate = useNavigate();
  const [values, setValues] = useState<ProjectFormValues>(EMPTY_PROJECT_FORM);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [openAfter, setOpenAfter] = useState(true);

  useEffect(() => {
    if (open) {
      setValues(EMPTY_PROJECT_FORM);
      setError(null);
    }
  }, [open]);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const invalid = validateProjectForm(values);
    if (invalid) {
      setError(invalid);
      return;
    }
    setError(null);
    setSaving(true);
    try {
      const created = await api.post<ProjectRecord>(
        "/api/v1/projects",
        buildProjectPayload(values),
      );
      toast.success("Project created", { description: created.name });
      onCreated();
      onClose();
      if (openAfter && created.id) navigate(`/projects/${created.id}`);
    } catch (err) {
      setError(
        err instanceof ApiClientError
          ? err.message
          : err instanceof Error
            ? err.message
            : "The project could not be created.",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      side="right"
      size="lg"
      title="New project"
      description="You become the project administrator on creation, so you can set up the team straight away."
      icon={IconProject}
      footer={
        <>
          <Checkbox
            size="sm"
            className="mr-auto"
            checked={openAfter}
            onChange={(event) => setOpenAfter(event.target.checked)}
            label="Open the project after creating it"
          />
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" form="project-create-form" loading={saving} loadingText="Creating…">
            Create project
          </Button>
        </>
      }
    >
      <form id="project-create-form" onSubmit={onSubmit} noValidate>
        <ErrorAlert message={error} onDismiss={() => setError(null)} />
        <ProjectFormFields
          values={values}
          onChange={setValues}
          disabled={saving}
          note={
            <p className="mt-3 text-2xs leading-snug text-content-subtle">
              Only the name is required. Everything else can be filled in later from the project
              workspace — and the contract sum is set on the prime contract, not here.
            </p>
          }
        />
      </form>
    </Drawer>
  );
}
