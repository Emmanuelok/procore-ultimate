/**
 * THE CHECKLIST REGISTER.
 *
 * A checklist is the record made when an intervention point is reached, so the
 * register leads with the verdict and the count of failures rather than with a
 * percentage. A percentage is frequently absent on purpose: a pass/fail form
 * carries a verdict and no score, and inventing one from the count of ticked
 * boxes would put a number on a record that never had one. Those cells say
 * "not scored" and the record says why.
 */
import { useMemo, useState } from "react";
import {
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
  type DataColumns,
} from "../../ui";
import { IconPlus } from "../../ui/icons";
import { api } from "../../lib/api";
import {
  CHECKLIST_STATUS_TONE,
  LoadError,
  NothingHere,
  RESULT_TONE,
  RefusalNotice,
  dateTime,
  labelize,
  pct,
  plural,
  useAction,
  type Resource,
} from "./qualityShared";
import type { Checklist, ChecklistTemplate, Paged } from "./types";

const CHECKLIST_STATUSES = [
  "draft",
  "scheduled",
  "in_progress",
  "complete",
  "failed",
  "reviewed",
  "closed",
  "void",
];

const CHECKLIST_CATEGORIES = [
  "quality",
  "safety",
  "commissioning",
  "pre_pour",
  "pre_task",
  "environmental",
  "handover",
  "snagging",
  "closeout",
  "delivery_receipt",
  "prequalification",
];

const INSPECTION_RESULTS = ["pass", "pass_with_observations", "fail", "not_applicable"];

export interface ChecklistFilters {
  status: string;
  category: string;
  result: string;
  search: string;
}

export const EMPTY_CHECKLIST_FILTERS: ChecklistFilters = {
  status: "",
  category: "",
  result: "",
  search: "",
};

