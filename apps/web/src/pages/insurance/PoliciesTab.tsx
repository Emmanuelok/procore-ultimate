/**
 * Policies (#771-779) — the programme itself.
 *
 * A project's insurance picture includes the company-level programme: an
 * owner- or contractor-controlled master policy is carried at company level
 * and covers every project under it, so the project view lists both and says
 * which is which.
 *
 * Two rules from the API are enforced in the UI rather than discovered by
 * error message: `expired` is never offered as a status (it is derived from
 * the recorded period), and activation is not offered for a period that has
 * already run out.
 */
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { POLICY_TYPES } from "@constructos/shared";
import { api } from "../../lib/api";
import {
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
import { formatDate } from "../format";
import PolicyDrawer from "./PolicyDrawer";
import {
  DeadlineChip,
  LIMIT_BASES,
  LIMIT_BASIS_LABELS,
  Pager,
  errMsg,
  fmtMoney,
  policyTone,
  policyTypeLabel,
  type CompanyPolicyRow,
  type ListResponse,
  type PolicyRow,
  type FocusRequest,
  type InsuredParty,
  type PolicyCondition,
  type VendorLite,
} from "./insuranceShared";

const PAGE_SIZE = 25;

type ScopeKey = "project" | "companyOnly" | "estate";

const SCOPE_LABELS: Record<ScopeKey, string> = {
  project: "This project + company programme",
  companyOnly: "Company-level programme only",
  estate: "Every policy in the company",
};

interface FormState {
  companyLevel: boolean;
  policyType: string;
  insurer: string;
  policyNumber: string;
  brokerVendorId: string;
  limitOfIndemnity: string;
  limitBasis: string;
  currency: string;
  deductible: string;
  deductibleBasis: string;
  periodStart: string;
  periodEnd: string;
  notificationDays: string;
  territorialLimits: string;
  requiredByClause: string;
  insuredParties: InsuredParty[];
  conditions: PolicyCondition[];
}

const EMPTY_FORM: FormState = {
  companyLevel: false,
  policyType: "contractors_all_risks",
  insurer: "",
  policyNumber: "",
  brokerVendorId: "",
  limitOfIndemnity: "",
  limitBasis: "",
  currency: "GBP",
  deductible: "",
  deductibleBasis: "",
  periodStart: "",
  periodEnd: "",
  notificationDays: "",
  territorialLimits: "",
  requiredByClause: "",
  insuredParties: [],
  conditions: [],
};

export default function PoliciesTab({
  projectId,
  focus,
}: {
  projectId: string;
  focus: FocusRequest | null;
}) {
  const base = `/api/v1/projects/${projectId}`;

  const [scope, setScope] = useState<ScopeKey>("project");
  const [typeFilter, setTypeFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [page, setPage] = useState(1);

  const [items, setItems] = useState<(PolicyRow | CompanyPolicyRow)[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [vendors, setVendors] = useState<VendorLite[]>([]);

  const [selected, setSelected] = useState<{ id: string; ownerProjectId: string | null } | null>(
    null,
  );

  const load = useCallback(async () => {
    setError(null);
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
      if (typeFilter) params.set("policyType", typeFilter);
      if (statusFilter) params.set("status", statusFilter);
      let path: string;
      if (scope === "project") {
        path = `${base}/insurance/policies?${params}`;
      } else {
        if (scope === "companyOnly") params.set("companyLevelOnly", "true");
        path = `/api/v1/insurance/policies?${params}`;
      }
      const res = await api.get<ListResponse<PolicyRow | CompanyPolicyRow>>(path);
      setItems(res.items);
      setTotal(res.total);
    } catch (err) {
      setItems([]);
      setError(errMsg(err, "Failed to load policies"));
    }
  }, [base, page, scope, statusFilter, typeFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api.get<ListResponse<VendorLite>>("/api/v1/vendors?pageSize=200");
        if (!cancelled) setVendors(res.items);
      } catch {
        // the broker picker degrades to "none" — not worth an error banner
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /* Radar sent the reader here to look at one policy. */
  useEffect(() => {
    if (!focus?.recordId) return;
    const known = items?.find((p) => p.id === focus.recordId);
    setSelected({ id: focus.recordId, ownerProjectId: known ? known.projectId : projectId });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus]);

  /* ------------------------------ create / edit ------------------------------ */

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<PolicyRow | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  function openCreate() {
    setEditing(null);
    setForm({ ...EMPTY_FORM, companyLevel: scope === "companyOnly" });
    setFormError(null);
    setFormOpen(true);
  }

  function openEdit(p: PolicyRow) {
    setEditing(p);
    setForm({
      companyLevel: p.projectId === null,
      policyType: p.policyType,
      insurer: p.insurer,
      policyNumber: p.policyNumber,
      brokerVendorId: p.brokerVendorId ?? "",
      limitOfIndemnity: p.limitOfIndemnity === null ? "" : String(p.limitOfIndemnity),
      limitBasis: p.limitBasis ?? "",
      currency: p.currency,
      deductible: p.deductible === null ? "" : String(p.deductible),
      deductibleBasis: p.deductibleBasis ?? "",
      periodStart: p.periodStart,
      periodEnd: p.periodEnd,
      notificationDays: p.notificationDays === null ? "" : String(p.notificationDays),
      territorialLimits: p.territorialLimits ?? "",
      requiredByClause: p.requiredByClause ?? "",
      insuredParties: parseParties(p.insuredParties),
      conditions: parseConds(p.conditions),
    });
    setFormError(null);
    setFormOpen(true);
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    setBusy(true);
    try {
      const payload: Record<string, unknown> = {
        policyType: form.policyType,
        insurer: form.insurer.trim(),
        policyNumber: form.policyNumber.trim(),
        periodStart: form.periodStart,
        periodEnd: form.periodEnd,
        currency: form.currency.trim().toUpperCase() || "GBP",
        limitOfIndemnity: form.limitOfIndemnity === "" ? null : Number(form.limitOfIndemnity),
        limitBasis: form.limitBasis === "" ? null : form.limitBasis,
        deductible: form.deductible === "" ? null : Number(form.deductible),
        deductibleBasis: form.deductibleBasis.trim() || null,
        notificationDays: form.notificationDays === "" ? null : Number(form.notificationDays),
        territorialLimits: form.territorialLimits.trim() || null,
        requiredByClause: form.requiredByClause.trim() || null,
        brokerVendorId: form.brokerVendorId || null,
        insuredParties: form.insuredParties
          .filter((p) => p.name.trim())
          .map((p) => ({
            name: p.name.trim(),
            ...(p.capacity?.trim() ? { capacity: p.capacity.trim() } : {}),
            ...(p.vendorId ? { vendorId: p.vendorId } : {}),
          })),
        conditions: form.conditions
          .filter((c) => c.ref.trim() && c.text.trim())
          .map((c) => ({
            ref: c.ref.trim(),
            text: c.text.trim(),
            isConditionPrecedent: c.isConditionPrecedent === true,
          })),
      };
      if (editing) {
        const path =
          editing.projectId === null
            ? `/api/v1/insurance/policies/${editing.id}`
            : `/api/v1/projects/${editing.projectId}/insurance/policies/${editing.id}`;
        await api.patch<PolicyRow>(path, payload);
      } else {
        const path = form.companyLevel
          ? "/api/v1/insurance/policies"
          : `${base}/insurance/policies`;
        await api.post<PolicyRow>(path, payload);
      }
      setFormOpen(false);
      await load();
    } catch (err) {
      setFormError(errMsg(err, "Failed to save the policy"));
    } finally {
      setBusy(false);
    }
  }

  const periodInverted = useMemo(() => {
    if (!form.periodStart || !form.periodEnd) return false;
    return form.periodEnd < form.periodStart;
  }, [form.periodEnd, form.periodStart]);

  const editable =
    editing === null || !["cancelled", "expired"].includes(editing.status);

  return (
    <div>
      {/* -------------------------------- filters -------------------------------- */}
      <Card className="mb-4">
        <CardBody className="flex flex-wrap items-end gap-3 py-3">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-ink-600">Scope</span>
            <Select
              value={scope}
              onChange={(e) => {
                setScope(e.target.value as ScopeKey);
                setPage(1);
              }}
              className="w-72"
            >
              {(Object.keys(SCOPE_LABELS) as ScopeKey[]).map((k) => (
                <option key={k} value={k}>
                  {SCOPE_LABELS[k]}
                </option>
              ))}
            </Select>
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-ink-600">Policy type</span>
            <Select
              value={typeFilter}
              onChange={(e) => {
                setTypeFilter(e.target.value);
                setPage(1);
              }}
              className="w-56"
            >
              <option value="">All types</option>
              {POLICY_TYPES.map((t) => (
                <option key={t} value={t}>
                  {policyTypeLabel(t)}
                </option>
              ))}
            </Select>
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-ink-600">Status</span>
            <Select
              value={statusFilter}
              onChange={(e) => {
                setStatusFilter(e.target.value);
                setPage(1);
              }}
              className="w-44"
            >
              <option value="">All statuses</option>
              {["draft", "active", "expired", "lapsed", "cancelled"].map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
          </label>
          <div className="grow" />
          <Button onClick={openCreate}>New policy</Button>
        </CardBody>
      </Card>

      <p className="mb-3 text-xs leading-relaxed text-ink-500">
        Status is shown as the API derives it: a policy whose period has ended reads{" "}
        <strong>expired</strong> whatever the stored status says, because expiry is a fact about the
        period, not a value somebody typed.
      </p>

      <ErrorAlert message={error} />

      {items === null ? (
        <Spinner />
      ) : items.length === 0 ? (
        <EmptyState
          title="No policies in this scope"
          hint="Record the cover in force — its period, its limit and, above all, the claim-notification period the wording imposes."
          action={<Button onClick={openCreate}>Create the first policy</Button>}
        />
      ) : (
        <>
          <Table>
            <thead>
              <tr>
                <Th>No.</Th>
                <Th>Type</Th>
                <Th>Insurer / policy no.</Th>
                <Th>Scope</Th>
                <Th className="text-right">Limit</Th>
                <Th>Period</Th>
                <Th>Expiry</Th>
                <Th>Notification</Th>
                <Th>Status</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {items.map((p) => {
                const companyRow = p as CompanyPolicyRow;
                return (
                  <tr
                    key={p.id}
                    className="cursor-pointer hover:bg-ink-50/60"
                    onClick={() => setSelected({ id: p.id, ownerProjectId: p.projectId })}
                  >
                    <Td className="whitespace-nowrap font-mono text-xs text-ink-500">{p.number}</Td>
                    <Td className="whitespace-nowrap">{policyTypeLabel(p.policyType)}</Td>
                    <Td>
                      <div className="text-sm text-ink-900">{p.insurer}</div>
                      <div className="font-mono text-[11px] text-ink-400">{p.policyNumber}</div>
                    </Td>
                    <Td className="whitespace-nowrap">
                      {p.projectId === null ? (
                        <Badge tone="violet">Company programme</Badge>
                      ) : p.projectId === projectId ? (
                        <Badge tone="blue">This project</Badge>
                      ) : (
                        <span className="text-xs text-ink-500">
                          {companyRow.projectName ?? "Another project"}
                        </span>
                      )}
                    </Td>
                    <Td className="whitespace-nowrap text-right tabular-nums">
                      {p.limitOfIndemnity === null ? (
                        <span
                          className="text-xs text-amber-700"
                          title="No limit of indemnity is recorded, so this policy cannot contribute to any total cover figure."
                        >
                          not recorded
                        </span>
                      ) : (
                        <>
                          {fmtMoney(p.limitOfIndemnity, p.currency, 0)}
                          {p.limitBasis ? (
                            <div className="text-[11px] font-normal text-ink-400">
                              {LIMIT_BASIS_LABELS[p.limitBasis] ?? p.limitBasis}
                            </div>
                          ) : null}
                        </>
                      )}
                    </Td>
                    <Td className="whitespace-nowrap text-xs">
                      {formatDate(p.periodStart)} → {formatDate(p.periodEnd)}
                    </Td>
                    <Td className="whitespace-nowrap">
                      <DeadlineChip days={p.daysToExpiry} />
                      {/*
                        Renewal is measured against a LEAD TIME, not the expiry
                        date: a renewal not started with three weeks left has
                        already failed even though nothing has expired yet.
                      */}
                      {p.renewalStatus && p.renewalStatus !== "bound" &&
                      p.renewalStatus !== "not_renewing" &&
                      p.daysToExpiry <= 120 ? (
                        <div
                          className={`mt-0.5 text-[10px] font-medium ${
                            p.renewalStatus === "not_started" && p.daysToExpiry <= 30
                              ? "text-red-700"
                              : "text-amber-700"
                          }`}
                          title="Renewal pipeline stage. Manage it from the Lines & requirements tab."
                        >
                          renewal: {p.renewalStatus.replace(/_/g, " ")}
                        </div>
                      ) : null}
                      {p.renewalStatus === "bound" && p.renewedByPolicyId ? (
                        <div className="mt-0.5 text-[10px] text-emerald-700">renewal bound</div>
                      ) : null}
                    </Td>
                    <Td className="whitespace-nowrap text-xs">
                      {p.notificationDays === null ? (
                        <span
                          className="font-medium text-amber-700"
                          title="No claim-notification period is recorded. Claims raised under this policy get no computed deadline and no obligation."
                        >
                          none recorded
                        </span>
                      ) : (
                        `${p.notificationDays}d from awareness`
                      )}
                    </Td>
                    <Td className="whitespace-nowrap">
                      <Badge tone={policyTone(p.derivedStatus)}>{p.derivedStatus}</Badge>
                      {p.derivedStatus !== p.status ? (
                        <div
                          className="text-[10px] text-ink-400"
                          title={`Stored status is "${p.status}"; the period ended on ${p.periodEnd}, so the derived status governs.`}
                        >
                          stored: {p.status}
                        </div>
                      ) : null}
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
          <Pager page={page} total={total} pageSize={PAGE_SIZE} noun="policy" onPage={setPage} />
        </>
      )}

      {/* ------------------------------- form modal ------------------------------- */}
      <Modal
        open={formOpen}
        title={editing ? `Edit ${editing.number}` : "New policy"}
        onClose={() => setFormOpen(false)}
        wide
      >
        <ErrorAlert message={formError} />
        {editing && !editable ? (
          <div className="mb-3 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-900 ring-1 ring-amber-200">
            A {editing.status} policy cannot be edited — record an endorsement or a replacement
            policy instead. The API will refuse this save.
          </div>
        ) : null}
        <form onSubmit={onSubmit} className="space-y-4">
          {!editing ? (
            <label className="flex items-start gap-2 rounded-md bg-ink-50 px-3 py-2 text-sm">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={form.companyLevel}
                onChange={(e) => set("companyLevel", e.target.checked)}
              />
              <span>
                <span className="font-medium text-ink-800">Company-level policy</span>
                <span className="block text-xs text-ink-500">
                  A master programme policy carried at company level, covering every project under
                  it. Numbered CPOL-0001 on a company counter rather than POL-0001 per project.
                </span>
              </span>
            </label>
          ) : null}

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field label="Policy type">
              <Select value={form.policyType} onChange={(e) => set("policyType", e.target.value)}>
                {POLICY_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {policyTypeLabel(t)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Insurer">
              <Input
                required
                value={form.insurer}
                onChange={(e) => set("insurer", e.target.value)}
                placeholder="Underwriter or carrier"
              />
            </Field>
            <Field label="Policy number">
              <Input
                required
                value={form.policyNumber}
                onChange={(e) => set("policyNumber", e.target.value)}
              />
            </Field>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field label="Period start">
              <Input
                type="date"
                required
                value={form.periodStart}
                onChange={(e) => set("periodStart", e.target.value)}
              />
            </Field>
            <Field label="Period end">
              <Input
                type="date"
                required
                value={form.periodEnd}
                onChange={(e) => set("periodEnd", e.target.value)}
              />
            </Field>
            <Field
              label="Claim-notification days"
              hint="Days from BECOMING AWARE within which a claim must be notified. Leave blank only if the wording truly imposes none."
            >
              <Input
                type="number"
                min={0}
                max={3650}
                value={form.notificationDays}
                onChange={(e) => set("notificationDays", e.target.value)}
                placeholder="e.g. 30"
              />
            </Field>
          </div>

          {periodInverted ? (
            <div className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-800 ring-1 ring-red-200">
              The period is inverted — the end date falls before the start date. The API will refuse
              this.
            </div>
          ) : null}

          {form.notificationDays === "" ? (
            <div className="rounded-md bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-900 ring-1 ring-amber-200">
              With no notification period recorded, claims raised against this policy carry no
              computed deadline and no obligation — the platform will not be able to tell you when
              notification is due. An unnotified condition precedent is the commonest way a good
              claim is lost.
            </div>
          ) : null}

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
            <Field label="Limit of indemnity">
              <Input
                type="number"
                min={0}
                step="any"
                value={form.limitOfIndemnity}
                onChange={(e) => set("limitOfIndemnity", e.target.value)}
              />
            </Field>
            <Field label="Limit basis" hint="Per occurrence and in the aggregate are materially different cover.">
              <Select value={form.limitBasis} onChange={(e) => set("limitBasis", e.target.value)}>
                <option value="">Not recorded</option>
                {LIMIT_BASES.map((b) => (
                  <option key={b} value={b}>
                    {LIMIT_BASIS_LABELS[b] ?? b}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Currency">
              <Input
                value={form.currency}
                maxLength={3}
                onChange={(e) => set("currency", e.target.value)}
              />
            </Field>
            <Field label="Deductible">
              <Input
                type="number"
                min={0}
                step="any"
                value={form.deductible}
                onChange={(e) => set("deductible", e.target.value)}
              />
            </Field>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field label="Deductible basis">
              <Input
                value={form.deductibleBasis}
                onChange={(e) => set("deductibleBasis", e.target.value)}
                placeholder="each and every claim…"
              />
            </Field>
            <Field label="Broker">
              <Select
                value={form.brokerVendorId}
                onChange={(e) => set("brokerVendorId", e.target.value)}
              >
                <option value="">None recorded</option>
                {vendors.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field
              label="Required by clause"
              hint="The contractual requirement this policy satisfies. Recording it is what lets the platform derive the cover the supply chain must evidence."
            >
              <Input
                value={form.requiredByClause}
                onChange={(e) => set("requiredByClause", e.target.value)}
                placeholder="FIDIC 18.2"
              />
            </Field>
          </div>

          <Field label="Territorial limits">
            <Textarea
              value={form.territorialLimits}
              onChange={(e) => set("territorialLimits", e.target.value)}
              className="min-h-10"
            />
          </Field>

          {/* insured parties */}
          <div>
            <div className="mb-1 flex items-center justify-between">
              <span className="text-xs font-medium text-ink-600">Insured parties</span>
              <Button
                size="sm"
                variant="secondary"
                onClick={() =>
                  set("insuredParties", [...form.insuredParties, { name: "", capacity: "" }])
                }
              >
                Add party
              </Button>
            </div>
            {form.insuredParties.length === 0 ? (
              <p className="text-xs text-ink-400">
                None recorded. A party who is not named is not insured.
              </p>
            ) : (
              <div className="space-y-2">
                {form.insuredParties.map((party, i) => (
                  <div key={i} className="flex gap-2">
                    <Input
                      placeholder="Name"
                      value={party.name}
                      onChange={(e) => {
                        const next = form.insuredParties.slice();
                        next[i] = { ...party, name: e.target.value };
                        set("insuredParties", next);
                      }}
                    />
                    <Input
                      placeholder="Capacity (e.g. principal, sub-contractor)"
                      value={party.capacity ?? ""}
                      onChange={(e) => {
                        const next = form.insuredParties.slice();
                        next[i] = { ...party, capacity: e.target.value };
                        set("insuredParties", next);
                      }}
                    />
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        set(
                          "insuredParties",
                          form.insuredParties.filter((_, j) => j !== i),
                        )
                      }
                    >
                      Remove
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* conditions */}
          <div>
            <div className="mb-1 flex items-center justify-between">
              <span className="text-xs font-medium text-ink-600">
                Conditions — mark the ones that are conditions precedent to liability
              </span>
              <Button
                size="sm"
                variant="secondary"
                onClick={() =>
                  set("conditions", [
                    ...form.conditions,
                    { ref: "", text: "", isConditionPrecedent: false },
                  ])
                }
              >
                Add condition
              </Button>
            </div>
            {form.conditions.length === 0 ? (
              <p className="text-xs text-ink-400">
                None recorded. A condition precedent breached is cover lost, so the ones that carry
                that consequence are worth typing out.
              </p>
            ) : (
              <div className="space-y-2">
                {form.conditions.map((c, i) => (
                  <div key={i} className="rounded-md bg-ink-50 p-2">
                    <div className="flex gap-2">
                      <Input
                        className="w-40"
                        placeholder="Ref"
                        value={c.ref}
                        onChange={(e) => {
                          const next = form.conditions.slice();
                          next[i] = { ...c, ref: e.target.value };
                          set("conditions", next);
                        }}
                      />
                      <Input
                        placeholder="Condition text"
                        value={c.text}
                        onChange={(e) => {
                          const next = form.conditions.slice();
                          next[i] = { ...c, text: e.target.value };
                          set("conditions", next);
                        }}
                      />
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          set(
                            "conditions",
                            form.conditions.filter((_, j) => j !== i),
                          )
                        }
                      >
                        Remove
                      </Button>
                    </div>
                    <label className="mt-1 flex items-center gap-2 text-xs text-ink-700">
                      <input
                        type="checkbox"
                        checked={c.isConditionPrecedent === true}
                        onChange={(e) => {
                          const next = form.conditions.slice();
                          next[i] = { ...c, isConditionPrecedent: e.target.checked };
                          set("conditions", next);
                        }}
                      />
                      Condition precedent to liability — breach of it defeats the claim outright
                    </label>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setFormOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Saving…" : editing ? "Save changes" : "Create policy"}
            </Button>
          </div>
        </form>
      </Modal>

      {/* --------------------------------- drawer --------------------------------- */}
      {selected ? (
        <PolicyDrawer
          projectId={projectId}
          policyId={selected.id}
          ownerProjectId={selected.ownerProjectId}
          onClose={() => setSelected(null)}
          onChanged={() => void load()}
          onEdit={(p) => {
            setSelected(null);
            openEdit(p);
          }}
        />
      ) : null}
    </div>
  );
}

/* ------------------------------ JSON coercion ------------------------------ */

function parseParties(raw: unknown): InsuredParty[] {
  if (!Array.isArray(raw)) return [];
  const out: InsuredParty[] = [];
  for (const e of raw) {
    if (!e || typeof e !== "object") continue;
    const o = e as Record<string, unknown>;
    out.push({
      name: typeof o["name"] === "string" ? o["name"] : "",
      capacity: typeof o["capacity"] === "string" ? o["capacity"] : "",
      vendorId: typeof o["vendorId"] === "string" ? o["vendorId"] : null,
    });
  }
  return out;
}

function parseConds(raw: unknown): PolicyCondition[] {
  if (!Array.isArray(raw)) return [];
  const out: PolicyCondition[] = [];
  for (const e of raw) {
    if (!e || typeof e !== "object") continue;
    const o = e as Record<string, unknown>;
    out.push({
      ref: typeof o["ref"] === "string" ? o["ref"] : "",
      text: typeof o["text"] === "string" ? o["text"] : "",
      isConditionPrecedent: o["isConditionPrecedent"] === true,
    });
  }
  return out;
}
