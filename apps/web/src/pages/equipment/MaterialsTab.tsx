/**
 * MATERIALS — deliveries with their discrepancies, and a stock ledger whose
 * balance has to reconcile to its own movements.
 *
 * Two controls carry this tab:
 *
 *  · THE THREE-WAY MATCH. An unmatched delivery is either unbilled cost the
 *    supplier will claim later — usually at final account, when there is no
 *    budget left for it — or cost already paid twice. Both are found by
 *    asking; neither is found by waiting. Values are reported per currency
 *    and never added.
 *
 *  · THE STOCK RECONCILIATION. The materialized balance is replayed against
 *    the movements that produced it. A balance that has drifted is worse than
 *    no balance at all, because it is a number people order against. Where the
 *    replay and the record disagree the screen says so, names the difference,
 *    and points at the movement where the drift entered.
 */
import { useMemo, useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  DescriptionList,
  EmptyState,
  SegmentedControl,
  SkeletonTable,
  Table,
  TBody,
  Td,
  Th,
  THead,
  Tooltip,
  Tr,
} from "../../ui";
import { DataTable, type DataColumns } from "../../ui/data";
import type { Tone } from "../../ui/tokens";
import { IconMaterial, IconWarning } from "../../ui/icons";
import {
  CurrencyRail,
  DISCREPANCY_LABEL,
  EM_DASH,
  LoadError,
  ReasonList,
  SectionHeading,
  dateTime,
  isoDate,
  labelize,
  money,
  quantity,
  type DeliveryDetail,
  type DeliveryRow,
  type InvoiceMatchReport,
  type ListResponse,
  type Loadable,
  type MaterialRow,
  type StockLedger,
  type StockMovementRow,
} from "./equipmentShared";

type View = "deliveries" | "match" | "stock";

export default function MaterialsTab({
  deliveries,
  invoiceMatch,
  materials,
  selectedItemId,
  onSelectItem,
  ledger,
  movements,
  selectedDeliveryId,
  onSelectDelivery,
  deliveryDetail,
}: {
  deliveries: Loadable<ListResponse<DeliveryRow>>;
  invoiceMatch: Loadable<InvoiceMatchReport>;
  materials: Loadable<ListResponse<MaterialRow>>;
  selectedItemId: string | null;
  onSelectItem: (itemId: string | null) => void;
  ledger: Loadable<StockLedger>;
  movements: Loadable<ListResponse<StockMovementRow>>;
  selectedDeliveryId: string | null;
  onSelectDelivery: (deliveryId: string | null) => void;
  deliveryDetail: Loadable<DeliveryDetail>;
}) {
  const [view, setView] = useState<View>("deliveries");

  const deliveryRows = useMemo(() => deliveries.data?.items ?? [], [deliveries.data]);
  const discrepant = deliveryRows.filter((row) => row.hasDiscrepancy);
  const discrepantWithoutNcr = discrepant.filter((row) => row.ncrId === null);

  return (
    <div className="space-y-4">
      <Card>
        <CardBody className="space-y-3">
          <SectionHeading
            title="Materials"
            hint="What arrived, what was wrong with it, and whether the compound's balance still agrees with the movements that produced it."
            className="mb-0"
          />
          <SegmentedControl<View>
            value={view}
            onChange={setView}
            size="sm"
            aria-label="Materials view"
            options={[
              { value: "deliveries", label: `Deliveries (${deliveryRows.length})` },
              {
                value: "match",
                label: `Invoice match (${invoiceMatch.data?.unmatchedCount ?? 0} unmatched)`,
              },
              { value: "stock", label: "Stock ledger" },
            ]}
          />
        </CardBody>
      </Card>

      {view === "deliveries" ? (
        <DeliveriesView
          deliveries={deliveries}
          discrepant={discrepant.length}
          discrepantWithoutNcr={discrepantWithoutNcr.length}
          selectedDeliveryId={selectedDeliveryId}
          onSelectDelivery={onSelectDelivery}
          detail={deliveryDetail}
        />
      ) : view === "match" ? (
        <InvoiceMatchView report={invoiceMatch} />
      ) : (
        <StockView
          materials={materials}
          selectedItemId={selectedItemId}
          onSelectItem={onSelectItem}
          ledger={ledger}
          movements={movements}
        />
      )}
    </div>
  );
}

