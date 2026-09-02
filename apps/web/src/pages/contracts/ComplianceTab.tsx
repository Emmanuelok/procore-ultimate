/**
 * Insurance, bond and guarantee compliance (spec Vol II Domain C #251-253).
 *
 * The contract's own requirement set is seeded from the standard form, then
 * each requirement is linked to the policy or bond that answers it and
 * re-evaluated. `unknown` is a first-class verdict: no evidence is not the
 * same as bad evidence, and colouring it green is how compliance theatre
 * starts.
 */
import { useCallback, useEffect, useState } from "react";
import { api, ApiClientError } from "../../lib/api";
import {
  Badge,
  Button,
  EmptyState,
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
import { formatDate, formatDateTime, formatMoney, humanize } from "../format";
import { complianceTone, type ComplianceCheckRow } from "./contractsShared";

interface PolicyOption {
  id: string;
  policyNumber: string;
  policyType: string;
  limitOfIndemnity: number | null;
  currency: string;
  periodEnd: string;
  status: string;
}

interface BondOption {
  id: string;
  number: string;
  bondNumber: string | null;
  bondType: string;
  amount: number;
  currency: string;
  expiryAt: string | null;
  status: string;
}

const KINDS = ["insurance", "bond", "guarantee", "warranty", "other"] as const;

export default function ComplianceTab({
  projectId,
  contractId,
  currency,
}: {
  projectId: string;
  contractId: string;
  currency: string;
}) {
  const base = `/api/v1/projects/${projectId}/contracts/${contractId}/compliance`;
  const [rows, setRows] = useState<ComplianceCheckRow[] | null>(null);
  const [byStatus, setByStatus] = useState<Record<string, number>>({});
  const [available, setAvailable] = useState(0);
  const [policies, setPolicies] = useState<PolicyOption[]>([]);
  const [bonds, setBonds] = useState<BondOption[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [kind, setKind] = useState<string>("insurance");
  const [clauseRef, setClauseRef] = useState("");
  const [requirement, setRequirement] = useState("");
  const [requiredAmount, setRequiredAmount] = useState("");
  const [requiredUntil, setRequiredUntil] = useState("");

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api.get<{
        items: ComplianceCheckRow[];
        byStatus: Record<string, number>;
        available: number;
      }>(`${base}?pageSize=200`);
      setRows(res.items);
      setByStatus(res.byStatus);
      setAvailable(res.available);
    } catch (err) {
      setRows([]);
      setError(err instanceof Error ? err.message : "Failed to load compliance checks");
    }
    // evidence candidates are optional context; a failure here must not blank the tab
    try {
      const [p, b] = await Promise.all([
        api
          .get<{ items: PolicyOption[] }>(`/api/v1/projects/${projectId}/insurance/policies?pageSize=100`)
          .catch(() => ({ items: [] as PolicyOption[] })),
        api
          .get<{ items: BondOption[] }>(`/api/v1/projects/${projectId}/insurance/bonds?pageSize=100`)
          .catch(() => ({ items: [] as BondOption[] })),
      ]);
      setPolicies(p.items ?? []);
      setBonds(b.items ?? []);
    } catch {
      setPolicies([]);
      setBonds([]);
    }
  }, [base, projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(fn: () => Promise<unknown>) {
    setError(null);
    setBusy(true);
    try {
      await fn();
      await load();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "The action failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-ink-900">Insurance, bonds & guarantees</h2>
          <p className="mt-0.5 text-xs text-ink-500">
            Each requirement is tested against the evidence actually held, with the reason recorded.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {Object.entries(byStatus).map(([s, n]) => (
            <Badge key={s} tone={complianceTone(s)}>
              {n} {humanize(s).toLowerCase()}
            </Badge>
          ))}
          <Button
            variant="secondary"
            size="sm"
            disabled={busy || available === 0}
            onClick={() => void act(() => api.post(`${base}/seed`, {}))}
          >
            Seed from the form
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={busy || (rows?.length ?? 0) === 0}
            onClick={() => void act(() => api.post(`${base}/evaluate`, {}))}
          >
            Re-evaluate
          </Button>
          <Button size="sm" onClick={() => setAdding((v) => !v)}>
            {adding ? "Close" : "Add requirement"}
          </Button>
        </div>
      </div>

      <ErrorAlert message={error} />

      {adding ? (
        <div className="mb-4 rounded-md bg-ink-50 p-3">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Field label="Kind">
              <Select value={kind} onChange={(e) => setKind(e.target.value)}>
                {KINDS.map((k) => (
                  <option key={k} value={k}>
                    {humanize(k)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Clause">
              <Input value={clauseRef} onChange={(e) => setClauseRef(e.target.value)} />
            </Field>
            <Field label={`Required amount (${currency})`}>
              <Input
                value={requiredAmount}
                inputMode="decimal"
                onChange={(e) => setRequiredAmount(e.target.value)}
              />
            </Field>
            <Field label="Required until">
              <Input
                type="date"
                value={requiredUntil}
                onChange={(e) => setRequiredUntil(e.target.value)}
              />
            </Field>
          </div>
          <Field label="Requirement" className="mt-2">
            <Textarea
              rows={2}
              value={requirement}
              onChange={(e) => setRequirement(e.target.value)}
            />
          </Field>
          <div className="mt-2 flex justify-end">
            <Button
              size="sm"
              disabled={busy || requirement.trim().length === 0}
              onClick={() =>
                void act(async () => {
                  await api.post(base, {
                    kind,
                    clauseRef: clauseRef || null,
                    requirement,
                    requiredAmount: requiredAmount ? Number(requiredAmount) : null,
                    requiredUntil: requiredUntil || null,
                  });
                  setRequirement("");
                  setClauseRef("");
                  setRequiredAmount("");
                  setRequiredUntil("");
                  setAdding(false);
                })
              }
            >
              Add
            </Button>
          </div>
        </div>
      ) : null}

      {rows === null ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No requirements recorded"
          hint={
            available > 0
              ? `This form imposes ${available} standard requirement${available === 1 ? "" : "s"} — seed them to start.`
              : "Add the insurance and bond requirements this contract imposes."
          }
        />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Clause</Th>
              <Th>Requirement</Th>
              <Th className="text-right">Required</Th>
              <Th>Until</Th>
              <Th>Evidence</Th>
              <Th>Status</Th>
              <Th />
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {rows.map((c) => (
              <tr key={c.id} className="align-top hover:bg-ink-50/60">
                <Td className="whitespace-nowrap">
                  <span className="font-mono text-xs font-medium">{c.clauseRef ?? "—"}</span>
                  <span className="block">
                    <Badge tone="gray">{humanize(c.kind)}</Badge>
                  </span>
                </Td>
                <Td className="max-w-md text-sm">{c.requirement}</Td>
                <Td className="text-right tabular-nums">
                  {c.requiredAmount == null ? "—" : formatMoney(c.requiredAmount, c.currency)}
                </Td>
                <Td className="whitespace-nowrap">{formatDate(c.requiredUntil)}</Td>
                <Td className="text-xs">
                  {c.evidenceType ? (
                    <>
                      {humanize(c.evidenceType)}
                      {c.evidenceAmount != null ? (
                        <span className="block">{formatMoney(c.evidenceAmount, c.currency)}</span>
                      ) : null}
                      {c.evidenceExpiry ? (
                        <span className="block text-ink-400">
                          expires {formatDate(c.evidenceExpiry)}
                        </span>
                      ) : null}
                    </>
                  ) : (
                    <span className="text-ink-400">none linked</span>
                  )}
                </Td>
                <Td>
                  <Badge tone={complianceTone(c.status)}>{humanize(c.status)}</Badge>
                  {c.reason ? (
                    <span className="mt-1 block max-w-xs text-xs text-ink-500">{c.reason}</span>
                  ) : null}
                  {c.lastCheckedAt ? (
                    <span className="block text-[11px] text-ink-400">
                      checked {formatDateTime(c.lastCheckedAt)}
                    </span>
                  ) : null}
                </Td>
                <Td className="whitespace-nowrap">
                  <EvidencePicker
                    check={c}
                    policies={policies}
                    bonds={bonds}
                    busy={busy}
                    onLink={(payload) =>
                      void act(() => api.post(`${base}/${c.id}/evidence`, payload))
                    }
                  />
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}

function EvidencePicker({
  check,
  policies,
  bonds,
  busy,
  onLink,
}: {
  check: ComplianceCheckRow;
  policies: PolicyOption[];
  bonds: BondOption[];
  busy: boolean;
  onLink: (payload: { evidenceType: string; evidenceId: string | null }) => void;
}) {
  const wantsBond = check.kind === "bond" || check.kind === "guarantee";
  const options = wantsBond
    ? bonds.map((b) => ({
        id: b.id,
        label: `${b.bondNumber ?? b.number} · ${humanize(b.bondType)} · ${b.amount} ${b.currency}`,
      }))
    : policies.map((p) => ({
        id: p.id,
        label: `${p.policyNumber} · ${humanize(p.policyType)} · ${p.limitOfIndemnity ?? "—"} ${p.currency}`,
      }));

  if (options.length === 0) {
    return (
      <span className="text-xs text-ink-400">
        {wantsBond ? "No bonds recorded" : "No policies recorded"}
      </span>
    );
  }

  return (
    <div className="flex items-center gap-1">
      <Select
        className="w-48 text-xs"
        value={check.evidenceId ?? ""}
        disabled={busy}
        onChange={(e) =>
          onLink(
            e.target.value
              ? {
                  evidenceType: wantsBond ? "bond" : "insurance_policy",
                  evidenceId: e.target.value,
                }
              : { evidenceType: "none", evidenceId: null },
          )
        }
      >
        <option value="">— no evidence —</option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </Select>
    </div>
  );
}
