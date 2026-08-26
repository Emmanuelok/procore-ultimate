/**
 * POTENTIAL CHANGE ORDERS — our cost position, priced by cost type.
 *
 * A PCO holds THREE amounts and this screen never collapses them:
 *
 *   estimated   what we think it costs, Σ of the cost lines
 *   quoted      what the subcontractor came back with on the RFQ
 *   carried     the position being taken forward into a COR
 *
 * The variance between the first two is the single most useful early warning
 * in change management — a sub quoting 40% over estimate is a negotiation, not
 * a data-entry step — so it is printed beside them, and printed as "not
 * available" with the server's reason when only one of the two exists.
 *
 * The MARKUP STACK is applied at COR stage, over the whole ask, in a stated
 * order. When this PCO has been rolled into a COR, that COR's stack is shown
 * here in full rather than summarised, because the order it was applied in is
 * what a disputed change order turns on.
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
import {
  ConfirmDialog,
  Drawer,
  DrawerBody,
  DrawerFooter,
  Modal,
  toast,
} from "../../ui/overlays";
import { DataTable, DescriptionList, type DataColumns } from "../../ui/data";
import { NumberInput } from "../../ui/inputs";
import { IconCommitment, IconVendor } from "../../ui/icons";
import { api } from "../../lib/api";
import CostLines from "./CostLines";
import MarkupStackTable from "./MarkupStack";
import {
  ComponentValue,
  PCO_STATUSES,
  PanelSkeleton,
  Reasons,
  days,
  errorMessage,
  isoDate,
  label,
  money,
  pcoTone,
  quoteTone,
  refusalFrom,
  useResource,
  type ChangeChain,
  type ChangeContext,
  type CorDetail,
  type PcoDetail,
  type PcoRow,
} from "./changesShared";

const PCO_EDITABLE = new Set(["draft", "pending_quote", "priced"]);

/* ------------------------------------------------------------------ */
/* Create                                                              */
/* ------------------------------------------------------------------ */

