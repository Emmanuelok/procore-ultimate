/**
 * CERTIFICATES — the deduction statement issued per payment (#800, #802,
 * #804). A certificate is drafted from a determination (or typed, when the
 * deduction was made outside the engine) and ISSUED BY A SECOND PERSON; the
 * printed reference only exists once it is issued. Cancellation keeps the
 * row and records why.
 */
import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  DataTable,
  Drawer,
  Field,
  Input,
  Select,
  Textarea,
  toast,
  type DataColumns,
} from "../../ui";
import { IconPlus } from "../../ui/icons";
import { useAuth } from "../../lib/auth";
import {
  DASH,
  LoadError,
  Row,
  WITHHOLDING_SCHEMES,
  certificateTone,
  dateTime,
  isoDate,
  money,
  pct,
  taxApi,
  titleCase,
  useAction,
  useProfile,
  useRegimes,
  useResource,
  useVendors,
  type Certificate,
  type CertificateDetail,
  type Paginated,
} from "./taxShared";

export default function CertificatesTab({ projectId, onChanged }: { projectId: string; onChanged: () => void }) {
  const [status, setStatus] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  const params = new URLSearchParams({ page: "1", pageSize: "500" });
  if (status) params.set("status", status);
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  const list = useResource<Paginated<Certificate>>(`/api/v1/projects/${projectId}/tax/withholding-certificates?${params.toString()}`);

  const columns = useMemo<DataColumns<Certificate>>(
    () => [
      { id: "number", header: "#", accessor: "number", type: "number", width: 70, mono: true, cell: ({ row }) => <span className="font-mono">{row.reference ?? `draft ${row.number}`}</span> },
      { id: "vendorName", header: "Payee", accessor: "vendorName", type: "text", width: 220 },
      { id: "scheme", header: "Scheme", accessor: (row) => row.scheme.toUpperCase(), type: "code", width: 80, mono: true },
      { id: "paymentDate", header: "Payment date", accessor: "paymentDate", type: "date", width: 120 },
      { id: "grossAmount", header: "Gross", accessor: "grossAmount", type: "number", align: "right", width: 130, cell: ({ row }) => money(row.grossAmount, row.currency) },
      { id: "materialsAmount", header: "Materials", accessor: "materialsAmount", type: "number", align: "right", width: 120, cell: ({ row }) => (row.materialsAmount > 0 ? money(row.materialsAmount, row.currency) : DASH) },
      { id: "baseAmount", header: "Base", accessor: "baseAmount", type: "number", align: "right", width: 130, cell: ({ row }) => money(row.baseAmount, row.currency) },
      { id: "rate", header: "Rate", accessor: "rate", type: "number", align: "right", width: 80, cell: ({ row }) => pct(row.rate) },
      { id: "withheldAmount", header: "Withheld", accessor: "withheldAmount", type: "number", align: "right", width: 130, cell: ({ row }) => <span className="font-semibold">{money(row.withheldAmount, row.currency)}</span> },
      { id: "netPaid", header: "Net paid", accessor: "netPaid", type: "number", align: "right", width: 130, cell: ({ row }) => money(row.netPaid, row.currency) },
      { id: "status", header: "Status", accessor: "status", type: "text", width: 110, cell: ({ row }) => <Badge tone={certificateTone(row.status)} size="xs" dot>{titleCase(row.status)}</Badge> },
    ],
    [],
  );

  return (
    <div className="space-y-4">
      <Card>
        <CardBody className="flex flex-wrap items-end gap-3">
          <Field label="Status">
            <Select value={status} onChange={(e) => setStatus(e.target.value)} size="sm">
              <option value="">Any</option>
              <option value="draft">Draft</option>
              <option value="issued">Issued</option>
              <option value="cancelled">Cancelled</option>
            </Select>
          </Field>
          <Field label="Paid from">
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} size="sm" />
          </Field>
          <Field label="Paid to">
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} size="sm" />
          </Field>
          <div className="ml-auto">
            <Button icon={IconPlus} onClick={() => setCreating(true)}>
              New certificate
            </Button>
          </div>
        </CardBody>
      </Card>

      {list.error ? (
        <LoadError message={list.error} onRetry={list.reload} />
      ) : (
        <DataTable<Certificate>
          tableId="tax.certificates"
          data={list.data?.items ?? []}
          columns={columns}
          getRowId={(row) => row.id}
          loading={list.loading && !list.data}
          height={520}
          rowHeight={44}
          stickyHeader
          exportFileName="withholding-certificates"
          empty={{
            title: "No withholding certificates",
            description: "Draft one from a determination on the Determinations tab, or record one here when the deduction was made outside the engine.",
          }}
          onRowClick={({ row }) => setOpenId(row.id)}
          rowTone={(row) => (row.status === "draft" ? "warning" : row.status === "cancelled" ? "neutral" : undefined)}
          aria-label="Withholding certificates"
        />
      )}

      <CertificateCreateDrawer
        projectId={projectId}
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={() => {
          setCreating(false);
          list.reload();
          onChanged();
        }}
      />
      <CertificateDrawer
        projectId={projectId}
        certificateId={openId}
        onClose={() => setOpenId(null)}
        onChanged={() => {
          list.reload();
          onChanged();
        }}
      />
    </div>
  );
}