export default function ChecklistsTab({
  checklists,
  templates,
  filters,
  onFilters,
  projectId,
  onOpen,
  onMutated,
}: {
  checklists: Resource<Paged<Checklist>>;
  templates: Resource<Paged<ChecklistTemplate>>;
  filters: ChecklistFilters;
  onFilters: (next: ChecklistFilters) => void;
  projectId: string;
  onOpen: (checklistId: string) => void;
  onMutated: () => void;
}) {
  const [createOpen, setCreateOpen] = useState(false);
  const [templateId, setTemplateId] = useState("");
  const [title, setTitle] = useState("");
  const [locationText, setLocationText] = useState("");
  const { busy, refusal, clear, run } = useAction();

  const rows = checklists.data?.items ?? [];
  const activeTemplates = (templates.data?.items ?? []).filter((t) => t.status === "active");

  const columns = useMemo<DataColumns<Checklist>>(
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
      { id: "title", header: "Checklist", accessor: "title", type: "text", width: 280 },
      {
        id: "category",
        header: "Category",
        accessor: "category",
        type: "enum",
        width: 150,
        groupable: true,
        options: CHECKLIST_CATEGORIES.map((c) => ({
          value: c,
          text: labelize(c),
          label: labelize(c),
        })),
        cell: ({ row }) => labelize(row.category),
      },
      {
        id: "status",
        header: "Status",
        accessor: "status",
        type: "status",
        width: 130,
        groupable: true,
        options: CHECKLIST_STATUSES.map((s) => ({
          value: s,
          text: labelize(s),
          label: labelize(s),
          tone: CHECKLIST_STATUS_TONE[s] ?? "neutral",
        })),
        cell: ({ row }) => (
          <Badge tone={CHECKLIST_STATUS_TONE[row.status] ?? "neutral"} size="xs" dot>
            {labelize(row.status)}
          </Badge>
        ),
      },
      {
        id: "result",
        header: "Verdict",
        accessor: (row) => row.result ?? "",
        type: "enum",
        width: 180,
        groupable: true,
        options: INSPECTION_RESULTS.map((r) => ({
          value: r,
          text: labelize(r),
          label: labelize(r),
          tone: RESULT_TONE[r] ?? "neutral",
        })),
        cell: ({ row }) =>
          row.result ? (
            <Badge tone={RESULT_TONE[row.result] ?? "neutral"} size="xs" dot>
              {labelize(row.result)}
            </Badge>
          ) : (
            <span className="text-2xs italic text-content-subtle">no verdict recorded</span>
          ),
      },
      {
        id: "score",
        header: "Score",
        headerTooltip:
          "Blank where the form produces no score. A pass/fail form carries a verdict and no percentage, and one invented from the count of ticked boxes would be a number the record never had.",
        accessor: (row) => row.scorePercent ?? -1,
        type: "custom",
        width: 120,
        align: "right",
        cell: ({ row }) =>
          row.scorePercent === null ? (
            <span className="text-2xs italic text-content-subtle">not scored</span>
          ) : (
            <span className="tabular-nums">{pct(row.scorePercent)}</span>
          ),
        toCsv: ({ row }) => (row.scorePercent === null ? "not scored" : row.scorePercent),
      },
      {
        id: "answered",
        header: "Answered",
        accessor: "answeredItemCount",
        type: "number",
        width: 100,
        align: "right",
        aggregate: "sum",
      },
      {
        id: "failed",
        header: "Failed",
        accessor: "failedItemCount",
        type: "number",
        width: 90,
        align: "right",
        aggregate: "sum",
        cell: ({ row }) =>
          row.failedItemCount === 0 ? (
            <span className="text-content-subtle">—</span>
          ) : (
            <Badge tone="warning" size="xs">
              {row.failedItemCount}
            </Badge>
          ),
      },
      {
        id: "critical",
        header: "Critical failures",
        headerTooltip: "A critical item failing fails the whole checklist, whatever the score says.",
        accessor: "criticalFailureCount",
        type: "number",
        width: 140,
        align: "right",
        aggregate: "sum",
        cell: ({ row }) =>
          row.criticalFailureCount === 0 ? (
            <span className="text-content-subtle">—</span>
          ) : (
            <Badge tone="danger" size="xs" variant="solid">
              {row.criticalFailureCount}
            </Badge>
          ),
      },
      {
        id: "ncrs",
        header: "NCRs raised",
        accessor: "ncrCount",
        type: "number",
        width: 110,
        align: "right",
        aggregate: "sum",
      },
      {
        id: "performed",
        header: "Performed",
        accessor: (row) => row.performedAt ?? "",
        type: "datetime",
        width: 170,
        cell: ({ row }) =>
          row.performedAt ? (
            <span className="tabular-nums">{dateTime(row.performedAt)}</span>
          ) : (
            <span className="text-content-subtle">not yet performed</span>
          ),
      },
      {
        id: "witness",
        header: "Witnessed",
        accessor: (row) => (row.witnessedAt ? "yes" : ""),
        type: "text",
        width: 130,
        cell: ({ row }) =>
          row.witnessedAt ? (
            <Badge tone="success" size="xs" dot>
              witnessed
            </Badge>
          ) : (
            <span className="text-2xs text-content-subtle">not witnessed</span>
          ),
      },
    ],
    [],
  );

  async function create() {
    const created = await run("create", () =>
      api.post<Checklist>(`/api/v1/projects/${projectId}/checklists`, {
        /* `templateId` is optional but NOT nullable on the API — omit it
         * entirely for an ad-hoc checklist rather than sending null. */
        ...(templateId === "" ? {} : { templateId }),
        ...(title.trim() === "" ? {} : { title: title.trim() }),
        locationText: locationText.trim() === "" ? null : locationText.trim(),
      }),
    );
    if (created) {
      setCreateOpen(false);
      setTitle("");
      setLocationText("");
      onMutated();
      onOpen(created.id);
    }
  }

  if (checklists.error) {
    return (
      <LoadError
        message={checklists.error}
        onRetry={checklists.reload}
        title="The checklist register could not be loaded"
      />
    );
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardBody className="grid gap-3 md:grid-cols-4">
          <Field label="Status">
            <Select
              value={filters.status}
              onChange={(e) => onFilters({ ...filters, status: e.target.value })}
            >
              <option value="">Every status</option>
              {CHECKLIST_STATUSES.map((s) => (
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
              {CHECKLIST_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {labelize(c)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Verdict">
            <Select
              value={filters.result}
              onChange={(e) => onFilters({ ...filters, result: e.target.value })}
            >
              <option value="">Any verdict</option>
              {INSPECTION_RESULTS.map((r) => (
                <option key={r} value={r}>
                  {labelize(r)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Search titles">
            <Input
              value={filters.search}
              onChange={(e) => onFilters({ ...filters, search: e.target.value })}
              placeholder="Checklist title"
            />
          </Field>
        </CardBody>
      </Card>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-meta text-content-muted">
          {checklists.data
            ? `${checklists.data.total} ${plural(checklists.data.total, "record")} · ${activeTemplates.length} issued ${plural(activeTemplates.length, "form")} available`
            : "Loading the register…"}
        </p>
        <Button size="sm" icon={IconPlus} onClick={() => setCreateOpen(true)}>
          Take a checklist
        </Button>
      </div>

      {checklists.loading && rows.length === 0 ? (
        <Skeleton height={420} />
      ) : rows.length === 0 ? (
        <NothingHere
          title="No checklist has been taken on this project"
          reason={
            filters.status || filters.category || filters.result || filters.search
              ? "Nothing matches the filters above. Clear them before concluding anything about the project."
              : "A checklist is the record made when an intervention point is reached. With none taken, the project's first-time-pass rate has no denominator and the platform will report it as unavailable rather than invent one."
          }
          action={
            <Button size="sm" icon={IconPlus} onClick={() => setCreateOpen(true)}>
              Take the first checklist
            </Button>
          }
        />
      ) : (
        <DataTable<Checklist>
          tableId="quality-checklists"
          data={rows}
          columns={columns}
          getRowId={(row) => row.id}
          height={560}
          stickyHeader
          showFooter
          zebra
          filterRow
          exportFileName="checklist-register"
          searchPlaceholder="Search checklists"
          aria-label="Checklists"
          rowTone={(row) =>
            row.criticalFailureCount > 0
              ? "danger"
              : row.failedItemCount > 0
                ? "warning"
                : row.result === "pass"
                  ? "success"
                  : undefined
          }
          onRowClick={({ row }) => onOpen(row.id)}
        />
      )}

      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="Take a checklist"
        description="Work is recorded against an ISSUED form. Only approved (active) templates appear below; the API refuses a draft one so the record names a controlled document."
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={busy === "create"}
              disabled={templateId === "" && title.trim().length === 0}
              onClick={create}
            >
              Take it
            </Button>
          </div>
        }
      >
        <div className="space-y-3">
          <RefusalNotice refusal={refusal} onDismiss={clear} />
          <Field
            label="Template"
            hint={
              activeTemplates.length === 0
                ? "No active template exists in this company. A checklist taken without one is ad hoc: it is still typed and still judged, but it names no controlled form."
                : "The template version is stamped onto the record so a later revision cannot rewrite the past."
            }
          >
            <Select value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
              <option value="">No template — ad hoc checklist</option>
              {activeTemplates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.reference} v{t.version} · {t.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label="Title"
            required={templateId === ""}
            hint="Required when no template is used — a record with no template and no title names nothing."
          >
            <Input value={title} onChange={(e) => setTitle(e.target.value)} />
          </Field>
          <Field label="Location">
            <Input
              value={locationText}
              onChange={(e) => setLocationText(e.target.value)}
              placeholder="e.g. Level 3, grid C4–D6"
            />
          </Field>
        </div>
      </Modal>
    </div>
  );
}