function CreatePcoModal({
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
  const [changeEventId, setChangeEventId] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [commitmentId, setCommitmentId] = useState("");
  const [vendorId, setVendorId] = useState("");
  const [scheduleImpactDays, setScheduleImpactDays] = useState<number | null>(null);
  const [copyEventLines, setCopyEventLines] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { title: title.trim() };
      if (changeEventId) body["changeEventId"] = changeEventId;
      if (description.trim()) body["description"] = description.trim();
      if (commitmentId) body["commitmentId"] = commitmentId;
      if (vendorId) body["vendorId"] = vendorId;
      if (scheduleImpactDays !== null) body["scheduleImpactDays"] = scheduleImpactDays;
      if (changeEventId && copyEventLines) body["copyEventLines"] = true;
      await api.post(`/api/v1/projects/${projectId}/potential-change-orders`, body);
      toast.success("Potential change order raised.");
      setTitle("");
      setDescription("");
      onCreated();
      onClose();
    } catch (err) {
      setError(errorMessage(err, "Could not raise this PCO"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Raise a potential change order"
      description="One PCO per affected commitment, plus one for self-performed work. This is where a change event stops being a narrative and becomes money we will owe."
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} loading={busy} disabled={!title.trim()}>
            Raise PCO
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <ErrorAlert message={error} />
        <Field label="Change event" hint="A PCO without an event is legal but rare.">
          <Select value={changeEventId} onChange={(e) => setChangeEventId(e.target.value)}>
            <option value="">No change event</option>
            {chain.events
              .filter((e) => e.status !== "void")
              .map((e) => (
                <option key={e.id} value={e.id}>
                  {e.reference} — {e.title}
                </option>
              ))}
          </Select>
        </Field>
        <Field label="Title" required>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <Field label="Scope being priced" optional>
          <Textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label="Commitment"
            optional
            hint="The subcontract whose scope this changes. Leave blank for self-performed work."
          >
            <Select value={commitmentId} onChange={(e) => setCommitmentId(e.target.value)}>
              <option value="">Self-performed / not yet bought</option>
              {context.commitments.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.reference} — {c.title} ({c.currency})
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Vendor" optional>
            <Select value={vendorId} onChange={(e) => setVendorId(e.target.value)}>
              <option value="">Not stated</option>
              {context.vendors.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
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
          <Field label="Cost lines">
            <label className="flex items-center gap-2 text-meta text-content-muted">
              <input
                type="checkbox"
                checked={copyEventLines}
                disabled={!changeEventId}
                onChange={(e) => setCopyEventLines(e.target.checked)}
              />
              Copy the change event's cost lines forward
            </label>
          </Field>
        </div>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Detail                                                              */
/* ------------------------------------------------------------------ */

function PcoDrawer({
  projectId,
  pcoId,
  onClose,
  onChanged,
  context,
  onOpenQuotes,
}: {
  projectId: string;
  pcoId: string;
  onClose: () => void;
  onChanged: () => void;
  context: ChangeContext;
  onOpenQuotes: (pcoId: string) => void;
}) {
  const detail = useResource<PcoDetail>(
    `/api/v1/projects/${projectId}/potential-change-orders/${pcoId}`,
  );
  const pco = detail.data?.pco ?? null;
  const corDetail = useResource<CorDetail>(
    pco?.changeOrderRequestId
      ? `/api/v1/projects/${projectId}/change-order-requests/${pco.changeOrderRequestId}`
      : null,
  );

  const [actionError, setActionError] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [noChargeOpen, setNoChargeOpen] = useState(false);
  const [noChargeReason, setNoChargeReason] = useState("");

  const currency =
    context.commitmentCurrency(pco?.commitmentId ?? null) ??
    context.contractCurrency(pco?.primeContractId ?? null);

  async function act(path: string, body?: unknown, success?: string) {
    setActionError(null);
    try {
      await api.post(
        `/api/v1/projects/${projectId}/potential-change-orders/${pcoId}/${path}`,
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

  const editable = pco ? PCO_EDITABLE.has(pco.status) : false;

  return (
    <Drawer
      open
      onClose={onClose}
      size="xl"
      title={pco ? `${pco.reference} — ${pco.title}` : "Potential change order"}
      description={
        pco
          ? `${label(pco.status)} · ${
              pco.commitmentId
                ? (context.commitmentById.get(pco.commitmentId)?.reference ?? "commitment")
                : "self-performed"
            }`
          : undefined
      }
      icon={IconCommitment}
      footer={
        <DrawerFooter align="between">
          <span className="text-2xs text-content-subtle">
            Approval is refused for the author and the submitter — segregation of duties, enforced
            at the route rather than in a template anyone can edit.
          </span>
          <span className="flex flex-wrap gap-2">
            {pco && PCO_EDITABLE.has(pco.status) ? (
              <Button size="sm" variant="secondary" onClick={() => void act("price", {}, "Priced from the cost lines.")}>
                Price from lines
              </Button>
            ) : null}
            {pco?.status === "priced" ? (
              <Button size="sm" onClick={() => void act("submit", {}, "Submitted for approval.")}>
                Submit
              </Button>
            ) : null}
            {pco?.status === "submitted" ? (
              <Button size="sm" onClick={() => void act("approve", {}, "Approved.")}>
                Approve
              </Button>
            ) : null}
            {pco && ["submitted", "priced"].includes(pco.status) ? (
              <Button size="sm" variant="danger" onClick={() => setRejecting(true)}>
                Reject
              </Button>
            ) : null}
            {pco && ["draft", "pending_quote", "priced", "submitted"].includes(pco.status) ? (
              <Button size="sm" variant="ghost" onClick={() => setNoChargeOpen(true)}>
                No charge
              </Button>
            ) : null}
          </span>
        </DrawerFooter>
      }
    >
      <DrawerBody>
        {detail.loading && !detail.data ? (
          <PanelSkeleton rows={6} />
        ) : detail.error ? (
          <ErrorAlert message={detail.error} />
        ) : detail.data && pco ? (
          <div className="space-y-4">
            <ErrorAlert message={actionError} />

            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={pcoTone(pco.status)}>{label(pco.status)}</Badge>
              {pco.noCharge === 1 ? <Badge tone="neutral">No charge — absorbed</Badge> : null}
              {pco.changeOrderRequestId ? <Badge tone="info">Inside a COR</Badge> : null}
              {pco.changeOrderPackageId ? <Badge tone="success">Inside a package</Badge> : null}
              <span className="text-2xs text-content-subtle">
                Currency {currency ?? "unknown — no commitment or contract attached"}
              </span>
            </div>

            {pco.rejectionReason ? (
              <Alert tone="danger" variant="subtle" size="sm" title="Rejected">
                {pco.rejectionReason}
              </Alert>
            ) : null}

            {/* ---- the three positions ---- */}
            <Card>
              <CardHeader
                title="Three positions, never collapsed"
                subtitle="Our estimate, the sub's quote, and the number being carried forward. The gap between the first two is the early warning."
              />
              <CardBody>
                <DescriptionList
                  columns={3}
                  items={[
                    {
                      label: "Our estimate",
                      value: money(detail.data.positions.estimatedAmount, currency),
                      hint: "Σ of the cost lines below",
                    },
                    {
                      label: "Subcontractor quote",
                      value:
                        detail.data.positions.quotedAmount === 0 ? (
                          <span className="text-content-subtle italic">
                            No quote accepted yet
                          </span>
                        ) : (
                          money(detail.data.positions.quotedAmount, currency)
                        ),
                    },
                    {
                      label: "Position carried forward",
                      value: money(detail.data.positions.amount, currency),
                      hint: "the number a COR will be built on",
                    },
                    {
                      label: "Quote vs estimate",
                      value: (
                        <ComponentValue
                          component={detail.data.positions.quoteVariance}
                          currency={currency}
                        />
                      ),
                      span: 2,
                    },
                    {
                      label: "Quote vs estimate (%)",
                      value: (
                        <ComponentValue
                          component={detail.data.positions.quoteVariancePercent}
                          format="percent"
                        />
                      ),
                    },
                    { label: "Days claimed", value: days(pco.scheduleImpactDays) },
                    { label: "Due", value: isoDate(pco.dueDate) },
                    {
                      label: "Vendor",
                      value: context.vendorName(pco.vendorId) ?? "—",
                    },
                  ]}
                />
              </CardBody>
            </Card>

            {/* ---- cost lines ---- */}
            <CostLines
              basePath={`/api/v1/projects/${projectId}/potential-change-orders/${pcoId}`}
              lines={detail.data.lines}
              totals={detail.data.totals}
              currency={currency}
              editable={editable}
              frozenReason={`This PCO is "${label(pco.status)}". A priced position that can be edited after it has been put to someone is not a position.`}
              onChanged={() => {
                detail.reload();
                onChanged();
              }}
            />

            {/* ---- the markup stack ---- */}
            {corDetail.data ? (
              <MarkupStackTable
                stack={corDetail.data.markupStack}
                currency={context.contractCurrency(
                  corDetail.data.changeOrderRequest.primeContractId,
                )}
                title={`Markup stack applied on ${corDetail.data.changeOrderRequest.reference}`}
                subtitle="This PCO has been rolled into a change order request. The stack below is the one the owner is being asked to pay, in the order it was applied."
              />
            ) : (
              <Alert
                tone="info"
                variant="subtle"
                size="sm"
                title="No markup stack applies yet"
              >
                Overhead, profit, bond and insurance are charged on the change order request, over
                the whole ask, in a stated order — not on the PCO. Roll this PCO into a COR to see
                the build-up.
              </Alert>
            )}

            {/* ---- RFQs ---- */}
            <Card>
              <CardHeader
                title="Quotes requested against this PCO"
                subtitle="The RFQ is how a PCO gets a real number instead of an estimate."
                actions={
                  <Button size="sm" variant="secondary" onClick={() => onOpenQuotes(pcoId)}>
                    Open the RFQ comparison
                  </Button>
                }
              />
              <CardBody>
                {detail.data.quoteRequests.length === 0 ? (
                  <EmptyState
                    size="sm"
                    title="No RFQ issued"
                    hint="A PCO priced only from our own estimate carries no evidence that the sub agrees with it."
                  />
                ) : (
                  <ul className="space-y-1">
                    {detail.data.quoteRequests.map((quote) => (
                      <li
                        key={quote.id}
                        className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border-subtle px-2.5 py-1.5 text-meta"
                      >
                        <span className="flex items-center gap-2">
                          <span className="font-mono text-2xs text-content-subtle">
                            {quote.reference}
                          </span>
                          <IconVendor size={12} className="text-content-subtle" />
                          <span className="text-content">
                            {context.vendorName(quote.vendorId) ?? "Vendor not named"}
                          </span>
                          <Badge tone={quoteTone(quote.status)} size="xs">
                            {label(quote.status)}
                          </Badge>
                        </span>
                        <span className="tabular-nums text-content">
                          {quote.quotedAmount === null ? (
                            <span className="text-content-subtle italic">
                              no number returned
                            </span>
                          ) : (
                            money(quote.quotedAmount, currency)
                          )}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </CardBody>
            </Card>
          </div>
        ) : null}
      </DrawerBody>

      <Modal
        open={rejecting}
        onClose={() => setRejecting(false)}
        title="Reject this PCO"
        description="A rejection always carries a reason. It is recorded on the row and in the ledger."
        footer={
          <>
            <Button variant="ghost" onClick={() => setRejecting(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              disabled={!rejectReason.trim()}
              onClick={async () => {
                const ok = await act(
                  "reject",
                  { rejectionReason: rejectReason.trim() },
                  "Rejected.",
                );
                if (ok) {
                  setRejecting(false);
                  setRejectReason("");
                }
              }}
            >
              Reject PCO
            </Button>
          </>
        }
      >
        <Field label="Reason" required>
          <Textarea
            rows={4}
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
          />
        </Field>
      </Modal>

      <ConfirmDialog
        open={noChargeOpen}
        onClose={() => setNoChargeOpen(false)}
        title="Mark this PCO as no charge?"
        description="The subcontractor absorbs it. The PCO is RECORDED as no-charge rather than deleted, because 'how many changes did this subcontractor absorb' is a real commercial question. The carried amount goes to zero."
        confirmLabel="Record as no charge"
        onConfirm={async () => {
          const ok = await act(
            "no-charge",
            noChargeReason.trim() ? { reason: noChargeReason.trim() } : {},
            "Recorded as no charge.",
          );
          if (ok) {
            setNoChargeOpen(false);
            setNoChargeReason("");
          }
          return ok;
        }}
      >
        <Field label="Why is it absorbed?" optional>
          <Textarea
            rows={3}
            value={noChargeReason}
            onChange={(e) => setNoChargeReason(e.target.value)}
          />
        </Field>
      </ConfirmDialog>
    </Drawer>
  );
}

/* ------------------------------------------------------------------ */
/* Register                                                            */
/* ------------------------------------------------------------------ */

export default function PcoTab({
  projectId,
  chain,
  context,
  selectedPcoId,
  onSelectPco,
  onOpenQuotes,
}: {
  projectId: string;
  chain: ChangeChain;
  context: ChangeContext;
  selectedPcoId: string | null;
  onSelectPco: (id: string | null) => void;
  onOpenQuotes: (pcoId: string) => void;
}) {
  const [creating, setCreating] = useState(false);
  const eventByIdRef = useMemo(
    () => new Map(chain.events.map((e) => [e.id, e])),
    [chain.events],
  );

  const currencyOf = (row: PcoRow): string | null =>
    context.commitmentCurrency(row.commitmentId) ?? context.contractCurrency(row.primeContractId);

  const columns = useMemo<DataColumns<PcoRow>>(
    () => [
      {
        id: "reference",
        header: "Number",
        accessor: "reference",
        type: "code",
        width: 110,
        sticky: "start",
      },
      { id: "title", header: "Title", accessor: "title", type: "text", width: 260 },
      {
        id: "event",
        header: "Change event",
        accessor: (row: PcoRow) =>
          row.changeEventId ? (eventByIdRef.get(row.changeEventId)?.reference ?? "") : "",
        type: "code",
        width: 120,
        cell: (ctx) =>
          ctx.row.changeEventId ? (
            (eventByIdRef.get(ctx.row.changeEventId)?.reference ?? ctx.row.changeEventId)
          ) : (
            <span className="text-content-subtle" title="Raised without a change event.">
              none
            </span>
          ),
      },
      {
        id: "commitment",
        header: "Commitment / vendor",
        accessor: (row: PcoRow) =>
          row.commitmentId
            ? (context.commitmentById.get(row.commitmentId)?.reference ?? row.commitmentId)
            : (context.vendorName(row.vendorId) ?? "Self-performed"),
        type: "text",
        width: 200,
      },
      {
        id: "status",
        header: "Status",
        accessor: "status",
        type: "status",
        width: 130,
        groupable: true,
        options: PCO_STATUSES.map((s) => ({
          value: s,
          text: label(s),
          label: label(s),
          tone: pcoTone(s),
        })),
      },
      {
        id: "estimatedAmount",
        header: "Estimated",
        accessor: "estimatedAmount",
        type: "currency",
        width: 130,
        aggregate: "sum",
        cell: (ctx) => money(ctx.row.estimatedAmount, currencyOf(ctx.row)),
      },
      {
        id: "quotedAmount",
        header: "Quoted",
        accessor: "quotedAmount",
        type: "currency",
        width: 130,
        aggregate: "sum",
        cell: (ctx) =>
          ctx.row.quotedAmount === 0 ? (
            <span className="text-content-subtle" title="No subcontractor quote has been accepted.">
              —
            </span>
          ) : (
            money(ctx.row.quotedAmount, currencyOf(ctx.row))
          ),
      },
      {
        id: "amount",
        header: "Carried",
        headerTooltip: "The position taken forward into a change order request.",
        accessor: "amount",
        type: "currency",
        width: 130,
        aggregate: "sum",
        cell: (ctx) => money(ctx.row.amount, currencyOf(ctx.row)),
      },
      {
        id: "variance",
        header: "Quote vs estimate",
        accessor: (row: PcoRow) =>
          row.quotedAmount !== 0 && row.estimatedAmount !== 0
            ? row.quotedAmount - row.estimatedAmount
            : null,
        type: "currency",
        width: 150,
        signColor: true,
        cell: (ctx) =>
          ctx.row.quotedAmount !== 0 && ctx.row.estimatedAmount !== 0 ? (
            money(ctx.row.quotedAmount - ctx.row.estimatedAmount, currencyOf(ctx.row))
          ) : (
            <span
              className="text-content-subtle italic"
              title="A quote variance needs both our estimate and the subcontractor's quote; this PCO holds only one of them."
            >
              not available
            </span>
          ),
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
        id: "currency",
        header: "Currency",
        accessor: (row: PcoRow) => currencyOf(row) ?? "",
        type: "text",
        width: 100,
        cell: (ctx) =>
          currencyOf(ctx.row) ?? (
            <span className="text-content-subtle" title="Neither a commitment nor a prime contract is attached.">
              unknown
            </span>
          ),
      },
    ],
    [context, eventByIdRef],
  );

  const mixed = context.currencies.length > 1;

  return (
    <div className="space-y-3">
      <ErrorAlert message={chain.error} />
      {mixed ? (
        <Reasons
          reasons={[
            `This project prices change in ${context.currencies.join(", ")}. Column footers add rows that are not in the same currency — read the per-currency reconciliation on the change log instead.`,
          ]}
          tone="warning"
          title="Mixed currency"
        />
      ) : null}

      <DataTable<PcoRow>
        tableId={`changes:pcos:${projectId}`}
        data={chain.pcos}
        columns={columns}
        getRowId={(row) => row.id}
        loading={chain.loading}
        error={chain.error}
        onRetry={chain.reload}
        height={620}
        stickyHeader
        showFooter={!mixed}
        filterRow
        savedViews
        exportFileName={`potential-change-orders-${projectId}`}
        searchPlaceholder="Search PCOs…"
        aria-label="Potential change orders"
        defaultSort={[{ id: "reference", desc: true }]}
        onRowClick={(ctx) => onSelectPco(ctx.row.id)}
        rowTone={(row) => pcoTone(row.status)}
        empty={{
          icon: IconCommitment,
          title: "Nothing priced yet",
          description:
            "Every change event with no PCO underneath it is exposure nobody has put a number on.",
          action: <Button onClick={() => setCreating(true)}>Raise a PCO</Button>,
        }}
        toolbarActions={<Button onClick={() => setCreating(true)}>Raise PCO</Button>}
      />

      <CreatePcoModal
        open={creating}
        onClose={() => setCreating(false)}
        projectId={projectId}
        chain={chain}
        context={context}
        onCreated={chain.reload}
      />

      {selectedPcoId ? (
        <PcoDrawer
          projectId={projectId}
          pcoId={selectedPcoId}
          onClose={() => onSelectPco(null)}
          onChanged={chain.reload}
          context={context}
          onOpenQuotes={onOpenQuotes}
        />
      ) : null}
    </div>
  );
}
