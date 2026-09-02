/**
 * The human-in-the-loop gate, made real.
 *
 * The previous queue rendered a two-line summary next to an Approve button:
 * approving an `rfi_response` wrote the model's text into the RFI's official
 * response and answered it, and nobody had seen the text. This drawer is the
 * fix. It shows, for every proposal:
 *
 *   · the proposal itself, rendered for its target type (response text,
 *     sections table, sheet before/after, findings list…);
 *   · the CURRENT state of the record it would change, so the reviewer reads
 *     a diff rather than a claim;
 *   · the citations, validated server-side, and the provenance of the run —
 *     evidence score, dropped citations, prompt version;
 *   · a staleness warning when the proposal has been sitting long enough that
 *     the record has probably moved.
 *
 * Approve stays disabled until the proposal has actually been rendered, and
 * Reject asks for a reason (the API has always ledgered one; the UI never
 * sent it).
 */
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "../../lib/api";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  Drawer,
  ErrorAlert,
  Field,
  Spinner,
  Table,
  Td,
  Textarea,
  Th,
} from "../../ui";
import { IconAi, IconUndo } from "../../ui/icons";
import {
  confidenceBand,
  errorMessage,
  formatDateTime,
  humanize,
  num,
  pct,
  REVIEW_STATUS_TONE,
  type Citation,
  type ReviewDetail,
} from "./agentsShared";

/* ------------------------------------------------------------------ */
/* Proposal renderers by target type                                   */
/* ------------------------------------------------------------------ */

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function Prose({ label, value }: { label: string; value: unknown }) {
  const text = str(value);
  if (!text) return null;
  return (
    <div>
      <div className="text-xs font-semibold uppercase tracking-wide text-ink-500">{label}</div>
      <p className="mt-1 whitespace-pre-wrap rounded-md bg-ink-50 p-3 text-sm text-ink-800">{text}</p>
    </div>
  );
}

function StringList({ label, value }: { label: string; value: unknown }) {
  if (!Array.isArray(value) || value.length === 0) return null;
  return (
    <div>
      <div className="text-xs font-semibold uppercase tracking-wide text-ink-500">{label}</div>
      <ul className="mt-1 list-inside list-disc space-y-0.5 text-sm text-ink-700">
        {value.map((v, i) => (
          <li key={i}>{typeof v === "string" ? v : JSON.stringify(v)}</li>
        ))}
      </ul>
    </div>
  );
}

function ObjectRows({ label, value }: { label: string; value: unknown }) {
  if (!Array.isArray(value) || value.length === 0) return null;
  const rows = value.filter((v): v is Record<string, unknown> => Boolean(v) && typeof v === "object");
  if (rows.length === 0) return null;
  const keys = [...new Set(rows.flatMap((r) => Object.keys(r)))].filter((k) => k !== "citations");
  return (
    <div>
      <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-500">{label}</div>
      <div className="overflow-x-auto">
        <Table>
          <thead>
            <tr>
              {keys.map((k) => (
                <Th key={k}>{humanize(k)}</Th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                {keys.map((k) => (
                  <Td key={k} className="align-top text-xs">
                    {typeof r[k] === "string" || typeof r[k] === "number"
                      ? String(r[k])
                      : r[k] === undefined
                        ? "—"
                        : JSON.stringify(r[k])}
                  </Td>
                ))}
              </tr>
            ))}
          </tbody>
        </Table>
      </div>
    </div>
  );
}

/** Everything the specific renderers did not already show, without noise. */
function Remainder({ proposal, shown }: { proposal: Record<string, unknown>; shown: string[] }) {
  const skip = new Set([...shown, "citations", "confidence", "runId", "agentKind", "projectId"]);
  const rest = Object.entries(proposal).filter(
    ([k, v]) => !skip.has(k) && v !== null && v !== undefined && !(Array.isArray(v) && v.length === 0),
  );
  if (rest.length === 0) return null;
  return (
    <details className="rounded-md border border-ink-100 p-2">
      <summary className="cursor-pointer text-xs font-semibold text-ink-600">
        Everything else the agent returned ({rest.length})
      </summary>
      <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all text-xs text-ink-600">
        {JSON.stringify(Object.fromEntries(rest), null, 2)}
      </pre>
    </details>
  );
}

