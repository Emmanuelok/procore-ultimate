/**
 * Risk and signals — the two registers that say what is about to go wrong.
 *
 *   Signals   what the assurance detectors raised, with the detector's own
 *             explanation printed verbatim. These are the input to the health
 *             verdict in the workspace header, so the two can never disagree.
 *   Risks     the project risk register, worst pre-mitigation score first.
 *
 * Neither list is summarised into a single number. A "risk score" for a whole
 * project is a number nobody can act on; the individual entries are.
 */
import { useState } from "react";
import { Link } from "react-router-dom";
import { Badge, SegmentedControl } from "../../../ui";
import { IconRisk } from "../../../ui/icons";
import { cx } from "../../../ui/cx";
import { toneClass, type Tone } from "../../../ui/tokens";
import { useProjectWorkspace } from "../../../layouts/project/context";
import {
  isoDate,
  titleCase,
  type Loadable,
  type Paginated,
} from "../../../layouts/project/lib";
import Panel, { RowSkeleton } from "./Panel";
import type { RiskRow } from "./types";

type Mode = "signals" | "risks";

const SEVERITY_TONE: Record<string, Tone> = {
  critical: "danger",
  high: "danger",
  medium: "warning",
  low: "neutral",
  info: "info",
};

const OPEN_RISK_STATUSES = ["open", "mitigating"];

function riskTone(score: number): Tone {
  if (score >= 15) return "danger";
  if (score >= 8) return "warning";
  return "neutral";
}

export interface SignalsPanelProps {
  risks: Loadable<Paginated<RiskRow>>;
  className?: string;
}

export default function SignalsPanel({ risks, className }: SignalsPanelProps) {
  const { signals, openSignals, health } = useProjectWorkspace();
  const [mode, setMode] = useState<Mode>("signals");

  const openRisks = (risks.data?.items ?? [])
    .filter((risk) => OPEN_RISK_STATUSES.includes(risk.status))
    .sort((a, b) => b.preScore - a.preScore);

  const isSignals = mode === "signals";
  const loading = isSignals
    ? signals.loading && !signals.data
    : risks.loading && !risks.data;
  const error = isSignals ? signals.error : risks.error;
  const isEmpty = isSignals ? openSignals.length === 0 : openRisks.length === 0;

  return (
    <Panel
      className={className}
      title="Risk and signals"
      subtitle={
        health.level === "unrated" ? undefined : `${health.basis.split(".")[0] ?? ""}.`
      }
      icon={IconRisk}
      tone={health.tone}
      actions={
        <div className="flex items-center gap-2">
          <SegmentedControl
            size="xs"
            aria-label="Choose register"
            value={mode}
            onChange={setMode}
            options={[
              // No count while a register is unread: a "0" chip over a failed
              // request is a claim that there is nothing there.
              {
                value: "signals",
                label: "Signals",
                ...(signals.data ? { count: openSignals.length } : {}),
              },
              {
                value: "risks",
                label: "Risks",
                ...(risks.data ? { count: openRisks.length } : {}),
              },
            ]}
          />
          <Link
            to={isSignals ? "assurance" : "risk"}
            className="rounded px-1 text-meta text-accent-text underline-offset-2 hover:underline"
          >
            Open
          </Link>
        </div>
      }
      loading={loading}
      error={error}
      onRetry={isSignals ? signals.reload : risks.reload}
      isEmpty={isEmpty}
      emptyTitle={isSignals ? "No open signals" : "No open risks"}
      emptyHint={
        isSignals
          ? "The assurance detectors have raised nothing on this project that is still open. Signals that were reviewed and closed or dismissed are excluded."
          : "The risk register holds no entry with status open or mitigating. Closed and realised risks are excluded."
      }
      skeleton={<RowSkeleton rows={4} />}
      bodyClassName="p-0"
      footer={
        isSignals
          ? "Explanations are printed exactly as the detector wrote them. Dispositioning a signal is restricted to integrity reviewers."
          : "Score is probability × impact before mitigation, on the 1–5 scales recorded on each risk."
      }
    >
      {isSignals ? (
        <ul className="divide-y divide-border-subtle">
          {openSignals.slice(0, 6).map((signal) => (
            <li key={signal.id} className="px-card py-2.5">
              <div className="flex items-start gap-2.5">
                <Badge
                  tone={SEVERITY_TONE[signal.severity] ?? "neutral"}
                  size="xs"
                  variant="subtle"
                  className="mt-px shrink-0"
                >
                  {titleCase(signal.severity)}
                </Badge>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-meta font-medium text-content">{signal.title}</p>
                  <p className="mt-0.5 line-clamp-2 text-2xs leading-snug text-content-muted">
                    {signal.explanation}
                  </p>
                  <p className="mt-1 text-2xs text-content-subtle">
                    <span className="font-mono">{signal.detector}</span>
                    {" · "}
                    {titleCase(signal.disposition)}
                    {" · "}
                    {isoDate(signal.createdAt)}
                  </p>
                </div>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <ul className="divide-y divide-border-subtle">
          {openRisks.slice(0, 6).map((risk) => (
            <li key={risk.id} className="flex items-center gap-3 px-card py-2">
              <span
                className={cx(
                  "grid size-7 shrink-0 place-items-center rounded-md border text-2xs font-semibold tabular-nums",
                  toneClass(riskTone(risk.preScore), "subtle"),
                  toneClass(riskTone(risk.preScore), "border"),
                )}
                title={`Probability ${risk.probabilityScore} × impact ${risk.impactScore}`}
              >
                {risk.preScore}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-meta text-content" title={risk.title}>
                  R-{String(risk.number).padStart(3, "0")} · {risk.title}
                </p>
                <p className="text-2xs text-content-subtle">
                  {titleCase(risk.category)} · {titleCase(risk.status)}
                  {risk.postScore !== null ? ` · ${risk.postScore} after mitigation` : ""}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
