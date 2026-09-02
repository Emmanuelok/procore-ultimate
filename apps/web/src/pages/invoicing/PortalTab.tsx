/**
 * VENDOR PORTAL (#567–568) — the subcontractor's self-service identity.
 *
 * A token is bound to one vendor on this project (optionally one
 * commitment), carries explicit scopes, an expiry and a revocation switch.
 * The raw link is shown ONCE when it is minted; only its hash is kept, so
 * the register below can never leak it. With the link the vendor sees their
 * schedule of values, raises and submits their own progress invoice under the
 * same over-billing rules as a user, watches payments and remittances,
 * returns a requested waiver, and answers an RFQ.
 */
import { useMemo, useState } from "react";
import { api } from "../../lib/api";
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
  Modal,
  Select,
} from "../../ui";
import { DataTable, type DataColumns } from "../../ui/data";
import { toast } from "../../ui/overlays";
import { IconVendor } from "../../ui/icons";
import { errorMessage, isoDateTime, useResource, type InvoicingContext } from "./invoicingShared";

interface TokenRow {
  id: string;
  vendorId: string;
  vendorName: string | null;
  commitmentId: string | null;
  label: string;
  scopes: string[];
  contactEmail: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
  useCount: number;
  createdAt: string;
  active: boolean;
}

const SCOPES = ["invoices", "rfqs", "documents"] as const;

