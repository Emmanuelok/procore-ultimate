/**
 * ISO 19650 information delivery milestones (spec Domain L #632-636).
 *
 * A milestone is delivered when every information container it requires is at
 * the required CDE state and suitability — the API evaluates that from the
 * model register and refuses the transition otherwise, naming the container
 * that is not there. Acceptance is a separate person's decision and is
 * recorded as such.
 */
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { CDE_STATES, SUITABILITY_CODES } from "@constructos/shared";
import { api, ApiClientError } from "../../lib/api";
import {
  Badge,
  Button,
  Card,
  CardBody,
  Drawer,
  DrawerBody,
  EmptyState,
  ErrorAlert,
  Field,
  Input,
  Modal,
  Select,
  Spinner,
  Table,
  Td,
  Textarea,
  Th,
} from "../../ui";
import { formatDate, humanize } from "../format";
import { CdeBadge, SuitabilityChip, type BimModel, type ListResponse as BimList } from "../bim/bimShared";
import {
  MILESTONE_NEXT_STATUSES,
  type DeliveryMilestone,
  type ListResponse,
  type MilestoneDetail,
} from "./twinShared";

export default function MilestonesTab({
  projectId,
  onChanged,
}: {
  projectId: string;
  onChanged: () => void;
}) {
  const [items, setItems] = useState<DeliveryMilestone[] | null>(null);
  const [models, setModels] = useState<BimModel[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState({
    name: "",
    dueDate: "",
    requiredState: "published",
    requiredSuitability: "A1",
    description: "",
  });
  const [formError, setFormError] = useState<string | null>(null);

  const [detail, setDetail] = useState<MilestoneDetail | null>(null);
  const [containerForm, setContainerForm] = useState({ label: "", modelId: "" });

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api.get<ListResponse<DeliveryMilestone>>(
        `/api/v1/projects/${projectId}/delivery-milestones?pageSize=100`,
      );
      setItems(res.items);
    } catch (err) {
      setItems([]);
      setError(err instanceof Error ? err.message : "Failed to load delivery milestones");
    }
  }, [projectId]);

  useEffect(() => {
    void load();
    api
      .get<BimList<BimModel>>(`/api/v1/projects/${projectId}/bim/models?pageSize=100`)
      .then((res) => setModels(res.items))
      .catch(() => setModels([]));
  }, [load, projectId]);

  async function openDetail(milestoneId: string) {
    setDetail(null);
    try {
      setDetail(
        await api.get<MilestoneDetail>(
          `/api/v1/projects/${projectId}/delivery-milestones/${milestoneId}`,
        ),
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load the milestone");
    }
  }

  async function create(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    setBusy(true);
    try {
      await api.post(`/api/v1/projects/${projectId}/delivery-milestones`, {
        name: form.name.trim(),
        requiredState: form.requiredState,
        ...(form.dueDate ? { dueDate: form.dueDate } : {}),
        ...(form.requiredSuitability ? { requiredSuitability: form.requiredSuitability } : {}),
        ...(form.description.trim() ? { description: form.description.trim() } : {}),
      });
      setCreateOpen(false);
      setForm({
        name: "",
        dueDate: "",
        requiredState: "published",
        requiredSuitability: "A1",
        description: "",
      });
      await load();
      onChanged();
    } catch (err) {
      setFormError(err instanceof ApiClientError ? err.message : "Failed to create the milestone.");
    } finally {
      setBusy(false);
    }
  }

  async function transition(milestone: DeliveryMilestone, status: string) {
    setBusy(true);
    try {
      await api.patch(`/api/v1/projects/${projectId}/delivery-milestones/${milestone.id}`, {
        status,
      });
      toast.success(`Milestone ${humanize(status).toLowerCase()}.`);
      await load();
      if (detail?.id === milestone.id) await openDetail(milestone.id);
      onChanged();
    } catch (err) {
      toast.error(err instanceof ApiClientError ? err.message : "The transition was refused.");
    } finally {
      setBusy(false);
    }
  }

  async function addContainer(e: FormEvent) {
    e.preventDefault();
    if (!detail || !containerForm.modelId) return;
    setBusy(true);
    try {
      await api.post(
        `/api/v1/projects/${projectId}/delivery-milestones/${detail.id}/containers`,
        { label: containerForm.label.trim() || "Model container", modelId: containerForm.modelId },
      );
      setContainerForm({ label: "", modelId: "" });
      await openDetail(detail.id);
      await load();
    } catch (err) {
      toast.error(err instanceof ApiClientError ? err.message : "The container was refused.");
    } finally {
      setBusy(false);
    }
  }

  async function removeContainer(containerId: string) {
    if (!detail) return;
    setBusy(true);
    try {
      await api.del(
        `/api/v1/projects/${projectId}/delivery-milestones/${detail.id}/containers/${containerId}`,
      );
      await openDetail(detail.id);
      await load();
    } catch (err) {
      toast.error(err instanceof ApiClientError ? err.message : "Delete failed.");
    } finally {
      setBusy(false);
    }
  }

  async function remove(milestone: DeliveryMilestone) {
    if (!window.confirm(`Delete "${milestone.name}"?`)) return;
    try {
      await api.del(`/api/v1/projects/${projectId}/delivery-milestones/${milestone.id}`);
      setDetail(null);
      await load();
      onChanged();
    } catch (err) {
      toast.error(err instanceof ApiClientError ? err.message : "Delete failed.");
    }
  }

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-ink-900">Information delivery milestones</h2>
        <Button onClick={() => setCreateOpen(true)}>New milestone</Button>
      </div>

      <ErrorAlert message={error} />

      {items === null ? (
        <Spinner label="Loading milestones…" />
      ) : items.length === 0 ? (
        <EmptyState
          title="No milestones"
          hint="Set out the MIDP: what information is due, when, and at which CDE state — then attach the containers that must be there."
          action={<Button onClick={() => setCreateOpen(true)}>Add a milestone</Button>}
        />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Milestone</Th>
              <Th>Due</Th>
              <Th>Required</Th>
              <Th className="text-right">Containers</Th>
              <Th>Status</Th>
              <Th className="text-right">Actions</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {items.map((m) => (
              <tr key={m.id} className="hover:bg-ink-50/60">
                <Td>
                  <button
                    type="button"
                    className="font-medium text-brand-700 hover:text-brand-800"
                    onClick={() => void openDetail(m.id)}
                  >
                    {m.name}
                  </button>
                  {m.description ? (
                    <div className="text-[11px] text-ink-400">{m.description}</div>
                  ) : null}
                </Td>
                <Td className={m.overdue ? "text-red-600" : undefined}>
                  {m.dueDate ? formatDate(m.dueDate) : "—"}
                </Td>
                <Td>
                  <CdeBadge state={m.requiredState} />{" "}
                  <SuitabilityChip code={m.requiredSuitability} />
                </Td>
                <Td className="text-right tabular-nums">{m.containerCount ?? 0}</Td>
                <Td>
                  <Badge
                    size="sm"
                    tone={
                      m.status === "accepted"
                        ? "success"
                        : m.status === "rejected"
                          ? "danger"
                          : m.status === "delivered"
                            ? "info"
                            : "neutral"
                    }
                  >
                    {humanize(m.status)}
                  </Badge>
                </Td>
                <Td className="text-right">
                  <div className="flex justify-end gap-1">
                    {(MILESTONE_NEXT_STATUSES[m.status] ?? []).map((next) => (
                      <Button
                        key={next}
                        size="sm"
                        variant="secondary"
                        disabled={busy}
                        onClick={() => void transition(m, next)}
                      >
                        {humanize(next)}
                      </Button>
                    ))}
                    <Button size="sm" variant="ghost" onClick={() => void remove(m)}>
                      Delete
                    </Button>
                  </div>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title="New delivery milestone">
        <form onSubmit={create} className="space-y-3">
          <ErrorAlert message={formError} />
          <Field label="Name">
            <Input
              required
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="Stage 4 design freeze information"
            />
          </Field>
          <div className="grid grid-cols-3 gap-3">
            <Field label="Due date">
              <Input
                type="date"
                value={form.dueDate}
                onChange={(e) => setForm({ ...form, dueDate: e.target.value })}
              />
            </Field>
            <Field label="Required state">
              <Select
                value={form.requiredState}
                onChange={(e) => setForm({ ...form, requiredState: e.target.value })}
              >
                {CDE_STATES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Required suitability">
              <Select
                value={form.requiredSuitability}
                onChange={(e) => setForm({ ...form, requiredSuitability: e.target.value })}
              >
                <option value="">Any</option>
                {SUITABILITY_CODES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Field label="Description">
            <Textarea
              rows={2}
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              Create
            </Button>
          </div>
        </form>
      </Modal>

      <Drawer
        open={detail !== null}
        onOpenChange={(open) => !open && setDetail(null)}
        title={detail?.name ?? "Milestone"}
        description="Required information containers and their current state"
        size="md"
      >
        <DrawerBody>
          {detail === null ? (
            <Spinner label="Loading milestone…" />
          ) : (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-2">
                <Badge
                  tone={
                    detail.status === "accepted"
                      ? "success"
                      : detail.status === "rejected"
                        ? "danger"
                        : "neutral"
                  }
                >
                  {humanize(detail.status)}
                </Badge>
                <Badge tone={detail.containersSatisfied ? "success" : "warning"}>
                  {detail.containersSatisfied
                    ? "every container in place"
                    : "containers outstanding"}
                </Badge>
                {detail.dueDate ? <Badge tone="neutral">due {formatDate(detail.dueDate)}</Badge> : null}
              </div>

              <Card>
                <CardBody>
                  <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-500">
                    Containers ({detail.containers.length})
                  </h3>
                  {detail.containers.length === 0 ? (
                    <p className="mb-2 text-xs text-ink-400">
                      No containers attached — the milestone can be marked delivered without an
                      automatic check until one is added.
                    </p>
                  ) : (
                    <ul className="mb-3 space-y-2 text-xs">
                      {detail.containers.map((c) => (
                        <li key={c.id} className="flex items-start justify-between gap-2">
                          <span>
                            <span className="font-medium text-ink-800">{c.label}</span>
                            <span className="block text-ink-500">{c.reason}</span>
                          </span>
                          <span className="flex items-center gap-2">
                            <Badge size="sm" tone={c.satisfied ? "success" : "warning"}>
                              {c.satisfied ? "in place" : "outstanding"}
                            </Badge>
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={busy}
                              onClick={() => void removeContainer(c.id)}
                            >
                              Remove
                            </Button>
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                  <form onSubmit={addContainer} className="space-y-2">
                    <Select
                      value={containerForm.modelId}
                      onChange={(e) =>
                        setContainerForm({ ...containerForm, modelId: e.target.value })
                      }
                    >
                      <option value="">Require a model…</option>
                      {models.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name}
                        </option>
                      ))}
                    </Select>
                    <Input
                      value={containerForm.label}
                      onChange={(e) => setContainerForm({ ...containerForm, label: e.target.value })}
                      placeholder="Label (optional)"
                    />
                    <div className="flex justify-end">
                      <Button size="sm" type="submit" disabled={busy || !containerForm.modelId}>
                        Require this container
                      </Button>
                    </div>
                  </form>
                </CardBody>
              </Card>

              <div className="flex flex-wrap gap-2">
                {(MILESTONE_NEXT_STATUSES[detail.status] ?? []).map((next) => (
                  <Button
                    key={next}
                    size="sm"
                    disabled={busy}
                    onClick={() => void transition(detail, next)}
                  >
                    {humanize(next)}
                  </Button>
                ))}
              </div>
              {detail.acceptedBy ? (
                <p className="text-xs text-ink-500">
                  Accepted {formatDate(detail.acceptedAt)}
                  {detail.decisionNote ? ` — ${detail.decisionNote}` : ""}
                </p>
              ) : null}
            </div>
          )}
        </DrawerBody>
      </Drawer>
    </div>
  );
}
