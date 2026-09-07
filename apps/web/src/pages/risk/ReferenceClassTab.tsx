/**
 * Reference class forecasting and optimism bias (spec Vol II Domain H
 * #402-405).
 *
 * Two views of the same question — by how much will this estimate be wrong?
 * The INSIDE view is the HM Treasury table at a stated mitigation position.
 * The OUTSIDE view is the empirical outturn/estimate distribution of the
 * company's own completed projects in the same class. Neither is chosen for
 * the user: both are shown with their basis and their sample size, and a
 * thin sample says so rather than pretending to be a distribution.
 */
import { useCallback, useEffect, useState, type FormEvent } from "react";
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
import { formatDate, humanize } from "../format";
import { fmtNum } from "./riskShared";

const CATEGORIES = [
  "standard_building",
  "non_standard_building",
  "standard_civil_engineering",
  "non_standard_civil_engineering",
  "equipment_development",
  "outsourcing",
] as const;

type Category = (typeof CATEGORIES)[number];

interface Band {
  category: string;
  label: string;
  upperPercent: number;
  lowerPercent: number;
  description: string;
}

interface UpliftPosition {
  category: string;
  upperPercent: number;
  lowerPercent: number;
  position: number;
  upliftPercent: number;
  basis: string;
}

interface Forecast {
  basis: string;
  category: string;
  sampleSize: number;
  ratios: number[];
  p50UpliftPercent: number | null;
  p80UpliftPercent: number | null;
  p90UpliftPercent: number | null;
  meanUpliftPercent: number | null;
  thin: boolean;
  basisNote: string;
  unavailableReason: string | null;
}

interface ReferenceProject {
  id: string;
  name: string;
  category: string;
  assetClass: string | null;
  country: string | null;
  currency: string;
  estimatedCost: number | null;
  outturnCost: number | null;
  estimatedDurationDays: number | null;
  outturnDurationDays: number | null;
  completedAt: string | null;
  source: string | null;
  note: string | null;
}

interface ClassResponse {
  inside: UpliftPosition | null;
  outside: Forecast;
  references: Array<{
    id: string;
    name: string;
    currency: string;
    estimatedCost: number | null;
    outturnCost: number | null;
    estimatedDurationDays: number | null;
    outturnDurationDays: number | null;
    completedAt: string | null;
  }>;
}

