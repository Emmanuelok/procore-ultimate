/**
 * Dispute detail drawer: status stepper + procedural timetable (Timeline),
 * pleadings register (Submissions), tamper-evident hearing bundle builder
 * (Bundles) and the settlement offer register with expected-value modelling
 * (Settlement) — spec Vol II Domain E #325-352.
 */
import { useCallback, useEffect, useState } from "react";
import { api } from "../../lib/api";
import { Badge, Spinner, ErrorAlert } from "../../ui";
import { formatDate, humanize } from "../format";
import {
  CountdownBadge,
  disputeStatusTone,
  dspLabel,
  fmtMoney,
  kindLabel,
  TabBar,
  type DisputeDetail,
} from "./disputesShared";
import TimelineTab from "./TimelineTab";
import SubmissionsTab from "./SubmissionsTab";
import BundleBuilder from "./BundleBuilder";
import SettlementTab from "./SettlementTab";

const TABS = [
  { key: "timeline", label: "Timeline" },
  { key: "submissions", label: "Submissions" },
  { key: "bundles", label: "Bundles" },
  { key: "settlement", label: "Settlement" },
];

export default function DisputeDrawer({
  projectId,
  disputeId,
  onClose,
  onChanged,
}: {
  projectId: string;
  disputeId: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const base = `/api/v1/projects/${projectId}`;

  const [dispute, setDispute] = useState<DisputeDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState("timeline");

  const load = useCallback(async () => {
    setError(null);
    try {
      setDispute(await api.get<DisputeDetail>(`${base}/disputes/${disputeId}`));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load the dispute");
    }
  }, [base, disputeId]);

  useEffect(() => {
    void load();
  }, [load]);

  const refresh = useCallback(async () => {
    await load();
    onChanged();
  }, [load, onChanged]);

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-ink-950/40" onClick={onClose}>
      <div
        className="h-full w-full max-w-3xl overflow-y-auto bg-white p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {dispute === null ? (
          <>
            <ErrorAlert message={error} />
            <Spinner />
          </>
        ) : (
          <>
            <div className="mb-4 flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="mb-1 flex flex-wrap items-center gap-2">
                  <span className="font-mono text-xs text-ink-400">{dspLabel(dispute.number)}</span>
                  <Badge tone="blue">{kindLabel(dispute.kind)}</Badge>
                  <Badge tone={disputeStatusTone(dispute.status)}>
                    {humanize(dispute.status)}
                  </Badge>
                  {dispute.nextDeadline ? <CountdownBadge days={dispute.daysToNext} /> : null}
                </div>
                <h2 className="truncate text-base font-semibold text-ink-900">{dispute.title}</h2>
                <p className="mt-0.5 text-sm text-ink-500">
                  {fmtMoney(dispute.amountInDispute, dispute.currency)} in dispute
                  {dispute.forum ? ` · ${dispute.forum}` : ""}
                  {dispute.rules ? ` · ${dispute.rules}` : ""}
                </p>
                {dispute.claims.length > 0 ? (
                  <p className="mt-1 flex flex-wrap gap-1.5 text-xs text-ink-500">
                    {dispute.claims.map((c) => (
                      <span
                        key={c.id}
                        className="inline-flex items-center gap-1 rounded-full bg-ink-100 px-2 py-0.5"
                        title={c.title}
                      >
                        <span className="font-mono">CLM-{String(c.number).padStart(3, "0")}</span>
                        <span className="max-w-40 truncate">{c.title}</span>
                      </span>
                    ))}
                  </p>
                ) : null}
              </div>
              <button
                type="button"
                onClick={onClose}
                className="rounded p-1 text-ink-400 hover:bg-ink-100 hover:text-ink-700"
                aria-label="Close"
              >
                ✕
              </button>
            </div>

            {/* terminal outcome banner */}
            {dispute.status === "decided" && dispute.outcome ? (
              <div className="mb-4 rounded-md bg-violet-50 px-3 py-2 text-sm text-violet-900 ring-1 ring-violet-200">
                <strong>Decided {formatDate(dispute.decidedAt)}.</strong> {dispute.outcome}
              </div>
            ) : null}
            {dispute.status === "settled" ? (
              <div className="mb-4 rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-900 ring-1 ring-emerald-200">
                <strong>Settled.</strong> {dispute.outcome ?? "The dispute was settled by agreement."}
              </div>
            ) : null}
            {dispute.status === "withdrawn" ? (
              <div className="mb-4 rounded-md bg-ink-100 px-3 py-2 text-sm text-ink-700 ring-1 ring-ink-200">
                <strong>Withdrawn.</strong> {dispute.outcome ?? "The referral was withdrawn."}
              </div>
            ) : null}

            <ErrorAlert message={error} />

            <TabBar tabs={TABS} active={tab} onSelect={setTab} />

            {tab === "timeline" ? (
              <TimelineTab projectId={projectId} dispute={dispute} onChanged={refresh} />
            ) : null}
            {tab === "submissions" ? (
              <SubmissionsTab projectId={projectId} dispute={dispute} onChanged={refresh} />
            ) : null}
            {tab === "bundles" ? (
              <BundleBuilder projectId={projectId} dispute={dispute} onChanged={refresh} />
            ) : null}
            {tab === "settlement" ? (
              <SettlementTab projectId={projectId} dispute={dispute} onChanged={refresh} />
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
