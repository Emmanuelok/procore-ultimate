/**
 * 4D / 5D tab — elements bound to programme tasks and budget lines
 * (spec #238-239).
 *
 * The interesting number here is coverage: how much of the current model is
 * actually tied to the programme and the cost report, and what the model says
 * about a budget line's quantity compared with what the budget says. Where a
 * quantity cannot be summed (mixed units, no measured link) the reason is
 * shown instead of a total.
 */
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { api, ApiClientError } from "../../lib/api";
import {
  Button,
  Card,
  CardBody,
  EmptyState,
  ErrorAlert,
  Field,
  Input,
  Modal,
  Select,
  Spinner,
  Stat,
  Table,
  Td,
  Th,
} from "../../ui";
import { formatDate } from "../format";
import type { BimSummary, FiveDLine, FourDTask } from "./bimShared";

interface FourDResponse {
  items: FourDTask[];
  total: number;
  linkedElements: number;
  currentModelElements: number;
  unlinkedElements: number;
}

export default function LinksTab({
  projectId,
  summary,
}: {
  projectId: string;
  summary: BimSummary | null;
}) {
  const [fourD, setFourD] = useState<FourDResponse | null>(null);
  const [fiveD, setFiveD] = useState<{ items: FiveDLine[]; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    linkType: "schedule_task",
    targetId: "",
    globalIds: "",
    quantity: "",
    unit: "",
  });
  const [linkError, setLinkError] = useState<string | null>(null);
  const [linkResult, setLinkResult] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [four, five] = await Promise.all([
        api.get<FourDResponse>(`/api/v1/projects/${projectId}/bim/4d`),
        api.get<{ items: FiveDLine[]; total: number }>(`/api/v1/projects/${projectId}/bim/5d`),
      ]);
      setFourD(four);
      setFiveD(five);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load links");
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function createLink(e: FormEvent) {
    e.preventDefault();
    setLinkError(null);
    setLinkResult(null);
    setBusy(true);
    try {
      const globalIds = form.globalIds
        .split(/[\s,]+/)
        .map((g) => g.trim())
        .filter(Boolean);
      if (globalIds.length === 0) throw new Error("Paste at least one IFC GlobalId");
      const payload: Record<string, unknown> = {
        linkType: form.linkType,
        targetId: form.targetId.trim(),
        globalIds,
      };
      if (form.quantity) payload["quantity"] = Number(form.quantity);
      if (form.unit) payload["unit"] = form.unit.trim();
      const res = await api.post<{ linked: number; skippedExisting: number; unknownGlobalIds: string[] }>(
        `/api/v1/projects/${projectId}/bim/links`,
        payload,
      );
      setLinkResult(
        `${res.linked} element(s) linked${res.skippedExisting > 0 ? `, ${res.skippedExisting} already linked` : ""}${
          res.unknownGlobalIds.length > 0
            ? `, ${res.unknownGlobalIds.length} GlobalId(s) are not in any model of this project`
            : ""
        }.`,
      );
      toast.success(`${res.linked} element(s) linked.`);
      await load();
    } catch (err) {
      setLinkError(
        err instanceof ApiClientError ? err.message : err instanceof Error ? err.message : "Linking failed.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="mb-4 grid grid-cols-2 gap-4 md:grid-cols-4">
        <Card>
          <CardBody>
            <Stat
              label="4D coverage"
              value={summary?.fourDCoverage !== null && summary?.fourDCoverage !== undefined ? `${summary.fourDCoverage}%` : "—"}
              hint={summary?.fourDCoverageBasis ?? "not available"}
            />
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <Stat
              label="5D coverage"
              value={summary?.fiveDCoverage !== null && summary?.fiveDCoverage !== undefined ? `${summary.fiveDCoverage}%` : "—"}
              hint="elements linked to a budget line"
            />
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <Stat
              label="Linked elements"
              value={fourD ? fourD.linkedElements.toLocaleString() : "—"}
              hint={fourD ? `${fourD.unlinkedElements.toLocaleString()} not on the programme` : ""}
            />
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <Stat
              label="Tasks with geometry"
              value={fourD ? fourD.total.toLocaleString() : "—"}
              hint="schedule tasks carrying model elements"
            />
          </CardBody>
        </Card>
      </div>

      <div className="mb-3 flex justify-end">
        <Button onClick={() => setLinkOpen(true)}>Link elements</Button>
      </div>

      <ErrorAlert message={error} />

      <Card className="mb-4">
        <CardBody>
          <h3 className="mb-2 text-sm font-semibold text-ink-900">4D — programme</h3>
          {fourD === null ? (
            <Spinner label="Loading 4D links…" />
          ) : fourD.items.length === 0 ? (
            <EmptyState
              title="No task is bound to geometry yet"
              hint="Link the elements a task builds and the programme carries its own model view."
            />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Task</Th>
                  <Th>Start</Th>
                  <Th>Finish</Th>
                  <Th className="text-right">% complete</Th>
                  <Th className="text-right">Elements</Th>
                  <Th>Roles</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {fourD.items.map((t) => (
                  <tr key={t.id}>
                    <Td>
                      <span className={t.isCritical ? "font-medium text-red-700" : "text-ink-800"}>
                        {t.name}
                      </span>
                    </Td>
                    <Td>{formatDate(t.startDate)}</Td>
                    <Td>{formatDate(t.finishDate)}</Td>
                    <Td className="text-right tabular-nums">{Math.round(t.percentComplete)}%</Td>
                    <Td className="text-right tabular-nums">{t.elementCount}</Td>
                    <Td className="text-xs text-ink-500">{t.roles.join(", ")}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardBody>
          <h3 className="mb-2 text-sm font-semibold text-ink-900">5D — cost</h3>
          {fiveD === null ? (
            <Spinner label="Loading 5D links…" />
          ) : fiveD.items.length === 0 ? (
            <EmptyState
              title="No budget line is bound to geometry yet"
              hint="Link elements with a measured quantity to compare the model against the budget."
            />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Cost code</Th>
                  <Th>Description</Th>
                  <Th className="text-right">Budget qty</Th>
                  <Th className="text-right">Model qty</Th>
                  <Th className="text-right">Variance</Th>
                  <Th>Basis</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {fiveD.items.map((l) => (
                  <tr key={l.id}>
                    <Td className="font-mono text-[11px]">{l.costCode}</Td>
                    <Td>{l.description}</Td>
                    <Td className="text-right tabular-nums">
                      {l.quantity === null ? "—" : `${l.quantity} ${l.unit ?? ""}`}
                    </Td>
                    <Td className="text-right tabular-nums">
                      {l.modelQuantity === null
                        ? "—"
                        : `${l.modelQuantity} ${l.modelQuantityUnit ?? ""}`}
                    </Td>
                    <Td
                      className={`text-right tabular-nums ${
                        l.variance !== null && l.variance < 0 ? "text-red-600" : ""
                      }`}
                    >
                      {l.variance === null ? "—" : l.variance}
                    </Td>
                    <Td className="text-xs text-ink-500">{l.quantityBasis}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </CardBody>
      </Card>

      <Modal open={linkOpen} onClose={() => setLinkOpen(false)} title="Link elements">
        <form onSubmit={createLink} className="space-y-3">
          <ErrorAlert message={linkError} />
          {linkResult ? <p className="text-xs text-emerald-700">{linkResult}</p> : null}
          <Field label="Link type">
            <Select
              value={form.linkType}
              onChange={(e) => setForm({ ...form, linkType: e.target.value })}
            >
              <option value="schedule_task">4D — schedule task</option>
              <option value="budget_line">5D — budget line</option>
            </Select>
          </Field>
          <Field
            label="Target id"
            hint="The schedule task id or budget line id. Both are shown on their own registers."
          >
            <Input
              value={form.targetId}
              onChange={(e) => setForm({ ...form, targetId: e.target.value })}
              required
            />
          </Field>
          <Field label="IFC GlobalIds" hint="One per line, or comma separated. Ids not present in a model of this project are reported back, not silently dropped.">
            <textarea
              className="w-full rounded-md border border-ink-200 p-2 font-mono text-xs"
              rows={4}
              value={form.globalIds}
              onChange={(e) => setForm({ ...form, globalIds: e.target.value })}
            />
          </Field>
          {form.linkType === "budget_line" ? (
            <div className="grid grid-cols-2 gap-3">
              <Field label="Quantity per element">
                <Input
                  type="number"
                  step="any"
                  value={form.quantity}
                  onChange={(e) => setForm({ ...form, quantity: e.target.value })}
                />
              </Field>
              <Field label="Unit">
                <Input
                  value={form.unit}
                  onChange={(e) => setForm({ ...form, unit: e.target.value })}
                  placeholder="m2"
                />
              </Field>
            </div>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setLinkOpen(false)}>
              Close
            </Button>
            <Button type="submit" disabled={busy}>
              Link
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
