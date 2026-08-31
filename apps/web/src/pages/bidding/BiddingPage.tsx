/**
 * BIDDING, TENDERING & PREQUALIFICATION — module M25.
 *
 * Routed at /projects/:projectId/bidding. Project-scoped, with the two
 * company-level prequalification surfaces carried here as tabs because that is
 * where a buyer stands when they need them.
 *
 *   Packages        the tender register, its timetable and its evaluation basis
 *   Invitations     who was asked, whether they engaged, and where their
 *                   prequalification actually stands right now
 *   Bids            THE SEAL — rendered as the control it is, with the opening
 *                   requirements: the time, the opener, and a witness who is a
 *                   different person
 *   Levelling       the comparison grid: scope rows against bidders, where an
 *                   excluded scope with no adjustment yields a SENTENCE and not
 *                   a cheap-looking number
 *   Scoring         price and quality, with every unscored criterion named
 *   Award           the recommendation, the lowest bid shown alongside, and the
 *                   written justification when it was not taken
 *   Prequalification  questionnaires, knockouts, scoring and the lapse gate
 *   Screening       financial figures, ratios, and the recommended
 *                   single-project limit with its stated basis
 *
 * Everything project-scoped hangs off ONE selected package, chosen at the top,
 * so the register never loses its place while a tender is worked on.
 */
import { useEffect, useMemo, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { Alert, Badge, Button, EmptyState, PageHeader, Select, Skeleton, Tabs } from "../../ui";
import { IconProcurement, IconLock, IconRefresh } from "../../ui/icons";
import AwardTab from "./AwardTab";
import InvitationsTab from "./InvitationsTab";
import LevellingTab from "./LevellingTab";
import PackagesTab from "./PackagesTab";
import PrequalificationTab from "./PrequalificationTab";
import ScoringTab from "./ScoringTab";
import ScreeningTab from "./ScreeningTab";
import SubmissionsTab from "./SubmissionsTab";
import {
  LoadError,
  dateTime,
  money,
  packageTone,
  titleCase,
  useResource,
} from "./biddingShared";
import type { BidPackage, PackageDetail, Paginated } from "./types";

type TabKey =
  | "packages"
  | "invitations"
  | "bids"
  | "levelling"
  | "scoring"
  | "award"
  | "prequalification"
  | "screening";

interface TabSpec {
  value: TabKey;
  label: string;
  /** false for the two company-level tabs, which need no package */
  needsPackage: boolean;
}

const TABS: readonly TabSpec[] = [
  { value: "packages", label: "Packages", needsPackage: false },
  { value: "invitations", label: "Invitations", needsPackage: true },
  { value: "bids", label: "Bids & seal", needsPackage: true },
  { value: "levelling", label: "Levelling", needsPackage: true },
  { value: "scoring", label: "Scoring", needsPackage: true },
  { value: "award", label: "Award", needsPackage: true },
  { value: "prequalification", label: "Prequalification", needsPackage: false },
  { value: "screening", label: "Financial screening", needsPackage: false },
];

const isTabKey = (value: string | null): value is TabKey =>
  value !== null && TABS.some((t) => t.value === value);

export default function BiddingPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();

  const [tab, setTab] = useState<TabKey>(() => {
    const requested = searchParams.get("tab");
    return isTabKey(requested) ? requested : "packages";
  });
  const [packageId, setPackageId] = useState<string>(() => searchParams.get("package") ?? "");
  const [version, setVersion] = useState(0);

  const packages = useResource<Paginated<BidPackage>>(
    projectId ? `/api/v1/projects/${projectId}/bid-packages?page=1&pageSize=200&_v=${version}` : null,
  );

  const items = useMemo(() => packages.data?.items ?? [], [packages.data]);

  useEffect(() => {
    if (items.length === 0) return;
    if (items.some((p) => p.id === packageId)) return;
    const preferred =
      items.find((p) => p.status !== "awarded" && p.status !== "cancelled") ?? items[0];
    if (preferred) setPackageId(preferred.id);
  }, [items, packageId]);

  const detail = useResource<PackageDetail>(
    projectId && packageId
      ? `/api/v1/projects/${projectId}/bid-packages/${packageId}?_v=${version}`
      : null,
  );

  function selectTab(next: TabKey) {
    setTab(next);
    const params = new URLSearchParams(searchParams);
    params.set("tab", next);
    setSearchParams(params, { replace: true });
  }

  function selectPackage(next: string) {
    setPackageId(next);
    const params = new URLSearchParams(searchParams);
    if (next) params.set("package", next);
    else params.delete("package");
    setSearchParams(params, { replace: true });
  }

  function refreshAll() {
    setVersion((n) => n + 1);
  }

  if (!projectId) {
    return (
      <Alert tone="danger" title="No project in the route">
        This workspace is project-scoped. It cannot show a tender register without knowing which
        project the packages belong to.
      </Alert>
    );
  }

  const pkg = detail.data;
  const seal = pkg?.seal ?? null;
  const spec = TABS.find((t) => t.value === tab)!;
  const needsPackage = spec.needsPackage;

  return (
    <div>
      <PageHeader
        icon={IconProcurement}
        title="Bidding & prequalification"
        subtitle="Sealed bids stay sealed until the time passes and two named people open them; bids are compared on their levelled amounts, never as bid; and an award that is not the lowest carries the lowest amount and the reason it was not taken."
        meta={
          packages.data ? (
            <span>
              {packages.data.total} package{packages.data.total === 1 ? "" : "s"} on this project
              {pkg ? (
                <>
                  {" · "}
                  <span className="font-medium">{pkg.reference}</span> {titleCase(pkg.status)}
                  {pkg.engineersEstimate !== null
                    ? ` · estimate ${money(pkg.engineersEstimate, pkg.currency)}`
                    : " · no pre-tender estimate recorded"}
                </>
              ) : null}
            </span>
          ) : null
        }
        actions={
          <Button
            variant="ghost"
            size="sm"
            icon={IconRefresh}
            onClick={refreshAll}
            disabled={packages.loading}
          >
            Refresh
          </Button>
        }
        tabs={
          <Tabs
            aria-label="Bidding workspace"
            items={TABS.map((t) => ({
              value: t.value,
              label: t.label,
              ...(t.value === "packages" && packages.data
                ? { count: packages.data.total }
                : {}),
              ...(t.value === "invitations" && pkg ? { count: pkg.counts.invitations } : {}),
              ...(t.value === "bids" && pkg ? { count: pkg.counts.submissions } : {}),
              ...(t.value === "levelling" && pkg ? { count: pkg.counts.levellingItems } : {}),
            }))}
            value={tab}
            onChange={selectTab}
          />
        }
      />

      {/* ---------------------------------------------------------------- */}
      {/* The package rail — every project-scoped tab is about one package   */}
      {/* ---------------------------------------------------------------- */}
      {needsPackage ? (
        <div className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-border bg-surface-raised px-3 py-2">
          <label className="text-label uppercase text-content-subtle" htmlFor="bidding-package">
            Package
          </label>
          {packages.loading && items.length === 0 ? (
            <Skeleton width={280} height={32} radius="md" />
          ) : (
            <Select
              id="bidding-package"
              className="min-w-[22rem]"
              value={packageId}
              onChange={(e) => selectPackage(e.target.value)}
              placeholder="Choose a package"
            >
              {items.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.reference} — {p.title}
                </option>
              ))}
            </Select>
          )}
          {pkg ? (
            <>
              <Badge tone={packageTone(pkg.status)} size="sm" dot>
                {titleCase(pkg.status)}
              </Badge>
              {seal?.isSealed ? (
                <Badge
                  tone={seal.amountsWithheld ? "warning" : "success"}
                  size="sm"
                  icon={IconLock}
                >
                  {seal.amountsWithheld ? "Sealed — prices withheld" : "Opened"}
                </Badge>
              ) : (
                <Badge tone="neutral" size="sm">
                  Open bidding — not sealed
                </Badge>
              )}
              <span className="text-meta text-content-subtle">
                Bids due {dateTime(pkg.timetable.bidDueAt)}
              </span>
            </>
          ) : null}
        </div>
      ) : null}

      {packages.error ? (
        <LoadError message={packages.error} onRetry={packages.reload} />
      ) : null}

      {needsPackage && !packages.loading && items.length === 0 ? (
        <EmptyState
          icon={IconProcurement}
          title="No bid packages on this project yet"
          hint="This tab works on one package at a time, and there is not one to work on. A package is the scope, the timetable and the evaluation basis, agreed before anyone is invited to price it — start on the Packages tab."
          action={<Button onClick={() => selectTab("packages")}>Go to Packages</Button>}
        />
      ) : needsPackage && !packageId ? (
        <EmptyState
          title="No package selected"
          hint="Choose a package above. Invitations, bids, levelling, scoring and the award all belong to one tender."
        />
      ) : needsPackage && detail.error ? (
        <LoadError message={detail.error} onRetry={detail.reload} />
      ) : (
        <TabBody
          tab={tab}
          projectId={projectId}
          packageId={packageId}
          pkg={pkg}
          loading={detail.loading}
          onRefresh={refreshAll}
          onSelectPackage={selectPackage}
          onSelectTab={selectTab}
        />
      )}
    </div>
  );
}

