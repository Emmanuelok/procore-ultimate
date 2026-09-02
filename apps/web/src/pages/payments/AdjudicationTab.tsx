/**
 * STATUTORY ADJUDICATION (spec Vol II F #386–390).
 *
 * Every security-of-payment regime provides a fast-track dispute path with a
 * timetable measured in days, and missing a step in it is how a good case is
 * lost on procedure. The timetable is COMPUTED from the code-resident model
 * of the regime and re-based on the actual referral date, each step carrying
 * its own obligation — and every screen that shows a date shows the
 * disclaimer with it, because the model holds the headline periods of each
 * Act and none of the extensions parties may agree.
 */
import { useCallback, useEffect, useState } from "react";
import { api } from "../../lib/api";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  EmptyState,
  ErrorAlert,
  Field,
  Input,
  Modal,
  Select,
  Spinner,
  Table,
  Td,
  Textarea,
  Th,
} from "../../ui";
import { formatDate, humanize } from "../format";
import { fmtMoney, regimeShort, type ListResponse } from "./paymentsShared";

interface TimetableStep {
  step: "referral" | "response" | "decision";
  dueAt: string;
  basis: string;
  obligationId: string | null;
}

interface AdjudicationRule {
  regime: string;
  referralDays: number;
  referralBasis: string;
  responseDays: number;
  responseBasis: string;
  decisionDays: number;
  decisionBasis: string;
  decisionRunsFrom: string;
  note: string;
}

interface CaseRow {
  id: string;
  reference: string;
  status: string;
  regime: string;
  referringParty: string;
  disputedAmount: number;
  currency: string;
  adjudicatorName: string | null;
  nominatingBody: string | null;
  noticeAt: string | null;
  referralAt: string | null;
  responseAt: string | null;
  responseDueAt: string | null;
  decisionDueAt: string | null;
  decisionAt: string | null;
  decisionAmount: number | null;
  decisionSummary: string | null;
  timetable: TimetableStep[];
  rule?: AdjudicationRule | null;
  obligations?: Array<{
    id: string;
    status: string;
    trigger: string;
    deadline: string | null;
  }>;
}

interface RadarItem {
  id: string;
  reference: string;
  status: string;
  regime: string;
  disputedAmount: number;
  currency: string;
  nextStep: string;
  nextDueAt: string | null;
  daysRemaining: number | null;
}

function caseTone(status: string): "neutral" | "warning" | "danger" | "success" | "info" {
  switch (status) {
    case "decided":
    case "enforced":
      return "success";
    case "settled":
    case "withdrawn":
      return "neutral";
    case "referred":
    case "responded":
      return "warning";
    default:
      return "info";
  }
}