export default function ReferenceClassTab() {
  const [bands, setBands] = useState<Band[]>([]);
  const [category, setCategory] = useState<Category>("standard_building");
  const [position, setPosition] = useState(0);
  const [basisMode, setBasisMode] = useState<"cost" | "duration">("cost");
  const [data, setData] = useState<ClassResponse | null>(null);
  const [refs, setRefs] = useState<ReferenceProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [name, setName] = useState("");
  const [estimated, setEstimated] = useState("");
  const [outturn, setOutturn] = useState("");
  const [estDays, setEstDays] = useState("");
  const [outDays, setOutDays] = useState("");
  const [completedAt, setCompletedAt] = useState("");
  const [currency, setCurrency] = useState("GBP");

  useEffect(() => {
    api
      .get<{ bands: Band[] }>("/api/v1/risk/optimism-bias")
      .then((r) => setBands(r.bands ?? []))
      .catch(() => setBands([]));
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [cls, list] = await Promise.all([
        api.get<ClassResponse>(
          `/api/v1/risk/reference-class?category=${category}&basis=${basisMode}&position=${position}`,
        ),
        api.get<{ items: ReferenceProject[] }>(
          `/api/v1/risk/reference-projects?pageSize=200&category=${category}`,
        ),
      ]);
      setData(cls);
      setRefs(list.items ?? []);
    } catch (err) {
      setError(
        err instanceof ApiClientError ? err.message : "Could not load the reference class",
      );
    } finally {
      setLoading(false);
    }
  }, [category, basisMode, position]);

  useEffect(() => {
    void load();
  }, [load]);

  async function addReference(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setFormError(null);
    try {
      await api.post("/api/v1/risk/reference-projects", {
        name,
        category,
        currency,
        estimatedCost: estimated.trim() === "" ? null : Number(estimated),
        outturnCost: outturn.trim() === "" ? null : Number(outturn),
        estimatedDurationDays: estDays.trim() === "" ? null : Number(estDays),
        outturnDurationDays: outDays.trim() === "" ? null : Number(outDays),
        completedAt: completedAt.trim() === "" ? null : completedAt,
      });
      setName("");
      setEstimated("");
      setOutturn("");
      setEstDays("");
      setOutDays("");
      setCompletedAt("");
      await load();
    } catch (err) {
      setFormError(
        err instanceof ApiClientError ? err.message : "Could not add the reference project",
      );
    } finally {
      setSaving(false);
    }
  }

  const band = bands.find((b) => b.category === category) ?? null;

  return (
    <div className="space-y-5">
      <Card>
        <CardBody>
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Reference class" className="min-w-56">
              <Select value={category} onChange={(e) => setCategory(e.target.value as Category)}>
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {bands.find((b) => b.category === c)?.label ?? humanize(c)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Outside view basis" className="min-w-40">
              <Select
                value={basisMode}
                onChange={(e) => setBasisMode(e.target.value as "cost" | "duration")}
              >
                <option value="cost">Cost</option>
                <option value="duration">Duration</option>
              </Select>
            </Field>
            <Field
              label={`Mitigation position (${position.toFixed(2)})`}
              hint="0 = nothing mitigated (upper bound) · 1 = every driver addressed (lower bound)"
              className="min-w-64 flex-1"
            >
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={position}
                onChange={(e) => setPosition(Number(e.target.value))}
                className="w-full accent-brand-600"
              />
            </Field>
          </div>
          {band ? (
            <p className="mt-2 text-xs leading-relaxed text-ink-500">{band.description}</p>
          ) : null}
        </CardBody>
      </Card>

      {loading ? <Spinner label="Computing the reference class…" /> : null}
      {error ? <ErrorAlert message={error} onRetry={() => void load()} /> : null}

      {data && !loading ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardBody>
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-ink-800">Inside view — the table</h3>
                <Badge tone="blue">HM Treasury Green Book</Badge>
              </div>
              {data.inside ? (
                <>
                  <div className="mt-3 text-3xl font-semibold tabular-nums text-ink-900">
                    {data.inside.upliftPercent}%
                  </div>
                  <div className="mt-1 text-xs text-ink-500">
                    Range {data.inside.upperPercent}% (nothing mitigated) →{" "}
                    {data.inside.lowerPercent}% (all drivers addressed)
                  </div>
                  <div className="mt-3 h-2 w-full rounded-full bg-ink-100">
                    <div
                      className="h-2 rounded-full bg-brand-500"
                      style={{ width: `${Math.round(data.inside.position * 100)}%` }}
                    />
                  </div>
                  <p className="mt-3 text-xs leading-relaxed text-ink-500">{data.inside.basis}</p>
                </>
              ) : (
                <EmptyState title="No band for this category" />
              )}
            </CardBody>
          </Card>

          <Card>
            <CardBody>
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-ink-800">
                  Outside view — your own outturns
                </h3>
                {data.outside.sampleSize > 0 ? (
                  <Badge tone={data.outside.thin ? "amber" : "green"}>
                    n = {data.outside.sampleSize}
                    {data.outside.thin ? " (thin)" : ""}
                  </Badge>
                ) : (
                  <Badge tone="gray">No sample</Badge>
                )}
              </div>
              {data.outside.unavailableReason ? (
                <div className="mt-3 rounded-md bg-ink-50 px-3 py-3 text-sm text-ink-600 ring-1 ring-ink-200">
                  {data.outside.unavailableReason}
                </div>
              ) : (
                <>
                  <div className="mt-3 grid grid-cols-3 gap-2 text-center">
                    {(
                      [
                        ["P50", data.outside.p50UpliftPercent],
                        ["P80", data.outside.p80UpliftPercent],
                        ["P90", data.outside.p90UpliftPercent],
                      ] as const
                    ).map(([label, value]) => (
                      <div key={label} className="rounded-md bg-ink-50 px-2 py-3">
                        <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-400">
                          {label}
                        </div>
                        <div className="mt-0.5 text-xl font-semibold tabular-nums">
                          {value === null ? "—" : `${value}%`}
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="mt-2 text-xs text-ink-500">
                    Mean uplift{" "}
                    {data.outside.meanUpliftPercent === null
                      ? "—"
                      : `${data.outside.meanUpliftPercent}%`}
                  </div>
                  <p className="mt-3 text-xs leading-relaxed text-ink-500">
                    {data.outside.basisNote}
                  </p>
                </>
              )}
            </CardBody>
          </Card>
        </div>
      ) : null}

      <Card>
        <CardBody>
          <h3 className="mb-3 text-sm font-semibold text-ink-800">
            Reference projects in this class
          </h3>
          {refs.length === 0 ? (
            <EmptyState
              title="No completed projects recorded in this class"
              description="The outside view is empirical: it needs projects that finished, with both what they were estimated to cost and what they actually cost. Until there are some, only the published table is available."
            />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Project</Th>
                  <Th>Completed</Th>
                  <Th className="text-right">Estimated</Th>
                  <Th className="text-right">Outturn</Th>
                  <Th className="text-right">Ratio</Th>
                </tr>
              </thead>
              <tbody>
                {refs.map((r) => {
                  const est = basisMode === "cost" ? r.estimatedCost : r.estimatedDurationDays;
                  const out = basisMode === "cost" ? r.outturnCost : r.outturnDurationDays;
                  const ratio = est && est > 0 && out !== null ? out / est : null;
                  return (
                    <tr key={r.id}>
                      <Td className="font-medium">{r.name}</Td>
                      <Td>{formatDate(r.completedAt)}</Td>
                      <Td className="text-right tabular-nums">{est === null ? "—" : fmtNum(est)}</Td>
                      <Td className="text-right tabular-nums">{out === null ? "—" : fmtNum(out)}</Td>
                      <Td className="text-right tabular-nums">
                        {ratio === null ? (
                          <span className="text-ink-400">not comparable</span>
                        ) : (
                          <span className={ratio > 1 ? "text-red-700" : "text-emerald-700"}>
                            {ratio.toFixed(2)}×
                          </span>
                        )}
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardBody>
          <h3 className="mb-3 text-sm font-semibold text-ink-800">Add a reference project</h3>
          {formError ? <ErrorAlert message={formError} /> : null}
          <form className="grid gap-3 md:grid-cols-4" onSubmit={addReference}>
            <Field label="Name" className="md:col-span-2">
              <Input value={name} required onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label="Currency">
              <Input
                value={currency}
                maxLength={3}
                onChange={(e) => setCurrency(e.target.value.toUpperCase())}
              />
            </Field>
            <Field label="Completed">
              <Input type="date" value={completedAt} onChange={(e) => setCompletedAt(e.target.value)} />
            </Field>
            <Field label="Estimated cost">
              <Input type="number" min={0} value={estimated} onChange={(e) => setEstimated(e.target.value)} />
            </Field>
            <Field label="Outturn cost">
              <Input type="number" min={0} value={outturn} onChange={(e) => setOutturn(e.target.value)} />
            </Field>
            <Field label="Estimated days">
              <Input type="number" min={0} value={estDays} onChange={(e) => setEstDays(e.target.value)} />
            </Field>
            <Field label="Outturn days">
              <Input type="number" min={0} value={outDays} onChange={(e) => setOutDays(e.target.value)} />
            </Field>
            <div className="md:col-span-4">
              <Button type="submit" disabled={saving || name.trim() === ""}>
                {saving ? "Saving…" : "Add reference project"}
              </Button>
              <span className="ml-3 text-xs text-ink-500">
                A project missing either number is kept on the register but excluded from the
                forecast — a made-up ratio would poison the whole class.
              </span>
            </div>
          </form>
        </CardBody>
      </Card>
    </div>
  );
}
