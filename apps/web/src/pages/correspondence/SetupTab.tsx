/**
 * SETUP — the correspondence types this tenant issues under (#440, #445) and
 * the action plan template library (#447).
 *
 * A type decides four things a letter cannot decide for itself: its reference
 * prefix and sequence, whether a response is expected and in how many days,
 * whether the record is a contractual act, and which approvals stand between
 * a draft and an issued letter. Getting these wrong later is expensive, so
 * the screen states each consequence next to the control that sets it.
 */
import { useEffect, useMemo, useState, type FormEvent } from "react";
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
  Select,
  Textarea,
  toast,
  type DataColumns,
} from "../../ui";
import { IconPlus, IconWorkflow } from "../../ui/icons";
import {
  DASH,
  DIRECTIONS,
  LoadError,
  Row,
  corrApi,
  count,
  days,
  titleCase,
  useAction,
  useResource,
  useTypes,
  type ActionPlanTemplate,
  type CorrespondenceType,
} from "./correspondenceShared";

export default function SetupTab({
  projectId,
  onChanged,
}: {
  projectId: string;
  onChanged: () => void;
}) {
  const types = useTypes(projectId);
  const planTemplates = useResource<{ items: ActionPlanTemplate[] }>(
    `/api/v1/correspondence/action-plan-templates?projectId=${projectId}`,
  );
  const action = useAction();
  const [creating, setCreating] = useState(false);
  const [openType, setOpenType] = useState<CorrespondenceType | null>(null);

  const columns = useMemo<DataColumns<CorrespondenceType>>(
    () => [
      { id: "prefix", header: "Prefix", accessor: "prefix", type: "code", width: 90, mono: true },
      { id: "name", header: "Type", accessor: "name", type: "text", width: 220 },
      { id: "key", header: "Key", accessor: "key", type: "code", width: 150, mono: true },
      {
        id: "response",
        header: "Response expected",
        accessor: (r) => (r.requiresResponse === 1 ? (r.responseDays ?? 0) : -1),
        type: "text",
        width: 180,
        cell: ({ row }) =>
          row.requiresResponse === 1 ? (
            <span>
              within {row.responseDays === null ? DASH : days(row.responseDays)}
              {row.createsObligation === 1 ? (
                <Badge tone="info" size="xs" className="ml-1" title="An obligation is opened at issue">
                  obligation
                </Badge>
              ) : null}
            </span>
          ) : (
            <span className="text-content-subtle">not chased</span>
          ),
      },
      {
        id: "isContractual",
        header: "Contractual",
        accessor: (r) => (r.isContractual === 1 ? "yes" : "no"),
        type: "text",
        width: 110,
        cell: ({ row }) =>
          row.isContractual === 1 ? (
            <Badge tone="accent" size="xs">
              contractual
            </Badge>
          ) : (
            <span className="text-content-subtle">{DASH}</span>
          ),
      },
      {
        id: "approvals",
        header: "Approval steps",
        accessor: (r) => r.approvalSteps.length,
        type: "number",
        align: "right",
        width: 130,
        cell: ({ row }) =>
          row.approvalSteps.length === 0 ? (
            <span className="text-content-subtle">{DASH}</span>
          ) : (
            <span title={row.approvalSteps.map((s) => s.name).join(" → ")}>
              {row.approvalSteps.length}
            </span>
          ),
      },
      {
        id: "letterCount",
        header: "Letters",
        accessor: (r) => r.letterCount ?? 0,
        type: "number",
        align: "right",
        width: 90,
      },
      {
        id: "scope",
        header: "Scope",
        accessor: (r) => (r.projectId === null ? "Company-wide" : "This project"),
        type: "text",
        width: 130,
      },
    ],
    [],
  );

  async function seed() {
    const result = await action.run("seed", () => corrApi.seedTypes());
    if (result) {
      toast.success(
        result.created.length > 0
          ? `Seeded ${result.created.length} type(s): ${result.created.join(", ")}.`
          : "Everything in the default library already exists.",
      );
      types.reload();
      onChanged();
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title="Correspondence types"
          subtitle="What a letter IS in this tenant: its numbering, its response period, whether it is a contractual act, and the approvals it must pass."
          actions={
            <div className="flex gap-2">
              <Button variant="ghost" loading={action.busy === "seed"} onClick={seed}>
                Seed the default library
              </Button>
              <Button icon={IconPlus} onClick={() => setCreating(true)}>
                New type
              </Button>
            </div>
          }
        />
        <CardBody>
          {action.error ? <Alert tone="danger" size="sm">{action.error}</Alert> : null}
          {types.error ? (
            <LoadError message={types.error} onRetry={types.reload} />
          ) : (
            <DataTable<CorrespondenceType>
              tableId="correspondence.types"
              data={types.data?.items ?? []}
              columns={columns}
              getRowId={(row) => row.id}
              loading={types.loading && !types.data}
              height={360}
              rowHeight={44}
              stickyHeader
              exportFileName="correspondence-types"
              empty={{
                title: "No correspondence types configured",
                description:
                  "Nothing can be written until the tenant has at least one type. Seed the default library — general letter, instruction, notice, EOT notice and technical query — and adjust from there.",
                action: (
                  <Button loading={action.busy === "seed"} onClick={seed}>
                    Seed the default library
                  </Button>
                ),
              }}
              onRowClick={({ row }) => setOpenType(row)}
              rowTone={(row) => (row.isActive === 0 ? "warning" : undefined)}
              aria-label="Correspondence types"
            />
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Action plan templates"
          subtitle="The library a plan is built from: required activities, evidence requirements and who must sign."
          icon={IconWorkflow}
        />
        <CardBody>
          {planTemplates.error ? (
            <LoadError message={planTemplates.error} onRetry={planTemplates.reload} />
          ) : (planTemplates.data?.items ?? []).length === 0 ? (
            <p className="text-meta text-content-subtle">
              No templates yet. A plan can also be built ad hoc on the Action plans tab; a template is
              how the same set of checks gets applied every time.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {(planTemplates.data?.items ?? []).map((t) => (
                <li key={t.id} className="flex items-center justify-between gap-3 py-2">
                  <div className="min-w-0">
                    <div className="truncate text-meta text-content">{t.name}</div>
                    <div className="truncate text-2xs text-content-subtle">
                      <span className="font-mono">{t.key}</span> · v{t.version} ·{" "}
                      {count(t.activityCount ?? 0)} activities
                      {t.category ? ` · ${t.category}` : ""}
                    </div>
                  </div>
                  <Badge tone={t.isActive === 1 ? "success" : "neutral"} size="xs">
                    {t.isActive === 1 ? "Active" : "Inactive"}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      <TypeCreateDrawer
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={() => {
          setCreating(false);
          types.reload();
          onChanged();
        }}
      />

      <Drawer
        open={openType !== null}
        onClose={() => setOpenType(null)}
        size="sm"
        title={openType ? openType.name : "Correspondence type"}
        description={openType ? `Prefix ${openType.prefix}` : undefined}
      >
        {openType ? (
          <div className="space-y-4">
            <dl className="divide-y divide-border">
              <Row label="Key">
                <span className="font-mono text-2xs">{openType.key}</span>
              </Row>
              <Row label="Default direction">{titleCase(openType.defaultDirection)}</Row>
              <Row label="Response expected">
                {openType.requiresResponse === 1
                  ? `within ${openType.responseDays === null ? DASH : days(openType.responseDays)}`
                  : "No"}
              </Row>
              <Row
                label="Opens an obligation"
                hint="An obligation is what makes the deadline visible to the assurance layer"
              >
                {openType.createsObligation === 1 ? "Yes" : "No"}
              </Row>
              <Row label="Contractual">{openType.isContractual === 1 ? "Yes" : "No"}</Row>
              <Row label="Letters written">{count(openType.letterCount ?? 0)}</Row>
              <Row label="Active">{openType.isActive === 1 ? "Yes" : "No — cannot be used for new letters"}</Row>
            </dl>
            {openType.description ? (
              <p className="text-meta text-content-muted">{openType.description}</p>
            ) : null}
            {openType.approvalSteps.length > 0 ? (
              <section>
                <h3 className="mb-1 text-meta font-semibold text-content">Approval workflow</h3>
                <ol className="space-y-1 text-meta text-content-muted">
                  {openType.approvalSteps.map((s, i) => (
                    <li key={i}>
                      {i + 1}. {s.name}
                      {s.role ? ` — requires the ${s.role} role` : ""}
                    </li>
                  ))}
                </ol>
                <p className="mt-1 text-2xs text-content-subtle">
                  The author of a letter can never satisfy one of its own approval steps.
                </p>
              </section>
            ) : null}
          </div>
        ) : null}
      </Drawer>
    </div>
  );
}

function TypeCreateDrawer({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const action = useAction();
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const [prefix, setPrefix] = useState("");
  const [description, setDescription] = useState("");
  const [defaultDirection, setDefaultDirection] = useState("outbound");
  const [requiresResponse, setRequiresResponse] = useState(true);
  const [responseDays, setResponseDays] = useState("14");
  const [isContractual, setIsContractual] = useState(false);
  const [createsObligation, setCreatesObligation] = useState(true);
  const [approvalRole, setApprovalRole] = useState("");

  useEffect(() => {
    if (!open) return;
    setKey("");
    setName("");
    setPrefix("");
    setDescription("");
    setDefaultDirection("outbound");
    setRequiresResponse(true);
    setResponseDays("14");
    setIsContractual(false);
    setCreatesObligation(true);
    setApprovalRole("");
    action.clear();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const payload: Record<string, unknown> = {
      key: key.trim(),
      name: name.trim(),
      prefix: prefix.trim().toUpperCase(),
      defaultDirection,
      requiresResponse,
      responseDays: requiresResponse ? Number(responseDays) : null,
      isContractual,
      createsObligation,
      approvalSteps: approvalRole
        ? [{ name: `${titleCase(approvalRole)} approval`, role: approvalRole }]
        : [],
    };
    if (description.trim()) payload["description"] = description.trim();
    const created = await action.run("create", () => corrApi.createType(payload));
    if (created) {
      toast.success(`"${created.name}" added — letters will be numbered ${created.prefix}-001.`);
      onCreated();
    }
  }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      size="md"
      title="New correspondence type"
      description="Configuration, not project data: it applies to every project unless you say otherwise."
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="corr-type-create" loading={action.busy === "create"}>
            Add type
          </Button>
        </div>
      }
    >
      <form id="corr-type-create" onSubmit={submit} className="space-y-4">
        {action.error ? <Alert tone="danger" size="sm">{action.error}</Alert> : null}
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Key" required hint="Lower case">
            <Input value={key} onChange={(e) => setKey(e.target.value)} required />
          </Field>
          <Field label="Name" required>
            <Input value={name} onChange={(e) => setName(e.target.value)} required />
          </Field>
          <Field label="Prefix" required hint="LTR-001">
            <Input value={prefix} onChange={(e) => setPrefix(e.target.value)} required maxLength={12} />
          </Field>
        </div>
        <Field label="Description">
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Default direction">
            <Select value={defaultDirection} onChange={(e) => setDefaultDirection(e.target.value)}>
              {DIRECTIONS.map((d) => (
                <option key={d} value={d}>
                  {titleCase(d)}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label="Response period (days)"
            required={requiresResponse}
            hint={requiresResponse ? "The register will chase this deadline" : "Not chased"}
          >
            <Input
              type="number"
              min={0}
              disabled={!requiresResponse}
              value={responseDays}
              onChange={(e) => setResponseDays(e.target.value)}
            />
          </Field>
        </div>
        <div className="space-y-2">
          <label className="flex items-center gap-2 text-meta text-content-muted">
            <input
              type="checkbox"
              checked={requiresResponse}
              onChange={(e) => setRequiresResponse(e.target.checked)}
            />
            A response is expected
          </label>
          <label className="flex items-center gap-2 text-meta text-content-muted">
            <input
              type="checkbox"
              checked={createsObligation}
              disabled={!requiresResponse}
              onChange={(e) => setCreatesObligation(e.target.checked)}
            />
            Open an assurance obligation for the response deadline
          </label>
          <label className="flex items-center gap-2 text-meta text-content-muted">
            <input
              type="checkbox"
              checked={isContractual}
              onChange={(e) => setIsContractual(e.target.checked)}
            />
            This type is a contractual act (a notice served under the contract)
          </label>
        </div>
        <Field
          label="Approval before issue"
          hint="The author can never satisfy their own letter's approval step."
        >
          <Select value={approvalRole} onChange={(e) => setApprovalRole(e.target.value)}>
            <option value="">No approval needed</option>
            <option value="admin">A company admin must approve</option>
            <option value="owner">The company owner must approve</option>
          </Select>
        </Field>
      </form>
    </Drawer>
  );
}
