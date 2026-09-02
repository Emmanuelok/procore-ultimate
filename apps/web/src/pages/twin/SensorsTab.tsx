/**
 * Sensors tab — channels, telemetry and the alert register
 * (spec Domain L #659-661).
 *
 * The whole tab loads in ONE request (`/sensors/overview`): the previous
 * version issued a readings query per sensor on every mount, which is a
 * GROUP BY per sensor over 48 hours of data every time somebody looked at the
 * page. Charts are fetched only for the sensor a person actually opens.
 *
 * The "simulate" control writes telemetry tagged as synthetic, is only shown
 * when the API says the environment allows it, and raises no alerts, events
 * or signals — a demo must not be able to write into the assurance record.
 */
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { SENSOR_KINDS } from "@constructos/shared";
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
  Th,
} from "../../ui";
import { formatDateTime, humanize } from "../format";
import {
  Sparkline,
  type AssetRow,
  type CompanyUser,
  type ListResponse,
  type ReadingBucket,
  type SensorAlert,
  type SensorOverviewRow,
  type TwinSummary,
} from "./twinShared";

export default function SensorsTab({
  projectId,
  summary,
  onChanged,
}: {
  projectId: string;
  summary: TwinSummary | null;
  onChanged: () => void;
}) {
  const [rows, setRows] = useState<SensorOverviewRow[] | null>(null);
  const [alerts, setAlerts] = useState<SensorAlert[] | null>(null);
  const [assets, setAssets] = useState<AssetRow[]>([]);
  const [users, setUsers] = useState<CompanyUser[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState({
    name: "",
    kind: "temperature",
    unit: "",
    assetId: "",
    ownerId: "",
    minValue: "",
    maxValue: "",
    designSetpoint: "",
    staleAfterMinutes: "",
  });
  const [formError, setFormError] = useState<string | null>(null);

  const [detail, setDetail] = useState<SensorOverviewRow | null>(null);
  const [buckets, setBuckets] = useState<ReadingBucket[] | null>(null);
  const [readingsNote, setReadingsNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [overview, alertList] = await Promise.all([
        api.get<{ items: SensorOverviewRow[] }>(
          `/api/v1/projects/${projectId}/sensors/overview?hours=24`,
        ),
        api.get<ListResponse<SensorAlert>>(
          `/api/v1/projects/${projectId}/sensor-alerts?pageSize=50`,
        ),
      ]);
      setRows(overview.items);
      setAlerts(alertList.items);
    } catch (err) {
      setRows([]);
      setAlerts([]);
      setError(err instanceof Error ? err.message : "Failed to load sensors");
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    api
      .get<ListResponse<AssetRow>>(`/api/v1/projects/${projectId}/assets?pageSize=200`)
      .then((res) => setAssets(res.items))
      .catch(() => setAssets([]));
    api
      .get<ListResponse<CompanyUser>>("/api/v1/company/users?pageSize=200")
      .then((res) => setUsers(res.items))
      .catch(() => setUsers([]));
  }, [projectId]);

  async function createSensor(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    setBusy(true);
    try {
      const payload: Record<string, unknown> = {
        name: form.name.trim(),
        kind: form.kind,
        unit: form.unit.trim(),
      };
      if (form.assetId) payload["assetId"] = form.assetId;
      if (form.ownerId) payload["ownerId"] = form.ownerId;
      if (form.minValue) payload["minValue"] = Number(form.minValue);
      if (form.maxValue) payload["maxValue"] = Number(form.maxValue);
      if (form.designSetpoint) payload["designSetpoint"] = Number(form.designSetpoint);
      if (form.staleAfterMinutes) payload["staleAfterMinutes"] = Number(form.staleAfterMinutes);
      await api.post(`/api/v1/projects/${projectId}/sensors`, payload);
      setCreateOpen(false);
      setForm({
        name: "",
        kind: "temperature",
        unit: "",
        assetId: "",
        ownerId: "",
        minValue: "",
        maxValue: "",
        designSetpoint: "",
        staleAfterMinutes: "",
      });
      await load();
      onChanged();
    } catch (err) {
      setFormError(err instanceof ApiClientError ? err.message : "Failed to create the sensor.");
    } finally {
      setBusy(false);
    }
  }

  async function openDetail(sensor: SensorOverviewRow) {
    setDetail(sensor);
    setBuckets(null);
    setReadingsNote(null);
    try {
      const res = await api.get<{ items: ReadingBucket[]; bucketMinutes: number }>(
        `/api/v1/sensors/${sensor.id}/readings?bucketMinutes=60`,
      );
      setBuckets(res.items);
      setReadingsNote(
        res.items.length === 0
          ? "No readings have been ingested for this channel yet."
          : `${res.items.length} hourly buckets.`,
      );
    } catch (err) {
      setBuckets([]);
      setReadingsNote(err instanceof Error ? err.message : "Readings unavailable");
    }
  }

  async function toggleActive(sensor: SensorOverviewRow) {
    setBusy(true);
    try {
      await api.patch(`/api/v1/sensors/${sensor.id}`, { isActive: sensor.isActive !== "true" });
      await load();
    } catch (err) {
      toast.error(err instanceof ApiClientError ? err.message : "The change was refused.");
    } finally {
      setBusy(false);
    }
  }

  async function acknowledge(alert: SensorAlert) {
    setBusy(true);
    try {
      await api.patch(`/api/v1/sensor-alerts/${alert.id}`, { status: "acknowledged" });
      toast.success("Alert acknowledged.");
      await load();
      onChanged();
    } catch (err) {
      toast.error(err instanceof ApiClientError ? err.message : "The change was refused.");
    } finally {
      setBusy(false);
    }
  }

  async function simulate(sensor: SensorOverviewRow) {
    setBusy(true);
    try {
      const res = await api.post<{ inserted: number; note: string }>(
        `/api/v1/projects/${projectId}/sensors/${sensor.id}/simulate`,
        { hours: 24 },
      );
      toast.success(`${res.inserted} synthetic readings written. ${res.note}`);
      await load();
    } catch (err) {
      toast.error(
        err instanceof ApiClientError ? err.message : "Synthetic telemetry is not available here.",
      );
    } finally {
      setBusy(false);
    }
  }

  const openAlerts = (alerts ?? []).filter(
    (a) => a.status === "open" || a.status === "acknowledged",
  );

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-ink-900">Sensor channels</h2>
        <Button onClick={() => setCreateOpen(true)}>New sensor</Button>
      </div>

      <ErrorAlert message={error} />

      {openAlerts.length > 0 ? (
        <Card className="mb-4">
          <CardBody>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-500">
              Open alerts ({openAlerts.length})
            </h3>
            <Table>
              <thead>
                <tr>
                  <Th>Sensor</Th>
                  <Th>Asset</Th>
                  <Th>Kind</Th>
                  <Th className="text-right">Worst value</Th>
                  <Th className="text-right">Breaches</Th>
                  <Th>Since</Th>
                  <Th className="text-right">Actions</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {openAlerts.map((a) => (
                  <tr key={a.id}>
                    <Td>{a.sensorName ?? a.sensorId}</Td>
                    <Td>{a.assetTag ? `${a.assetTag} — ${a.assetName}` : "—"}</Td>
                    <Td>
                      <Badge tone={a.kind === "stale" ? "warning" : "danger"} size="sm">
                        {humanize(a.kind)}
                      </Badge>
                    </Td>
                    <Td className="text-right tabular-nums">
                      {a.value === null ? "—" : `${a.value} ${a.unit ?? ""}`}
                      {a.threshold !== null ? (
                        <span className="block text-[11px] text-ink-400">
                          limit {a.threshold}
                        </span>
                      ) : null}
                    </Td>
                    <Td className="text-right tabular-nums">{a.breachCount}</Td>
                    <Td className="text-xs">{formatDateTime(a.firstBreachAt)}</Td>
                    <Td className="text-right">
                      {a.status === "open" ? (
                        <Button size="sm" variant="secondary" disabled={busy} onClick={() => void acknowledge(a)}>
                          Acknowledge
                        </Button>
                      ) : (
                        <span className="text-[11px] text-ink-400">acknowledged</span>
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </CardBody>
        </Card>
      ) : null}

      {rows === null ? (
        <Spinner label="Loading sensors…" />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No sensors"
          hint="Create a channel and point a gateway at the project-scoped ingest route; readings are unique per instant, so a retried batch is a no-op."
          action={<Button onClick={() => setCreateOpen(true)}>Add a sensor</Button>}
        />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Sensor</Th>
              <Th>Kind</Th>
              <Th>Asset</Th>
              <Th className="text-right">Last value</Th>
              <Th className="text-right">24h average</Th>
              <Th>Thresholds</Th>
              <Th>State</Th>
              <Th className="text-right">Actions</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {rows.map((s) => {
              const asset = assets.find((a) => a.id === s.assetId);
              return (
                <tr key={s.id} className="hover:bg-ink-50/60">
                  <Td>
                    <button
                      type="button"
                      className="font-medium text-brand-700 hover:text-brand-800"
                      onClick={() => void openDetail(s)}
                    >
                      {s.name}
                    </button>
                    {s.openAlerts > 0 ? (
                      <Badge tone="danger" size="sm" className="ml-2">
                        {s.openAlerts} alert{s.openAlerts === 1 ? "" : "s"}
                      </Badge>
                    ) : null}
                  </Td>
                  <Td>{humanize(s.kind)}</Td>
                  <Td>{asset ? `${asset.tagCode}` : "—"}</Td>
                  <Td className="text-right tabular-nums">
                    {s.lastValue === null ? (
                      <span className="text-ink-300">—</span>
                    ) : (
                      `${s.lastValue} ${s.unit}`
                    )}
                    <span className="block text-[11px] text-ink-400">
                      {s.lastReadingAt ? formatDateTime(s.lastReadingAt) : "never reported"}
                    </span>
                  </Td>
                  <Td className="text-right tabular-nums">
                    {s.window.avg === null ? (
                      <span className="text-ink-300" title={s.window.basis}>
                        —
                      </span>
                    ) : (
                      Math.round(s.window.avg * 100) / 100
                    )}
                  </Td>
                  <Td className="text-xs">
                    {s.minValue === null && s.maxValue === null
                      ? "none"
                      : `${s.minValue ?? "−∞"} … ${s.maxValue ?? "∞"} ${s.unit}`}
                  </Td>
                  <Td>
                    <Badge tone={s.isActive === "true" ? "success" : "neutral"} size="sm">
                      {s.isActive === "true" ? "active" : "inactive"}
                    </Badge>
                  </Td>
                  <Td className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button size="sm" variant="ghost" disabled={busy} onClick={() => void toggleActive(s)}>
                        {s.isActive === "true" ? "Deactivate" : "Activate"}
                      </Button>
                      {summary?.simulationAvailable ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          title="Writes synthetic readings, tagged as simulation, excluded from statistics and alerts"
                          onClick={() => void simulate(s)}
                        >
                          Simulate
                        </Button>
                      ) : null}
                    </div>
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}

      {summary && !summary.simulationAvailable ? (
        <p className="mt-2 text-[11px] text-ink-400">
          Synthetic telemetry is disabled in this environment, so every figure above comes from
          ingested readings.
        </p>
      ) : null}

      {/* ------------------------------ create ------------------------------ */}
      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title="New sensor channel" wide>
        <form onSubmit={createSensor} className="space-y-3">
          <ErrorAlert message={formError} />
          <div className="grid grid-cols-3 gap-3">
            <Field label="Name">
              <Input
                required
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </Field>
            <Field label="Kind">
              <Select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
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
                onChange={(e) => setForm({ ...form, unit: e.target.value })}
                placeholder="C, kWh, ppm…"
              />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Asset">
              <Select
                value={form.assetId}
                onChange={(e) => setForm({ ...form, assetId: e.target.value })}
              >
                <option value="">Not bound to an asset</option>
                {assets.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.tagCode} — {a.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Alert owner" hint="Falls back to the asset owner, then its creator.">
              <Select
                value={form.ownerId}
                onChange={(e) => setForm({ ...form, ownerId: e.target.value })}
              >
                <option value="">Default</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <div className="grid grid-cols-4 gap-3">
            <Field label="Min">
              <Input
                type="number"
                step="any"
                value={form.minValue}
                onChange={(e) => setForm({ ...form, minValue: e.target.value })}
              />
            </Field>
            <Field label="Max">
              <Input
                type="number"
                step="any"
                value={form.maxValue}
                onChange={(e) => setForm({ ...form, maxValue: e.target.value })}
              />
            </Field>
            <Field label="Design setpoint">
              <Input
                type="number"
                step="any"
                value={form.designSetpoint}
                onChange={(e) => setForm({ ...form, designSetpoint: e.target.value })}
              />
            </Field>
            <Field label="Stale after (min)">
              <Input
                type="number"
                min={1}
                value={form.staleAfterMinutes}
                onChange={(e) => setForm({ ...form, staleAfterMinutes: e.target.value })}
              />
            </Field>
          </div>
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

      {/* ------------------------------ detail ------------------------------ */}
      <Drawer
        open={detail !== null}
        onOpenChange={(open) => !open && setDetail(null)}
        title={detail?.name ?? "Sensor"}
        description={detail ? `${humanize(detail.kind)} · ${detail.unit}` : undefined}
        size="lg"
      >
        <DrawerBody>
          {detail ? (
            <div className="space-y-4">
              <Card>
                <CardBody>
                  {buckets === null ? (
                    <Spinner label="Loading readings…" />
                  ) : (
                    <Sparkline
                      buckets={buckets}
                      minValue={detail.minValue}
                      maxValue={detail.maxValue}
                      unit={detail.unit}
                    />
                  )}
                  {readingsNote ? (
                    <p className="mt-1 text-[11px] text-ink-400">{readingsNote}</p>
                  ) : null}
                </CardBody>
              </Card>
              <div className="grid grid-cols-2 gap-3 text-xs text-ink-600">
                <div>
                  <div className="text-ink-400">Last reading</div>
                  {detail.lastReadingAt ? formatDateTime(detail.lastReadingAt) : "never"}
                </div>
                <div>
                  <div className="text-ink-400">24h window</div>
                  {detail.window.basis}
                </div>
                <div>
                  <div className="text-ink-400">Design setpoint</div>
                  {detail.designSetpoint === null ? "not recorded" : `${detail.designSetpoint} ${detail.unit}`}
                </div>
                <div>
                  <div className="text-ink-400">Alert cool-down</div>
                  {detail.cooldownMinutes} minutes
                </div>
              </div>
            </div>
          ) : null}
        </DrawerBody>
      </Drawer>
    </div>
  );
}
