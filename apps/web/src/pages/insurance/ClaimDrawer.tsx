/**
 * Claim detail — the notification clock, then everything else.
 *
 * Notification within the policy period is a condition precedent to liability
 * in almost every wording. Where it is, late notification is fatal to the
 * claim however strong its merits and the insurer need show no prejudice to
 * decline — so when the API returns `late: true`, its `consequence` text is
 * printed verbatim at the top of this drawer and stays there.
 */
import { useCallback, useEffect, useState } from "react";
import { api } from "../../lib/api";
import { Badge, Button, ErrorAlert, Field, Input, Select, Spinner, Textarea } from "../../ui";
import { formatDate, formatDateTime } from "../format";
import {
  CHART,
  CLAIM_REQUEST_KIND_LABELS,
  CLAIM_STATUS_LABELS,
  CLAIM_TRANSITIONS,
  Caveat,
  DeadlineChip,
  DetailRow,
  Disclosure,
  Drawer,
  NOTIFICATION_METHODS,
  SectionTitle,
  claimTone,
  daysBetweenIso,
  daysWord,
  errMsg,
  fmtMoney,
  policyTypeLabel,
  todayIso,
  type ClaimDetail,
  type ClaimNotifyResult,
  type ClaimPackResult,
  type ClaimRequestList,
} from "./insuranceShared";

