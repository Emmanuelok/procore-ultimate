/**
 * CHANGE ORDER REQUESTS — the priced ask that goes to the owner.
 *
 * A COR packages one or more PCOs, adds the markup stack in a stated order,
 * and becomes the number under negotiation. Two columns are kept apart on
 * purpose and are never merged on this screen:
 *
 *   amount          what we asked for
 *   approvedAmount  what the owner agreed
 *
 * The gap between them, aggregated across a project, is the most useful
 * commercial metric a contractor has. A partially approved COR must not
 * silently rewrite what was requested, so both are always printed.
 *
 * NEGOTIATION is a sequence, not a final number. Every round is recorded with
 * its author, its side of the table and its date, because the question that
 * decides a claim two years later is "what did they offer, and when" — and a
 * single notes field cannot answer it.
 */
import { useMemo, useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  ErrorAlert,
  Field,
  Input,
  Select,
  Textarea,
} from "../../ui";
import { Drawer, DrawerBody, DrawerFooter, Modal, toast } from "../../ui/overlays";
import { DataTable, DescriptionList, Timeline, type DataColumns, type TimelineItem } from "../../ui/data";
import { NumberInput } from "../../ui/inputs";
import { IconContract, IconApproval } from "../../ui/icons";
import { api } from "../../lib/api";
import CostLines from "./CostLines";
import MarkupStackTable from "./MarkupStack";
import {
  COR_STATUSES,
  ComponentValue,
  IdentityList,
  PanelSkeleton,
  PanelSkeleton as Skel,
  Reasons,
  corTone,
  days,
  errorMessage,
  isoDate,
  isoDateTime,
  label,
  money,
  pcoTone,
  refusalFrom,
  useResource,
  type ChangeChain,
  type ChangeContext,
  type CorDetail,
  type CorRow,
  type NegotiationRound,
  type PcoRow,
} from "./changesShared";

const COR_EDITABLE = new Set(["draft", "revise_and_resubmit"]);

/* ------------------------------------------------------------------ */
/* Create — packaging PCOs into an ask                                 */
/* ------------------------------------------------------------------ */

