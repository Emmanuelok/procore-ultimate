/**
 * THE SAFETY PROGRAMME — policies, RAMS, permits, training matrices,
 * competency cards, statutory registers.
 *
 * They share one register because they share the only thing that matters
 * operationally: THEY EXPIRE, and something has to be watching the date. So
 * expiry is the first column, sorted soonest-first by default, and a permit
 * to work or a competency card that has lapsed is painted red rather than
 * amber — those are the kinds whose expiry stops work rather than merely
 * dating a file.
 *
 * A project sees its own records AND the company-level programme that applies
 * across every project (the policy, the training matrix); which is which is
 * stated on the row, because "we have a policy" and "this site has a policy"
 * are different claims.
 */
import { useMemo } from "react";
import {
  Badge,
  Card,
  CardBody,
  DataTable,
  Field,
  Progress,
  Select,
  Stat,
  Tooltip,
  type DataColumns,
  type DataView,
} from "../../ui";
import { IconDocument } from "../../ui/icons";
import type { Tone } from "../../ui/tokens";
import {
  LoadError,
  RECORD_STATUS_TONE,
  RegisterPager,
  count,
  pageParams,
  isoDate,
  labelize,
  nameOf,
  type Paged,
  type ProgrammeRecord,
  type Resource,
} from "./safetyShared";

export interface ProgrammeFilters {
  /** 1-based; the register is paged rather than silently truncated */
  page: string;
  recordKind: string;
  status: string;
  expiringWithinDays: string;
}

export const EMPTY_PROGRAMME_FILTERS: ProgrammeFilters = { page: "1",
  recordKind: "",
  status: "",
  expiringWithinDays: "",
};

const KINDS = [
  "policy",
  "risk_assessment",
  "method_statement",
  "rams",
  "safe_system_of_work",
  "permit_to_work",
  "emergency_plan",
  "traffic_management_plan",
  "training_matrix",
  "competency_card",
  "orientation_record",
  "drill_record",
  "audit_record",
  "statutory_register",
  "coshh_assessment",
  "temporary_works_design",
];

const STATUSES = [
  "draft",
  "in_review",
  "approved",
  "active",
  "expired",
  "superseded",
  "withdrawn",
];

const BUILT_IN_VIEWS: DataView[] = [
  {
    id: "builtin:expired",
    name: "Expired",
    builtIn: true,
    state: { columnFilters: [{ id: "expiry", value: ["expired"] }] },
  },
  {
    id: "builtin:critical",
    name: "Work-stopping kinds",
    builtIn: true,
    state: {
      columnFilters: [
        { id: "recordKind", value: ["permit_to_work", "competency_card", "temporary_works_design"] },
      ],
    },
  },
];

/** One word for the row's expiry position — what the filter and rail read. */
function expiryKey(row: ProgrammeRecord): string {
  if (row.expiresAt === null) return "no_expiry";
  if (row.isExpired) return "expired";
  if (row.daysToExpiry !== null && row.daysToExpiry <= 30) return "expiring";
  return "in_date";
}

const EXPIRY_LABEL: Record<string, string> = {
  expired: "Expired",
  expiring: "Expires within 30 days",
  in_date: "In date",
  no_expiry: "No expiry recorded",
};

const EXPIRY_TONE: Record<string, Tone> = {
  expired: "danger",
  expiring: "warning",
  in_date: "success",
  no_expiry: "neutral",
};

function rowRail(row: ProgrammeRecord): Tone | undefined {
  const key = expiryKey(row);
  if (key === "expired") return row.isCriticalKind ? "danger" : "warning";
  if (key === "expiring") return "warning";
  if (row.reviewOverdue) return "warning";
  return undefined;
}

