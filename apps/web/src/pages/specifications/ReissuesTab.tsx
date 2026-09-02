/**
 * REISSUES — what a new issue of the spec did to the register (#288).
 *
 * A reissue is only interesting because of its consequences. Each notice
 * names them and they are counted, not narrated: clauses that moved,
 * requirements the reissue superseded, confirmations it voided (the SoD
 * chain has to run again on the new words) and — the one that costs money —
 * REGISTERED submittals whose clause changed underneath an approval.
 *
 * A notice is open until a person says it has been actioned. Acknowledging
 * is therefore an assertion, recorded with who made it, and the tab defaults
 * to the open ones because that is the queue.
 *
 * What this tab deliberately does not do: acknowledge anything on your
 * behalf, or hide a notice whose affected submittals are still approved.
 */
import { useMemo, useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  DataTable,
  EmptyState,
  Field,
  SegmentedControl,
  Stat,
  Textarea,
  Tooltip,
  type DataColumns,
} from "../../ui";
import { IconCheckCircle, IconSubmittal, IconVersion, IconWarning } from "../../ui/icons";
import { api } from "../../lib/api";
import {
  EM_DASH,
  LoadError,
  RefusalPanel,
  count,
  dateTime,
  isoDate,
  useAction,
  type Loadable,
  type SpecRevisionNotice,
  type SpecRevisionNoticesResponse,
} from "./specShared";

type Scope = "open" | "done" | "all";

const SCOPES: ReadonlyArray<{ value: Scope; label: string }> = [
  { value: "open", label: "Needs action" },
  { value: "done", label: "Acknowledged" },
  { value: "all", label: "All" },
];

