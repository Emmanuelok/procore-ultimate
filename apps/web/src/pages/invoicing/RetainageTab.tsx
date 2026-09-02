/**
 * RETAINAGE — the money everyone forgets.
 *
 * Two positions, reported separately and never netted:
 *
 *   receivable   retainage the OWNER holds from us — an asset we are waiting on
 *   payable      retainage WE hold from subs — a liability we control
 *
 * Netting them would produce a number that describes neither. So would summing
 * across currencies, and the API does not do either.
 *
 * Releasing retainage is an APPROVAL EVENT with money attached: someone asks,
 * someone else agrees, and only then does the held balance move. The approver
 * may be neither the author nor the requester, and the held position is
 * re-derived from the schedule of values at approval rather than trusted from
 * the draft — a release requested last week against 50,000 cannot be approved
 * this week if only 20,000 is still held.
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
  Stat,
  Textarea,
} from "../../ui";
import { ConfirmDialog, Drawer, DrawerBody, Modal, toast } from "../../ui/overlays";
import { DataTable, DescriptionList, type DataColumns } from "../../ui/data";
import { NumberInput } from "../../ui/inputs";
import { IconLedger, IconWarning } from "../../ui/icons";
import { api } from "../../lib/api";
import {
  CurrencyBlocks,
  PanelSkeleton,
  RETAINAGE_BASES,
  RETAINAGE_RELEASE_STATUSES,
  Reasons,
  RefusalPanel,
  errorMessage,
  isoDate,
  isoDateTime,
  label,
  money,
  percent,
  refusalFrom,
  releaseTone,
  useResource,
  type InvoicingContext,
  type ListResponse,
  type RetainageReleaseRow,
  type RetainageSummary,
  type ServerRefusal,
} from "./invoicingShared";

/* ------------------------------------------------------------------ */
/* Request a release                                                   */
/* ------------------------------------------------------------------ */