export default function ProgrammeTab({
  records,
  filters,
  onFilters,
  users,
  vendors,
}: {
  records: Resource<Paged<ProgrammeRecord>>;
  filters: ProgrammeFilters;
  onFilters: (next: ProgrammeFilters) => void;
  users: Map<string, string>;
  vendors: Map<string, string>;
}) {
  const rows = records.data?.items ?? [];

  const posture = useMemo(() => {
    const expired = rows.filter((r) => r.isExpired);
    return {
      total: rows.length,
      expired: expired.length,
      expiredCritical: expired.filter((r) => r.isCriticalKind).length,
      expiring: rows.filter((r) => expiryKey(r) === "expiring").length,
      reviewOverdue: rows.filter((r) => r.reviewOverdue).length,
      unapproved: rows.filter((r) => r.approvedBy === null && r.status !== "draft").length,
    };
  }, [rows]);

  const columns = useMemo<DataColumns<ProgrammeRecord>>(
    () => [
      {
        id: "reference",
        header: "Number",
        accessor: "reference",
        type: "code",
        sticky: "start",
        width: 120,
        mono: true,
      },
      { id: "title", header: "Record", accessor: "title", type: "text", width: 280 },
      {
        id: "recordKind",
        header: "Kind",
        accessor: "recordKind",
        type: "enum",
        width: 190,
        groupable: true,
        options: KINDS.map((k) => ({ value: k, text: labelize(k), label: labelize(k) })),
        cell: ({ row }) => (
          <span className="flex flex-wrap items-center gap-1">
            <Badge tone="neutral" size="xs">
              {labelize(row.recordKind)}
            </Badge>
            {row.isCriticalKind ? (
              <Tooltip content="A kind whose expiry stops work rather than merely dating a file — a permit, a competency card, a temporary-works design.">
                <span>
                  <Badge tone="danger" size="xs" variant="outline">
                    work-stopping
                  </Badge>
                </span>
              </Tooltip>
            ) : null}
          </span>
        ),
      },
      {
        id: "expiry",
        header: "Expiry",
        headerTooltip:
          "The reason this register exists. Sorted soonest first — a lapsed permit is the record an inspector finds within ten minutes.",
        accessor: (row) => expiryKey(row),
        type: "enum",
        width: 220,
        truncate: false,
        groupable: true,
        options: Object.keys(EXPIRY_LABEL).map((k) => ({
          value: k,
          text: EXPIRY_LABEL[k]!,
          label: EXPIRY_LABEL[k]!,
          tone: EXPIRY_TONE[k],
        })),
        sortFn: (a, b) => {
          const order = ["expired", "expiring", "in_date", "no_expiry"];
          return order.indexOf(String(a)) - order.indexOf(String(b));
        },
        cell: ({ row }) => {
          const key = expiryKey(row);
          return (
            <span className="block py-0.5">
              <Badge tone={EXPIRY_TONE[key] ?? "neutral"} size="xs" dot>
                {EXPIRY_LABEL[key]}
              </Badge>
              {row.expiresAt ? (
                <span className="mt-0.5 block text-2xs tabular-nums text-content-muted">
                  {isoDate(row.expiresAt)}
                  {row.daysToExpiry !== null
                    ? row.isExpired
                      ? ` · ${count(Math.abs(row.daysToExpiry))} days ago`
                      : ` · in ${count(row.daysToExpiry)} days`
                    : ""}
                </span>
              ) : (
                <span className="mt-0.5 block text-2xs text-content-subtle">
                  Nothing is watching this record
                </span>
              )}
            </span>
          );
        },
        toCsv: ({ row }) => row.expiresAt ?? "no expiry",
      },
      {
        id: "status",
        header: "Status",
        accessor: "status",
        type: "status",
        width: 140,
        groupable: true,
        options: STATUSES.map((s) => ({
          value: s,
          text: labelize(s),
          label: labelize(s),
          tone: RECORD_STATUS_TONE[s],
        })),
        cell: ({ row }) => (
          <Badge tone={RECORD_STATUS_TONE[row.status] ?? "neutral"} size="xs" dot>
            {labelize(row.status)}
          </Badge>
        ),
      },
      {
        id: "scope",
        header: "Scope",
        accessor: (row) => (row.projectId === null ? "Company-wide" : "This project"),
        type: "enum",
        width: 150,
        groupable: true,
        options: [
          { value: "Company-wide", text: "Company-wide", label: "Company-wide" },
          { value: "This project", text: "This project", label: "This project" },
        ],
        cell: ({ row }) => (
          <Badge tone={row.projectId === null ? "info" : "highlight"} size="xs" variant="outline">
            {row.projectId === null ? "Company-wide" : "This project"}
          </Badge>
        ),
      },
      {
        id: "acknowledgements",
        header: "Acknowledged",
        headerTooltip:
          "A policy nobody has read is a policy nobody is bound by. Where a required count is recorded, the shortfall is the people who have not signed.",
        accessor: (row) => row.acknowledgementCount,
        type: "custom",
        width: 170,
        align: "left",
        cell: ({ row }) => {
          if (row.requiredAcknowledgementCount === null) {
            return (
              <span className="text-2xs text-content-subtle">
                {count(row.acknowledgementCount)} · no target set
              </span>
            );
          }
          const pct =
            row.requiredAcknowledgementCount > 0
              ? (row.acknowledgementCount / row.requiredAcknowledgementCount) * 100
              : 100;
          return (
            <span className="block w-full">
              <span className="block text-meta tabular-nums text-content">
                {count(row.acknowledgementCount)} of {count(row.requiredAcknowledgementCount)}
              </span>
              <Progress
                value={Math.min(100, pct)}
                max={100}
                size="xs"
                tone={pct >= 100 ? "success" : pct >= 70 ? "warning" : "danger"}
              />
            </span>
          );
        },
        toCsv: ({ row }) =>
          `${row.acknowledgementCount}${row.requiredAcknowledgementCount ? ` of ${row.requiredAcknowledgementCount}` : ""}`,
      },
      {
        id: "reviewDueDate",
        header: "Review due",
        accessor: "reviewDueDate",
        type: "date",
        width: 150,
        cell: ({ row }) =>
          row.reviewDueDate ? (
            <span className="flex items-center gap-1.5 tabular-nums">
              {isoDate(row.reviewDueDate)}
              {row.reviewOverdue ? (
                <Badge tone="warning" size="xs">
                  overdue
                </Badge>
              ) : null}
            </span>
          ) : (
            <span className="text-content-subtle">—</span>
          ),
      },
      {
        id: "approvedBy",
        header: "Approved by",
        headerTooltip: "Never the author. An unapproved record is a draft with a nicer name.",
        accessor: (row) => (row.approvedBy ? nameOf(users, row.approvedBy) : ""),
        type: "text",
        width: 170,
        cell: ({ row }) =>
          row.approvedBy ? (
            <span className="truncate">{nameOf(users, row.approvedBy)}</span>
          ) : (
            <span className="text-2xs text-warning-fg">not approved</span>
          ),
      },
      {
        id: "owner",
        header: "Belongs to",
        accessor: (row) => (row.vendorId ? nameOf(vendors, row.vendorId) : "Us"),
        type: "text",
        width: 170,
        defaultHidden: true,
      },
      {
        id: "regulatoryReference",
        header: "Discharges",
        accessor: (row) => row.regulatoryReference ?? "",
        type: "text",
        width: 220,
        defaultHidden: true,
      },
      {
        id: "version",
        header: "Version",
        accessor: (row) => row.version ?? "",
        type: "text",
        width: 110,
        defaultHidden: true,
      },
    ],
    [users, vendors],
  );

  return (
    <div className="space-y-4">
      {records.error ? (
        <LoadError
          message={records.error}
          onRetry={records.reload}
          title="The safety programme could not be loaded"
        />
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Card accent={posture.expiredCritical > 0 ? "danger" : undefined}>
          <CardBody>
            <Stat
              label="Expired"
              value={count(posture.expired)}
              tone={posture.expired > 0 ? "danger" : "neutral"}
              hint={
                posture.expiredCritical > 0
                  ? `${count(posture.expiredCritical)} of them are permits, competency cards or temporary-works designs — kinds whose expiry stops work.`
                  : "Nothing on this project has lapsed."
              }
            />
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <Stat
              label="Expiring within 30 days"
              value={count(posture.expiring)}
              tone={posture.expiring > 0 ? "warning" : "neutral"}
              hint="Renewals bound to the obligations register are already on the clock."
            />
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <Stat
              label="Review overdue"
              value={count(posture.reviewOverdue)}
              tone={posture.reviewOverdue > 0 ? "warning" : "neutral"}
              hint="Still in date, but past the date somebody said they would re-read it."
            />
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <Stat
              label="Unapproved"
              value={count(posture.unapproved)}
              tone={posture.unapproved > 0 ? "warning" : "neutral"}
              hint="Beyond draft, with no approver other than the author. A record signed off by nobody is not a standard."
            />
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardBody className="grid gap-3 md:grid-cols-3">
          <Field label="Kind">
            <Select
              value={filters.recordKind}
              onChange={(e) => onFilters({ ...filters, recordKind: e.target.value })}
            >
              <option value="">Every kind</option>
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {labelize(k)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Status">
            <Select
              value={filters.status}
              onChange={(e) => onFilters({ ...filters, status: e.target.value })}
            >
              <option value="">Every status</option>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {labelize(s)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Expiring within">
            <Select
              value={filters.expiringWithinDays}
              onChange={(e) => onFilters({ ...filters, expiringWithinDays: e.target.value })}
            >
              <option value="">Any horizon</option>
              <option value="0">Already expired</option>
              <option value="7">7 days</option>
              <option value="30">30 days</option>
              <option value="90">90 days</option>
            </Select>
          </Field>
        </CardBody>
      </Card>

      <DataTable<ProgrammeRecord>
        tableId="safety-programme-records"
        data={rows}
        columns={columns}
        getRowId={(row) => row.id}
        loading={records.loading}
        height={580}
        stickyHeader
        gridLines
        filterRow
        savedViews
        builtInViews={BUILT_IN_VIEWS}
        exportFileName="safety-programme-records"
        searchPlaceholder="Search the programme…"
        defaultSort={[{ id: "expiry", desc: false }]}
        rowTone={rowRail}
        empty={{
          icon: IconDocument,
          title: "The safety programme is empty",
          description:
            "No policy, RAMS, permit, training matrix or statutory register has been recorded — for this project or at company level. These records share one table because they all expire, and an empty register means nothing is watching any date.",
        }}
        emptyFiltered={{
          title: "No record matches these filters",
          description: "Widen the kind, status or expiry horizon.",
        }}
        aria-label="Safety programme records"
      />

      <RegisterPager
        page={filters.page}
        loaded={rows.length}
        total={records.data?.total ?? null}
        noun="programme record"
        loading={records.loading}
        onPage={(page) => onFilters({ ...filters, page })}
      />

      <p className="text-2xs text-content-subtle">
        Renewals are bound to the platform's obligations register — the same one that carries
        contractual time bars and insurance notification periods. A breached obligation there is a
        lapsed record here.
      </p>
    </div>
  );
}

export function programmeQueryString(filters: ProgrammeFilters): string {
  const params = pageParams(filters.page);
  if (filters.recordKind) params.set("recordKind", filters.recordKind);
  if (filters.status) params.set("status", filters.status);
  if (filters.expiringWithinDays) params.set("expiringWithinDays", filters.expiringWithinDays);
  return params.toString();
}
