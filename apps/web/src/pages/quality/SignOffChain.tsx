/**
 * THE SIGN-OFF CHAIN on one intervention point.
 *
 * A hold point in a real ITP is rarely one signature: the contractor's own QC
 * signs, then the engineer, then — on the pours, welds and services that
 * matter — a third-party surveillance body. The order is the control, so this
 * panel draws it as an ordered chain with exactly one leg live at a time, and
 * the API refuses a signature given out of turn.
 *
 * Three facts are kept apart, because they are three different things:
 * NOTIFIED (they were invited), ATTENDED (they came), SIGNED (they released
 * it). A surveillance body that attended and has not yet issued its report is
 * a different position from one that has released the point, and a programme
 * that cannot tell them apart cannot chase the right person.
 */
import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Field, Input, Modal, Select, Skeleton } from "../../ui";
import { cx } from "../../ui/cx";
import { IconCheckCircle, IconPlus, IconSend, IconSlash, IconUser } from "../../ui/icons";
import { toneClass, type Tone } from "../../ui/tokens";
import { api } from "../../lib/api";
import {
  EM_DASH,
  LoadError,
  RESPONSIBLE_PARTIES,
  ReasonList,
  RefusalNotice,
  dateTime,
  labelize,
  nameOf,
  useAction,
  useReason,
  useResource,
} from "./qualityShared";
import type { ReleaseLeg, ReleaseChain } from "./types";

const LEG_TONE: Record<string, Tone> = {
  pending: "neutral",
  notified: "info",
  attended: "accent",
  released: "success",
  rejected: "danger",
  waived: "highlight",
  not_required: "neutral",
};

const TERMINAL_LEG = ["released", "rejected", "waived", "not_required"];

