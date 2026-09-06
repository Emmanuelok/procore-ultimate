/**
 * THE LIBRARY — trades, crafts and plant classes, and the tickets people hold
 * (spec Vol I #676, #692).
 *
 * Nothing else in this workspace works until this tab has something in it.
 * The demand plan buckets by resource type, the histogram draws one row per
 * type, `derive` refuses outright when the project can reach none, and the
 * skills matrix has no columns until a ticket exists. So the library is a
 * first-class surface rather than a settings page somebody has to be told
 * about, and it is the first thing a fresh company is pointed at.
 *
 * Two deliberate refusals:
 *  · `standardHoursPerDay` is left blank unless somebody states it. It is the
 *    only thing that turns hours into a headcount, and an assumed eight-hour
 *    day is how a histogram quietly reports five people where there are eight.
 *  · a ticket with no validity period never enters the expiry sweep, and the
 *    form says so rather than letting somebody assume it is being watched.
 *
 * The library is a COMPANY asset: reading it needs company membership, and
 * changing it needs an owner/admin company role. A member without that role
 * sees the lists and gets the server's refusal, verbatim, on save.
 */
import { useMemo, useState } from "react";
import { toast } from "sonner";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  DataTable,
  Drawer,
  Field,
  Input,
  Modal,
  Select,
  Textarea,
  type DataColumns,
} from "../../ui";
import { IconPlus } from "../../ui/icons";
import {
  LoadError,
  ReasonList,
  Row,
  count,
  num,
  resourcesApi,
  titleCase,
  useAction,
  useResource,
  type Paginated,
  type ResourceSkill,
  type ResourceSkillDetail,
  type ResourceType,
  type ResourceTypeDetail,
} from "./resourcesShared";

const KINDS = ["labour", "equipment", "subcontract"] as const;
const UNITS = ["hours", "days", "shifts", "each"] as const;
const CATEGORIES = ["skill", "certification", "licence", "training"] as const;

