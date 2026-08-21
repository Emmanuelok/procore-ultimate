/**
 * Sensor / IoT tab — channels bound to assets, hourly-bucketed sparklines
 * with threshold lines, and a 24h synthetic-data simulator that demonstrates
 * threshold breach detection (spec Domain L #659-661).
 */
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { SENSOR_KINDS } from "@constructos/shared";
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
  Th,
} from "../../ui";
import { formatDateTime, humanize } from "../format";
import {
  Sparkline,
  type Asset,
  type ListResponse,
  type ReadingBucket,
  type Sensor,
} from "./twinShared";

interface LastValue {
  value: number;
  at: string;
}

export default function SensorsTab({ projectId }: { projectId: string }) {
  const [items, setItems] = useState<Sensor[] | null>(null);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [lastValues, setLastValues] = useState<Record<string, LastValue | null>>({});

  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [buckets, setBuckets] = useState<ReadingBucket[] | null>(null);
  const [bucketsError, setBucketsError] = useState<string | null>(null);
  const [simBusy, setSimBusy] = useState(false);
  const [simNote, setSimNote] = useState<string | null>(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState({
    name: "",
    kind: "temperature",
    unit: "°C",
    assetId: "",
    minValue: "",
    maxValue: "",
  });
  const [createError, setCreateError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api.get<ListResponse<Sensor>>(
        `/api/v1/projects/${projectId}/sensors?pageSize=100`,
      );
      setItems(res.items);
      // fetch a compact last-value per sensor (48h window, hourly buckets)
      const from = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
      const results = await Promise.all(
        res.items.map(async (s) => {
          try {
            const r = await api.get<{ items: ReadingBucket[] }>(
              `/api/v1/sensors/${s.id}/readings?from=${encodeURIComponent(from)}&bucketMinutes=60`,
            );
            const last = r.items[r.items.length - 1];
            return [s.id, last ? { value: last.avg, at: last.bucketStart } : null] as const;
          } catch {
            return [s.id, null] as const;
          }
        }),
      );
      setLastValues(Object.fromEntries(results));
    } catch (err) {
      setItems([]);
      setError(err instanceof Error ? err.message : "Failed to load sensors");
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    api
      .get<ListResponse<Asset>>(`/api/v1/projects/${projectId}/assets?pageSize=100`)
      .then((res) => setAssets(res.items))
      .catch(() => setAssets([]));
  }, [projectId]);

  const loadBuckets = useCallback(async (sensorId: string) => {
    setBuckets(null);
    setBucketsError(null);
    try {
      const from = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
      const res = await api.get<{ items: ReadingBucket[] }>(
        `/api/v1/sensors/${sensorId}/readings?from=${encodeURIComponent(from)}&bucketMinutes=60`,
      );
      setBuckets(res.items);
    } catch (err) {
      setBuckets([]);
      setBucketsError(err instanceof Error ? err.message : "Failed to load readings");
    }
  }, []);

  function toggleExpand(sensorId: string) {
    setSimNote(null);
    if (expandedId === sensorId) {
      setExpandedId(null);
      setBuckets(null);
      return;
    }
    setExpandedId(sensorId);
    void loadBuckets(sensorId);
  }

  /**
   * Simulate 24h of hourly readings: a sine wave around the threshold
   * midpoint with one deliberate outlier above max to demo breach handling.
   */
  async function simulate(sensor: Sensor) {
    setSimBusy(true);
    setSimNote(null);
    setBucketsError(null);
    try {
      const min = sensor.minValue;
      const max = sensor.maxValue;
      const mid = min !== null && max !== null ? (min + max) / 2 : (max ?? min ?? 21);
      const amp =
        min !== null && max !== null ? Math.max((max - min) / 3, 0.5) : Math.abs(mid) * 0.1 + 1;
      const now = Date.now();
      const readings = Array.from({ length: 24 }, (_, i) => {
        const at = new Date(now - (23 - i) * 3600 * 1000).toISOString();
        let value = mid + amp * Math.sin((2 * Math.PI * i) / 24);
        if (i === 18) {
          // one outlier beyond the max threshold to demonstrate a breach
          value = max !== null ? max + amp : mid + amp * 3;
        }
        return { value: Number(value.toFixed(3)), at };
      });
      const res = await api.post<{ inserted: number; breaches: number }>(
        `/api/v1/sensors/${sensor.id}/readings`,
        { readings },
      );
      setSimNote(
        `Ingested ${res.inserted} readings — ${res.breaches} threshold breach${
          res.breaches === 1 ? "" : "es"
        } detected and written to the assurance event stream.`,
      );
      await loadBuckets(sensor.id);
      await load();
    } catch (err) {
      setBucketsError(err instanceof ApiClientError ? err.message : "Simulation failed.");
    } finally {
      setSimBusy(false);
    }
  }

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setCreateError(null);
    setBusy(true);
    try {
      const payload: Record<string, unknown> = {
        name: form.name.trim(),
        kind: form.kind,
        unit: form.unit.trim(),
      };
      if (form.assetId) payload["assetId"] = form.assetId;
      if (form.minValue !== "") payload["minValue"] = Number(form.minValue);
      if (form.maxValue !== "") payload["maxValue"] = Number(form.maxValue);
      await api.post(`/api/v1/projects/${projectId}/sensors`, payload);
      setCreateOpen(false);
      setForm({ name: "", kind: "temperature", unit: "°C", assetId: "", minValue: "", maxValue: "" });
      await load();
    } catch (err) {
      setCreateError(err instanceof ApiClientError ? err.message : "Failed to create the sensor.");
    } finally {
      setBusy(false);
    }
  }

  const assetName = (assetId: string | null) =>
    assetId ? (assets.find((a) => a.id === assetId)?.tagCode ?? "linked") : null;

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <span className="text-xs text-ink-400">
          Sensor channels stream operational data into the twin; thresholds feed the assurance
          event stream on breach.
        </span>
        <Button onClick={() => setCreateOpen(true)}>New sensor</Button>
      </div>

      <ErrorAlert message={error} />

      {items === null ? (
        <Spinner label="Loading sensors…" />
      ) : items.length === 0 ? (
        <EmptyState
          title="No sensors yet"
          hint="Create a sensor channel (temperature, energy, vibration…) and bind it to an asset, then simulate 24h of readings to see thresholds in action."
          action={<Button onClick={() => setCreateOpen(true)}>Create a sensor</Button>}
        />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th></Th>
              <Th>Sensor</Th>
              <Th>Kind</Th>
              <Th>Unit</Th>
              <Th>Asset</Th>
              <Th>Thresholds</Th>
              <Th className="text-right">Last value</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {items.map((s) => {
              const last = lastValues[s.id];
              const breach =
                last != null &&
                ((s.maxValue !== null && last.value > s.maxValue) ||
                  (s.minValue !== null && last.value < s.minValue));
              const expanded = expandedId === s.id;
              return [
                <tr key={s.id} className="hover:bg-ink-50/60">
                  <Td className="w-8">
                    <button
                      type="button"
                      onClick={() => toggleExpand(s.id)}
                      className="rounded p-1 text-ink-400 hover:bg-ink-100 hover:text-ink-700"
                      aria-label={expanded ? "Collapse" : "Expand"}
                    >
                      {expanded ? "▾" : "▸"}
                    </button>
                  </Td>
                  <Td>
                    <button
                      type="button"
                      onClick={() => toggleExpand(s.id)}
                      className="font-medium text-brand-700 hover:text-brand-800"
                    >
                      {s.name}
                    </button>
                  </Td>
                  <Td>
                    <Badge tone="blue">{humanize(s.kind)}</Badge>
                  </Td>
                  <Td>{s.unit}</Td>
                  <Td className="font-mono text-xs">{assetName(s.assetId) ?? "—"}</Td>
                  <Td className="text-xs text-ink-500">
                    {s.minValue !== null || s.maxValue !== null
                      ? `${s.minValue ?? "−∞"} … ${s.maxValue ?? "+∞"}`
                      : "—"}
                  </Td>
                  <Td className="text-right tabular-nums">
                    {last === undefined ? (
                      <span className="text-ink-300">…</span>
                    ) : last === null ? (
                      "—"
                    ) : (
                      <span className={breach ? "font-semibold text-red-600" : ""}>
                        {last.value.toFixed(2)} {s.unit}
                      </span>
                    )}
                  </Td>
                </tr>,
                expanded ? (
                  <tr key={`${s.id}-detail`}>
                    <td className="bg-ink-50/40 px-4 py-2.5" colSpan={7}>
                      <div className="px-2 py-2">
                        <div className="mb-2 flex items-center justify-between">
                          <span className="text-xs font-medium text-ink-600">
                            Last 48h — hourly averages
                            {last?.at ? (
                              <span className="ml-2 text-ink-400">
                                latest bucket {formatDateTime(last.at)}
                              </span>
                            ) : null}
                          </span>
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={simBusy}
                            onClick={() => void simulate(s)}
                          >
                            {simBusy ? "Simulating…" : "Simulate 24h"}
                          </Button>
                        </div>
                        {simNote && (
                          <div className="mb-2 rounded-md bg-emerald-50 px-3 py-1.5 text-xs text-emerald-800 ring-1 ring-emerald-100">
                            {simNote}
                          </div>
                        )}
                        <ErrorAlert message={bucketsError} />
                        {buckets === null ? (
                          <Spinner />
                        ) : (
                          <Sparkline
                            buckets={buckets}
                            minValue={s.minValue}
                            maxValue={s.maxValue}
                            unit={s.unit}
                          />
                        )}
                      </div>
                    </td>
                  </tr>
                ) : null,
              ];
            })}
          </tbody>
        </Table>
      )}

      <Modal open={createOpen} title="New sensor channel" onClose={() => setCreateOpen(false)}>
        <ErrorAlert message={createError} />
        <form onSubmit={onCreate} className="space-y-4">
          <Field label="Name">
            <Input
              required
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="AHU-L3-01 supply air temperature"
            />
          </Field>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Kind">
              <Select
                value={form.kind}
                onChange={(e) => setForm((f) => ({ ...f, kind: e.target.value }))}
              >
                {SENSOR_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {humanize(k)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Unit">
              <Input
                required
                value={form.unit}
                onChange={(e) => setForm((f) => ({ ...f, unit: e.target.value }))}
                placeholder="°C"
              />
            </Field>
          </div>
          <Field label="Bound asset" hint="Optional — breach notifications route to the asset owner.">
            <Select
              value={form.assetId}
              onChange={(e) => setForm((f) => ({ ...f, assetId: e.target.value }))}
            >
              <option value="">Not bound</option>
              {assets.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.tagCode} — {a.name}
                </option>
              ))}
            </Select>
          </Field>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Min threshold">
              <Input
                type="number"
                step="any"
                value={form.minValue}
                onChange={(e) => setForm((f) => ({ ...f, minValue: e.target.value }))}
                placeholder="16"
              />
            </Field>
            <Field label="Max threshold">
              <Input
                type="number"
                step="any"
                value={form.maxValue}
                onChange={(e) => setForm((f) => ({ ...f, maxValue: e.target.value }))}
                placeholder="26"
              />
            </Field>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !form.name.trim() || !form.unit.trim()}>
              {busy ? "Creating…" : "Create sensor"}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
