/**
 * WHO SAYS THIS CERTIFICATE IS REAL (#772, #781).
 *
 * The verification block above this one records that a colleague looked at a
 * PDF. This panel adds the two checks that do not depend on anybody in the
 * tenant:
 *
 *   · EXTRACTION reads the uploaded document and diffs it against what was
 *     typed. Nothing is overwritten — a disagreement is a finding with a
 *     severity and the quoted words it rests on, because a system that
 *     silently "corrects" the record destroys the evidence that there was
 *     ever a discrepancy.
 *   · CONFIRMATION asks the broker or insurer, at their own address, through
 *     a single-use expiring link. Their reply sets the verification; ours
 *     never does. An unanswered request stays visibly unanswered, because
 *     silence is not confirmation.
 */
import { useCallback, useEffect, useState } from "react";
import { api } from "../../lib/api";
import { Badge, Button, ErrorAlert, Field, Input, Select, Spinner } from "../../ui";
import { formatDate, formatDateTime } from "../format";
import {
  CONFIRMATION_CHANNELS,
  CONFIRMATION_OUTCOME_LABELS,
  Caveat,
  DetailRow,
  SectionTitle,
  confirmationTone,
  errMsg,
  mismatchTone,
  type ConfirmationCreated,
  type ConfirmationRow,
  type ExtractionResult,
  type ListResponse,
  type StoredExtraction,
} from "./insuranceShared";

