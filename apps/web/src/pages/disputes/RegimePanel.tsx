/**
 * Statutory timetable generation, adjudicator nomination request and the
 * outcome record (spec Vol II Domain E #322-333, #356).
 *
 * The regimes are published law encoded as offsets from a trigger date —
 * UK HGCRA/Scheme, Singapore SOPA, NSW and Queensland, Malaysia CIPAA, NZ
 * CCA, FIDIC DAAB. Generating a timetable materialises each dated step as an
 * assurance obligation; regenerating never erases a step already done.
 *
 * The nomination request is assembled, not drafted: every sentence comes
 * from a recorded field, and anything missing says so in the document.
 */
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { DISPUTE_JURISDICTIONS, DISPUTE_ROOT_CAUSES, ENFORCEMENT_STATUSES } from "@constructos/shared";
import { api, ApiClientError } from "../../lib/api";
import {
  Badge,
  Button,
  Card,
  CardBody,
  ErrorAlert,
  Field,
  Input,
  Modal,
  Select,
  Textarea,
} from "../../ui";
import { formatDate, humanize } from "../format";
import { SectionTitle, type DisputeDetail } from "./disputesShared";

interface RegimeStep {
  key: string;
  name: string;
  offsetDays: number;
  basis: string;
  extendableToDays: number | null;
  owner: string;
  authority: string;
}

interface RegimeSpec {
  jurisdiction: string;
  label: string;
  triggerName: string;
  statute: string;
  kinds: string[];
  steps: RegimeStep[];
  notes: string;
}

interface NominationRequest {
  title: string;
  sections: { heading: string; body: string }[];
  deadlines: { name: string; dueDate: string }[];
  basis: string;
}

/** Fields the drawer's dispute row carries once the regime work landed. */
interface DisputeRegimeFields {
  jurisdiction?: string | null;
  triggerDate?: string | null;
  rootCause?: string | null;
  amountClaimed?: number | null;
  amountAwarded?: number | null;
  costsAwarded?: number | null;
  resolvedAt?: string | null;
  enforcementStatus?: string | null;
  complianceDeadline?: string | null;
  nodDeadline?: string | null;
  governingClause?: string | null;
  contractFamily?: string | null;
}