export default function ClaimDrawer({
  projectId,
  claimId,
  onClose,
  onChanged,
}: {
  projectId: string;
  claimId: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const base = `/api/v1/projects/${projectId}/insurance/claims/${claimId}`;

  const [claim, setClaim] = useState<ClaimDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setClaim(await api.get<ClaimDetail>(base));
    } catch (err) {
      setClaim(null);
      setError(errMsg(err, "Failed to load the claim"));
    }
  }, [base]);

  useEffect(() => {
    void load();
  }, [load]);

  /* --------------------------------- notify --------------------------------- */

  const [notifiedAt, setNotifiedAt] = useState(todayIso());
  const [method, setMethod] = useState<string>("email");
  const [reference, setReference] = useState("");
  const [insurerRef, setInsurerRef] = useState("");
  const [notifyError, setNotifyError] = useState<string | null>(null);
  const [notifyResult, setNotifyResult] = useState<ClaimNotifyResult | null>(null);

  async function onNotify() {
    setBusy(true);
    setNotifyError(null);
    try {
      const body: Record<string, unknown> = { notifiedAt, method };
      if (reference.trim()) body["reference"] = reference.trim();
      if (insurerRef.trim()) body["insurerRef"] = insurerRef.trim();
      const res = await api.post<ClaimNotifyResult>(`${base}/notify`, body);
      setNotifyResult(res);
      await load();
      onChanged();
    } catch (err) {
      setNotifyError(errMsg(err, "The notification could not be recorded"));
    } finally {
      setBusy(false);
    }
  }

  /* ------------------------------- transitions ------------------------------- */

  const [target, setTarget] = useState("");
  const [repudiationReason, setRepudiationReason] = useState("");
  const [settledAmount, setSettledAmount] = useState("");
  const [settledAt, setSettledAt] = useState(todayIso());
  const [statusError, setStatusError] = useState<string | null>(null);

  async function onTransition() {
    if (!target) return;
    setBusy(true);
    setStatusError(null);
    try {
      const body: Record<string, unknown> = { status: target };
      if (target === "repudiated") body["repudiationReason"] = repudiationReason.trim();
      if (target === "settled") {
        body["settledAmount"] = Number(settledAmount);
        body["settledAt"] = settledAt;
      }
      await api.post(`${base}/status`, body);
      setTarget("");
      setRepudiationReason("");
      setSettledAmount("");
      await load();
      onChanged();
    } catch (err) {
      setStatusError(errMsg(err, "The transition was refused"));
    } finally {
      setBusy(false);
    }
  }

  /* --------------------------------- edit --------------------------------- */

  const [editOpen, setEditOpen] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [edit, setEdit] = useState({
    title: "",
    description: "",
    quantum: "",
    reserve: "",
    insurerRef: "",
    lossAdjuster: "",
  });

  function openEdit() {
    if (!claim) return;
    setEdit({
      title: claim.title,
      description: claim.description ?? "",
      quantum: claim.quantum === null ? "" : String(claim.quantum),
      reserve: claim.reserve === null ? "" : String(claim.reserve),
      insurerRef: claim.insurerRef ?? "",
      lossAdjuster: claim.lossAdjuster ?? "",
    });
    setEditError(null);
    setEditOpen(true);
  }

  async function onSaveEdit() {
    setBusy(true);
    setEditError(null);
    try {
      await api.patch(base, {
        title: edit.title.trim(),
        description: edit.description.trim() || null,
        quantum: edit.quantum === "" ? null : Number(edit.quantum),
        reserve: edit.reserve === "" ? null : Number(edit.reserve),
        insurerRef: edit.insurerRef.trim() || null,
        lossAdjuster: edit.lossAdjuster.trim() || null,
      });
      setEditOpen(false);
      await load();
      onChanged();
    } catch (err) {
      setEditError(errMsg(err, "Failed to save the claim"));
    } finally {
      setBusy(false);
    }
  }

  /* --------------------------------- render --------------------------------- */

  const allowed = claim ? (CLAIM_TRANSITIONS[claim.status] ?? []) : [];
  const storedDaysLate =
    claim?.notifiedAt && claim.notificationDueAt
      ? (daysBetweenIso(claim.notificationDueAt, claim.notifiedAt) ?? 0)
      : null;
  const editable =
    claim !== null && !["settled", "repudiated", "withdrawn"].includes(claim.status);
  const linkedRecords = parseLinkedRecords(claim?.linkedRecords);

  return (
    <Drawer
      open
      wide
      onClose={onClose}
      title={
        claim ? (
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-sm text-ink-500">{claim.number}</span>
            <span>{claim.title}</span>
            <Badge tone={claimTone(claim.status)}>
              {CLAIM_STATUS_LABELS[claim.status] ?? claim.status}
            </Badge>
          </span>
        ) : (
          "Claim"
        )
      }
    >
      <ErrorAlert message={error} />
      {claim === null ? (
        error ? null : (
          <Spinner />
        )
      ) : (
        <div>
          {/* ---------------------------- notification ---------------------------- */}
          {notifyResult ? (
            notifyResult.late ? (
              <div className="mb-3 rounded-md border-l-4 border-red-700 bg-red-900 px-4 py-3 text-red-50">
                <div className="text-sm font-bold uppercase tracking-wide">
                  Notified out of time
                  {notifyResult.daysLate !== null
                    ? ` — ${daysWord(notifyResult.daysLate)} late`
                    : ""}
                </div>
                <p className="mt-2 text-xs leading-relaxed text-red-50">
                  {notifyResult.consequence}
                </p>
                <p className="mt-2 text-[11px] leading-relaxed text-red-200">
                  A critical signal has been raised and the notification obligation is recorded as
                  breached. Treat the loss as uninsured until the insurer confirms otherwise in
                  writing, and preserve the record of when awareness actually arose — that date is
                  now the whole argument.
                </p>
              </div>
            ) : (
              <div className="mb-3 rounded-md bg-emerald-50 px-3 py-2 text-xs leading-relaxed text-emerald-900 ring-1 ring-emerald-200">
                <span className="text-[10px] font-semibold uppercase tracking-wide opacity-70">
                  consequence — returned verbatim by the API
                </span>
                <p className="mt-0.5">{notifyResult.consequence}</p>
              </div>
            )
          ) : null}

          {claim.notifiedLate && !notifyResult ? (
            <div className="mb-3 rounded-md border-l-4 border-red-700 bg-red-900 px-4 py-3 text-red-50">
              <div className="text-sm font-bold uppercase tracking-wide">
                This claim was notified late
                {storedDaysLate !== null && storedDaysLate > 0
                  ? ` — ${daysWord(storedDaysLate)} after the deadline`
                  : ""}
              </div>
              <p className="mt-1 text-xs leading-relaxed text-red-100">
                Notification was given on {formatDate(claim.notifiedAt)} against a deadline of{" "}
                {formatDate(claim.notificationDueAt)} computed from the aware date{" "}
                {formatDate(claim.awareDate)}. Where notification in time is a condition precedent
                to liability — which it usually is — the insurer may decline outright without
                showing any prejudice.
              </p>
            </div>
          ) : null}

          <SectionTitle hint="The clock runs from awareness, not from the incident.">
            Notification
          </SectionTitle>

          <NotificationTimeline claim={claim} />

          <div className="mt-3">
            {claim.notificationOutstanding ? (
              <div className="space-y-3 rounded-lg bg-ink-50 p-3">
                <div className="flex flex-wrap items-center gap-3">
                  <span className="text-sm font-medium text-ink-900">
                    The insurer has not been told yet.
                  </span>
                  <DeadlineChip
                    days={claim.daysToNotificationDue}
                    fatal
                    unknownLabel="no deadline computed"
                    unknownTitle="The policy records no notificationDays, so no deadline was computed and no obligation exists."
                  />
                  {claim.notificationDueAt ? (
                    <span className="text-xs text-ink-500">
                      due {formatDate(claim.notificationDueAt)}
                    </span>
                  ) : null}
                </div>

                {claim.notificationDueAt === null ? (
                  <Caveat>
                    No deadline could be computed for this claim because its policy records no
                    notification period. That is not the same as having time: the wording will still
                    impose one, and the platform simply cannot tell you what it is.
                  </Caveat>
                ) : null}

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
                  <Field label="Notified at">
                    <Input
                      type="date"
                      value={notifiedAt}
                      onChange={(e) => setNotifiedAt(e.target.value)}
                    />
                  </Field>
                  <Field label="Method">
                    <Select value={method} onChange={(e) => setMethod(e.target.value)}>
                      {NOTIFICATION_METHODS.map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Reference" hint="Proof of despatch.">
                    <Input value={reference} onChange={(e) => setReference(e.target.value)} />
                  </Field>
                  <Field label="Insurer reference">
                    <Input value={insurerRef} onChange={(e) => setInsurerRef(e.target.value)} />
                  </Field>
                </div>
                <ErrorAlert message={notifyError} />
                <div className="flex flex-wrap items-center gap-2">
                  <Button disabled={busy} onClick={() => void onNotify()}>
                    {busy ? "Recording…" : "Record notification"}
                  </Button>
                  <span className="text-xs text-ink-500">
                    Recorded once and never rewritten — a second notification would falsify the
                    record of when the insurer was actually told.
                  </span>
                </div>
              </div>
            ) : (
              <div className="rounded-md bg-white p-3 text-sm text-ink-700 shadow-sm ring-1 ring-ink-100">
                Notified {formatDate(claim.notifiedAt)}
                {claim.notificationDueAt
                  ? ` against a deadline of ${formatDate(claim.notificationDueAt)}`
                  : " (no deadline was computed for this claim)"}
                .{" "}
                {claim.notifiedLate ? (
                  <span className="font-semibold text-red-700">It was late.</span>
                ) : claim.notificationDueAt ? (
                  <span className="text-emerald-700">In time.</span>
                ) : (
                  <span className="text-amber-700">
                    Timeliness cannot be asserted either way.
                  </span>
                )}
              </div>
            )}
          </div>

          {/* ------------------------------ obligation ------------------------------ */}
          <SectionTitle hint="The deadline is carried as an obligation — the same machinery as a contractual time bar.">
            Obligation
          </SectionTitle>
          {claim.obligation ? (
            <div>
              <DetailRow label="Source">{claim.obligation.sourceClause}</DetailRow>
              <DetailRow label="Trigger">{claim.obligation.trigger}</DetailRow>
              <DetailRow label="Deadline">
                {claim.obligation.deadline ? formatDateTime(claim.obligation.deadline) : "—"}
              </DetailRow>
              <DetailRow label="Status">
                <Badge
                  tone={
                    claim.obligation.status === "breached"
                      ? "red"
                      : claim.obligation.status === "satisfied"
                        ? "green"
                        : "blue"
                  }
                >
                  {claim.obligation.status}
                </Badge>
              </DetailRow>
              <DetailRow label="Evidence required">
                {claim.obligation.evidenceRequirement ?? "—"}
              </DetailRow>
              <DetailRow label="Warn before">
                {claim.obligation.warnDaysBefore === null
                  ? "—"
                  : `${claim.obligation.warnDaysBefore} day(s)`}
              </DetailRow>
            </div>
          ) : (
            <Disclosure label="No obligation exists for this claim" tone="amber">
              No notification obligation was created, because the policy recorded no notification
              period when the claim was raised. Nothing will warn you as the deadline approaches —
              there is no deadline in the system to warn about.
            </Disclosure>
          )}

          {/* -------------------------------- policy -------------------------------- */}
          <SectionTitle>Policy</SectionTitle>
          {claim.policy ? (
            <div>
              <DetailRow label="Policy">
                <span className="font-mono text-xs">{claim.policy.number}</span> ·{" "}
                {policyTypeLabel(claim.policy.policyType)} · {claim.policy.insurer}
              </DetailRow>
              <DetailRow label="Period">
                {formatDate(claim.policy.periodStart)} → {formatDate(claim.policy.periodEnd)}
              </DetailRow>
              <DetailRow label="Status">{claim.policy.derivedStatus}</DetailRow>
              <DetailRow label="Notification period">
                {claim.policy.notificationDays === null ? (
                  <span className="text-amber-700">None recorded</span>
                ) : (
                  `${claim.policy.notificationDays} day(s) from awareness`
                )}
              </DetailRow>
            </div>
          ) : (
            <p className="text-sm text-ink-400">
              The policy behind this claim is not visible from this project.
            </p>
          )}

          {/* --------------------------------- claim --------------------------------- */}
          <SectionTitle>Claim</SectionTitle>
          <div>
            <DetailRow label="Incident date">{formatDate(claim.incidentDate)}</DetailRow>
            <DetailRow label="Aware date">{formatDate(claim.awareDate)}</DetailRow>
            <DetailRow label="Description">
              {claim.description ? (
                <span className="whitespace-pre-wrap">{claim.description}</span>
              ) : (
                <span className="text-ink-400">—</span>
              )}
            </DetailRow>
            <DetailRow label="Quantum">
              {claim.quantum === null ? (
                <span className="text-ink-400">Not estimated</span>
              ) : (
                fmtMoney(claim.quantum, claim.currency)
              )}
            </DetailRow>
            <DetailRow label="Reserve">
              {claim.reserve === null ? (
                <span className="text-ink-400">Not set</span>
              ) : (
                fmtMoney(claim.reserve, claim.currency)
              )}
            </DetailRow>
            {claim.settledAmount !== null ? (
              <DetailRow label="Settled">
                {fmtMoney(claim.settledAmount, claim.currency)} on {formatDate(claim.settledAt)}
              </DetailRow>
            ) : null}
            {claim.repudiationReason ? (
              <DetailRow label="Repudiation ground">
                <span className="whitespace-pre-wrap text-red-800">{claim.repudiationReason}</span>
              </DetailRow>
            ) : null}
            <DetailRow label="Insurer reference">{claim.insurerRef ?? "—"}</DetailRow>
            <DetailRow label="Loss adjuster">{claim.lossAdjuster ?? "—"}</DetailRow>
            <DetailRow
              label="Linked records"
              title="The platform records this claim arises from. Recorded through the API; this workspace displays them but does not yet offer a picker to add them."
            >
              {linkedRecords.length === 0 ? (
                <span className="text-ink-400">None linked</span>
              ) : (
                <ul className="space-y-0.5">
                  {linkedRecords.map((r, i) => (
                    <li key={i} className="text-xs">
                      <span className="font-medium">{r.recordType}</span>{" "}
                      <code className="text-[11px]">{r.recordId}</code>
                      {r.note ? <span className="text-ink-500"> — {r.note}</span> : null}
                    </li>
                  ))}
                </ul>
              )}
            </DetailRow>
          </div>

          {editOpen ? (
            <div className="mt-3 space-y-3 rounded-lg bg-ink-50 p-3">
              <ErrorAlert message={editError} />
              <Field label="Title">
                <Input value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} />
              </Field>
              <Field label="Description">
                <Textarea
                  value={edit.description}
                  onChange={(e) => setEdit({ ...edit, description: e.target.value })}
                />
              </Field>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
                <Field label="Quantum">
                  <Input
                    type="number"
                    min={0}
                    step="any"
                    value={edit.quantum}
                    onChange={(e) => setEdit({ ...edit, quantum: e.target.value })}
                  />
                </Field>
                <Field label="Reserve">
                  <Input
                    type="number"
                    min={0}
                    step="any"
                    value={edit.reserve}
                    onChange={(e) => setEdit({ ...edit, reserve: e.target.value })}
                  />
                </Field>
                <Field label="Insurer reference">
                  <Input
                    value={edit.insurerRef}
                    onChange={(e) => setEdit({ ...edit, insurerRef: e.target.value })}
                  />
                </Field>
                <Field label="Loss adjuster">
                  <Input
                    value={edit.lossAdjuster}
                    onChange={(e) => setEdit({ ...edit, lossAdjuster: e.target.value })}
                  />
                </Field>
              </div>
              <p className="text-xs text-ink-500">
                The incident and aware dates are not editable here: they are the facts the
                notification deadline was computed from.
              </p>
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
              <Button
                variant="secondary"
                disabled={!editable}
                title={
                  editable
                    ? undefined
                    : `A ${claim.status} claim cannot be edited — it is closed on the record.`
                }
                onClick={openEdit}
              >
                Edit claim
              </Button>
            </div>
          )}

          {/* ------------------------ pack + adjuster requests ---------------------- */}
          <ClaimPackPanel projectId={projectId} claimId={claimId} claim={claim} onChanged={load} />

          {/* -------------------------------- status -------------------------------- */}
          <SectionTitle>Status</SectionTitle>
          <ErrorAlert message={statusError} />
          {allowed.length === 0 ? (
            <p className="text-sm text-ink-500">
              A {CLAIM_STATUS_LABELS[claim.status] ?? claim.status} claim is terminal — there is no
              transition out of it.
            </p>
          ) : (
            <div className="space-y-3">
              <div className="flex flex-wrap items-end gap-2">
                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-ink-600">
                    Transition to
                  </span>
                  <Select
                    value={target}
                    onChange={(e) => setTarget(e.target.value)}
                    className="w-64"
                  >
                    <option value="">Choose…</option>
                    {allowed.map((s) => (
                      <option
                        key={s}
                        value={s}
                        disabled={s === "acknowledged" && !claim.notifiedAt}
                      >
                        {CLAIM_STATUS_LABELS[s] ?? s}
                        {s === "acknowledged" && !claim.notifiedAt
                          ? " — needs the notification first"
                          : ""}
                      </option>
                    ))}
                  </Select>
                </label>
                <Button
                  disabled={
                    busy ||
                    !target ||
                    (target === "acknowledged" && !claim.notifiedAt) ||
                    (target === "repudiated" && !repudiationReason.trim()) ||
                    (target === "settled" && (settledAmount === "" || !settledAt))
                  }
                  onClick={() => void onTransition()}
                >
                  {busy ? "Working…" : "Apply"}
                </Button>
              </div>

              {target === "acknowledged" && !claim.notifiedAt ? (
                <p className="text-xs text-red-700">
                  A claim cannot be acknowledged before it has been notified to the insurer — record
                  the notification first.
                </p>
              ) : null}

              {target === "repudiated" ? (
                <Field
                  label="Ground relied on (required)"
                  hint="An unreasoned declinature cannot be challenged, and the ground is what any later coverage dispute turns on."
                >
                  <Textarea
                    value={repudiationReason}
                    onChange={(e) => setRepudiationReason(e.target.value)}
                  />
                </Field>
              ) : null}

              {target === "settled" ? (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Field
                    label="Settled amount (required)"
                    hint="A settled claim with no figure cannot be reconciled against the reserve."
                  >
                    <Input
                      type="number"
                      min={0}
                      step="any"
                      value={settledAmount}
                      onChange={(e) => setSettledAmount(e.target.value)}
                    />
                  </Field>
                  <Field label="Settled at (required)">
                    <Input
                      type="date"
                      value={settledAt}
                      onChange={(e) => setSettledAt(e.target.value)}
                    />
                  </Field>
                </div>
              ) : null}

              <p className="text-xs leading-relaxed text-ink-500">
                Only transitions the API accepts from{" "}
                <strong>{CLAIM_STATUS_LABELS[claim.status] ?? claim.status}</strong> are offered.
                Settling a claim late does not rewrite a breached notification obligation: a breach
                stays on the register.
              </p>
            </div>
          )}
        </div>
      )}
    </Drawer>
  );
}

