/**
 * T&M TICKETS — where the signature IS the product.
 *
 * A daywork ticket is work done outside the contract scope, priced on time,
 * and signed on site on the day by the client's representative. The signature
 * block is nine columns rather than a boolean because three outcomes are
 * genuinely different documents, and a dispute later turns on exactly which
 * one this was:
 *
 *   SIGNED                a clean, unqualified acknowledgement.
 *   SIGNED UNDER PROTEST  "signed for record of hours only, without prejudice
 *                         to liability". The signature acknowledges the hours;
 *                         it does not admit the change. Reporting it as an
 *                         unqualified acceptance is a misrepresentation.
 *   REFUSED TO SIGN       evidence in its own right. It fixes the date on
 *                         which the client was told the work was being done
 *                         and declined to acknowledge it.
 *
 * The fourth state — UNSIGNED — is our own record of hours and nothing more,
 * and it never presents as signed. The signature filter reads the signature
 * COLUMNS, never `status`, so a ticket whose status was pushed to "signed" by
 * some other route still reads here as what it actually is.
 */
import { useMemo, useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  EmptyState,
  SegmentedControl,
  SkeletonTable,
  Tooltip,
} from "../../ui";
import { DataTable, type DataColumns } from "../../ui/data";
import { ChartCard, DonutChart } from "../../ui/charts";
import type { Tone } from "../../ui/tokens";
import { IconSignature, IconWarning } from "../../ui/icons";
import {
  EM_DASH,
  LoadError,
  SIGNATURE_LABEL,
  SIGNATURE_TONE,
  SectionHeading,
  dateTime,
  hoursText,
  isoDate,
  labelize,
  money,
  type ListResponse,
  type Loadable,
  type SignatureState,
  type TicketListRow,
  type TicketRecord,
} from "./timecardsShared";

type Filter = "all" | SignatureState;

const FILTERS: Array<{ value: Filter; label: string }> = [
  { value: "all", label: "All" },
  { value: "signed", label: "Signed" },
  { value: "signed_under_protest", label: "Under protest" },
  { value: "refused_to_sign", label: "Refused" },
  { value: "unsigned", label: "Unsigned" },
];