export default function RegimePanel({
  projectId,
  dispute,
  onChanged,
}: {
  projectId: string;
  dispute: DisputeDetail & DisputeRegimeFields;
  onChanged: () => void;
}) {
  const base = `/api/v1/projects/${projectId}`;
  const [regimes, setRegimes] = useState<RegimeSpec[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [jurisdiction, setJurisdiction] = useState<string>(dispute.jurisdiction ?? "uk_hgcra");
  const [triggerDate, setTriggerDate] = useState<string>(dispute.triggerDate ?? "");
  const [holidays, setHolidays] = useState("");
  const [replace, setReplace] = useState(false);
  const [genOpen, setGenOpen] = useState(false);
  const [genBusy, setGenBusy] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);

  const [nomination, setNomination] = useState<NominationRequest | null>(null);
  const [nomOpen, setNomOpen] = useState(false);

  const [outcomeOpen, setOutcomeOpen] = useState(false);
  const [oClaimed, setOClaimed] = useState(
    dispute.amountClaimed === null || dispute.amountClaimed === undefined
      ? ""
      : String(dispute.amountClaimed),
  );
  const [oAwarded, setOAwarded] = useState(
    dispute.amountAwarded === null || dispute.amountAwarded === undefined
      ? ""
      : String(dispute.amountAwarded),
  );
  const [oCosts, setOCosts] = useState(
    dispute.costsAwarded === null || dispute.costsAwarded === undefined
      ? ""
      : String(dispute.costsAwarded),
  );
  const [oRootCause, setORootCause] = useState<string>(dispute.rootCause ?? "");
  const [oClause, setOClause] = useState(dispute.governingClause ?? "");
  const [oFamily, setOFamily] = useState(dispute.contractFamily ?? "");
  const [oResolved, setOResolved] = useState(dispute.resolvedAt ?? "");
  const [oEnforcement, setOEnforcement] = useState<string>(
    dispute.enforcementStatus ?? "not_applicable",
  );
  const [oCompliance, setOCompliance] = useState(dispute.complianceDeadline ?? "");
  const [oNod, setONod] = useState(dispute.nodDeadline ?? "");
  const [outcomeError, setOutcomeError] = useState<string | null>(null);
  const [outcomeBusy, setOutcomeBusy] = useState(false);

  const loadRegimes = useCallback(async () => {
    try {
      const res = await api.get<{ regimes: RegimeSpec[] }>("/api/v1/disputes/regimes");
      setRegimes(res.regimes);
    } catch {
      setRegimes([]);
    }
  }, []);

  useEffect(() => {
    void loadRegimes();
  }, [loadRegimes]);

  async function generate(e: FormEvent) {
    e.preventDefault();
    setGenError(null);
    setGenBusy(true);
    try {
      await api.post(`${base}/disputes/${dispute.id}/timetable/generate`, {
        jurisdiction,
        triggerDate,
        replace,
        holidays: holidays
          .split(/[\s,]+/)
          .map((h) => h.trim())
          .filter(Boolean),
      });
      setGenOpen(false);
      onChanged();
    } catch (err) {
      setGenError(err instanceof ApiClientError ? err.message : "Could not generate the timetable");
    } finally {
      setGenBusy(false);
    }
  }

  async function openNomination() {
    setError(null);
    try {
      setNomination(
        await api.get<NominationRequest>(`${base}/disputes/${dispute.id}/nomination-request`),
      );
      setNomOpen(true);
    } catch (err) {
      setError(
        err instanceof ApiClientError ? err.message : "Could not assemble the nomination request",
      );
    }
  }

  async function saveOutcome(e: FormEvent) {
    e.preventDefault();
    setOutcomeError(null);
    setOutcomeBusy(true);
    try {
      await api.patch(`${base}/disputes/${dispute.id}/outcome`, {
        enforcementStatus: oEnforcement,
        ...(oClaimed.trim() ? { amountClaimed: Number(oClaimed) } : {}),
        ...(oAwarded.trim() ? { amountAwarded: Number(oAwarded) } : {}),
        ...(oCosts.trim() ? { costsAwarded: Number(oCosts) } : {}),
        ...(oRootCause ? { rootCause: oRootCause } : {}),
        ...(oClause.trim() ? { governingClause: oClause.trim() } : {}),
        ...(oFamily.trim() ? { contractFamily: oFamily.trim() } : {}),
        ...(oResolved ? { resolvedAt: oResolved } : {}),
        ...(oCompliance ? { complianceDeadline: oCompliance } : {}),
        ...(oNod ? { nodDeadline: oNod } : {}),
      });
      setOutcomeOpen(false);
      onChanged();
    } catch (err) {
      setOutcomeError(
        err instanceof ApiClientError ? err.message : "Could not record the outcome",
      );
    } finally {
      setOutcomeBusy(false);
    }
  }

  const spec = (regimes ?? []).find((r) => r.jurisdiction === jurisdiction) ?? null;
  const current = (regimes ?? []).find((r) => r.jurisdiction === dispute.jurisdiction) ?? null;

  return (
    <div className="mt-5 border-t border-ink-100 pt-4">
      <SectionTitle>Regime, nomination and outcome</SectionTitle>
      <ErrorAlert message={error} />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        {dispute.jurisdiction ? (
          <Badge tone="violet">{current?.label ?? humanize(dispute.jurisdiction)}</Badge>
        ) : (
          <Badge tone="gray">no regime selected</Badge>
        )}
        {dispute.triggerDate ? (
          <span className="text-xs text-ink-500">
            trigger {formatDate(dispute.triggerDate)}
            {current ? ` (${current.triggerName})` : ""}
          </span>
        ) : null}
        {dispute.enforcementStatus && dispute.enforcementStatus !== "not_applicable" ? (
          <Badge tone={dispute.enforcementStatus === "complied" ? "green" : "amber"}>
            {humanize(dispute.enforcementStatus)}
          </Badge>
        ) : null}
      </div>

      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" size="sm" onClick={() => setGenOpen(true)}>
          Generate timetable from regime
        </Button>
        <Button variant="secondary" size="sm" onClick={() => void openNomination()}>
          Nomination request
        </Button>
        <Button variant="secondary" size="sm" onClick={() => setOutcomeOpen(true)}>
          Record outcome
        </Button>
      </div>

      {current ? (
        <p className="mt-2 text-xs leading-5 text-ink-400">
          {current.statute}. {current.notes}
        </p>
      ) : null}

      {/* ------------------------------ generate modal ----------------------------- */}
      <Modal open={genOpen} title="Generate procedural timetable" onClose={() => setGenOpen(false)} wide>
        <ErrorAlert message={genError} />
        <form onSubmit={generate} className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Regime">
              <Select value={jurisdiction} onChange={(e) => setJurisdiction(e.target.value)}>
                {DISPUTE_JURISDICTIONS.map((j) => (
                  <option key={j} value={j}>
                    {(regimes ?? []).find((r) => r.jurisdiction === j)?.label ?? humanize(j)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={spec ? spec.triggerName : "Trigger date"}>
              <Input
                type="date"
                required
                value={triggerDate}
                onChange={(e) => setTriggerDate(e.target.value)}
              />
            </Field>
          </div>
          <Field
            label="Public holidays"
            hint="Space or comma separated ISO dates — weekends are always excluded from business-day counts."
          >
            <Textarea
              value={holidays}
              onChange={(e) => setHolidays(e.target.value)}
              className="min-h-14 text-xs"
              placeholder="2026-12-25 2026-12-26"
            />
          </Field>
          <label className="flex items-center gap-2 text-xs text-ink-700">
            <input
              type="checkbox"
              className="h-4 w-4 accent-brand-600"
              checked={replace}
              onChange={(e) => setReplace(e.target.checked)}
            />
            Replace the existing timetable (steps already marked done are always kept)
          </label>

          {spec ? (
            <div className="rounded-md bg-ink-50 p-3 text-xs ring-1 ring-ink-100">
              <div className="mb-1 font-semibold text-ink-700">{spec.statute}</div>
              <ul className="space-y-1">
                {spec.steps.map((s) => (
                  <li key={s.key} className="flex flex-wrap gap-2">
                    <span className="font-medium text-ink-800">{s.name}</span>
                    <span className="tabular-nums text-ink-500">
                      +{s.offsetDays} {s.basis === "business" ? "business" : "calendar"} days
                      {s.extendableToDays === null ? "" : ` (extendable to ${s.extendableToDays})`}
                    </span>
                    <span className="text-ink-400">{s.authority}</span>
                  </li>
                ))}
              </ul>
              <p className="mt-2 leading-5 text-ink-500">{spec.notes}</p>
            </div>
          ) : null}

          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setGenOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={genBusy}>
              {genBusy ? "Generating…" : "Generate timetable"}
            </Button>
          </div>
        </form>
      </Modal>

      {/* ---------------------------- nomination modal ----------------------------- */}
      <Modal
        open={nomOpen}
        title={nomination?.title ?? "Nomination request"}
        onClose={() => setNomOpen(false)}
        wide
      >
        {nomination ? (
          <div className="space-y-3">
            {nomination.deadlines.length > 0 ? (
              <div className="rounded-md bg-brand-50 px-3 py-2 text-xs text-brand-900 ring-1 ring-brand-100">
                {nomination.deadlines
                  .map((d) => `${d.name}: ${formatDate(d.dueDate)}`)
                  .join(" · ")}
              </div>
            ) : null}
            {nomination.sections.map((sec) => (
              <div key={sec.heading}>
                <div className="text-xs font-semibold uppercase tracking-wide text-ink-400">
                  {sec.heading}
                </div>
                <p className="mt-0.5 whitespace-pre-wrap text-sm leading-6 text-ink-800">
                  {sec.body}
                </p>
              </div>
            ))}
            <p className="text-xs leading-5 text-ink-400">{nomination.basis}</p>
          </div>
        ) : null}
      </Modal>

      {/* ------------------------------ outcome modal ------------------------------ */}
      <Modal open={outcomeOpen} title="Record dispute outcome" onClose={() => setOutcomeOpen(false)} wide>
        <ErrorAlert message={outcomeError} />
        <form onSubmit={saveOutcome} className="space-y-4">
          <p className="text-xs leading-5 text-ink-500">
            These fields feed the company-wide outcome database: win rates, award ratios, cost of
            recovery and the clauses that keep being litigated. Leave a field blank rather than
            guessing — an unknown is more useful than a fabricated number.
          </p>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field label={`Claimed (${dispute.currency})`}>
              <Input
                type="number"
                min="0"
                step="any"
                value={oClaimed}
                onChange={(e) => setOClaimed(e.target.value)}
              />
            </Field>
            <Field label={`Awarded (${dispute.currency})`}>
              <Input
                type="number"
                step="any"
                value={oAwarded}
                onChange={(e) => setOAwarded(e.target.value)}
              />
            </Field>
            <Field label={`Costs awarded (${dispute.currency})`}>
              <Input
                type="number"
                step="any"
                value={oCosts}
                onChange={(e) => setOCosts(e.target.value)}
              />
            </Field>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field label="Root cause">
              <Select value={oRootCause} onChange={(e) => setORootCause(e.target.value)}>
                <option value="">Not classified</option>
                {DISPUTE_ROOT_CAUSES.map((r) => (
                  <option key={r} value={r}>
                    {humanize(r)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Governing clause">
              <Input
                value={oClause}
                onChange={(e) => setOClause(e.target.value)}
                placeholder="NEC4 cl. 61.3"
              />
            </Field>
            <Field label="Contract family">
              <Input
                value={oFamily}
                onChange={(e) => setOFamily(e.target.value)}
                placeholder="NEC4 ECC Option C"
              />
            </Field>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
            <Field label="Resolved on">
              <Input type="date" value={oResolved} onChange={(e) => setOResolved(e.target.value)} />
            </Field>
            <Field label="Enforcement">
              <Select value={oEnforcement} onChange={(e) => setOEnforcement(e.target.value)}>
                {ENFORCEMENT_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {humanize(s)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Compliance deadline">
              <Input
                type="date"
                value={oCompliance}
                onChange={(e) => setOCompliance(e.target.value)}
              />
            </Field>
            <Field label="Dissatisfaction window">
              <Input type="date" value={oNod} onChange={(e) => setONod(e.target.value)} />
            </Field>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setOutcomeOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={outcomeBusy}>
              {outcomeBusy ? "Saving…" : "Save outcome"}
            </Button>
          </div>
        </form>
      </Modal>

      <Card className="mt-3">
        <CardBody className="px-3 py-2">
          <p className="text-xs leading-5 text-ink-500">
            Recorded outcome: claimed{" "}
            {dispute.amountClaimed ?? "—"} · awarded {dispute.amountAwarded ?? "—"} · costs{" "}
            {dispute.costsAwarded ?? "—"} · root cause{" "}
            {dispute.rootCause ? humanize(dispute.rootCause) : "not classified"} · resolved{" "}
            {dispute.resolvedAt ? formatDate(dispute.resolvedAt) : "—"}.
          </p>
        </CardBody>
      </Card>
    </div>
  );
}