function CreateCorModal({
  open,
  onClose,
  projectId,
  chain,
  context,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  projectId: string;
  chain: ChangeChain;
  context: ChangeContext;
  onCreated: () => void;
}) {
  const [primeContractId, setPrimeContractId] = useState("");
  const [changeEventId, setChangeEventId] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [scheduleImpactDays, setScheduleImpactDays] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Only a PCO with a priced position and no other COR can be rolled up. */
  const eligible = useMemo(
    () =>
      chain.pcos.filter(
        (p) =>
          !p.changeOrderRequestId &&
          (["priced", "submitted", "approved"].includes(p.status) || p.noCharge === 1),
      ),
    [chain.pcos],
  );

  const currency = context.contractCurrency(primeContractId || null);
  const selectedTotal = eligible
    .filter((p) => selected.includes(p.id))
    .reduce((sum, p) => sum + p.amount, 0);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        primeContractId,
        title: title.trim(),
        pcoIds: selected,
      };
      if (changeEventId) body["changeEventId"] = changeEventId;
      if (description.trim()) body["description"] = description.trim();
      if (scheduleImpactDays !== null) body["scheduleImpactDays"] = scheduleImpactDays;
      await api.post(`/api/v1/projects/${projectId}/change-order-requests`, body);
      toast.success("Change order request raised.");
      setTitle("");
      setDescription("");
      setSelected([]);
      onCreated();
      onClose();
    } catch (err) {
      setError(errorMessage(err, "The change order request was refused"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Raise a change order request"
      description="Package the priced PCOs into one ask against one prime contract. Markups are taken from the contract's standard stack and can be edited before submission."
      size="xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            onClick={() => void submit()}
            loading={busy}
            disabled={!primeContractId || !title.trim()}
          >
            Raise COR
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <ErrorAlert message={error} />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Prime contract" required hint="A COR is an ask against one contract.">
            <Select
              value={primeContractId}
              onChange={(e) => setPrimeContractId(e.target.value)}
            >
              <option value="">Select a contract…</option>
              {context.contracts.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.reference} — {c.title} ({c.currency})
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Change event" optional>
            <Select value={changeEventId} onChange={(e) => setChangeEventId(e.target.value)}>
              <option value="">Not attributed</option>
              {chain.events
                .filter((e) => e.status !== "void")
                .map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.reference} — {e.title}
                  </option>
                ))}
            </Select>
          </Field>
        </div>

        <Field label="Title" required>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <Field label="Description" optional>
          <Textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>

        <Field
          label="Potential change orders rolled up"
          hint="Only priced PCOs that are not already inside another COR. Billing one cost to the owner twice is refused."
        >
          {eligible.length === 0 ? (
            <EmptyState
              size="sm"
              title="Nothing eligible"
              hint="A PCO must be priced (or explicitly no-charge) and not already inside a change order request."
            />
          ) : (
            <div className="max-h-56 space-y-1 overflow-y-auto rounded-md border border-border p-2">
              {eligible.map((pco) => (
                <label
                  key={pco.id}
                  className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-meta hover:bg-surface-hover"
                >
                  <span className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={selected.includes(pco.id)}
                      onChange={(e) =>
                        setSelected((prev) =>
                          e.target.checked
                            ? [...prev, pco.id]
                            : prev.filter((id) => id !== pco.id),
                        )
                      }
                    />
                    <span className="font-mono text-2xs text-content-subtle">{pco.reference}</span>
                    <span className="text-content">{pco.title}</span>
                    <Badge tone={pcoTone(pco.status)} size="xs">
                      {label(pco.status)}
                    </Badge>
                  </span>
                  <span className="tabular-nums text-content">
                    {money(
                      pco.amount,
                      context.commitmentCurrency(pco.commitmentId) ?? currency,
                    )}
                  </span>
                </label>
              ))}
            </div>
          )}
        </Field>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Days claimed" optional>
            <NumberInput
              value={scheduleImpactDays}
              onChange={setScheduleImpactDays}
              min={0}
              precision={0}
              suffix="d"
            />
          </Field>
          <div className="flex items-end">
            <p className="text-meta text-content-muted">
              Selected cost position:{" "}
              <span className="tabular-nums text-content">
                {money(selectedTotal, currency)}
              </span>
              . Markup is added on top, in the order the stack states.
            </p>
          </div>
        </div>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Negotiation                                                         */
/* ------------------------------------------------------------------ */

function negotiationTimeline(
  rounds: readonly NegotiationRound[],
  currency: string | null,
): TimelineItem[] {
  return rounds.map((round) => ({
    id: `round-${round.seq}`,
    title:
      round.position === "owner"
        ? `Owner's position (round ${round.seq})`
        : `Our position (round ${round.seq})`,
    tone: round.position === "owner" ? "info" : "accent",
    timestamp: round.at,
    actor: round.by,
    badge:
      round.amount === null ? (
        <Badge tone="neutral" size="xs">
          no figure stated
        </Badge>
      ) : (
        <Badge tone="neutral" size="xs">
          {money(round.amount, currency)}
        </Badge>
      ),
    description: round.note,
    body:
      round.scheduleImpactDays !== null ? (
        <span className="text-2xs text-content-subtle">
          Time position: {days(round.scheduleImpactDays)}
        </span>
      ) : null,
  }));
}

/* ------------------------------------------------------------------ */
/* Detail                                                              */
/* ------------------------------------------------------------------ */

