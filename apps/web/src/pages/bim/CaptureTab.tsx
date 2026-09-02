/**
 * Reality capture tab (spec #246, Vol II Z #1076-1080).
 *
 * What was captured, when, against which model version, and what the survey
 * found: mean and maximum deviation against a stated tolerance and a sample
 * size. A capture without a deviation summary says so rather than implying
 * the scan matched.
 */
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";
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
} from "../../ui";
import { formatDate, humanize } from "../format";
import {
  REALITY_CAPTURE_KINDS,
  type BimModel,
  type ListResponse,
  type RealityCapture,
} from "./bimShared";

export default function CaptureTab({
  projectId,
  onChanged,
}: {
  projectId: string;
  onChanged: () => void;
}) {
  const [items, setItems] = useState<RealityCapture[] | null>(null);
  const [models, setModels] = useState<BimModel[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    kind: "point_cloud",
    name: "",
    description: "",
    capturedAt: "",
    modelVersionId: "",
    coveragePercent: "",
    latitude: "",
    longitude: "",
    sampleCount: "",
    meanMm: "",
    maxMm: "",
    toleranceMm: "",
    withinTolerance: "",
  });
  const [formError, setFormError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api.get<ListResponse<RealityCapture>>(
        `/api/v1/projects/${projectId}/bim/reality-captures?pageSize=100`,
      );
      setItems(res.items);
    } catch (err) {
      setItems([]);
      setError(err instanceof Error ? err.message : "Failed to load captures");
    }
  }, [projectId]);

  useEffect(() => {
    void load();
    api
      .get<ListResponse<BimModel>>(`/api/v1/projects/${projectId}/bim/models?pageSize=100`)
      .then((res) => setModels(res.items))
      .catch(() => setModels([]));
  }, [load, projectId]);

  async function create(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    setBusy(true);
    try {
      const payload: Record<string, unknown> = {
        kind: form.kind,
        name: form.name.trim(),
      };
      if (form.description.trim()) payload["description"] = form.description.trim();
      if (form.capturedAt) payload["capturedAt"] = form.capturedAt;
      if (form.modelVersionId) payload["modelVersionId"] = form.modelVersionId;
      if (form.coveragePercent) payload["coveragePercent"] = Number(form.coveragePercent);
      if (form.latitude) payload["latitude"] = Number(form.latitude);
      if (form.longitude) payload["longitude"] = Number(form.longitude);
      if (form.sampleCount && form.toleranceMm) {
        payload["deviation"] = {
          sampleCount: Number(form.sampleCount),
          meanMm: Number(form.meanMm || 0),
          maxMm: Number(form.maxMm || 0),
          toleranceMm: Number(form.toleranceMm),
          withinTolerance: Number(form.withinTolerance || 0),
        };
      }
      await api.post(`/api/v1/projects/${projectId}/bim/reality-captures`, payload);
      setOpen(false);
      toast.success("Capture recorded.");
      await load();
      onChanged();
    } catch (err) {
      setFormError(err instanceof ApiClientError ? err.message : "Failed to record the capture.");
    } finally {
      setBusy(false);
    }
  }

  async function remove(capture: RealityCapture) {
    if (!window.confirm(`Delete "${capture.name}"?`)) return;
    try {
      await api.del(`/api/v1/projects/${projectId}/bim/reality-captures/${capture.id}`);
      await load();
      onChanged();
    } catch (err) {
      toast.error(err instanceof ApiClientError ? err.message : "Delete failed.");
    }
  }

  const versionOptions = models
    .filter((m) => m.currentVersionId && m.currentVersion)
    .map((m) => ({
      value: m.currentVersionId as string,
      label: `${m.name} · v${m.currentVersion?.version}`,
    }));

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-ink-900">Reality capture</h2>
        <Button onClick={() => setOpen(true)}>Record a capture</Button>
      </div>

      <ErrorAlert message={error} />

      {items === null ? (
        <Spinner label="Loading captures…" />
      ) : items.length === 0 ? (
        <EmptyState
          title="Nothing captured yet"
          hint="Record scans, drone flights and 360 tours against the model version they are compared with, and the deviation the surveyor measured."
          action={<Button onClick={() => setOpen(true)}>Record a capture</Button>}
        />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Capture</Th>
              <Th>Kind</Th>
              <Th>Captured</Th>
              <Th>Status</Th>
              <Th className="text-right">Coverage</Th>
              <Th>Deviation vs model</Th>
              <Th className="text-right">Actions</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {items.map((c) => (
              <tr key={c.id}>
                <Td>
                  <span className="font-medium text-ink-900">{c.name}</span>
                  {c.description ? (
                    <div className="text-[11px] text-ink-400">{c.description}</div>
                  ) : null}
                </Td>
                <Td>{humanize(c.kind)}</Td>
                <Td>{c.capturedAt ? formatDate(c.capturedAt) : "—"}</Td>
                <Td>
                  <Badge size="sm" tone={c.status === "compared" ? "success" : "neutral"}>
                    {humanize(c.status)}
                  </Badge>
                </Td>
                <Td className="text-right tabular-nums">
                  {c.coveragePercent === null ? "—" : `${c.coveragePercent}%`}
                </Td>
                <Td className="text-xs">
                  {c.deviation ? (
                    <span>
                      mean {c.deviation.meanMm} mm · max {c.deviation.maxMm} mm ·{" "}
                      {c.withinTolerancePercent}% within ±{c.deviation.toleranceMm} mm
                      <span className="block text-ink-400">
                        {c.deviation.sampleCount.toLocaleString()} sampled points
                      </span>
                    </span>
                  ) : (
                    <span className="text-ink-400">no deviation analysis recorded</span>
                  )}
                </Td>
                <Td className="text-right">
                  <Button size="sm" variant="ghost" onClick={() => void remove(c)}>
                    Delete
                  </Button>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      <Modal open={open} onClose={() => setOpen(false)} title="Record a reality capture" wide>
        <form onSubmit={create} className="space-y-3">
          <ErrorAlert message={formError} />
          <div className="grid grid-cols-2 gap-3">
            <Field label="Kind">
              <Select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
                {REALITY_CAPTURE_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {humanize(k)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Captured on">
              <Input
                type="date"
                value={form.capturedAt}
                onChange={(e) => setForm({ ...form, capturedAt: e.target.value })}
              />
            </Field>
          </div>
          <Field label="Name">
            <Input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              required
              placeholder="Level 1 scan, week 12"
            />
          </Field>
          <Field label="Description">
            <Textarea
              rows={2}
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Registered against">
              <Select
                value={form.modelVersionId}
                onChange={(e) => setForm({ ...form, modelVersionId: e.target.value })}
              >
                <option value="">Not registered to a model</option>
                {versionOptions.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Coverage %">
              <Input
                type="number"
                min={0}
                max={100}
                value={form.coveragePercent}
                onChange={(e) => setForm({ ...form, coveragePercent: e.target.value })}
              />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Latitude">
              <Input
                type="number"
                step="any"
                value={form.latitude}
                onChange={(e) => setForm({ ...form, latitude: e.target.value })}
              />
            </Field>
            <Field label="Longitude">
              <Input
                type="number"
                step="any"
                value={form.longitude}
                onChange={(e) => setForm({ ...form, longitude: e.target.value })}
              />
            </Field>
          </div>
          <fieldset className="rounded-md border border-ink-200 p-3">
            <legend className="px-1 text-xs font-medium text-ink-600">
              Scan-vs-model deviation (optional, but a tolerance and a sample size are required
              together)
            </legend>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
              <Field label="Samples">
                <Input
                  type="number"
                  min={1}
                  value={form.sampleCount}
                  onChange={(e) => setForm({ ...form, sampleCount: e.target.value })}
                />
              </Field>
              <Field label="Mean (mm)">
                <Input
                  type="number"
                  step="any"
                  value={form.meanMm}
                  onChange={(e) => setForm({ ...form, meanMm: e.target.value })}
                />
              </Field>
              <Field label="Max (mm)">
                <Input
                  type="number"
                  step="any"
                  value={form.maxMm}
                  onChange={(e) => setForm({ ...form, maxMm: e.target.value })}
                />
              </Field>
              <Field label="Tolerance (mm)">
                <Input
                  type="number"
                  step="any"
                  value={form.toleranceMm}
                  onChange={(e) => setForm({ ...form, toleranceMm: e.target.value })}
                />
              </Field>
              <Field label="Within tolerance">
                <Input
                  type="number"
                  min={0}
                  value={form.withinTolerance}
                  onChange={(e) => setForm({ ...form, withinTolerance: e.target.value })}
                />
              </Field>
            </div>
          </fieldset>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              Record
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
