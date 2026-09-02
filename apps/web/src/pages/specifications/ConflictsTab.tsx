/**
 * CROSS-REFERENCE CONFLICTS — where change orders come from.
 *
 * A `conflicts_with` reference says two contract documents disagree at a named
 * paragraph, on a named target, from a named date. That is not a housekeeping
 * item: it is the origin of a variation, and its AGE is the number that
 * matters, because a conflict nobody settled for ninety days has been priced
 * by somebody in the meantime.
 *
 * The list is ordered oldest first for exactly that reason, and resolving one
 * demands a written note naming what settled it — the RFI answer or the
 * addendum — because "resolved" with no cited instrument is not a resolution.
 */
import { useMemo, useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  Checkbox,
  DataTable,
  EmptyState,
  Field,
  Stat,
  Textarea,
  Tooltip,
  type DataColumns,
} from "../../ui";
import { IconCompliance, IconWarning } from "../../ui/icons";
import { api } from "../../lib/api";
import {
  EM_DASH,
  LoadError,
  RefusalPanel,
  count,
  isoDate,
  titleCase,
  useAction,
  type Loadable,
  type SpecConflict,
  type SpecConflictsResponse,
} from "./specShared";

export default function ConflictsTab({
  projectId,
  conflicts,
  includeResolved,
  onIncludeResolved,
  onMutated,
  onOpenSection,
}: {
  projectId: string;
  conflicts: Loadable<SpecConflictsResponse>;
  includeResolved: boolean;
  onIncludeResolved: (next: boolean) => void;
  onMutated: () => void;
  onOpenSection: (sectionId: string) => void;
}) {
  const { busy, refusal, clear, run } = useAction();
  const [resolving, setResolving] = useState<SpecConflict | null>(null);
  const [note, setNote] = useState("");

  const data = conflicts.data;
  const rows = useMemo(
    () => (data?.items ?? []).slice().sort((a, b) => b.ageDays - a.ageDays),
    [data],
  );

  const open = rows.filter((r) => r.resolvedAt === null);
  const oldest = open[0]?.ageDays ?? null;

  async function resolve() {
    if (!resolving || !note.trim()) return;
    const done = await run(`resolve:${resolving.id}`, () =>
      api.post(`/api/v1/projects/${projectId}/spec-references/${resolving.id}/resolve`, {
        resolutionNote: note.trim(),
      }),
    );
    if (done !== null) {
      setResolving(null);
      setNote("");
      onMutated();
    }
  }

  const columns = useMemo<DataColumns<SpecConflict>>(
    () => [
      {
        id: "ageDays",
        header: "Age",
        headerTooltip:
          "Days since the conflict was recorded. Every one of them is a day somebody may have priced work against a document that disagrees with another.",
        accessor: "ageDays",
        type: "number",
        align: "right",
        width: 90,
        sortDescFirst: true,
        aggregate: "max",
        cell: ({ row }) => (
          <span
            className={
              row.resolvedAt
                ? "tabular-nums text-content-subtle"
                : row.ageDays >= 30
                  ? "font-semibold tabular-nums text-danger-fg"
                  : "tabular-nums text-content"
            }
          >
            {count(row.ageDays)}d
          </span>
        ),
      },
      {
        id: "section",
        header: "Section",
        accessor: (row) => row.section?.code ?? "",
        type: "code",
        width: 120,
        mono: true,
        cell: ({ row }) =>
          row.section ? (
            <Tooltip content={row.section.title}>
              <span className="font-mono">{row.section.code}</span>
            </Tooltip>
          ) : (
            <span className="italic text-content-subtle">unknown</span>
          ),
      },
      {
        id: "paragraphRef",
        header: "Paragraph",
        accessor: (row) => row.paragraphRef ?? "",
        type: "code",
        width: 110,
        mono: true,
        cell: ({ row }) =>
          row.paragraphRef ?? (
            <Tooltip content="No paragraph was recorded, so the conflict is asserted against the whole section. That is weaker evidence than a clause reference.">
              <span className="italic text-content-subtle">whole section</span>
            </Tooltip>
          ),
      },
      {
        id: "target",
        header: "Conflicts with",
        accessor: (row) => row.targetLabel ?? row.targetId,
        type: "text",
        width: 280,
        cell: ({ row }) => (
          <span className="min-w-0">
            <Badge tone="neutral" size="xs" variant="outline">
              {titleCase(row.targetType)}
            </Badge>{" "}
            <span className="text-meta text-content">{row.targetLabel ?? row.targetId}</span>
          </span>
        ),
      },
      {
        id: "note",
        header: "What disagrees",
        accessor: (row) => row.note ?? "",
        type: "text",
        width: 340,
        truncate: false,
        cell: ({ row }) =>
          row.note ? (
            <span className="whitespace-normal text-meta text-content-muted">{row.note}</span>
          ) : (
            <span className="italic text-content-subtle">
              no description was recorded with this conflict
            </span>
          ),
      },
      {
        id: "resolved",
        header: "State",
        accessor: (row) => (row.resolvedAt ? "resolved" : "open"),
        type: "enum",
        width: 240,
        groupable: true,
        options: [
          { value: "open", text: "Open", label: "Open", tone: "danger" },
          { value: "resolved", text: "Resolved", label: "Resolved", tone: "success" },
        ],
        cell: ({ row }) =>
          row.resolvedAt ? (
            <span className="min-w-0 py-0.5">
              <Badge tone="success" size="xs" dot>
                Resolved {isoDate(row.resolvedAt)}
              </Badge>
              {row.resolutionNote ? (
                <p className="mt-0.5 whitespace-normal text-2xs leading-snug text-content-muted">
                  {row.resolutionNote}
                </p>
              ) : null}
            </span>
          ) : (
            <Badge tone="danger" size="xs" variant="solid" dot>
              Open since {isoDate(row.createdAt)}
            </Badge>
          ),
      },
    ],
    [],
  );

  return (
    <div className="space-y-4">
      <RefusalPanel refusal={refusal} onDismiss={clear} />
      {conflicts.error ? (
        <LoadError
          message={conflicts.error}
          onRetry={conflicts.reload}
          title="The conflict list could not be loaded"
        />
      ) : null}

      <Card>
        <CardBody className="grid gap-4 sm:grid-cols-4">
          <Stat
            label="Open conflicts"
            value={count(open.length)}
            tone={open.length > 0 ? "danger" : "success"}
            icon={IconWarning}
            hint="Each one is a documented disagreement between contract documents."
          />
          <Stat
            label="Oldest"
            value={oldest === null ? EM_DASH : `${count(oldest)} days`}
            tone={oldest !== null && oldest >= 30 ? "danger" : "neutral"}
            hint={
              oldest === null
                ? "No open conflict, so there is no age to report."
                : "Days since the disagreement was first recorded."
            }
          />
          <Stat
            label="Recorded in total"
            value={count(data?.total ?? 0)}
            hint="Including resolved ones when the toggle below is on."
          />
          <div className="flex items-end">
            <Checkbox
              checked={includeResolved}
              onChange={(e) => onIncludeResolved(e.target.checked)}
              label="Include resolved conflicts"
              description="Resolved conflicts stay on the record with the note that settled them."
            />
          </div>
        </CardBody>
      </Card>

      {data?.note ? (
        <Alert tone="info" variant="subtle" size="sm" title="Why this list exists">
          {data.note}
        </Alert>
      ) : null}

      {!conflicts.loading && rows.length === 0 ? (
        <EmptyState
          icon={IconCompliance}
          tone="success"
          title={
            includeResolved
              ? "No conflict has ever been recorded between a clause and anything else"
              : "No unresolved conflict is recorded on this project"
          }
          hint="This is a statement about the record, not about the documents. A conflict exists on this list only because somebody anchored it at a paragraph — if the spec and the drawings disagree and nobody has said so here, the platform cannot know it."
        />
      ) : (
        <DataTable<SpecConflict>
          tableId="spec-conflicts"
          data={rows}
          columns={columns}
          getRowId={(row) => row.id}
          loading={conflicts.loading}
          height={520}
          rowHeight={52}
          stickyHeader
          gridLines
          filterRow
          savedViews
          exportFileName="spec-conflicts"
          searchPlaceholder="Search conflicts…"
          defaultSort={[{ id: "ageDays", desc: true }]}
          rowTone={(row) =>
            row.resolvedAt ? undefined : row.ageDays >= 30 ? "danger" : "warning"
          }
          rowActions={(row) => [
            {
              id: "section",
              label: row.section ? `Open section ${row.section.code}` : "Open section",
              onSelect: () => onOpenSection(row.sectionId),
            },
            {
              id: "resolve",
              label: "Record what settled it",
              disabled: row.resolvedAt !== null,
              onSelect: () => {
                setResolving(row);
                setNote("");
              },
            },
          ]}
          empty={{
            title: "No conflict recorded",
            description: "Conflicts are recorded against a section, anchored at a paragraph.",
          }}
          emptyFiltered={{
            title: "No conflict matches these filters",
            description: "Clear the state filter to see the rest.",
          }}
          aria-label="Unresolved cross-reference conflicts"
        />
      )}

      {resolving ? (
        <Card>
          <CardBody className="space-y-3">
            <p className="text-sm font-semibold text-content">
              Resolve the conflict on {resolving.section?.code ?? "this section"}
              {resolving.paragraphRef ? ` at ${resolving.paragraphRef}` : ""}
            </p>
            <p className="max-w-prose text-meta text-content-muted">
              Name the instrument that settled it. "Resolved" without a cited RFI answer or addendum
              is an assertion nobody can check later, and this note is what a claim will be read
              against.
            </p>
            <Field label="What settled it?" required>
              <Textarea
                rows={3}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="RFI-042 answered 12 May: the drawing governs; the clause is superseded by Addendum 3."
                autoFocus
              />
            </Field>
            <div className="flex gap-2">
              <Button
                disabled={note.trim().length === 0 || busy !== null}
                loading={busy !== null}
                onClick={() => void resolve()}
              >
                Record the resolution
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  setResolving(null);
                  setNote("");
                }}
              >
                Cancel
              </Button>
            </div>
          </CardBody>
        </Card>
      ) : null}
    </div>
  );
}
