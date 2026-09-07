/**
 * Grievance triage panel (#571-572, #574).
 *
 * Sits inside the grievance drawer and answers the one question the intake
 * officer actually has: "how has this project classified complaints like this
 * one before, and what does that mean for the clock?"
 *
 * Three layers, in decreasing order of trustworthiness — which is also the
 * order they render in:
 *
 *  1. PRECEDENT. The closest grievances this project has already handled,
 *     with how they were classified, how long they took and whether the
 *     complainant accepted the outcome. Computed server-side with no model,
 *     so it is present whether or not AI is configured.
 *  2. THE RULE. The published service standard for the severity in play,
 *     quoted, because severity IS the SLA — re-grading a grievance from low
 *     to high moves the resolution deadline from 45 days to 14.
 *  3. THE ASSISTANT. A cited proposal, shown as a proposal: never applied,
 *     always next to the precedent it rests on, with the dropped-citation
 *     count visible so a confident-sounding answer with no surviving citation
 *     looks as thin as it is.
 *
 * The officer's decision is the only write. It is recorded against the
 * proposal so the agreement rate is measured rather than assumed, and the
 * deadlines are recomputed from the date the community raised the grievance,
 * never from today.
 */
import { useCallback, useEffect, useState } from "react";
import { GRIEVANCE_SEVERITIES } from "@constructos/shared";
import { api, ApiClientError } from "../../lib/api";
import { Badge, Button, ErrorAlert, Field, Select, Spinner, Textarea } from "../../ui";
import { humanize } from "../format";
import { severityTone } from "./landShared";

const CATEGORIES = [
  "land",
  "noise",
  "dust",
  "access",
  "employment",
  "conduct",
  "compensation",
  "other",
] as const;

interface Precedent {
  id: string;
  number: number;
  score: number;
  category: string;
  severity: string;
  status: string;
  resolutionDays: number | null;
  complainantSatisfied: boolean | null;
  sharedTerms: string[];
  excerpt: string;
}

interface SlaRule {
  severity: string;
  acknowledgeDays: number;
  resolveDays: number;
  rule: string;
}

interface Proposal {
  id: string;
  runId: string | null;
  method: string;
  proposedCategory: string;
  proposedSeverity: string;
  confidence: number;
  rationale: string;
  decidedCategory: string | null;
  decidedSeverity: string | null;
  decidedAt: string | null;
  createdAt: string;
}

interface TriagePanelData {
  grievanceId: string;
  number: number;
  current: { category: string; severity: string; assigneeId: string | null };
  precedents: Precedent[];
  corpusSize: number;
  corpusTruncated: boolean;
  suggestion: {
    category: string | null;
    severity: string | null;
    confidence: number;
    basis: string;
  };
  slaRules: SlaRule[];
  proposals: Proposal[];
  aiAvailable: boolean;
}

interface AgentProposal {
  proposedCategory: string;
  proposedSeverity: string;
  confidence: number;
  rationale: string;
  citations: unknown[];
  droppedCitations: number;
  evidenceScore: number | null;
}

const pct = (n: number): string => `${Math.round(n * 100)}%`;