export default function AuthenticityPanel({
  projectId,
  certificateId,
  hasFile,
  onChanged,
}: {
  projectId: string;
  certificateId: string;
  hasFile: boolean;
  onChanged: () => void;
}) {
  const [extraction, setExtraction] = useState<StoredExtraction | null>(null);
  const [confirmations, setConfirmations] = useState<ConfirmationRow[]>([]);
  const [confirmReason, setConfirmReason] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [issuedLink, setIssuedLink] = useState<string | null>(null);

  const [channel, setChannel] = useState<string>("broker");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [ex, cf] = await Promise.all([
        api.get<StoredExtraction>(
          `/api/v1/projects/${projectId}/insurance/certificates/${certificateId}/extraction`,
        ),
        api.get<ListResponse<ConfirmationRow> & { reason: string | null }>(
          `/api/v1/projects/${projectId}/insurance/certificates/${certificateId}/confirmations`,
        ),
      ]);
      setExtraction(ex);
      setConfirmations(cf.items);
      setConfirmReason(cf.reason ?? null);
    } catch (err) {
      setError(errMsg(err, "Failed to load the authenticity checks"));
    } finally {
      setLoading(false);
    }
  }, [projectId, certificateId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function runExtraction() {
    setBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      const res = await api.post<ExtractionResult>(
        `/api/v1/projects/${projectId}/insurance/certificates/${certificateId}/extract`,
        {},
      );
      setNotice(res.summary);
      await load();
      onChanged();
    } catch (err) {
      setActionError(errMsg(err, "The extraction was refused"));
    } finally {
      setBusy(false);
    }
  }

  async function requestConfirmation() {
    setBusy(true);
    setActionError(null);
    setNotice(null);
    setIssuedLink(null);
    try {
      const res = await api.post<ConfirmationCreated>(
        `/api/v1/projects/${projectId}/insurance/certificates/${certificateId}/confirmations`,
        {
          channel,
          recipientEmail: email.trim(),
          recipientName: name.trim() || null,
        },
      );
      setIssuedLink(res.link);
      setNotice(
        res.dispatched
          ? `Sent to ${res.recipientEmail}. Their reply — not ours — will set the verification.`
          : `Recorded, but nothing was dispatched: ${res.deliveryReasons.join(" ") || "the mail transport does not send"}. Copy the link below to the recipient yourself.`,
      );
      setEmail("");
      setName("");
      await load();
    } catch (err) {
      setActionError(errMsg(err, "The confirmation request was refused"));
    } finally {
      setBusy(false);
    }
  }

  async function withdraw(id: string) {
    setBusy(true);
    setActionError(null);
    try {
      await api.post(`/api/v1/projects/${projectId}/insurance/confirmations/${id}/withdraw`, {});
      await load();
    } catch (err) {
      setActionError(errMsg(err, "The withdrawal was refused"));
    } finally {
      setBusy(false);
    }
  }

  if (loading && !extraction) return <Spinner label="Loading the authenticity checks…" />;

  return (
    <div className="space-y-3">
      <SectionTitle hint="Two checks that do not rely on anybody inside this company: what the document says, and what the party who issued the cover says.">
        Authenticity
      </SectionTitle>
      <ErrorAlert message={error} />
      <ErrorAlert message={actionError} />
      {notice ? (
        <div className="rounded-md bg-brand-50 px-3 py-2 text-xs leading-relaxed text-brand-900 ring-1 ring-brand-100">
          {notice}
        </div>
      ) : null}

      {/* ------------------------------ extraction ----------------------------- */}
      <div className="rounded-md ring-1 ring-ink-100">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-ink-100 px-3 py-2">
          <span className="text-xs font-semibold uppercase tracking-wide text-ink-500">
            What the document says
          </span>
          <Button
            size="sm"
            variant="secondary"
            disabled={busy || !hasFile}
            onClick={() => void runExtraction()}
          >
            {busy ? "Working…" : extraction?.available ? "Re-read the document" : "Read the document"}
          </Button>
        </div>
        <div className="space-y-2 px-3 py-2">
          {!hasFile ? (
            <p className="text-xs text-ink-500">
              No document has been uploaded, so there is nothing to read. The record asserts the
              cover and nothing tests it.
            </p>
          ) : !extraction?.available ? (
            <p className="text-xs text-ink-500">
              {extraction?.reason ??
                "The document has never been read. Reading it compares the paper with the record — it does not verify either."}
            </p>
          ) : (
            <>
              <p className="text-[11px] text-ink-400">
                Read {formatDateTime(extraction.extractedAt)} · run{" "}
                <span className="font-mono">{extraction.runId}</span>
              </p>
              {extraction.mismatches.length === 0 ? (
                <p className="text-xs text-emerald-800">
                  Every field the extraction could read agrees with the record. That is agreement
                  between the record and the paper supplied with it — not confirmation from the
                  insurer.
                </p>
              ) : (
                <ul className="space-y-2">
                  {extraction.mismatches.map((m) => (
                    <li key={m.field} className="rounded bg-ink-50 px-2 py-1.5 ring-1 ring-ink-100">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge tone={mismatchTone(m.severity)}>{m.severity}</Badge>
                        <span className="text-xs font-semibold text-ink-800">{m.field}</span>
                        <span className="text-xs text-ink-600">
                          record <span className="font-medium">{String(m.typed ?? "—")}</span> ·
                          document <span className="font-medium">{String(m.extracted ?? "—")}</span>
                        </span>
                      </div>
                      <p className="mt-1 text-[11px] leading-relaxed text-ink-600">{m.detail}</p>
                      {m.quote ? (
                        <p className="mt-1 border-l-2 border-ink-200 pl-2 font-mono text-[11px] text-ink-500">
                          “{m.quote}”
                        </p>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
              {extraction.extracted ? (
                <div className="mt-1">
                  <DetailRow label="Insurer">{extraction.extracted.insurer ?? "not stated"}</DetailRow>
                  <DetailRow label="Policy no.">
                    {extraction.extracted.policyNumber ?? "not stated"}
                  </DetailRow>
                  <DetailRow label="Limit">
                    {extraction.extracted.limitOfIndemnity === null
                      ? "not stated"
                      : `${extraction.extracted.currency ?? ""} ${extraction.extracted.limitOfIndemnity.toLocaleString("en-GB")}`}
                  </DetailRow>
                  <DetailRow label="Period">
                    {extraction.extracted.validFrom ?? "not stated"} →{" "}
                    {extraction.extracted.validTo ?? "not stated"}
                  </DetailRow>
                  <DetailRow label="Endorsements">
                    {extraction.extracted.endorsements.length === 0
                      ? "none quoted"
                      : extraction.extracted.endorsements.join("; ")}
                  </DetailRow>
                </div>
              ) : null}
              <Caveat>
                Reading a document is not confirming it. Nothing on the certificate record has been
                changed by the extraction: deciding which side is right is a person's job.
              </Caveat>
            </>
          )}
        </div>
      </div>

      {/* ---------------------------- confirmations ---------------------------- */}
      <div className="rounded-md ring-1 ring-ink-100">
        <div className="border-b border-ink-100 px-3 py-2">
          <span className="text-xs font-semibold uppercase tracking-wide text-ink-500">
            What the broker or insurer says
          </span>
        </div>
        <div className="space-y-2 px-3 py-2">
          {confirmations.length === 0 ? (
            <p className="text-xs text-ink-500">
              {confirmReason ??
                "Nobody has been asked to confirm this certificate. Until they are, verification rests on the document alone."}
            </p>
          ) : (
            <ul className="space-y-1">
              {confirmations.map((c) => (
                <li key={c.id} className="rounded bg-ink-50 px-2 py-1.5 ring-1 ring-ink-100">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={confirmationTone(c)}>
                      {c.status === "responded"
                        ? (CONFIRMATION_OUTCOME_LABELS[c.responseOutcome ?? ""] ?? "Responded")
                        : c.overdue
                          ? "No reply, link expired"
                          : c.status}
                    </Badge>
                    <span className="text-xs text-ink-700">{c.channel}</span>
                    <span className="text-xs text-ink-600">{c.recipientEmail}</span>
                    <span className="text-[11px] text-ink-400">
                      asked {formatDate(c.createdAt)} · expires {formatDate(c.expiresAt)}
                    </span>
                    {c.status === "sent" ? (
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={busy}
                        onClick={() => void withdraw(c.id)}
                      >
                        Withdraw
                      </Button>
                    ) : null}
                  </div>
                  {c.responseNote ? (
                    <p className="mt-1 text-[11px] leading-relaxed text-ink-600">
                      Their words: “{c.responseNote}”
                    </p>
                  ) : null}
                  {c.responseSha256 ? (
                    <p className="mt-0.5 break-all font-mono text-[10px] text-ink-400">
                      reply sha256 {c.responseSha256}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          )}

          <div className="grid gap-2 sm:grid-cols-3">
            <Field label="Ask">
              <Select value={channel} onChange={(e) => setChannel(e.target.value)}>
                {CONFIRMATION_CHANNELS.map((c) => (
                  <option key={c} value={c}>
                    {c === "broker" ? "The broker" : "The insurer"}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Their email">
              <Input
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="underwriting@insurer.example"
                maxLength={320}
              />
            </Field>
            <Field label="Their name (optional)">
              <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={200} />
            </Field>
          </div>
          <Button size="sm" disabled={busy || email.trim().length < 5} onClick={() => void requestConfirmation()}>
            Send a confirmation request
          </Button>
          {issuedLink ? (
            <p className="break-all rounded bg-ink-50 px-2 py-1 font-mono text-[11px] text-ink-600">
              {issuedLink}
              <span className="ml-2 font-sans text-ink-400">
                — shown once. It is a bearer link: anyone holding it can answer for this
                certificate.
              </span>
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
