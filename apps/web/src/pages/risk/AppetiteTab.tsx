/**
 * Risk appetite and tolerance (spec Vol II Domain H #472).
 *
 * The board says what it will accept; the register says what is actually
 * carried. This tab puts the two side by side and names every breach with
 * the risk that caused it. Exceeding appetite is not an error — it is a
 * fact somebody is entitled to be told — so nothing here blocks a write.
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
import { humanize } from "../format";
import { fmtNum, rskLabel } from "./riskShared";

const CATEGORIES = [
  "technical",
  "commercial",
  "external",
  "organisational",
  "environmental",
  "political",
] as const;

interface AppetiteRule {
  id: string;
  scope: string;
  category: string | null;
  maxScore: number | null;
  maxExpectedValue: number | null;
  currency: string;
  note: string | null;
  updatedAt: string;
}

interface AppetiteBreach {
  ruleId: string;
  scope: string;
  category: string | null;
  kind: string;
  limit: number;
  actual: number;
  riskId: string | null;
  riskNumber: number | null;
  detail: string;
}

interface AppetiteResponse {
  rules: AppetiteRule[];
  breaches: AppetiteBreach[];
  liveRisks: number;
  quantifiedRisks: number;
  basis: string;
}

export default function AppetiteTab({ base }: { base: string }) {
  const [data, setData] = useState<AppetiteResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [scope, setScope] = useState<"project" | "category">("project");
  const [category, setCategory] = useState<string>("technical");
  const [maxScore, setMaxScore] = useState("");
  const [maxEv, setMaxEv] = useState("");
  const [currency, setCurrency] = useState("GBP");
  const [note, setNote] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await api.get<AppetiteResponse>(`${base}/risk/appetite`));
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Could not load risk appetite");
    } finally {
      setLoading(false);
    }
  }, [base]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setFormError(null);
    try {
      await api.put(`${base}/risk/appetite`, {
        scope,
        category: scope === "category" ? category : null,
        maxScore: maxScore.trim() === "" ? null : Number(maxScore),
        maxExpectedValue: maxEv.trim() === "" ? null : Number(maxEv),
        currency,
        note: note.trim() === "" ? null : note.trim(),
      });
      setMaxScore("");
      setMaxEv("");
      setNote("");
      await load();
    } catch (err) {
      setFormError(err instanceof ApiClientError ? err.message : "Could not save the threshold");
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <Spinner label="Loading risk appetite…" />;
  if (error) return <ErrorAlert message={error} onRetry={() => void load()} />;
  if (!data) return null;

  const breachesByRule = new Map<string, AppetiteBreach[]>();
  for (const b of data.breaches) {
    const list = breachesByRule.get(b.ruleId) ?? [];
    list.push(b);
    breachesByRule.set(b.ruleId, list);
  }

  return (
    <div className="space-y-5">
      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardBody>
            <div className="text-xs font-semibold uppercase tracking-wide text-ink-400">
              Live risks
            </div>
            <div className="mt-1 text-2xl font-semibold tabular-nums">{data.liveRisks}</div>
            <div className="mt-1 text-xs text-ink-500">
              {data.quantifiedRisks} quantified with a cost distribution
            </div>
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <div className="text-xs font-semibold uppercase tracking-wide text-ink-400">
              Thresholds set
            </div>
            <div className="mt-1 text-2xl font-semibold tabular-nums">{data.rules.length}</div>
            <div className="mt-1 text-xs text-ink-500">
              {data.rules.length === 0
                ? "No appetite is recorded — nothing can be measured against it"
                : "Evaluated on every register change and twice a day"}
            </div>
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <div className="text-xs font-semibold uppercase tracking-wide text-ink-400">
              Breaches
            </div>
            <div
              className={`mt-1 text-2xl font-semibold tabular-nums ${
                data.breaches.length > 0 ? "text-red-700" : "text-emerald-700"
              }`}
            >
              {data.breaches.length}
            </div>
            <div className="mt-1 text-xs text-ink-500">
              {data.breaches.length === 0
                ? "The register is inside appetite"
                : "Each raises a signal on the integrity feed"}
            </div>
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardBody>
          <h3 className="mb-3 text-sm font-semibold text-ink-800">Thresholds</h3>
          {data.rules.length === 0 ? (
            <EmptyState
              title="No appetite thresholds"
              description="Set a maximum acceptable probability × impact score, a maximum quantified expected value, or both. A threshold left unset is simply not evaluated."
            />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Scope</Th>
                  <Th>Max score</Th>
                  <Th>Max expected value</Th>
                  <Th>Breaches</Th>
                  <Th>Note</Th>
                </tr>
              </thead>
              <tbody>
                {data.rules.map((rule) => {
                  const breaches = breachesByRule.get(rule.id) ?? [];
                  return (
                    <tr key={rule.id}>
                      <Td>
                        {rule.scope === "project" ? (
                          <Badge tone="blue">Whole project</Badge>
                        ) : (
                          <Badge tone="violet">{humanize(rule.category ?? "")}</Badge>
                        )}
                      </Td>
                      <Td className="tabular-nums">{rule.maxScore ?? "—"}</Td>
                      <Td className="tabular-nums">
                        {rule.maxExpectedValue === null
                          ? "—"
                          : `${rule.currency} ${fmtNum(rule.maxExpectedValue)}`}
                      </Td>
                      <Td>
                        {breaches.length === 0 ? (
                          <Badge tone="green">Within appetite</Badge>
                        ) : (
                          <Badge tone="red">{breaches.length}</Badge>
                        )}
                      </Td>
                      <Td className="max-w-xs text-xs text-ink-500">{rule.note ?? "—"}</Td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          )}
        </CardBody>
      </Card>

      {data.breaches.length > 0 ? (
        <Card>
          <CardBody>
            <h3 className="mb-3 text-sm font-semibold text-ink-800">What is outside appetite</h3>
            <ul className="space-y-2">
              {data.breaches.map((b, i) => (
                <li
                  key={`${b.ruleId}-${b.kind}-${b.riskId ?? "portfolio"}-${i}`}
                  className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-900 ring-1 ring-red-200"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone="red">{humanize(b.kind)}</Badge>
                    {b.riskNumber !== null ? (
                      <span className="font-mono text-xs">{rskLabel(b.riskNumber)}</span>
                    ) : null}
                    <span className="tabular-nums text-xs">
                      {fmtNum(b.actual)} against a limit of {fmtNum(b.limit)}
                    </span>
                  </div>
                  <p className="mt-1 text-xs leading-relaxed">{b.detail}</p>
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      ) : null}

      <Card>
        <CardBody>
          <h3 className="mb-3 text-sm font-semibold text-ink-800">Set a threshold</h3>
          {formError ? <ErrorAlert message={formError} /> : null}
          <form className="grid gap-3 md:grid-cols-3" onSubmit={save}>
            <Field label="Scope">
              <Select value={scope} onChange={(e) => setScope(e.target.value as typeof scope)}>
                <option value="project">Whole project</option>
                <option value="category">One category</option>
              </Select>
            </Field>
            <Field label="Category">
              <Select
                value={category}
                disabled={scope !== "category"}
                onChange={(e) => setCategory(e.target.value)}
              >
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {humanize(c)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Currency">
              <Input value={currency} maxLength={3} onChange={(e) => setCurrency(e.target.value.toUpperCase())} />
            </Field>
            <Field label="Max probability × impact (1–25)" hint="Leave blank not to test the score">
              <Input
                type="number"
                min={1}
                max={25}
                value={maxScore}
                onChange={(e) => setMaxScore(e.target.value)}
              />
            </Field>
            <Field label="Max expected value" hint="Leave blank not to test quantified exposure">
              <Input
                type="number"
                min={0}
                value={maxEv}
                onChange={(e) => setMaxEv(e.target.value)}
              />
            </Field>
            <Field label="Note">
              <Input value={note} onChange={(e) => setNote(e.target.value)} />
            </Field>
            <div className="md:col-span-3">
              <Button type="submit" disabled={saving}>
                {saving ? "Saving…" : "Save threshold"}
              </Button>
              <span className="ml-3 text-xs text-ink-500">
                Saving with both limits blank removes the threshold — an appetite with no limit is
                not an appetite.
              </span>
            </div>
          </form>
        </CardBody>
      </Card>

      <p className="text-xs leading-relaxed text-ink-500">{data.basis}</p>
    </div>
  );
}
