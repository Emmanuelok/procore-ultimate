/**
 * Bonds (#790-794) — security, and the date it stops being security.
 *
 * The column that matters most in this register is the demand deadline, not
 * the expiry date. Many bonds die weeks before they expire: after the demand
 * deadline a compliant demand buys nothing at all, and the API refuses to
 * record one as though it were live.
 */
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { BOND_TYPES } from "@constructos/shared";
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
  Th,
} from "../../ui";
import { formatDate } from "../format";
import BondDrawer from "./BondDrawer";
import {
  DeadlineChip,
  Pager,
  bondTone,
  bondTypeLabel,
  errMsg,
  fmtMoney,
  fmtPct,
  type BondRow,
  type FocusRequest,
  type ListResponse,
  type ReductionStep,
  type VendorLite,
} from "./insuranceShared";

const PAGE_SIZE = 25;

export default function BondsTab({
  projectId,
  focus,
}: {
  projectId: string;
  focus: FocusRequest | null;
}) {
  const base = `/api/v1/projects/${projectId}`;

  const [typeFilter, setTypeFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [page, setPage] = useState(1);
  const [items, setItems] = useState<BondRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [vendors, setVendors] = useState<VendorLite[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
      if (typeFilter) params.set("bondType", typeFilter);
      if (statusFilter) params.set("status", statusFilter);
      const res = await api.get<ListResponse<BondRow>>(`${base}/insurance/bonds?${params}`);
      setItems(res.items);
      setTotal(res.total);
    } catch (err) {
      setItems([]);
      setError(errMsg(err, "Failed to load bonds"));
    }
  }, [base, page, statusFilter, typeFilter]);

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
        // picker degrades
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (focus?.recordId) setSelectedId(focus.recordId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus]);

  /* -------------------------------- create -------------------------------- */

  const [createOpen, setCreateOpen] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    bondType: "performance",
    guarantor: "",
    bondNumber: "",
    principalVendorId: "",
    beneficiary: "",
    amount: "",
    currency: "GBP",
    percentOfContract: "",
    isOnDemand: false,
    issuedAt: "",
    expiryAt: "",
    demandDeadline: "",
  });
  const [steps, setSteps] = useState<ReductionStep[]>([]);

  function openCreate() {
    setCreateError(null);
    setForm({
      bondType: "performance",
      guarantor: "",
      bondNumber: "",
      principalVendorId: "",
      beneficiary: "",
      amount: "",
      currency: "GBP",
      percentOfContract: "",
      isOnDemand: false,
      issuedAt: "",
      expiryAt: "",
      demandDeadline: "",
    });
    setSteps([]);
    setCreateOpen(true);
  }

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setCreateError(null);
    setBusy(true);
    try {
      const payload: Record<string, unknown> = {
        bondType: form.bondType,
        guarantor: form.guarantor.trim(),
        amount: Number(form.amount),
        currency: form.currency.trim().toUpperCase() || "GBP",
        isOnDemand: form.isOnDemand,
        bondNumber: form.bondNumber.trim() || null,
        principalVendorId: form.principalVendorId || null,
        beneficiary: form.beneficiary.trim() || null,
        percentOfContract: form.percentOfContract === "" ? null : Number(form.percentOfContract),
        issuedAt: form.issuedAt || null,
        expiryAt: form.expiryAt || null,
        demandDeadline: form.demandDeadline || null,
        reductionSchedule: steps
          .filter((s) => s.trigger.trim())
          .map((s) => ({
            trigger: s.trigger.trim(),
            reducesToPercent: Number(s.reducesToPercent),
            occurredAt: s.occurredAt || null,
          })),
      };
      const created = await api.post<BondRow>(`${base}/insurance/bonds`, payload);
      setCreateOpen(false);
      setPage(1);
      await load();
      setSelectedId(created.id);
    } catch (err) {
      setCreateError(errMsg(err, "Failed to create the bond"));
    } finally {
      setBusy(false);
    }
  }

  const deadlineAfterExpiry =
    form.expiryAt !== "" && form.demandDeadline !== "" && form.demandDeadline > form.expiryAt;

  return (
    <div>
      <Card className="mb-4">
        <CardBody className="flex flex-wrap items-end gap-3 py-3">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-ink-600">Bond type</span>
            <Select
              value={typeFilter}
              onChange={(e) => {
                setTypeFilter(e.target.value);
                setPage(1);
              }}
              className="w-56"
            >
              <option value="">All types</option>
              {BOND_TYPES.map((t) => (
                <option key={t} value={t}>
                  {bondTypeLabel(t)}
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
              {["draft", "issued", "active", "called", "released", "expired"].map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
          </label>
          <div className="grow" />
          <Button onClick={openCreate}>New bond</Button>
        </CardBody>
      </Card>

      <ErrorAlert message={error} />

      {items === null ? (
        <Spinner />
      ) : items.length === 0 ? (
        <EmptyState
          title="No bonds recorded"
          hint="Record the security held or given, its reduction milestones and — above all — the last date a demand can be made under it."
          action={<Button onClick={openCreate}>Create the first bond</Button>}
        />
      ) : (
        <>
          <Table>
            <thead>
              <tr>
                <Th>No.</Th>
                <Th>Type</Th>
                <Th>Guarantor</Th>
                <Th className="text-right">Exposure</Th>
                <Th>Demand deadline</Th>
                <Th>Expiry</Th>
                <Th>Basis</Th>
                <Th>Status</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {items.map((b) => {
                const dead =
                  b.daysToDemandDeadline !== null &&
                  b.daysToDemandDeadline < 0 &&
                  ["issued", "active"].includes(b.status);
                return (
                  <tr
                    key={b.id}
                    className={`cursor-pointer hover:bg-ink-50/60 ${dead ? "bg-red-50/60" : ""}`}
                    onClick={() => setSelectedId(b.id)}
                  >
                    <Td className="whitespace-nowrap font-mono text-xs text-ink-500">{b.number}</Td>
                    <Td className="whitespace-nowrap">{bondTypeLabel(b.bondType)}</Td>
                    <Td>
                      <div className="text-sm text-ink-900">{b.guarantor}</div>
                      {b.bondNumber ? (
                        <div className="font-mono text-[11px] text-ink-400">{b.bondNumber}</div>
                      ) : null}
                    </Td>
                    <Td className="whitespace-nowrap text-right tabular-nums">
                      <div className="font-medium">
                        {fmtMoney(b.exposure.currentAmount, b.currency, 0)}
                      </div>
                      {b.exposure.appliedPercent < 100 ? (
                        <div className="text-[11px] text-ink-400">
                          {fmtPct(b.exposure.appliedPercent, 0)} of face{" "}
                          {fmtMoney(b.exposure.faceAmount, b.currency, 0)}
                        </div>
                      ) : (
                        <div className="text-[11px] text-ink-400">face value, no reduction applied</div>
                      )}
                      {b.exposure.unparsableSteps > 0 ? (
                        <div
                          className="text-[11px] font-medium text-amber-700"
                          title="Entries in the reduction schedule that are not a usable reduction step. They are reported, never silently ignored — the current value may not be the whole story."
                        >
                          {b.exposure.unparsableSteps} unparsable step(s)
                        </div>
                      ) : null}
                    </Td>
                    <Td className="whitespace-nowrap">
                      {b.demandDeadline ? (
                        <div>
                          <div className="text-xs text-ink-600">
                            {formatDate(b.demandDeadline)}
                          </div>
                          <DeadlineChip days={b.daysToDemandDeadline} fatal />
                        </div>
                      ) : (
                        <span
                          className="text-xs text-amber-700"
                          title="No demand deadline is recorded, so the platform cannot tell you when the right to demand ends. Read the bond wording."
                        >
                          not recorded
                        </span>
                      )}
                    </Td>
                    <Td className="whitespace-nowrap text-xs">
                      {b.expiryAt ? formatDate(b.expiryAt) : <span className="text-ink-400">—</span>}
                    </Td>
                    <Td className="whitespace-nowrap">
                      {b.isOnDemand === 1 ? (
                        <Badge tone="red">on demand</Badge>
                      ) : (
                        <Badge tone="gray">conditional</Badge>
                      )}
                    </Td>
                    <Td className="whitespace-nowrap">
                      <Badge tone={bondTone(b.status)}>{b.status}</Badge>
                      {dead ? (
                        <div className="mt-0.5 rounded bg-red-900 px-1.5 py-0.5 text-center text-[10px] font-bold uppercase tracking-wide text-red-50">
                          not callable
                        </div>
                      ) : null}
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
          <Pager page={page} total={total} pageSize={PAGE_SIZE} noun="bond" onPage={setPage} />
        </>
      )}

      {/* ------------------------------ create modal ------------------------------ */}
      <Modal open={createOpen} title="New bond" onClose={() => setCreateOpen(false)} wide>
        <ErrorAlert message={createError} />
        <form onSubmit={onCreate} className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field label="Bond type">
              <Select
                value={form.bondType}
                onChange={(e) => setForm({ ...form, bondType: e.target.value })}
              >
                {BOND_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {bondTypeLabel(t)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Guarantor" hint="The surety or bank standing behind the bond.">
              <Input
                required
                value={form.guarantor}
                onChange={(e) => setForm({ ...form, guarantor: e.target.value })}
              />
            </Field>
            <Field label="Bond number">
              <Input
                value={form.bondNumber}
                onChange={(e) => setForm({ ...form, bondNumber: e.target.value })}
              />
            </Field>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
            <Field label="Amount">
              <Input
                type="number"
                min={0}
                step="any"
                required
                value={form.amount}
                onChange={(e) => setForm({ ...form, amount: e.target.value })}
              />
            </Field>
            <Field label="Currency">
              <Input
                maxLength={3}
                value={form.currency}
                onChange={(e) => setForm({ ...form, currency: e.target.value })}
              />
            </Field>
            <Field label="Percent of contract">
              <Input
                type="number"
                min={0}
                max={100}
                step="any"
                value={form.percentOfContract}
                onChange={(e) => setForm({ ...form, percentOfContract: e.target.value })}
              />
            </Field>
            <Field label="Principal">
              <Select
                value={form.principalVendorId}
                onChange={(e) => setForm({ ...form, principalVendorId: e.target.value })}
              >
                <option value="">Not linked</option>
                {vendors.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field label="Issued at" hint="Required before the bond can be marked issued.">
              <Input
                type="date"
                value={form.issuedAt}
                onChange={(e) => setForm({ ...form, issuedAt: e.target.value })}
              />
            </Field>
            <Field label="Expiry">
              <Input
                type="date"
                value={form.expiryAt}
                onChange={(e) => setForm({ ...form, expiryAt: e.target.value })}
              />
            </Field>
            <Field
              label="Demand deadline"
              hint="The last date a demand can be made. Often before expiry — and it is the date that kills the security."
            >
              <Input
                type="date"
                value={form.demandDeadline}
                onChange={(e) => setForm({ ...form, demandDeadline: e.target.value })}
              />
            </Field>
          </div>

          {deadlineAfterExpiry ? (
            <div className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-800 ring-1 ring-red-200">
              The demand deadline falls after the expiry date — a demand cannot be made after the
              bond has expired, and the API will refuse this.
            </div>
          ) : null}

          {form.demandDeadline === "" ? (
            <div className="rounded-md bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-900 ring-1 ring-amber-200">
              With no demand deadline recorded, nothing here can warn you when the right to demand
              ends. The bond wording will have one; read it and record it.
            </div>
          ) : null}

          <Field label="Beneficiary">
            <Input
              value={form.beneficiary}
              onChange={(e) => setForm({ ...form, beneficiary: e.target.value })}
            />
          </Field>

          <label className="flex items-start gap-2 rounded-md bg-ink-50 px-3 py-2 text-sm">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={form.isOnDemand}
              onChange={(e) => setForm({ ...form, isOnDemand: e.target.checked })}
            />
            <span>
              <span className="font-medium text-ink-800">On-demand bond</span>
              <span className="block text-xs text-ink-500">
                An on-demand bond pays against a compliant demand. A conditional bond does not: the
                guarantor pays only against proof of the principal's default, and the API refuses a
                demand under one unless evidence is recorded with it.
              </span>
            </span>
          </label>

          {/* reduction schedule */}
          <div>
            <div className="mb-1 flex items-center justify-between">
              <span className="text-xs font-medium text-ink-600">
                Reduction schedule — milestones that step the bond down
              </span>
              <Button
                size="sm"
                variant="secondary"
                onClick={() =>
                  setSteps([...steps, { trigger: "", reducesToPercent: 50, occurredAt: null }])
                }
              >
                Add step
              </Button>
            </div>
            {steps.length === 0 ? (
              <p className="text-xs text-ink-400">
                None. The bond stays at face value until it is released or expires.
              </p>
            ) : (
              <div className="space-y-2">
                {steps.map((s, i) => (
                  <div key={i} className="flex flex-wrap items-end gap-2">
                    <Input
                      className="w-64"
                      placeholder="Trigger (e.g. practical completion)"
                      value={s.trigger}
                      onChange={(e) => {
                        const next = steps.slice();
                        next[i] = { ...s, trigger: e.target.value };
                        setSteps(next);
                      }}
                    />
                    <Input
                      className="w-28"
                      type="number"
                      min={0}
                      max={100}
                      step="any"
                      value={s.reducesToPercent}
                      onChange={(e) => {
                        const next = steps.slice();
                        next[i] = { ...s, reducesToPercent: Number(e.target.value) };
                        setSteps(next);
                      }}
                    />
                    <span className="pb-2 text-xs text-ink-500">% of face</span>
                    <Input
                      className="w-40"
                      type="date"
                      value={s.occurredAt ?? ""}
                      onChange={(e) => {
                        const next = steps.slice();
                        next[i] = { ...s, occurredAt: e.target.value || null };
                        setSteps(next);
                      }}
                    />
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setSteps(steps.filter((_, j) => j !== i))}
                    >
                      Remove
                    </Button>
                  </div>
                ))}
                <p className="text-xs text-ink-500">
                  A step bites only once its trigger is recorded as having occurred. Leave the date
                  blank for a milestone that has not happened yet and record it later.
                </p>
              </div>
            )}
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Creating…" : "Create bond"}
            </Button>
          </div>
        </form>
      </Modal>

      {selectedId ? (
        <BondDrawer
          projectId={projectId}
          bondId={selectedId}
          vendors={vendors}
          onClose={() => setSelectedId(null)}
          onChanged={() => void load()}
        />
      ) : null}
    </div>
  );
}