export default function PortalTab({ projectId, context }: { projectId: string; context: InvoicingContext }) {
  const tokens = useResource<{ items: TokenRow[]; total: number }>(`/api/v1/projects/${projectId}/vendor-portal/tokens`);
  const [minting, setMinting] = useState(false);
  const [vendorId, setVendorId] = useState("");
  const [commitmentId, setCommitmentId] = useState("");
  const [label, setLabel] = useState("");
  const [email, setEmail] = useState("");
  const [scopes, setScopes] = useState<string[]>(["invoices"]);
  const [days, setDays] = useState("90");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [minted, setMinted] = useState<{ token: string; portalPath: string; label: string } | null>(null);

  const vendorCommitments = useMemo(
    () => context.commitments.filter((c) => c.vendorId === vendorId),
    [context.commitments, vendorId],
  );

  async function mint() {
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<{ token: string; portalPath: string; label: string }>(`/api/v1/projects/${projectId}/vendor-portal/tokens`, {
        vendorId,
        ...(commitmentId ? { commitmentId } : {}),
        label: label.trim() || `Portal link for ${context.vendorName(vendorId) ?? "vendor"}`,
        scopes,
        ...(email.trim() ? { contactEmail: email.trim() } : {}),
        ...(Number(days) > 0 ? { expiresInDays: Number(days) } : {}),
      });
      setMinted(res);
      setMinting(false);
      tokens.reload();
      toast.success("Portal link minted — copy it now; it is shown once.");
    } catch (err) {
      setError(errorMessage(err, "The token was refused"));
    } finally {
      setBusy(false);
    }
  }

  async function revoke(row: TokenRow) {
    if (!window.confirm(`Revoke ${row.label}? The vendor's link stops working immediately.`)) return;
    try {
      await api.post(`/api/v1/projects/${projectId}/vendor-portal/tokens/${row.id}/revoke`, {});
      toast.success("Revoked.");
      tokens.reload();
    } catch (err) {
      setError(errorMessage(err, "The revocation was refused"));
    }
  }

  const columns = useMemo<DataColumns<TokenRow>>(
    () => [
      { id: "label", header: "Link", accessor: "label", type: "text", width: 220 },
      { id: "vendor", header: "Vendor", accessor: (r: TokenRow) => r.vendorName ?? context.vendorName(r.vendorId) ?? r.vendorId, type: "text", width: 200 },
      {
        id: "commitment",
        header: "Scope",
        accessor: (r: TokenRow) => (r.commitmentId ? (context.commitmentById.get(r.commitmentId)?.reference ?? r.commitmentId) : "every commitment"),
        type: "text",
        width: 160,
      },
      { id: "scopes", header: "Permissions", accessor: (r: TokenRow) => r.scopes.join(", "), type: "text", width: 160 },
      {
        id: "active",
        header: "State",
        accessor: (r: TokenRow) => (r.revokedAt ? "revoked" : r.active ? "active" : "expired"),
        type: "text",
        width: 110,
        cell: ({ row }) => (
          <Badge tone={row.revokedAt ? "danger" : row.active ? "success" : "warning"} size="xs">
            {row.revokedAt ? "revoked" : row.active ? "active" : "expired"}
          </Badge>
        ),
      },
      { id: "expiresAt", header: "Expires", accessor: (r: TokenRow) => r.expiresAt ?? "", type: "text", width: 150, cell: ({ row }) => <span>{row.expiresAt ? isoDateTime(row.expiresAt) : "never"}</span> },
      { id: "lastUsedAt", header: "Last used", accessor: (r: TokenRow) => r.lastUsedAt ?? "", type: "text", width: 150, cell: ({ row }) => <span>{row.lastUsedAt ? `${isoDateTime(row.lastUsedAt)} (${row.useCount})` : "never"}</span> },
      {
        id: "actions",
        header: "",
        width: 110,
        sortable: false,
        interactive: true,
        exportable: false,
        cell: ({ row }) =>
          row.active ? (
            <Button size="xs" variant="ghost" onClick={() => void revoke(row)}>
              Revoke
            </Button>
          ) : null,
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [context],
  );

  return (
    <div className="space-y-4">
      <ErrorAlert message={error} />

      {minted ? (
        <Alert tone="success" title={`Portal link for ${minted.label} — shown once`}>
          <p className="mb-1">Send this to the vendor. It is not stored anywhere on the platform in this form.</p>
          <code className="block break-all rounded bg-surface-raised px-2 py-1 font-mono text-2xs">{`${window.location.origin}${minted.portalPath}`}</code>
          <p className="mt-1 text-2xs text-content-subtle">The vendor's client calls this path; a web front for it can be pointed at the same token.</p>
        </Alert>
      ) : null}

      <DataTable<TokenRow>
        tableId={`invoicing:portal:${projectId}`}
        data={tokens.data?.items ?? []}
        columns={columns}
        getRowId={(row) => row.id}
        loading={tokens.loading}
        error={tokens.error}
        onRetry={tokens.reload}
        height={420}
        stickyHeader
        aria-label="Vendor portal links"
        empty={{
          icon: IconVendor,
          title: "No vendor portal links",
          description: "Mint a link so a subcontractor can raise their own invoices, return waivers and answer RFQs against their own schedule of values.",
          action: <Button onClick={() => setMinting(true)}>Mint a portal link</Button>,
        }}
        toolbarActions={<Button onClick={() => setMinting(true)}>Mint a portal link</Button>}
      />

      <Card>
        <CardHeader title="What a vendor can do with a link" />
        <CardBody>
          <ul className="list-disc pl-5 text-meta text-content-muted">
            <li>See their commitments and schedule of values, previous billing and retainage held.</li>
            <li>Raise and submit a progress invoice — the same over-billing and regression rules apply as for a user; the actor is recorded as the portal identity, so segregation of duties holds.</li>
            <li>See their invoices (including why one was sent back), payments and remittance details.</li>
            <li>Return a requested lien waiver with a signature; receipt and verification stay with the project.</li>
            <li>With the RFQ scope: see their open quote requests (marking them viewed) and submit a price and validity date.</li>
          </ul>
        </CardBody>
      </Card>

      <Modal
        open={minting}
        onClose={() => setMinting(false)}
        title="Mint a vendor portal link"
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setMinting(false)}>
              Cancel
            </Button>
            <Button onClick={() => void mint()} disabled={!vendorId || scopes.length === 0 || busy}>
              {busy ? "Minting…" : "Mint link"}
            </Button>
          </div>
        }
      >
        {context.vendors.length === 0 ? (
          <EmptyState title="No vendors in the directory" hint="Add the subcontractor to the directory first; a link is bound to a vendor." />
        ) : (
          <div className="space-y-3">
            <Field label="Vendor" required>
              <Select value={vendorId} onChange={(e) => { setVendorId(e.target.value); setCommitmentId(""); }}>
                <option value="">Pick a vendor…</option>
                {context.vendors.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Narrow to one commitment" optional>
              <Select value={commitmentId} onChange={(e) => setCommitmentId(e.target.value)} disabled={!vendorId}>
                <option value="">Every commitment with this vendor</option>
                {vendorCommitments.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.reference} — {c.title}
                  </option>
                ))}
              </Select>
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Label">
                <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Ironbridge — 2026 progress billing" />
              </Field>
              <Field label="Contact email" optional>
                <Input value={email} onChange={(e) => setEmail(e.target.value)} type="email" />
              </Field>
            </div>
            <Field label="Permissions">
              <div className="flex flex-wrap gap-3">
                {SCOPES.map((sc) => (
                  <label key={sc} className="flex items-center gap-1 text-meta">
                    <input
                      type="checkbox"
                      checked={scopes.includes(sc)}
                      onChange={(e) => setScopes(e.target.checked ? [...scopes, sc] : scopes.filter((x) => x !== sc))}
                    />
                    {sc}
                  </label>
                ))}
              </div>
            </Field>
            <Field label="Expires in (days)" hint="Blank or 0 = never expires; revocation always works.">
              <Input value={days} inputMode="numeric" onChange={(e) => setDays(e.target.value)} />
            </Field>
          </div>
        )}
      </Modal>
    </div>
  );
}
