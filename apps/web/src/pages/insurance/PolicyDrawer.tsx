/**
 * Policy detail — the wording's consequences, not just its fields.
 *
 * Three things are given more room than a form field deserves, because they
 * are the three that decide whether the cover is worth anything:
 *   · the notification rule, rendered verbatim as the API returns it (#783);
 *   · conditions marked as conditions precedent to liability;
 *   · the derived status, when it disagrees with the stored one.
 */
import { useCallback, useEffect, useState } from "react";
import { api } from "../../lib/api";
import { Badge, Button, ErrorAlert, Select, Spinner, Textarea } from "../../ui";
import { formatDate, formatDateTime } from "../format";
import {
  ConfirmStrip,
  DeadlineChip,
  DetailRow,
  Disclosure,
  Drawer,
  LIMIT_BASIS_LABELS,
  POLICY_TRANSITIONS,
  SectionTitle,
  claimTone,
  certificateTone,
  errMsg,
  fmtMoney,
  parseConditions,
  parseInsuredParties,
  policyTone,
  policyTypeLabel,
  type PolicyDetail,
  type PolicyRow,
} from "./insuranceShared";

export default function PolicyDrawer({
  projectId,
  policyId,
  ownerProjectId,
  onClose,
  onChanged,
  onEdit,
}: {
  projectId: string;
  policyId: string;
  /** the project that owns the policy — null for a company-level programme policy */
  ownerProjectId: string | null;
  onClose: () => void;
  onChanged: () => void;
  onEdit: (policy: PolicyRow) => void;
}) {
  const viaProject = ownerProjectId === null || ownerProjectId === projectId;
  const detailPath = viaProject
    ? `/api/v1/projects/${projectId}/insurance/policies/${policyId}`
    : `/api/v1/insurance/policies/${policyId}`;

  const [policy, setPolicy] = useState<PolicyDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [target, setTarget] = useState("");
  const [reason, setReason] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setPolicy(await api.get<PolicyDetail>(detailPath));
    } catch (err) {
      setPolicy(null);
      setError(errMsg(err, "Failed to load the policy"));
    }
  }, [detailPath]);

  useEffect(() => {
    void load();
  }, [load]);

  async function onTransition() {
    if (!policy || !target) return;
    setBusy(true);
    setActionError(null);
    try {
      const path =
        policy.projectId === null
          ? `/api/v1/insurance/policies/${policy.id}/status`
          : `/api/v1/projects/${policy.projectId}/insurance/policies/${policy.id}/status`;
      const body: Record<string, unknown> = { status: target };
      if (reason.trim()) body["reason"] = reason.trim();
      await api.post(path, body);
      setTarget("");
      setReason("");
      await load();
      onChanged();
    } catch (err) {
      setActionError(errMsg(err, "The transition was refused"));
    } finally {
      setBusy(false);
    }
  }

  async function onDelete() {
    if (!policy || policy.projectId === null) return;
    setBusy(true);
    setActionError(null);
    try {
      await api.del(
        `/api/v1/projects/${policy.projectId}/insurance/policies/${policy.id}`,
      );
      onChanged();
      onClose();
    } catch (err) {
      setConfirmDelete(false);
      setActionError(errMsg(err, "The policy could not be deleted"));
    } finally {
      setBusy(false);
    }
  }

  const allowed = policy ? (POLICY_TRANSITIONS[policy.status] ?? []) : [];
  const expiredPeriod = policy ? policy.daysToExpiry < 0 : false;
  const parties = policy ? parseInsuredParties(policy.insuredParties) : [];
  const conditions = policy ? parseConditions(policy.conditions) : [];
  const precedents = conditions.filter((c) => c.isConditionPrecedent);

  return (
    <Drawer
      open
      wide
      onClose={onClose}
      title={
        policy ? (
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-sm text-ink-500">{policy.number}</span>
            <span>{policyTypeLabel(policy.policyType)}</span>
            <Badge tone={policyTone(policy.derivedStatus)}>{policy.derivedStatus}</Badge>
            {policy.projectId === null ? <Badge tone="violet">Company programme</Badge> : null}
          </span>
        ) : (
          "Policy"
        )
      }
    >
      <ErrorAlert message={error} />
      {policy === null ? (
        error ? null : (
          <Spinner />
        )
      ) : (
        <div>
          {!viaProject ? (
            <div className="mb-3">
              <Disclosure label="Partial view" tone="ink">
                This policy belongs to another project, so it is read here through the company
                route: it carries its certificates, but its claims and its notification rule are
                only served by the owning project's workspace. Open that project's insurance
                workspace to see them.
              </Disclosure>
            </div>
          ) : null}

          {policy.derivedStatus !== policy.status ? (
            <div className="mb-3">
              <Disclosure label="Derived status differs from the stored status" tone="amber">
                The stored status is <strong>{policy.status}</strong>, but the recorded period ended
                on {policy.periodEnd}, so the API reports this policy as{" "}
                <strong>{policy.derivedStatus}</strong>. Expiry is a fact about the period, never a
                value typed by a user.
              </Disclosure>
            </div>
          ) : null}

          {/* ---------------------------- notification rule ---------------------------- */}
          {policy.notificationRule ? (
            <div className="mb-4 rounded-lg border-l-4 border-l-red-500 bg-white p-3 shadow-sm ring-1 ring-ink-100">
              <div className="text-sm font-semibold text-ink-900">
                Claim-notification rule
                {policy.notificationRule.notificationDays === null ? (
                  <Badge tone="red">no period recorded</Badge>
                ) : (
                  <span className="ml-2 text-xs font-normal text-ink-500">
                    {policy.notificationRule.notificationDays} day(s) from awareness
                  </span>
                )}
              </div>
              <div className="mt-2">
                <Disclosure
                  label="notificationRule.note — returned verbatim by the API"
                  tone={policy.notificationRule.notificationDays === null ? "red" : "brand"}
                >
                  {policy.notificationRule.note}
                </Disclosure>
              </div>
            </div>
          ) : null}

          {/* --------------------------------- fields --------------------------------- */}
          <SectionTitle>Cover</SectionTitle>
          <div>
            <DetailRow label="Insurer">{policy.insurer}</DetailRow>
            <DetailRow label="Policy number">
              <span className="font-mono text-xs">{policy.policyNumber}</span>
            </DetailRow>
            <DetailRow label="Period">
              {formatDate(policy.periodStart)} → {formatDate(policy.periodEnd)}{" "}
              <DeadlineChip days={policy.daysToExpiry} />
            </DetailRow>
            <DetailRow label="Limit of indemnity">
              {policy.limitOfIndemnity === null ? (
                <span className="text-amber-700">
                  Not recorded — this policy cannot contribute to any total cover figure.
                </span>
              ) : (
                <>
                  {fmtMoney(policy.limitOfIndemnity, policy.currency, 0)}{" "}
                  {policy.limitBasis ? (
                    <span className="text-xs text-ink-500">
                      ({LIMIT_BASIS_LABELS[policy.limitBasis] ?? policy.limitBasis})
                    </span>
                  ) : (
                    <span className="text-xs text-amber-700">(basis not recorded)</span>
                  )}
                </>
              )}
            </DetailRow>
            <DetailRow label="Deductible">
              {policy.deductible === null
                ? "Not recorded"
                : `${fmtMoney(policy.deductible, policy.currency, 0)}${
                    policy.deductibleBasis ? ` — ${policy.deductibleBasis}` : ""
                  }`}
            </DetailRow>
            <DetailRow label="Territorial limits">
              {policy.territorialLimits ?? <span className="text-ink-400">Not recorded</span>}
            </DetailRow>
            <DetailRow label="Required by clause">
              {policy.requiredByClause ?? (
                <span className="text-ink-400">
                  Not recorded — this policy's type is therefore not treated as a cover requirement
                  for the supply chain.
                </span>
              )}
            </DetailRow>
            <DetailRow label="In force">{policy.inForce ? "Yes" : "No"}</DetailRow>
            <DetailRow label="Created">{formatDateTime(policy.createdAt)}</DetailRow>
          </div>

          {/* --------------------------------- parties --------------------------------- */}
          <SectionTitle hint="A party who is not named is not insured.">Insured parties</SectionTitle>
          {parties.length === 0 ? (
            <p className="text-sm text-ink-400">None recorded.</p>
          ) : (
            <ul className="space-y-1 text-sm text-ink-800">
              {parties.map((p, i) => (
                <li key={i} className="flex items-baseline gap-2">
                  <span className="font-medium">{p.name}</span>
                  {p.capacity ? <span className="text-xs text-ink-500">{p.capacity}</span> : null}
                </li>
              ))}
            </ul>
          )}

          {/* ------------------------------- conditions ------------------------------- */}
          <SectionTitle
            hint={
              precedents.length > 0
                ? `${precedents.length} of these are conditions precedent to liability: breach of one defeats a claim outright, whatever its merits.`
                : undefined
            }
          >
            Conditions
          </SectionTitle>
          {conditions.length === 0 ? (
            <p className="text-sm text-ink-400">None recorded.</p>
          ) : (
            <div className="space-y-2">
              {conditions.map((c, i) => (
                <div
                  key={i}
                  className={`rounded-md p-2 text-sm ring-1 ${
                    c.isConditionPrecedent
                      ? "bg-red-50 text-red-900 ring-red-200"
                      : "bg-ink-50 text-ink-700 ring-ink-100"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs">{c.ref}</span>
                    {c.isConditionPrecedent ? (
                      <span className="rounded bg-red-700 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white">
                        Condition precedent
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-1 whitespace-pre-wrap text-xs leading-relaxed">{c.text}</p>
                </div>
              ))}
            </div>
          )}

          {/* ------------------------------ certificates ------------------------------ */}
          <SectionTitle hint="Evidence filed against this policy.">Certificates</SectionTitle>
          {!policy.certificates || policy.certificates.length === 0 ? (
            <p className="text-sm text-ink-400">None filed against this policy.</p>
          ) : (
            <div className="space-y-1">
              {policy.certificates.map((c) => (
                <div
                  key={c.id}
                  className="flex flex-wrap items-center gap-2 rounded-md bg-ink-50 px-2 py-1.5 text-sm"
                >
                  <span className="font-medium text-ink-900">{c.subjectName}</span>
                  <Badge tone={certificateTone(c)}>{c.inDate ? "in date" : "not in date"}</Badge>
                  <span className="text-xs text-ink-500">
                    {formatDate(c.validFrom)} → {formatDate(c.validTo)}
                  </span>
                  {c.verified ? (
                    <Badge tone="green">verified</Badge>
                  ) : (
                    <Badge tone="amber">unverified</Badge>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* --------------------------------- claims --------------------------------- */}
          {viaProject ? (
            <>
              <SectionTitle>Claims under this policy</SectionTitle>
              {!policy.claims || policy.claims.length === 0 ? (
                <p className="text-sm text-ink-400">None recorded.</p>
              ) : (
                <div className="space-y-1">
                  {policy.claims.map((c) => (
                    <div
                      key={c.id}
                      className="flex flex-wrap items-center gap-2 rounded-md bg-ink-50 px-2 py-1.5 text-sm"
                    >
                      <span className="font-mono text-xs text-ink-500">{c.number}</span>
                      <span className="grow font-medium text-ink-900">{c.title}</span>
                      <Badge tone={claimTone(c.status)}>{c.status}</Badge>
                      {c.notifiedLate ? (
                        <span className="rounded bg-red-900 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-red-50">
                          notified late
                        </span>
                      ) : c.notificationOutstanding ? (
                        <DeadlineChip
                          days={c.daysToNotificationDue}
                          fatal
                          unknownLabel="no deadline computed"
                        />
                      ) : null}
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : null}

          {/* --------------------------------- actions --------------------------------- */}
          <SectionTitle>Status</SectionTitle>
          <ErrorAlert message={actionError} />
          {!viaProject && policy.projectId !== null ? (
            <p className="text-sm text-ink-500">
              This policy is owned by another project. Transition and edit it from that project's
              insurance workspace so its tool permissions apply.
            </p>
          ) : allowed.length === 0 ? (
            <p className="text-sm text-ink-500">
              A {policy.status} policy is terminal — there is no transition out of it. Record a
              replacement policy with its own period instead.
            </p>
          ) : (
            <div className="space-y-2">
              <div className="flex flex-wrap items-end gap-2">
                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-ink-600">
                    Transition to
                  </span>
                  <Select
                    value={target}
                    onChange={(e) => setTarget(e.target.value)}
                    className="w-56"
                  >
                    <option value="">Choose…</option>
                    {allowed.map((s) => (
                      <option
                        key={s}
                        value={s}
                        disabled={s === "active" && expiredPeriod}
                      >
                        {s}
                        {s === "active" && expiredPeriod ? " — period already ended" : ""}
                      </option>
                    ))}
                  </Select>
                </label>
                <Button
                  disabled={busy || !target || (target === "active" && expiredPeriod)}
                  onClick={() => void onTransition()}
                >
                  {busy ? "Working…" : "Apply"}
                </Button>
              </div>
              <Textarea
                className="min-h-10"
                placeholder="Reason (optional — stored on the ledger entry)"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
              <p className="text-xs leading-relaxed text-ink-500">
                <strong>expired</strong> is not offered: it is derived from the period end (
                {policy.periodEnd}) and applied automatically once that date passes. To end cover
                early use <strong>cancelled</strong>; to record a lapse for non-payment use{" "}
                <strong>lapsed</strong>.
                {expiredPeriod && allowed.includes("active")
                  ? " Activation is unavailable because the recorded period has already ended — record the renewal as a new policy with its own period."
                  : ""}
              </p>
            </div>
          )}

          <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-ink-100 pt-4">
            <Button
              variant="secondary"
              disabled={["cancelled", "expired"].includes(policy.status)}
              title={
                ["cancelled", "expired"].includes(policy.status)
                  ? `A ${policy.status} policy cannot be edited — record an endorsement or a replacement policy instead.`
                  : undefined
              }
              onClick={() => onEdit(policy)}
            >
              Edit
            </Button>
            {policy.status === "draft" && policy.projectId !== null && viaProject ? (
              confirmDelete ? (
                <div className="w-full">
                  <ConfirmStrip
                    message={
                      <>
                        Delete draft policy {policy.number}? Only a draft with no claims can be
                        deleted; anything else is part of the record and must be cancelled instead.
                      </>
                    }
                    confirmLabel="Delete policy"
                    busy={busy}
                    onCancel={() => setConfirmDelete(false)}
                    onConfirm={() => void onDelete()}
                  />
                </div>
              ) : (
                <Button variant="danger" onClick={() => setConfirmDelete(true)}>
                  Delete draft
                </Button>
              )
            ) : null}
          </div>
        </div>
      )}
    </Drawer>
  );
}
