/**
 * Bond detail — exposure, the reduction ladder, and the demand.
 *
 * The demand is the only irreversible act in this workspace: a successful call
 * flips the bond to `called` and there is no un-call, so it is confirmed
 * explicitly. The refusal that matters most is the one nobody expects — a
 * demand made after the deadline — and when the API returns it, its numbers
 * (deadline, demand date, days late) are printed as loudly as the message.
 */
import { useCallback, useEffect, useState } from "react";
import { api } from "../../lib/api";
import { Badge, Button, ErrorAlert, Field, Input, Select, Spinner, Textarea } from "../../ui";
import { formatDate, formatDateTime } from "../format";
import {
  BOND_CALL_OUTCOMES,
  BOND_CALL_OUTCOME_LABELS,
  BOND_STATUS_TRANSITIONS,
  CHART,
  Caveat,
  ConfirmStrip,
  DeadlineChip,
  DetailRow,
  Disclosure,
  Drawer,
  SectionTitle,
  bondTone,
  bondTypeLabel,
  callOutcomeTone,
  daysWord,
  errMsg,
  fmtMoney,
  fmtPct,
  outOfTimeDetails,
  todayIso,
  type BondCallResult,
  type BondCallRow,
  type BondDetail,
  type OutOfTimeDetails,
  type VendorLite,
} from "./insuranceShared";

