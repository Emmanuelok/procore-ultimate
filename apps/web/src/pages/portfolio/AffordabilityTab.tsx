/**
 * AFFORDABILITY — the envelope portfolio demand is measured against (#426) and
 * the capital/revenue split of that demand (#430–#431).
 *
 * Demand is matched to an envelope on fiscal year, currency AND expenditure
 * class: a capital envelope does not pay for revenue spend, and saying so is
 * the whole point of the control. Allocations that no active envelope covers
 * are listed separately rather than quietly counted against the nearest one.
 */
import { useEffect, useMemo, useState, type FormEvent } from "react";
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
  Progress,
  Select,
  Table,
  Td,
  Textarea,
  Th,
  toast,
  type DataColumns,
} from "../../ui";
import { IconPlus } from "../../ui/icons";
import {
  DASH,
  EXPENDITURE_CLASSES,
  LoadError,
  ReasonList,
  headroomTone,
  money,
  moneyShort,
  num,
  pct,
  portfolioApi,
  statusTone,
  titleCase,
  useAction,
  useIsCompanyAdmin,
  useResource,
  utilisationTone,
  type AffordabilityLine,
  type AffordabilityResult,
  type Envelope,
  type Paginated,
} from "./portfolioShared";

export default function AffordabilityTab({ onChanged }: { onChanged: () => void }) {
  const isAdmin = useIsCompanyAdmin();
  const action = useAction();
  const [creating, setCreating] = useState(false);

  const envelopes = useResource<Paginated<Envelope>>("/api/v1/portfolio/envelopes?page=1&pageSize=200");
  const affordability = useResource<AffordabilityResult>("/api/v1/portfolio/affordability");

  function reloadAll() {
    envelopes.reload();
    affordability.reload();
    onChanged();
  }

  async function activate(id: string) {
    const res = await action.run(id, () => portfolioApi.activateEnvelope(id));
    if (res) {
      toast.success("Envelope activated; any earlier ceiling for the same year, currency and class is superseded");
      reloadAll();
    }
  }

  const envelopeColumns = useMemo<DataColumns<Envelope>>(
    () => [
      { id: "name", header: "Envelope", accessor: "name", type: "text", width: 260 },
      { id: "fiscalYear", header: "Year", accessor: "fiscalYear", type: "text", width: 100 },
      {
        id: "expenditureClass",
        header: "Class",
        accessor: "expenditureClass",
        type: "text",
        width: 120,
        cell: ({ row }) => titleCase(row.expenditureClass),
      },
      {
        id: "envelopeAmount",
        header: "Ceiling",
        accessor: "envelopeAmount",
        type: "number",
        align: "right",
        width: 160,
        cell: ({ row }) => moneyShort(row.envelopeAmount, row.currency),
      },
      {
        id: "status",
        header: "Status",
        accessor: "status",
        type: "text",
        width: 130,
        cell: ({ row }) => (
          <Badge tone={statusTone(row.status)} size="xs" dot>
            {titleCase(row.status)}
          </Badge>
        ),
      },
      {
        id: "basis",
        header: "Basis",
        accessor: (r) => r.basis ?? "",
        type: "text",
        width: 340,
        cell: ({ row }) =>
          row.basis ?? (
            <span className="italic text-warning-text">
              no basis recorded — a ceiling with no stated basis is an assertion
            </span>
          ),
      },
      {
        id: "actions",
        header: "",
        accessor: () => "",
        type: "text",
        width: 110,
        cell: ({ row }) =>
          isAdmin && row.status === "draft" ? (
            <Button size="xs" onClick={() => void activate(row.id)} loading={action.busy === row.id}>
              Activate
            </Button>
          ) : null,
      },
    ],
    // activate/action identities are stable enough for this table
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [isAdmin, action.busy],
  );

  const a = affordability.data;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title="Envelope versus demand"
          subtitle="Demand is matched on fiscal year, currency and expenditure class. A capital envelope does not pay for revenue spend."
        />
        <CardBody flush>
          {affordability.error ? (
            <div className="p-4">
              <LoadError message={affordability.error} onRetry={affordability.reload} />
            </div>
          ) : !a ? (
            <div className="p-4 text-meta text-content-subtle">Loading…</div>
          ) : a.lines.length === 0 ? (
            <div className="p-4">
              <Alert tone="info" size="sm" title="No active envelope">
                A draft or superseded ceiling is not a control. Create an envelope for the year and activate it,
                and portfolio demand will be measured against it from then on.
              </Alert>
            </div>
          ) : (
            <div className="divide-y divide-border">
              {a.lines.map((line: AffordabilityLine) => (
                <div key={line.envelopeId} className="p-4">
                  <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
                    <div>
                      <span className="font-semibold text-content">{line.name}</span>
                      <span className="ml-2 text-meta text-content-subtle">
                        {line.fiscalYear} · {line.currency} · {titleCase(line.expenditureClass)}
                      </span>
                    </div>
                    <Badge tone={line.breached ? "danger" : "success"} size="xs" dot>
                      {line.breached
                        ? `Over by ${moneyShort(line.breachedBy, line.currency)}`
                        : `${moneyShort(line.headroom, line.currency)} headroom`}
                    </Badge>
                  </div>
                  <Progress
                    value={Math.min(line.utilisationPercent ?? 0, 100)}
                    tone={utilisationTone(line.utilisationPercent) ?? "success"}
                    aria-label={`${line.name} utilisation`}
                  />
                  <div className="mt-2 flex flex-wrap gap-4 text-meta text-content-muted">
                    <span>
                      Envelope <span className="font-semibold text-content">{money(line.envelope, line.currency)}</span>
                    </span>
                    <span>
                      Demand <span className="font-semibold text-content">{money(line.demand, line.currency)}</span>
                    </span>
                    <span>
                      Headroom{" "}
                      <span
                        className={
                          headroomTone(line.headroom) === "danger"
                            ? "font-semibold text-danger-text"
                            : "font-semibold text-content"
                        }
                      >
                        {money(line.headroom, line.currency)}
                      </span>
                    </span>
                    <span>
                      Utilisation <span className="font-semibold text-content">{pct(line.utilisationPercent)}</span>
                    </span>
                    <span>{num(line.allocationCount)} allocation(s)</span>
                  </div>
                  {line.basis ? (
                    <p className="mt-1 text-2xs text-content-subtle">Basis: {line.basis}</p>
                  ) : (
                    <p className="mt-1 text-2xs text-warning-text">
                      No basis is recorded for this ceiling; how it was arrived at is not on the record.
                    </p>
                  )}
                  <ReasonList reasons={line.reasons} className="mt-1" />
                </div>
              ))}
            </div>
          )}
        </CardBody>
        {a ? (
          <CardBody className="border-t border-border">
            <ReasonList reasons={a.reasons} />
            {a.uncovered.length > 0 ? (
              <div className="mt-2">
                <div className="mb-1 text-2xs font-semibold uppercase tracking-wide text-content-subtle">
                  Demand no active envelope covers
                </div>
                <div className="overflow-x-auto">
                  <Table>
                    <thead>
                      <tr>
                        <Th>Year</Th>
                        <Th>Currency</Th>
                        <Th>Class</Th>
                        <Th align="right">Amount</Th>
                        <Th align="right">Allocations</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {a.uncovered.map((u, i) => (
                        <tr key={`${u.fiscalYear}-${u.currency}-${u.expenditureClass}-${i}`}>
                          <Td>{u.fiscalYear}</Td>
                          <Td>{u.currency}</Td>
                          <Td>{titleCase(u.expenditureClass)}</Td>
                          <Td align="right">{moneyShort(u.amount, u.currency)}</Td>
                          <Td align="right">{num(u.count)}</Td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                </div>
              </div>
            ) : null}
          </CardBody>
        ) : null}
      </Card>

      {a && a.classificationSplit && a.classificationSplit.length > 0 ? (
        <Card>
          <CardHeader
            title="Capital versus revenue"
            subtitle="The split of allocated demand by expenditure class, per currency (#430–#431)."
          />
          <CardBody flush>
            <div className="overflow-x-auto">
              <Table>
                <thead>
                  <tr>
                    <Th>Currency</Th>
                    <Th align="right">Capital</Th>
                    <Th align="right">Revenue</Th>
                    <Th align="right">Mixed</Th>
                    <Th align="right">Unclassified</Th>
                    <Th align="right">Total</Th>
                    <Th align="right">Capital %</Th>
                  </tr>
                </thead>
                <tbody>
                  {a.classificationSplit.map((b) => (
                    <tr key={b.currency}>
                      <Td>
                        <span className="font-semibold">{b.currency}</span>
                      </Td>
                      <Td align="right">{moneyShort(b.capital, null)}</Td>
                      <Td align="right">{moneyShort(b.revenue, null)}</Td>
                      <Td align="right">{moneyShort(b.mixed, null)}</Td>
                      <Td align="right">
                        {b.unclassified > 0 ? (
                          <span className="text-warning-text">{moneyShort(b.unclassified, null)}</span>
                        ) : (
                          DASH
                        )}
                      </Td>
                      <Td align="right">{moneyShort(b.total, null)}</Td>
                      <Td align="right">{pct(b.capitalPercent, 0)}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </div>
          </CardBody>
        </Card>
      ) : null}

      <Card>
        <CardHeader
          title="Envelopes"
          subtitle="One active envelope per portfolio, year, currency and expenditure class. Activating a new one supersedes the old, which stays readable as the ceiling a past decision was taken against."
          actions={
            isAdmin ? (
              <Button size="sm" icon={IconPlus} onClick={() => setCreating(true)}>
                New envelope
              </Button>
            ) : undefined
          }
        />
        <CardBody flush>
          {action.error ? (
            <div className="p-3">
              <Alert tone="danger" size="sm">
                {action.error}
              </Alert>
            </div>
          ) : null}
          {envelopes.error ? (
            <div className="p-4">
              <LoadError message={envelopes.error} onRetry={envelopes.reload} />
            </div>
          ) : (
            <DataTable<Envelope>
              tableId="portfolio.envelopes"
              data={envelopes.data?.items ?? []}
              columns={envelopeColumns}
              getRowId={(row) => row.id}
              loading={envelopes.loading && !envelopes.data}
              height={320}
              rowHeight={44}
              stickyHeader
              flush
              toolbar={false}
              empty={{
                title: "No envelopes",
                description:
                  "An affordability envelope is the ceiling the portfolio's demand is measured against for one year, currency and expenditure class.",
                action: isAdmin ? <Button onClick={() => setCreating(true)}>Add an envelope</Button> : undefined,
              }}
              aria-label="Affordability envelopes"
            />
          )}
        </CardBody>
      </Card>

      <EnvelopeCreateDrawer
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={() => {
          setCreating(false);
          reloadAll();
        }}
      />
    </div>
  );
}

function EnvelopeCreateDrawer({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const action = useAction();
  const [form, setForm] = useState<Record<string, string>>({});

  useEffect(() => {
    setForm({});
    action.clear();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const set = (key: string, value: string) => setForm((f) => ({ ...f, [key]: value }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    const amount = Number(form["envelopeAmount"] ?? "");
    const res = await action.run("create", () =>
      portfolioApi.createEnvelope({
        name: form["name"] ?? "",
        fiscalYear: form["fiscalYear"] ?? "",
        currency: form["currency"] ?? "",
        envelopeAmount: Number.isFinite(amount) ? amount : 0,
        expenditureClass: form["expenditureClass"] ?? "capital",
        basis: form["basis"] || undefined,
      }),
    );
    if (res) {
      toast.success("Envelope drafted — activate it to make it the live ceiling");
      onCreated();
    }
  }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      size="md"
      title="New affordability envelope"
      description="Record how the ceiling was arrived at. A ceiling with no stated basis cannot be defended when it is challenged."
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="portfolio-envelope-create" loading={action.busy === "create"}>
            Save as draft
          </Button>
        </div>
      }
    >
      <form id="portfolio-envelope-create" onSubmit={submit} className="space-y-4">
        {action.error ? (
          <Alert tone="danger" size="sm">
            {action.error}
          </Alert>
        ) : null}
        <Field label="Name" required>
          <Input value={form["name"] ?? ""} onChange={(e) => set("name", e.target.value)} required />
        </Field>
        <div className="grid gap-3 sm:grid-cols-4">
          <Field label="Fiscal year" required>
            <Input value={form["fiscalYear"] ?? ""} onChange={(e) => set("fiscalYear", e.target.value)} required />
          </Field>
          <Field label="Currency" required>
            <Input value={form["currency"] ?? ""} onChange={(e) => set("currency", e.target.value)} maxLength={3} required />
          </Field>
          <Field label="Ceiling" required>
            <Input
              type="number"
              value={form["envelopeAmount"] ?? ""}
              onChange={(e) => set("envelopeAmount", e.target.value)}
              min={0}
              step="0.01"
              required
            />
          </Field>
          <Field label="Class">
            <Select
              value={form["expenditureClass"] ?? "capital"}
              onChange={(e) => set("expenditureClass", e.target.value)}
            >
              {EXPENDITURE_CLASSES.map((c) => (
                <option key={c} value={c}>
                  {titleCase(c)}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="Basis" hint="Where the ceiling comes from — the plan, the paper, the decision date">
          <Textarea rows={3} value={form["basis"] ?? ""} onChange={(e) => set("basis", e.target.value)} />
        </Field>
      </form>
    </Drawer>
  );
}