export default function ReissuesTab({
  projectId,
  notices,
  scope,
  onScope,
  onMutated,
  onOpenSection,
}: {
  projectId: string;
  notices: Loadable<SpecRevisionNoticesResponse>;
  scope: Scope;
  onScope: (next: Scope) => void;
  onMutated: () => void;
  onOpenSection: (sectionId: string) => void;
}) {
  const { busy, refusal, clear, run } = useAction();
  const [acking, setAcking] = useState<SpecRevisionNotice | null>(null);
  const [note, setNote] = useState("");

  const data = notices.data;
  const rows = useMemo(() => data?.items ?? [], [data]);
  const affectedSubmittals = useMemo(
    () => rows.reduce((n, r) => n + (r.submittalsAffected?.length ?? 0), 0),
    [rows],
  );
  const toReconfirm = useMemo(
    () => rows.reduce((n, r) => n + r.requirementsToReconfirm, 0),
    [rows],
  );

  async function acknowledge() {
    if (!acking) return;
    const trimmed = note.trim();
    const done = await run(`ack:${acking.id}`, () =>
      api.post(
        `/api/v1/projects/${projectId}/spec-revision-notices/${acking.id}/acknowledge`,
        trimmed ? { note: trimmed } : {},
      ),
    );
    if (done !== null) {
      setAcking(null);
      setNote("");
      onMutated();
    }
  }

  const columns = useMemo<DataColumns<SpecRevisionNotice>>(
    () => [
      {
        id: "createdAt",
        header: "Reissued",
        accessor: "createdAt",
        type: "date",
        width: 110,
        sortDescFirst: true,
        cell: ({ row }) => (
          <Tooltip content={dateTime(row.createdAt)}>
            <span className="tabular-nums">{isoDate(row.createdAt)}</span>
          </Tooltip>
        ),
      },
      {
        id: "section",
        header: "Section",
        accessor: "sectionCode",
        type: "code",
        width: 130,
        mono: true,
        cell: ({ row }) => (
          <Tooltip content={row.sectionTitle ?? "The section title is not held for this notice."}>
            <span className="font-mono">{row.sectionCode}</span>
          </Tooltip>
        ),
      },
      {
        id: "revision",
        header: "Revision",
        accessor: "revision",
        type: "code",
        width: 90,
        mono: true,
      },
      {
        id: "changedClauseCount",
        header: "Clauses moved",
        headerTooltip:
          "Paragraphs added, amended or removed between the previous text in force and this one.",
        accessor: "changedClauseCount",
        type: "number",
        align: "right",
        width: 120,
        aggregate: "sum",
      },
      {
        id: "requirementsSuperseded",
        header: "Superseded",
        headerTooltip: "Requirements whose clause no longer exists in the new text.",
        accessor: "requirementsSuperseded",
        type: "number",
        align: "right",
        width: 110,
        aggregate: "sum",
      },
      {
        id: "requirementsToReconfirm",
        header: "To reconfirm",
        headerTooltip:
          "Confirmations the reissue voided: someone agreed to words that have since changed, so the human step runs again.",
        accessor: "requirementsToReconfirm",
        type: "number",
        align: "right",
        width: 120,
        aggregate: "sum",
        cell: ({ row }) => (
          <span
            className={
              row.requirementsToReconfirm > 0
                ? "font-semibold tabular-nums text-warning-fg"
                : "tabular-nums text-content-subtle"
            }
          >
            {count(row.requirementsToReconfirm)}
          </span>
        ),
      },
      {
        id: "requirementsNew",
        header: "New",
        headerTooltip: "Requirements read out of clauses this issue added.",
        accessor: "requirementsNew",
        type: "number",
        align: "right",
        width: 80,
        aggregate: "sum",
      },
      {
        id: "submittalsAffected",
        header: "Registered submittals hit",
        headerTooltip:
          "Submittals already on the register whose spec clause changed after they were raised. These are the ones that cost money.",
        accessor: (row) => row.submittalsAffected?.length ?? 0,
        type: "number",
        align: "right",
        width: 190,
        aggregate: "sum",
        cell: ({ row }) => {
          const n = row.submittalsAffected?.length ?? 0;
          if (n === 0) return <span className="tabular-nums text-content-subtle">0</span>;
          return (
            <Tooltip
              content={row.submittalsAffected
                .map(
                  (s) =>
                    `${s.paragraphRef ?? "whole section"} — ${s.kind === "removed" ? "clause removed" : "clause amended"}`,
                )
                .join("\n")}
            >
              <Badge tone="danger" size="xs" variant="solid">
                {count(n)}
              </Badge>
            </Tooltip>
          );
        },
      },
      {
        id: "state",
        header: "State",
        accessor: (row) => (row.acknowledgedAt ? "acknowledged" : "open"),
        type: "enum",
        width: 240,
        groupable: true,
        options: [
          { value: "open", text: "Needs action", label: "Needs action", tone: "warning" },
          { value: "acknowledged", text: "Acknowledged", label: "Acknowledged", tone: "success" },
        ],
        cell: ({ row }) =>
          row.acknowledgedAt ? (
            <span className="min-w-0 py-0.5">
              <Badge tone="success" size="xs" dot>
                Actioned {isoDate(row.acknowledgedAt)}
              </Badge>
              <p className="mt-0.5 whitespace-normal text-2xs leading-snug text-content-muted">
                by {row.acknowledgedByName ?? row.acknowledgedBy ?? "an unnamed user"}
                {typeof row.detail?.["acknowledgementNote"] === "string"
                  ? ` — ${row.detail["acknowledgementNote"] as string}`
                  : ""}
              </p>
            </span>
          ) : (
            <Badge tone="warning" size="xs" variant="solid" dot>
              Open since {isoDate(row.createdAt)}
            </Badge>
          ),
      },
      {
        id: "notified",
        header: "Told",
        headerTooltip: "Who the platform notified when the reissue landed.",
        accessor: (row) => row.notifiedNames.join(", "),
        type: "text",
        width: 200,
        cell: ({ row }) =>
          row.notifiedNames.length === 0 ? (
            <Tooltip content="Nobody was on the notification list for this section when it was reissued.">
              <span className="italic text-content-subtle">nobody</span>
            </Tooltip>
          ) : (
            <span className="text-meta text-content-muted">{row.notifiedNames.join(", ")}</span>
          ),
      },
    ],
    [],
  );

  return (
    <div className="space-y-4">
      <RefusalPanel refusal={refusal} onDismiss={clear} />
      {notices.error ? (
        <LoadError
          message={notices.error}
          onRetry={notices.reload}
          title="The reissue notices could not be loaded"
        />
      ) : null}

      <Card>
        <CardBody className="grid gap-4 sm:grid-cols-4">
          <Stat
            label="Notices awaiting action"
            value={data ? count(data.unacknowledged) : EM_DASH}
            tone={data && data.unacknowledged > 0 ? "warning" : "success"}
            icon={IconWarning}
            hint={
              data
                ? "A reissue is open until a person says the register has caught up with it."
                : "Not loaded."
            }
          />
          <Stat
            label="Confirmations voided"
            value={data ? count(toReconfirm) : EM_DASH}
            tone={toReconfirm > 0 ? "warning" : "neutral"}
            icon={IconVersion}
            hint="Across the notices listed. Each one has to be read and confirmed again by somebody other than the extractor."
          />
          <Stat
            label="Registered submittals hit"
            value={data ? count(affectedSubmittals) : EM_DASH}
            tone={affectedSubmittals > 0 ? "danger" : "success"}
            icon={IconSubmittal}
            hint="Submittals raised against a clause that has since changed. The approval on them was given for different words."
          />
          <div className="flex items-end">
            <SegmentedControl<Scope>
              value={scope}
              onChange={onScope}
              options={SCOPES}
              aria-label="Which reissue notices to show"
            />
          </div>
        </CardBody>
      </Card>

      <Alert tone="info" variant="subtle" size="sm" title="What a notice is">
        A notice is written by the platform when a section's text in force changes — never by hand.
        An identical reissue creates no revision and therefore no notice: an unchanged issue has to
        be provable as unchanged, and it is, by content hash.
      </Alert>

      {!notices.loading && rows.length === 0 ? (
        <EmptyState
          icon={IconCheckCircle}
          tone={scope === "open" ? "success" : "neutral"}
          title={
            scope === "open"
              ? "No reissue is waiting on anybody"
              : scope === "done"
                ? "No reissue has been acknowledged yet"
                : "No section has been reissued on this project"
          }
          hint="A notice appears the moment a new issue changes the words a requirement was read out of. Nothing here means nothing has changed — not that nothing was checked."
        />
      ) : (
        <DataTable<SpecRevisionNotice>
          tableId="spec-reissue-notices"
          data={rows}
          columns={columns}
          getRowId={(row) => row.id}
          loading={notices.loading}
          height={520}
          rowHeight={52}
          stickyHeader
          gridLines
          filterRow
          exportFileName="spec-reissue-notices"
          searchPlaceholder="Search reissues…"
          defaultSort={[{ id: "createdAt", desc: true }]}
          rowTone={(row) =>
            row.acknowledgedAt
              ? undefined
              : (row.submittalsAffected?.length ?? 0) > 0
                ? "danger"
                : "warning"
          }
          rowActions={(row) => [
            {
              id: "section",
              label: `Open section ${row.sectionCode}`,
              onSelect: () => onOpenSection(row.sectionId),
            },
            {
              id: "ack",
              label: "Record that it has been actioned",
              disabled: row.acknowledgedAt !== null,
              onSelect: () => {
                setAcking(row);
                setNote("");
              },
            },
          ]}
          empty={{ title: "No reissue notice", description: "Nothing has been reissued." }}
          emptyFiltered={{
            title: "No notice matches these filters",
            description: "Clear the state filter to see the rest.",
          }}
          aria-label="Specification reissue notices"
        />
      )}

      {acking ? (
        <Card>
          <CardBody className="space-y-3">
            <p className="text-sm font-semibold text-content">
              Acknowledge the reissue of {acking.sectionCode} revision {acking.revision}
            </p>
            <p className="max-w-prose text-meta text-content-muted">
              You are asserting that the register has caught up: superseded requirements dealt with,
              voided confirmations re-run, and{" "}
              {(acking.submittalsAffected?.length ?? 0) > 0
                ? `the ${count(acking.submittalsAffected.length)} registered submittal(s) whose clause changed reviewed.`
                : "no registered submittal was affected."}{" "}
              The acknowledgement is recorded against your name.
            </p>
            <Field
              label="What was done (optional)"
              hint="A sentence a reader in a year's time can check against the record."
            >
              <Textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={3}
                maxLength={2000}
                placeholder="Re-confirmed 1.3.B with the design team; SUB-014 reissued against the new clause."
              />
            </Field>
            <div className="flex gap-2">
              <Button
                onClick={() => void acknowledge()}
                loading={busy === `ack:${acking.id}`}
                size="sm"
              >
                Acknowledge
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setAcking(null)}>
                Cancel
              </Button>
            </div>
          </CardBody>
        </Card>
      ) : null}
    </div>
  );
}
