/**
 * Optimism bias: inside vs outside view, and the challenge that lets a team
 * depart from the published range on the record (spec Vol I #402-405).
 *
 * The two views are always shown side by side. The inside view is the HM
 * Treasury Green Book table interpolated at a stated mitigation position;
 * the outside view is the empirical uplift of this company's own completed
 * projects in the same class. When the outside view cannot be computed the
 * panel says why rather than showing a zero — a missing reference class is
 * information, not a 0% uplift.
 */
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { OPTIMISM_BIAS_CATEGORIES } from "@constructos/shared";
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
  Textarea,
  Th,
} from "../../ui";
import { formatDate, humanize } from "../format";
import {
  fmtNum,
  SectionTitle,
  type BusinessCaseRow,
  type UpliftChallenge,
} from "./governanceShared";

interface OptimismBand {
  category: string;
  label: string;
  upperPercent: number;
  lowerPercent: number;
  description: string;
}

export default function OptimismPanel({
  base,
  bc,
  onChanged,
}: {
  base: string;
  bc: BusinessCaseRow;
  onChanged: () => void;
}) {
  const draft = bc.status === "draft";
  const rc = bc.referenceClass;

  const [bands, setBands] = useState<OptimismBand[] | null>(null);
  const [challenges, setChallenges] = useState<UpliftChallenge[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [category, setCategory] = useState<string>(rc?.category ?? "standard_building");
  const [position, setPosition] = useState<string>(String(rc?.position ?? 0.5));
  const [useOutside, setUseOutside] = useState(rc?.view === "outside");
  const [confidence, setConfidence] = useState<string>(rc?.outsideConfidence ?? "p80");
  const [mitigations, setMitigations] = useState<string>((rc?.mitigations ?? []).join("\n"));
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [chOpen, setChOpen] = useState(false);
  const [chProposed, setChProposed] = useState("");
  const [chJustification, setChJustification] = useState("");
  const [chError, setChError] = useState<string | null>(null);
  const [chBusy, setChBusy] = useState(false);

  const loadChallenges = useCallback(async () => {
    try {
      const res = await api.get<{ items: UpliftChallenge[] }>(
        `${base}/business-cases/${bc.id}/uplift-challenges`,
      );
      setChallenges(res.items);
    } catch (err) {
      setChallenges([]);
      setError(err instanceof ApiClientError ? err.message : "Could not load uplift challenges");
    }
  }, [base, bc.id]);

  useEffect(() => {
    let cancelled = false;
    api
      .get<{ bands: OptimismBand[] }>("/api/v1/governance/optimism-bias")
      .then((res) => {
        if (!cancelled) setBands(res.bands);
      })
      .catch(() => {
        if (!cancelled) setBands([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    void loadChallenges();
  }, [loadChallenges]);

  async function setReferenceClass(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    setBusy(true);
    try {
      await api.put(`${base}/business-cases/${bc.id}/reference-class`, {
        category,
        position: Number(position),
        useOutsideView: useOutside,
        outsideConfidence: confidence,
        mitigations: mitigations
          .split("\n")
          .map((m) => m.trim())
          .filter(Boolean),
      });
      onChanged();
    } catch (err) {
      setFormError(
        err instanceof ApiClientError ? err.message : "Could not set the optimism bias position",
      );
    } finally {
      setBusy(false);
    }
  }

  async function proposeChallenge(e: FormEvent) {
    e.preventDefault();
    setChError(null);
    setChBusy(true);
    try {
      await api.post(`${base}/business-cases/${bc.id}/uplift-challenges`, {
        category,
        proposedPercent: Number(chProposed),
        justification: chJustification.trim(),
      });
      setChOpen(false);
      setChProposed("");
      setChJustification("");
      await loadChallenges();
      onChanged();
    } catch (err) {
      setChError(err instanceof ApiClientError ? err.message : "Could not propose the challenge");
    } finally {
      setChBusy(false);
    }
  }

  async function decide(ch: UpliftChallenge, verb: "approve" | "reject") {
    setError(null);
    try {
      await api.post(`${base}/uplift-challenges/${ch.id}/${verb}`, {});
      await loadChallenges();
      onChanged();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : `Could not ${verb} the challenge`);
    }
  }

  const band = bands?.find((b) => b.category === category) ?? null;

  return (
    <div className="space-y-4">
      <SectionTitle>Optimism bias — inside vs outside view</SectionTitle>
      <ErrorAlert message={error} />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* ---------------------------- inside view ---------------------------- */}
        <Card>
          <CardBody>
            <div className="mb-2 flex items-center gap-2">
              <Badge tone={rc?.view === "inside" ? "brand" : "gray"}>Inside view</Badge>
              <span className="text-xs text-ink-500">HM Treasury Green Book table</span>
            </div>
            {rc ? (
              <>
                <div className="text-2xl font-bold tabular-nums text-ink-900">
                  +{fmtNum(rc.inside.upliftPercent, 1, 1)}%
                </div>
                <p className="mt-1 text-xs leading-5 text-ink-500">{rc.inside.basis}</p>
                {rc.mitigations.length > 0 ? (
                  <ul className="mt-2 list-disc space-y-0.5 pl-5 text-xs text-ink-600">
                    {rc.mitigations.map((m) => (
                      <li key={m}>{m}</li>
                    ))}
                  </ul>
                ) : null}
              </>
            ) : (
              <p className="text-sm text-ink-500">
                — no optimism-bias position has been set on this case, so the appraisal uses the
                raw appraisal-config percentage.
              </p>
            )}
          </CardBody>
        </Card>

        {/* --------------------------- outside view ---------------------------- */}
        <Card>
          <CardBody>
            <div className="mb-2 flex items-center gap-2">
              <Badge tone={rc?.view === "outside" ? "brand" : "gray"}>Outside view</Badge>
              <span className="text-xs text-ink-500">this company&rsquo;s own outturns</span>
            </div>
            {!rc ? (
              <p className="text-sm text-ink-500">
                — set a reference class to compute the empirical uplift.
              </p>
            ) : rc.outside.unavailableReason ? (
              <p className="text-sm leading-5 text-ink-500">— {rc.outside.unavailableReason}</p>
            ) : (
              <>
                <div className="text-2xl font-bold tabular-nums text-ink-900">
                  +{fmtNum(rc.outside.p80UpliftPercent, 1, 1)}%
                  <span className="ml-1 text-xs font-medium text-ink-400">at P80</span>
                </div>
                <div className="mt-1 flex flex-wrap gap-3 text-xs text-ink-600">
                  <span>
                    P50 <strong className="tabular-nums">+{fmtNum(rc.outside.p50UpliftPercent, 1, 1)}%</strong>
                  </span>
                  <span>
                    P90 <strong className="tabular-nums">+{fmtNum(rc.outside.p90UpliftPercent, 1, 1)}%</strong>
                  </span>
                  <span>
                    mean{" "}
                    <strong className="tabular-nums">+{fmtNum(rc.outside.meanUpliftPercent, 1, 1)}%</strong>
                  </span>
                  <span>
                    n = <strong className="tabular-nums">{rc.outside.sampleSize}</strong>
                  </span>
                </div>
                {rc.outside.thin ? (
                  <p className="mt-2 rounded-md bg-amber-50 px-2 py-1 text-xs text-amber-800 ring-1 ring-amber-200">
                    Thin sample — the percentiles are reported but should not be treated as
                    reliable.
                  </p>
                ) : null}
                <p className="mt-2 text-xs leading-5 text-ink-500">{rc.outside.basisNote}</p>
              </>
            )}
          </CardBody>
        </Card>
      </div>

      {rc ? (
        <div className="rounded-md bg-brand-50 px-3 py-2 text-xs text-brand-900 ring-1 ring-brand-100">
          Applied to the appraisal: <strong className="tabular-nums">+{fmtNum(rc.appliedPercent, 1, 1)}%</strong>{" "}
          on capex, taken from the <strong>{rc.view}</strong> view
          {rc.view === "outside" ? ` at ${rc.outsideConfidence.toUpperCase()}` : ""} · set{" "}
          {formatDate(rc.setAt)}.
        </div>
      ) : null}

      {/* ------------------------------ set position ------------------------------ */}
      {draft ? (
        <Card>
          <CardBody>
            <form onSubmit={setReferenceClass} className="space-y-3">
              <ErrorAlert message={formError} />
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
                <Field label="Reference class">
                  <Select value={category} onChange={(e) => setCategory(e.target.value)}>
                    {OPTIMISM_BIAS_CATEGORIES.map((c) => (
                      <option key={c} value={c}>
                        {humanize(c)}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field
                  label="Mitigation position (0–1)"
                  hint={
                    band
                      ? `0 = upper ${band.upperPercent}%, 1 = lower ${band.lowerPercent}%`
                      : "0 = upper bound, 1 = lower bound"
                  }
                >
                  <Input
                    type="number"
                    min="0"
                    max="1"
                    step="0.05"
                    value={position}
                    onChange={(e) => setPosition(e.target.value)}
                  />
                </Field>
                <Field label="Apply which view">
                  <Select
                    value={useOutside ? "outside" : "inside"}
                    onChange={(e) => setUseOutside(e.target.value === "outside")}
                  >
                    <option value="inside">Inside (published table)</option>
                    <option value="outside">Outside (reference class)</option>
                  </Select>
                </Field>
                <Field label="Outside confidence">
                  <Select
                    value={confidence}
                    onChange={(e) => setConfidence(e.target.value)}
                    disabled={!useOutside}
                  >
                    <option value="p50">P50</option>
                    <option value="p80">P80</option>
                    <option value="p90">P90</option>
                  </Select>
                </Field>
              </div>
              <Field
                label="Bias drivers addressed"
                hint="One per line — the justification for moving down the range."
              >
                <Textarea
                  value={mitigations}
                  onChange={(e) => setMitigations(e.target.value)}
                  className="min-h-16 text-xs"
                  placeholder={"Design frozen at RIBA 4\nGround investigation complete\nContractor engaged early"}
                />
              </Field>
              <div className="flex justify-end">
                <Button type="submit" size="sm" disabled={busy}>
                  {busy ? "Recomputing…" : "Set position & recompute options"}
                </Button>
              </div>
            </form>
          </CardBody>
        </Card>
      ) : null}

      {/* ------------------------------- challenges ------------------------------- */}
      <div>
        <div className="mb-2 flex items-center justify-between">
          <SectionTitle>Uplift challenges (#405)</SectionTitle>
          {draft && rc ? (
            <Button size="sm" variant="secondary" onClick={() => setChOpen((v) => !v)}>
              {chOpen ? "Cancel" : "Propose a departure"}
            </Button>
          ) : null}
        </div>

        {chOpen ? (
          <Card className="mb-3">
            <CardBody>
              <form onSubmit={proposeChallenge} className="space-y-3">
                <ErrorAlert message={chError} />
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <Field label="Proposed uplift %">
                    <Input
                      type="number"
                      step="0.1"
                      min="0"
                      required
                      value={chProposed}
                      onChange={(e) => setChProposed(e.target.value)}
                    />
                  </Field>
                  <div className="sm:col-span-2">
                    <Field label="Justification">
                      <Input
                        required
                        value={chJustification}
                        onChange={(e) => setChJustification(e.target.value)}
                        placeholder="Two comparable schemes delivered within 4% — the class bound overstates our exposure…"
                        minLength={20}
                      />
                    </Field>
                  </div>
                </div>
                <div className="flex justify-end">
                  <Button type="submit" size="sm" disabled={chBusy}>
                    {chBusy ? "Proposing…" : "Propose"}
                  </Button>
                </div>
              </form>
            </CardBody>
          </Card>
        ) : null}

        {challenges === null ? (
          <Spinner />
        ) : challenges.length === 0 ? (
          <p className="rounded-md bg-ink-50 px-3 py-2 text-xs text-ink-500 ring-1 ring-ink-100">
            No departures from the published range have been proposed on this case.
          </p>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Class</Th>
                <Th className="text-right">Table</Th>
                <Th className="text-right">Proposed</Th>
                <Th>Justification</Th>
                <Th>Status</Th>
                <Th className="text-right">Decision</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {challenges.map((ch) => (
                <tr key={ch.id}>
                  <Td className="text-xs">{humanize(ch.category)}</Td>
                  <Td className="text-right tabular-nums">+{fmtNum(ch.tablePercent, 1, 1)}%</Td>
                  <Td className="text-right font-semibold tabular-nums">
                    +{fmtNum(ch.proposedPercent, 1, 1)}%
                  </Td>
                  <Td className="text-xs">{ch.justification}</Td>
                  <Td>
                    <Badge
                      tone={
                        ch.status === "approved"
                          ? "green"
                          : ch.status === "rejected"
                            ? "red"
                            : "amber"
                      }
                    >
                      {humanize(ch.status)}
                    </Badge>
                  </Td>
                  <Td className="text-right">
                    {ch.status === "proposed" ? (
                      <div className="flex justify-end gap-1.5">
                        <Button size="sm" onClick={() => void decide(ch, "approve")}>
                          Approve
                        </Button>
                        <Button size="sm" variant="danger" onClick={() => void decide(ch, "reject")}>
                          Reject
                        </Button>
                      </div>
                    ) : (
                      <span className="text-xs text-ink-400">
                        {ch.decidedAt ? formatDate(ch.decidedAt) : "—"}
                      </span>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        <p className="mt-1.5 text-xs text-ink-400">
          Proposer and decider must be different people; an approved challenge replaces the applied
          uplift and re-computes every option.
        </p>
      </div>
    </div>
  );
}
