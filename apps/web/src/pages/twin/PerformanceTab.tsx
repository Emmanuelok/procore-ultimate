/**
 * Performance tab — measured behaviour against design intent
 * (spec Domain L #660-661).
 *
 * A channel with no recorded design setpoint reports "unknown" and says so;
 * it does not get a made-up gap. Simulated readings are excluded by the API,
 * so the averages here are what the building actually did.
 */
import { useCallback, useEffect, useState } from "react";
import { api } from "../../lib/api";
import {
  Badge,
  Card,
  CardBody,
  EmptyState,
  ErrorAlert,
  Select,
  Spinner,
  Stat,
  Table,
  Td,
  Th,
} from "../../ui";
import { formatDateTime, humanize } from "../format";
import type { PerformanceRow } from "./twinShared";

const VERDICT_TONE: Record<string, "success" | "warning" | "danger" | "neutral"> = {
  on_design: "success",
  above_design: "warning",
  below_design: "warning",
  unknown: "neutral",
};

export default function PerformanceTab({ projectId }: { projectId: string }) {
  const [data, setData] = useState<{
    items: PerformanceRow[];
    total: number;
    windowDays: number;
    withBaseline: number;
    note: string;
  } | null>(null);
  const [days, setDays] = useState("30");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(
        await api.get(`/api/v1/projects/${projectId}/twin/performance?days=${days}`),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load performance");
    }
  }, [projectId, days]);

  useEffect(() => {
    void load();
  }, [load]);

  const offDesign = (data?.items ?? []).filter(
    (r) => r.verdict === "above_design" || r.verdict === "below_design",
  ).length;

  return (
    <div>
      <div className="mb-4 grid grid-cols-2 gap-4 md:grid-cols-4">
        <Card>
          <CardBody>
            <Stat label="Channels" value={data ? data.total : "—"} />
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <Stat
              label="With a design baseline"
              value={data ? data.withBaseline : "—"}
              hint={data ? `${data.total - data.withBaseline} without one` : ""}
            />
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <Stat
              label="Off design"
              value={data ? offDesign : "—"}
              tone={offDesign > 0 ? "warning" : "neutral"}
            />
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <Stat label="Window" value={data ? `${data.windowDays} days` : "—"} />
          </CardBody>
        </Card>
      </div>

      <div className="mb-3 flex items-center gap-2">
        <span className="text-xs text-ink-500">Window</span>
        <Select value={days} onChange={(e) => setDays(e.target.value)} className="max-w-[140px]">
          <option value="7">7 days</option>
          <option value="30">30 days</option>
          <option value="90">90 days</option>
          <option value="365">1 year</option>
        </Select>
      </div>

      <ErrorAlert message={error} />

      {data === null ? (
        <Spinner label="Loading performance…" />
      ) : data.items.length === 0 ? (
        <EmptyState
          title="No sensors to assess"
          hint="Bind sensors to assets and record their design setpoints to compare measured behaviour with design intent."
        />
      ) : (
        <>
          <Table>
            <thead>
              <tr>
                <Th>Asset</Th>
                <Th>Channel</Th>
                <Th className="text-right">Design</Th>
                <Th className="text-right">Measured avg</Th>
                <Th className="text-right">Gap</Th>
                <Th>Verdict</Th>
                <Th>Basis</Th>
                <Th>Last reading</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {data.items.map((r) => (
                <tr key={r.sensorId}>
                  <Td>
                    {r.assetTag ? (
                      <>
                        <span className="font-mono text-xs">{r.assetTag}</span> {r.assetName}
                      </>
                    ) : (
                      <span className="text-ink-300">unbound</span>
                    )}
                  </Td>
                  <Td>
                    {r.sensorName}
                    <div className="text-[11px] text-ink-400">
                      {humanize(r.kind)} · {r.unit}
                    </div>
                  </Td>
                  <Td className="text-right tabular-nums">
                    {r.designSetpoint === null ? "—" : r.designSetpoint}
                  </Td>
                  <Td className="text-right tabular-nums">
                    {r.avg === null ? "—" : Math.round(r.avg * 100) / 100}
                  </Td>
                  <Td className="text-right tabular-nums">
                    {r.gap === null ? "—" : `${r.gap} (${r.gapPercent}%)`}
                  </Td>
                  <Td>
                    <Badge tone={VERDICT_TONE[r.verdict] ?? "neutral"} size="sm">
                      {humanize(r.verdict)}
                    </Badge>
                  </Td>
                  <Td className="text-xs text-ink-500">{r.basis}</Td>
                  <Td className="text-xs">{r.lastAt ? formatDateTime(r.lastAt) : "never"}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
          <p className="mt-2 text-[11px] text-ink-400">{data.note}</p>
        </>
      )}
    </div>
  );
}
