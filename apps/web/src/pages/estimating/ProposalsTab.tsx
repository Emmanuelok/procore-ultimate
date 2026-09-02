/**
 * PROPOSALS — what was sent to the client, frozen at the moment it was
 * generated (#205) and readable as printable HTML (#206).
 *
 * A proposal never re-derives from the live estimate. If a rate moved after
 * it was issued, the proposal still says what it said, and a new one is
 * generated rather than the old one edited.
 */
import { useMemo, useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  DataTable,
  Drawer,
  Table,
  Td,
  Th,
  toast,
  type DataColumns,
} from "../../ui";
import { IconExternal, IconPrint } from "../../ui/icons";
import {
  DASH,
  LoadError,
  Row,
  count,
  dateOnly,
  dateTime,
  estimatingApi,
  money,
  money0,
  num,
  titleCase,
  useAction,
  useResource,
  type Paginated,
  type Proposal,
  type ProposalDocument,
} from "./estimatingShared";

const STATUS_TONE: Record<string, "neutral" | "info" | "success" | "danger" | "accent"> = {
  draft: "neutral",
  issued: "info",
  accepted: "success",
  declined: "danger",
  superseded: "neutral",
};

export default function ProposalsTab({
  projectId,
  onChanged,
}: {
  projectId: string;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState<Proposal | null>(null);
  const action = useAction();
  const list = useResource<Paginated<Proposal>>(
    `/api/v1/projects/${projectId}/estimating/proposals?page=1&pageSize=100`,
  );

  const columns = useMemo<DataColumns<Proposal>>(
    () => [
      { id: "reference", header: "Ref", accessor: "reference", type: "text", width: 100, mono: true },
      { id: "title", header: "Title", accessor: "title", type: "text", width: 280 },
      {
        id: "clientName",
        header: "Client",
        accessor: (row) => row.clientName ?? "",
        type: "text",
        width: 200,
        cell: ({ row }) => row.clientName ?? <span className="text-content-subtle">{DASH}</span>,
      },
      {
        id: "detailLevel",
        header: "Detail",
        accessor: (row) => titleCase(row.detailLevel),
        type: "text",
        width: 120,
      },
      {
        id: "total",
        header: "Total",
        accessor: "total",
        type: "number",
        align: "right",
        width: 150,
        cell: ({ row }) => <span className="font-semibold">{money0(row.total, row.currency)}</span>,
      },
      {
        id: "status",
        header: "Status",
        accessor: "status",
        type: "text",
        width: 120,
        cell: ({ row }) => (
          <Badge tone={STATUS_TONE[row.status] ?? "neutral"} size="xs" dot>
            {titleCase(row.status)}
          </Badge>
        ),
      },
      {
        id: "validUntil",
        header: "Valid until",
        accessor: (row) => row.validUntil ?? "",
        type: "text",
        width: 130,
        cell: ({ row }) =>
          row.validUntil === null ? (
            <Badge tone="warning" size="xs">
              Not stated
            </Badge>
          ) : (
            dateOnly(row.validUntil)
          ),
      },
      {
        id: "createdAt",
        header: "Generated",
        accessor: "createdAt",
        type: "datetime",
        width: 170,
        cell: ({ row }) => dateTime(row.createdAt),
      },
    ],
    [],
  );

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title="Proposals"
          subtitle="Generated from an estimate on the Estimates tab. The document is frozen: what was sent on a date stays what was sent."
        />
        <CardBody flush>
          {action.error ? (
            <div className="p-3">
              <Alert tone="danger" size="sm" onDismiss={action.clear}>
                {action.error}
              </Alert>
            </div>
          ) : null}
          {list.error ? (
            <div className="p-4">
              <LoadError message={list.error} onRetry={list.reload} />
            </div>
          ) : (
            <DataTable<Proposal>
              tableId="estimating.proposals"
              data={list.data?.items ?? []}
              columns={columns}
              getRowId={(row) => row.id}
              loading={list.loading && !list.data}
              height={380}
              rowHeight={44}
              stickyHeader
              flush
              toolbar={false}
              empty={{
                title: "Nothing sent yet",
                description:
                  "Open an estimate, go to Convert & propose, and generate a proposal. It will appear here with the exact figures it was generated from.",
              }}
              onRowClick={({ row }) => setOpen(row)}
              aria-label="Proposals"
            />
          )}
        </CardBody>
      </Card>

      <ProposalDrawer
        projectId={projectId}
        proposal={open}
        onClose={() => setOpen(null)}
        onChanged={() => {
          list.reload();
          onChanged();
        }}
      />
    </div>
  );
}