export default function BondDrawer({
  projectId,
  bondId,
  vendors,
  onClose,
  onChanged,
}: {
  projectId: string;
  bondId: string;
  vendors: VendorLite[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const base = `/api/v1/projects/${projectId}/insurance/bonds/${bondId}`;

  const [bond, setBond] = useState<BondDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setBond(await api.get<BondDetail>(base));
    } catch (err) {
      setBond(null);
      setError(errMsg(err, "Failed to load the bond"));
    }
  }, [base]);

  useEffect(() => {
    void load();
  }, [load]);

  /* ------------------------------- transitions ------------------------------- */

  const [target, setTarget] = useState("");

  async function onTransition() {
    if (!target) return;
    setBusy(true);
    setActionError(null);
    try {
      await api.post(`${base}/status`, { status: target });
      setTarget("");
      await load();
      onChanged();
    } catch (err) {
      setActionError(errMsg(err, "The transition was refused"));
    } finally {
      setBusy(false);
    }
  }

  /* --------------------------------- reduce --------------------------------- */

  const [reduceTrigger, setReduceTrigger] = useState<string | null>(null);
  const [reduceDate, setReduceDate] = useState(todayIso());
  const [reduceError, setReduceError] = useState<string | null>(null);

  async function onReduce() {
    if (!reduceTrigger) return;
    setBusy(true);
    setReduceError(null);
    try {
      const body: Record<string, unknown> = { trigger: reduceTrigger };
      if (reduceDate) body["occurredAt"] = reduceDate;
      await api.post(`${base}/reduce`, body);
      setReduceTrigger(null);
      await load();
      onChanged();
    } catch (err) {
      setReduceError(errMsg(err, "The reduction was refused"));
    } finally {
      setBusy(false);
    }
  }

  /* ---------------------------------- call ---------------------------------- */

  const [callOpen, setCallOpen] = useState(false);
  const [callAmount, setCallAmount] = useState("");
  const [callReason, setCallReason] = useState("");
  const [callDate, setCallDate] = useState(todayIso());
  const [evidence, setEvidence] = useState<{ key: string; value: string }[]>([]);
  const [callConfirm, setCallConfirm] = useState(false);
  const [callError, setCallError] = useState<string | null>(null);
  const [outOfTime, setOutOfTime] = useState<OutOfTimeDetails | null>(null);
  const [callResult, setCallResult] = useState<BondCallResult | null>(null);

  function openCall() {
    if (!bond) return;
    setCallAmount(String(bond.exposure.currentAmount));
    setCallReason("");
    setCallDate(todayIso());
    setEvidence([]);
    setCallConfirm(false);
    setCallError(null);
    setOutOfTime(null);
    setCallResult(null);
    setCallOpen(true);
  }

  async function onCall() {
    if (!bond) return;
    setBusy(true);
    setCallError(null);
    setOutOfTime(null);
    try {
      const refs: Record<string, unknown> = {};
      for (const row of evidence) {
        if (row.key.trim()) refs[row.key.trim()] = row.value;
      }
      const body: Record<string, unknown> = {
        amount: Number(callAmount),
        reason: callReason.trim(),
        calledAt: callDate,
      };
      if (Object.keys(refs).length > 0) body["evidenceRefs"] = refs;
      const res = await api.post<BondCallResult>(`${base}/call`, body);
      setCallResult(res);
      setCallOpen(false);
      setCallConfirm(false);
      await load();
      onChanged();
    } catch (err) {
      const details = outOfTimeDetails(err);
      if (details) setOutOfTime(details);
      setCallError(errMsg(err, "The demand was refused"));
      setCallConfirm(false);
    } finally {
      setBusy(false);
    }
  }

  /* --------------------------------- release -------------------------------- */

  const [releaseOpen, setReleaseOpen] = useState(false);
  const [releaseDate, setReleaseDate] = useState(todayIso());
  const [releaseReason, setReleaseReason] = useState("");
  const [releaseError, setReleaseError] = useState<string | null>(null);

  async function onRelease() {
    setBusy(true);
    setReleaseError(null);
    try {
      const body: Record<string, unknown> = {};
      if (releaseDate) body["releasedAt"] = releaseDate;
      if (releaseReason.trim()) body["reason"] = releaseReason.trim();
      await api.post(`${base}/release`, body);
      setReleaseOpen(false);
      await load();
      onChanged();
    } catch (err) {
      setReleaseError(errMsg(err, "The release was refused"));
    } finally {
      setBusy(false);
    }
  }

  /* ---------------------------------- edit ---------------------------------- */

  const [editOpen, setEditOpen] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [edit, setEdit] = useState({
    guarantor: "",
    bondNumber: "",
    beneficiary: "",
    amount: "",
    currency: "",
    percentOfContract: "",
    isOnDemand: false,
    issuedAt: "",
    expiryAt: "",
    demandDeadline: "",
  });

  function openEdit() {
    if (!bond) return;
    setEdit({
      guarantor: bond.guarantor,
      bondNumber: bond.bondNumber ?? "",
      beneficiary: bond.beneficiary ?? "",
      amount: String(bond.amount),
      currency: bond.currency,
      percentOfContract: bond.percentOfContract === null ? "" : String(bond.percentOfContract),
      isOnDemand: bond.isOnDemand === 1,
      issuedAt: bond.issuedAt ?? "",
      expiryAt: bond.expiryAt ?? "",
      demandDeadline: bond.demandDeadline ?? "",
    });
    setEditError(null);
    setEditOpen(true);
  }

  async function onSaveEdit() {
    setBusy(true);
    setEditError(null);
    try {
      await api.patch(base, {
        guarantor: edit.guarantor.trim(),
        bondNumber: edit.bondNumber.trim() || null,
        beneficiary: edit.beneficiary.trim() || null,
        amount: Number(edit.amount),
        currency: edit.currency.trim().toUpperCase(),
        percentOfContract: edit.percentOfContract === "" ? null : Number(edit.percentOfContract),
        isOnDemand: edit.isOnDemand,
        issuedAt: edit.issuedAt || null,
        expiryAt: edit.expiryAt || null,
        demandDeadline: edit.demandDeadline || null,
      });
      setEditOpen(false);
      await load();
      onChanged();
    } catch (err) {
      setEditError(errMsg(err, "Failed to save the bond"));
    } finally {
      setBusy(false);
    }
  }

  /* --------------------------------- delete --------------------------------- */

  const [confirmDelete, setConfirmDelete] = useState(false);

  async function onDelete() {
    setBusy(true);
    setActionError(null);
    try {
      await api.del(base);
      onChanged();
      onClose();
    } catch (err) {
      setConfirmDelete(false);
      setActionError(errMsg(err, "The bond could not be deleted"));
    } finally {
      setBusy(false);
    }
  }

  /* ------------------------------ call outcomes ------------------------------ */

  const [outcomeFor, setOutcomeFor] = useState<string | null>(null);
  const [outcome, setOutcome] = useState("pending");
  const [proceedsAmount, setProceedsAmount] = useState("");
  const [proceedsAt, setProceedsAt] = useState("");
  const [outcomeError, setOutcomeError] = useState<string | null>(null);

  function openOutcome(call: BondCallRow) {
    setOutcomeFor(call.id);
    setOutcome(call.outcome ?? "pending");
    setProceedsAmount(call.proceedsAmount === null ? "" : String(call.proceedsAmount));
    setProceedsAt(call.proceedsReceivedAt ?? "");
    setOutcomeError(null);
  }

  const proceedsRequired = outcome === "paid" || outcome === "partially_paid";

  async function onSaveOutcome() {
    if (!outcomeFor) return;
    setBusy(true);
    setOutcomeError(null);
    try {
      const body: Record<string, unknown> = { outcome };
      if (proceedsRequired) {
        body["proceedsAmount"] = Number(proceedsAmount);
        body["proceedsReceivedAt"] = proceedsAt;
      }
      await api.post(
        `/api/v1/projects/${projectId}/insurance/bond-calls/${outcomeFor}/outcome`,
        body,
      );
      setOutcomeFor(null);
      await load();
      onChanged();
    } catch (err) {
      setOutcomeError(errMsg(err, "The outcome could not be recorded"));
    } finally {
      setBusy(false);
    }
  }

  /* --------------------------------- render --------------------------------- */

  const allowed = bond ? (BOND_STATUS_TRANSITIONS[bond.status] ?? []) : [];
  const callable = bond ? ["issued", "active"].includes(bond.status) : false;
  const deadlinePassed =
    bond !== null && bond.daysToDemandDeadline !== null && bond.daysToDemandDeadline < 0;
  const callDateDaysBefore =
    bond?.demandDeadline && callDate
      ? Math.round(
          (Date.parse(`${bond.demandDeadline}T00:00:00Z`) - Date.parse(`${callDate}T00:00:00Z`)) /
            86_400_000,
        )
      : null;
  const amountOverCurrent =
    bond !== null && callAmount !== "" && Number(callAmount) > bond.exposure.currentAmount;
  const conditionalNoEvidence =
    bond !== null && bond.isOnDemand === 0 && evidence.every((e) => !e.key.trim());

  return (
    <Drawer
      open
      wide
      onClose={onClose}
      title={
        bond ? (
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-sm text-ink-500">{bond.number}</span>
            <span>{bondTypeLabel(bond.bondType)}</span>
            <Badge tone={bondTone(bond.status)}>{bond.status}</Badge>
            {bond.isOnDemand === 1 ? (
              <Badge tone="red">on demand</Badge>
            ) : (
              <Badge tone="gray">conditional</Badge>
            )}
          </span>
        ) : (
          "Bond"
        )
      }
    >
      <ErrorAlert message={error} />
      {bond === null ? (
        error ? null : (
          <Spinner />
        )
      ) : (
        <div>
          {/* ---------------------------- demand deadline ---------------------------- */}
          {bond.demandDeadline === null ? (
            <Caveat>
              <strong>No demand deadline recorded.</strong> Nothing here can warn you when the right
              to demand ends, and the API cannot refuse a late demand it does not know about. The
              bond wording will state one — read it and record it.
            </Caveat>
          ) : deadlinePassed && callable ? (
            <div className="rounded-md border-l-4 border-red-700 bg-red-900 px-4 py-3 text-red-50">
              <div className="text-sm font-bold uppercase tracking-wide">
                Demand deadline passed {daysWord(bond.daysToDemandDeadline ?? 0)} ago
              </div>
              <p className="mt-1 text-xs leading-relaxed text-red-100">
                The last date for making a demand under this bond was{" "}
                {formatDate(bond.demandDeadline)}. A demand made now will not be honoured, and the
                API refuses to record one as though it were live. The{" "}
                {fmtMoney(bond.exposure.currentAmount, bond.currency)} of security this bond
                represented is gone. Pursue the principal directly and record the missed deadline as
                a loss.
              </p>
            </div>
          ) : (
            <div className="rounded-lg border-l-4 border-l-brand-500 bg-white p-3 shadow-sm ring-1 ring-ink-100">
              <div className="flex flex-wrap items-center gap-3">
                <span className="text-xs font-semibold uppercase tracking-wide text-ink-500">
                  Last date for a demand
                </span>
                <span className="text-sm font-medium text-ink-900">
                  {formatDate(bond.demandDeadline)}
                </span>
                <DeadlineChip days={bond.daysToDemandDeadline} fatal />
                {bond.expiryAt ? (
                  <span className="text-xs text-ink-500">
                    (bond expires {formatDate(bond.expiryAt)})
                  </span>
                ) : null}
              </div>
              <p className="mt-1 text-xs leading-relaxed text-ink-500">
                Demand still possible:{" "}
                <strong>
                  {bond.demandStillPossible === null
                    ? "unknown — no deadline recorded"
                    : bond.demandStillPossible
                      ? "yes"
                      : "no"}
                </strong>
                . A demand one day late buys nothing, whatever the merits of the underlying claim.
              </p>
            </div>
          )}

          {/* -------------------------------- exposure -------------------------------- */}
          <SectionTitle hint="Reductions step down, they do not stack: the lowest triggered percentage governs.">
            Exposure
          </SectionTitle>
          <ExposureBar
            face={bond.exposure.faceAmount}
            current={bond.exposure.currentAmount}
            percent={bond.exposure.appliedPercent}
            currency={bond.currency}
          />
          {bond.exposure.unparsableSteps > 0 ? (
            <div className="mt-2">
              <Disclosure label="unparsableSteps" tone="amber">
                {bond.exposure.unparsableSteps} entr
                {bond.exposure.unparsableSteps === 1 ? "y" : "ies"} in this bond's reduction
                schedule could not be read as a reduction step and had no effect on the figures
                above. They are reported rather than dropped: the current value may not be the whole
                story.
              </Disclosure>
            </div>
          ) : null}

          {/* --------------------------- reduction schedule --------------------------- */}
          <SectionTitle>Reduction schedule</SectionTitle>
          <ErrorAlert message={reduceError} />
          {bond.exposure.applied.length === 0 && bond.exposure.pending.length === 0 ? (
            <p className="text-sm text-ink-400">
              None recorded — the bond stays at face value until released or expired.
            </p>
          ) : (
            <div className="space-y-1.5">
              {bond.exposure.applied.map((s, i) => (
                <div
                  key={`a-${i}`}
                  className="flex flex-wrap items-center gap-2 rounded-md bg-emerald-50 px-2 py-1.5 text-sm ring-1 ring-emerald-100"
                >
                  <Badge tone="green">applied</Badge>
                  <span className="grow font-medium text-ink-900">{s.trigger}</span>
                  <span className="tabular-nums text-ink-700">
                    reduces to {fmtPct(s.reducesToPercent, 0)}
                  </span>
                  <span className="text-xs text-ink-500">
                    occurred {formatDate(s.occurredAt)}
                  </span>
                </div>
              ))}
              {bond.exposure.pending.map((s, i) => (
                <div
                  key={`p-${i}`}
                  className="rounded-md bg-ink-50 px-2 py-1.5 text-sm ring-1 ring-ink-100"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone="gray">pending</Badge>
                    <span className="grow font-medium text-ink-900">{s.trigger}</span>
                    <span className="tabular-nums text-ink-700">
                      would reduce to {fmtPct(s.reducesToPercent, 0)}
                    </span>
                    {["issued", "active"].includes(bond.status) ? (
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => {
                          setReduceTrigger(s.trigger);
                          setReduceDate(todayIso());
                        }}
                      >
                        Record occurrence
                      </Button>
                    ) : null}
                  </div>
                  {reduceTrigger === s.trigger ? (
                    <div className="mt-2 flex flex-wrap items-end gap-2">
                      <Field label="Occurred at">
                        <Input
                          type="date"
                          value={reduceDate}
                          onChange={(e) => setReduceDate(e.target.value)}
                        />
                      </Field>
                      <Button disabled={busy} onClick={() => void onReduce()}>
                        {busy ? "Working…" : "Apply reduction"}
                      </Button>
                      <Button variant="secondary" onClick={() => setReduceTrigger(null)}>
                        Cancel
                      </Button>
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          )}

          {/* --------------------------------- details --------------------------------- */}
          <SectionTitle>Bond</SectionTitle>
          <div>
            <DetailRow label="Guarantor">{bond.guarantor}</DetailRow>
            <DetailRow label="Bond number">
              {bond.bondNumber ?? <span className="text-ink-400">Not recorded</span>}
            </DetailRow>
            <DetailRow label="Principal">
              {bond.principalVendorId ? (
                (vendors.find((v) => v.id === bond.principalVendorId)?.name ??
                bond.principalVendorId)
              ) : (
                <span className="text-ink-400">Not linked</span>
              )}
            </DetailRow>
            <DetailRow label="Beneficiary">
              {bond.beneficiary ?? <span className="text-ink-400">Not recorded</span>}
            </DetailRow>
            <DetailRow label="Face amount">{fmtMoney(bond.amount, bond.currency)}</DetailRow>
            <DetailRow label="Percent of contract">
              {bond.percentOfContract === null ? (
                <span className="text-ink-400">Not recorded</span>
              ) : (
                fmtPct(bond.percentOfContract)
              )}
            </DetailRow>
            <DetailRow label="Basis">
              {bond.isOnDemand === 1
                ? "On demand — the guarantor pays against a compliant demand"
                : "Conditional — the guarantor pays only against proof of the principal's default"}
            </DetailRow>
            <DetailRow label="Issued at">
              {bond.issuedAt ? formatDate(bond.issuedAt) : <span className="text-ink-400">—</span>}
            </DetailRow>
            <DetailRow label="Expiry">
              {bond.expiryAt ? formatDate(bond.expiryAt) : <span className="text-ink-400">—</span>}
            </DetailRow>
            {bond.releasedAt ? (
              <DetailRow label="Released at">{formatDate(bond.releasedAt)}</DetailRow>
            ) : null}
          </div>

          {["draft", "issued", "active"].includes(bond.status) ? (
            editOpen ? (
              <div className="mt-3 space-y-3 rounded-lg bg-ink-50 p-3">
                <ErrorAlert message={editError} />
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <Field label="Guarantor">
                    <Input
                      value={edit.guarantor}
                      onChange={(e) => setEdit({ ...edit, guarantor: e.target.value })}
                    />
                  </Field>
                  <Field label="Bond number">
                    <Input
                      value={edit.bondNumber}
                      onChange={(e) => setEdit({ ...edit, bondNumber: e.target.value })}
                    />
                  </Field>
                  <Field label="Beneficiary">
                    <Input
                      value={edit.beneficiary}
                      onChange={(e) => setEdit({ ...edit, beneficiary: e.target.value })}
                    />
                  </Field>
                  <Field label="Amount">
                    <Input
                      type="number"
                      min={0}
                      step="any"
                      value={edit.amount}
                      onChange={(e) => setEdit({ ...edit, amount: e.target.value })}
                    />
                  </Field>
                  <Field label="Currency">
                    <Input
                      maxLength={3}
                      value={edit.currency}
                      onChange={(e) => setEdit({ ...edit, currency: e.target.value })}
                    />
                  </Field>
                  <Field label="Percent of contract">
                    <Input
                      type="number"
                      min={0}
                      max={100}
                      step="any"
                      value={edit.percentOfContract}
                      onChange={(e) => setEdit({ ...edit, percentOfContract: e.target.value })}
                    />
                  </Field>
                  <Field label="Issued at">
                    <Input
                      type="date"
                      value={edit.issuedAt}
                      onChange={(e) => setEdit({ ...edit, issuedAt: e.target.value })}
                    />
                  </Field>
                  <Field label="Expiry">
                    <Input
                      type="date"
                      value={edit.expiryAt}
                      onChange={(e) => setEdit({ ...edit, expiryAt: e.target.value })}
                    />
                  </Field>
                  <Field label="Demand deadline">
                    <Input
                      type="date"
                      value={edit.demandDeadline}
                      onChange={(e) => setEdit({ ...edit, demandDeadline: e.target.value })}
                    />
                  </Field>
                </div>
                <label className="flex items-center gap-2 text-sm text-ink-700">
                  <input
                    type="checkbox"
                    checked={edit.isOnDemand}
                    onChange={(e) => setEdit({ ...edit, isOnDemand: e.target.checked })}
                  />
                  On-demand bond
                </label>
                {edit.demandDeadline !== bond.demandDeadline ? (
                  <div className="rounded-md bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-900 ring-1 ring-amber-200">
                    You are changing the demand deadline from{" "}
                    <strong>{bond.demandDeadline ?? "not recorded"}</strong> to{" "}
                    <strong>{edit.demandDeadline || "not recorded"}</strong>. This is the date every
                    refusal of a late demand is measured against — change it only to match the bond
                    wording, never to make a late demand acceptable.
                  </div>
                ) : null}
                <div className="flex gap-2">
                  <Button disabled={busy} onClick={() => void onSaveEdit()}>
                    {busy ? "Saving…" : "Save changes"}
                  </Button>
                  <Button variant="secondary" onClick={() => setEditOpen(false)}>
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <div className="mt-3">
                <Button variant="secondary" onClick={openEdit}>
                  Edit bond
                </Button>
              </div>
            )
          ) : (
            <p className="mt-3 text-xs text-ink-500">
              A {bond.status} bond cannot be edited — it is part of the record.
            </p>
          )}

          {/* --------------------------------- actions --------------------------------- */}
          <SectionTitle>Actions</SectionTitle>
          <ErrorAlert message={actionError} />

          <div className="flex flex-wrap items-end gap-2">
            {allowed.length > 0 ? (
              <>
                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-ink-600">Status</span>
                  <Select
                    value={target}
                    onChange={(e) => setTarget(e.target.value)}
                    className="w-44"
                  >
                    <option value="">Choose…</option>
                    {allowed.map((s) => (
                      <option
                        key={s}
                        value={s}
                        disabled={s === "issued" && !bond.issuedAt}
                      >
                        {s}
                        {s === "issued" && !bond.issuedAt ? " — needs an issue date" : ""}
                      </option>
                    ))}
                  </Select>
                </label>
                <Button
                  disabled={busy || !target || (target === "issued" && !bond.issuedAt)}
                  onClick={() => void onTransition()}
                >
                  Apply
                </Button>
              </>
            ) : (
              <span className="text-sm text-ink-500">
                No plain status transition is available from <strong>{bond.status}</strong>.
                {bond.status === "active"
                  ? " An active bond leaves that state only by being called, released or expiring."
                  : ""}
              </span>
            )}
            <div className="grow" />
            {callable ? (
              <Button
                variant="danger"
                disabled={deadlinePassed}
                title={
                  deadlinePassed
                    ? "The demand deadline has passed. A demand now will be refused by the API and would not be honoured by the guarantor."
                    : undefined
                }
                onClick={openCall}
              >
                Make a demand
              </Button>
            ) : null}
            {["issued", "active", "called"].includes(bond.status) ? (
              <Button variant="secondary" onClick={() => setReleaseOpen((v) => !v)}>
                Release
              </Button>
            ) : null}
            {bond.status === "draft" ? (
              <Button variant="danger" onClick={() => setConfirmDelete(true)}>
                Delete draft
              </Button>
            ) : null}
          </div>

          {confirmDelete ? (
            <div className="mt-3">
              <ConfirmStrip
                message={`Delete draft bond ${bond.number}? Only a draft can be deleted — once issued, a bond is part of the record.`}
                confirmLabel="Delete bond"
                busy={busy}
                onCancel={() => setConfirmDelete(false)}
                onConfirm={() => void onDelete()}
              />
            </div>
          ) : null}

          {/* --------------------------------- release --------------------------------- */}
          {releaseOpen ? (
            <div className="mt-3 space-y-2 rounded-lg bg-ink-50 p-3">
              <ErrorAlert message={releaseError} />
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field label="Released at">
                  <Input
                    type="date"
                    value={releaseDate}
                    onChange={(e) => setReleaseDate(e.target.value)}
                  />
                </Field>
                <Field label="Reason">
                  <Input
                    value={releaseReason}
                    onChange={(e) => setReleaseReason(e.target.value)}
                    placeholder="Defects liability period expired…"
                  />
                </Field>
              </div>
              <ConfirmStrip
                message={
                  <>
                    Release bond {bond.number} ({fmtMoney(bond.exposure.currentAmount, bond.currency)}{" "}
                    of security)? Releasing gives up the right to demand under it. There is no
                    un-release.
                  </>
                }
                confirmLabel="Release bond"
                busy={busy}
                onCancel={() => setReleaseOpen(false)}
                onConfirm={() => void onRelease()}
              />
            </div>
          ) : null}

          {/* ---------------------------------- call ---------------------------------- */}
          {callResult ? (
            <div className="mt-3 rounded-md bg-violet-50 px-3 py-2 text-xs leading-relaxed text-violet-900 ring-1 ring-violet-200">
              <strong>Demand recorded.</strong>{" "}
              {fmtMoney(callResult.call.amount, bond.currency)} demanded on{" "}
              {formatDate(callResult.call.calledAt)}
              {callResult.daysBeforeDeadline === null
                ? " (no demand deadline is recorded for this bond)"
                : ` — ${daysWord(callResult.daysBeforeDeadline)} before the demand deadline`}
              . The bond is now <strong>called</strong>; there is no un-call. Record the outcome
              below when the guarantor responds.
            </div>
          ) : null}

          {callOpen ? (
            <div className="mt-3 space-y-3 rounded-lg bg-ink-50 p-3">
              <div className="text-sm font-semibold text-ink-900">Make a demand</div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <Field label="Amount">
                  <Input
                    type="number"
                    min={0}
                    step="any"
                    value={callAmount}
                    onChange={(e) => setCallAmount(e.target.value)}
                  />
                </Field>
                <Field label="Demand date">
                  <Input
                    type="date"
                    value={callDate}
                    onChange={(e) => setCallDate(e.target.value)}
                  />
                </Field>
                <div className="self-end pb-2 text-xs text-ink-600">
                  {bond.demandDeadline === null
                    ? "No demand deadline recorded."
                    : callDateDaysBefore === null
                      ? ""
                      : callDateDaysBefore >= 0
                        ? `${daysWord(callDateDaysBefore)} before the deadline of ${bond.demandDeadline}.`
                        : `${daysWord(callDateDaysBefore)} AFTER the deadline of ${bond.demandDeadline} — the API will refuse this.`}
                </div>
              </div>

              <Field label="Reason" hint="The ground relied on. This is the record of why the demand was made.">
                <Textarea value={callReason} onChange={(e) => setCallReason(e.target.value)} />
              </Field>

              <div>
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-xs font-medium text-ink-600">
                    Evidence relied on{bond.isOnDemand === 0 ? " — required for a conditional bond" : ""}
                  </span>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => setEvidence([...evidence, { key: "", value: "" }])}
                  >
                    Add reference
                  </Button>
                </div>
                {evidence.length === 0 ? (
                  <p className="text-xs text-ink-400">None recorded.</p>
                ) : (
                  <div className="space-y-2">
                    {evidence.map((row, i) => (
                      <div key={i} className="flex gap-2">
                        <Input
                          className="w-48"
                          placeholder="Key (e.g. defaultNotice)"
                          value={row.key}
                          onChange={(e) => {
                            const next = evidence.slice();
                            next[i] = { ...row, key: e.target.value };
                            setEvidence(next);
                          }}
                        />
                        <Input
                          placeholder="Reference (record id, document number…)"
                          value={row.value}
                          onChange={(e) => {
                            const next = evidence.slice();
                            next[i] = { ...row, value: e.target.value };
                            setEvidence(next);
                          }}
                        />
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setEvidence(evidence.filter((_, j) => j !== i))}
                        >
                          Remove
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {amountOverCurrent ? (
                <div className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-800 ring-1 ring-red-200">
                  The demand exceeds the bond's current value of{" "}
                  {fmtMoney(bond.exposure.currentAmount, bond.currency)} (face{" "}
                  {fmtMoney(bond.exposure.faceAmount, bond.currency)}, reduced to{" "}
                  {fmtPct(bond.exposure.appliedPercent, 0)} by {bond.exposure.applied.length}{" "}
                  triggered reduction(s)). The API will refuse it.
                </div>
              ) : null}
              {conditionalNoEvidence ? (
                <div className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-800 ring-1 ring-red-200">
                  This is a conditional bond: the guarantor pays only against proof of the
                  principal's default. Record the evidence relied on before demanding — the API will
                  refuse a demand with none.
                </div>
              ) : null}

              <ErrorAlert message={callError} />
              {outOfTime ? (
                <div className="rounded-md border-l-4 border-red-700 bg-red-900 px-4 py-3 text-red-50">
                  <div className="text-sm font-bold uppercase tracking-wide">Demand out of time</div>
                  <div className="mt-2 grid grid-cols-3 gap-2 text-center">
                    <div className="rounded bg-red-950/40 px-2 py-1">
                      <div className="text-[10px] uppercase tracking-wide text-red-200">
                        Deadline
                      </div>
                      <div className="text-sm font-semibold">{outOfTime.demandDeadline ?? "—"}</div>
                    </div>
                    <div className="rounded bg-red-950/40 px-2 py-1">
                      <div className="text-[10px] uppercase tracking-wide text-red-200">
                        Demand dated
                      </div>
                      <div className="text-sm font-semibold">{outOfTime.calledAt}</div>
                    </div>
                    <div className="rounded bg-red-950/40 px-2 py-1">
                      <div className="text-[10px] uppercase tracking-wide text-red-200">
                        Days late
                      </div>
                      <div className="text-sm font-semibold">{outOfTime.daysLate ?? "—"}</div>
                    </div>
                  </div>
                  <p className="mt-2 text-xs leading-relaxed text-red-100">
                    A demand made after the deadline will not be honoured, so it is not recorded as
                    if it were live.
                  </p>
                </div>
              ) : null}

              {callConfirm ? (
                <ConfirmStrip
                  message={
                    <>
                      Demand {fmtMoney(Number(callAmount) || 0, bond.currency)} under bond{" "}
                      {bond.number} from {bond.guarantor}? A successful demand flips the bond to{" "}
                      <strong>called</strong> and there is no un-call — the record of the demand,
                      its date and its stated ground is permanent.
                    </>
                  }
                  confirmLabel="Send the demand"
                  busy={busy}
                  onCancel={() => setCallConfirm(false)}
                  onConfirm={() => void onCall()}
                />
              ) : (
                <div className="flex gap-2">
                  <Button
                    variant="danger"
                    disabled={busy || !callReason.trim() || callAmount === ""}
                    onClick={() => setCallConfirm(true)}
                  >
                    Review demand
                  </Button>
                  <Button variant="secondary" onClick={() => setCallOpen(false)}>
                    Cancel
                  </Button>
                </div>
              )}
            </div>
          ) : null}

          {/* ------------------------------ calls history ------------------------------ */}
          <SectionTitle>Demands made</SectionTitle>
          <ErrorAlert message={outcomeError} />
          {bond.calls.length === 0 ? (
            <p className="text-sm text-ink-400">None.</p>
          ) : (
            <div className="space-y-2">
              {bond.calls.map((call) => (
                <div key={call.id} className="rounded-lg bg-white p-3 shadow-sm ring-1 ring-ink-100">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold tabular-nums text-ink-900">
                      {fmtMoney(call.amount, bond.currency)}
                    </span>
                    <span className="text-xs text-ink-500">
                      demanded {formatDate(call.calledAt)}
                    </span>
                    <Badge tone={callOutcomeTone(call.outcome)}>
                      {BOND_CALL_OUTCOME_LABELS[call.outcome ?? "pending"] ??
                        call.outcome ??
                        "pending"}
                    </Badge>
                    <div className="grow" />
                    <Button size="sm" variant="secondary" onClick={() => openOutcome(call)}>
                      Record outcome
                    </Button>
                  </div>
                  <p className="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-ink-700">
                    {call.reason}
                  </p>
                  {call.proceedsAmount !== null ? (
                    <p className="mt-1 text-xs text-ink-600">
                      Proceeds {fmtMoney(call.proceedsAmount, bond.currency)} received{" "}
                      {formatDate(call.proceedsReceivedAt)}
                    </p>
                  ) : null}
                  {Object.keys(call.evidenceRefs ?? {}).length > 0 ? (
                    <div className="mt-1 flex flex-wrap gap-1.5">
                      {Object.entries(call.evidenceRefs).map(([k, v]) => (
                        <span
                          key={k}
                          className="rounded bg-ink-100 px-1.5 py-0.5 font-mono text-[10px] text-ink-600"
                        >
                          {k}: {String(v)}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <p className="mt-1 text-[11px] text-ink-400">No evidence references recorded.</p>
                  )}
                  <p className="mt-1 text-[11px] text-ink-400">
                    Recorded {formatDateTime(call.createdAt)}
                  </p>

                  {outcomeFor === call.id ? (
                    <div className="mt-2 space-y-2 rounded-md bg-ink-50 p-2">
                      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                        <Field label="Outcome">
                          <Select value={outcome} onChange={(e) => setOutcome(e.target.value)}>
                            {BOND_CALL_OUTCOMES.map((o) => (
                              <option key={o} value={o}>
                                {BOND_CALL_OUTCOME_LABELS[o] ?? o}
                              </option>
                            ))}
                          </Select>
                        </Field>
                        <Field label="Proceeds amount">
                          <Input
                            type="number"
                            min={0}
                            step="any"
                            disabled={!proceedsRequired}
                            value={proceedsAmount}
                            onChange={(e) => setProceedsAmount(e.target.value)}
                          />
                        </Field>
                        <Field label="Proceeds received at">
                          <Input
                            type="date"
                            disabled={!proceedsRequired}
                            value={proceedsAt}
                            onChange={(e) => setProceedsAt(e.target.value)}
                          />
                        </Field>
                      </div>
                      {proceedsRequired ? (
                        <p className="text-xs text-ink-500">
                          Money received is a fact, not a status: recording a demand as paid or
                          partially paid requires both the amount and the date it arrived.
                        </p>
                      ) : null}
                      <div className="flex gap-2">
                        <Button
                          disabled={
                            busy || (proceedsRequired && (proceedsAmount === "" || !proceedsAt))
                          }
                          onClick={() => void onSaveOutcome()}
                        >
                          {busy ? "Saving…" : "Save outcome"}
                        </Button>
                        <Button variant="secondary" onClick={() => setOutcomeFor(null)}>
                          Cancel
                        </Button>
                      </div>
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </Drawer>
  );
}

/* ------------------------------ exposure bar ------------------------------- */

/**
 * Face value against current value after triggered reductions. Both figures are
 * in the same currency, which is the only reason a single bar is honest here.
 */
function ExposureBar({
  face,
  current,
  percent,
  currency,
}: {
  face: number;
  current: number;
  percent: number;
  currency: string;
}) {
  const W = 640;
  const H = 74;
  const barY = 26;
  const barH = 22;
  const left = 8;
  const right = W - 8;
  const width = right - left;
  const frac = face > 0 ? Math.max(0, Math.min(1, current / face)) : 0;

  return (
    <div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full"
        role="img"
        aria-label={`Bond exposure: current value ${current} of face ${face} ${currency}, ${percent}% of face`}
      >
        <rect
          x={left}
          y={barY}
          width={width}
          height={barH}
          rx={3}
          fill={CHART.ink100}
          stroke={CHART.ink200}
        />
        <rect
          x={left}
          y={barY}
          width={Math.max(2, width * frac)}
          height={barH}
          rx={3}
          fill={CHART.violet}
        />
        <text x={left} y={barY - 8} fontSize={10} fontWeight={700} fill={CHART.ink600}>
          {fmtMoney(current, currency, 0)} current exposure
        </text>
        <text
          x={right}
          y={barY - 8}
          fontSize={10}
          textAnchor="end"
          fill={CHART.ink400}
        >
          face {fmtMoney(face, currency, 0)}
        </text>
        <text x={left + 6} y={barY + barH + 14} fontSize={10} fill={CHART.ink400}>
          {fmtPct(percent, 0)} of face value after triggered reductions
        </text>
      </svg>
    </div>
  );
}