function TabBody({
  tab,
  projectId,
  packageId,
  pkg,
  loading,
  onRefresh,
  onSelectPackage,
  onSelectTab,
}: {
  tab: TabKey;
  projectId: string;
  packageId: string;
  pkg: PackageDetail | null;
  loading: boolean;
  onRefresh: () => void;
  onSelectPackage: (id: string) => void;
  onSelectTab: (tab: TabKey) => void;
}) {
  switch (tab) {
    case "packages":
      return (
        <PackagesTab
          projectId={projectId}
          selectedId={packageId}
          onSelect={(id) => {
            onSelectPackage(id);
            onSelectTab("invitations");
          }}
          onMutated={onRefresh}
        />
      );
    case "invitations":
      return (
        <InvitationsTab
          projectId={projectId}
          packageId={packageId}
          pkg={pkg}
          loading={loading}
          onMutated={onRefresh}
        />
      );
    case "bids":
      return (
        <SubmissionsTab
          projectId={projectId}
          packageId={packageId}
          pkg={pkg}
          loading={loading}
          onMutated={onRefresh}
        />
      );
    case "levelling":
      return (
        <LevellingTab
          projectId={projectId}
          packageId={packageId}
          pkg={pkg}
          onMutated={onRefresh}
        />
      );
    case "scoring":
      return (
        <ScoringTab projectId={projectId} packageId={packageId} pkg={pkg} onMutated={onRefresh} />
      );
    case "award":
      return (
        <AwardTab projectId={projectId} packageId={packageId} pkg={pkg} onMutated={onRefresh} />
      );
    case "prequalification":
      return <PrequalificationTab />;
    case "screening":
      return <ScreeningTab />;
    default:
      return null;
  }
}
