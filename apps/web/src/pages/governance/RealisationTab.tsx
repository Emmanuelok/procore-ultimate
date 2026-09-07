/**
 * Benefits realisation: the dependency network and the planned-vs-realised
 * dashboard (spec Vol I #418-419, #421-422).
 *
 * Two honesty rules run through this tab. First, units are never summed
 * across: "£m saved" and "minutes per journey" get their own series and the
 * page says so. Second, a benefit with no reading contributes nothing rather
 * than zero — the gap in the line IS the finding.
 *
 * Propagation is shown, not hidden: a benefit downgraded because an upstream
 * enabler is at risk carries an "inherited" chip naming the cause.
 */
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { BENEFIT_DEPENDENCY_TYPES } from "@constructos/shared";
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
  Select,
  Spinner,
  Table,
  Td,
  Th,
} from "../../ui";
import { humanize } from "../format";
import { benefitTone, fmtNum, SectionTitle } from "./governanceShared";

interface NetworkNode {
  id: string;
  number: number;
  name: string;
  ownStatus: string;
  targetValue: number;
  baselineValue: number;
  latestValue: number | null;
  targetDate: string | null;
  isDisbenefit: boolean;
  effectiveStatus: string;
  inherited: boolean;
  causedBy: string[];
  reason: string | null;
}

interface NetworkEdge {
  id: string;
  fromBenefitId: string;
  toBenefitId: string;
  depType: string;
  note: string | null;
}

interface NetworkResponse {
  nodes: NetworkNode[];
  edges: NetworkEdge[];
  basis: string;
}

interface SeriesPoint {
  date: string;
  planned: number | null;
  realised: number | null;
}

interface RealisationResponse {
  total: number;
  byStatus: Record<string, number>;
  inheritedAtRisk: number;
  series: Array<{ unit: string; benefits: number; points: SeriesPoint[] }>;
  dates: string[];
  basis: string;
}