function ProposalBody({
  targetType,
  proposal,
}: {
  targetType: string;
  proposal: Record<string, unknown>;
}) {
  switch (targetType) {
    case "rfi_response":
      return (
        <div className="space-y-3">
          <Prose label="Suggested official response" value={proposal["suggestedResponse"]} />
          <div className="flex flex-wrap gap-2 text-xs">
            <Badge tone="neutral">Cost impact: {humanize(str(proposal["costImpact"]) ?? "tbd")}</Badge>
            <Badge tone="neutral">
              Schedule impact: {humanize(str(proposal["scheduleImpact"]) ?? "tbd")}
            </Badge>
            {typeof proposal["scheduleImpactDays"] === "number" ? (
              <Badge tone="warning">{proposal["scheduleImpactDays"]} day(s)</Badge>
            ) : null}
          </div>
          <Prose label="Reasoning" value={proposal["reasoning"]} />
          <Remainder
            proposal={proposal}
            shown={["suggestedResponse", "costImpact", "scheduleImpact", "scheduleImpactDays", "reasoning"]}
          />
        </div>
      );
    case "drawing_sheet":
      return (
        <div className="space-y-3">
          <Table>
            <thead>
              <tr>
                <Th>Field</Th>
                <Th>Proposed</Th>
              </tr>
            </thead>
            <tbody>
              {["number", "title", "discipline"].map((k) => (
                <tr key={k}>
                  <Td className="text-xs font-medium">{humanize(k)}</Td>
                  <Td className="text-xs">{str(proposal[k]) ?? "—"}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
          <Remainder proposal={proposal} shown={["number", "title", "discipline"]} />
        </div>
      );
    case "daily_log": {
      const sections = proposal["sections"];
      const entries =
        sections && typeof sections === "object" && !Array.isArray(sections)
          ? Object.entries(sections as Record<string, unknown>)
          : [];
      return (
        <div className="space-y-3">
          <Prose label="Summary" value={proposal["summary"]} />
          <Prose label="Notes" value={proposal["notes"]} />
          {entries.length === 0 ? (
            <p className="text-xs text-ink-500">The draft contains no sections.</p>
          ) : (
            entries.map(([key, rows]) => (
              <ObjectRows key={key} label={humanize(key)} value={rows} />
            ))
          )}
          <Remainder proposal={proposal} shown={["summary", "notes", "sections"]} />
        </div>
      );
    }
    case "submittal_review":
      return (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="info">Recommendation: {humanize(str(proposal["recommendation"]))}</Badge>
            {proposal["contentReviewed"] === false ? (
              <Badge tone="danger">No content was available to review</Badge>
            ) : (
              <Badge tone="neutral">
                {num(
                  typeof proposal["documentsAttached"] === "number"
                    ? proposal["documentsAttached"]
                    : null,
                )}{" "}
                document(s) read
              </Badge>
            )}
          </div>
          <ObjectRows label="Findings" value={proposal["findings"]} />
          <StringList label="Deviations" value={proposal["deviations"]} />
          <StringList label="Missing items" value={proposal["missingItems"]} />
          <Prose label="Reasoning" value={proposal["reasoning"]} />
          <Remainder
            proposal={proposal}
            shown={[
              "recommendation",
              "findings",
              "deviations",
              "missingItems",
              "reasoning",
              "contentReviewed",
              "documentsAttached",
            ]}
          />
        </div>
      );
    case "signal_explanation":
      return (
        <div className="space-y-3">
          <Prose label="Benign reading" value={proposal["benignExplanation"]} />
          <Prose label="Concerning reading" value={proposal["concerningExplanation"]} />
          <StringList label="Evidence that would settle it" value={proposal["recommendedEvidence"]} />
          <Remainder
            proposal={proposal}
            shown={["benignExplanation", "concerningExplanation", "recommendedEvidence", "signalId"]}
          />
        </div>
      );
    case "integrity_memo":
      return (
        <div className="space-y-3">
          <Prose label="Hypothesis" value={proposal["hypothesis"]} />
          <Badge tone="warning">
            Suggested disposition: {humanize(str(proposal["suggestedDisposition"]))}
          </Badge>
          <ObjectRows label="Corroborating" value={proposal["corroborating"]} />
          <ObjectRows label="Contradicting" value={proposal["contradicting"]} />
          <StringList label="Follow-up evidence" value={proposal["followUpEvidence"]} />
          <Prose label="Independence assessment" value={proposal["independenceAssessment"]} />
          <Remainder
            proposal={proposal}
            shown={[
              "hypothesis",
              "suggestedDisposition",
              "corroborating",
              "contradicting",
              "followUpEvidence",
              "independenceAssessment",
              "signalIds",
            ]}
          />
        </div>
      );
    default:
      return (
        <div className="space-y-3">
          <Prose label="Title" value={proposal["title"]} />
          <Prose label="Rationale" value={proposal["rationale"]} />
          <Prose label="Narrative" value={proposal["narrative"]} />
          <Prose label="Notice text" value={proposal["noticeText"]} />
          <Prose label="Minutes" value={proposal["minutes"]} />
          <Prose label="Answer" value={proposal["answer"]} />
          <ObjectRows label="Findings" value={proposal["findings"]} />
          <ObjectRows label="Drivers" value={proposal["drivers"]} />
          <ObjectRows label="Rebuttals" value={proposal["rebuttals"]} />
          <ObjectRows label="Deviations" value={proposal["deviations"]} />
          <ObjectRows label="Scope gaps" value={proposal["scopeGaps"]} />
          <ObjectRows label="Outliers" value={proposal["outliers"]} />
          <ObjectRows label="Assessments" value={proposal["assessments"]} />
          <ObjectRows label="Conflicts" value={proposal["conflicts"]} />
          <StringList label="Missing facts" value={proposal["missingFacts"]} />
          <StringList label="Gaps" value={proposal["gaps"]} />
          <StringList label="Figures the platform does not hold" value={proposal["unavailable"]} />
          <StringList label="Watch items" value={proposal["watchItems"]} />
          <Remainder
            proposal={proposal}
            shown={[
              "title",
              "rationale",
              "narrative",
              "noticeText",
              "minutes",
              "answer",
              "findings",
              "drivers",
              "rebuttals",
              "deviations",
              "scopeGaps",
              "outliers",
              "assessments",
              "conflicts",
              "missingFacts",
              "gaps",
              "unavailable",
              "watchItems",
            ]}
          />
        </div>
      );
  }
}

function CitationChips({ citations }: { citations: Citation[] }) {
  if (citations.length === 0) {
    return (
      <p className="text-xs text-ink-500">
        No citation survived validation — treat every statement above as ungrounded.
      </p>
    );
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {citations.map((c, i) => (
        <span
          key={`${c.type}:${c.id}:${i}`}
          title={c.excerpt ?? `${c.type} ${c.id}`}
          className="inline-flex items-center gap-1 rounded-full bg-ink-100 px-2 py-0.5 font-mono text-[11px] text-ink-700"
        >
          {c.type} · {c.id.slice(-8)}
        </span>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Drawer                                                              */
/* ------------------------------------------------------------------ */

export default function ReviewDrawer({
  reviewId,
  onClose,
  onChanged,
}: {
  reviewId: string | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [detail, setDetail] = useState<ReviewDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"approve" | "reject" | "revert" | null>(null);
  const [reason, setReason] = useState("");
  const [rejecting, setRejecting] = useState(false);

  const load = useCallback(async () => {
    if (!reviewId) return;
    setLoading(true);
    setError(null);
    try {
      setDetail(await api.get<ReviewDetail>(`/api/v1/ai/review/${reviewId}`));
    } catch (err) {
      setDetail(null);
      setError(errorMessage(err, "Failed to load the proposal"));
    } finally {
      setLoading(false);
    }
  }, [reviewId]);

  useEffect(() => {
    setDetail(null);
    setReason("");
    setRejecting(false);
    void load();
  }, [load]);

  async function decide(action: "approve" | "reject" | "revert") {
    if (!reviewId) return;
    setBusy(action);
    setError(null);
    try {
      await api.post(`/api/v1/ai/review/${reviewId}/${action}`, action === "approve" ? {} : { reason });
      toast.success(
        action === "approve"
          ? "Proposal applied and ledgered"
          : action === "reject"
            ? "Proposal rejected with your reason"
            : "Change rolled back and the record restored",
      );
      onChanged();
      await load();
      setRejecting(false);
      setReason("");
    } catch (err) {
      setError(errorMessage(err, `Failed to ${action} the proposal`));
    } finally {
      setBusy(null);
    }
  }

  const item = detail?.item;
  const band = confidenceBand(item?.confidence);
  const provenance = detail?.provenance ?? null;

  return (
    <Drawer
      open={reviewId !== null}
      onClose={onClose}
      size="xl"
      icon={IconAi}
      title={item ? humanize(item.targetType) : "Proposal"}
      description={item?.summary}
    >
      {loading && !detail ? <Spinner /> : null}
      <ErrorAlert message={error} />

      {detail && item ? (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={REVIEW_STATUS_TONE[item.status] ?? "neutral"}>{humanize(item.status)}</Badge>
            <Badge tone={band.tone}>
              Confidence {pct(item.confidence)} ({band.label})
            </Badge>
            {provenance ? (
              <Badge tone={provenance.evidenceScore !== null && provenance.evidenceScore >= 0.5 ? "neutral" : "warning"}>
                Evidence {pct(provenance.evidenceScore)}
              </Badge>
            ) : null}
            {provenance && provenance.droppedCitations > 0 ? (
              <Badge tone="danger">{provenance.droppedCitations} citation(s) invented and dropped</Badge>
            ) : null}
            <span className="text-xs text-ink-500">created {formatDateTime(item.createdAt)}</span>
          </div>

          {detail.stale ? (
            <Alert tone="warning" title="This proposal is stale">
              It has been pending for more than {detail.staleAfterDays} days. The record it was
              computed from has probably changed since — read the current state below before
              approving.
            </Alert>
          ) : null}

          <Card>
            <CardBody className="space-y-3">
              <div className="text-sm font-semibold text-ink-900">What the agent proposes</div>
              <ProposalBody targetType={item.targetType} proposal={item.proposal} />
            </CardBody>
          </Card>

          <Card>
            <CardBody className="space-y-2">
              <div className="text-sm font-semibold text-ink-900">
                The record as it stands now
              </div>
              {detail.current === null ? (
                <p className="text-xs text-ink-500">
                  {item.targetType === "daily_log"
                    ? "You have no draft log for that date, so approving creates one."
                    : "No operational record is attached to this proposal — approving records it as accepted advice and changes nothing."}
                </p>
              ) : (
                <Table>
                  <thead>
                    <tr>
                      <Th>Field</Th>
                      <Th>Current value</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(detail.current).map(([k, v]) => (
                      <tr key={k}>
                        <Td className="whitespace-nowrap text-xs font-medium">{humanize(k)}</Td>
                        <Td className="text-xs">
                          {v === null || v === undefined
                            ? "—"
                            : typeof v === "string" || typeof v === "number"
                              ? String(v)
                              : JSON.stringify(v)}
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardBody className="space-y-2">
              <div className="text-sm font-semibold text-ink-900">Grounding</div>
              <CitationChips citations={detail.run?.citations ?? []} />
              <div className="grid grid-cols-2 gap-2 text-xs text-ink-600 sm:grid-cols-4">
                <div>
                  <div className="text-ink-400">Records supplied</div>
                  <div className="tabular-nums">{num(provenance?.inputRefCount ?? detail.run?.inputRefCount)}</div>
                </div>
                <div>
                  <div className="text-ink-400">Citations kept</div>
                  <div className="tabular-nums">{num(provenance?.citationCount ?? detail.run?.citationCount)}</div>
                </div>
                <div>
                  <div className="text-ink-400">Prompt version</div>
                  <div className="font-mono">{provenance?.promptVersion ?? "—"}</div>
                </div>
                <div>
                  <div className="text-ink-400">Asked by</div>
                  <div>{humanize(provenance?.source ?? null)}</div>
                </div>
              </div>
              {provenance ? (
                <details className="rounded-md border border-ink-100 p-2">
                  <summary className="cursor-pointer text-xs font-semibold text-ink-600">
                    How the evidence score was computed
                  </summary>
                  <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap text-xs text-ink-600">
                    {JSON.stringify(provenance.evidenceBasis, null, 2)}
                  </pre>
                </details>
              ) : null}
            </CardBody>
          </Card>

          {detail.action ? (
            <Card>
              <CardBody className="space-y-1 text-xs text-ink-600">
                <div className="text-sm font-semibold text-ink-900">Applied change</div>
                <div>
                  {humanize(detail.action.actionType)} · {humanize(detail.action.status)} ·{" "}
                  {formatDateTime(detail.action.appliedAt)}
                </div>
                {detail.action.reversible === 0 ? (
                  <div className="text-ink-500">{detail.action.irreversibleReason}</div>
                ) : null}
                {detail.action.rollbackReason ? (
                  <div>Rolled back: {detail.action.rollbackReason}</div>
                ) : null}
              </CardBody>
            </Card>
          ) : null}

          {item.status === "pending" ? (
            <div className="space-y-2">
              {rejecting ? (
                <Field
                  label="Why are you rejecting this?"
                  hint="The reason is written to the ledger with the rejection."
                >
                  <Textarea
                    rows={3}
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder="e.g. the response cites a detail that was superseded"
                  />
                </Field>
              ) : null}
              <div className="flex flex-wrap gap-2">
                <Button loading={busy === "approve"} onClick={() => void decide("approve")}>
                  Approve and apply
                </Button>
                {rejecting ? (
                  <>
                    <Button
                      variant="danger"
                      loading={busy === "reject"}
                      onClick={() => void decide("reject")}
                    >
                      Confirm rejection
                    </Button>
                    <Button variant="ghost" onClick={() => setRejecting(false)}>
                      Cancel
                    </Button>
                  </>
                ) : (
                  <Button variant="secondary" onClick={() => setRejecting(true)}>
                    Reject…
                  </Button>
                )}
              </div>
            </div>
          ) : item.status === "approved" && detail.action && detail.action.reversible === 1 && detail.action.status === "applied" ? (
            <div className="space-y-2">
              <Field label="Reason for rolling back" hint="Recorded on the ledger with the reversal.">
                <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
              </Field>
              <Button
                variant="danger"
                leadingIcon={IconUndo}
                loading={busy === "revert"}
                onClick={() => void decide("revert")}
              >
                Roll this change back
              </Button>
            </div>
          ) : (
            <p className="text-xs text-ink-500">
              This proposal is {humanize(item.status).toLowerCase()} and can no longer be acted on.
            </p>
          )}
        </div>
      ) : null}
    </Drawer>
  );
}