/* ========================================================================== */
/* Deliveries                                                                  */
/* ========================================================================== */

function DeliveriesView({
  deliveries,
  discrepant,
  discrepantWithoutNcr,
  selectedDeliveryId,
  onSelectDelivery,
  detail,
}: {
  deliveries: Loadable<ListResponse<DeliveryRow>>;
  discrepant: number;
  discrepantWithoutNcr: number;
  selectedDeliveryId: string | null;
  onSelectDelivery: (deliveryId: string | null) => void;
  detail: Loadable<DeliveryDetail>;
}) {
  const rows = useMemo(() => deliveries.data?.items ?? [], [deliveries.data]);

  const columns = useMemo<DataColumns<DeliveryRow>>(
    () => [
      {
        id: "reference",
        header: "Delivery",
        accessor: "reference",
        type: "code",
        sticky: "start",
        width: 118,
        mono: true,
      },
      {
        id: "deliveryNoteNumber",
        header: "Note no.",
        accessor: (row) => row.deliveryNoteNumber ?? "",
        type: "code",
        width: 140,
        mono: true,
      },
      {
        id: "status",
        header: "Status",
        accessor: "status",
        type: "status",
        width: 160,
        groupable: true,
        cell: ({ row }) => (
          <Badge tone={deliveryTone(row.status)} size="xs" dot>
            {labelize(row.status)}
          </Badge>
        ),
      },
      {
        id: "receivedAt",
        header: "Received",
        accessor: (row) => row.receivedAt ?? "",
        type: "text",
        width: 165,
        cell: ({ row }) => <span className="text-content-muted">{dateTime(row.receivedAt)}</span>,
      },
      {
        id: "discrepancy",
        header: "Discrepancy",
        headerTooltip:
          "Recorded per line, because a delivery is short on one item and damaged on another — and the supplier's invoice will claim all of it. This is the difference between a credit note and an argument.",
        accessor: (row) => (row.hasDiscrepancy ? "yes" : "no"),
        type: "enum",
        width: 250,
        options: [
          { value: "yes", label: "Discrepant", text: "Discrepant", tone: "danger" },
          { value: "no", label: "Clean", text: "Clean", tone: "success" },
        ],
        cell: ({ row }) =>
          row.hasDiscrepancy ? (
            <span className="flex flex-wrap items-center gap-1">
              {row.discrepancyKinds.slice(0, 2).map((kind) => (
                <Badge key={kind} tone="danger" size="xs" variant="outline">
                  {DISCREPANCY_LABEL[kind] ?? labelize(kind)}
                </Badge>
              ))}
              {row.discrepancyKinds.length > 2 ? (
                <Badge tone="neutral" size="xs">
                  +{row.discrepancyKinds.length - 2}
                </Badge>
              ) : null}
              {row.ncrId === null ? (
                <Tooltip content="This delivery has a recorded discrepancy and no NCR is linked. If the material was rejected on quality grounds, raise the NCR in the quality module and link it here — the delivery record is evidence for the NCR, not a substitute for it.">
                  <span>
                    <Badge tone="warning" size="xs" icon={IconWarning}>
                      no NCR
                    </Badge>
                  </span>
                </Tooltip>
              ) : null}
            </span>
          ) : (
            <span className="text-2xs text-content-subtle">clean</span>
          ),
      },
      {
        id: "invoiceMatched",
        header: "Invoice",
        accessor: (row) => (row.invoiceMatched ? "matched" : "unmatched"),
        type: "enum",
        width: 140,
        options: [
          { value: "matched", label: "Matched", text: "Matched", tone: "success" },
          { value: "unmatched", label: "Unmatched", text: "Unmatched", tone: "warning" },
        ],
        cell: ({ row }) =>
          row.invoiceMatched ? (
            <Badge tone="success" size="xs" variant="outline">
              Matched
            </Badge>
          ) : (
            <Badge tone="warning" size="xs">
              Unmatched
            </Badge>
          ),
      },
      {
        id: "totalValue",
        header: "Value",
        accessor: "totalValue",
        type: "custom",
        align: "right",
        width: 150,
        aggregate: "none",
        cell: ({ row }) =>
          row.totalValue === null ? (
            <Tooltip content="This delivery carries no value, so the exposure cannot be stated. Price the lines, or the match is only a tick and not a control.">
              <span>
                <Badge tone="neutral" size="xs" variant="outline">
                  unpriced
                </Badge>
              </span>
            </Tooltip>
          ) : (
            <span className="tabular-nums">{money(row.totalValue, row.currency)}</span>
          ),
        toCsv: ({ row }) => (row.totalValue === null ? "" : `${row.totalValue} ${row.currency}`),
      },
      {
        id: "lineCount",
        header: "Lines",
        accessor: "lineCount",
        type: "number",
        align: "right",
        width: 90,
        aggregate: "sum",
      },
      {
        id: "waitingMinutes",
        header: "Waiting",
        headerTooltip: "Time the vehicle stood on site. A real cost the haulier will charge for.",
        accessor: "waitingMinutes",
        type: "custom",
        align: "right",
        width: 110,
        aggregate: "none",
        defaultHidden: true,
        cell: ({ row }) =>
          row.waitingMinutes === null ? (
            <span className="text-content-subtle">{EM_DASH}</span>
          ) : (
            <span className="tabular-nums">{row.waitingMinutes} min</span>
          ),
      },
      {
        id: "verifiedBy",
        header: "Verified",
        headerTooltip:
          "Verification of the receipt — never the person who signed for it. The signature says material arrived; the verification says the delivery note matches what is standing in the compound.",
        accessor: (row) => (row.verifiedBy ? "yes" : "no"),
        type: "enum",
        width: 120,
        cell: ({ row }) =>
          row.verifiedBy ? (
            <Badge tone="success" size="xs" variant="outline">
              checked
            </Badge>
          ) : (
            <Badge tone="warning" size="xs">
              unchecked
            </Badge>
          ),
      },
    ],
    [],
  );

  if (deliveries.error) return <LoadError message={deliveries.error} onRetry={deliveries.reload} />;
  if (deliveries.loading && rows.length === 0) return <SkeletonTable rows={8} columns={7} />;

  return (
    <div className="space-y-4">
      {discrepantWithoutNcr > 0 ? (
        <Alert
          tone="warning"
          title={`${discrepantWithoutNcr} discrepant deliver${discrepantWithoutNcr === 1 ? "y has" : "ies have"} no NCR raised`}
        >
          A discrepancy recorded on a delivery note and never escalated is a credit note nobody
          claimed and a quality decision nobody made. If the material was rejected on quality
          grounds the NCR belongs in the quality module — this record is the evidence for it, not a
          substitute.
        </Alert>
      ) : null}

      <Card>
        <CardBody className="flex flex-wrap items-center gap-2">
          <Badge tone="neutral" size="sm">
            {rows.length} deliver{rows.length === 1 ? "y" : "ies"}
          </Badge>
          <Badge tone={discrepant > 0 ? "danger" : "success"} size="sm" dot>
            {discrepant} with a discrepancy
          </Badge>
          <Badge tone={discrepantWithoutNcr > 0 ? "warning" : "neutral"} size="sm">
            {discrepantWithoutNcr} without an NCR
          </Badge>
        </CardBody>
      </Card>

      {rows.length === 0 ? (
        <EmptyState
          icon={IconMaterial}
          title="Nothing has been delivered to this project yet"
          hint="A delivery record is what turns a delivery note into evidence: the quantities expected against received against accepted, the batch and heat numbers a structural sign-off depends on, and the three-way match against the invoice. None exists here yet."
        />
      ) : (
        <DataTable<DeliveryRow>
          tableId="material-deliveries"
          data={rows}
          columns={columns}
          getRowId={(row) => row.id}
          loading={deliveries.loading}
          height={520}
          stickyHeader
          gridLines
          filterRow
          exportFileName="material-deliveries"
          searchPlaceholder="Search deliveries…"
          defaultSort={[{ id: "receivedAt", desc: true }]}
          rowTone={(row) => (row.hasDiscrepancy ? ("danger" as Tone) : undefined)}
          onRowClick={({ row }) => onSelectDelivery(row.id)}
          rowActions={(row) => [
            { id: "open", label: "Open the delivery", onSelect: () => onSelectDelivery(row.id) },
          ]}
          empty={{ title: "No deliveries" }}
          aria-label="Material deliveries"
        />
      )}

      {selectedDeliveryId ? (
        <DeliveryPanel detail={detail} onClose={() => onSelectDelivery(null)} />
      ) : null}
    </div>
  );
}