/** Tiny inline chart: planned (dashed) vs realised (solid) for one unit. */
function SeriesChart({ points }: { points: SeriesPoint[] }) {
  const values = points.flatMap((p) =>
    [p.planned, p.realised].filter((v): v is number => v !== null),
  );
  if (points.length < 2 || values.length === 0) {
    return (
      <p className="py-4 text-center text-xs text-ink-400">
        Not enough dated readings to draw a series.
      </p>
    );
  }
  const max = Math.max(...values);
  const min = Math.min(0, ...values);
  const span = max - min || 1;
  const w = 100;
  const h = 40;
  const x = (i: number) => (points.length === 1 ? 0 : (i / (points.length - 1)) * w);
  const y = (v: number) => h - ((v - min) / span) * h;

  function path(key: "planned" | "realised"): string {
    let d = "";
    let pen = false;
    points.forEach((p, i) => {
      const v = p[key];
      if (v === null) {
        pen = false;
        return;
      }
      d += `${pen ? "L" : "M"}${x(i).toFixed(2)},${y(v).toFixed(2)} `;
      pen = true;
    });
    return d.trim();
  }

  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-24 w-full" preserveAspectRatio="none" role="img">
      <path
        d={path("planned")}
        fill="none"
        stroke="currentColor"
        strokeWidth="1"
        strokeDasharray="3 2"
        className="text-ink-400"
        vectorEffect="non-scaling-stroke"
      />
      <path
        d={path("realised")}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        className="text-brand-600"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

export default function RealisationTab({ projectId }: { projectId: string }) {
  const base = `/api/v1/projects/${projectId}`;
  const [network, setNetwork] = useState<NetworkResponse | null>(null);
  const [realisation, setRealisation] = useState<RealisationResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [net, real] = await Promise.all([
        api.get<NetworkResponse>(`${base}/benefits/network`),
        api.get<RealisationResponse>(`${base}/benefits/realisation`),
      ]);
      setNetwork(net);
      setRealisation(real);
    } catch (err) {
      setNetwork({ nodes: [], edges: [], basis: "" });
      setError(err instanceof ApiClientError ? err.message : "Could not load benefits realisation");
    }
  }, [base]);

  useEffect(() => {
    void load();
  }, [load]);

  /* ------------------------------ dependencies ------------------------------ */

  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [depType, setDepType] = useState<string>("contributes");
  const [note, setNote] = useState("");
  const [depError, setDepError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function addDependency(e: FormEvent) {
    e.preventDefault();
    setDepError(null);
    setBusy(true);
    try {
      await api.post(`${base}/benefits/dependencies`, {
        fromBenefitId: from,
        toBenefitId: to,
        depType,
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      setFrom("");
      setTo("");
      setNote("");
      await load();
    } catch (err) {
      setDepError(err instanceof ApiClientError ? err.message : "Could not add the dependency");
    } finally {
      setBusy(false);
    }
  }

  async function removeDependency(id: string) {
    setError(null);
    try {
      await api.del(`${base}/benefit-dependencies/${id}`);
      await load();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Could not remove the dependency");
    }
  }

  if (network === null) return <Spinner label="Loading benefits network…" />;

  const nameOfBenefit = (id: string) => {
    const n = network.nodes.find((x) => x.id === id);
    return n ? `B-${String(n.number).padStart(3, "0")} ${n.name}` : id;
  };

  if (network.nodes.length === 0) {
    return (
      <>
        <ErrorAlert message={error} />
        <EmptyState
          title="No benefits to map"
          hint="Register benefits first — the dependency network and the realisation dashboard are built from them."
        />
      </>
    );
  }

  return (
    <div className="space-y-5">
      <ErrorAlert message={error} />

      {/* ------------------------------ status summary ----------------------------- */}
      {realisation ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <Card>
            <CardBody className="px-4 py-3">
              <div className="text-xl font-bold tabular-nums text-ink-900">{realisation.total}</div>
              <div className="text-xs font-medium uppercase tracking-wide text-ink-400">
                Benefits
              </div>
            </CardBody>
          </Card>
          {Object.entries(realisation.byStatus).map(([status, n]) => (
            <Card key={status}>
              <CardBody className="px-4 py-3">
                <div className="text-xl font-bold tabular-nums text-ink-900">{n}</div>
                <div className="mt-0.5">
                  <Badge tone={benefitTone(status)}>{humanize(status)}</Badge>
                </div>
              </CardBody>
            </Card>
          ))}
          <Card>
            <CardBody className="px-4 py-3">
              <div
                className={`text-xl font-bold tabular-nums ${
                  realisation.inheritedAtRisk > 0 ? "text-amber-700" : "text-ink-900"
                }`}
              >
                {realisation.inheritedAtRisk}
              </div>
              <div className="text-xs font-medium uppercase tracking-wide text-ink-400">
                Inherited risk
              </div>
            </CardBody>
          </Card>
        </div>
      ) : null}

      {/* ------------------------------ realisation -------------------------------- */}
      <div>
        <SectionTitle>Planned vs realised</SectionTitle>
        {!realisation || realisation.series.length === 0 ? (
          <p className="rounded-md bg-ink-50 px-3 py-2 text-xs text-ink-500 ring-1 ring-ink-100">
            — no dated readings yet, so no realisation curve can be drawn.
          </p>
        ) : (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {realisation.series.map((s) => (
              <Card key={s.unit}>
                <CardBody>
                  <div className="mb-1 flex items-baseline justify-between">
                    <span className="text-sm font-semibold text-ink-900">{s.unit}</span>
                    <span className="text-xs text-ink-400">
                      {s.benefits} benefit{s.benefits === 1 ? "" : "s"}
                    </span>
                  </div>
                  <SeriesChart points={s.points} />
                  <div className="mt-1 flex gap-4 text-[11px] text-ink-500">
                    <span className="flex items-center gap-1">
                      <span className="inline-block h-0 w-4 border-t border-dashed border-ink-400" />
                      planned
                    </span>
                    <span className="flex items-center gap-1">
                      <span className="inline-block h-0.5 w-4 bg-brand-600" />
                      realised
                    </span>
                  </div>
                </CardBody>
              </Card>
            ))}
          </div>
        )}
        {realisation ? (
          <p className="mt-2 text-xs leading-5 text-ink-400">{realisation.basis}</p>
        ) : null}
      </div>

      {/* -------------------------------- network ---------------------------------- */}
      <div>
        <SectionTitle>Dependency network</SectionTitle>
        <Card>
          <CardBody>
            <Table>
              <thead>
                <tr>
                  <Th>Benefit</Th>
                  <Th>Own status</Th>
                  <Th>Effective</Th>
                  <Th>Depends on</Th>
                  <Th className="text-right">Latest / target</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {network.nodes.map((n) => {
                  const upstream = network.edges.filter((e) => e.toBenefitId === n.id);
                  return (
                    <tr key={n.id}>
                      <Td>
                        <span className="font-mono text-xs text-ink-500">
                          B-{String(n.number).padStart(3, "0")}
                        </span>{" "}
                        <span className="text-sm font-medium text-ink-900">{n.name}</span>
                        {n.isDisbenefit ? (
                          <span className="ml-1.5 rounded-full bg-ink-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-ink-500">
                            disbenefit
                          </span>
                        ) : null}
                      </Td>
                      <Td>
                        <Badge tone={benefitTone(n.ownStatus)}>{humanize(n.ownStatus)}</Badge>
                      </Td>
                      <Td>
                        <Badge tone={benefitTone(n.effectiveStatus)}>
                          {humanize(n.effectiveStatus)}
                        </Badge>
                        {n.inherited ? (
                          <div className="mt-0.5 text-[11px] text-amber-700">
                            inherited{n.reason ? ` — ${n.reason}` : ""}
                          </div>
                        ) : null}
                      </Td>
                      <Td className="text-xs">
                        {upstream.length === 0 ? (
                          <span className="text-ink-300">—</span>
                        ) : (
                          <ul className="space-y-0.5">
                            {upstream.map((e) => (
                              <li key={e.id} className="flex items-center gap-1.5">
                                <span className="rounded bg-ink-100 px-1 text-[10px] font-semibold uppercase text-ink-600">
                                  {e.depType}
                                </span>
                                <span>{nameOfBenefit(e.fromBenefitId)}</span>
                                <button
                                  type="button"
                                  className="text-[11px] text-ink-400 hover:text-red-700"
                                  onClick={() => void removeDependency(e.id)}
                                  aria-label="Remove dependency"
                                >
                                  ✕
                                </button>
                              </li>
                            ))}
                          </ul>
                        )}
                      </Td>
                      <Td className="whitespace-nowrap text-right tabular-nums text-xs">
                        {n.latestValue === null ? (
                          <span className="text-ink-400">no reading</span>
                        ) : (
                          fmtNum(n.latestValue, 2)
                        )}{" "}
                        / {fmtNum(n.targetValue, 2)}
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>

            <form
              onSubmit={addDependency}
              className="mt-4 grid grid-cols-1 gap-3 border-t border-ink-100 pt-3 sm:grid-cols-5"
            >
              <Field label="From (predecessor)">
                <Select required value={from} onChange={(e) => setFrom(e.target.value)}>
                  <option value="">Select…</option>
                  {network.nodes.map((n) => (
                    <option key={n.id} value={n.id}>
                      {nameOfBenefit(n.id)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="To (successor)">
                <Select required value={to} onChange={(e) => setTo(e.target.value)}>
                  <option value="">Select…</option>
                  {network.nodes.map((n) => (
                    <option key={n.id} value={n.id}>
                      {nameOfBenefit(n.id)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Type">
                <Select value={depType} onChange={(e) => setDepType(e.target.value)}>
                  {BENEFIT_DEPENDENCY_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {humanize(t)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Note">
                <Input value={note} onChange={(e) => setNote(e.target.value)} />
              </Field>
              <div className="flex items-end">
                <Button type="submit" size="sm" disabled={busy}>
                  {busy ? "Adding…" : "Add dependency"}
                </Button>
              </div>
              {depError ? (
                <div className="sm:col-span-5">
                  <ErrorAlert message={depError} />
                </div>
              ) : null}
            </form>
            <p className="mt-2 text-xs leading-5 text-ink-400">{network.basis}</p>
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