function CorDrawer({
  projectId,
  corId,
  onClose,
  onChanged,
  context,
}: {
  projectId: string;
  corId: string;
  onClose: () => void;
  onChanged: () => void;
  context: ChangeContext;
}) {
  const detail = useResource<CorDetail>(
    `/api/v1/projects/${projectId}/change-order-requests/${corId}`,
  );
  const cor = detail.data?.changeOrderRequest ?? null;
  const currency = context.contractCurrency(cor?.primeContractId ?? null);

  const [actionError, setActionError] = useState<string | null>(null);
  const [negotiating, setNegotiating] = useState(false);
  const [approving, setApproving] = useState(false);
  const [rejecting, setRejecting] = useState(false);

  const [round, setRound] = useState<{
    position: "owner" | "contractor";
    amount: number | null;
    scheduleImpactDays: number | null;
    note: string;
  }>({ position: "owner", amount: null, scheduleImpactDays: null, note: "" });

  const [approval, setApproval] = useState<{
    approvedAmount: number | null;
    scheduleImpactApprovedDays: number | null;
    ownerResponseDate: string;
    notes: string;
  }>({
    approvedAmount: null,
    scheduleImpactApprovedDays: null,
    ownerResponseDate: "",
    notes: "",
  });

  const [rejection, setRejection] = useState({ reason: "", ownerResponseDate: "" });

  async function act(path: string, body?: unknown, success?: string) {
    setActionError(null);
    try {
      await api.post(
        `/api/v1/projects/${projectId}/change-order-requests/${corId}/${path}`,
        body ?? {},
      );
      toast.success(success ?? "Done.");
      detail.reload();
      onChanged();
      return true;
    } catch (err) {
      const refusal = refusalFrom(err);
      setActionError(refusal ? refusal.message : errorMessage(err, "The action was refused"));
      return false;
    }
  }

  const editable = cor ? COR_EDITABLE.has(cor.status) : false;

  return (
    <Drawer
      open
      onClose={onClose}
      size="xl"
      title={cor ? `${cor.reference} — ${cor.title}` : "Change order request"}
      description={cor ? `${label(cor.status)} · submitted ${isoDate(cor.submittedDate)}` : undefined}
      icon={IconContract}
      footer={
        <DrawerFooter align="between">
          <span className="text-2xs text-content-subtle">
            The approver may be neither the author nor the submitter. A refusal here is the control
            working.
          </span>
          <span className="flex flex-wrap gap-2">
            {cor && COR_EDITABLE.has(cor.status) ? (
              <>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => void act("recalculate", {}, "Totals re-derived from the lines and the stack.")}
                >
                  Recalculate
                </Button>
                <Button size="sm" onClick={() => void act("submit", {}, "Submitted to the owner.")}>
                  Submit to owner
                </Button>
              </>
            ) : null}
            {cor?.status === "submitted" ? (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => void act("review", {}, "Marked under review.")}
              >
                Mark under review
              </Button>
            ) : null}
            {cor && ["submitted", "under_review", "negotiating"].includes(cor.status) ? (
              <>
                <Button size="sm" variant="secondary" onClick={() => setNegotiating(true)}>
                  Record a negotiation round
                </Button>
                <Button size="sm" icon={IconApproval} onClick={() => setApproving(true)}>
                  Record owner decision
                </Button>
                <Button size="sm" variant="danger" onClick={() => setRejecting(true)}>
                  Reject
                </Button>
              </>
            ) : null}
          </span>
        </DrawerFooter>
      }
    >
      <DrawerBody>
        {detail.loading && !detail.data ? (
          <Skel rows={6} />
        ) : detail.error ? (
          <ErrorAlert message={detail.error} />
        ) : detail.data && cor ? (
          <div className="space-y-4">
            <ErrorAlert message={actionError} />

            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={corTone(cor.status)}>{label(cor.status)}</Badge>
              {cor.reason ? (
                <Badge tone="neutral" variant="outline">
                  {label(cor.reason)}
                </Badge>
              ) : null}
              {cor.changeOrderPackageId ? <Badge tone="success">Inside a package</Badge> : null}
              <span className="text-2xs text-content-subtle">
                {context.contractById.get(cor.primeContractId)?.reference ?? cor.primeContractId}
                {currency ? ` · ${currency}` : " · currency unknown"}
              </span>
            </div>

            {cor.rejectionReason ? (
              <Alert tone="danger" variant="subtle" size="sm" title="Rejected by the owner">
                {cor.rejectionReason}
              </Alert>
            ) : null}

            {/* ---- asked vs granted ---- */}
            <Card>
              <CardHeader
                title="Asked and granted"
                subtitle="Two columns, never merged. A partially approved COR must not rewrite what was requested."
              />
              <CardBody>
                <DescriptionList
                  columns={4}
                  items={[
                    { label: "Asked", value: money(detail.data.commercial.asked, currency) },
                    { label: "Granted", value: money(detail.data.commercial.granted, currency) },
                    {
                      label: "Gap",
                      value: money(detail.data.commercial.gap, currency),
                      hint: "what was conceded in negotiation",
                    },
                    {
                      label: "Gap %",
                      value: (
                        <ComponentValue
                          component={detail.data.commercial.gapPercent}
                          format="percent"
                        />
                      ),
                    },
                    {
                      label: "Days claimed",
                      value: days(cor.scheduleImpactDays),
                      hint: "time extension requested",
                    },
                    {
                      label: "Days granted",
                      value: days(cor.scheduleImpactApprovedDays),
                    },
                    { label: "Submitted", value: isoDate(cor.submittedDate) },
                    { label: "Owner responded", value: isoDate(cor.ownerResponseDate) },
                  ]}
                />
              </CardBody>
            </Card>

            {/* ---- the markup stack ---- */}
            <MarkupStackTable stack={detail.data.markupStack} currency={currency} />

            <Card>
              <CardHeader
                title="Reconciliation"
                subtitle="Every identity the total rests on, checked against the stored rows."
              />
              <CardBody className="space-y-3">
                <IdentityList identities={detail.data.identities} currency={currency} />
                <div className="border-t border-border-subtle pt-3">
                  <span className="text-2xs uppercase tracking-wide text-content-subtle">
                    Stack total
                  </span>
                  <div className="text-h4 tabular-nums text-content">
                    <ComponentValue component={detail.data.total} currency={currency} />
                  </div>
                </div>
              </CardBody>
            </Card>

            {/* ---- member PCOs ---- */}
            <Card>
              <CardHeader
                title="Potential change orders in this ask"
                subtitle="Each one is a cost position we have taken; the COR is what we bill for them."
              />
              <CardBody>
                {detail.data.members.length === 0 ? (
                  <EmptyState
                    size="sm"
                    title="No PCOs rolled up"
                    hint="A COR raised without member PCOs carries its own lines instead — which is legal, but the cost has no commitment behind it."
                  />
                ) : (
                  <ul className="space-y-1">
                    {detail.data.members.map((pco: PcoRow) => (
                      <li
                        key={pco.id}
                        className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border-subtle px-2.5 py-1.5 text-meta"
                      >
                        <span className="flex items-center gap-2">
                          <span className="font-mono text-2xs text-content-subtle">
                            {pco.reference}
                          </span>
                          <span className="text-content">{pco.title}</span>
                          <Badge tone={pcoTone(pco.status)} size="xs">
                            {label(pco.status)}
                          </Badge>
                        </span>
                        <span className="tabular-nums text-content">
                          {money(
                            pco.amount,
                            context.commitmentCurrency(pco.commitmentId) ?? currency,
                          )}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </CardBody>
            </Card>

            {/* ---- lines ---- */}
            <CostLines
              basePath={`/api/v1/projects/${projectId}/change-order-requests/${corId}`}
              lines={detail.data.lines}
              totals={{
                lineCount: detail.data.lines.length,
                costSubtotal: detail.data.markupStack.costSubtotal,
                costByType: detail.data.markupStack.costByType,
                revenueSubtotal: detail.data.lines.reduce((s, l) => s + l.revenueAmount, 0),
                lineMarkupTotal: detail.data.lines.reduce((s, l) => s + l.markupAmount, 0),
                taxTotal: detail.data.markupStack.taxTotal,
                margin: detail.data.markupStack.margin,
              }}
              currency={currency}
              editable={editable}
              frozenReason={`This request is "${label(cor.status)}" and has been put to the owner. Its lines are frozen.`}
              onChanged={() => {
                detail.reload();
                onChanged();
              }}
              title="Cost lines on the ask"
            />

            {/* ---- negotiation history ---- */}
            <Card>
              <CardHeader
                title="Negotiation history"
                subtitle="A sequence of positions with dates and authors — not a single notes field."
              />
              <CardBody>
                {detail.data.negotiation.length === 0 ? (
                  <EmptyState
                    size="sm"
                    title="No rounds recorded"
                    hint="If the owner has come back with a number, record it: the sequence is what a claim is argued from."
                  />
                ) : (
                  <Timeline
                    items={negotiationTimeline(detail.data.negotiation, currency)}
                    timeFormat="absolute"
                    aria-label="Negotiation history"
                  />
                )}
              </CardBody>
            </Card>
          </div>
        ) : null}
      </DrawerBody>

      {/* ---- negotiate ---- */}
      <Modal
        open={negotiating}
        onClose={() => setNegotiating(false)}
        title="Record a negotiation round"
        description="Who moved, to what number, and when. Appended — never overwritten."
        footer={
          <>
            <Button variant="ghost" onClick={() => setNegotiating(false)}>
              Cancel
            </Button>
            <Button
              disabled={!round.note.trim()}
              onClick={async () => {
                const body: Record<string, unknown> = {
                  position: round.position,
                  note: round.note.trim(),
                };
                if (round.amount !== null) body["amount"] = round.amount;
                if (round.scheduleImpactDays !== null) {
                  body["scheduleImpactDays"] = round.scheduleImpactDays;
                }
                const ok = await act("negotiate", body, "Negotiation round recorded.");
                if (ok) {
                  setNegotiating(false);
                  setRound({
                    position: "owner",
                    amount: null,
                    scheduleImpactDays: null,
                    note: "",
                  });
                }
              }}
            >
              Record round
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label="Whose position is this?" required>
            <Select
              value={round.position}
              onChange={(e) =>
                setRound((r) => ({ ...r, position: e.target.value as "owner" | "contractor" }))
              }
            >
              <option value="owner">The owner's</option>
              <option value="contractor">Ours</option>
            </Select>
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label={`Figure${currency ? ` (${currency})` : ""}`}
              optional
              hint="Leave blank when the round moved position without naming a number."
            >
              <NumberInput
                value={round.amount}
                onChange={(v) => setRound((r) => ({ ...r, amount: v }))}
                precision={2}
                align="right"
              />
            </Field>
            <Field label="Time position (days)" optional>
              <NumberInput
                value={round.scheduleImpactDays}
                onChange={(v) => setRound((r) => ({ ...r, scheduleImpactDays: v }))}
                min={0}
                precision={0}
                suffix="d"
              />
            </Field>
          </div>
          <Field label="What was said" required>
            <Textarea
              rows={4}
              value={round.note}
              onChange={(e) => setRound((r) => ({ ...r, note: e.target.value }))}
            />
          </Field>
        </div>
      </Modal>

      {/* ---- approve ---- */}
      <Modal
        open={approving}
        onClose={() => setApproving(false)}
        title="Record the owner's decision"
        description="The approved amount may be lower than what was asked. It is stored separately, so the gap survives."
        footer={
          <>
            <Button variant="ghost" onClick={() => setApproving(false)}>
              Cancel
            </Button>
            <Button
              disabled={approval.approvedAmount === null}
              onClick={async () => {
                const body: Record<string, unknown> = {
                  approvedAmount: approval.approvedAmount,
                };
                if (approval.scheduleImpactApprovedDays !== null) {
                  body["scheduleImpactApprovedDays"] = approval.scheduleImpactApprovedDays;
                }
                if (approval.ownerResponseDate) {
                  body["ownerResponseDate"] = approval.ownerResponseDate;
                }
                if (approval.notes.trim()) body["notes"] = approval.notes.trim();
                const ok = await act("approve", body, "Owner decision recorded.");
                if (ok) setApproving(false);
              }}
            >
              Record decision
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          {cor ? (
            <Alert tone="info" variant="subtle" size="sm">
              Asked: <strong>{money(cor.amount, currency)}</strong> over{" "}
              {days(cor.scheduleImpactDays)} claimed. Approving a lower figure records a partial
              approval; the difference stays visible as the negotiation gap.
            </Alert>
          ) : null}
          <Field label={`Approved amount${currency ? ` (${currency})` : ""}`} required>
            <NumberInput
              value={approval.approvedAmount}
              onChange={(v) => setApproval((a) => ({ ...a, approvedAmount: v }))}
              precision={2}
              align="right"
            />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Time extension granted (days)" optional>
              <NumberInput
                value={approval.scheduleImpactApprovedDays}
                onChange={(v) => setApproval((a) => ({ ...a, scheduleImpactApprovedDays: v }))}
                min={0}
                precision={0}
                suffix="d"
              />
            </Field>
            <Field label="Owner response date" optional>
              <Input
                type="date"
                value={approval.ownerResponseDate}
                onChange={(e) =>
                  setApproval((a) => ({ ...a, ownerResponseDate: e.target.value }))
                }
              />
            </Field>
          </div>
          <Field label="Notes" optional>
            <Textarea
              rows={3}
              value={approval.notes}
              onChange={(e) => setApproval((a) => ({ ...a, notes: e.target.value }))}
            />
          </Field>
        </div>
      </Modal>

      {/* ---- reject ---- */}
      <Modal
        open={rejecting}
        onClose={() => setRejecting(false)}
        title="Record a rejection"
        description="A rejection always carries a reason. Without one there is nothing to resubmit against."
        footer={
          <>
            <Button variant="ghost" onClick={() => setRejecting(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              disabled={!rejection.reason.trim()}
              onClick={async () => {
                const body: Record<string, unknown> = {
                  rejectionReason: rejection.reason.trim(),
                };
                if (rejection.ownerResponseDate) {
                  body["ownerResponseDate"] = rejection.ownerResponseDate;
                }
                const ok = await act("reject", body, "Rejection recorded.");
                if (ok) {
                  setRejecting(false);
                  setRejection({ reason: "", ownerResponseDate: "" });
                }
              }}
            >
              Record rejection
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label="Reason given" required>
            <Textarea
              rows={4}
              value={rejection.reason}
              onChange={(e) => setRejection((r) => ({ ...r, reason: e.target.value }))}
            />
          </Field>
          <Field label="Owner response date" optional>
            <Input
              type="date"
              value={rejection.ownerResponseDate}
              onChange={(e) =>
                setRejection((r) => ({ ...r, ownerResponseDate: e.target.value }))
              }
            />
          </Field>
        </div>
      </Modal>
    </Drawer>
  );
}

/* ------------------------------------------------------------------ */
/* Register                                                            */
/* ------------------------------------------------------------------ */

export default function CorTab({
  projectId,
  chain,
  context,
  selectedCorId,
  onSelectCor,
}: {
  projectId: string;
  chain: ChangeChain;
  context: ChangeContext;
  selectedCorId: string | null;
  onSelectCor: (id: string | null) => void;
}) {
  const [creating, setCreating] = useState(false);

  const columns = useMemo<DataColumns<CorRow>>(
    () => [
      {
        id: "reference",
        header: "Number",
        accessor: "reference",
        type: "code",
        width: 110,
        sticky: "start",
      },
      { id: "title", header: "Title", accessor: "title", type: "text", width: 280 },
      {
        id: "contract",
        header: "Prime contract",
        accessor: (row: CorRow) =>
          context.contractById.get(row.primeContractId)?.reference ?? row.primeContractId,
        type: "code",
        width: 130,
      },
      {
        id: "status",
        header: "Status",
        accessor: "status",
        type: "status",
        width: 150,
        groupable: true,
        options: COR_STATUSES.map((s) => ({
          value: s,
          text: label(s),
          label: label(s),
          tone: corTone(s),
        })),
      },
      {
        id: "amount",
        header: "Asked",
        accessor: "amount",
        type: "currency",
        width: 130,
        aggregate: "sum",
        cell: (ctx) => money(ctx.row.amount, context.contractCurrency(ctx.row.primeContractId)),
      },
      {
        id: "approvedAmount",
        header: "Granted",
        accessor: "approvedAmount",
        type: "currency",
        width: 130,
        aggregate: "sum",
        cell: (ctx) =>
          ["approved", "partially_approved"].includes(ctx.row.status) ? (
            money(ctx.row.approvedAmount, context.contractCurrency(ctx.row.primeContractId))
          ) : (
            <span
              className="text-content-subtle italic"
              title="The owner has not decided yet — this is not zero."
            >
              undecided
            </span>
          ),
      },
      {
        id: "gap",
        header: "Negotiation gap",
        accessor: (row: CorRow) =>
          ["approved", "partially_approved", "rejected"].includes(row.status)
            ? row.amount - row.approvedAmount
            : null,
        type: "currency",
        width: 150,
        signColor: true,
        cell: (ctx) =>
          ["approved", "partially_approved", "rejected"].includes(ctx.row.status) ? (
            money(
              ctx.row.amount - ctx.row.approvedAmount,
              context.contractCurrency(ctx.row.primeContractId),
            )
          ) : (
            <span className="text-content-subtle italic">not decided</span>
          ),
      },
      {
        id: "markupTotal",
        header: "Markup",
        accessor: "markupTotal",
        type: "currency",
        width: 120,
        defaultHidden: true,
        cell: (ctx) => money(ctx.row.markupTotal, context.contractCurrency(ctx.row.primeContractId)),
      },
      {
        id: "scheduleImpactDays",
        header: "Days claimed",
        accessor: "scheduleImpactDays",
        type: "number",
        width: 120,
        aggregate: "sum",
      },
      {
        id: "scheduleImpactApprovedDays",
        header: "Days granted",
        accessor: "scheduleImpactApprovedDays",
        type: "number",
        width: 120,
        aggregate: "sum",
      },
      {
        id: "submittedDate",
        header: "Submitted",
        accessor: "submittedDate",
        type: "date",
        width: 120,
      },
      {
        id: "ownerResponseDate",
        header: "Owner responded",
        accessor: "ownerResponseDate",
        type: "date",
        width: 140,
      },
      {
        id: "rounds",
        header: "Rounds",
        headerTooltip: "Negotiation rounds recorded on this request.",
        accessor: (row: CorRow) => {
          const history = row.detail["negotiationHistory"];
          return Array.isArray(history) ? history.length : 0;
        },
        type: "number",
        width: 90,
      },
    ],
    [context],
  );

  const mixed = context.currencies.length > 1;

  return (
    <div className="space-y-3">
      <ErrorAlert message={chain.error} />
      {mixed ? (
        <Reasons
          reasons={[
            `Prime contracts on this project are denominated in ${context.currencies.join(", ")}. Footer totals would add unlike things, so they are switched off — the change log reconciles per currency.`,
          ]}
          tone="warning"
          title="Mixed currency"
        />
      ) : null}

      <DataTable<CorRow>
        tableId={`changes:cors:${projectId}`}
        data={chain.cors}
        columns={columns}
        getRowId={(row) => row.id}
        loading={chain.loading}
        onRetry={chain.reload}
        height={620}
        stickyHeader
        showFooter={!mixed}
        filterRow
        savedViews
        exportFileName={`change-order-requests-${projectId}`}
        searchPlaceholder="Search change order requests…"
        aria-label="Change order requests"
        defaultSort={[{ id: "reference", desc: true }]}
        onRowClick={(ctx) => onSelectCor(ctx.row.id)}
        rowTone={(row) => corTone(row.status)}
        empty={{
          icon: IconContract,
          title: "Nothing has been put to the owner",
          description:
            "Priced and never submitted is a gap in the chain: the cost is real and nobody has been asked to pay it.",
          action: <Button onClick={() => setCreating(true)}>Raise a COR</Button>,
        }}
        toolbarActions={<Button onClick={() => setCreating(true)}>Raise COR</Button>}
      />

      <CreateCorModal
        open={creating}
        onClose={() => setCreating(false)}
        projectId={projectId}
        chain={chain}
        context={context}
        onCreated={chain.reload}
      />

      {selectedCorId ? (
        <CorDrawer
          projectId={projectId}
          corId={selectedCorId}
          onClose={() => onSelectCor(null)}
          onChanged={chain.reload}
          context={context}
        />
      ) : null}
    </div>
  );
}
