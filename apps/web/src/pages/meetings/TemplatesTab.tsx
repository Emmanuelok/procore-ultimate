/**
 * THE COMPANY AGENDA TEMPLATE LIBRARY (#416).
 *
 * A standing agenda is an organisational standard, not a per-series
 * invention: the same eight headings appear on every job, and typing them
 * again per series is exactly how the eighth one ("safety moment") quietly
 * stops appearing. The library holds them once; a series copies them.
 *
 * COPIED, NOT REFERENCED — deliberately. A template that were referenced
 * would let an edit made today change the agenda of minutes issued last
 * March, which is a rewrite of a record somebody has already relied on.
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
  Input,
  Modal,
  Select,
  Textarea,
  useConfirm,
  type DataColumns,
} from "../../ui";
import { IconMeeting, IconPlus, IconTrash } from "../../ui/icons";
import { api } from "../../lib/api";
import {
  ITEM_CATEGORIES,
  LoadError,
  MEETING_TYPES,
  RefusalPanel,
  count,
  titleCase,
  useAction,
  useResource,
  type Paginated,
} from "./meetingsShared";

interface TemplateItem {
  title?: string;
  category?: string;
  allocatedMinutes?: number | null;
  itemNumber?: string | null;
}

interface AgendaTemplate {
  id: string;
  projectId: string | null;
  name: string;
  description: string | null;
  meetingType: string;
  items: TemplateItem[];
  defaultAttendees: unknown[];
  contractRequirement: string | null;
  isDefault: number;
  status: string;
  usageCount: number;
  createdAt: string;
}

interface Row {
  title: string;
  category: string;
  allocatedMinutes: string;
}

export default function TemplatesTab({ projectId }: { projectId: string }) {
  const [version, setVersion] = useState(0);
  const list = useResource<Paginated<AgendaTemplate>>(
    `/api/v1/meeting-agenda-templates?pageSize=100&_v=${version}`,
  );
  const { busy, refusal, clear, run } = useAction();
  const { confirm, dialog } = useConfirm();
  const [createOpen, setCreateOpen] = useState(false);

  const rows = list.data?.items ?? [];

  async function archive(row: AgendaTemplate) {
    const ok = await confirm({
      title: `Archive ${row.name}?`,
      description:
        "Archiving takes it out of the picker. Every series that already copied it keeps its agenda exactly as it stands — a template is copied, never referenced, so nothing already minuted changes.",
      confirmLabel: "Archive it",
    });
    if (!ok) return;
    const done = await run(`archive:${row.id}`, () =>
      api.patch(`/api/v1/meeting-agenda-templates/${row.id}`, { status: "archived" }),
    );
    if (done !== null) setVersion((n) => n + 1);
  }

  const columns = useMemo<DataColumns<AgendaTemplate>>(
    () => [
      { id: "name", header: "Template", accessor: "name", type: "text", width: 240, sticky: "start" },
      {
        id: "meetingType",
        header: "Standard for",
        accessor: "meetingType",
        type: "enum",
        width: 180,
        groupable: true,
        cell: ({ row }) => (
          <Badge tone="neutral" size="xs" variant="outline">
            {titleCase(row.meetingType)}
          </Badge>
        ),
      },
      {
        id: "items",
        header: "Items",
        accessor: (row) => row.items.length,
        type: "number",
        align: "right",
        width: 90,
      },
      {
        id: "invitees",
        header: "Standing invitees",
        accessor: (row) => row.defaultAttendees.length,
        type: "number",
        align: "right",
        width: 150,
      },
      {
        id: "scope",
        header: "Scope",
        accessor: (row) => (row.projectId ? "project" : "company"),
        type: "enum",
        width: 130,
        cell: ({ row }) => (
          <Badge tone={row.projectId ? "info" : "neutral"} size="xs">
            {row.projectId ? "This project" : "Company"}
          </Badge>
        ),
      },
      {
        id: "usageCount",
        header: "Applied",
        accessor: "usageCount",
        type: "number",
        align: "right",
        width: 100,
        headerTooltip:
          "How many series or occurrences have copied this template. A standard nobody applies is a standard in name only.",
      },
      {
        id: "contractRequirement",
        header: "Contract basis",
        accessor: (row) => row.contractRequirement ?? "",
        type: "text",
        width: 200,
        cell: ({ row }) =>
          row.contractRequirement ?? (
            <span className="italic text-content-subtle">not recorded</span>
          ),
      },
    ],
    [],
  );

  return (
    <div className="space-y-4">
      {dialog}
      <RefusalPanel refusal={refusal} onDismiss={clear} />
      {list.error ? (
        <LoadError
          message={list.error}
          onRetry={list.reload}
          title="The agenda template library could not be loaded"
        />
      ) : null}

      <Alert tone="info" variant="subtle" size="sm" title="Copied, never referenced">
        Applying a template writes its items onto the series or the occurrence. Editing the library
        afterwards does not rewrite minutes that have already been taken — which is the whole reason
        it is a copy.
      </Alert>

      {!list.loading && rows.length === 0 ? (
        <EmptyState
          icon={IconMeeting}
          title="No agenda template recorded"
          hint="A standing agenda is an organisational standard, not a per-series invention. Record the headings your progress, design and commercial meetings always carry, and every new series can start from them."
          action={
            <Button icon={IconPlus} onClick={() => setCreateOpen(true)}>
              Create a template
            </Button>
          }
        />
      ) : (
        <DataTable<AgendaTemplate>
          tableId="meeting-agenda-templates"
          data={rows}
          columns={columns}
          getRowId={(row) => row.id}
          loading={list.loading}
          height={440}
          stickyHeader
          gridLines
          filterRow
          exportFileName="meeting-agenda-templates"
          searchPlaceholder="Search templates…"
          rowActions={(row) => [
            {
              id: "archive",
              label: "Archive the template",
              destructive: true,
              disabled: busy !== null,
              onSelect: () => void archive(row),
            },
          ]}
          toolbarActions={
            <Button size="sm" icon={IconPlus} onClick={() => setCreateOpen(true)}>
              New template
            </Button>
          }
          empty={{ title: "No template", description: "Create one to standardise your agendas." }}
          emptyFiltered={{
            title: "No template matches these filters",
            description: "Clear the type filter.",
          }}
          aria-label="Meeting agenda templates"
        />
      )}

      <CreateTemplateModal
        open={createOpen}
        projectId={projectId}
        onClose={() => setCreateOpen(false)}
        onCreated={() => {
          setCreateOpen(false);
          setVersion((n) => n + 1);
        }}
      />
    </div>
  );
}

function CreateTemplateModal({
  open,
  projectId,
  onClose,
  onCreated,
}: {
  open: boolean;
  projectId: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const { busy, refusal, clear, run } = useAction();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [meetingType, setMeetingType] = useState("progress");
  const [contractRequirement, setContractRequirement] = useState("");
  const [scope, setScope] = useState<"company" | "project">("company");
  const [rows, setRows] = useState<Row[]>([
    { title: "Safety moment", category: "safety", allocatedMinutes: "5" },
    { title: "Minutes of the last meeting", category: "other", allocatedMinutes: "5" },
    { title: "Programme", category: "programme", allocatedMinutes: "20" },
  ]);

  const set = (i: number, patch: Partial<Row>) =>
    setRows(rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));

  async function submit() {
    const items = rows
      .filter((r) => r.title.trim().length > 0)
      .map((r, i) => ({
        title: r.title.trim(),
        category: r.category,
        position: i,
        allocatedMinutes:
          r.allocatedMinutes.trim() === "" ? null : Number(r.allocatedMinutes),
      }));
    const done = await run("create", () =>
      api.post("/api/v1/meeting-agenda-templates", {
        name: name.trim(),
        description: description.trim() || null,
        meetingType,
        projectId: scope === "project" ? projectId : null,
        items,
        contractRequirement: contractRequirement.trim() || null,
      }),
    );
    if (done !== null) onCreated();
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Create an agenda template"
      size="lg"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={name.trim().length === 0 || busy !== null}
            loading={busy === "create"}
            onClick={() => void submit()}
          >
            Create the template
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        {refusal ? (
          <Alert tone="danger" size="sm" title="Refused" onDismiss={clear}>
            <p className="whitespace-pre-wrap">{refusal.message}</p>
          </Alert>
        ) : null}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name" required className="sm:col-span-2">
            <Input
              value={name}
              placeholder="Weekly progress meeting — standard agenda"
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Field label="Standard for">
            <Select value={meetingType} onChange={(e) => setMeetingType(e.target.value)}>
              {MEETING_TYPES.map((t) => (
                <option key={t} value={t}>
                  {titleCase(t)}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label="Scope"
            hint="A company template is available on every project; a project one stays here."
          >
            <Select
              value={scope}
              onChange={(e) => setScope(e.target.value === "project" ? "project" : "company")}
            >
              <option value="company">Company-wide standard</option>
              <option value="project">This project only</option>
            </Select>
          </Field>
          <Field label="Description" className="sm:col-span-2">
            <Textarea
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>
          <Field
            label="Contract basis"
            className="sm:col-span-2"
            hint="The clause this standard discharges, when there is one — e.g. NEC4 cl.31."
          >
            <Input
              value={contractRequirement}
              onChange={(e) => setContractRequirement(e.target.value)}
            />
          </Field>
        </div>

        <Card>
          <CardBody className="space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-sm font-semibold text-content">
                Standing items ({count(rows.length)})
              </p>
              <Button
                size="xs"
                icon={IconPlus}
                onClick={() =>
                  setRows([...rows, { title: "", category: "other", allocatedMinutes: "" }])
                }
              >
                Add item
              </Button>
            </div>
            <ul className="space-y-2">
              {rows.map((r, i) => (
                <li key={i} className="grid gap-2 sm:grid-cols-12">
                  <div className="sm:col-span-6">
                    <Input
                      value={r.title}
                      placeholder="Heading"
                      onChange={(e) => set(i, { title: e.target.value })}
                    />
                  </div>
                  <div className="sm:col-span-3">
                    <Select
                      value={r.category}
                      onChange={(e) => set(i, { category: e.target.value })}
                    >
                      {ITEM_CATEGORIES.map((c) => (
                        <option key={c} value={c}>
                          {titleCase(c)}
                        </option>
                      ))}
                    </Select>
                  </div>
                  <div className="sm:col-span-2">
                    <Input
                      type="number"
                      value={r.allocatedMinutes}
                      placeholder="min"
                      onChange={(e) => set(i, { allocatedMinutes: e.target.value })}
                    />
                  </div>
                  <div className="flex items-center sm:col-span-1">
                    <Button
                      size="xs"
                      variant="ghost"
                      icon={IconTrash}
                      aria-label="Remove"
                      onClick={() => setRows(rows.filter((_, idx) => idx !== i))}
                    />
                  </div>
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      </div>
    </Modal>
  );
}