/* ================================= Create ================================= */

export function CertificateCreateDrawer({
  projectId,
  open,
  onClose,
  onCreated,
  determinationId = null,
}: {
  projectId: string;
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
  /** pre-bound determination: the figures come from it */
  determinationId?: string | null;
}) {
  const action = useAction();
  const vendors = useVendors();
  const regimes = useRegimes();
  const profile = useProfile(projectId);
  const [vendorId, setVendorId] = useState("");
  const [vendorName, setVendorName] = useState("");
  const [regime, setRegime] = useState("");
  const [scheme, setScheme] = useState("cis");
  const [paymentDate, setPaymentDate] = useState("");
  const [currency, setCurrency] = useState("");
  const [gross, setGross] = useState("");
  const [materials, setMaterials] = useState("");
  const [rate, setRate] = useState("");
  const [paymentId, setPaymentId] = useState("");
  const [invoiceId, setInvoiceId] = useState("");

  useEffect(() => {
    if (!open) return;
    setVendorId("");
    setVendorName("");
    setRegime(profile.data?.resolved.regime ?? "");
    setScheme("cis");
    setPaymentDate(new Date().toISOString().slice(0, 10));
    setCurrency(profile.data?.profile?.currency ?? "");
    setGross("");
    setMaterials("");
    setRate("");
    setPaymentId("");
    setInvoiceId("");
    action.clear();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const body: Record<string, unknown> = { paymentDate };
    if (determinationId) body["determinationId"] = determinationId;
    if (vendorId) body["vendorId"] = vendorId;
    if (vendorName.trim()) body["vendorName"] = vendorName.trim();
    if (!determinationId) {
      if (regime) body["regime"] = regime;
      body["scheme"] = scheme;
      if (currency.trim()) body["currency"] = currency.trim().toUpperCase();
      if (gross.trim() !== "") body["grossAmount"] = Number(gross);
      if (rate.trim() !== "") body["rate"] = Number(rate);
    }
    if (materials.trim() !== "") body["materialsAmount"] = Number(materials);
    if (paymentId.trim()) body["paymentId"] = paymentId.trim();
    if (invoiceId.trim()) body["invoiceId"] = invoiceId.trim();
    const created = await action.run("create", () => taxApi.createCertificate(projectId, body));
    if (created) {
      toast.success(`Certificate drafted: ${money(created.withheldAmount, created.currency)} withheld`);
      onCreated();
    }
  }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      size="md"
      title={determinationId ? "Draft a certificate from this determination" : "Record a withholding certificate"}
      description="Drafting is one person's act; issuing is another's. The reference is assigned on issue."
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="tax-certificate-create" loading={action.busy === "create"}>
            Draft certificate
          </Button>
        </div>
      }
    >
      <form id="tax-certificate-create" onSubmit={submit} className="space-y-4">
        {action.error ? <Alert tone="danger" size="sm">{action.error}</Alert> : null}
        {determinationId ? (
          <Alert tone="info" size="sm">
            Gross, materials, base, scheme and rate come from the determination. Only the payment details are typed here.
          </Alert>
        ) : null}
        <Field label="Payment date" required>
          <Input type="date" value={paymentDate} onChange={(e) => setPaymentDate(e.target.value)} required />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Payment id" hint="commitment payment, when recorded">
            <Input value={paymentId} onChange={(e) => setPaymentId(e.target.value)} />
          </Field>
          <Field label="Invoice id">
            <Input value={invoiceId} onChange={(e) => setInvoiceId(e.target.value)} />
          </Field>
        </div>
        {!determinationId ? (
          <>
            <Field label="Payee (vendor)" hint="or type a name below">
              <Select value={vendorId} onChange={(e) => setVendorId(e.target.value)} placeholder="Choose the vendor">
                {(vendors.data?.items ?? []).map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Payee name">
              <Input value={vendorName} onChange={(e) => setVendorName(e.target.value)} />
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Regime" required>
                <Select value={regime} onChange={(e) => setRegime(e.target.value)} placeholder="Choose the regime">
                  {(regimes.data?.items ?? []).map((r) => (
                    <option key={r.regime} value={r.regime}>
                      {r.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Scheme" required>
                <Select value={scheme} onChange={(e) => setScheme(e.target.value)}>
                  {WITHHOLDING_SCHEMES.filter((s) => s !== "none").map((s) => (
                    <option key={s} value={s}>
                      {s.toUpperCase()}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <div className="grid gap-3 sm:grid-cols-4">
              <Field label="Currency" required>
                <Input value={currency} onChange={(e) => setCurrency(e.target.value)} maxLength={3} />
              </Field>
              <Field label="Gross" required>
                <Input type="number" min={0} step="0.01" value={gross} onChange={(e) => setGross(e.target.value)} />
              </Field>
              <Field label="Materials">
                <Input type="number" min={0} step="0.01" value={materials} onChange={(e) => setMaterials(e.target.value)} />
              </Field>
              <Field label="Rate (%)" required>
                <Input type="number" min={0} max={100} step="0.5" value={rate} onChange={(e) => setRate(e.target.value)} />
              </Field>
            </div>
            <div className="text-2xs text-content-subtle">
              Without a determination the base is the gross amount (materials are not excluded); draft from a determination to apply the scheme's base rule.
            </div>
          </>
        ) : null}
      </form>
    </Drawer>
  );
}

/* ================================= Detail ================================= */

function CertificateDrawer({ projectId, certificateId, onClose, onChanged }: { projectId: string; certificateId: string | null; onClose: () => void; onChanged: () => void }) {
  const { user } = useAuth();
  const detail = useResource<CertificateDetail>(certificateId ? `/api/v1/projects/${projectId}/tax/withholding-certificates/${certificateId}` : null);
  const action = useAction();
  const [reason, setReason] = useState("");
  const c = detail.data;
  const isDrafter = c !== null && user !== null && c.createdBy === user.id;

  useEffect(() => {
    setReason("");
    action.clear();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [certificateId]);

  async function issue() {
    if (!c) return;
    const res = await action.run("issue", () => taxApi.issueCertificate(projectId, c.id));
    if (res) {
      toast.success(`Issued ${res.reference ?? "certificate"}`);
      detail.reload();
      onChanged();
    }
  }

  async function cancel(e: FormEvent) {
    e.preventDefault();
    if (!c) return;
    const res = await action.run("cancel", () => taxApi.cancelCertificate(projectId, c.id, reason.trim()));
    if (res) {
      toast.success("Certificate cancelled");
      detail.reload();
      onChanged();
    }
  }

  return (
    <Drawer
      open={certificateId !== null}
      onClose={onClose}
      size="lg"
      title={c ? `${c.reference ?? `Draft ${c.number}`} — ${c.vendorName}` : "Certificate"}
      description={c?.certificateName ?? undefined}
    >
      {detail.loading && !c ? <div className="text-meta text-content-subtle">Loading…</div> : null}
      {detail.error ? <LoadError message={detail.error} onRetry={detail.reload} /> : null}
      {c ? (
        <div className="space-y-5">
          {action.error ? <Alert tone="danger" size="sm">{action.error}</Alert> : null}
          <div className="flex items-center gap-2">
            <Badge tone={certificateTone(c.status)} size="sm" dot>
              {titleCase(c.status)}
            </Badge>
            <Badge tone="neutral" size="sm">
              {c.scheme.toUpperCase()} · {c.regime.toUpperCase()}
            </Badge>
          </div>
          <dl className="divide-y divide-border">
            <Row label="Payment date">{isoDate(c.paymentDate)}</Row>
            <Row label="Gross">{money(c.grossAmount, c.currency)}</Row>
            <Row label="Materials excluded">{money(c.materialsAmount, c.currency)}</Row>
            <Row label="Deduction base">{money(c.baseAmount, c.currency)}</Row>
            <Row label="Rate">{pct(c.rate)}</Row>
            <Row label="Withheld">
              <span className="font-semibold">{money(c.withheldAmount, c.currency)}</span>
            </Row>
            <Row label="Net paid">{money(c.netPaid, c.currency)}</Row>
            <Row label="Determination">{c.determinationId ?? <span className="text-content-subtle">typed, not from the engine</span>}</Row>
            <Row label="Payment / invoice">
              {c.paymentId ?? DASH} / {c.invoiceId ?? DASH}
            </Row>
            <Row label="Drafted">{dateTime(c.createdAt)}</Row>
            {c.issuedAt ? <Row label="Issued">{dateTime(c.issuedAt)}</Row> : null}
            {c.cancelledAt ? (
              <Row label="Cancelled" hint={c.cancelReason ?? undefined}>
                {dateTime(c.cancelledAt)}
              </Row>
            ) : null}
            {c.remittance ? <Row label="Remittance">{c.remittance}</Row> : null}
          </dl>

          {c.status === "draft" ? (
            <section className="space-y-2 rounded-md border border-border p-3">
              <h3 className="text-sm font-semibold text-content">Issue</h3>
              {isDrafter ? (
                <Alert tone="warning" size="sm">
                  You drafted this certificate, so you cannot issue it. A second person must issue the statement the payee relies on.
                </Alert>
              ) : (
                <Button size="sm" onClick={() => void issue()} loading={action.busy === "issue"}>
                  Issue certificate
                </Button>
              )}
            </section>
          ) : null}

          {c.status !== "cancelled" ? (
            <form onSubmit={cancel} className="space-y-2 rounded-md border border-border p-3">
              <h3 className="text-sm font-semibold text-content">Cancel</h3>
              <Field label="Reason" required>
                <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} required />
              </Field>
              <Button type="submit" size="sm" variant="danger" disabled={reason.trim().length === 0} loading={action.busy === "cancel"}>
                Cancel certificate
              </Button>
            </form>
          ) : null}
        </div>
      ) : null}
    </Drawer>
  );
}