function RequestReleaseModal({
  open,
  onClose,
  projectId,
  context,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  projectId: string;
  context: InvoicingContext;
  onCreated: () => void;
}) {
  const [scope, setScope] = useState<"prime_contract" | "commitment">("commitment");
  const [contractId, setContractId] = useState("");
  const [amount, setAmount] = useState<number | null>(null);
  const [basis, setBasis] = useState<string>("percent_work_completed");
  const [newPercent, setNewPercent] = useState<number | null>(null);
  const [effectiveDate, setEffectiveDate] = useState("");
  const [reason, setReason] = useState("");
  const [conditions, setConditions] = useState("");
  const [requiresWaiver, setRequiresWaiver] = useState(true);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<ServerRefusal | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setRefusal(null);
    setError(null);
    try {
      const body: Record<string, unknown> = { scope, basis, requiresLienWaiver: requiresWaiver };
      if (scope === "prime_contract") body["primeContractId"] = contractId;
      else body["commitmentId"] = contractId;
      if (amount !== null) body["amount"] = amount;
      if (newPercent !== null) body["newRetainagePercent"] = newPercent;
      if (effectiveDate) body["effectiveDate"] = effectiveDate;
      if (reason.trim()) body["reason"] = reason.trim();
      if (conditions.trim()) body["conditions"] = conditions.trim();
      await api.post(`/api/v1/projects/${projectId}/retainage-releases`, body);
      toast.success("Retainage release drafted.");
      setContractId("");
      setAmount(null);
      setReason("");
      onCreated();
      onClose();
    } catch (err) {
      const parsed = refusalFrom(err);
      if (parsed) setRefusal(parsed);
      else setError(errorMessage(err, "The release was refused"));
    } finally {
      setBusy(false);
    }
  }

  const options =
    scope === "prime_contract"
      ? context.contracts.map((c) => ({
          id: c.id,
          text: `${c.reference} — ${c.title} (${c.currency})`,
        }))
      : context.commitments.map((c) => ({
          id: c.id,
          text: `${c.reference} — ${c.title} (${c.currency})`,
        }));

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Draft a retainage release"
      description="A release is a record, not a calculation. It brackets the held balance before and after, so it audits itself."
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} loading={busy} disabled={!contractId}>
            Draft release
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <ErrorAlert message={error} />
        <RefusalPanel refusal={refusal} />

        <Field label="Which side" required>
          <Select
            value={scope}
            onChange={(e) => {
              setScope(e.target.value as "prime_contract" | "commitment");
              setContractId("");
            }}
          >
            <option value="commitment">
              We release to a subcontractor — a liability we control
            </option>
            <option value="prime_contract">
              The owner releases to us — an asset we are waiting on
            </option>
          </Select>
        </Field>

        <Field label={scope === "prime_contract" ? "Prime contract" : "Commitment"} required>
          <Select value={contractId} onChange={(e) => setContractId(e.target.value)}>
            <option value="">Select…</option>
            {options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.text}
              </option>
            ))}
          </Select>
        </Field>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label="Amount"
            optional
            hint="Leave blank to release everything currently held — a final release."
          >
            <NumberInput value={amount} onChange={setAmount} precision={2} align="right" min={0} />
          </Field>
          <Field label="Basis" required>
            <Select value={basis} onChange={(e) => setBasis(e.target.value)}>
              {RETAINAGE_BASES.map((b) => (
                <option key={b} value={b}>
                  {label(b)}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label="New retainage rate for future billing"
            optional
            hint="The step-down clause: 10% held until 50% complete, 5% thereafter. A rate change rather than a lump sum."
          >
            <NumberInput
              value={newPercent}
              onChange={setNewPercent}
              precision={3}
              min={0}
              max={100}
              suffix="%"
              align="right"
            />
          </Field>
          <Field label="Effective date" optional>
            <Input
              type="date"
              value={effectiveDate}
              onChange={(e) => setEffectiveDate(e.target.value)}
            />
          </Field>
        </div>

        <Field label="Reason" optional>
          <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        <Field
          label="Conditions"
          optional
          hint="What must hold before the money actually moves."
        >
          <Textarea rows={2} value={conditions} onChange={(e) => setConditions(e.target.value)} />
        </Field>

        <label className="flex items-start gap-2 text-meta text-content-muted">
          <input
            type="checkbox"
            checked={requiresWaiver}
            onChange={(e) => setRequiresWaiver(e.target.checked)}
            className="mt-0.5"
          />
          <span>
            Require a lien waiver before the money moves. Final retainage is the payment most often
            followed by a lien claim.
          </span>
        </label>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Release detail                                                      */
/* ------------------------------------------------------------------ */

function ReleaseDrawer({
  releaseId,
  onClose,
  onChanged,
  context,
}: {
  releaseId: string;
  onClose: () => void;
  onChanged: () => void;
  context: InvoicingContext;
}) {
  const detail = useResource<RetainageReleaseRow>(`/api/v1/retainage-releases/${releaseId}`);
  const release = detail.data;
  const [refusal, setRefusal] = useState<ServerRefusal | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [releasing, setReleasing] = useState(false);
  const [overrideWaiver, setOverrideWaiver] = useState(false);

  const currency =
    release?.currency ??
    (release?.commitmentId
      ? (context.commitmentById.get(release.commitmentId)?.currency ?? null)
      : release?.primeContractId
        ? (context.contractById.get(release.primeContractId)?.currency ?? null)
        : null);

  async function act(path: string, body?: unknown, success?: string) {
    setError(null);
    setRefusal(null);
    try {
      await api.post(`/api/v1/retainage-releases/${releaseId}/${path}`, body ?? {});
      toast.success(success ?? "Done.");
      detail.reload();
      onChanged();
      return true;
    } catch (err) {
      const parsed = refusalFrom(err);
      if (parsed) setRefusal(parsed);
      else setError(errorMessage(err, "The action was refused"));
      return false;
    }
  }

  return (
    <Drawer
      open
      onClose={onClose}
      size="lg"
      title={release ? `${release.reference} — retainage release` : "Retainage release"}
      description={release ? `${label(release.scope)} · ${label(release.status)}` : undefined}
      icon={IconLedger}
    >
      <DrawerBody>
        {detail.loading && !detail.data ? (
          <PanelSkeleton rows={5} />
        ) : detail.error ? (
          <ErrorAlert message={detail.error} />
        ) : release ? (
          <div className="space-y-4">
            <ErrorAlert message={error} />
            <RefusalPanel refusal={refusal} />

            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={releaseTone(release.status)}>{label(release.status)}</Badge>
              <Badge tone="neutral" variant="outline">
                {release.scope === "prime_contract" ? "Owner releases to us" : "We release to a sub"}
              </Badge>
              {release.requiresLienWaiver === 1 ? (
                <Badge tone="warning" variant="outline">
                  lien waiver required
                </Badge>
              ) : null}
            </div>

            {release.stillValid === false ? (
              <Alert
                tone="warning"
                variant="subtle"
                icon={IconWarning}
                title="The held position has moved since this release was drafted"
              >
                This release brackets{" "}
                {money(release.retainageHeldBefore, currency)} as held before, but the schedule of
                values now shows {money(release.currentlyHeld ?? null, currency)}. The server
                re-derives the position at approval and refuses a release larger than what is
                actually held.
              </Alert>
            ) : null}

            {release.rejectionReason ? (
              <Alert tone="danger" variant="subtle" size="sm" title="Rejected">
                {release.rejectionReason}
              </Alert>
            ) : null}

            <Card>
              <CardHeader
                title="The movement"
                subtitle="Bracketed before and after, so the release is self-auditing."
              />
              <CardBody>
                <DescriptionList
                  columns={3}
                  items={[
                    {
                      label: "Held before",
                      value: money(release.retainageHeldBefore, currency),
                    },
                    { label: "Released", value: money(release.amount, currency) },
                    { label: "Held after", value: money(release.retainageHeldAfter, currency) },
                    {
                      label: "Currently held (live)",
                      value:
                        release.currentlyHeld === undefined
                          ? "—"
                          : money(release.currentlyHeld, currency),
                      hint: "re-derived from the SOV just now",
                    },
                    { label: "Basis", value: label(release.basis) },
                    {
                      label: "New rate for future billing",
                      value:
                        release.newRetainagePercent === null
                          ? "unchanged"
                          : percent(release.newRetainagePercent),
                    },
                    { label: "Effective", value: isoDate(release.effectiveDate) },
                    { label: "Released on", value: isoDate(release.releaseDate) },
                    { label: "Requested", value: isoDateTime(release.requestedAt) },
                  ]}
                />
              </CardBody>
            </Card>

            <Card>
              <CardHeader
                title="Approval trail"
                subtitle="The approver may be neither the author nor the requester. That is enforced at the route, not in an editable template."
              />
              <CardBody>
                <DescriptionList
                  columns={2}
                  size="sm"
                  items={[
                    { label: "Drafted by", value: release.createdBy },
                    { label: "Requested by", value: release.requestedBy ?? "—" },
                    { label: "Approved by", value: release.approvedBy ?? "—" },
                    { label: "Approved", value: isoDateTime(release.approvedAt) },
                    { label: "Rejected by", value: release.rejectedBy ?? "—" },
                    { label: "Rejected", value: isoDateTime(release.rejectedAt) },
                  ]}
                />
              </CardBody>
            </Card>

            {release.reason || release.conditions ? (
              <Card>
                <CardHeader title="Reason and conditions" />
                <CardBody className="space-y-2 text-body text-content-muted">
                  {release.reason ? <p>{release.reason}</p> : null}
                  {release.conditions ? (
                    <p>
                      <span className="font-medium text-content">Conditions: </span>
                      {release.conditions}
                    </p>
                  ) : null}
                </CardBody>
              </Card>
            ) : null}

            <div className="flex flex-wrap gap-2 border-t border-border pt-3">
              {release.status === "draft" ? (
                <Button
                  size="sm"
                  onClick={() => void act("submit", {}, "Submitted for approval.")}
                >
                  Submit for approval
                </Button>
              ) : null}
              {release.status === "pending_approval" ? (
                <>
                  <Button size="sm" onClick={() => void act("approve", {}, "Release approved.")}>
                    Approve
                  </Button>
                  <Button size="sm" variant="danger" onClick={() => setRejecting(true)}>
                    Reject
                  </Button>
                </>
              ) : null}
              {release.status === "approved" ? (
                <Button size="sm" onClick={() => setReleasing(true)}>
                  Release the money
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}
      </DrawerBody>

      <Modal
        open={rejecting}
        onClose={() => setRejecting(false)}
        title="Reject this retainage release"
        footer={
          <>
            <Button variant="ghost" onClick={() => setRejecting(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              disabled={!reason.trim()}
              onClick={async () => {
                const ok = await act("reject", { reason: reason.trim() }, "Release rejected.");
                if (ok) {
                  setRejecting(false);
                  setReason("");
                }
              }}
            >
              Reject release
            </Button>
          </>
        }
      >
        <Field label="Reason" required>
          <Textarea rows={4} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
      </Modal>

      <ConfirmDialog
        open={releasing}
        onClose={() => {
          setReleasing(false);
          setOverrideWaiver(false);
        }}
        title="Release the retainage?"
        description="Approval says yes; this does it. The allocation is written back onto the schedule of values, the contract's retainage columns are re-derived, and a step-down rate applies to future billing. This is the payment most often followed by a lien claim."
        destructive
        confirmLabel="Release the money"
        onConfirm={async () => {
          const ok = await act(
            "release",
            overrideWaiver ? { overrideMissingWaiver: true } : {},
            "Retainage released.",
          );
          if (ok) {
            setReleasing(false);
            setOverrideWaiver(false);
          }
          return ok;
        }}
      >
        {release?.requiresLienWaiver === 1 ? (
          <label className="mt-2 flex items-start gap-2 text-meta text-content-muted">
            <input
              type="checkbox"
              checked={overrideWaiver}
              onChange={(e) => setOverrideWaiver(e.target.checked)}
              className="mt-0.5"
            />
            <span>
              Release even though the required lien waiver is not on file. The server refuses
              otherwise, and it is right to.
            </span>
          </label>
        ) : null}
      </ConfirmDialog>
    </Drawer>
  );
}

/* ------------------------------------------------------------------ */
/* The tab                                                             */
/* ------------------------------------------------------------------ */

export default function RetainageTab({
  projectId,
  context,
  selectedReleaseId,
  onSelectRelease,
}: {
  projectId: string;
  context: InvoicingContext;
  selectedReleaseId: string | null;
  onSelectRelease: (id: string | null) => void;
}) {
  const summary = useResource<RetainageSummary>(
    `/api/v1/projects/${projectId}/retainage-summary`,
  );
  const releases = useResource<ListResponse<RetainageReleaseRow>>(
    `/api/v1/projects/${projectId}/retainage-releases?page=1&pageSize=200`,
  );
  const [requesting, setRequesting] = useState(false);

  const columns = useMemo<DataColumns<RetainageReleaseRow>>(
    () => [
      {
        id: "reference",
        header: "Release",
        accessor: "reference",
        type: "code",
        width: 110,
        sticky: "start",
      },
      {
        id: "scope",
        header: "Side",
        accessor: "scope",
        type: "enum",
        width: 190,
        groupable: true,
        options: [
          {
            value: "commitment",
            text: "We release to a sub",
            label: "We release to a sub (payable)",
          },
          {
            value: "prime_contract",
            text: "Owner releases to us",
            label: "Owner releases to us (receivable)",
          },
        ],
        cell: (ctx) =>
          ctx.row.scope === "prime_contract" ? "Owner releases to us" : "We release to a sub",
      },
      {
        id: "against",
        header: "Against",
        accessor: (row: RetainageReleaseRow) =>
          row.scope === "prime_contract"
            ? (context.contractById.get(row.primeContractId ?? "")?.reference ?? "")
            : (context.commitmentById.get(row.commitmentId ?? "")?.reference ?? ""),
        type: "code",
        width: 130,
      },
      {
        id: "vendor",
        header: "Vendor",
        accessor: (row: RetainageReleaseRow) => context.vendorName(row.vendorId) ?? "",
        type: "text",
        width: 180,
      },
      {
        id: "status",
        header: "Status",
        accessor: "status",
        type: "status",
        width: 150,
        groupable: true,
        options: RETAINAGE_RELEASE_STATUSES.map((s) => ({
          value: s,
          text: label(s),
          label: label(s),
          tone: releaseTone(s),
        })),
      },
      {
        id: "retainageHeldBefore",
        header: "Held before",
        accessor: "retainageHeldBefore",
        type: "currency",
        width: 140,
        cell: (ctx) => money(ctx.row.retainageHeldBefore, ctx.row.currency ?? null),
      },
      {
        id: "amount",
        header: "Released",
        accessor: "amount",
        type: "currency",
        width: 140,
        cell: (ctx) => money(ctx.row.amount, ctx.row.currency ?? null),
      },
      {
        id: "retainageHeldAfter",
        header: "Held after",
        accessor: "retainageHeldAfter",
        type: "currency",
        width: 140,
        cell: (ctx) => money(ctx.row.retainageHeldAfter, ctx.row.currency ?? null),
      },
      {
        id: "newRetainagePercent",
        header: "New rate",
        headerTooltip: "The step-down clause: a rate change rather than a lump sum.",
        accessor: "newRetainagePercent",
        type: "percent",
        width: 110,
        cell: (ctx) =>
          ctx.row.newRetainagePercent === null ? (
            <span className="text-content-subtle">unchanged</span>
          ) : (
            percent(ctx.row.newRetainagePercent)
          ),
      },
      {
        id: "requiresLienWaiver",
        header: "Waiver",
        accessor: (row: RetainageReleaseRow) =>
          row.requiresLienWaiver === 1 ? "required" : "not required",
        type: "text",
        width: 110,
        cell: (ctx) =>
          ctx.row.requiresLienWaiver === 1 ? (
            <Badge tone="warning" size="xs">
              required
            </Badge>
          ) : (
            <span className="text-content-subtle">—</span>
          ),
      },
      {
        id: "effectiveDate",
        header: "Effective",
        accessor: "effectiveDate",
        type: "date",
        width: 120,
      },
      {
        id: "approvedBy",
        header: "Approved by",
        accessor: "approvedBy",
        type: "text",
        width: 150,
        defaultHidden: true,
      },
    ],
    [context],
  );

  return (
    <div className="space-y-4">
      <ErrorAlert message={summary.error} />

      {summary.loading && !summary.data ? (
        <PanelSkeleton rows={4} />
      ) : summary.data ? (
        <>
          <div className="grid gap-3 lg:grid-cols-2">
            <Card>
              <CardHeader
                title="Retainage the owner holds from us"
                subtitle="An asset we are waiting on. It is not overdue — it is withheld by agreement."
              />
              <CardBody>
                <CurrencyBlocks
                  blocks={summary.data.receivable.byCurrency}
                  emptyTitle="No retainage receivable"
                  emptyHint="No prime contract on this project is holding retainage. That is a fact about the contracts, not a zero balance nobody checked."
                  render={(block) => (
                    <div className="grid gap-3 rounded-md border border-border p-3 sm:grid-cols-3">
                      <Stat
                        label={`Held (${block.currency})`}
                        value={money(block.retainageHeld, block.currency)}
                        size="sm"
                        tone="warning"
                      />
                      <Stat
                        label="Released to date"
                        value={money(block.retainageReleased, block.currency)}
                        size="sm"
                      />
                      <Stat label="Contracts" value={String(block.contracts)} size="sm" />
                    </div>
                  )}
                />
              </CardBody>
            </Card>

            <Card>
              <CardHeader
                title="Retainage we hold from subcontractors"
                subtitle="A liability we control. Releasing it needs an approval by someone other than the requester."
              />
              <CardBody>
                <CurrencyBlocks
                  blocks={summary.data.payable.byCurrency}
                  emptyTitle="No retainage payable"
                  emptyHint="No commitment on this project is holding retainage from a subcontractor."
                  render={(block) => (
                    <div className="grid gap-3 rounded-md border border-border p-3 sm:grid-cols-3">
                      <Stat
                        label={`Held (${block.currency})`}
                        value={money(block.retainageHeld, block.currency)}
                        size="sm"
                        tone="warning"
                      />
                      <Stat
                        label="Released to date"
                        value={money(block.retainageReleased, block.currency)}
                        size="sm"
                      />
                      <Stat label="Commitments" value={String(block.contracts)} size="sm" />
                    </div>
                  )}
                />
              </CardBody>
            </Card>
          </div>

          <Alert tone="info" variant="subtle" size="sm" title="Why these two are never netted">
            {summary.data.note}
          </Alert>

          <Card>
            <CardHeader
              title="Held position, contract by contract"
              subtitle="Derived from the schedule of values, not from a running balance somebody might have incremented twice."
            />
            <CardBody className="overflow-x-auto">
              <table className="w-full min-w-[40rem] text-meta">
                <thead>
                  <tr className="border-b border-border text-2xs uppercase tracking-wide text-content-subtle">
                    <th className="py-1.5 pr-3 text-left font-semibold">Contract</th>
                    <th className="py-1.5 pr-3 text-left font-semibold">Side</th>
                    <th className="py-1.5 pr-3 text-left font-semibold">Vendor</th>
                    <th className="py-1.5 pr-3 text-right font-semibold">Held</th>
                    <th className="py-1.5 text-right font-semibold">Released</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border-subtle">
                  {[
                    ...summary.data.receivable.contracts.map((c) => ({ ...c, side: "receivable" })),
                    ...summary.data.payable.commitments.map((c) => ({ ...c, side: "payable" })),
                  ].map((row) => (
                    <tr key={`${row.side}-${row.reference}`}>
                      <td className="py-1.5 pr-3">
                        <span className="font-mono text-2xs text-content-subtle">
                          {row.reference}
                        </span>
                        <span className="ml-2 text-content">{row.title}</span>
                      </td>
                      <td className="py-1.5 pr-3 text-content-muted">
                        {row.side === "receivable" ? "Owner holds from us" : "We hold from a sub"}
                      </td>
                      <td className="py-1.5 pr-3 text-content-muted">
                        {context.vendorName(row.vendorId ?? null) ?? "—"}
                      </td>
                      <td className="py-1.5 pr-3 text-right tabular-nums text-content">
                        {money(row.retainageHeld, row.currency)}
                      </td>
                      <td className="py-1.5 text-right tabular-nums text-content-muted">
                        {money(row.retainageReleased, row.currency)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {summary.data.receivable.contracts.length === 0 &&
              summary.data.payable.commitments.length === 0 ? (
                <EmptyState
                  size="sm"
                  title="No contracts holding retainage"
                  hint="Nothing on this project withholds retainage."
                />
              ) : null}
            </CardBody>
          </Card>

          {summary.data.pendingReleases.length > 0 ? (
            <Reasons
              reasons={summary.data.pendingReleases.map(
                (r) =>
                  `${r.reference} (${label(r.scope)}) is ${label(r.status).toLowerCase()} for ${r.amount.toFixed(2)}, effective ${r.effectiveDate ?? "unstated"}.`,
              )}
              tone="warning"
              title={`${summary.data.pendingReleases.length} release(s) awaiting a decision`}
            />
          ) : null}
        </>
      ) : null}

      <DataTable<RetainageReleaseRow>
        tableId={`invoicing:retainage:${projectId}`}
        data={releases.data?.items ?? []}
        columns={columns}
        getRowId={(row) => row.id}
        loading={releases.loading}
        error={releases.error}
        onRetry={releases.reload}
        height={480}
        stickyHeader
        filterRow
        savedViews
        exportFileName={`retainage-releases-${projectId}`}
        searchPlaceholder="Search releases…"
        aria-label="Retainage releases"
        defaultSort={[{ id: "reference", desc: true }]}
        onRowClick={(ctx) => onSelectRelease(ctx.row.id)}
        rowTone={(row) => releaseTone(row.status)}
        empty={{
          icon: IconLedger,
          title: "No retainage releases",
          description:
            "Retainage moves only through an approved release. Nothing has been asked for yet.",
          action: <Button onClick={() => setRequesting(true)}>Draft a release</Button>,
        }}
        toolbarActions={<Button onClick={() => setRequesting(true)}>Draft release</Button>}
      />

      <RequestReleaseModal
        open={requesting}
        onClose={() => setRequesting(false)}
        projectId={projectId}
        context={context}
        onCreated={() => {
          releases.reload();
          summary.reload();
        }}
      />

      {selectedReleaseId ? (
        <ReleaseDrawer
          releaseId={selectedReleaseId}
          onClose={() => onSelectRelease(null)}
          onChanged={() => {
            releases.reload();
            summary.reload();
            context.reload();
          }}
          context={context}
        />
      ) : null}
    </div>
  );
}