function DeliveryPanel({
  detail,
  onClose,
}: {
  detail: Loadable<DeliveryDetail>;
  onClose: () => void;
}) {
  if (detail.error) return <LoadError message={detail.error} onRetry={detail.reload} />;
  if (detail.loading && !detail.data) return <SkeletonTable rows={5} columns={5} />;
  const data = detail.data;
  if (!data) return null;

  return (
    <Card>
      <CardBody className="space-y-3">
        <SectionHeading
          title={
            <span className="flex flex-wrap items-center gap-2">
              <span className="font-mono">{data.reference}</span>
              <Badge tone={deliveryTone(data.status)} size="xs" dot>
                {labelize(data.status)}
              </Badge>
              {data.hasDiscrepancy ? (
                <Badge tone="danger" size="xs">
                  {data.derived.discrepantLineCount} discrepant line
                  {data.derived.discrepantLineCount === 1 ? "" : "s"}
                </Badge>
              ) : null}
            </span>
          }
          hint={`Delivery note ${data.deliveryNoteNumber ?? "not recorded"} · received ${dateTime(data.receivedAt)} · signed for by ${data.receivedByName ?? "nobody named"}`}
          className="mb-0"
          actions={
            <Button size="sm" variant="ghost" onClick={onClose}>
              Close
            </Button>
          }
        />

        <DescriptionList
          columns={3}
          size="sm"
          items={[
            { label: "Supplier", value: data.supplierVendorId ?? EM_DASH },
            { label: "Purchase order", value: data.purchaseOrderRef ?? EM_DASH },
            { label: "Carrier", value: data.carrierName ?? EM_DASH },
            { label: "Vehicle", value: data.vehicleRegistration ?? EM_DASH },
            {
              label: "Value",
              value:
                data.totalValue === null ? "Not priced" : money(data.totalValue, data.currency),
            },
            {
              label: "Waiting on site",
              value: data.waitingMinutes === null ? EM_DASH : `${data.waitingMinutes} min`,
            },
          ]}
        />

        {data.derived.ncrCandidate ? (
          <Alert tone="warning" size="sm" title="No NCR is linked">
            {data.derived.ncrCandidate}
          </Alert>
        ) : null}
        {data.derived.invoiceMatchNote ? (
          <Alert tone="info" size="sm" title="Not matched to an invoice">
            {data.derived.invoiceMatchNote}
          </Alert>
        ) : null}
        {data.derived.certificateCoverage.note ? (
          <Alert tone="warning" size="sm" title="No line carries a certificate">
            {data.derived.certificateCoverage.note}
          </Alert>
        ) : null}

        <Table dense tableClassName="min-w-[720px] text-meta">
            <THead>
              <Tr>
                <Th>Line</Th>
                <Th align="right">Expected</Th>
                <Th align="right">Received</Th>
                <Th align="right">Accepted</Th>
                <Th align="right">Rejected</Th>
                <Th>Discrepancy</Th>
                <Th>Traceability</Th>
              </Tr>
            </THead>
            <TBody>
              {data.lines.map((line) => (
                <Tr key={line.id} className={line.discrepancyKind !== "none" ? "bg-danger-subtle" : ""}>
                  <Td>
                    <div className="text-content">{line.description}</div>
                    {line.rejectionReason ? (
                      <div className="text-2xs text-danger-fg">{line.rejectionReason}</div>
                    ) : null}
                  </Td>
                  <Td align="right" numeric>
                    {line.quantityExpected === null ? (
                      <span className="text-content-subtle italic">not stated</span>
                    ) : (
                      quantity(line.quantityExpected, line.unit)
                    )}
                  </Td>
                  <Td align="right" numeric>
                    {quantity(line.quantityReceived, line.unit)}
                  </Td>
                  <Td align="right" numeric>
                    {quantity(line.quantityAccepted, line.unit)}
                  </Td>
                  <Td align="right" numeric>
                    {line.quantityRejected > 0 ? (
                      <span className="font-semibold text-danger-fg">
                        {quantity(line.quantityRejected, line.unit)}
                      </span>
                    ) : (
                      quantity(line.quantityRejected, line.unit)
                    )}
                  </Td>
                  <Td>
                    {line.discrepancyKind === "none" ? (
                      <span className="text-content-subtle">—</span>
                    ) : (
                      <Tooltip content={line.discrepancyNote ?? "No note recorded."}>
                        <span>
                          <Badge tone="danger" size="xs" variant="outline">
                            {DISCREPANCY_LABEL[line.discrepancyKind] ?? labelize(line.discrepancyKind)}
                          </Badge>
                        </span>
                      </Tooltip>
                    )}
                  </Td>
                  <Td>
                    <span className="flex flex-wrap gap-1">
                      {line.batchNumber ? (
                        <Badge tone="neutral" size="xs" variant="outline">
                          batch {line.batchNumber}
                        </Badge>
                      ) : null}
                      {line.heatNumber ? (
                        <Badge tone="neutral" size="xs" variant="outline">
                          heat {line.heatNumber}
                        </Badge>
                      ) : null}
                      {line.certificateFileIds.length > 0 ? (
                        <Badge tone="success" size="xs" variant="outline">
                          {line.certificateFileIds.length} cert
                        </Badge>
                      ) : (
                        <Badge tone="warning" size="xs">
                          no cert
                        </Badge>
                      )}
                    </span>
                  </Td>
                </Tr>
              ))}
              {data.lines.length === 0 ? (
                <Tr>
                  <Td colSpan={7} align="center" className="text-content-muted">
                    This delivery carries no lines. A delivery with no lines records that a lorry
                    arrived and nothing else — it cannot be matched to an invoice or to a purchase
                    order.
                  </Td>
                </Tr>
              ) : null}
            </TBody>
          </Table>
      </CardBody>
    </Card>
  );
}