export default function TicketsTab({
  tickets,
  onOpenTicket,
}: {
  tickets: Loadable<ListResponse<TicketListRow>>;
  onOpenTicket: (ticketId: string) => void;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const rows = useMemo(() => tickets.data?.items ?? [], [tickets.data]);

  const counts = useMemo(() => {
    const base: Record<SignatureState, number> = {
      signed: 0,
      signed_under_protest: 0,
      refused_to_sign: 0,
      unsigned: 0,
    };
    for (const row of rows) base[row.signature.state] += 1;
    return base;
  }, [rows]);

  const filtered = useMemo(
    () => (filter === "all" ? rows : rows.filter((row) => row.signature.state === filter)),
    [filter, rows],
  );

  const unpromoted = rows.filter(
    (row) => row.signature.hasClientResponse && row.incorporatedChangeOrderId === null,
  );

  const slices = useMemo(
    () =>
      (Object.keys(counts) as SignatureState[])
        .filter((state) => counts[state] > 0)
        .map((state) => ({ name: SIGNATURE_LABEL[state], value: counts[state] })),
    [counts],
  );

  const columns = useMemo<DataColumns<TicketListRow>>(
    () => [
      {
        id: "reference",
        header: "Ticket",
        accessor: "reference",
        type: "code",
        sticky: "start",
        width: 108,
        mono: true,
      },
      { id: "ticketDate", header: "Date", accessor: "ticketDate", type: "date", width: 118 },
      {
        id: "title",
        header: "Work",
        accessor: "title",
        type: "text",
        width: 260,
        cell: ({ row }) => (
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate">{row.title}</span>
            {row.wasVerbalInstruction === 1 ? (
              <Tooltip
                content={`Instructed VERBALLY by ${row.instructedByName ?? "somebody unnamed"}${
                  row.instructionDate ? ` on ${row.instructionDate}` : ""
                }. Entitlement to a verbal instruction is won or lost on whether the instructor was named at the time and the instruction confirmed in writing promptly.`}
              >
                <span>
                  <Badge tone="warning" size="xs" variant="outline">
                    verbal
                  </Badge>
                </span>
              </Tooltip>
            ) : null}
          </span>
        ),
      },
      {
        id: "signature",
        header: "Signature",
        headerTooltip:
          "Read from the signature columns, never from status. Signed, signed under protest and refused to sign are three different documents, and an unsigned ticket never presents as signed.",
        accessor: (row) => row.signature.state,
        type: "enum",
        width: 220,
        groupable: true,
        options: FILTERS.filter((entry) => entry.value !== "all").map((entry) => ({
          value: entry.value,
          label: SIGNATURE_LABEL[entry.value as SignatureState],
          text: SIGNATURE_LABEL[entry.value as SignatureState],
          tone: SIGNATURE_TONE[entry.value as SignatureState],
        })),
        cell: ({ row }) => <SignatureCell ticket={row} />,
      },
      {
        id: "signedByName",
        header: "Signed by",
        accessor: (row) => row.signedByName ?? "",
        type: "text",
        width: 230,
        cell: ({ row }) =>
          row.signedByName ? (
            <span className="flex min-w-0 flex-col leading-tight">
              <span className="truncate text-content">{row.signedByName}</span>
              <span className="truncate text-2xs text-content-subtle">
                {row.signedByRole ?? "role not recorded"}
                {row.signedByOrganisation ? ` · ${row.signedByOrganisation}` : ""}
              </span>
            </span>
          ) : (
            <span className="text-2xs text-content-subtle italic">nobody</span>
          ),
      },
      {
        id: "totalLabourHours",
        header: "Labour hours",
        headerTooltip: "The figure the signature is really about.",
        accessor: "totalLabourHours",
        type: "custom",
        align: "right",
        width: 140,
        aggregate: "sum",
        cell: ({ row }) => (
          <span className="font-medium tabular-nums">{hoursText(row.totalLabourHours, 1)}</span>
        ),
      },
      {
        id: "total",
        header: "Claimed value",
        accessor: "total",
        type: "custom",
        align: "right",
        width: 155,
        aggregate: "none",
        cell: ({ row }) =>
          row.totalsAreComplete === false ? (
            <Tooltip
              content={
                row.totalNote ??
                "Some lines on this ticket carry no rate, so its value cannot be stated yet."
              }
            >
              <span className="text-content-muted">Not available</span>
            </Tooltip>
          ) : (
            <span className="tabular-nums">{money(row.total, row.currency)}</span>
          ),
        toCsv: ({ row }) =>
          row.totalsAreComplete === false ? "" : `${row.total} ${row.currency}`,
      },
      {
        id: "rateBasis",
        header: "Priced on",
        accessor: "rateBasis",
        type: "enum",
        width: 190,
        cell: ({ row }) => (
          <Tooltip
            content={
              row.rateBasis === "star_rate"
                ? "A rate invented for work with no comparable in the contract. This is the one that ends up in adjudication."
                : row.rateBasis === "to_be_agreed"
                  ? "The basis has not been agreed. Agreeing it before the work, not after, is what turns a ticket into an entitlement."
                  : "The pricing basis agreed for this ticket."
            }
          >
            <span>
              <Badge
                tone={
                  row.rateBasis === "to_be_agreed"
                    ? "warning"
                    : row.rateBasis === "star_rate"
                      ? "highlight"
                      : "neutral"
                }
                size="xs"
                variant="outline"
              >
                {labelize(row.rateBasis)}
              </Badge>
            </span>
          </Tooltip>
        ),
      },
      {
        id: "status",
        header: "Our status",
        accessor: "status",
        type: "status",
        width: 150,
        groupable: true,
        cell: ({ row }) => (
          <Badge tone={ticketStatusTone(row.status)} size="xs" dot>
            {labelize(row.status)}
          </Badge>
        ),
      },
      {
        id: "incorporated",
        header: "Absorbed",
        headerTooltip:
          "Between a signature and incorporation into a change order is where unrecovered cost lives.",
        accessor: (row) => (row.incorporatedChangeOrderId ? "yes" : "no"),
        type: "enum",
        width: 150,
        cell: ({ row }) =>
          row.incorporatedChangeOrderId ? (
            <Badge tone="success" size="xs" variant="outline">
              {isoDate(row.incorporatedAt)}
            </Badge>
          ) : row.signature.hasClientResponse ? (
            <Badge tone="warning" size="xs">
              not yet
            </Badge>
          ) : (
            <span className="text-2xs text-content-subtle">{EM_DASH}</span>
          ),
      },
    ],
    [],
  );

  if (tickets.error) return <LoadError message={tickets.error} onRetry={tickets.reload} />;
  if (tickets.loading && rows.length === 0) return <SkeletonTable rows={8} columns={7} />;

  return (
    <div className="space-y-4">
      <Card>
        <CardBody className="space-y-3">
          <SectionHeading
            title="Time & materials tickets"
            hint="The hours the client's representative signed for, on site, on the day — or signed under protest, or refused to sign. All three are recorded distinctly."
            className="mb-0"
          />
          <SegmentedControl<Filter>
            value={filter}
            onChange={setFilter}
            size="sm"
            aria-label="Signature state"
            options={FILTERS.map((entry) => ({
              value: entry.value,
              label:
                entry.value === "all"
                  ? `All (${rows.length})`
                  : `${entry.label} (${counts[entry.value as SignatureState]})`,
            }))}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="success" size="sm" dot>
              {counts.signed} signed
            </Badge>
            <Badge tone="warning" size="sm" dot>
              {counts.signed_under_protest} under protest
            </Badge>
            <Badge tone="danger" size="sm" dot>
              {counts.refused_to_sign} refused
            </Badge>
            <Badge tone="neutral" size="sm" variant="outline">
              {counts.unsigned} unsigned
            </Badge>
          </div>
        </CardBody>
      </Card>

      {counts.unsigned > 0 ? (
        <Alert
          tone="warning"
          title={`${counts.unsigned} ticket${counts.unsigned === 1 ? "" : "s"} carry no client response at all`}
        >
          No signature, no protest and no recorded refusal. These are our own record of hours and
          nothing more — they evidence no instruction, and they cannot be promoted into the change
          chain. Present them on site and record what the client&rsquo;s representative did,
          including a refusal: a recorded refusal is evidence, a silence is not.
        </Alert>
      ) : null}

      {unpromoted.length > 0 ? (
        <Alert
          tone="info"
          title={`${unpromoted.length} ticket${unpromoted.length === 1 ? "" : "s"} carry a client response and have not been absorbed`}
        >
          Between a signature and incorporation into a change order is exactly where unrecovered
          cost lives. Each of these has something the client did on record — promote it while the
          people who were there still remember the day.
        </Alert>
      ) : null}

      {slices.length > 1 ? (
        <ChartCard
          title="How the client responded"
          subtitle={`${rows.length} ticket${rows.length === 1 ? "" : "s"} on this project`}
          icon={IconSignature}
          footnote="Counted from the signature columns, never from status. A ticket pushed to 'signed' by another route still counts here as whatever the signature block actually says."
        >
          <DonutChart
            data={slices}
            labelKey="name"
            valueKey="value"
            valueFormat="number"
            ariaLabel="Tickets by signature state"
            height={260}
          />
        </ChartCard>
      ) : null}

      {filtered.length === 0 ? (
        <EmptyState
          icon={IconSignature}
          title={
            filter === "all"
              ? "No T&M tickets on this project"
              : `No ticket is ${SIGNATURE_LABEL[filter as SignatureState].toLowerCase()}`
          }
          hint={
            filter === "all"
              ? "A T&M ticket is what turns work done outside the contract scope into an entitlement: the hours, the instruction, and the client's own acknowledgement of both on the day. None has been raised here."
              : filter === "refused_to_sign"
                ? "No client representative has refused to sign a ticket on this project. That is a good state — but note that a refusal, when it happens, is evidence rather than a failure, and is worth recording precisely."
                : `Nothing in this bucket. Pick another signature state above.`
          }
          action={
            filter !== "all" ? (
              <Button size="sm" variant="secondary" onClick={() => setFilter("all")}>
                Show every ticket
              </Button>
            ) : undefined
          }
        />
      ) : (
        <DataTable<TicketListRow>
          tableId="tm-tickets"
          data={filtered}
          columns={columns}
          getRowId={(row) => row.id}
          loading={tickets.loading}
          height={560}
          stickyHeader
          gridLines
          filterRow
          exportFileName="tm-tickets"
          searchPlaceholder="Search tickets…"
          defaultSort={[{ id: "ticketDate", desc: true }]}
          rowTone={(row) => ticketRail(row)}
          onRowClick={({ row }) => onOpenTicket(row.id)}
          rowActions={(row) => [
            { id: "open", label: "Open the ticket", onSelect: () => onOpenTicket(row.id) },
          ]}
          empty={{ title: "No tickets" }}
          aria-label="T&M tickets"
        />
      )}

      <p className="text-2xs text-content-subtle">
        Claimed values carry no grand total. A project can raise tickets in more than one currency,
        and a single figure across them would need an FX rate and a date — neither of which belongs
        on a document whose whole purpose is to be exact about a particular day.
      </p>
    </div>
  );
}

/** Three visibly different states, plus the honest fourth. */
export function SignatureCell({ ticket }: { ticket: TicketRecord }) {
  const signature = ticket.signature;
  return (
    <Tooltip content={<span className="block max-w-sm">{signature.summary}</span>}>
      <span className="flex flex-wrap items-center gap-1">
        <Badge
          tone={SIGNATURE_TONE[signature.state]}
          size="xs"
          dot
          variant={
            signature.state === "refused_to_sign"
              ? "solid"
              : signature.state === "signed_under_protest"
                ? "solid"
                : "subtle"
          }
          icon={signature.state === "refused_to_sign" ? IconWarning : undefined}
        >
          {SIGNATURE_LABEL[signature.state]}
        </Badge>
        {signature.state === "signed" ? (
          <span className="text-2xs text-content-subtle">{dateTime(ticket.signedAt)}</span>
        ) : null}
        {signature.state === "signed_under_protest" ? (
          <Badge tone="warning" size="xs" variant="outline">
            hours only
          </Badge>
        ) : null}
      </span>
    </Tooltip>
  );
}

function ticketRail(ticket: TicketRecord): Tone | undefined {
  switch (ticket.signature.state) {
    case "refused_to_sign":
      return "danger";
    case "signed_under_protest":
      return "warning";
    case "unsigned":
      return "neutral";
    default:
      return undefined;
  }
}

function ticketStatusTone(status: string): Tone {
  switch (status) {
    case "signed":
    case "approved":
      return "success";
    case "signed_under_protest":
      return "warning";
    case "disputed":
    case "rejected":
      return "danger";
    case "incorporated":
      return "highlight";
    case "void":
      return "neutral";
    default:
      return "info";
  }
}
