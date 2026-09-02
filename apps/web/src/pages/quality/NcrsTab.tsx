/**
 * THE NON-CONFORMANCE REGISTER.
 *
 * The register exists to make ONE act difficult: deciding that non-conforming
 * work is acceptable. So the grid leads with the DISPOSITION and with who
 * proposed it — a `use_as_is` sitting at "proposed" with nobody independent
 * behind it is the row that matters, and it is drawn as such.
 *
 * Money on an NCR carries its own currency and is never summed with another's.
 * The register shows a per-currency strip rather than one total, because there
 * is no rate on the record and inventing one would be a fabrication.
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
import { IconAlert, IconPlus } from "../../ui/icons";
import { api } from "../../lib/api";
import {
  CONCESSION_DISPOSITIONS,
  DISPOSITION_TONE,
  LoadError,
  NCR_OPEN_STATUSES,
  NCR_SEVERITY_TONE,
  NCR_STATUS_TONE,
  NothingHere,
  RefusalNotice,
  isoDate,
  labelize,
  money,
  nameOf,
  plural,
  todayIso,
  useAction,
  type Resource,
} from "./qualityShared";
import type { Ncr, Paged } from "./types";

const NCR_STATUSES = [
  "open",
  "under_review",
  "disposition_proposed",
  "disposition_approved",
  "action_in_progress",
  "verification_pending",
  "closed",
  "rejected",
  "void",
];

const NCR_SEVERITIES = ["minor", "major", "critical"];

const NCR_CATEGORIES = [
  "workmanship",
  "material",
  "design",
  "documentation",
  "process",
  "testing",
  "dimensional",
  "calibration",
  "environmental",
  "supplier",
  "other",
];

const NCR_DISPOSITIONS = [
  "pending",
  "rework",
  "repair",
  "use_as_is",
  "reject",
  "return_to_supplier",
  "regrade",
];

export interface NcrFilters {
  status: string;
  severity: string;
  category: string;
  disposition: string;
  openOnly: string;
  search: string;
}

export const EMPTY_NCR_FILTERS: NcrFilters = {
  status: "",
  severity: "",
  category: "",
  disposition: "",
  openOnly: "",
  search: "",
};

export default function NcrsTab({
  ncrs,
  filters,
  onFilters,
  projectId,
  users,
  onOpen,
  onMutated,
}: {
  ncrs: Resource<Paged<Ncr>>;
  filters: NcrFilters;
  onFilters: (next: NcrFilters) => void;
  projectId: string;
  users: Map<string, string>;
  onOpen: (ncrId: string) => void;
  onMutated: () => void;
}) {
  const [createOpen, setCreateOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [severity, setSeverity] = useState("minor");
  const [category, setCategory] = useState("workmanship");
  const [due, setDue] = useState("");
  const { busy, refusal, clear, run } = useAction();

  const rows = ncrs.data?.items ?? [];
  const today = todayIso();

  /** Awaiting an independent approval — the queue this register exists for. */
  const awaitingApproval = rows.filter((n) => n.status === "disposition_proposed");
  const concessionsProposed = awaitingApproval.filter((n) =>
    CONCESSION_DISPOSITIONS.includes(n.disposition),
  );
  const overdue = rows.filter(
    (n) =>
      n.responseDueDate !== null &&
      n.responseDueDate < today &&
      NCR_OPEN_STATUSES.includes(n.status),
  );

  /** Cost is bucketed by currency. Nothing here adds a euro to a dollar. */
  const byCurrency = useMemo(() => {
    const buckets = new Map<string, { withCost: number; without: number; total: number }>();
    for (const n of rows) {
      const bucket = buckets.get(n.currency) ?? { withCost: 0, without: 0, total: 0 };
      if (typeof n.costImpact === "number") {
        bucket.withCost += 1;
        bucket.total += n.costImpact;
      } else {
        bucket.without += 1;
      }
      buckets.set(n.currency, bucket);
    }
    return [...buckets.entries()].map(([currency, b]) => ({ currency, ...b }));
  }, [rows]);

  const columns = useMemo<DataColumns<Ncr>>(
    () => [
      {
        id: "reference",
        header: "Reference",
        accessor: "reference",
        type: "code",
        mono: true,
        sticky: "start",
        width: 120,
      },
      { id: "title", header: "Non-conformance", accessor: "title", type: "text", width: 280 },
      {
        id: "severity",
        header: "Severity",
        accessor: "severity",
        type: "enum",
        width: 110,
        groupable: true,
        options: NCR_SEVERITIES.map((s) => ({
          value: s,
          text: labelize(s),
          label: labelize(s),
          tone: NCR_SEVERITY_TONE[s] ?? "neutral",
        })),
        cell: ({ row }) => (
          <Badge tone={NCR_SEVERITY_TONE[row.severity] ?? "neutral"} size="xs" dot>
            {labelize(row.severity)}
          </Badge>
        ),
      },
      {
        id: "status",
        header: "Status",
        accessor: "status",
        type: "status",
        width: 170,
        groupable: true,
        options: NCR_STATUSES.map((s) => ({
          value: s,
          text: labelize(s),
          label: labelize(s),
          tone: NCR_STATUS_TONE[s] ?? "neutral",
        })),
        cell: ({ row }) => (
          <Badge tone={NCR_STATUS_TONE[row.status] ?? "neutral"} size="xs" dot>
            {labelize(row.status)}
          </Badge>
        ),
      },
      {
        id: "disposition",
        header: "Disposition",
        headerTooltip:
          "Proposed by one person and approved by another. A use-as-is approved by its own proposer is exactly what this register exists to prevent.",
        accessor: "disposition",
        type: "enum",
        width: 230,
        groupable: true,
        options: NCR_DISPOSITIONS.map((d) => ({
          value: d,
          text: labelize(d),
          label: labelize(d),
          tone: DISPOSITION_TONE[d] ?? "neutral",
        })),
        cell: ({ row }) => (
          <div className="min-w-0 py-0.5">
            <Badge
              tone={DISPOSITION_TONE[row.disposition] ?? "neutral"}
              size="xs"
              variant={CONCESSION_DISPOSITIONS.includes(row.disposition) ? "solid" : "subtle"}
            >
              {labelize(row.disposition)}
            </Badge>
            <p className="mt-0.5 whitespace-normal text-2xs leading-snug text-content-muted">
              {row.disposition === "pending"
                ? "nobody has proposed one"
                : row.dispositionApprovedBy
                  ? `approved by ${nameOf(users, row.dispositionApprovedBy)}`
                  : row.dispositionProposedBy
                    ? `proposed by ${nameOf(users, row.dispositionProposedBy)} — not yet approved by anyone else`
                    : "no proposer recorded"}
            </p>
          </div>
        ),
        toCsv: ({ row }) => row.disposition,
      },
      {
        id: "vendor",
        header: "Against",
        accessor: (row) => row.raisedAgainstVendorId ?? "",
        type: "text",
        width: 150,
        cell: ({ row }) =>
          row.raisedAgainstVendorId ? (
            <span className="font-mono text-2xs">{row.raisedAgainstVendorId}</span>
          ) : (
            <span className="text-content-subtle">not attributed</span>
          ),
      },
      {
        id: "due",
        header: "Response due",
        accessor: (row) => row.responseDueDate ?? "",
        type: "date",
        width: 140,
        cell: ({ row }) => {
          if (!row.responseDueDate) {
            return <span className="text-2xs text-content-subtle">no date set</span>;
          }
          const late =
            row.responseDueDate < today && NCR_OPEN_STATUSES.includes(row.status);
          return (
            <span className="flex items-center gap-1.5 tabular-nums">
              {isoDate(row.responseDueDate)}
              {late ? (
                <Badge tone="danger" size="xs">
                  overdue
                </Badge>
              ) : null}
            </span>
          );
        },
      },
      {
        id: "cost",
        header: "Cost impact",
        headerTooltip:
          "In the NCR's own currency. Costs in different currencies are never added together on this project.",
        accessor: (row) => row.costImpact ?? Number.NEGATIVE_INFINITY,
        type: "custom",
        width: 150,
        align: "right",
        cell: ({ row }) =>
          row.costImpact === null ? (
            <span className="text-2xs italic text-content-subtle">unmeasured</span>
          ) : (
            <span className="tabular-nums">{money(row.costImpact, row.currency)}</span>
          ),
        toCsv: ({ row }) =>
          row.costImpact === null ? "unmeasured" : `${row.costImpact} ${row.currency}`,
      },
      {
        id: "actions",
        header: "Open actions",
        accessor: "openActionCount",
        type: "number",
        width: 120,
        align: "right",
        aggregate: "sum",
      },
    ],
    [today, users],
  );

  async function create() {
    const created = await run("create", () =>
      api.post<Ncr>(`/api/v1/projects/${projectId}/ncrs`, {
        title: title.trim(),
        description: description.trim(),
        severity,
        category,
        responseDueDate: due === "" ? null : due,
      }),
    );
    if (created) {
      setCreateOpen(false);
      setTitle("");
      setDescription("");
      setDue("");
      onMutated();
      onOpen(created.id);
    }
  }

  if (ncrs.error) {
    return (
      <LoadError
        message={ncrs.error}
        onRetry={ncrs.reload}
        title="The non-conformance register could not be loaded"
      />
    );
  }

  return (
    <div className="space-y-4">
      {concessionsProposed.length > 0 ? (
        <Alert
          tone="warning"
          icon={IconAlert}
          title={`${concessionsProposed.length} concession ${plural(concessionsProposed.length, "disposition")} ${plural(concessionsProposed.length, "is", "are")} proposed and unapproved`}
        >
          {concessionsProposed.map((n) => (
            <p key={n.id} className="mt-0.5">
              <span className="font-mono text-2xs">{n.reference}</span> — {labelize(n.disposition)},
              proposed by {nameOf(users, n.dispositionProposedBy)}. Whoever approves it must be
              somebody else, and a use-as-is needs the designer&apos;s concession reference on the
              record.
            </p>
          ))}
        </Alert>
      ) : null}

      {overdue.length > 0 ? (
        <Alert tone="danger" title={`${overdue.length} open ${plural(overdue.length, "NCR")} past the response date`}>
          {overdue.map((n) => n.reference).join(", ")}
        </Alert>
      ) : null}

      {byCurrency.length > 0 ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {byCurrency.map((b) => (
            <div key={b.currency} className="rounded-lg border border-border bg-surface-raised p-3">
              <div className="flex items-center justify-between">
                <span className="text-label uppercase tracking-wide text-content-subtle">
                  Cost of non-conformance · {b.currency}
                </span>
              </div>
              <div className="mt-1 text-lg font-semibold tabular-nums">
                {b.withCost === 0 ? (
                  <span className="text-sm font-normal italic text-content-subtle">
                    not available
                  </span>
                ) : (
                  money(b.total, b.currency)
                )}
              </div>
              <p className="mt-1 text-2xs text-content-subtle">
                {b.withCost === 0
                  ? `None of the ${b.without} ${plural(b.without, "NCR")} in ${b.currency} carries a recorded cost. It is not zero — it is unmeasured.`
                  : b.without > 0
                    ? `${b.without} of ${b.withCost + b.without} carry no cost and are excluded, so this is a floor rather than the figure.`
                    : `Across all ${b.withCost} ${plural(b.withCost, "NCR")} in ${b.currency}.`}
              </p>
            </div>
          ))}
          {byCurrency.length > 1 ? (
            <div className="rounded-lg border border-border bg-surface-sunken p-3 text-2xs text-content-muted sm:col-span-2 lg:col-span-4">
              This project carries NCR costs in {byCurrency.map((b) => b.currency).join(", ")}. They
              are shown per currency and are never added together — there is no rate on the record.
            </div>
          ) : null}
        </div>
      ) : null}

      <Card>
        <CardBody className="grid gap-3 md:grid-cols-3 xl:grid-cols-6">
          <Field label="Status">
            <Select
              value={filters.status}
              onChange={(e) => onFilters({ ...filters, status: e.target.value })}
            >
              <option value="">Every status</option>
              {NCR_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {labelize(s)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Severity">
            <Select
              value={filters.severity}
              onChange={(e) => onFilters({ ...filters, severity: e.target.value })}
            >
              <option value="">Any severity</option>
              {NCR_SEVERITIES.map((s) => (
                <option key={s} value={s}>
                  {labelize(s)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Category">
            <Select
              value={filters.category}
              onChange={(e) => onFilters({ ...filters, category: e.target.value })}
            >
              <option value="">Every category</option>
              {NCR_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {labelize(c)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Disposition">
            <Select
              value={filters.disposition}
              onChange={(e) => onFilters({ ...filters, disposition: e.target.value })}
            >
              <option value="">Any disposition</option>
              {NCR_DISPOSITIONS.map((d) => (
                <option key={d} value={d}>
                  {labelize(d)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Scope">
            <Select
              value={filters.openOnly}
              onChange={(e) => onFilters({ ...filters, openOnly: e.target.value })}
            >
              <option value="">Everything</option>
              <option value="true">Open only</option>
            </Select>
          </Field>
          <Field label="Search titles">
            <Input
              value={filters.search}
              onChange={(e) => onFilters({ ...filters, search: e.target.value })}
            />
          </Field>
        </CardBody>
      </Card>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-meta text-content-muted">
          {ncrs.data
            ? `${ncrs.data.total} ${plural(ncrs.data.total, "NCR")} · ${awaitingApproval.length} awaiting an independent approval`
            : "Loading the register…"}
        </p>
        <Button size="sm" icon={IconPlus} onClick={() => setCreateOpen(true)}>
          Raise an NCR
        </Button>
      </div>

      {ncrs.loading && rows.length === 0 ? (
        <Skeleton height={420} />
      ) : rows.length === 0 ? (
        <NothingHere
          title="No non-conformance has been raised on this project"
          reason={
            filters.status || filters.severity || filters.category || filters.disposition || filters.search
              ? "Nothing matches the filters above. Clear them before drawing any conclusion about the work."
              : "An empty NCR register is not a project without defects; it is a project where nobody has written one down. The register's whole purpose is to make the decision to accept non-conforming work a decision somebody independent had to sign."
          }
          action={
            <Button size="sm" icon={IconPlus} onClick={() => setCreateOpen(true)}>
              Raise the first NCR
            </Button>
          }
        />
      ) : (
        <DataTable<Ncr>
          tableId="quality-ncrs"
          data={rows}
          columns={columns}
          getRowId={(row) => row.id}
          height={560}
          stickyHeader
          showFooter
          zebra
          filterRow
          exportFileName="ncr-register"
          searchPlaceholder="Search NCRs"
          aria-label="Non-conformance reports"
          rowTone={(row) =>
            row.severity === "critical" && NCR_OPEN_STATUSES.includes(row.status)
              ? "danger"
              : row.status === "disposition_proposed"
                ? "warning"
                : row.status === "closed"
                  ? "success"
                  : undefined
          }
          onRowClick={({ row }) => onOpen(row.id)}
        />
      )}

      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="Raise a non-conformance report"
        description="An NCR records work that departs from what was specified. What happens to it next is a decision two people have to make between them."
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={busy === "create"}
              disabled={title.trim().length === 0 || description.trim().length === 0}
              onClick={create}
            >
              Raise it
            </Button>
          </div>
        }
      >
        <div className="space-y-3">
          <RefusalNotice refusal={refusal} onDismiss={clear} />
          <Field label="Title" required>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
          </Field>
          <Field
            label="Description"
            required
            hint="What departs from what. The specific clause and the measured departure are worth more than an adjective."
          >
            <Textarea
              rows={4}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Severity">
              <Select value={severity} onChange={(e) => setSeverity(e.target.value)}>
                {NCR_SEVERITIES.map((s) => (
                  <option key={s} value={s}>
                    {labelize(s)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Category">
              <Select value={category} onChange={(e) => setCategory(e.target.value)}>
                {NCR_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {labelize(c)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Response due">
              <Input type="date" value={due} onChange={(e) => setDue(e.target.value)} />
            </Field>
          </div>
        </div>
      </Modal>
    </div>
  );
}