/* ========================================================================== */
/* Three-way match                                                             */
/* ========================================================================== */

function InvoiceMatchView({ report }: { report: Loadable<InvoiceMatchReport> }) {
  if (report.error) return <LoadError message={report.error} onRetry={report.reload} />;
  if (report.loading && !report.data) return <SkeletonTable rows={6} columns={5} />;
  const data = report.data;
  if (!data) return null;

  const unmatchedBuckets = Object.entries(data.unmatchedByCurrency).map(([currency, bucket]) => ({
    currency,
    value: bucket.value,
  }));
  const unpriced = Object.values(data.unmatchedByCurrency).reduce((sum, b) => sum + b.unpriced, 0);

  return (
    <div className="space-y-4">
      <CurrencyRail
        buckets={unmatchedBuckets}
        label="Unmatched delivery value"
        tone={data.unmatchedCount > 0 ? "danger" : "neutral"}
        note="Reported per currency and never added. An unmatched delivery is either unbilled cost the supplier will come back for, or cost already paid twice."
      />

      <Card>
        <CardBody className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="neutral" size="sm">
              {data.total} received deliver{data.total === 1 ? "y" : "ies"}
            </Badge>
            <Badge tone="success" size="sm" dot>
              {data.matchedCount} matched
            </Badge>
            <Badge tone={data.unmatchedCount > 0 ? "warning" : "neutral"} size="sm" dot>
              {data.unmatchedCount} unmatched
            </Badge>
            {unpriced > 0 ? (
              <Badge tone="warning" size="sm" variant="outline">
                {unpriced} unpriced — exposure cannot be stated
              </Badge>
            ) : null}
            <span className="text-2xs text-content-subtle">as at {data.asOf}</span>
          </div>
          <p className="text-2xs text-content-muted">{data.interpretation}</p>
        </CardBody>
      </Card>

      {data.unmatched.length === 0 ? (
        <EmptyState
          icon={IconMaterial}
          tone="success"
          title="Every received delivery is matched to an invoice"
          hint={`All ${data.total} received or partially received deliveries carry an invoice link as at ${data.asOf}. Neither unbilled cost nor a double payment can be hiding in this set.`}
        />
      ) : (
        <div className="space-y-2">
          <SectionHeading
            title="Unmatched, oldest first"
            hint="An unmatched delivery is not automatically a problem — the invoice may simply not have arrived. It becomes one when it ages."
          />
          {data.unmatched
            .slice()
            .sort((a, b) => (b.ageDays ?? 0) - (a.ageDays ?? 0))
            .map((row) => (
              <Card key={row.id}>
                <CardBody className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-sm font-semibold">{row.reference}</span>
                      <span className="text-sm text-content">
                        {row.deliveryNoteNumber ?? "no delivery note number"}
                      </span>
                      {row.hasDiscrepancy ? (
                        <Badge tone="danger" size="xs">
                          discrepant
                        </Badge>
                      ) : null}
                      {row.ageDays !== null && row.ageDays > 60 ? (
                        <Badge tone="danger" size="xs" dot>
                          {row.ageDays} days old
                        </Badge>
                      ) : row.ageDays !== null ? (
                        <Badge tone="neutral" size="xs">
                          {row.ageDays} days old
                        </Badge>
                      ) : null}
                    </div>
                    <p className="mt-0.5 text-2xs text-content-subtle">
                      PO {row.purchaseOrderRef ?? EM_DASH} · received {dateTime(row.receivedAt)}
                    </p>
                    {row.valueNote ? (
                      <p className="mt-1 text-meta text-warning-fg">{row.valueNote}</p>
                    ) : null}
                  </div>
                  <div className="text-right">
                    <div className="text-body font-semibold tabular-nums">
                      {row.totalValue === null ? "Not priced" : money(row.totalValue, row.currency)}
                    </div>
                    <div className="text-2xs uppercase tracking-wide text-content-subtle">
                      {row.currency}
                    </div>
                  </div>
                </CardBody>
              </Card>
            ))}
        </div>
      )}
    </div>
  );
}