function ProposalDrawer({
  projectId,
  proposal,
  onClose,
  onChanged,
}: {
  projectId: string;
  proposal: Proposal | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const action = useAction();
  const detail = useResource<Proposal & { document: ProposalDocument }>(
    proposal ? `/api/v1/projects/${projectId}/estimating/proposals/${proposal.id}` : null,
  );
  const doc = detail.data?.document;

  return (
    <Drawer
      open={proposal !== null}
      onClose={onClose}
      size="lg"
      title={proposal ? `${proposal.reference} — ${proposal.title}` : "Proposal"}
      description={
        proposal
          ? `${titleCase(proposal.detailLevel)} detail · ${money(proposal.total, proposal.currency)}${
              proposal.clientName ? ` · ${proposal.clientName}` : ""
            }`
          : undefined
      }
      headerActions={
        proposal ? (
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="secondary"
              icon={IconExternal}
              onClick={() =>
                window.open(
                  `/api/v1/projects/${projectId}/estimating/proposals/${proposal.id}/html`,
                  "_blank",
                  "noopener",
                )
              }
            >
              Open printable
            </Button>
            {proposal.status === "draft" ? (
              <Button
                size="sm"
                icon={IconPrint}
                loading={action.busy === "issue"}
                onClick={() =>
                  void action
                    .run("issue", () => estimatingApi.proposalStatus(projectId, proposal.id, { status: "issued" }))
                    .then((res) => {
                      if (res) {
                        toast.success(`${res.reference} issued`);
                        detail.reload();
                        onChanged();
                      }
                    })
                }
              >
                Mark issued
              </Button>
            ) : null}
          </div>
        ) : undefined
      }
    >
      {detail.error ? (
        <LoadError message={detail.error} onRetry={detail.reload} />
      ) : !doc ? (
        <div className="text-meta text-content-subtle">Loading…</div>
      ) : (
        <div className="space-y-4">
          {action.error ? (
            <Alert tone="danger" size="sm" onDismiss={action.clear}>
              {action.error}
            </Alert>
          ) : null}
          <dl className="divide-y divide-border">
            <Row label="Project">{doc.projectName}</Row>
            <Row label="Generated">{dateTime(doc.generatedAt)}</Row>
            <Row label="Valid until">{doc.validUntil ? dateOnly(doc.validUntil) : DASH}</Row>
            <Row label="Detail level">{titleCase(doc.detailLevel)}</Row>
          </dl>

          <Table>
            <thead>
              <tr>
                <Th>Item</Th>
                <Th align="right">Quantity</Th>
                <Th align="right">Rate</Th>
                <Th align="right">Amount</Th>
              </tr>
            </thead>
            <tbody>
              {doc.sections.map((section) => (
                <>
                  <tr key={section.id}>
                    <Td className="font-semibold">
                      {section.code ? `${section.code} — ${section.name}` : section.name}
                    </Td>
                    <Td />
                    <Td />
                    <Td align="right" className="font-semibold">
                      {money(section.amount, doc.currency)}
                    </Td>
                  </tr>
                  {section.lines.map((line, i) => (
                    <tr key={`${section.id}-${i}`}>
                      <Td>
                        <span className="pl-3 text-content-subtle">
                          {line.itemCode ? `${line.itemCode} ` : ""}
                          {line.description}
                        </span>
                      </Td>
                      <Td align="right">
                        {num(line.quantity, 2)} {line.unit ?? ""}
                      </Td>
                      <Td align="right">{num(line.unitRate, 2)}</Td>
                      <Td align="right">{money(line.amount, doc.currency)}</Td>
                    </tr>
                  ))}
                </>
              ))}
              {doc.markupLines.map((m, i) => (
                <tr key={`m-${i}`}>
                  <Td>{m.name}</Td>
                  <Td />
                  <Td />
                  <Td align="right">{money(m.amount, doc.currency)}</Td>
                </tr>
              ))}
              <tr>
                <Td className="font-semibold">Total</Td>
                <Td />
                <Td />
                <Td align="right" className="font-semibold">
                  {money(doc.totals.total, doc.currency)}
                </Td>
              </tr>
            </tbody>
          </Table>

          {doc.alternates.length > 0 ? (
            <div>
              <div className="mb-1 text-2xs font-semibold uppercase tracking-wide text-content-subtle">
                Alternates — priced, offered, not in the total
              </div>
              <Table dense>
                <tbody>
                  {doc.alternates.map((a, i) => (
                    <tr key={i}>
                      <Td>{a.description}</Td>
                      <Td align="right">{money(a.amount, doc.currency)}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </div>
          ) : null}

          {doc.notes.length > 0 ? (
            <Alert tone="info" size="sm" title="Notes on this proposal">
              <ul className="list-disc space-y-0.5 pl-4">
                {doc.notes.map((n, i) => (
                  <li key={i}>{n}</li>
                ))}
              </ul>
            </Alert>
          ) : null}

          <div className="text-2xs text-content-subtle">
            {count(doc.sections.length)} section{doc.sections.length === 1 ? "" : "s"} ·{" "}
            {money(doc.totals.directCost, doc.currency)} direct cost ·{" "}
            {money(doc.totals.markupTotal, doc.currency)} markups. The internal explanation of each markup is
            never part of the document at any detail level.
          </div>
        </div>
      )}
    </Drawer>
  );
}
