/**
 * SUB-QUOTES — subcontract prices, and the levelling that makes them
 * comparable (#202–203).
 *
 * The comparison is on SCOPE ROWS, not totals: the cheapest number on the
 * page is normally the one that priced the least, so the grid shows who
 * priced each row, who excluded it, who never mentioned it, and whose number
 * is a long way from the pack.
 */
import { useEffect, useMemo, useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  DataTable,
  Drawer,
  Field,
  Input,
  Modal,
  Select,
  Table,
  Td,
  Textarea,
  Th,
  toast,
  type DataColumns,
} from "../../ui";
import { IconImport, IconPlus } from "../../ui/icons";
import {
  DASH,
  LoadError,
  QUOTE_STATUS_TONE,
  Row,
  StatusPill,
  count,
  dateOnly,
  estimatingApi,
  money,
  money0,
  num,
  pct,
  titleCase,
  useAction,
  useResource,
  type Estimate,
  type Levelling,
  type Paginated,
  type SubQuote,
  type SubQuoteDetail,
} from "./estimatingShared";

export default function QuotesTab({
  projectId,
  onChanged,
}: {
  projectId: string;
  onChanged: () => void;
}) {
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [packageFilter, setPackageFilter] = useState("");

  const quotes = useResource<Paginated<SubQuote>>(
    `/api/v1/projects/${projectId}/estimating/sub-quotes?page=1&pageSize=200`,
  );

  const packages = useMemo(() => {
    const set = new Set<string>();
    for (const q of quotes.data?.items ?? []) set.add(q.tradePackage);
    return [...set].sort();
  }, [quotes.data]);

  useEffect(() => {
    if (packageFilter.length === 0 && packages.length > 0) setPackageFilter(packages[0]!);
  }, [packages, packageFilter]);

  const columns = useMemo<DataColumns<SubQuote>>(
    () => [
      { id: "reference", header: "Ref", accessor: "reference", type: "text", width: 100, mono: true },
      { id: "vendorName", header: "Supplier", accessor: "vendorName", type: "text", width: 220 },
      { id: "tradePackage", header: "Package", accessor: "tradePackage", type: "text", width: 180 },
      {
        id: "status",
        header: "Status",
        accessor: "status",
        type: "text",
        width: 130,
        cell: ({ row }) => <StatusPill status={row.status} map={QUOTE_STATUS_TONE} />,
      },
      {
        id: "quotedTotal",
        header: "Quoted",
        accessor: "quotedTotal",
        type: "number",
        align: "right",
        width: 140,
        cell: ({ row }) => money0(row.quotedTotal, row.currency),
      },
      {
        id: "levelledTotal",
        header: "Levelled",
        accessor: "levelledTotal",
        type: "number",
        align: "right",
        width: 140,
        cell: ({ row }) => (
          <span className="font-semibold">{money0(row.levelledTotal, row.currency)}</span>
        ),
      },
      { id: "lineCount", header: "Lines", accessor: "lineCount", type: "number", align: "right", width: 80 },
      {
        id: "validUntil",
        header: "Valid until",
        accessor: (row) => row.validUntil ?? "",
        type: "text",
        width: 130,
        cell: ({ row }) =>
          row.validUntil === null ? (
            <Badge tone="warning" size="xs">
              No validity stated
            </Badge>
          ) : (
            dateOnly(row.validUntil)
          ),
      },
      { id: "source", header: "Source", accessor: (row) => titleCase(row.source), type: "text", width: 130 },
    ],
    [],
  );

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title="Subcontract quotes"
          subtitle="A quote out of validity is not a price. The validity sweep expires them and tells whoever is relying on them."
          actions={
            <div className="flex gap-2">
              <Button size="sm" variant="secondary" icon={IconImport} onClick={() => setImporting(true)}>
                Import a bid
              </Button>
              <Button size="sm" icon={IconPlus} onClick={() => setCreating(true)}>
                Record a quote
              </Button>
            </div>
          }
        />
        <CardBody flush>
          {quotes.error ? (
            <div className="p-4">
              <LoadError message={quotes.error} onRetry={quotes.reload} />
            </div>
          ) : (
            <DataTable<SubQuote>
              tableId="estimating.subquotes"
              data={quotes.data?.items ?? []}
              columns={columns}
              getRowId={(row) => row.id}
              loading={quotes.loading && !quotes.data}
              height={360}
              rowHeight={44}
              stickyHeader
              flush
              toolbar={false}
              empty={{
                title: "No subcontract quotes yet",
                description:
                  "Record what the trades have quoted, or import a bid submission. Levelling needs at least three prices on a scope row before it will call an outlier.",
              }}
              onRowClick={({ row }) => setOpenId(row.id)}
              rowTone={(row) => (row.status === "expired" ? "danger" : undefined)}
              aria-label="Sub-quotes"
            />
          )}
        </CardBody>
      </Card>

      <LevellingPanel projectId={projectId} packages={packages} selected={packageFilter} onSelect={setPackageFilter} />

      <CreateQuoteModal
        open={creating}
        projectId={projectId}
        onClose={() => setCreating(false)}
        onCreated={() => {
          setCreating(false);
          quotes.reload();
          onChanged();
        }}
      />
      <ImportBidModal
        open={importing}
        projectId={projectId}
        onClose={() => setImporting(false)}
        onImported={() => {
          setImporting(false);
          quotes.reload();
          onChanged();
        }}
      />
      <QuoteDrawer
        projectId={projectId}
        quoteId={openId}
        onClose={() => setOpenId(null)}
        onChanged={() => {
          quotes.reload();
          onChanged();
        }}
      />
    </div>
  );
}