export default function TriagePanel({
  projectId,
  grievanceId,
  settled,
  users,
  onDecided,
}: {
  projectId: string;
  grievanceId: string;
  settled: boolean;
  users: { id: string; name: string }[];
  onDecided: () => void;
}) {
  const base = `/api/v1/projects/${projectId}`;
  const [data, setData] = useState<TriagePanelData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [agent, setAgent] = useState<AgentProposal | null>(null);
  const [agentError, setAgentError] = useState<string | null>(null);

  const [category, setCategory] = useState<string>("");
  const [severity, setSeverity] = useState<string>("");
  const [assigneeId, setAssigneeId] = useState<string>("");
  const [note, setNote] = useState("");
  const [decideError, setDecideError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api.get<TriagePanelData>(
        `${base}/grievances/${grievanceId}/triage`,
      );
      setData(res);
      setCategory(res.current.category);
      setSeverity(res.current.severity);
      setAssigneeId(res.current.assigneeId ?? "");
    } catch (err) {
      setData(null);
      setError(err instanceof Error ? err.message : "Failed to load the triage panel");
    }
  }, [base, grievanceId]);

  useEffect(() => {
    setAgent(null);
    setAgentError(null);
    void load();
  }, [load]);

  async function runAgent() {
    setBusy(true);
    setAgentError(null);
    try {
      const res = await api.post<AgentProposal>(
        `${base}/grievances/${grievanceId}/triage`,
        {},
      );
      setAgent(res);
      setCategory(res.proposedCategory);
      setSeverity(res.proposedSeverity);
      await load();
    } catch (err) {
      setAgentError(
        err instanceof ApiClientError
          ? err.status === 503
            ? "The assistant is not configured on this deployment. The precedent panel below is computed without it."
            : err.message
          : "The triage assistant failed.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function decide() {
    setBusy(true);
    setDecideError(null);
    try {
      await api.post(`${base}/grievances/${grievanceId}/triage/decide`, {
        category,
        severity,
        assigneeId: assigneeId || null,
        note: note.trim() || null,
      });
      setNote("");
      await load();
      onDecided();
    } catch (err) {
      setDecideError(
        err instanceof ApiClientError ? err.message : "Failed to record the triage decision.",
      );
    } finally {
      setBusy(false);
    }
  }

  if (error) return <ErrorAlert message={error} />;
  if (!data) return <Spinner label="Loading precedent…" />;

  const rule = data.slaRules.find((r) => r.severity === severity) ?? null;
  const currentRule = data.slaRules.find((r) => r.severity === data.current.severity) ?? null;
  const changed =
    category !== data.current.category ||
    severity !== data.current.severity ||
    (assigneeId || null) !== data.current.assigneeId;

  return (
    <div className="space-y-3 rounded-lg border border-ink-100 bg-ink-50/40 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-ink-500">
          Triage — precedent, rule, proposal
        </h4>
        {data.aiAvailable && !settled ? (
          <Button variant="secondary" size="sm" disabled={busy} onClick={() => void runAgent()}>
            {busy ? "Reading precedent…" : "Ask the assistant"}
          </Button>
        ) : (
          <span className="text-xs text-ink-400">
            {settled ? "Settled — no longer awaiting triage" : "Assistant not configured"}
          </span>
        )}
      </div>

      <ErrorAlert message={agentError} />

      {/* ------------------------------ 1. precedent ----------------------------- */}
      <div>
        <p className="mb-1.5 text-xs text-ink-500">
          {data.precedents.length === 0
            ? data.corpusSize === 0
              ? "This is the first grievance on the project, so there is no precedent to compare it against."
              : `None of the ${data.corpusSize} grievances already recorded shares wording with this one.`
            : data.suggestion.basis}
          {data.corpusTruncated ? " Ranked over the most recent 500 grievances." : null}
        </p>
        {data.precedents.length > 0 ? (
          <ul className="space-y-1.5">
            {data.precedents.map((p) => (
              <li key={p.id} className="rounded-md bg-white px-3 py-2 ring-1 ring-ink-100">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="font-semibold text-ink-800">GRV-{p.number}</span>
                  <Badge tone={severityTone(p.severity)}>{humanize(p.severity)}</Badge>
                  <Badge tone="gray">{humanize(p.category)}</Badge>
                  <span className="text-ink-400">{pct(p.score)} similar</span>
                  {p.resolutionDays !== null ? (
                    <span className="text-ink-500">resolved in {p.resolutionDays}d</span>
                  ) : (
                    <span className="text-ink-400">not yet resolved</span>
                  )}
                  {p.complainantSatisfied === false ? (
                    <span className="text-amber-700">complainant not satisfied</span>
                  ) : null}
                </div>
                <p className="mt-1 line-clamp-2 text-xs text-ink-600">{p.excerpt}</p>
                {p.sharedTerms.length > 0 ? (
                  <p className="mt-1 text-[11px] text-ink-400">
                    matched on {p.sharedTerms.join(", ")}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      {/* ------------------------------ 3. assistant ----------------------------- */}
      {agent ? (
        <div className="rounded-md bg-brand-50/70 px-3 py-2 ring-1 ring-brand-100">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="font-semibold text-ink-800">Assistant proposes</span>
            <Badge tone={severityTone(agent.proposedSeverity)}>
              {humanize(agent.proposedSeverity)}
            </Badge>
            <Badge tone="gray">{humanize(agent.proposedCategory)}</Badge>
            <span className="text-ink-500">confidence {pct(agent.confidence)}</span>
            <span className="text-ink-400">
              {agent.citations.length} citation{agent.citations.length === 1 ? "" : "s"} kept
              {agent.droppedCitations > 0 ? `, ${agent.droppedCitations} dropped` : ""}
            </span>
          </div>
          <p className="mt-1 text-xs text-ink-700">{agent.rationale}</p>
          {agent.citations.length === 0 ? (
            <p className="mt-1 text-xs text-amber-700">
              Nothing the assistant cited survived validation against the records it was given.
              Treat this as an unsupported opinion.
            </p>
          ) : null}
          <p className="mt-1 text-[11px] text-ink-400">
            A proposal changes nothing. The classification below is yours.
          </p>
        </div>
      ) : null}

      {/* ------------------------------ 2 + decision ----------------------------- */}
      {!settled ? (
        <div className="space-y-2 border-t border-ink-100 pt-3">
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Category">
              <Select
                className="w-40"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
              >
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {humanize(c)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Severity">
              <Select
                className="w-36"
                value={severity}
                onChange={(e) => setSeverity(e.target.value)}
              >
                {GRIEVANCE_SEVERITIES.map((s) => (
                  <option key={s} value={s}>
                    {humanize(s)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Handler">
              <Select
                className="w-48"
                value={assigneeId}
                onChange={(e) => setAssigneeId(e.target.value)}
              >
                <option value="">Unassigned</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          {rule ? (
            <p className="text-xs text-ink-600">
              <span className="font-medium text-ink-800">The rule you are invoking:</span>{" "}
              {rule.rule}
            </p>
          ) : null}
          {rule && currentRule && rule.resolveDays !== currentRule.resolveDays ? (
            <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">
              This changes the promise made to the complainant from {currentRule.resolveDays} days
              to {rule.resolveDays}. Both deadlines are measured from the date the grievance was
              received, not from today — re-grading does not buy the project a fresh clock.
            </p>
          ) : null}

          <Field label="Why (recorded on the ledger with the before and after)">
            <Textarea
              className="min-h-12"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Crops affected, not just nuisance — matches GRV-14 which was graded high."
            />
          </Field>

          <ErrorAlert message={decideError} />
          <Button
            size="sm"
            disabled={busy || !changed}
            title={changed ? undefined : "Nothing has changed from the current classification"}
            onClick={() => void decide()}
          >
            {busy ? "Recording…" : "Record classification"}
          </Button>
        </div>
      ) : null}

      {/* ------------------------------ history ---------------------------------- */}
      {data.proposals.length > 0 ? (
        <details className="text-xs text-ink-500">
          <summary className="cursor-pointer select-none">
            {data.proposals.length} previous proposal{data.proposals.length === 1 ? "" : "s"}
          </summary>
          <ul className="mt-1.5 space-y-1">
            {data.proposals.map((p) => (
              <li key={p.id} className="rounded bg-white px-2 py-1 ring-1 ring-ink-100">
                <span className="font-medium text-ink-700">
                  {humanize(p.method)} proposed {humanize(p.proposedCategory)}/
                  {humanize(p.proposedSeverity)}
                </span>{" "}
                <span className="text-ink-400">({pct(p.confidence)})</span>
                {p.decidedAt ? (
                  <span className="text-ink-600">
                    {" "}
                    → officer decided {humanize(p.decidedCategory ?? "—")}/
                    {humanize(p.decidedSeverity ?? "—")}
                    {p.decidedCategory === p.proposedCategory &&
                    p.decidedSeverity === p.proposedSeverity
                      ? " (agreed)"
                      : " (overridden)"}
                  </span>
                ) : (
                  <span className="text-ink-400"> — awaiting a decision</span>
                )}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
