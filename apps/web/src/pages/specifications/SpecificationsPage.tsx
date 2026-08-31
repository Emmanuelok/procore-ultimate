/**
 * SPECIFICATIONS — module M19, routed at /projects/:projectId/specifications.
 *
 * The claim this workspace exists to make is one sentence: **the submittal
 * register is BUILT FROM the spec book, not typed by hand.** Everything on
 * screen serves that claim or checks it.
 *
 *   Issues     upload a spec book, watch it split into divisions and sections,
 *              accept the issue (a second person's act), build the register.
 *   Sections   the binder: divisions, sections, revisions and supersession.
 *   Review     the requirement queue — identified → confirmed → registered,
 *              with provenance on every row so a machine reading is never
 *              mistaken for a human assertion.
 *   Coverage   the three gaps between the spec and the register.
 *   Conflicts  clauses that contradict a drawing: change-order origins.
 *
 * A section opens in a drawer over whichever tab you are on, so the queue
 * keeps its place while the clause behind a row is read.
 */
import { useCallback, useMemo, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { Badge, EmptyState, PageHeader, Tabs } from "../../ui";
import { IconSpec } from "../../ui/icons";
import BooksTab from "./BooksTab";
import ConflictsTab from "./ConflictsTab";
import CoverageTab from "./CoverageTab";
import ReviewQueueTab from "./ReviewQueueTab";
import SectionDrawer from "./SectionDrawer";
import SectionsTab from "./SectionsTab";
import {
  EMPTY_REQUIREMENT_FILTERS,
  EMPTY_SECTION_FILTERS,
  count,
  useSpecBooks,
  useSpecConflicts,
  useSpecCoverage,
  useSpecDivisions,
  useSpecRequirements,
  useSpecSections,
  type RequirementFilters,
  type SectionFilters,
} from "./specShared";

type TabKey = "books" | "sections" | "review" | "coverage" | "conflicts";

const TABS: Array<{ value: TabKey; label: string }> = [
  { value: "books", label: "Issues" },
  { value: "sections", label: "Sections" },
  { value: "review", label: "Requirement review" },
  { value: "coverage", label: "Coverage" },
  { value: "conflicts", label: "Conflicts" },
];

const isTabKey = (value: string | null): value is TabKey =>
  value !== null && TABS.some((t) => t.value === value);

export default function SpecificationsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();

  const [tab, setTab] = useState<TabKey>(() => {
    const requested = searchParams.get("tab");
    return isTabKey(requested) ? requested : "books";
  });
  const [sectionId, setSectionId] = useState<string | null>(() => searchParams.get("section"));
  const [sectionFilters, setSectionFilters] = useState<SectionFilters>(EMPTY_SECTION_FILTERS);
  const [requirementFilters, setRequirementFilters] = useState<RequirementFilters>(
    EMPTY_REQUIREMENT_FILTERS,
  );
  const [includeResolved, setIncludeResolved] = useState(false);

  /** Bumped by every write anywhere in the workspace; every read depends on it. */
  const [version, setVersion] = useState(0);
  const refresh = useCallback(() => setVersion((n) => n + 1), []);

  const books = useSpecBooks(projectId, version);
  const divisions = useSpecDivisions(projectId, version);
  const sections = useSpecSections(projectId, sectionFilters, version);
  const requirements = useSpecRequirements(projectId, requirementFilters, version);
  const coverage = useSpecCoverage(projectId, version);
  const conflicts = useSpecConflicts(projectId, includeResolved, version);

  const selectTab = useCallback(
    (next: TabKey) => {
      setTab(next);
      const params = new URLSearchParams(searchParams);
      params.set("tab", next);
      setSearchParams(params, { replace: true });
    },
    [searchParams, setSearchParams],
  );

  const openSection = useCallback(
    (next: string | null) => {
      setSectionId(next);
      const params = new URLSearchParams(searchParams);
      if (next) params.set("section", next);
      else params.delete("section");
      setSearchParams(params, { replace: true });
    },
    [searchParams, setSearchParams],
  );

  const bookItems = useMemo(() => books.data?.items ?? [], [books.data]);
  const currentBook = bookItems.find((b) => b.isCurrent === 1) ?? null;

  const awaitingConfirmation = coverage.data
    ? coverage.data.summary.identified
    : (requirements.data?.items ?? []).filter((r) => r.status === "identified").length;
  const openConflicts = conflicts.data?.unresolved ?? 0;

  if (!projectId) {
    return (
      <EmptyState
        icon={IconSpec}
        title="No project in the route"
        hint="The specifications workspace is project-scoped. A spec book, its sections and the register built from it all belong to one project, so this screen cannot render without knowing which."
      />
    );
  }

  const tabItems = TABS.map((t) => ({
    value: t.value,
    label: t.label,
    ...(t.value === "review" && awaitingConfirmation > 0
      ? { count: awaitingConfirmation, tone: "warning" as const }
      : {}),
    ...(t.value === "conflicts" && openConflicts > 0
      ? { count: openConflicts, tone: "danger" as const }
      : {}),
  }));

  return (
    <div>
      <PageHeader
        icon={IconSpec}
        title="Specifications"
        subtitle="The spec book, split into sections you can cite — and the submittal register derived from it. An extraction proposes; a person confirms; only then does a submittal exist."
        meta={
          <>
            {currentBook ? (
              <span className="flex items-center gap-1.5">
                <Badge tone="success" size="xs" dot>
                  Current issue
                </Badge>
                <span className="font-mono">{currentBook.reference}</span>
                <span>{currentBook.name}</span>
                {currentBook.issueLabel ? <span>· {currentBook.issueLabel}</span> : null}
              </span>
            ) : (
              <span>
                No issue is marked current — the register has no single book to be built from.
              </span>
            )}
            {coverage.data ? (
              <span>
                {count(coverage.data.summary.sections)} section
                {coverage.data.summary.sections === 1 ? "" : "s"} ·{" "}
                {count(coverage.data.summary.requirements)} requirement
                {coverage.data.summary.requirements === 1 ? "" : "s"} held ·{" "}
                {count(coverage.data.summary.registered)} registered
              </span>
            ) : null}
          </>
        }
        tabs={<Tabs items={tabItems} value={tab} onChange={selectTab} />}
      />

      {tab === "books" ? (
        <BooksTab
          projectId={projectId}
          books={books}
          onChanged={refresh}
          onOpenSections={(bookId) => {
            setSectionFilters({ ...EMPTY_SECTION_FILTERS, bookId });
            selectTab("sections");
          }}
        />
      ) : tab === "sections" ? (
        <SectionsTab
          sections={sections}
          divisions={divisions}
          books={bookItems}
          filters={sectionFilters}
          onFilters={setSectionFilters}
          onOpenSection={openSection}
        />
      ) : tab === "review" ? (
        <ReviewQueueTab
          projectId={projectId}
          requirements={requirements}
          books={bookItems}
          filters={requirementFilters}
          onFilters={setRequirementFilters}
          onMutated={refresh}
          onOpenSection={openSection}
        />
      ) : tab === "coverage" ? (
        <CoverageTab coverage={coverage} onOpenSection={openSection} />
      ) : (
        <ConflictsTab
          projectId={projectId}
          conflicts={conflicts}
          includeResolved={includeResolved}
          onIncludeResolved={setIncludeResolved}
          onMutated={refresh}
          onOpenSection={openSection}
        />
      )}

      <SectionDrawer
        projectId={projectId}
        sectionId={sectionId}
        version={version}
        onClose={() => openSection(null)}
        onMutated={refresh}
      />
    </div>
  );
}
