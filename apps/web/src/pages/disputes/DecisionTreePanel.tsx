/**
 * Decision-tree settlement model (spec Vol II Domain E #351-355).
 *
 * A single "probability of winning" is not a model — it cannot express
 * partial recovery, staged costs, or the Part 36 / Calderbank consequences
 * that decide who actually pays. This panel edits the tree (branches,
 * per-stage costs, discounting, offer consequences) and shows what the
 * server computed from it: the expected present value, the recommendation
 * against the best live offer, and the probability-weighted litigation
 * provision.
 *
 * A tree whose probabilities do not sum to 1 produces NO recommendation.
 * That is deliberate — a model that does not close should not be trusted to
 * advise a settlement.
 */
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { SETTLEMENT_BRANCH_KINDS } from "@constructos/shared";
import { api, ApiClientError } from "../../lib/api";
import {
  Badge,
  Button,
  Card,
  CardBody,
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
import { fmtMoney, type DisputeDetail } from "./disputesShared";

interface BranchDraft {
  id?: string;
  kind: string;
  label: string;
  probability: string;
  award: string;
}

interface StageDraft {
  id?: string;
  name: string;
  ownCosts: string;
  opponentCosts: string;
}

interface BranchOutcome {
  id: string;
  kind: string;
  label: string;
  probability: number;
  award: number;
  ownCosts: number;
  opponentCostsPayable: number;
  costsUplift: number;
  enhancedInterest: number;
  netOutcome: number;
  presentValue: number;
  weightedPresentValue: number;
}

interface TreeResult {
  currency: string;
  branches: BranchOutcome[];
  expectedValue: number;
  totalOwnCosts: number;
  totalOpponentCosts: number;
  probabilitySum: number;
  valid: boolean;
  bestOffer: { id: string; amount: number; currency: string; direction: string } | null;
  recommendation: "settle" | "proceed" | "insufficient_model";
  rationale: string;
  caveats: string[];
  basis: string;
}

interface StoredModel {
  id: string;
  name: string;
  currency: string;
  branches: Array<{ id: string; kind: string; label: string; probability: number; award: number }>;
  stages: Array<{ id: string; name: string; ownCosts: number; opponentCosts: number }>;
  discountRatePercent: number;
  yearsToResolution: number;
  costsRules: {
    enabled: boolean;
    indemnityCostsPercent: number;
    enhancedInterestPercent: number;
    ownOfferAmount: number | null;
  } | null;
}

interface ModelResponse {
  model: StoredModel | null;
  computed?: TreeResult;
  provision?: {
    provision: number | null;
    currency: string;
    contingentAsset: number | null;
    basis: string;
    unavailableReason: string | null;
  };
  reason?: string;
}

const DEFAULT_BRANCHES: BranchDraft[] = [
  { kind: "win_full", label: "Succeed in full", probability: "0.3", award: "" },
  { kind: "win_partial", label: "Partial recovery", probability: "0.4", award: "" },
  { kind: "lose", label: "Fail", probability: "0.3", award: "0" },
];

export default function DecisionTreePanel({
  projectId,
  dispute,
  onChanged,
}: {
  projectId: string;
  dispute: DisputeDetail;
  onChanged: () => void;
}) {
  const base = `/api/v1/projects/${projectId}`;
  const [data, setData] = useState<ModelResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  const [name, setName] = useState("Decision tree");
  const [branches, setBranches] = useState<BranchDraft[]>(DEFAULT_BRANCHES);
  const [stages, setStages] = useState<StageDraft[]>([
    { name: "Preparation", ownCosts: "0", opponentCosts: "0" },
  ]);
  const [discountRate, setDiscountRate] = useState("0");
  const [years, setYears] = useState("0");
  const [rulesEnabled, setRulesEnabled] = useState(false);
  const [indemnity, setIndemnity] = useState("0");
  const [enhanced, setEnhanced] = useState("0");
  const [ownOffer, setOwnOffer] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api.get<ModelResponse>(`${base}/disputes/${dispute.id}/settlement-model`);
      setData(res);
      if (res.model) {
        setName(res.model.name);
        setBranches(
          res.model.branches.map((b) => ({
            id: b.id,
            kind: b.kind,
            label: b.label,
            probability: String(b.probability),
            award: String(b.award),
          })),
        );
        setStages(
          res.model.stages.map((s) => ({
            id: s.id,
            name: s.name,
            ownCosts: String(s.ownCosts),
            opponentCosts: String(s.opponentCosts),
          })),
        );
        setDiscountRate(String(res.model.discountRatePercent));
        setYears(String(res.model.yearsToResolution));
        setRulesEnabled(res.model.costsRules?.enabled ?? false);
        setIndemnity(String(res.model.costsRules?.indemnityCostsPercent ?? 0));
        setEnhanced(String(res.model.costsRules?.enhancedInterestPercent ?? 0));
        setOwnOffer(
          res.model.costsRules?.ownOfferAmount === null ||
            res.model.costsRules?.ownOfferAmount === undefined
            ? ""
            : String(res.model.costsRules.ownOfferAmount),
        );
      }
    } catch (err) {
      setData({ model: null });
      setError(err instanceof ApiClientError ? err.message : "Could not load the settlement model");
    }
  }, [base, dispute.id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    setBusy(true);
    try {
      await api.put(`${base}/disputes/${dispute.id}/settlement-model`, {
        name: name.trim(),
        branches: branches.map((b) => ({
          ...(b.id ? { id: b.id } : {}),
          kind: b.kind,
          label: b.label.trim(),
          probability: Number(b.probability),
          award: Number(b.award || 0),
        })),
        stages: stages
          .filter((s) => s.name.trim())
          .map((s) => ({
            ...(s.id ? { id: s.id } : {}),
            name: s.name.trim(),
            ownCosts: Number(s.ownCosts || 0),
            opponentCosts: Number(s.opponentCosts || 0),
          })),
        discountRatePercent: Number(discountRate || 0),
        yearsToResolution: Number(years || 0),
        costsRules: {
          enabled: rulesEnabled,
          indemnityCostsPercent: Number(indemnity || 0),
          enhancedInterestPercent: Number(enhanced || 0),
          ownOfferAmount: ownOffer.trim() ? Number(ownOffer) : null,
        },
      });
      setEditing(false);
      await load();
      onChanged();
    } catch (err) {
      setFormError(err instanceof ApiClientError ? err.message : "Could not save the model");
    } finally {
      setBusy(false);
    }
  }

  if (data === null) return <Spinner label="Loading settlement model…" />;

  const computed = data.computed;
  const probSum = branches.reduce((s, b) => s + (Number(b.probability) || 0), 0);

  return (
    <div className="space-y-4">
      <ErrorAlert message={error} />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-sm font-semibold text-ink-900">Decision tree (#351-355)</h4>
        <Button variant="secondary" size="sm" onClick={() => setEditing((v) => !v)}>
          {editing ? "Cancel" : data.model ? "Edit tree" : "Build tree"}
        </Button>
      </div>

      {!data.model && !editing ? (
        <p className="rounded-md bg-ink-50 px-3 py-2 text-xs leading-5 text-ink-500 ring-1 ring-ink-100">
          {data.reason ??
            "No decision tree has been built for this dispute."}
        </p>
      ) : null}

      {/* --------------------------------- editor --------------------------------- */}
      {editing ? (
        <Card>
          <CardBody>
            <form onSubmit={save} className="space-y-4">
              <ErrorAlert message={formError} />
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <Field label="Model name">
                  <Input required value={name} onChange={(e) => setName(e.target.value)} />
                </Field>
                <Field label="Discount rate % p.a.">
                  <Input
                    type="number"
                    min="0"
                    step="0.1"
                    value={discountRate}
                    onChange={(e) => setDiscountRate(e.target.value)}
                  />
                </Field>
                <Field label="Years to resolution">
                  <Input
                    type="number"
                    min="0"
                    step="0.25"
                    value={years}
                    onChange={(e) => setYears(e.target.value)}
                  />
                </Field>
              </div>

              {/* branches */}
              <div>
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-xs font-semibold uppercase tracking-wide text-ink-400">
                    Outcome branches
                  </span>
                  <span
                    className={`text-xs tabular-nums ${
                      Math.abs(probSum - 1) <= 0.005 ? "text-emerald-700" : "text-red-700"
                    }`}
                  >
                    probabilities sum to {probSum.toFixed(3)}
                  </span>
                </div>
                <div className="space-y-2">
                  {branches.map((b, i) => (
                    <div key={i} className="grid grid-cols-1 gap-2 sm:grid-cols-12">
                      <div className="sm:col-span-3">
                        <Select
                          value={b.kind}
                          onChange={(e) =>
                            setBranches((bs) =>
                              bs.map((x, j) => (j === i ? { ...x, kind: e.target.value } : x)),
                            )
                          }
                        >
                          {SETTLEMENT_BRANCH_KINDS.map((k) => (
                            <option key={k} value={k}>
                              {humanize(k)}
                            </option>
                          ))}
                        </Select>
                      </div>
                      <div className="sm:col-span-4">
                        <Input
                          required
                          value={b.label}
                          placeholder="Branch label"
                          onChange={(e) =>
                            setBranches((bs) =>
                              bs.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)),
                            )
                          }
                        />
                      </div>
                      <div className="sm:col-span-2">
                        <Input
                          type="number"
                          min="0"
                          max="1"
                          step="0.01"
                          required
                          value={b.probability}
                          placeholder="p"
                          onChange={(e) =>
                            setBranches((bs) =>
                              bs.map((x, j) =>
                                j === i ? { ...x, probability: e.target.value } : x,
                              ),
                            )
                          }
                        />
                      </div>
                      <div className="sm:col-span-2">
                        <Input
                          type="number"
                          step="any"
                          value={b.award}
                          placeholder="award"
                          onChange={(e) =>
                            setBranches((bs) =>
                              bs.map((x, j) => (j === i ? { ...x, award: e.target.value } : x)),
                            )
                          }
                        />
                      </div>
                      <div className="flex items-center sm:col-span-1">
                        <button
                          type="button"
                          className="text-xs text-ink-400 hover:text-red-700"
                          onClick={() => setBranches((bs) => bs.filter((_, j) => j !== i))}
                          aria-label="Remove branch"
                        >
                          ✕
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="mt-1"
                  onClick={() =>
                    setBranches((bs) => [
                      ...bs,
                      { kind: "win_partial", label: "", probability: "0", award: "0" },
                    ])
                  }
                >
                  + Add branch
                </Button>
              </div>

              {/* stages */}
              <div>
                <span className="text-xs font-semibold uppercase tracking-wide text-ink-400">
                  Cost stages
                </span>
                <div className="mt-1 space-y-2">
                  {stages.map((s, i) => (
                    <div key={i} className="grid grid-cols-1 gap-2 sm:grid-cols-12">
                      <div className="sm:col-span-5">
                        <Input
                          value={s.name}
                          placeholder="Stage (e.g. disclosure)"
                          onChange={(e) =>
                            setStages((ss) =>
                              ss.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)),
                            )
                          }
                        />
                      </div>
                      <div className="sm:col-span-3">
                        <Input
                          type="number"
                          min="0"
                          step="any"
                          value={s.ownCosts}
                          placeholder="own costs"
                          onChange={(e) =>
                            setStages((ss) =>
                              ss.map((x, j) => (j === i ? { ...x, ownCosts: e.target.value } : x)),
                            )
                          }
                        />
                      </div>
                      <div className="sm:col-span-3">
                        <Input
                          type="number"
                          min="0"
                          step="any"
                          value={s.opponentCosts}
                          placeholder="opponent costs"
                          onChange={(e) =>
                            setStages((ss) =>
                              ss.map((x, j) =>
                                j === i ? { ...x, opponentCosts: e.target.value } : x,
                              ),
                            )
                          }
                        />
                      </div>
                      <div className="flex items-center sm:col-span-1">
                        <button
                          type="button"
                          className="text-xs text-ink-400 hover:text-red-700"
                          onClick={() => setStages((ss) => ss.filter((_, j) => j !== i))}
                          aria-label="Remove stage"
                        >
                          ✕
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="mt-1"
                  onClick={() =>
                    setStages((ss) => [...ss, { name: "", ownCosts: "0", opponentCosts: "0" }])
                  }
                >
                  + Add stage
                </Button>
              </div>

              {/* Part 36 */}
              <div className="rounded-md bg-ink-50 p-3 ring-1 ring-ink-100">
                <label className="flex items-center gap-2 text-xs font-medium text-ink-700">
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-brand-600"
                    checked={rulesEnabled}
                    onChange={(e) => setRulesEnabled(e.target.checked)}
                  />
                  Apply Part 36 / Calderbank consequences
                </label>
                {rulesEnabled ? (
                  <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-3">
                    <Field label="Indemnity costs uplift %">
                      <Input
                        type="number"
                        min="0"
                        step="1"
                        value={indemnity}
                        onChange={(e) => setIndemnity(e.target.value)}
                      />
                    </Field>
                    <Field label="Enhanced interest % p.a.">
                      <Input
                        type="number"
                        min="0"
                        step="0.5"
                        value={enhanced}
                        onChange={(e) => setEnhanced(e.target.value)}
                      />
                    </Field>
                    <Field label="Our own offer" hint="Outcomes beating it earn the consequences.">
                      <Input
                        type="number"
                        min="0"
                        step="any"
                        value={ownOffer}
                        onChange={(e) => setOwnOffer(e.target.value)}
                      />
                    </Field>
                  </div>
                ) : null}
              </div>

              <div className="flex justify-end">
                <Button type="submit" disabled={busy}>
                  {busy ? "Evaluating…" : "Save & evaluate"}
                </Button>
              </div>
            </form>
          </CardBody>
        </Card>
      ) : null}

      {/* -------------------------------- results --------------------------------- */}
      {computed ? (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <Badge
              tone={
                computed.recommendation === "settle"
                  ? "amber"
                  : computed.recommendation === "proceed"
                    ? "green"
                    : "gray"
              }
            >
              {humanize(computed.recommendation)}
            </Badge>
            <span className="text-sm">
              Expected present value{" "}
              <strong className="tabular-nums">
                {fmtMoney(computed.expectedValue, computed.currency)}
              </strong>
            </span>
            {computed.bestOffer ? (
              <span className="text-sm text-ink-600">
                best live offer{" "}
                <strong className="tabular-nums">
                  {fmtMoney(computed.bestOffer.amount, computed.bestOffer.currency)}
                </strong>
              </span>
            ) : (
              <span className="text-sm text-ink-500">no live offer to compare</span>
            )}
            {!computed.valid ? (
              <Badge tone="red">
                probabilities sum to {computed.probabilitySum} — no recommendation
              </Badge>
            ) : null}
          </div>

          <p className="text-xs leading-5 text-ink-600">{computed.rationale}</p>

          {computed.caveats.length > 0 ? (
            <ul className="list-disc space-y-1 rounded-md bg-amber-50 px-5 py-2 text-xs leading-5 text-amber-800 ring-1 ring-amber-200">
              {computed.caveats.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          ) : null}

          <div className="overflow-x-auto">
            <Table>
              <thead>
                <tr>
                  <Th>Branch</Th>
                  <Th className="text-right">p</Th>
                  <Th className="text-right">Award</Th>
                  <Th className="text-right">Own costs</Th>
                  <Th className="text-right">Opponent</Th>
                  <Th className="text-right">Part 36</Th>
                  <Th className="text-right">Net</Th>
                  <Th className="text-right">PV</Th>
                  <Th className="text-right">p × PV</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {computed.branches.map((b) => (
                  <tr key={b.id}>
                    <Td className="text-xs">
                      {b.label}
                      <div className="text-[11px] text-ink-400">{humanize(b.kind)}</div>
                    </Td>
                    <Td className="text-right tabular-nums">{b.probability}</Td>
                    <Td className="text-right tabular-nums">
                      {fmtMoney(b.award, computed.currency)}
                    </Td>
                    <Td className="text-right tabular-nums text-ink-500">
                      {fmtMoney(-b.ownCosts, computed.currency)}
                    </Td>
                    <Td className="text-right tabular-nums text-ink-500">
                      {b.opponentCostsPayable === 0
                        ? "—"
                        : fmtMoney(-b.opponentCostsPayable, computed.currency)}
                    </Td>
                    <Td className="text-right tabular-nums text-emerald-700">
                      {b.costsUplift + b.enhancedInterest === 0
                        ? "—"
                        : fmtMoney(b.costsUplift + b.enhancedInterest, computed.currency)}
                    </Td>
                    <Td
                      className={`text-right font-medium tabular-nums ${
                        b.netOutcome < 0 ? "text-red-700" : "text-ink-900"
                      }`}
                    >
                      {fmtMoney(b.netOutcome, computed.currency)}
                    </Td>
                    <Td className="text-right tabular-nums">
                      {fmtMoney(b.presentValue, computed.currency)}
                    </Td>
                    <Td className="text-right font-semibold tabular-nums">
                      {fmtMoney(b.weightedPresentValue, computed.currency)}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>

          {data.provision ? (
            <Card>
              <CardBody>
                <div className="text-xs font-semibold uppercase tracking-wide text-ink-400">
                  Litigation provision
                </div>
                {data.provision.unavailableReason ? (
                  <p className="mt-1 text-sm text-ink-500">
                    — {data.provision.unavailableReason}
                  </p>
                ) : (
                  <>
                    <div className="mt-1 flex flex-wrap gap-4">
                      <span className="text-lg font-bold tabular-nums text-red-700">
                        {fmtMoney(data.provision.provision, data.provision.currency)}
                      </span>
                      <span className="self-center text-xs text-ink-500">
                        contingent asset{" "}
                        <strong className="tabular-nums text-emerald-700">
                          {fmtMoney(data.provision.contingentAsset, data.provision.currency)}
                        </strong>
                      </span>
                    </div>
                    <p className="mt-1 text-xs leading-5 text-ink-400">{data.provision.basis}</p>
                  </>
                )}
              </CardBody>
            </Card>
          ) : null}

          <p className="text-xs leading-5 text-ink-400">{computed.basis}</p>
        </>
      ) : null}
    </div>
  );
}
