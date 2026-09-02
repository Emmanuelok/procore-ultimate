/**
 * TURNOVER — and the GAP LEADS.
 *
 * A turnover package is a checklist of artefact kinds with a required count
 * and a present count, and the difference between them is the only number
 * anybody needs. "The O&Ms are missing" has to be a query, not a conversation
 * in a handover meeting six weeks after the contractor demobilised — so the
 * gap is the first thing on this screen, itemised by artefact kind, before any
 * status or reference.
 *
 * Where the project declares no required artefact at all there is no
 * denominator, so completeness is reported as unavailable with the API's
 * reason rather than as 100%.
 */
import { useMemo, useState } from "react";
import {
  Alert,
  Badge,
  BarChart,
  Button,
  Card,
  CardBody,
  ChartCard,
  DataTable,
  Field,
  Input,
  Modal,
  Select,
  Skeleton,
  Textarea,
  type DataColumns,
} from "../../ui";
import { cx } from "../../ui/cx";
import { IconPlus } from "../../ui/icons";
import { toneClass } from "../../ui/tokens";
import { api } from "../../lib/api";
import {
  CountTile,
  FigureTile,
  LoadError,
  NothingHere,
  RefusalNotice,
  STRICTNESS_MEANING,
  TURNOVER_STATUS_TONE,
  artefactLabel,
  labelize,
  pct,
  plural,
  useAction,
  type Resource,
} from "./qualityShared";
import type { TurnoverSummary, TurnoverSummaryRow } from "./types";

const TURNOVER_STATUSES = [
  "draft",
  "assembling",
  "submitted",
  "under_review",
  "comments_issued",
  "resubmitted",
  "accepted",
  "rejected",
  "handed_over",
];

const PACKAGE_TYPES = ["system", "area", "building", "phase", "whole_project"];

