/**
 * Risk drawer (spec Domain H #450-454): score movement, the quantification
 * summary, the mitigation checklist (add / toggle-done, persisted via PATCH),
 * the mitigation-value verdict card (worthwhile ✓/✗) and status actions.
 */
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { RISK_STATUSES } from "@constructos/shared";
import { api, ApiClientError } from "../../lib/api";
import { Badge, Button, Card, CardBody, ErrorAlert, Input, Spinner } from "../../ui";
import { formatDate, humanize } from "../format";
import {
  bandChipClass,
  bandTone,
  categoryTone,
  distLabel,
  fmtNum,
  isQuantified,
  parseMitigations,
  postScore,
  preScore,
  riskStatusTone,
  rskLabel,
  type MitigationAction,
  type RiskRow,
  type UserLite,
} from "./riskShared";

interface MitigationValue {
  riskId: string;
  mitigationCost: number | null;
  expectedValueBefore: number;
  expectedValueAfter: number;
  riskReduction: number;
  worthwhile: boolean;
  method: string;
}

function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-ink-400">
      {children}
    </div>
  );
}

function ScoreChip({ score }: { score: number }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-bold tabular-nums ${bandChipClass[bandTone(score)]}`}
    >
      {score}
    </span>
  );
}

const STATUS_ACTION_LABEL: Record<string, string> = {
  open: "Reopen",
  mitigating: "Start mitigating",
  closed: "Close",
  realised: "Mark realised",
};

export default function RiskDrawer({
  projectId,
  riskId,
  users,
  onClose,
  onChanged,
  onEdit,
}: {
  projectId: string;
  riskId: string;
  users: UserLite[];
  onClose: () => void;
  onChanged: () => void;
  onEdit: (risk: RiskRow) => void;
}) {
  const base = `/api/v1/projects/${projectId}`;
  const [risk, setRisk] = useState<RiskRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mv, setMv] = useState<MitigationValue | null>(null);
  const [mvHint, setMvHint] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [newAction, setNewAction] = useState("");

  const load = useCallback(async () => {
    setError(null);
    try {
      const r = await api.get<RiskRow>(`${base}/risks/${riskId}`);
      setRisk(r);
      try {
        setMv(await api.get<MitigationValue>(`${base}/risks/${riskId}/mitigation-value`));
        setMvHint(null);
      } catch (err) {
        setMv(null);
        setMvHint(
          err instanceof ApiClientError && err.status === 400
            ? "Quantify the risk (occurrence probability + cost impact) to value its mitigation."
            : "Mitigation value is unavailable.",
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load the risk");
    }
  }, [base, riskId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function patchMitigations(next: MitigationAction[]) {
    setBusy(true);
    setError(null);
    try {
      const updated = await api.patch<RiskRow>(`${base}/risks/${riskId}`, { mitigations: next });
      setRisk(updated);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Failed to update mitigations.");
    } finally {
      setBusy(false);
    }
  }

  async function onAddAction(e: FormEvent) {
    e.preventDefault();
    if (!risk || !newAction.trim()) return;
    const next = [...parseMitigations(risk.mitigations), { description: newAction.trim(), done: false }];
    setNewAction("");
    await patchMitigations(next);
  }

  async function onToggle(idx: number) {
    if (!risk) return;
    const next = parseMitigations(risk.mitigations).map((m, i) =>
      i === idx ? { ...m, done: !m.done } : m,
    );
    await patchMitigations(next);
  }

  async function onStatus(status: string) {
    setBusy(true);
    setError(null);
    try {
      const updated = await api.post<RiskRow>(`${base}/risks/${riskId}/status`, { status });
      setRisk(updated);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Failed to change status.");
    } finally {
      setBusy(false);
    }
  }

  const ownerName = (id: string | null) =>
    id ? (users.find((u) => u.id === id)?.name ?? id) : "Unassigned";

  const mitigations = risk ? parseMitigations(risk.mitigations) : [];
  const doneCount = mitigations.filter((m) => m.done).length;
  const pre = risk ? preScore(risk) : 0;
  const post = risk ? postScore(risk) : null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-ink-950/40" onClick={onClose}>
      <div
        className="h-full w-full max-w-2xl overflow-y-auto bg-white p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {!risk ? (
          <>
            <ErrorAlert message={error} />
            <Spinner label="Loading risk…" />
          </>
        ) : (
          <>
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <div className="mb-1 flex items-center gap-2">
                  <span className="font-mono text-xs text-ink-400">{rskLabel(risk.number)}</span>
                  <Badge tone={categoryTone(risk.category)}>{humanize(risk.category)}</Badge>
                  <Badge tone={riskStatusTone(risk.status)}>{humanize(risk.status)}</Badge>
                </div>
                <h2 className="text-lg font-semibold text-ink-900">{risk.title}</h2>
              </div>
              <div className="flex items-center gap-2">
                <Button variant="secondary" size="sm" onClick={() => onEdit(risk)}>
                  Edit
                </Button>
                <button
                  type="button"
                  onClick={onClose}
                  className="rounded p-1 text-ink-400 hover:bg-ink-100 hover:text-ink-700"
                  aria-label="Close"
                >
                  ✕
                </button>
              </div>
            </div>

            <ErrorAlert message={error} />

            {/* scoring movement */}
            <Card className="mb-4">
              <CardBody className="flex flex-wrap items-center gap-x-6 gap-y-2 py-3">
                <div>
                  <div className="text-[11px] font-medium uppercase tracking-wide text-ink-400">
                    Pre-mitigation
                  </div>
                  <div className="mt-0.5 flex items-center gap-1.5 text-sm text-ink-700">
                    P{risk.probabilityScore} × I{risk.impactScore} = <ScoreChip score={pre} />
                  </div>
                </div>
                {post != null ? (
                  <>
                    <span className="text-lg text-ink-300" aria-hidden>
                      →
                    </span>
                    <div>
                      <div className="text-[11px] font-medium uppercase tracking-wide text-ink-400">
                        Post-mitigation
                      </div>
                      <div className="mt-0.5 flex items-center gap-1.5 text-sm text-ink-700">
                        P{risk.postProbabilityScore} × I{risk.postImpactScore} ={" "}
                        <ScoreChip score={post} />
                      </div>
                    </div>
                  </>
                ) : (
                  <span className="text-xs text-ink-400">No post-mitigation scores yet.</span>
                )}
                <div className="ml-auto text-right">
                  <div className="text-[11px] font-medium uppercase tracking-wide text-ink-400">
                    Owner
                  </div>
                  <div className="mt-0.5 text-sm text-ink-700">{ownerName(risk.ownerId)}</div>
                </div>
              </CardBody>
            </Card>

            {risk.description ? (
              <p className="mb-4 whitespace-pre-wrap text-sm leading-6 text-ink-600">
                {risk.description}
              </p>
            ) : null}

            {/* quantification */}
            <div className="mb-4">
              <SectionTitle>Quantification</SectionTitle>
              <Card>
                <CardBody className="grid grid-cols-1 gap-3 py-3 text-sm sm:grid-cols-2">
                  <div>
                    <span className="text-xs text-ink-400">Occurrence probability</span>
                    <div className="font-medium tabular-nums text-ink-800">
                      {risk.occurrenceProbability != null
                        ? `${Math.round(risk.occurrenceProbability * 100)}%`
                        : "—"}
                    </div>
                  </div>
                  <div>
                    <span className="text-xs text-ink-400">Cost impact</span>
                    <div className="font-medium tabular-nums text-ink-800">
                      {distLabel(risk.costImpact)}
                    </div>
                  </div>
                  <div>
                    <span className="text-xs text-ink-400">Schedule task</span>
                    <div className="font-medium text-ink-800">
                      {risk.scheduleTaskId ? (
                        <span className="font-mono text-xs">{risk.scheduleTaskId}</span>
                      ) : (
                        "Not linked"
                      )}
                    </div>
                  </div>
                  <div>
                    <span className="text-xs text-ink-400">Duration impact</span>
                    <div className="font-medium tabular-nums text-ink-800">
                      {distLabel(risk.durationImpact)}
                    </div>
                  </div>
                  <div className="sm:col-span-2">
                    {isQuantified(risk) ? (
                      <Badge tone="green">Quantified — included in QCRA</Badge>
                    ) : (
                      <Badge tone="gray">Not quantified — excluded from QCRA</Badge>
                    )}
                  </div>
                </CardBody>
              </Card>
            </div>

            {/* mitigation value */}
            <div className="mb-4">
              <SectionTitle>Mitigation value (#454)</SectionTitle>
              {mv ? (
                <Card
                  className={
                    mv.worthwhile ? "border-l-4 border-l-emerald-500" : "border-l-4 border-l-red-500"
                  }
                >
                  <CardBody className="py-3">
                    <div className="mb-2 flex items-center gap-2">
                      {mv.worthwhile ? (
                        <Badge tone="green">✓ Worthwhile</Badge>
                      ) : (
                        <Badge tone="red">✗ Not worthwhile</Badge>
                      )}
                      <span className="text-xs text-ink-400">
                        risk reduction vs mitigation cost
                      </span>
                    </div>
                    <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
                      <div>
                        <span className="text-xs text-ink-400">EV before</span>
                        <div className="font-semibold tabular-nums">{fmtNum(mv.expectedValueBefore)}</div>
                      </div>
                      <div>
                        <span className="text-xs text-ink-400">EV after</span>
                        <div className="font-semibold tabular-nums">{fmtNum(mv.expectedValueAfter)}</div>
                      </div>
                      <div>
                        <span className="text-xs text-ink-400">Risk reduction</span>
                        <div className="font-semibold tabular-nums text-emerald-700">
                          {fmtNum(mv.riskReduction)}
                        </div>
                      </div>
                      <div>
                        <span className="text-xs text-ink-400">Mitigation cost</span>
                        <div className="font-semibold tabular-nums">{fmtNum(mv.mitigationCost)}</div>
                      </div>
                    </div>
                  </CardBody>
                </Card>
              ) : (
                <p className="text-xs text-ink-400">{mvHint ?? "Loading…"}</p>
              )}
            </div>

            {/* mitigation checklist */}
            <div className="mb-4">
              <SectionTitle>
                Mitigation actions{" "}
                <span className="normal-case tabular-nums">
                  ({doneCount}/{mitigations.length} done)
                </span>
              </SectionTitle>
              {mitigations.length === 0 ? (
                <p className="mb-2 text-xs text-ink-400">No mitigation actions recorded.</p>
              ) : (
                <ul className="mb-2 divide-y divide-ink-100 rounded-md ring-1 ring-ink-100">
                  {mitigations.map((m, i) => (
                    <li key={i} className="flex items-center gap-2.5 px-3 py-2">
                      <input
                        type="checkbox"
                        checked={Boolean(m.done)}
                        disabled={busy}
                        onChange={() => void onToggle(i)}
                        className="h-4 w-4 rounded border-ink-300 text-brand-600 focus:ring-brand-500"
                        aria-label={`Mark "${m.description}" ${m.done ? "not done" : "done"}`}
                      />
                      <span
                        className={`flex-1 text-sm ${m.done ? "text-ink-400 line-through" : "text-ink-800"}`}
                      >
                        {m.description}
                      </span>
                      {m.cost != null ? (
                        <span className="text-xs tabular-nums text-ink-400">{fmtNum(m.cost)}</span>
                      ) : null}
                      {m.dueDate ? (
                        <span className="text-xs text-ink-400">{formatDate(m.dueDate)}</span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
              <form onSubmit={onAddAction} className="flex gap-2">
                <Input
                  value={newAction}
                  onChange={(e) => setNewAction(e.target.value)}
                  placeholder="Add a mitigation action…"
                />
                <Button type="submit" variant="secondary" disabled={busy || !newAction.trim()}>
                  Add
                </Button>
              </form>
            </div>

            {/* status actions */}
            <div>
              <SectionTitle>Status</SectionTitle>
              <div className="flex flex-wrap gap-2">
                {RISK_STATUSES.filter((s) => s !== risk.status).map((s) => (
                  <Button
                    key={s}
                    size="sm"
                    variant={s === "realised" ? "danger" : "secondary"}
                    disabled={busy}
                    onClick={() => void onStatus(s)}
                  >
                    {STATUS_ACTION_LABEL[s] ?? humanize(s)}
                  </Button>
                ))}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