export default function AdjudicationTab({ projectId }: { projectId: string }) {
  const base = `/api/v1/projects/${projectId}`;
  const [rows, setRows] = useState<CaseRow[] | null>(null);
  const [radar, setRadar] = useState<RadarItem[]>([]);
  const [rules, setRules] = useState<AdjudicationRule[]>([]);
  const [disclaimer, setDisclaimer] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [list, rad] = await Promise.all([
        api.get<ListResponse<CaseRow> & { disclaimer: string }>(
          `${base}/adjudications?page=1&pageSize=200`,
        ),
        api.get<{ items: RadarItem[] }>(`${base}/adjudications-radar`),
      ]);
      setRows(list.items);
      setDisclaimer(list.disclaimer);
      setRadar(rad.items ?? []);
    } catch (err) {
      setRows([]);
      setError(
        err instanceof Error ? err.message : "The adjudication register could not be loaded.",
      );
    }
  }, [base]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api.get<{ items: AdjudicationRule[] }>("/api/v1/adjudication-rules");
        if (!cancelled) setRules(res.items);
      } catch {
        /* the reference cards simply do not render */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="space-y-4">
      {disclaimer ? (
        <Alert tone="warning" variant="subtle" size="sm" title="Indicative timetable">
          {disclaimer}
        </Alert>
      ) : null}

      <ErrorAlert message={error} />

      {radar.length > 0 ? (
        <Card>
          <CardBody className="py-3">
            <div className="mb-2 text-label uppercase text-content-subtle">
              Next step on every live case, soonest first
            </div>
            <div className="flex flex-wrap gap-2">
              {radar.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => setOpenId(r.id)}
                  className="inline-flex items-center gap-2 rounded-full border border-border bg-surface-raised px-2.5 py-1 text-2xs hover:bg-surface-hover"
                >
                  <span className="font-mono">{r.reference}</span>
                  <span>{humanize(r.nextStep)}</span>
                  <Badge
                    size="xs"
                    tone={
                      r.daysRemaining === null
                        ? "neutral"
                        : r.daysRemaining < 0
                          ? "danger"
                          : r.daysRemaining <= 3
                            ? "warning"
                            : "neutral"
                    }
                  >
                    {r.daysRemaining === null
                      ? "no date"
                      : r.daysRemaining < 0
                        ? "OVERDUE"
                        : `${r.daysRemaining}d`}
                  </Badge>
                </button>
              ))}
            </div>
          </CardBody>
        </Card>
      ) : null}

      <div className="flex justify-end">
        <Button size="sm" onClick={() => setCreating(true)}>
          Open a case
        </Button>
      </div>

      {rows === null ? (
        <Spinner label="Loading adjudications…" />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No adjudications on this project"
          hint="A notice of adjudication starts a statutory clock. Recording it here computes the timetable and puts each step in the obligation register."
          action={<Button onClick={() => setCreating(true)}>Open the first case</Button>}
        />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Ref</Th>
              <Th>Regime</Th>
              <Th className="text-right">Disputed</Th>
              <Th>Notice</Th>
              <Th>Response due</Th>
              <Th>Decision due</Th>
              <Th>Status</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((c) => (
              <tr
                key={c.id}
                className="cursor-pointer hover:bg-surface-hover"
                onClick={() => setOpenId(c.id)}
              >
                <Td className="whitespace-nowrap font-mono text-xs">{c.reference}</Td>
                <Td>
                  <Badge tone="info" size="xs">
                    {regimeShort(c.regime)}
                  </Badge>
                </Td>
                <Td className="whitespace-nowrap text-right font-mono tabular-nums">
                  {fmtMoney(c.disputedAmount, c.currency)}
                </Td>
                <Td className="whitespace-nowrap text-xs">{formatDate(c.noticeAt)}</Td>
                <Td className="whitespace-nowrap text-xs">{formatDate(c.responseDueAt)}</Td>
                <Td className="whitespace-nowrap text-xs">{formatDate(c.decisionDueAt)}</Td>
                <Td>
                  <Badge tone={caseTone(c.status)} dot size="xs">
                    {humanize(c.status)}
                  </Badge>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      {rules.length > 0 ? (
        <Card>
          <CardBody>
            <div className="mb-2 text-label uppercase text-content-subtle">
              The code-resident model, regime by regime
            </div>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {rules.map((r) => (
                <div key={r.regime} className="rounded-md border border-border p-3">
                  <div className="text-meta font-semibold">{regimeShort(r.regime)}</div>
                  <ul className="mt-1 space-y-0.5 text-2xs text-content-muted">
                    <li>
                      Referral: {r.referralDays} {r.referralBasis} days from the notice
                    </li>
                    <li>
                      Response: {r.responseDays} {r.responseBasis} days from the referral
                    </li>
                    <li>
                      Decision: {r.decisionDays} {r.decisionBasis} days from the{" "}
                      {r.decisionRunsFrom}
                    </li>
                  </ul>
                  <details className="mt-1">
                    <summary className="cursor-pointer text-2xs text-accent-text">
                      Statutory note
                    </summary>
                    <p className="mt-1 text-2xs leading-5 text-content-subtle">{r.note}</p>
                  </details>
                </div>
              ))}
            </div>
          </CardBody>
        </Card>
      ) : null}

      <CreateCase
        open={creating}
        base={base}
        rules={rules}
        onClose={() => setCreating(false)}
        onCreated={() => {
          setCreating(false);
          void load();
        }}
      />

      <CaseDrawer
        caseId={openId}
        base={base}
        onClose={() => setOpenId(null)}
        onChanged={() => void load()}
      />
    </div>
  );
}

function CreateCase({
  open,
  base,
  rules,
  onClose,
  onCreated,
}: {
  open: boolean;
  base: string;
  rules: AdjudicationRule[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [regime, setRegime] = useState("uk_hgcra");
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState("GBP");
  const [noticeAt, setNoticeAt] = useState("");
  const [referringParty, setReferringParty] = useState("claimant");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const rule = rules.find((r) => r.regime === regime) ?? null;

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await api.post(`${base}/adjudications`, {
        regime,
        disputedAmount: Number(amount) || 0,
        currency: currency.trim().toUpperCase() || "GBP",
        referringParty,
        ...(noticeAt ? { noticeAt } : {}),
        ...(notes.trim() ? { notes: notes.trim() } : {}),
      });
      setAmount("");
      setNoticeAt("");
      setNotes("");
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "The case could not be opened.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Open an adjudication case"
      size="md"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={busy || !Number.isFinite(Number(amount))} onClick={() => void submit()}>
            {busy ? "Opening…" : "Open the case"}
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <ErrorAlert message={error} />
        <Field label="Regime" required>
          <Select value={regime} onChange={(e) => setRegime(e.target.value)}>
            {(rules.length > 0
              ? rules.map((r) => r.regime)
              : ["uk_hgcra", "sg_sopa", "au_nsw_sopa", "my_cipaa", "nz_cca"]
            ).map((r) => (
              <option key={r} value={r}>
                {regimeShort(r)}
              </option>
            ))}
          </Select>
        </Field>
        {rule ? (
          <p className="text-2xs text-content-subtle">
            Referral {rule.referralDays} {rule.referralBasis} days from the notice; decision{" "}
            {rule.decisionDays} {rule.decisionBasis} days from the {rule.decisionRunsFrom}.
          </p>
        ) : null}
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Disputed amount" required>
            <Input value={amount} inputMode="decimal" onChange={(e) => setAmount(e.target.value)} />
          </Field>
          <Field label="Currency">
            <Input value={currency} maxLength={3} onChange={(e) => setCurrency(e.target.value)} />
          </Field>
          <Field label="Notice date">
            <Input type="date" value={noticeAt} onChange={(e) => setNoticeAt(e.target.value)} />
          </Field>
        </div>
        <Field label="Referring party">
          <Select value={referringParty} onChange={(e) => setReferringParty(e.target.value)}>
            <option value="claimant">Us (claimant)</option>
            <option value="respondent">The other side (respondent)</option>
          </Select>
        </Field>
        <Field label="Notes">
          <Textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

function CaseDrawer({
  caseId,
  base,
  onClose,
  onChanged,
}: {
  caseId: string | null;
  base: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [data, setData] = useState<CaseRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [decisionAmount, setDecisionAmount] = useState("");
  const [decisionSummary, setDecisionSummary] = useState("");

  const load = useCallback(async () => {
    if (!caseId) return;
    setError(null);
    try {
      setData(await api.get<CaseRow>(`${base}/adjudications/${caseId}`));
    } catch (err) {
      setError(err instanceof Error ? err.message : "The case could not be loaded.");
    }
  }, [base, caseId]);

  useEffect(() => {
    if (!caseId) {
      setData(null);
      return;
    }
    void load();
  }, [caseId, load]);

  async function act(action: string, body?: unknown) {
    if (!caseId) return;
    setBusy(true);
    setError(null);
    try {
      await api.post(`${base}/adjudications/${caseId}/${action}`, body ?? {});
      await load();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : `The case could not be ${action}d.`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={caseId !== null}
      onClose={onClose}
      title={data ? `${data.reference} — ${regimeShort(data.regime)}` : "Adjudication"}
      size="lg"
    >
      <div className="space-y-3">
        <ErrorAlert message={error} />
        {!data ? (
          <Spinner label="Loading…" />
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={caseTone(data.status)} dot>
                {humanize(data.status)}
              </Badge>
              <span className="font-mono text-meta tabular-nums">
                {fmtMoney(data.disputedAmount, data.currency)} disputed
              </span>
              {data.adjudicatorName ? (
                <span className="text-meta text-content-muted">
                  Adjudicator: {data.adjudicatorName}
                </span>
              ) : null}
            </div>

            <Table>
              <thead>
                <tr>
                  <Th>Step</Th>
                  <Th>Due</Th>
                  <Th>Basis</Th>
                  <Th>Obligation</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {data.timetable.map((s) => {
                  const obl = (data.obligations ?? []).find((o) => o.id === s.obligationId);
                  return (
                    <tr key={s.step}>
                      <Td className="capitalize">{s.step}</Td>
                      <Td className="whitespace-nowrap text-xs">{formatDate(s.dueAt)}</Td>
                      <Td className="text-2xs text-content-muted">{s.basis}</Td>
                      <Td>
                        {obl ? (
                          <Badge
                            size="xs"
                            tone={
                              obl.status === "breached"
                                ? "danger"
                                : obl.status === "satisfied"
                                  ? "success"
                                  : "neutral"
                            }
                          >
                            {humanize(obl.status)}
                          </Badge>
                        ) : (
                          <span className="text-2xs text-content-subtle">—</span>
                        )}
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>

            {data.decisionSummary ? (
              <Alert tone="success" size="sm" title={`Decided ${formatDate(data.decisionAt)}`}>
                <p className="font-mono tabular-nums">
                  {fmtMoney(data.decisionAmount ?? 0, data.currency)}
                </p>
                <p className="mt-1 whitespace-pre-wrap">{data.decisionSummary}</p>
              </Alert>
            ) : null}

            {data.status === "referred" || data.status === "responded" ? (
              <Card>
                <CardBody className="space-y-2">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label={`Decided amount (${data.currency})`}>
                      <Input
                        value={decisionAmount}
                        inputMode="decimal"
                        onChange={(e) => setDecisionAmount(e.target.value)}
                      />
                    </Field>
                    <Field label="Decision summary" required>
                      <Input
                        value={decisionSummary}
                        onChange={(e) => setDecisionSummary(e.target.value)}
                      />
                    </Field>
                  </div>
                  <Button
                    size="sm"
                    disabled={
                      busy || !decisionSummary.trim() || !Number.isFinite(Number(decisionAmount))
                    }
                    onClick={() =>
                      void act("decide", {
                        decisionAmount: Number(decisionAmount) || 0,
                        decisionSummary: decisionSummary.trim(),
                      })
                    }
                  >
                    Record the decision
                  </Button>
                </CardBody>
              </Card>
            ) : null}

            <div className="flex flex-wrap gap-2">
              {data.status === "notice" ? (
                <Button size="sm" disabled={busy} onClick={() => void act("refer")}>
                  Record the referral
                </Button>
              ) : null}
              {data.status === "referred" ? (
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busy}
                  onClick={() => {
                    const summary = window.prompt("Summary of the response served?") ?? "";
                    void act("respond", summary.trim() ? { summary: summary.trim() } : {});
                  }}
                >
                  Record the response
                </Button>
              ) : null}
              {data.status === "decided" ? (
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busy}
                  onClick={() => void act("enforce")}
                >
                  Record enforcement
                </Button>
              ) : null}
              {["notice", "referred", "responded", "decided"].includes(data.status) ? (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    const note = window.prompt("Terms of settlement?");
                    if (note?.trim()) void act("settle", { note: note.trim() });
                  }}
                >
                  Settle
                </Button>
              ) : null}
              {["notice", "referred", "responded"].includes(data.status) ? (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    const note = window.prompt("Why is the case withdrawn?");
                    if (note?.trim()) void act("withdraw", { note: note.trim() });
                  }}
                >
                  Withdraw
                </Button>
              ) : null}
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
