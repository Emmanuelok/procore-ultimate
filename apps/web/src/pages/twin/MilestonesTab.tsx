/**
 * ISO 19650 information delivery milestones (MIDP/TIDP) — the delivery
 * checklist with due dates, required CDE state/suitability and an
 * open → delivered → accepted/rejected acceptance flow (spec Domain L
 * #632-636).
 */
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { CDE_STATES, SUITABILITY_CODES } from "@constructos/shared";
import { api, ApiClientError } from "../../lib/api";
import {
  Badge,
  Button,
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
  statusTone,
} from "../../ui";
import { formatDate, humanize } from "../format";
import { CdeBadge, SuitabilityChip } from "../bim/bimShared";
import {
  MILESTONE_NEXT_STATUSES,
  type DeliveryMilestone,
  type ListResponse,
} from "./twinShared";

export default function MilestonesTab({ projectId }: { projectId: string }) {
  const [items, setItems] = useState<DeliveryMilestone[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState({
    name: "",
    dueDate: "",
    requiredState: "published",
    requiredSuitability: "",
    description: "",
  });
  const [createError, setCreateError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api.get<ListResponse<DeliveryMilestone>>(
        `/api/v1/projects/${projectId}/delivery-milestones?pageSize=100`,
      );
      setItems(res.items);
    } catch (err) {
      setItems([]);
      setError(err instanceof Error ? err.message : "Failed to load milestones");
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setCreateError(null);
    setBusy(true);
    try {
      const payload: Record<string, unknown> = {
        name: form.name.trim(),
        requiredState: form.requiredState,
      };
      if (form.dueDate) payload["dueDate"] = form.dueDate;
      if (form.requiredSuitability) payload["requiredSuitability"] = form.requiredSuitability;
      if (form.description.trim()) payload["description"] = form.description.trim();
      await api.post(`/api/v1/projects/${projectId}/delivery-milestones`, payload);
      setCreateOpen(false);
      setForm({
        name: "",
        dueDate: "",
        requiredState: "published",
        requiredSuitability: "",
        description: "",
      });
      await load();
    } catch (err) {
      setCreateError(
        err instanceof ApiClientError ? err.message : "Failed to create the milestone.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function onStatus(milestone: DeliveryMilestone, status: string) {
    if (!status) return;
    setError(null);
    try {
      await api.patch(`/api/v1/projects/${projectId}/delivery-milestones/${milestone.id}`, {
        status,
      });
      await load();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Status change failed.");
    }
  }

  const today = new Date().toISOString().slice(0, 10);

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <span className="text-xs text-ink-400">
          Which information containers are due, when, and at what CDE state / suitability —
          delivered against the MIDP and formally accepted or rejected.
        </span>
        <Button onClick={() => setCreateOpen(true)}>New milestone</Button>
      </div>

      <ErrorAlert message={error} />

      {items === null ? (
        <Spinner label="Loading milestones…" />
      ) : items.length === 0 ? (
        <EmptyState
          title="No delivery milestones"
          hint="Seed the ISO 19650 delivery plan: each milestone names the information deliverable, its due date and the required container state."
          action={<Button onClick={() => setCreateOpen(true)}>Add the first milestone</Button>}
        />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Deliverable</Th>
              <Th>Due</Th>
              <Th>Required state</Th>
              <Th>Suitability</Th>
              <Th>Status</Th>
              <Th>Action</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {items.map((m) => {
              const overdue = m.status === "open" && m.dueDate !== null && m.dueDate < today;
              const next = MILESTONE_NEXT_STATUSES[m.status] ?? [];
              return (
                <tr key={m.id} className="hover:bg-ink-50/60">
                  <Td>
                    <div className="font-medium text-ink-900">{m.name}</div>
                    {m.description ? (
                      <div className="max-w-md truncate text-xs text-ink-400">{m.description}</div>
                    ) : null}
                  </Td>
                  <Td className={overdue ? "font-medium text-red-600" : ""}>
                    {formatDate(m.dueDate)}
                    {overdue ? " · overdue" : ""}
                  </Td>
                  <Td>
                    <CdeBadge state={m.requiredState} />
                  </Td>
                  <Td>
                    <SuitabilityChip code={m.requiredSuitability} />
                  </Td>
                  <Td>
                    <Badge tone={statusTone(m.status)}>{humanize(m.status)}</Badge>
                  </Td>
                  <Td>
                    {next.length > 0 ? (
                      <Select
                        className="w-32 py-1 text-xs"
                        value=""
                        onChange={(e) => void onStatus(m, e.target.value)}
                      >
                        <option value="">Move to…</option>
                        {next.map((s) => (
                          <option key={s} value={s}>
                            {humanize(s)}
                          </option>
                        ))}
                      </Select>
                    ) : (
                      <span className="text-xs text-ink-300">—</span>
                    )}
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}

      <Modal open={createOpen} title="New delivery milestone" onClose={() => setCreateOpen(false)}>
        <ErrorAlert message={createError} />
        <form onSubmit={onCreate} className="space-y-4">
          <Field label="Deliverable name">
            <Input
              required
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="Stage 4 federated model — published"
            />
          </Field>
          <div className="grid grid-cols-3 gap-4">
            <Field label="Due date">
              <Input
                type="date"
                value={form.dueDate}
                onChange={(e) => setForm((f) => ({ ...f, dueDate: e.target.value }))}
              />
            </Field>
            <Field label="Required state">
              <Select
                value={form.requiredState}
                onChange={(e) => setForm((f) => ({ ...f, requiredState: e.target.value }))}
              >
                {CDE_STATES.map((s) => (
                  <option key={s} value={s}>
                    {humanize(s)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Suitability">
              <Select
                value={form.requiredSuitability}
                onChange={(e) => setForm((f) => ({ ...f, requiredSuitability: e.target.value }))}
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
              value={form.description}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              placeholder="Level of Information Need, exchange requirements, acceptance criteria…"
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !form.name.trim()}>
              {busy ? "Creating…" : "Create milestone"}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