/* ========================================================================== */
/* Stock ledger                                                                */
/* ========================================================================== */

function StockView({
  materials,
  selectedItemId,
  onSelectItem,
  ledger,
  movements,
}: {
  materials: Loadable<ListResponse<MaterialRow>>;
  selectedItemId: string | null;
  onSelectItem: (itemId: string | null) => void;
  ledger: Loadable<StockLedger>;
  movements: Loadable<ListResponse<StockMovementRow>>;
}) {
  const rows = useMemo(
    () => (materials.data?.items ?? []).filter((row) => row.isTracked),
    [materials.data],
  );

  const columns = useMemo<DataColumns<MaterialRow>>(
    () => [
      {
        id: "reference",
        header: "Item",
        accessor: "reference",
        type: "code",
        sticky: "start",
        width: 118,
        mono: true,
      },
      { id: "name", header: "Material", accessor: "name", type: "text", width: 260 },
      {
        id: "status",
        header: "Status",
        accessor: "status",
        type: "status",
        width: 150,
        groupable: true,
        cell: ({ row }) => (
          <Badge tone="neutral" size="xs" dot>
            {labelize(row.status)}
          </Badge>
        ),
      },
      {
        id: "quantityOnHand",
        header: "On hand",
        accessor: "quantityOnHand",
        type: "custom",
        align: "right",
        width: 130,
        aggregate: "none",
        cell: ({ row }) => (
          <span
            className={
              row.derived.belowReorderLevel ? "font-semibold tabular-nums text-warning-fg" : "tabular-nums"
            }
          >
            {quantity(row.quantityOnHand, row.unit)}
          </span>
        ),
      },
      {
        id: "availableToIssue",
        header: "Available",
        headerTooltip:
          "On hand less reserved. Reserved stock is still physically in the compound and still counted — a reservation moves the reserved figure, not the balance.",
        accessor: (row) => row.derived.availableToIssue,
        type: "custom",
        align: "right",
        width: 130,
        aggregate: "none",
        cell: ({ row }) => (
          <span className="tabular-nums">{quantity(row.derived.availableToIssue, row.unit)}</span>
        ),
      },
      {
        id: "wastage",
        header: "Wastage",
        accessor: (row) => row.derived.wastagePercent,
        type: "custom",
        align: "right",
        width: 130,
        aggregate: "none",
        sortDescFirst: true,
        cell: ({ row }) =>
          row.derived.wastagePercent === null ? (
            <Tooltip
              content={
                row.derived.wastagePercentReason ??
                "Nothing has been delivered, so a wastage percentage would divide by zero."
              }
            >
              <span className="inline-flex items-center gap-1 text-content-muted">
                <span>Not available</span>
                <Badge tone="warning" size="xs">
                  why
                </Badge>
              </span>
            </Tooltip>
          ) : (
            <span
              className={
                row.derived.wastagePercent > 10
                  ? "font-semibold tabular-nums text-danger-fg"
                  : "tabular-nums"
              }
            >
              {row.derived.wastagePercent.toFixed(1)}%
            </span>
          ),
      },
      {
        id: "spec",
        header: "Spec control",
        accessor: (row) => (row.derived.specControlled ? "yes" : "no"),
        type: "enum",
        width: 180,
        cell: ({ row }) =>
          row.derived.specControlled ? (
            <Badge tone="success" size="xs" variant="outline">
              bound to a spec
            </Badge>
          ) : (
            <Tooltip content={row.derived.specNote ?? "Not bound to a spec section or submittal."}>
              <span>
                <Badge tone="warning" size="xs">
                  unspecified
                </Badge>
              </span>
            </Tooltip>
          ),
      },
    ],
    [],
  );

  if (materials.error) return <LoadError message={materials.error} onRetry={materials.reload} />;
  if (materials.loading && rows.length === 0) return <SkeletonTable rows={8} columns={6} />;

  return (
    <div className="space-y-4">
      {rows.length === 0 ? (
        <EmptyState
          icon={IconMaterial}
          title="No tracked material on this project"
          hint="A stock ledger only exists for materials marked as tracked. Bulk consumables are deliberately not tracked movement by movement — the reconciliation below would be counting sand grains. Nothing here is set up for tracking yet."
        />
      ) : (
        <DataTable<MaterialRow>
          tableId="material-items"
          data={rows}
          columns={columns}
          getRowId={(row) => row.id}
          loading={materials.loading}
          height={Math.min(440, 140 + rows.length * 40)}
          stickyHeader
          gridLines
          filterRow
          exportFileName="material-items"
          searchPlaceholder="Search materials…"
          rowTone={(row) => (row.derived.belowReorderLevel ? ("warning" as Tone) : undefined)}
          onRowClick={({ row }) => onSelectItem(row.id)}
          rowActions={(row) => [
            { id: "ledger", label: "Open the stock ledger", onSelect: () => onSelectItem(row.id) },
          ]}
          empty={{ title: "No tracked materials" }}
          aria-label="Material items"
        />
      )}

      {selectedItemId ? (
        <StockLedgerPanel
          ledger={ledger}
          movements={movements}
          onClose={() => onSelectItem(null)}
        />
      ) : rows.length > 0 ? (
        <p className="text-2xs text-content-subtle">
          Select a material to replay its stock ledger. The replay starts from a zero opening
          balance — every unit in the compound must have arrived through a movement — and compares
          the result to the materialized figure.
        </p>
      ) : null}
    </div>
  );
}