export default function LibraryTab({
  projectId,
  onChanged,
}: {
  projectId: string;
  onChanged: () => void;
}) {
  const [nonce, setNonce] = useState(0);
  const [creatingType, setCreatingType] = useState(false);
  const [creatingSkill, setCreatingSkill] = useState(false);
  const [openTypeId, setOpenTypeId] = useState<string | null>(null);
  const [openSkillId, setOpenSkillId] = useState<string | null>(null);

  const types = useResource<Paginated<ResourceType>>(
    `/api/v1/resource-types?pageSize=200&projectId=${projectId}&_=${nonce}`,
  );
  const skills = useResource<Paginated<ResourceSkill>>(
    `/api/v1/resource-skills?pageSize=200&_=${nonce}`,
  );

  const bump = () => {
    setNonce((n) => n + 1);
    onChanged();
  };

  const typeColumns = useMemo<DataColumns<ResourceType>>(
    () => [
      { id: "code", header: "Code", accessor: "code", type: "text", width: 110, mono: true },
      { id: "name", header: "Name", accessor: "name", type: "text", width: 240 },
      {
        id: "kind",
        header: "Kind",
        accessor: (row) => titleCase(row.kind),
        type: "text",
        width: 120,
      },
      {
        id: "trade",
        header: "Trade / class",
        accessor: (row) => row.trade ?? row.equipmentCategory ?? "—",
        type: "text",
        width: 160,
      },
      { id: "unit", header: "Unit", accessor: "unit", type: "text", width: 90 },
      {
        id: "standardHoursPerDay",
        header: "Standard day",
        accessor: (row) => row.standardHoursPerDay,
        type: "number",
        align: "right",
        width: 130,
        cell: ({ row }) =>
          row.standardHoursPerDay === null ? (
            <span className="text-content-subtle" title="No headcount is derived for this type.">
              — no headcount
            </span>
          ) : (
            `${num(row.standardHoursPerDay)} h`
          ),
      },
      {
        id: "scope",
        header: "Scope",
        accessor: (row) => (row.projectId === null ? "Company" : "This project"),
        type: "text",
        width: 120,
      },
      {
        id: "status",
        header: "Status",
        accessor: "status",
        type: "text",
        width: 100,
        cell: ({ row }) => (
          <Badge tone={row.status === "active" ? "success" : "neutral"} size="xs" dot>
            {titleCase(row.status)}
          </Badge>
        ),
      },
    ],
    [],
  );

  const skillColumns = useMemo<DataColumns<ResourceSkill>>(
    () => [
      { id: "code", header: "Code", accessor: "code", type: "text", width: 110, mono: true },
      { id: "name", header: "Name", accessor: "name", type: "text", width: 240 },
      {
        id: "category",
        header: "Category",
        accessor: (row) => titleCase(row.category),
        type: "text",
        width: 130,
      },
      {
        id: "validityMonths",
        header: "Validity",
        accessor: (row) => row.validityMonths,
        type: "number",
        align: "right",
        width: 160,
        cell: ({ row }) =>
          row.validityMonths === null ? (
            <span
              className="text-content-subtle"
              title="No validity period is recorded, so holders of this ticket are never swept for expiry."
            >
              — never swept
            </span>
          ) : (
            `${row.validityMonths} months`
          ),
      },
      {
        id: "isMandatory",
        header: "Mandatory",
        accessor: (row) => (row.isMandatory ? "Yes" : "No"),
        type: "text",
        width: 110,
        cell: ({ row }) =>
          row.isMandatory ? (
            <Badge tone="danger" size="xs">
              Mandatory
            </Badge>
          ) : (
            <span className="text-content-subtle">—</span>
          ),
      },
      {
        id: "status",
        header: "Status",
        accessor: "status",
        type: "text",
        width: 100,
        cell: ({ row }) => (
          <Badge tone={row.status === "active" ? "success" : "neutral"} size="xs" dot>
            {titleCase(row.status)}
          </Badge>
        ),
      },
    ],
    [],
  );

  return (
    <div className="space-y-4">
      <Alert tone="info" size="sm" title="Everything else keys off this list">
        A demand plan buckets by resource type, the histogram draws one row per type, and the
        skills matrix has one column per ticket. Define the trades and plant classes this project
        actually resources against before deriving a plan.
      </Alert>

      <Card>
        <CardHeader
          title="Trades, crafts and plant classes"
          subtitle="The company vocabulary a plan, a histogram and a productivity figure all join on. Codes are unique per company on purpose."
          actions={
            <Button size="sm" icon={IconPlus} onClick={() => setCreatingType(true)}>
              New type
            </Button>
          }
        />
        <CardBody flush>
          {types.error ? (
            <div className="p-4">
              <LoadError message={types.error} onRetry={types.reload} />
            </div>
          ) : (
            <DataTable<ResourceType>
              tableId="resources.library.types"
              data={types.data?.items ?? []}
              columns={typeColumns}
              getRowId={(row) => row.id}
              loading={types.loading && !types.data}
              height={300}
              rowHeight={40}
              stickyHeader
              flush
              toolbar={false}
              empty={{
                title: "No trades or plant classes yet",
                description:
                  "Nothing in this workspace can start without one. Create the trades the programme is resourced in — Concretors, Steel fixers, Tower crane — and the plan, the histogram and the calendar all become available.",
              }}
              onRowClick={({ row }) => setOpenTypeId(row.id)}
              aria-label="Resource types"
            />
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Skills, tickets and certifications"
          subtitle="A skill is a capability; a certification or licence is one somebody external attested to, and it expires. Only entries with a validity period are swept."
          actions={
            <Button size="sm" icon={IconPlus} onClick={() => setCreatingSkill(true)}>
              New ticket
            </Button>
          }
        />
        <CardBody flush>
          {skills.error ? (
            <div className="p-4">
              <LoadError message={skills.error} onRetry={skills.reload} />
            </div>
          ) : (
            <DataTable<ResourceSkill>
              tableId="resources.library.skills"
              data={skills.data?.items ?? []}
              columns={skillColumns}
              getRowId={(row) => row.id}
              loading={skills.loading && !skills.data}
              height={300}
              rowHeight={40}
              stickyHeader
              flush
              toolbar={false}
              empty={{
                title: "No tickets defined",
                description:
                  "The skills matrix has one column per ticket, so until one exists there is nothing to check anybody against. Start with the tickets the work legally requires.",
              }}
              onRowClick={({ row }) => setOpenSkillId(row.id)}
              aria-label="Skills and certifications"
            />
          )}
        </CardBody>
      </Card>

      <TypeModal
        open={creatingType}
        projectId={projectId}
        skills={skills.data?.items ?? []}
        onClose={() => setCreatingType(false)}
        onSaved={() => {
          setCreatingType(false);
          bump();
        }}
      />
      <SkillModal
        open={creatingSkill}
        onClose={() => setCreatingSkill(false)}
        onSaved={() => {
          setCreatingSkill(false);
          bump();
        }}
      />
      <TypeDrawer typeId={openTypeId} onClose={() => setOpenTypeId(null)} onChanged={bump} />
      <SkillDrawer skillId={openSkillId} onClose={() => setOpenSkillId(null)} onChanged={bump} />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Create                                                              */
/* ------------------------------------------------------------------ */

function TypeModal({
  open,
  projectId,
  skills,
  onClose,
  onSaved,
}: {
  open: boolean;
  projectId: string;
  skills: ResourceSkill[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const action = useAction();
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [kind, setKind] = useState<string>("labour");
  const [trade, setTrade] = useState("");
  const [unit, setUnit] = useState<string>("hours");
  const [standardHoursPerDay, setStandardHoursPerDay] = useState("");
  const [workingDaysPerWeek, setWorkingDaysPerWeek] = useState("");
  const [scope, setScope] = useState<"company" | "project">("company");
  const [requiredSkillIds, setRequiredSkillIds] = useState<string[]>([]);

  const toggleSkill = (id: string) =>
    setRequiredSkillIds((held) =>
      held.includes(id) ? held.filter((x) => x !== id) : [...held, id],
    );

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title="New trade or plant class"
      description="One entry per thing you resource against. The code is the join between a plan, a histogram and a productivity figure, so it is unique for the whole company."
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            loading={action.busy === "save"}
            disabled={code.trim() === "" || name.trim() === ""}
            onClick={async () => {
              const res = await action.run("save", () =>
                resourcesApi.createType({
                  code: code.trim().toUpperCase(),
                  name: name.trim(),
                  kind,
                  unit,
                  ...(trade.trim()
                    ? kind === "equipment"
                      ? { equipmentCategory: trade.trim() }
                      : { trade: trade.trim(), mapsToTrade: trade.trim() }
                    : {}),
                  ...(standardHoursPerDay.trim()
                    ? { standardHoursPerDay: Number(standardHoursPerDay) }
                    : {}),
                  ...(workingDaysPerWeek.trim()
                    ? { workingDaysPerWeek: Number(workingDaysPerWeek) }
                    : {}),
                  ...(scope === "project" ? { projectId } : {}),
                  ...(requiredSkillIds.length > 0 ? { requiredSkillIds } : {}),
                }),
              );
              if (res) {
                toast.success(`${res.code} added`);
                setCode("");
                setName("");
                setTrade("");
                setStandardHoursPerDay("");
                setWorkingDaysPerWeek("");
                setRequiredSkillIds([]);
                onSaved();
              }
            }}
          >
            Create
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        {action.error ? (
          <Alert tone="danger" size="sm" onDismiss={action.clear}>
            {action.error}
          </Alert>
        ) : null}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Code" required hint="Short and stable — CONC, SF, CRANE.">
            <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="CONC" />
          </Field>
          <Field label="Name" required>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Concretors" />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field
            label="Kind"
            hint="Hours of one kind never satisfy demand of another — a crane hour does not cover a joiner hour."
          >
            <Select value={kind} onChange={(e) => setKind(e.target.value)}>
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {titleCase(k)}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label={kind === "equipment" ? "Plant category" : "Trade"}
            hint="Matched against the trade on a timecard, so spell it the way the field does."
          >
            <Input value={trade} onChange={(e) => setTrade(e.target.value)} />
          </Field>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <Field
            label="Unit"
            hint="The engines reason in hours. Anything else is stored and shown but never converted."
          >
            <Select value={unit} onChange={(e) => setUnit(e.target.value)}>
              {UNITS.map((u) => (
                <option key={u} value={u}>
                  {titleCase(u)}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label="Standard hours a day"
            hint="Leave blank and headcount reads “—”, never an assumed eight."
          >
            <Input
              type="number"
              value={standardHoursPerDay}
              onChange={(e) => setStandardHoursPerDay(e.target.value)}
              placeholder="—"
            />
          </Field>
          <Field label="Working days a week">
            <Input
              type="number"
              value={workingDaysPerWeek}
              onChange={(e) => setWorkingDaysPerWeek(e.target.value)}
              placeholder="—"
            />
          </Field>
        </div>
        <Field
          label="Where it lives"
          hint="A company type is offered on every project; a project type is offered only on this one."
        >
          <Select
            value={scope}
            onChange={(e) => setScope(e.target.value === "project" ? "project" : "company")}
          >
            <option value="company">Company library</option>
            <option value="project">This project only</option>
          </Select>
        </Field>
        {skills.length > 0 ? (
          <Field
            label="Tickets this type requires"
            hint="A booking made against this type is checked for these; nothing else is."
          >
            <div className="max-h-40 space-y-1 overflow-y-auto rounded-md border border-border-subtle p-2">
              {skills.map((s) => (
                <label key={s.id} className="flex items-center gap-2 text-meta text-content">
                  <input
                    type="checkbox"
                    checked={requiredSkillIds.includes(s.id)}
                    onChange={() => toggleSkill(s.id)}
                  />
                  {s.code} — {s.name}
                </label>
              ))}
            </div>
          </Field>
        ) : null}
      </div>
    </Modal>
  );
}

function SkillModal({
  open,
  onClose,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const action = useAction();
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [category, setCategory] = useState<string>("certification");
  const [issuingBody, setIssuingBody] = useState("");
  const [validityMonths, setValidityMonths] = useState("");
  const [isMandatory, setIsMandatory] = useState(false);
  const [requiresEvidence, setRequiresEvidence] = useState(true);
  const [description, setDescription] = useState("");

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New skill or certification"
      description="A skill is a capability. A certification or licence is one somebody external attested to — and only those with a validity period are ever swept for expiry."
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            loading={action.busy === "save"}
            disabled={code.trim() === "" || name.trim() === ""}
            onClick={async () => {
              const res = await action.run("save", () =>
                resourcesApi.createSkill({
                  code: code.trim().toUpperCase(),
                  name: name.trim(),
                  category,
                  isMandatory,
                  requiresEvidence,
                  ...(issuingBody.trim() ? { issuingBody: issuingBody.trim() } : {}),
                  ...(description.trim() ? { description: description.trim() } : {}),
                  ...(validityMonths.trim() ? { validityMonths: Number(validityMonths) } : {}),
                }),
              );
              if (res) {
                toast.success(`${res.code} added`);
                setCode("");
                setName("");
                setIssuingBody("");
                setValidityMonths("");
                setDescription("");
                onSaved();
              }
            }}
          >
            Create
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        {action.error ? (
          <Alert tone="danger" size="sm" onDismiss={action.clear}>
            {action.error}
          </Alert>
        ) : null}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Code" required>
            <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="MEWP" />
          </Field>
          <Field label="Name" required>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="MEWP operator"
            />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Category">
            <Select value={category} onChange={(e) => setCategory(e.target.value)}>
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {titleCase(c)}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label="Valid for (months)"
            hint="Blank means no expiry is tracked — holders are never swept, which is not the same as “never expires”."
          >
            <Input
              type="number"
              value={validityMonths}
              onChange={(e) => setValidityMonths(e.target.value)}
              placeholder="—"
            />
          </Field>
        </div>
        <Field label="Issuing body">
          <Input value={issuingBody} onChange={(e) => setIssuingBody(e.target.value)} />
        </Field>
        <Field label="What it covers">
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
          />
        </Field>
        <div className="flex flex-wrap gap-4">
          <label className="flex items-center gap-2 text-meta text-content">
            <input
              type="checkbox"
              checked={isMandatory}
              onChange={(e) => setIsMandatory(e.target.checked)}
            />
            Mandatory — a gap is reported as critical
          </label>
          <label className="flex items-center gap-2 text-meta text-content">
            <input
              type="checkbox"
              checked={requiresEvidence}
              onChange={(e) => setRequiresEvidence(e.target.checked)}
            />
            Evidence required before it counts as checked
          </label>
        </div>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Edit                                                                */
/* ------------------------------------------------------------------ */

function TypeDrawer({
  typeId,
  onClose,
  onChanged,
}: {
  typeId: string | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const action = useAction();
  const [nonce, setNonce] = useState(0);
  const detail = useResource<ResourceTypeDetail>(
    typeId ? `/api/v1/resource-types/${typeId}?_=${nonce}` : null,
  );
  const t = detail.data;

  const save = async (body: Record<string, unknown>, label: string) => {
    if (!t) return;
    const res = await action.run(label, () => resourcesApi.patchType(t.id, body));
    if (res) {
      toast.success(`${t.code} updated`);
      setNonce((n) => n + 1);
      onChanged();
    }
  };

  return (
    <Drawer
      open={typeId !== null}
      onClose={onClose}
      size="md"
      title={t ? `${t.code} — ${t.name}` : "Resource type"}
      description={t ? `${titleCase(t.kind)} · measured in ${t.unit}` : null}
    >
      {detail.error ? (
        <LoadError message={detail.error} onRetry={detail.reload} />
      ) : !t ? (
        <div className="py-8 text-center text-meta text-content-subtle">Loading…</div>
      ) : (
        <div className="space-y-4">
          {action.error ? (
            <Alert tone="danger" size="sm" onDismiss={action.clear}>
              {action.error}
            </Alert>
          ) : null}

          <Card>
            <CardBody>
              <dl className="divide-y divide-border-subtle">
                <Row label="Trade / plant class">{t.trade ?? t.equipmentCategory ?? "—"}</Row>
                <Row label="Standard day">
                  {t.standardHoursPerDay === null ? "—" : `${num(t.standardHoursPerDay)} h`}
                </Row>
                <Row label="Working days a week">
                  {t.workingDaysPerWeek === null ? "—" : num(t.workingDaysPerWeek)}
                </Row>
                <Row label="Scope">{t.projectId === null ? "Company library" : "This project"}</Row>
                <Row label="Demand rows using it">{count(t.usage.demandRows)}</Row>
                <Row label="Supply rows using it">{count(t.usage.availabilityRows)}</Row>
              </dl>
              <ReasonList reasons={[t.headcountBasis]} className="mt-2" />
            </CardBody>
          </Card>

          <EditTypeForm type={t} onSave={save} busy={action.busy} />

          <Card>
            <CardHeader
              title="Tickets it requires"
              subtitle="A booking made against this type is checked for these"
            />
            <CardBody>
              {t.requiredSkills.length === 0 ? (
                <p className="text-meta text-content-subtle">
                  None. Bookings on this type are not certification-checked.
                </p>
              ) : (
                <ul className="space-y-1 text-meta text-content">
                  {t.requiredSkills.map((s) => (
                    <li key={s.id}>
                      {s.code} — {s.name}
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>

          <Button
            size="sm"
            variant={t.status === "active" ? "ghost" : "secondary"}
            loading={action.busy === "status"}
            onClick={() => save({ status: t.status === "active" ? "archived" : "active" }, "status")}
          >
            {t.status === "active" ? "Archive this type" : "Restore this type"}
          </Button>
        </div>
      )}
    </Drawer>
  );
}

function EditTypeForm({
  type,
  onSave,
  busy,
}: {
  type: ResourceTypeDetail;
  onSave: (body: Record<string, unknown>, label: string) => Promise<void>;
  busy: string | null;
}) {
  const [name, setName] = useState(type.name);
  const [standardHoursPerDay, setStandardHoursPerDay] = useState(
    type.standardHoursPerDay === null ? "" : String(type.standardHoursPerDay),
  );
  const [workingDaysPerWeek, setWorkingDaysPerWeek] = useState(
    type.workingDaysPerWeek === null ? "" : String(type.workingDaysPerWeek),
  );

  return (
    <Card>
      <CardHeader
        title="Edit"
        subtitle="The code never changes: plans, histograms and productivity rows already join on it."
      />
      <CardBody className="space-y-3">
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field
            label="Standard hours a day"
            hint="Clearing it makes headcount read “—” again rather than an assumed figure."
          >
            <Input
              type="number"
              value={standardHoursPerDay}
              onChange={(e) => setStandardHoursPerDay(e.target.value)}
              placeholder="—"
            />
          </Field>
          <Field label="Working days a week">
            <Input
              type="number"
              value={workingDaysPerWeek}
              onChange={(e) => setWorkingDaysPerWeek(e.target.value)}
              placeholder="—"
            />
          </Field>
        </div>
        <Button
          size="sm"
          loading={busy === "edit"}
          disabled={name.trim() === ""}
          onClick={() =>
            onSave(
              {
                name: name.trim(),
                standardHoursPerDay:
                  standardHoursPerDay.trim() === "" ? null : Number(standardHoursPerDay),
                workingDaysPerWeek:
                  workingDaysPerWeek.trim() === "" ? null : Number(workingDaysPerWeek),
              },
              "edit",
            )
          }
        >
          Save changes
        </Button>
      </CardBody>
    </Card>
  );
}

function SkillDrawer({
  skillId,
  onClose,
  onChanged,
}: {
  skillId: string | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const action = useAction();
  const [nonce, setNonce] = useState(0);
  const detail = useResource<ResourceSkillDetail>(
    skillId ? `/api/v1/resource-skills/${skillId}?_=${nonce}` : null,
  );
  const s = detail.data;

  const save = async (body: Record<string, unknown>, label: string) => {
    if (!s) return;
    const res = await action.run(label, () => resourcesApi.patchSkill(s.id, body));
    if (res) {
      toast.success(`${s.code} updated`);
      setNonce((n) => n + 1);
      onChanged();
    }
  };

  return (
    <Drawer
      open={skillId !== null}
      onClose={onClose}
      size="md"
      title={s ? `${s.code} — ${s.name}` : "Ticket"}
      description={s ? titleCase(s.category) : null}
    >
      {detail.error ? (
        <LoadError message={detail.error} onRetry={detail.reload} />
      ) : !s ? (
        <div className="py-8 text-center text-meta text-content-subtle">Loading…</div>
      ) : (
        <div className="space-y-4">
          {action.error ? (
            <Alert tone="danger" size="sm" onDismiss={action.clear}>
              {action.error}
            </Alert>
          ) : null}
          <Card>
            <CardBody>
              <dl className="divide-y divide-border-subtle">
                <Row label="People holding it">{count(s.holderCount)}</Row>
                <Row label="Issuing body">{s.issuingBody ?? "—"}</Row>
                <Row label="Mandatory">{s.isMandatory ? "Yes" : "No"}</Row>
                <Row label="Evidence required">{s.requiresEvidence ? "Yes" : "No"}</Row>
              </dl>
              <ReasonList
                reasons={[
                  s.validityMonths === null
                    ? "No validity period is recorded, so holders of this ticket never enter the expiry sweep. That is not the same as “does not expire”."
                    : `Valid for ${s.validityMonths} month(s) from issue; holders are swept and warned 30 days out.`,
                ]}
                className="mt-2"
              />
            </CardBody>
          </Card>

          <EditSkillForm skill={s} onSave={save} busy={action.busy} />

          <Button
            size="sm"
            variant={s.status === "active" ? "ghost" : "secondary"}
            loading={action.busy === "status"}
            onClick={() => save({ status: s.status === "active" ? "archived" : "active" }, "status")}
          >
            {s.status === "active" ? "Archive this ticket" : "Restore this ticket"}
          </Button>
        </div>
      )}
    </Drawer>
  );
}

function EditSkillForm({
  skill,
  onSave,
  busy,
}: {
  skill: ResourceSkillDetail;
  onSave: (body: Record<string, unknown>, label: string) => Promise<void>;
  busy: string | null;
}) {
  const [name, setName] = useState(skill.name);
  const [issuingBody, setIssuingBody] = useState(skill.issuingBody ?? "");
  const [validityMonths, setValidityMonths] = useState(
    skill.validityMonths === null ? "" : String(skill.validityMonths),
  );
  const [isMandatory, setIsMandatory] = useState(skill.isMandatory === 1);

  return (
    <Card>
      <CardHeader title="Edit" subtitle="The code never changes: matrix cells already join on it." />
      <CardBody className="space-y-3">
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Issuing body">
            <Input value={issuingBody} onChange={(e) => setIssuingBody(e.target.value)} />
          </Field>
          <Field
            label="Valid for (months)"
            hint="Clearing it removes every holder from the expiry sweep."
          >
            <Input
              type="number"
              value={validityMonths}
              onChange={(e) => setValidityMonths(e.target.value)}
              placeholder="—"
            />
          </Field>
        </div>
        <label className="flex items-center gap-2 text-meta text-content">
          <input
            type="checkbox"
            checked={isMandatory}
            onChange={(e) => setIsMandatory(e.target.checked)}
          />
          Mandatory — a gap is reported as critical
        </label>
        <Button
          size="sm"
          loading={busy === "edit"}
          disabled={name.trim() === ""}
          onClick={() =>
            onSave(
              {
                name: name.trim(),
                issuingBody: issuingBody.trim() === "" ? null : issuingBody.trim(),
                validityMonths: validityMonths.trim() === "" ? null : Number(validityMonths),
                isMandatory,
              },
              "edit",
            )
          }
        >
          Save changes
        </Button>
      </CardBody>
    </Card>
  );
}