export default function SignOffChain({
  projectId,
  itpId,
  activityId,
  users,
  onMutated,
  version,
}: {
  projectId: string;
  itpId: string;
  activityId: string;
  users: Map<string, string>;
  onMutated: () => void;
  version: number;
}) {
  const base = `/api/v1/projects/${projectId}/itps/${itpId}/activities/${activityId}/parties`;
  const [nonce, setNonce] = useState(0);
  const [editing, setEditing] = useState(false);
  const { busy, refusal, clear, run } = useAction();
  const { ask, dialog } = useReason();

  const chain = useResource<ReleaseChain>(
    (signal) => api.get<ReleaseChain>(base, { signal }),
    [base, nonce, version],
  );

  const refresh = useCallback(() => {
    setNonce((n) => n + 1);
    onMutated();
  }, [onMutated]);

  async function act(leg: ReleaseLeg, action: "notify" | "attend" | "release") {
    const done = await run(`${action}-${leg.id}`, () => api.post(`${base}/${leg.id}/${action}`, {}));
    if (done) refresh();
  }

  async function reject(leg: ReleaseLeg) {
    const reason = await ask({
      title: `Refuse to certify — ${labelize(leg.party)}`,
      description:
        "A rejection is a refusal to certify, not a delay. It fails the activity, and the reason is what the contractor is answering.",
      label: "Why is this point refused?",
      confirmLabel: "Record the refusal",
    });
    if (!reason) return;
    const done = await run(`reject-${leg.id}`, () =>
      api.post(`${base}/${leg.id}/reject`, { reason }),
    );
    if (done) refresh();
  }

  async function waive(leg: ReleaseLeg) {
    const reason = await ask({
      title: `Waive the ${labelize(leg.party)} leg`,
      description:
        "A waived leg is a different fact from a signed one, and only survives a challenge if the reason was written at the time.",
      label: "Why is this leg being waived?",
      confirmLabel: "Record the waiver",
    });
    if (!reason) return;
    const done = await run(`waive-${leg.id}`, () => api.post(`${base}/${leg.id}/waive`, { reason }));
    if (done) refresh();
  }

  if (chain.loading && !chain.data) return <Skeleton className="h-20 w-full" />;
  if (chain.error) return <LoadError message={chain.error} onRetry={chain.reload} title="The sign-off chain could not be loaded" />;

  const legs = chain.data?.items ?? [];
  const summary = chain.data?.summary;

  return (
    <div className="rounded-md border border-border-subtle bg-surface-sunken p-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-label uppercase tracking-wide text-content-subtle">
          Sign-off chain
        </div>
        <Button size="xs" variant="ghost" icon={IconPlus} onClick={() => setEditing(true)}>
          {legs.length === 0 ? "Set the chain" : "Replace the chain"}
        </Button>
      </div>

      {legs.length === 0 ? (
        <p className="mt-1 text-meta text-content-muted">
          No chain is recorded, so the single-release rule on the activity governs it. Set one where
          the point needs the contractor's QC, then the engineer, then a third-party body — the
          order is the control, not a formality.
        </p>
      ) : (
        <ol className="mt-2 space-y-1.5">
          {legs.map((leg, index) => {
            const live = summary?.nextLegId === leg.id;
            const terminal = TERMINAL_LEG.includes(leg.status);
            return (
              <li
                key={leg.id}
                className={cx(
                  "rounded-md border p-2",
                  live
                    ? cx(toneClass("accent", "border"), toneClass("accent", "subtle"))
                    : "border-border-subtle bg-surface",
                )}
              >
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="font-mono text-2xs text-content-subtle">{index + 1}</span>
                  <Badge tone={LEG_TONE[leg.status] ?? "neutral"} size="xs" dot>
                    {labelize(leg.status)}
                  </Badge>
                  <span className="text-2xs font-semibold text-content">{labelize(leg.party)}</span>
                  {leg.organisation ? (
                    <span className="text-2xs text-content-muted">· {leg.organisation}</span>
                  ) : null}
                  {leg.userId ? (
                    <Badge tone="accent" size="xs" variant="outline">
                      <IconUser className="mr-0.5 size-3" aria-hidden />
                      {nameOf(users, leg.userId)}
                    </Badge>
                  ) : null}
                  {leg.accreditation ? (
                    <span className="text-2xs text-content-subtle">{leg.accreditation}</span>
                  ) : null}
                  {leg.required === 0 ? (
                    <Badge tone="neutral" size="xs" variant="outline">
                      invited, does not block
                    </Badge>
                  ) : null}
                  {live ? (
                    <Badge tone="accent" size="xs" variant="solid">
                      their turn
                    </Badge>
                  ) : null}
                </div>
                <div className="mt-1 grid gap-x-4 gap-y-0.5 text-2xs text-content-muted sm:grid-cols-3">
                  <span>Notified {leg.notifiedAt ? dateTime(leg.notifiedAt) : EM_DASH}</span>
                  <span>Attended {leg.attendedAt ? dateTime(leg.attendedAt) : EM_DASH}</span>
                  <span>
                    Signed{" "}
                    {leg.releasedAt
                      ? `${dateTime(leg.releasedAt)} · ${leg.releasedByName ?? nameOf(users, leg.releasedBy)}`
                      : EM_DASH}
                  </span>
                </div>
                {leg.note ? (
                  <p className="mt-1 whitespace-pre-wrap text-2xs text-content-muted">{leg.note}</p>
                ) : null}
                {!terminal ? (
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    <Button
                      size="xs"
                      variant="ghost"
                      icon={IconSend}
                      loading={busy === `notify-${leg.id}`}
                      onClick={() => act(leg, "notify")}
                    >
                      Notify
                    </Button>
                    <Button
                      size="xs"
                      variant="ghost"
                      loading={busy === `attend-${leg.id}`}
                      onClick={() => act(leg, "attend")}
                    >
                      Record attendance
                    </Button>
                    <Button
                      size="xs"
                      variant="secondary"
                      icon={IconCheckCircle}
                      loading={busy === `release-${leg.id}`}
                      onClick={() => act(leg, "release")}
                    >
                      Sign
                    </Button>
                    <Button
                      size="xs"
                      variant="ghost"
                      icon={IconSlash}
                      loading={busy === `reject-${leg.id}`}
                      onClick={() => reject(leg)}
                    >
                      Refuse
                    </Button>
                    <Button
                      size="xs"
                      variant="ghost"
                      loading={busy === `waive-${leg.id}`}
                      onClick={() => waive(leg)}
                    >
                      Waive
                    </Button>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ol>
      )}

      {summary ? <ReasonList reasons={summary.reasons} className="mt-1.5" /> : null}
      <RefusalNotice refusal={refusal} onDismiss={clear} />

      <ChainModal
        open={editing}
        onClose={() => setEditing(false)}
        base={base}
        users={users}
        onSaved={() => {
          setEditing(false);
          refresh();
        }}
      />
      {dialog}
    </div>
  );
}

/* ================================================================== */
/* Setting the chain                                                   */
/* ================================================================== */

interface DraftLeg {
  party: string;
  userId: string;
  organisation: string;
  accreditation: string;
  required: boolean;
}

const emptyLeg = (party: string): DraftLeg => ({
  party,
  userId: "",
  organisation: "",
  accreditation: "",
  required: true,
});

function ChainModal({
  open,
  onClose,
  base,
  users,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  base: string;
  users: Map<string, string>;
  onSaved: () => void;
}) {
  const { busy, refusal, clear, run } = useAction();
  const [legs, setLegs] = useState<DraftLeg[]>([emptyLeg("contractor"), emptyLeg("engineer")]);

  useEffect(() => {
    if (open) setLegs([emptyLeg("contractor"), emptyLeg("engineer")]);
  }, [open]);

  function update(index: number, patch: Partial<DraftLeg>) {
    setLegs((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  }

  async function save() {
    const done = await run("save", () =>
      api.put(base, {
        parties: legs.map((l) => ({
          party: l.party,
          required: l.required,
          userId: l.userId === "" ? null : l.userId,
          organisation: l.organisation.trim() === "" ? null : l.organisation.trim(),
          accreditation: l.accreditation.trim() === "" ? null : l.accreditation.trim(),
        })),
      }),
    );
    if (done) onSaved();
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Set the sign-off chain"
      description="In order. Each required leg waits for the ones ahead of it, and one person may not sign two legs of the same point — that is the whole reason the chain exists."
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy === "save"} onClick={save}>
            Save the chain
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <RefusalNotice refusal={refusal} onDismiss={clear} />
        {legs.map((leg, index) => (
          <div key={index} className="rounded-md border border-border-subtle p-2.5">
            <div className="grid gap-2 sm:grid-cols-2">
              <Field label={`Party ${index + 1}`}>
                <Select value={leg.party} onChange={(e) => update(index, { party: e.target.value })}>
                  {RESPONSIBLE_PARTIES.map((p) => (
                    <option key={p} value={p}>
                      {labelize(p)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Nominated user" hint="Only this user may sign this leg.">
                <Select value={leg.userId} onChange={(e) => update(index, { userId: e.target.value })}>
                  <option value="">— organisation only —</option>
                  {[...users.entries()].map(([id, name]) => (
                    <option key={id} value={id}>
                      {name}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              <Field label="Organisation">
                <Input
                  value={leg.organisation}
                  onChange={(e) => update(index, { organisation: e.target.value })}
                  placeholder="e.g. Notified Body Ltd"
                />
              </Field>
              <Field label="Accreditation" hint="e.g. UKAS 0086 — who says they are competent.">
                <Input
                  value={leg.accreditation}
                  onChange={(e) => update(index, { accreditation: e.target.value })}
                />
              </Field>
            </div>
            <label className="mt-2 flex items-center gap-2 text-2xs text-content-muted">
              <input
                type="checkbox"
                checked={leg.required}
                onChange={(e) => update(index, { required: e.target.checked })}
              />
              The point waits for this party (clear it to invite them without blocking)
            </label>
            {legs.length > 1 ? (
              <Button
                size="xs"
                variant="ghost"
                className="mt-1"
                onClick={() => setLegs((prev) => prev.filter((_, i) => i !== index))}
              >
                Remove
              </Button>
            ) : null}
          </div>
        ))}
        <Button
          size="sm"
          variant="secondary"
          icon={IconPlus}
          onClick={() => setLegs((prev) => [...prev, emptyLeg("third_party")])}
        >
          Add a party
        </Button>
      </div>
    </Modal>
  );
}