export default function TurnoverTab({
  summary,
  projectId,
  onOpen,
  onMutated,
}: {
  summary: Resource<TurnoverSummary>;
  projectId: string;
  onOpen: (packageId: string) => void;
  onMutated: () => void;
}) {
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [packageType, setPackageType] = useState("system");
  const [strictness, setStrictness] = useState("block");
  const [description, setDescription] = useState("");
  const { busy, refusal, clear, run } = useAction();

  const rows = summary.data?.items ?? [];
  const totals = summary.data?.totals ?? null;

  /** Which artefact kinds are missing, and from how many packages. */
  const missingByKind = useMemo(() => {
    const counts = new Map<string, number>();
    for (const row of rows) {
      for (const kind of row.missingKinds) {
        counts.set(kind, (counts.get(kind) ?? 0) + 1);
      }
    }
    return [...counts.entries()]
      .map(([kind, packages]) => ({ kind, label: artefactLabel(kind), packages }))
      .sort((a, b) => b.packages - a.packages);
  }, [rows]);

  const blocked = rows.filter(
    (r) => r.strictness === "block" && (r.gap > 0 || r.openPunchItemCount > 0 || r.openNcrCount > 0),
  );

  const columns = useMemo<DataColumns<TurnoverSummaryRow>>(
    () => [
      {
        id: "gap",
        header: "Gap",
        headerTooltip:
          "Required artefacts that are not present. The reason the package has a contents list at all.",
        accessor: "gap",
        type: "number",
        sticky: "start",
        width: 110,
        align: "right",
        aggregate: "sum",
        cell: ({ row }) =>
          row.gap === 0 ? (
            <Badge tone="success" size="xs" dot>
              complete
            </Badge>
          ) : (
            <Badge tone="danger" size="xs" variant="solid">
              {row.gap} missing
            </Badge>
          ),
      },
      {
        id: "missing",
        header: "What is missing",
        accessor: (row) => row.missingKinds.map(artefactLabel).join(", "),
        type: "text",
        width: 320,
        cell: ({ row }) =>
          row.missingKinds.length === 0 ? (
            <span className="text-2xs text-content-subtle">
              every required artefact is present
            </span>
          ) : (
            <span className="flex flex-wrap gap-1 py-0.5">
              {row.missingKinds.map((kind) => (
                <Badge key={kind} tone="danger" size="xs" variant="outline">
                  {artefactLabel(kind)}
                </Badge>
              ))}
            </span>
          ),
      },
      {
        id: "reference",
        header: "Reference",
        accessor: "reference",
        type: "code",
        mono: true,
        width: 110,
      },
      { id: "name", header: "Package", accessor: "name", type: "text", width: 230 },
      {
        id: "status",
        header: "Status",
        accessor: "status",
        type: "status",
        width: 150,
        groupable: true,
        options: TURNOVER_STATUSES.map((s) => ({
          value: s,
          text: labelize(s),
          label: labelize(s),
          tone: TURNOVER_STATUS_TONE[s] ?? "neutral",
        })),
        cell: ({ row }) => (
          <Badge tone={TURNOVER_STATUS_TONE[row.status] ?? "neutral"} size="xs" dot>
            {labelize(row.status)}
          </Badge>
        ),
      },
      {
        id: "present",
        header: "Present / required",
        accessor: (row) => row.presentArtefactCount,
        type: "custom",
        width: 150,
        align: "right",
        cell: ({ row }) =>
          row.requiredArtefactCount === 0 ? (
            <span className="text-2xs italic text-content-subtle">nothing required</span>
          ) : (
            <span className="tabular-nums">
              {row.presentArtefactCount} / {row.requiredArtefactCount}
            </span>
          ),
        toCsv: ({ row }) => `${row.presentArtefactCount}/${row.requiredArtefactCount}`,
      },
      {
        id: "punch",
        header: "Open punch items",
        accessor: "openPunchItemCount",
        type: "number",
        width: 140,
        align: "right",
        aggregate: "sum",
        cell: ({ row }) =>
          row.openPunchItemCount === 0 ? (
            <span className="text-content-subtle">—</span>
          ) : (
            <Badge tone="warning" size="xs">
              {row.openPunchItemCount}
            </Badge>
          ),
      },
      {
        id: "ncrs",
        header: "Open NCRs",
        accessor: "openNcrCount",
        type: "number",
        width: 120,
        align: "right",
        aggregate: "sum",
        cell: ({ row }) =>
          row.openNcrCount === 0 ? (
            <span className="text-content-subtle">—</span>
          ) : (
            <Badge tone="danger" size="xs">
              {row.openNcrCount}
            </Badge>
          ),
      },
      {
        id: "strictness",
        header: "Strictness",
        headerTooltip:
          "block refuses submission and acceptance while anything is outstanding; warn allows it but names everything; ignore allows it silently. The gap is reported either way.",
        accessor: "strictness",
        type: "enum",
        width: 120,
        groupable: true,
        cell: ({ row }) => (
          <Badge
            tone={row.strictness === "block" ? "accent" : row.strictness === "warn" ? "warning" : "neutral"}
            size="xs"
            variant="outline"
          >
            {labelize(row.strictness)}
          </Badge>
        ),
      },
      {
        id: "handedOver",
        header: "Handed over",
        accessor: (row) => row.handedOverAt ?? "",
        type: "datetime",
        width: 160,
        cell: ({ row }) =>
          row.handedOverAt ? (
            <Badge tone="success" size="xs" dot>
              handed over
            </Badge>
          ) : (
            <span className="text-2xs text-content-subtle">not handed over</span>
          ),
      },
    ],
    [],
  );

  async function create() {
    const created = await run("create", () =>
      api.post<{ id: string }>(`/api/v1/projects/${projectId}/turnover-packages`, {
        name: name.trim(),
        packageType,
        blockingStrictness: strictness,
        description: description.trim() === "" ? null : description.trim(),
      }),
    );
    if (created) {
      setCreateOpen(false);
      setName("");
      setDescription("");
      onMutated();
      onOpen(created.id);
    }
  }

  if (summary.error) {
    return (
      <LoadError
        message={summary.error}
        onRetry={summary.reload}
        title="The turnover register could not be loaded"
      />
    );
  }

  if (summary.loading && rows.length === 0) {
    return (
      <div className="space-y-3">
        <Skeleton height={140} />
        <Skeleton height={260} />
        <Skeleton height={320} />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* ---------------- the gap, first ---------------- */}
      {totals ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div
            className={cx(
              "rounded-lg border p-3",
              totals.gap > 0
                ? cx(toneClass("danger", "subtle"), toneClass("danger", "border"))
                : "border-border bg-surface-raised",
            )}
          >
            <div className="text-label uppercase tracking-wide">Artefact gap</div>
            <div className="mt-1 text-2xl font-semibold tabular-nums">{totals.gap}</div>
            <p className="mt-1 text-2xs">
              {totals.gap === 0
                ? "Every required artefact across every package is present."
                : `${totals.gap} required ${plural(totals.gap, "artefact")} ${plural(totals.gap, "is", "are")} missing across ${rows.filter((r) => r.gap > 0).length} ${plural(rows.filter((r) => r.gap > 0).length, "package")}. An owner who accepts without them inherits a building nobody can operate or prove compliant.`}
            </p>
          </div>
          <FigureTile
            label="Artefact completeness"
            figure={totals.completeness}
            render={(v) => pct(v)}
            hint={`${totals.presentArtefactCount} present of ${totals.requiredArtefactCount} required`}
            tone={
              totals.completeness.value !== null && totals.completeness.value < 100
                ? "warning"
                : "success"
            }
          />
          <CountTile
            label="Packages"
            value={totals.packages}
            hint={`${rows.filter((r) => r.handedOverAt !== null).length} handed over`}
          />
          <CountTile
            label="Would be blocked today"
            value={blocked.length}
            tone="danger"
            emphasis
            hint="Strictness is block and something is outstanding."
          />
        </div>
      ) : null}

      {missingByKind.length > 0 ? (
        <ChartCard
          title="What is actually missing"
          subtitle="Required artefacts absent, counted across every package that requires them."
          footnote="Counted from each package's own contents list. A kind that no package requires does not appear — the platform does not invent a requirement nobody wrote down."
        >
          <BarChart
            data={missingByKind.map((m) => ({ kind: m.label, packages: m.packages }))}
            categoryKey="kind"
            series={[{ key: "packages", label: "Packages missing it", tone: "danger" }]}
            orientation="horizontal"
            height={Math.max(200, missingByKind.length * 30 + 60)}
            valueFormat="number"
            ariaLabel="Required turnover artefacts missing, by kind"
          />
        </ChartCard>
      ) : null}

      {blocked.length > 0 ? (
        <Alert
          tone="warning"
          title={`${blocked.length} ${plural(blocked.length, "package")} cannot be submitted or accepted as ${plural(blocked.length, "it stands", "they stand")}`}
        >
          <ul className="mt-1 space-y-1">
            {blocked.map((p) => (
              <li key={p.id}>
                <span className="font-mono text-2xs">{p.reference}</span> {p.name} —
                {p.gap > 0
                  ? ` ${p.gap} missing ${plural(p.gap, "artefact")} (${p.missingKinds.map(artefactLabel).join(", ")})`
                  : ""}
                {p.openPunchItemCount > 0
                  ? `${p.gap > 0 ? "," : ""} ${p.openPunchItemCount} open punch ${plural(p.openPunchItemCount, "item")}`
                  : ""}
                {p.openNcrCount > 0
                  ? `${p.gap > 0 || p.openPunchItemCount > 0 ? "," : ""} ${p.openNcrCount} open ${plural(p.openNcrCount, "NCR")}`
                  : ""}
                . Open the package to see the blocking records by name.
              </li>
            ))}
          </ul>
        </Alert>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-meta text-content-muted">
          {totals
            ? `${totals.packages} ${plural(totals.packages, "package")} · ${totals.presentArtefactCount} of ${totals.requiredArtefactCount} required artefacts present`
            : "Loading the register…"}
        </p>
        <Button size="sm" icon={IconPlus} onClick={() => setCreateOpen(true)}>
          New package
        </Button>
      </div>

      {rows.length === 0 ? (
        <NothingHere
          title="No turnover package exists on this project"
          reason="Nothing has been assembled for the owner to accept. Until a package declares its required artefacts there is no denominator for completeness, so the platform reports it as unavailable rather than as 100%."
          action={
            <Button size="sm" icon={IconPlus} onClick={() => setCreateOpen(true)}>
              Assemble the first package
            </Button>
          }
        />
      ) : (
        <DataTable<TurnoverSummaryRow>
          tableId="quality-turnover"
          data={rows}
          columns={columns}
          getRowId={(row) => row.id}
          height={520}
          stickyHeader
          showFooter
          zebra
          filterRow
          exportFileName="turnover-packages"
          searchPlaceholder="Search packages"
          aria-label="Turnover packages"
          defaultSort={[{ id: "gap", desc: true }]}
          rowTone={(row) =>
            row.gap > 0 || row.openNcrCount > 0
              ? "danger"
              : row.openPunchItemCount > 0
                ? "warning"
                : row.handedOverAt
                  ? "success"
                  : undefined
          }
          onRowClick={({ row }) => onOpen(row.id)}
        />
      )}

      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="New turnover package"
        description="The contents list is the acceptance gate, itemised. Declare what this package must contain and the gap becomes a query rather than a conversation."
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={busy === "create"}
              disabled={name.trim().length === 0}
              onClick={create}
            >
              Create the package
            </Button>
          </div>
        }
      >
        <div className="space-y-3">
          <RefusalNotice refusal={refusal} onDismiss={clear} />
          <Field label="Name" required>
            <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Package type">
              <Select value={packageType} onChange={(e) => setPackageType(e.target.value)}>
                {PACKAGE_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {labelize(t)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Strictness">
              <Select value={strictness} onChange={(e) => setStrictness(e.target.value)}>
                <option value="block">Block</option>
                <option value="warn">Warn</option>
                <option value="ignore">Ignore</option>
              </Select>
            </Field>
          </div>
          <Card>
            <CardBody className="text-2xs text-content-muted">
              {STRICTNESS_MEANING[strictness]}{" "}
              {strictness === "block"
                ? "Block is the default because the moment of acceptance is the last moment anybody has leverage to get the missing certificate."
                : ""}
            </CardBody>
          </Card>
          <Field label="Description">
            <Textarea
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>
        </div>
      </Modal>
    </div>
  );
}