function StockLedgerPanel({
  ledger,
  movements,
  onClose,
}: {
  ledger: Loadable<StockLedger>;
  movements: Loadable<ListResponse<StockMovementRow>>;
  onClose: () => void;
}) {
  if (ledger.error) return <LoadError message={ledger.error} onRetry={ledger.reload} />;
  if (ledger.loading && !ledger.data) return <SkeletonTable rows={6} columns={5} />;
  const data = ledger.data;
  if (!data) return null;

  const rec = data.reconciliation;
  const driftIds = new Set(rec.driftedMovements.map((m) => m.id));
  const rows = movements.data?.items ?? [];

  return (
    <Card>
      <CardBody className="space-y-3">
        <SectionHeading
          title={
            <span className="flex flex-wrap items-center gap-2">
              <span className="font-mono">{data.reference}</span>
              <span>{data.name}</span>
            </span>
          }
          hint={data.method}
          className="mb-0"
          actions={
            <Button size="sm" variant="ghost" onClick={onClose}>
              Close
            </Button>
          }
        />

        <Alert
          tone={rec.reconciles ? "success" : "danger"}
          title={rec.reconciles ? "The balance reconciles to the movements" : "The balance does NOT reconcile"}
          icon={rec.reconciles ? undefined : IconWarning}
        >
          <p>{data.verdict}</p>
          <ReasonList reasons={rec.reasons} className="mt-2" />
        </Alert>

        <DescriptionList
          columns={4}
          size="sm"
          items={[
            {
              label: "Recorded balance",
              value: (
                <span className="font-semibold tabular-nums">
                  {quantity(rec.recordedBalance, data.unit)}
                </span>
              ),
              hint: "The materialized figure on the material record",
            },
            {
              label: "Replayed balance",
              value: (
                <span className="font-semibold tabular-nums">
                  {quantity(rec.computedBalance, data.unit)}
                </span>
              ),
              hint: `${rec.movements} movement(s) replayed in movedAt order`,
            },
            {
              label: "Difference",
              value: (
                <span
                  className={
                    rec.reconciles
                      ? "font-semibold tabular-nums text-success-fg"
                      : "font-semibold tabular-nums text-danger-fg"
                  }
                >
                  {quantity(rec.difference, data.unit)}
                </span>
              ),
              hint: rec.reconciles ? "The two agree" : "Only the compound can say which is wrong",
            },
            {
              label: "Reserved",
              value: <span className="tabular-nums">{quantity(data.quantityReserved, data.unit)}</span>,
              hint: `${quantity(data.availableToIssue, data.unit)} available to issue`,
            },
          ]}
        />

        {Object.keys(rec.byType).length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {Object.entries(rec.byType)
              .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
              .map(([type, value]) => (
                <Badge
                  key={type}
                  tone={
                    type === "wastage" || type === "damage" || type === "theft" ? "danger" : "neutral"
                  }
                  size="xs"
                  variant="outline"
                >
                  {labelize(type)} {value > 0 ? "+" : ""}
                  {value.toFixed(2)}
                </Badge>
              ))}
          </div>
        ) : null}

        {rec.driftedMovements.length > 0 ? (
          <Alert tone="warning" size="sm" title="Where the drift entered">
            {rec.driftedMovements.length} movement(s) carry a stored balance that disagrees with the
            replay. Those rows are highlighted below — the drift entered at the earliest of them.
          </Alert>
        ) : null}

        {movements.error ? (
          <LoadError message={movements.error} onRetry={movements.reload} />
        ) : rows.length === 0 ? (
          <EmptyState
            size="sm"
            title="No movements recorded"
            hint={`The recorded balance is ${quantity(rec.recordedBalance, data.unit)} and no movement explains it. Every unit in the compound must have arrived through a movement, so a non-zero balance with no movements is the clearest possible drift.`}
          />
        ) : (
          <Table dense tableClassName="min-w-[640px] text-meta">
              <THead>
                <Tr>
                  <Th>Moved</Th>
                  <Th>Kind</Th>
                  <Th align="right">Quantity</Th>
                  <Th align="right">Balance recorded</Th>
                  <Th>Verified</Th>
                </Tr>
              </THead>
              <TBody>
                {rows.map((movement) => {
                  const drift = rec.driftedMovements.find((m) => m.id === movement.id);
                  return (
                    <Tr
                      key={movement.id}
                      className={driftIds.has(movement.id) ? "bg-danger-subtle" : ""}
                    >
                      <Td className="text-content-muted">
                        {dateTime(movement.movedAt)}
                      </Td>
                      <Td>
                        <Badge
                          tone={
                            movement.movementType === "wastage" ||
                            movement.movementType === "damage" ||
                            movement.movementType === "theft"
                              ? "danger"
                              : "neutral"
                          }
                          size="xs"
                          variant="outline"
                        >
                          {labelize(movement.movementType)}
                        </Badge>
                      </Td>
                      <Td align="right" numeric>
                        {quantity(movement.quantity, movement.unit ?? data.unit)}
                      </Td>
                      <Td align="right" numeric>
                        {movement.balanceAfter === null ? (
                          <span className="text-content-subtle italic">not stamped</span>
                        ) : (
                          <span className={drift ? "font-semibold text-danger-fg" : ""}>
                            {movement.balanceAfter.toFixed(2)}
                            {drift ? (
                              <span className="ml-1 text-2xs">
                                (replay says {drift.computedBalanceAfter.toFixed(2)})
                              </span>
                            ) : null}
                          </span>
                        )}
                      </Td>
                      <Td>
                        {movement.verifiedBy ? (
                          <Badge tone="success" size="xs" variant="outline">
                            checked
                          </Badge>
                        ) : (
                          <span className="text-2xs text-content-subtle">
                            {isoDate(movement.movedAt)}
                          </span>
                        )}
                      </Td>
                    </Tr>
                  );
                })}
              </TBody>
            </Table>
        )}
      </CardBody>
    </Card>
  );
}

function deliveryTone(status: string): Tone {
  switch (status) {
    case "received":
      return "success";
    case "partially_received":
      return "warning";
    case "rejected":
    case "returned":
      return "danger";
    case "cancelled":
      return "neutral";
    case "in_transit":
    case "arrived":
    case "receiving":
      return "info";
    default:
      return "neutral";
  }
}