/** Links to the platform records this claim arises from. */
function parseLinkedRecords(
  raw: unknown,
): { recordType: string; recordId: string; note?: string }[] {
  if (!Array.isArray(raw)) return [];
  const out: { recordType: string; recordId: string; note?: string }[] = [];
  for (const e of raw) {
    if (!e || typeof e !== "object") continue;
    const o = e as Record<string, unknown>;
    if (typeof o["recordType"] !== "string" || typeof o["recordId"] !== "string") continue;
    out.push({
      recordType: o["recordType"],
      recordId: o["recordId"],
      ...(typeof o["note"] === "string" ? { note: o["note"] } : {}),
    });
  }
  return out;
}

/* ----------------------------- the timeline ------------------------------- */

/**
 * Incident → awareness → deadline → notification, to scale.
 *
 * The gap between the incident and awareness is drawn because it is the part
 * people forget: the clock does not start when the loss happens, and a claim
 * discovered months later can still be notified in time.
 */
function NotificationTimeline({ claim }: { claim: ClaimDetail }) {
  const today = todayIso();
  const points: { date: string; label: string; color: string; strong?: boolean }[] = [
    { date: claim.incidentDate, label: "Incident", color: CHART.ink400 },
    { date: claim.awareDate, label: "Aware — clock starts", color: CHART.brand600, strong: true },
  ];
  if (claim.notificationDueAt) {
    points.push({
      date: claim.notificationDueAt,
      label: "Notification due",
      color: CHART.red,
      strong: true,
    });
  }
  if (claim.notifiedAt) {
    points.push({
      date: claim.notifiedAt,
      label: "Notified",
      color: claim.notifiedLate ? CHART.red900 : CHART.emerald,
      strong: true,
    });
  } else {
    points.push({ date: today, label: "Today", color: CHART.ink300 });
  }

  const times = points
    .map((p) => Date.parse(`${p.date}T00:00:00Z`))
    .filter((t) => !Number.isNaN(t));
  if (times.length === 0) return null;
  const min = Math.min(...times);
  const max = Math.max(...times);
  const span = Math.max(1, max - min);

  const W = 640;
  const H = 96;
  const left = 70;
  const right = W - 70;
  const y = 44;
  const x = (date: string) => {
    const t = Date.parse(`${date}T00:00:00Z`);
    if (Number.isNaN(t)) return left;
    return left + ((t - min) / span) * (right - left);
  };

  const incidentToAware = daysBetweenIso(claim.incidentDate, claim.awareDate);

  return (
    <div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full"
        role="img"
        aria-label="Claim notification timeline from incident through awareness to the notification deadline"
      >
        <line x1={left} x2={right} y1={y} y2={y} stroke={CHART.ink200} strokeWidth={2} />
        {/* the notification window itself */}
        {claim.notificationDueAt ? (
          <rect
            x={x(claim.awareDate)}
            y={y - 6}
            width={Math.max(2, x(claim.notificationDueAt) - x(claim.awareDate))}
            height={12}
            fill={CHART.brand200}
            rx={2}
          >
            <title>The notification window — it runs from the aware date.</title>
          </rect>
        ) : null}
        {points.map((p, i) => (
          <g key={`${p.label}-${i}`}>
            <circle cx={x(p.date)} cy={y} r={p.strong ? 6 : 4} fill={p.color} stroke="#fff" strokeWidth={1.5}>
              <title>{`${p.label} — ${p.date}`}</title>
            </circle>
            <text
              x={x(p.date)}
              y={i % 2 === 0 ? y - 14 : y + 22}
              textAnchor="middle"
              fontSize={9}
              fontWeight={p.strong ? 700 : 500}
              fill={CHART.ink600}
            >
              {p.label}
            </text>
            <text
              x={x(p.date)}
              y={i % 2 === 0 ? y - 24 : y + 32}
              textAnchor="middle"
              fontSize={8}
              fill={CHART.ink400}
            >
              {p.date}
            </text>
          </g>
        ))}
      </svg>
      <p className="text-xs leading-relaxed text-ink-500">
        {incidentToAware === null
          ? null
          : incidentToAware === 0
            ? "Awareness arose on the day of the incident."
            : `Awareness arose ${daysWord(incidentToAware)} after the incident — and the deadline runs from awareness, not from the incident.`}
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* THE PACK, AND THE ADJUSTER'S TASK LIST (#784, #785)                 */
/*                                                                     */
/* An insurer decides a claim on the pack it was given. This panel     */
/* assembles it, prints the hash, and — because a claim is more often  */
/* lost on an unanswered request than on its merits — keeps the        */
/* adjuster's asks in front of the person who owes them.               */
/* ------------------------------------------------------------------ */

function ClaimPackPanel({
  projectId,
  claimId,
  claim,
  onChanged,
}: {
  projectId: string;
  claimId: string;
  claim: ClaimDetail;
  onChanged: () => Promise<void> | void;
}) {
  const base = `/api/v1/projects/${projectId}/insurance/claims/${claimId}`;
  const [requests, setRequests] = useState<ClaimRequestList | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [packError, setPackError] = useState<string | null>(null);
  const [pack, setPack] = useState<ClaimPackResult | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const [addOpen, setAddOpen] = useState(false);
  const [addKind, setAddKind] = useState("information_request");
  const [addTitle, setAddTitle] = useState("");
  const [addBy, setAddBy] = useState("");
  const [addDue, setAddDue] = useState("");
  const [addError, setAddError] = useState<string | null>(null);

  const [respondFor, setRespondFor] = useState<string | null>(null);
  const [respondNote, setRespondNote] = useState("");
  const [respondError, setRespondError] = useState<string | null>(null);

  const loadRequests = useCallback(async () => {
    setListError(null);
    try {
      setRequests(await api.get<ClaimRequestList>(`${base}/requests`));
    } catch (err) {
      setRequests(null);
      setListError(errMsg(err, "Failed to load the adjuster's requests"));
    }
  }, [base]);

  useEffect(() => {
    void loadRequests();
  }, [loadRequests]);

  async function generate() {
    setBusy("pack");
    setPackError(null);
    try {
      setPack(await api.post<ClaimPackResult>(`${base}/pack`, {}));
      await onChanged();
    } catch (err) {
      setPackError(errMsg(err, "The pack could not be assembled"));
    } finally {
      setBusy(null);
    }
  }

  async function addRequest() {
    if (!addTitle.trim()) return;
    setBusy("add");
    setAddError(null);
    try {
      await api.post(`${base}/requests`, {
        kind: addKind,
        title: addTitle.trim(),
        requestedBy: addBy.trim() || null,
        dueDate: addDue || null,
      });
      setAddOpen(false);
      setAddTitle("");
      setAddBy("");
      setAddDue("");
      await loadRequests();
    } catch (err) {
      setAddError(errMsg(err, "The request could not be recorded"));
    } finally {
      setBusy(null);
    }
  }

  async function respond(requestId: string) {
    if (!respondNote.trim()) return;
    setBusy(`respond:${requestId}`);
    setRespondError(null);
    try {
      await api.post(
        `/api/v1/projects/${projectId}/insurance/claim-requests/${requestId}/respond`,
        { responseNote: respondNote.trim() },
      );
      setRespondFor(null);
      setRespondNote("");
      await loadRequests();
    } catch (err) {
      setRespondError(errMsg(err, "The answer could not be recorded"));
    } finally {
      setBusy(null);
    }
  }

  const generatedAt = pack?.generatedAt ?? claim.packGeneratedAt;
  const sha = pack?.sha256 ?? claim.packSha256;
  const itemCount = pack?.itemCount ?? claim.packItemCount;

  return (
    <>
      <SectionTitle hint="The pack indexes the evidence and is hashed; it does not copy the files, which stay in the register under their own hashes.">
        Documentation pack
      </SectionTitle>
      <ErrorAlert message={packError} />
      <div className="mb-4 space-y-2">
        {generatedAt ? (
          <div className="rounded-lg bg-ink-50 p-3 text-xs">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone="success" variant="outline">
                assembled
              </Badge>
              <span className="text-ink-600">
                {formatDateTime(generatedAt)} · {itemCount} record
                {itemCount === 1 ? "" : "s"} indexed
              </span>
            </div>
            {sha ? (
              <p className="mt-1 break-all font-mono text-[11px] text-ink-500">sha256 {sha}</p>
            ) : null}
            <p className="mt-1 text-ink-500">
              The hash is in the hash-chained ledger, so what was submitted stays checkable a year
              from now.
            </p>
          </div>
        ) : (
          <p className="text-sm text-ink-500">
            No pack has been assembled. An insurer decides a claim on the pack it was given — and
            without one there is no record of what that was.
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={busy !== null} onClick={() => void generate()}>
            {busy === "pack" ? "Assembling…" : generatedAt ? "Re-assemble" : "Assemble pack"}
          </Button>
          {claim.packFileId ? (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => window.open(`${base}/pack`, "_blank", "noopener")}
            >
              Open the stored pack
            </Button>
          ) : null}
        </div>
        {pack && pack.gaps.length > 0 ? (
          <Disclosure label={`${pack.gaps.length} thing(s) this pack does not establish`} tone="amber">
            <ul className="list-disc space-y-1 pl-4">
              {pack.gaps.map((g, i) => (
                <li key={i}>{g}</li>
              ))}
            </ul>
          </Disclosure>
        ) : null}
      </div>

      <SectionTitle hint="A claim is more often lost on an unanswered request than on its merits. Each request with a date is carried as an obligation.">
        Loss adjuster requests
      </SectionTitle>
      <ErrorAlert message={listError} />
      <div className="space-y-2">
        {requests === null && listError === null ? (
          <Spinner label="Loading requests…" />
        ) : requests && requests.total === 0 ? (
          <p className="text-sm text-ink-500">
            Nothing recorded from the adjuster. Record each ask as it arrives — an unanswered
            request that nobody wrote down is invisible until the claim is declined.
          </p>
        ) : requests ? (
          <>
            <div className="flex flex-wrap gap-2 text-xs text-ink-500">
              <span>{requests.open} open</span>
              {requests.overdue > 0 ? (
                <Badge tone="danger">{requests.overdue} past their date</Badge>
              ) : null}
            </div>
            <ul className="space-y-2">
              {requests.items.map((r) => (
                <li key={r.id} className="rounded-lg border border-ink-100 p-2 text-xs">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={r.overdue ? "danger" : r.status === "open" ? "warning" : "success"}>
                      {r.overdue ? "overdue" : r.status}
                    </Badge>
                    <span className="font-medium">{r.title}</span>
                    <span className="text-ink-400">
                      {CLAIM_REQUEST_KIND_LABELS[r.kind] ?? r.kind}
                    </span>
                  </div>
                  <div className="mt-1 text-ink-500">
                    {r.requestedBy ? <>Asked by {r.requestedBy}. </> : null}
                    {r.dueDate ? (
                      <>
                        Due {formatDate(r.dueDate)}
                        {r.daysToDue !== null && r.status === "open"
                          ? ` (${daysWord(Math.abs(r.daysToDue))} ${r.daysToDue < 0 ? "ago" : "away"})`
                          : ""}
                        .
                      </>
                    ) : (
                      <>No date was given, so nothing warns before it is late. </>
                    )}
                    {r.respondedAt ? <> Answered {formatDateTime(r.respondedAt)}.</> : null}
                  </div>
                  {r.responseNote ? (
                    <p className="mt-1 whitespace-pre-wrap text-ink-600">{r.responseNote}</p>
                  ) : null}
                  {r.status === "open" ? (
                    respondFor === r.id ? (
                      <div className="mt-2 space-y-2">
                        <ErrorAlert message={respondError} />
                        <Textarea
                          value={respondNote}
                          rows={2}
                          placeholder="What was sent, and when"
                          onChange={(e) => setRespondNote(e.target.value)}
                        />
                        <div className="flex gap-2">
                          <Button
                            size="sm"
                            disabled={busy !== null || !respondNote.trim()}
                            onClick={() => void respond(r.id)}
                          >
                            Record the answer
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => setRespondFor(null)}>
                            Cancel
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <Button
                        size="xs"
                        variant="secondary"
                        className="mt-2"
                        onClick={() => {
                          setRespondFor(r.id);
                          setRespondNote("");
                          setRespondError(null);
                        }}
                      >
                        Answer
                      </Button>
                    )
                  ) : null}
                </li>
              ))}
            </ul>
          </>
        ) : null}

        {addOpen ? (
          <div className="space-y-2 rounded-lg bg-ink-50 p-3">
            <ErrorAlert message={addError} />
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <Field label="Kind">
                <Select value={addKind} onChange={(e) => setAddKind(e.target.value)}>
                  {Object.entries(CLAIM_REQUEST_KIND_LABELS).map(([k, label]) => (
                    <option key={k} value={k}>
                      {label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Due date" hint="Without one, nothing can warn before it is late.">
                <Input type="date" value={addDue} onChange={(e) => setAddDue(e.target.value)} />
              </Field>
            </div>
            <Field label="What was asked for">
              <Input value={addTitle} onChange={(e) => setAddTitle(e.target.value)} />
            </Field>
            <Field label="Asked by">
              <Input
                value={addBy}
                placeholder={claim.lossAdjuster ?? "The adjuster or insurer"}
                onChange={(e) => setAddBy(e.target.value)}
              />
            </Field>
            <div className="flex gap-2">
              <Button
                size="sm"
                disabled={busy !== null || !addTitle.trim()}
                onClick={() => void addRequest()}
              >
                Record the request
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setAddOpen(false)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <Button size="sm" variant="secondary" onClick={() => setAddOpen(true)}>
            Record a request
          </Button>
        )}
      </div>
    </>
  );
}
