/**
 * Map tab — geofences and every geo-tagged record on the project
 * (spec #471-478).
 *
 * The plan is a schematic projection, not a basemap: it plots what the
 * platform actually holds coordinates for, and the coverage line says how
 * much of each register that is. A record without coordinates is counted as
 * "not located" rather than quietly omitted.
 */
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { api, ApiClientError } from "../../lib/api";
import {
  Badge,
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
  Table,
  Td,
  Textarea,
  Th,
} from "../../ui";
import { humanize } from "../format";
import { GEOFENCE_PURPOSES, MiniMap, type Geofence, type MapData, type MapFeature } from "./bimShared";

export default function MapTab({
  projectId,
  onChanged,
}: {
  projectId: string;
  onChanged: () => void;
}) {
  const [data, setData] = useState<MapData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: "", purpose: "work_zone", ring: "", description: "" });
  const [formError, setFormError] = useState<string | null>(null);
  const [focus, setFocus] = useState<MapFeature | null>(null);
  const [contents, setContents] = useState<{ fence: Geofence; items: MapFeature[]; byKind: Record<string, number> } | null>(
    null,
  );

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await api.get<MapData>(`/api/v1/projects/${projectId}/map`));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load the map");
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function createFence(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    setBusy(true);
    try {
      let ring: Array<[number, number]>;
      try {
        const parsed: unknown = JSON.parse(form.ring);
        if (!Array.isArray(parsed)) throw new Error("not an array");
        ring = parsed as Array<[number, number]>;
      } catch {
        throw new Error(
          'The ring must be JSON: [[longitude, latitude], [longitude, latitude], …] with at least three points',
        );
      }
      await api.post(`/api/v1/projects/${projectId}/geofences`, {
        name: form.name.trim(),
        purpose: form.purpose,
        ring,
        ...(form.description.trim() ? { description: form.description.trim() } : {}),
      });
      setOpen(false);
      setForm({ name: "", purpose: "work_zone", ring: "", description: "" });
      toast.success("Geofence created.");
      await load();
      onChanged();
    } catch (err) {
      setFormError(
        err instanceof ApiClientError ? err.message : err instanceof Error ? err.message : "Failed.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function showContents(fence: Geofence) {
    setContents(null);
    try {
      const res = await api.get<{ fence: Geofence; items: MapFeature[]; byKind: Record<string, number> }>(
        `/api/v1/projects/${projectId}/geofences/${fence.id}/contents`,
      );
      setContents(res);
    } catch (err) {
      toast.error(err instanceof ApiClientError ? err.message : "Could not evaluate the fence.");
    }
  }

  async function removeFence(fence: Geofence) {
    if (!window.confirm(`Delete the geofence "${fence.name}"?`)) return;
    try {
      await api.del(`/api/v1/projects/${projectId}/geofences/${fence.id}`);
      await load();
      onChanged();
    } catch (err) {
      toast.error(err instanceof ApiClientError ? err.message : "Delete failed.");
    }
  }

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-ink-900">Site map</h2>
        <Button onClick={() => setOpen(true)}>New geofence</Button>
      </div>

      <ErrorAlert message={error} />

      {data === null ? (
        <Spinner label="Loading the map…" />
      ) : (
        <>
          <Card className="mb-4">
            <CardBody>
              <MiniMap
                features={data.features}
                geofences={data.geofences}
                onSelect={(f) => setFocus(f)}
              />
              <div className="mt-2 flex flex-wrap gap-3 text-xs text-ink-500">
                <span>Centre: {data.centreBasis}</span>
                {Object.entries(data.coverage).map(([kind, c]) => (
                  <span key={kind}>
                    {humanize(kind)}: {c.located} of {c.total} located
                    {c.total > c.located ? ` (${c.total - c.located} not geo-tagged)` : ""}
                  </span>
                ))}
                <span>{data.outsideAnyFence} record(s) outside every fence</span>
              </div>
              {focus ? (
                <p className="mt-2 rounded-md bg-ink-50 p-2 text-xs text-ink-700">
                  <span className="font-medium">{focus.label}</span> · {humanize(focus.kind)} ·{" "}
                  {focus.latitude.toFixed(5)}, {focus.longitude.toFixed(5)}
                  {focus.geofenceIds.length > 0
                    ? ` · inside ${focus.geofenceIds
                        .map((id) => data.geofences.find((g) => g.id === id)?.name ?? id)
                        .join(", ")}`
                    : " · outside every fence"}
                </p>
              ) : null}
            </CardBody>
          </Card>

          {data.geofences.length === 0 ? (
            <EmptyState
              title="No geofences"
              hint="Draw the site boundary, exclusion zones and laydown areas as polygons, and every geo-tagged record is evaluated against them."
              action={<Button onClick={() => setOpen(true)}>Create a geofence</Button>}
            />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Geofence</Th>
                  <Th>Purpose</Th>
                  <Th className="text-right">Approx. area</Th>
                  <Th className="text-right">Records inside</Th>
                  <Th className="text-right">Actions</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {data.geofences.map((f) => (
                  <tr key={f.id}>
                    <Td>
                      <span className="font-medium text-ink-900">{f.name}</span>
                      {f.description ? (
                        <div className="text-[11px] text-ink-400">{f.description}</div>
                      ) : null}
                    </Td>
                    <Td>
                      <Badge size="sm" tone={f.purpose === "exclusion" ? "danger" : "neutral"}>
                        {humanize(f.purpose)}
                      </Badge>
                    </Td>
                    <Td className="text-right tabular-nums">
                      {f.areaM2 ? `${Math.round(f.areaM2).toLocaleString()} m²` : "—"}
                    </Td>
                    <Td className="text-right tabular-nums">{f.featureCount ?? 0}</Td>
                    <Td className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button size="sm" variant="ghost" onClick={() => void showContents(f)}>
                          Contents
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => void removeFence(f)}>
                          Delete
                        </Button>
                      </div>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}

          {contents ? (
            <Card className="mt-4">
              <CardBody>
                <h3 className="mb-2 text-sm font-semibold text-ink-900">
                  Inside “{contents.fence.name}” — {contents.items.length} record(s)
                </h3>
                {contents.items.length === 0 ? (
                  <p className="text-xs text-ink-500">
                    Nothing geo-tagged currently falls inside this fence.
                  </p>
                ) : (
                  <ul className="space-y-1 text-xs">
                    {contents.items.map((i) => (
                      <li key={`${i.kind}-${i.id}`}>
                        <span className="font-medium text-ink-800">{i.label}</span>{" "}
                        <span className="text-ink-400">
                          ({humanize(i.kind)} · {i.latitude.toFixed(5)}, {i.longitude.toFixed(5)})
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </CardBody>
            </Card>
          ) : null}
        </>
      )}

      <Modal open={open} onClose={() => setOpen(false)} title="New geofence">
        <form onSubmit={createFence} className="space-y-3">
          <ErrorAlert message={formError} />
          <Field label="Name">
            <Input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              required
            />
          </Field>
          <Field label="Purpose">
            <Select
              value={form.purpose}
              onChange={(e) => setForm({ ...form, purpose: e.target.value })}
            >
              {GEOFENCE_PURPOSES.map((p) => (
                <option key={p} value={p}>
                  {humanize(p)}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label="Polygon ring"
            hint="JSON array of [longitude, latitude] pairs, at least three. Paste from GIS or a survey."
          >
            <Textarea
              rows={4}
              value={form.ring}
              onChange={(e) => setForm({ ...form, ring: e.target.value })}
              placeholder="[[-0.1,51.5],[-0.1,51.6],[0.1,51.6],[0.1,51.5]]"
            />
          </Field>
          <Field label="Description">
            <Input
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              Create
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