function LevellingPanel({
  projectId,
  packages,
  selected,
  onSelect,
}: {
  projectId: string;
  packages: string[];
  selected: string;
  onSelect: (value: string) => void;
}) {
  const levelling = useResource<Levelling>(
    selected.length > 0
      ? `/api/v1/projects/${projectId}/estimating/sub-quotes/levelling?tradePackage=${encodeURIComponent(selected)}`
      : null,
  );
  const data = levelling.data;

  return (
    <Card>
      <CardHeader
        title="Levelling (#203)"
        subtitle="Compared on scope rows, not on totals. A comparable total fills every row a bidder did not price at the pack median, and says so."
        actions={
          packages.length > 0 ? (
            <Select value={selected} onChange={(e) => onSelect(e.target.value)} size="sm" className="w-56">
              {packages.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </Select>
          ) : undefined
        }
      />
      <CardBody className="space-y-3">
        {packages.length === 0 ? (
          <p className="text-meta text-content-subtle">
            Record at least one quote and its priced lines to level a package.
          </p>
        ) : levelling.error ? (
          <LoadError message={levelling.error} onRetry={levelling.reload} />
        ) : !data ? (
          <p className="text-meta text-content-subtle">Loading…</p>
        ) : (
          <>
            {data.warnings.length > 0 ? (
              <Alert tone="warning" size="sm" title="Read this before comparing">
                <ul className="list-disc space-y-0.5 pl-4">
                  {data.warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              </Alert>
            ) : null}

            {data.totals.length === 0 ? (
              <p className="text-meta text-content-subtle">Nothing to level in this package yet.</p>
            ) : (
              <Table>
                <thead>
                  <tr>
                    <Th>Bidder</Th>
                    <Th align="right">Quoted</Th>
                    <Th align="right">Levelled</Th>
                    <Th align="right">Coverage</Th>
                    <Th align="right">Comparable</Th>
                    <Th>Basis</Th>
                  </tr>
                </thead>
                <tbody>
                  {data.totals.map((t) => (
                    <tr key={t.quoteId}>
                      <Td>
                        <div className="text-content">{t.vendorName}</div>
                        <StatusPill status={t.status} map={QUOTE_STATUS_TONE} />
                      </Td>
                      <Td align="right">{money0(t.quotedTotal, t.currency)}</Td>
                      <Td align="right">{money0(t.levelledTotal, t.currency)}</Td>
                      <Td align="right">{pct(t.coverage, 0)}</Td>
                      <Td align="right" className="font-semibold">
                        {t.comparableTotal === null ? DASH : money0(t.comparableTotal, t.currency)}
                      </Td>
                      <Td>
                        <span className="text-2xs text-content-subtle">{t.comparableBasis}</span>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}

            {data.rows.length > 0 ? (
              <Table>
                <thead>
                  <tr>
                    <Th>Scope row</Th>
                    <Th align="right">Priced by</Th>
                    <Th align="right">Low</Th>
                    <Th align="right">Median</Th>
                    <Th align="right">High</Th>
                    <Th>Verdict</Th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((r) => (
                    <tr key={r.scopeKey}>
                      <Td>
                        <div className="text-content">{r.description}</div>
                        {r.missingVendors.length > 0 ? (
                          <div className="text-2xs text-danger">
                            Not priced by {r.missingVendors.join(", ")}
                          </div>
                        ) : null}
                        {r.entries.some((e) => e.outlier) ? (
                          <div className="text-2xs text-warning">
                            Outlier:{" "}
                            {r.entries
                              .filter((e) => e.outlier)
                              .map((e) => `${e.vendorName} (${num(e.amount, 0)})`)
                              .join(", ")}
                          </div>
                        ) : null}
                      </Td>
                      <Td align="right">
                        {count(r.pricedCount)}
                        {r.excludedCount > 0 ? ` (+${r.excludedCount} excluded)` : ""}
                      </Td>
                      <Td align="right">{r.low === null ? DASH : num(r.low, 2)}</Td>
                      <Td align="right">{r.median === null ? DASH : num(r.median, 2)}</Td>
                      <Td align="right">{r.high === null ? DASH : num(r.high, 2)}</Td>
                      <Td>
                        <span className="text-2xs text-content-subtle">{r.verdict}</span>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            ) : null}
          </>
        )}
      </CardBody>
    </Card>
  );
}

function CreateQuoteModal({
  open,
  projectId,
  onClose,
  onCreated,
}: {
  open: boolean;
  projectId: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [vendorName, setVendorName] = useState("");
  const [tradePackage, setTradePackage] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [quotedTotal, setQuotedTotal] = useState("");
  const [validUntil, setValidUntil] = useState("");
  const [linesRaw, setLinesRaw] = useState("");
  const [exclusions, setExclusions] = useState("");
  const action = useAction();

  useEffect(() => {
    if (open) {
      setVendorName("");
      setTradePackage("");
      setQuotedTotal("");
      setLinesRaw("");
      setExclusions("");
    }
  }, [open]);

  const lines = useMemo(
    () =>
      linesRaw
        .split(/\n+/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => {
          const parts = line.split("|").map((p) => p.trim());
          const [description = line, amount = "0", unit, quantity, rate] = parts;
          return {
            description,
            amount: Number(amount) || 0,
            unit: unit && unit.length > 0 ? unit : null,
            quantity: quantity && quantity.length > 0 ? Number(quantity) : null,
            unitRate: rate && rate.length > 0 ? Number(rate) : null,
            excluded: /^excl/i.test(amount),
          };
        }),
    [linesRaw],
  );

  return (
    <Modal
      open={open}
      title="Record a subcontract quote"
      description="The header total is the number the supplier is bound by; the line sum is a check on it, not a replacement."
      onClose={onClose}
      size="lg"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            loading={action.busy === "create"}
            disabled={vendorName.trim().length === 0 || tradePackage.trim().length === 0}
            onClick={() =>
              void action
                .run("create", () =>
                  estimatingApi.createQuote(projectId, {
                    vendorName,
                    tradePackage,
                    currency,
                    quotedTotal: quotedTotal.trim().length > 0 ? Number(quotedTotal) : undefined,
                    validUntil: validUntil.length > 0 ? validUntil : null,
                    exclusions: exclusions.trim().length > 0 ? exclusions : null,
                    lines,
                  }),
                )
                .then((res) => {
                  if (res) {
                    toast.success(`${res.reference} recorded`);
                    onCreated();
                  }
                })
            }
          >
            Record
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        {action.error ? (
          <Alert tone="danger" size="sm">
            {action.error}
          </Alert>
        ) : null}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Supplier" required>
            <Input value={vendorName} onChange={(e) => setVendorName(e.target.value)} />
          </Field>
          <Field label="Trade package" required>
            <Input value={tradePackage} onChange={(e) => setTradePackage(e.target.value)} placeholder="Groundworks" />
          </Field>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Currency">
            <Input value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} maxLength={3} />
          </Field>
          <Field label="Quoted total" optional hint="Leave blank to derive it from the lines">
            <Input value={quotedTotal} onChange={(e) => setQuotedTotal(e.target.value)} inputMode="decimal" />
          </Field>
          <Field label="Valid until" optional>
            <Input type="date" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} />
          </Field>
        </div>
        <Field
          label="Priced lines"
          optional
          hint="One per line: description | amount | unit | quantity | rate. Only the description and amount are needed."
        >
          <Textarea
            value={linesRaw}
            onChange={(e) => setLinesRaw(e.target.value)}
            rows={5}
            placeholder={"Bulk excavation | 10000 | m3 | 800 | 12.5\nDisposal | 4000"}
          />
        </Field>
        <Field label="Exclusions" optional>
          <Textarea value={exclusions} onChange={(e) => setExclusions(e.target.value)} rows={2} />
        </Field>
        {lines.length > 0 ? (
          <p className="text-2xs text-content-subtle">
            {lines.length} line{lines.length === 1 ? "" : "s"} parsed, summing to{" "}
            {num(lines.reduce((s, l) => s + l.amount, 0), 2)}.
          </p>
        ) : null}
      </div>
    </Modal>
  );
}

function ImportBidModal({
  open,
  projectId,
  onClose,
  onImported,
}: {
  open: boolean;
  projectId: string;
  onClose: () => void;
  onImported: () => void;
}) {
  const [submissionId, setSubmissionId] = useState("");
  const [tradePackage, setTradePackage] = useState("");
  const action = useAction();

  return (
    <Modal
      open={open}
      title="Import a bid submission"
      description="Pulls the bidder's header total, its priced lines, its exclusions and its validity date across from the bidding module. The header total is kept even when the lines disagree — and the difference is reported."
      onClose={onClose}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            loading={action.busy === "import"}
            disabled={submissionId.trim().length === 0}
            onClick={() =>
              void action
                .run("import", () =>
                  estimatingApi.importBid(projectId, {
                    submissionId: submissionId.trim(),
                    tradePackage: tradePackage.trim().length > 0 ? tradePackage : undefined,
                  }),
                )
                .then((res) => {
                  if (res) {
                    toast.success(`${res.reference} imported from the bid`);
                    for (const w of res.warnings ?? []) toast.warning(w);
                    onImported();
                  }
                })
            }
          >
            Import
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        {action.error ? (
          <Alert tone="danger" size="sm">
            {action.error}
          </Alert>
        ) : null}
        <Field label="Bid submission id" required hint="From the Bidding workspace on this project.">
          <Input value={submissionId} onChange={(e) => setSubmissionId(e.target.value)} />
        </Field>
        <Field label="Trade package" optional hint="Defaults to the bid package.">
          <Input value={tradePackage} onChange={(e) => setTradePackage(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

function QuoteDrawer({
  projectId,
  quoteId,
  onClose,
  onChanged,
}: {
  projectId: string;
  quoteId: string | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [estimateId, setEstimateId] = useState("");
  const action = useAction();
  const quote = useResource<SubQuoteDetail>(
    quoteId ? `/api/v1/projects/${projectId}/estimating/sub-quotes/${quoteId}` : null,
  );
  const estimates = useResource<Paginated<Estimate>>(
    quoteId ? `/api/v1/projects/${projectId}/estimates?page=1&pageSize=100&headsOnly=true` : null,
  );
  const draftEstimates = (estimates.data?.items ?? []).filter(
    (e) => e.status === "draft" || e.status === "in_review",
  );

  const q = quote.data;

  return (
    <Drawer
      open={quoteId !== null}
      onClose={onClose}
      size="lg"
      title={q ? `${q.reference} — ${q.vendorName}` : "Sub-quote"}
      description={
        q ? (
          <span className="flex flex-wrap items-center gap-2">
            <StatusPill status={q.status} map={QUOTE_STATUS_TONE} />
            <span className="text-2xs text-content-subtle">
              {q.tradePackage} · {money(q.quotedTotal, q.currency)}
              {q.validUntil ? ` · valid until ${dateOnly(q.validUntil)}` : " · no validity stated"}
            </span>
          </span>
        ) : undefined
      }
    >
      {quote.error ? (
        <LoadError message={quote.error} onRetry={quote.reload} />
      ) : !q ? (
        <div className="text-meta text-content-subtle">Loading…</div>
      ) : (
        <div className="space-y-4">
          {action.error ? (
            <Alert tone="danger" size="sm" onDismiss={action.clear}>
              {action.error}
            </Alert>
          ) : null}
          {q.status === "expired" ? (
            <Alert tone="danger" size="sm" title="Out of validity">
              This price lapsed on {dateOnly(q.validUntil)}. Re-confirm it with {q.vendorName} and re-date it
              before it is used in an estimate.
            </Alert>
          ) : null}

          <dl className="divide-y divide-border">
            <Row label="Quoted">{money(q.quotedTotal, q.currency)}</Row>
            <Row label="Levelling adjustment" hint="Scope added back to make the quote comparable">
              {money(q.adjustmentAmount, q.currency)}
            </Row>
            <Row label="Levelled">
              <span className="font-semibold">{money(q.levelledTotal, q.currency)}</span>
            </Row>
            <Row label="Quote date">{dateOnly(q.quoteDate)}</Row>
            <Row label="Source">{titleCase(q.source)}</Row>
            {q.exclusions ? <Row label="Exclusions">{q.exclusions}</Row> : null}
            {q.qualifications ? <Row label="Qualifications">{q.qualifications}</Row> : null}
          </dl>

          {q.lines.length > 0 ? (
            <Table dense>
              <thead>
                <tr>
                  <Th>Scope</Th>
                  <Th align="right">Qty</Th>
                  <Th align="right">Rate</Th>
                  <Th align="right">Amount</Th>
                </tr>
              </thead>
              <tbody>
                {q.lines.map((l) => (
                  <tr key={l.id}>
                    <Td>
                      {l.description}
                      {l.excluded === 1 ? (
                        <Badge tone="warning" size="xs" className="ml-2">
                          Excluded
                        </Badge>
                      ) : null}
                    </Td>
                    <Td align="right">
                      {l.quantity === null ? DASH : `${num(l.quantity, 2)} ${l.unit ?? ""}`}
                    </Td>
                    <Td align="right">{l.unitRate === null ? DASH : num(l.unitRate, 2)}</Td>
                    <Td align="right">{money(l.amount, q.currency)}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          ) : (
            <Alert tone="info" size="sm">
              This quote carries a header total but no priced lines, so it takes no part in the scope
              comparison.
            </Alert>
          )}

          {q.status !== "accepted" ? (
            <Card>
              <CardHeader
                title="Accept onto an estimate"
                subtitle="Writes one estimate line per priced, non-excluded scope row, each citing this quote."
              />
              <CardBody className="space-y-3">
                <Field label="Estimate">
                  <Select value={estimateId} onChange={(e) => setEstimateId(e.target.value)}>
                    <option value="">Choose an editable estimate</option>
                    {draftEstimates.map((e) => (
                      <option key={e.id} value={e.id}>
                        {e.reference} rev {e.version} — {e.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Button
                  size="sm"
                  disabled={estimateId.length === 0 || q.lines.length === 0}
                  loading={action.busy === "accept"}
                  onClick={() =>
                    void action
                      .run("accept", () => estimatingApi.acceptQuote(projectId, q.id, { estimateId }))
                      .then((res) => {
                        if (res) {
                          toast.success(`${res.created} lines added`);
                          for (const w of res.warnings) toast.warning(w);
                          quote.reload();
                          onChanged();
                        }
                      })
                  }
                >
                  Accept
                </Button>
              </CardBody>
            </Card>
          ) : (
            <Alert tone="success" size="sm" title="Accepted">
              This quote has been priced into an estimate; its lines can no longer be rewritten.
            </Alert>
          )}
        </div>
      )}
    </Drawer>
  );
}
