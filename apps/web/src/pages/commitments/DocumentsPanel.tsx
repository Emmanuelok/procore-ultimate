/**
 * CONTRACT DOCUMENTS AND SIGNATURE ROUTING (#525–527).
 *
 * The document is generated from the record — header, schedule of values,
 * inclusions/exclusions, compliance requirements, executed changes — and the
 * merge data is kept beside it. Routing names the signers in order and mints
 * the e-sign webhook token once; the last signature executes the commitment.
 */
import { useState } from "react";
import { api } from "../../lib/api";
import { Alert, Badge, Button, Card, CardBody, EmptyState, Field, Input, Modal, Select } from "../../ui";
import { RefusalPanel, isoDate, titleCase, useAction, useResource, type Loadable } from "./shared";
import type { Commitment } from "./types";

interface Signer {
  name: string;
  email: string | null;
  role: string;
  order: number;
  signedAt: string | null;
  method: string | null;
  reference: string | null;
}

interface ContractDocument {
  id: string;
  kind: string;
  templateKey: string;
  title: string;
  version: number;
  status: string;
  fileId: string | null;
  sha256: string | null;
  signers: Signer[];
  routedAt: string | null;
  signedAt: string | null;
  voidReason: string | null;
  createdAt: string;
}

interface Template {
  key: string;
  kind: string;
  name: string;
  description: string;
}

export function useContractDocuments(commitmentId: string | null): Loadable<{ items: ContractDocument[] }> {
  return useResource<{ items: ContractDocument[] }>(commitmentId ? `/api/v1/commitments/${commitmentId}/documents` : null);
}

export default function DocumentsPanel({ commitment, onChanged }: { commitment: Commitment; onChanged: () => void }) {
  const docs = useContractDocuments(commitment.id);
  const templates = useResource<{ items: Template[] }>("/api/v1/contract-templates");
  const { busy, refusal, clear, run } = useAction();
  const [templateKey, setTemplateKey] = useState("");
  const [routing, setRouting] = useState<ContractDocument | null>(null);
  const [signers, setSigners] = useState<Array<{ name: string; email: string; role: string }>>([
    { name: "", email: "", role: "Contractor" },
    { name: "", email: "", role: "Subcontractor" },
  ]);
  const [minted, setMinted] = useState<{ token: string; path: string } | null>(null);
  const [preview, setPreview] = useState<{ title: string; html: string } | null>(null);

  const usable = (templates.data?.items ?? []).filter((t) => t.kind === (commitment.kind === "purchase_order" ? "purchase_order" : "subcontract") || t.kind === "closeout");

  async function generate() {
    const body = templateKey ? { templateKey } : {};
    const created = await run("generate", () => api.post<ContractDocument & { html: string }>(`/api/v1/commitments/${commitment.id}/documents/generate`, body));
    if (created !== null) {
      setPreview({ title: created.title, html: created.html });
      docs.reload();
      onChanged();
    }
  }

  async function open(doc: ContractDocument) {
    const full = await run(`open:${doc.id}`, () => api.get<ContractDocument & { html: string | null }>(`/api/v1/contract-documents/${doc.id}`));
    if (full !== null && full.html) setPreview({ title: full.title, html: full.html });
  }

  async function route() {
    if (!routing) return;
    const res = await run("route", () =>
      api.post<{ webhookToken: string; webhookPath: string }>(`/api/v1/contract-documents/${routing.id}/route`, {
        signers: signers.filter((s) => s.name.trim()).map((s) => ({ name: s.name.trim(), role: s.role.trim() || "Signer", ...(s.email.trim() ? { email: s.email.trim() } : {}) })),
      }),
    );
    if (res !== null) {
      setMinted({ token: res.webhookToken, path: res.webhookPath });
      setRouting(null);
      docs.reload();
      onChanged();
    }
  }

  async function sign(doc: ContractDocument, order: number) {
    const name = doc.signers.find((s) => s.order === order)?.name ?? `signer #${order}`;
    const ref = window.prompt(`Reference for ${name}'s signature (optional)`) ?? "";
    const ok = await run(`sign:${doc.id}:${order}`, () => api.post(`/api/v1/contract-documents/${doc.id}/sign`, { order, method: "wet_ink", ...(ref.trim() ? { reference: ref.trim() } : {}) }));
    if (ok !== null) {
      docs.reload();
      onChanged();
    }
  }

  async function voidDoc(doc: ContractDocument) {
    const reason = window.prompt(`Why is ${doc.title} voided?`);
    if (!reason || !reason.trim()) return;
    const ok = await run(`void:${doc.id}`, () => api.post(`/api/v1/contract-documents/${doc.id}/void`, { reason: reason.trim() }));
    if (ok !== null) {
      docs.reload();
      onChanged();
    }
  }

  const rows = docs.data?.items ?? [];

  return (
    <div className="space-y-3">
      <RefusalPanel refusal={refusal} onDismiss={clear} />
      {minted ? (
        <Alert tone="success" title="E-sign webhook token — shown once">
          <p className="mb-1">Give this path to the e-signature provider; its hash is all the platform keeps.</p>
          <code className="block break-all rounded bg-surface-raised px-2 py-1 font-mono text-2xs">{minted.path}</code>
        </Alert>
      ) : null}
      <Card>
        <CardBody className="flex flex-wrap items-end gap-2">
          <Field label="Template" hint="Merges the commitment as it is now; every version is kept with its merge data.">
            <Select value={templateKey} onChange={(e) => setTemplateKey(e.target.value)}>
              <option value="">Default for this kind</option>
              {usable.map((t) => (
                <option key={t.key} value={t.key}>
                  {t.name}
                </option>
              ))}
            </Select>
          </Field>
          <Button size="sm" onClick={() => void generate()} disabled={busy !== null}>
            Generate document
          </Button>
        </CardBody>
      </Card>
      {docs.error ? <Alert tone="danger">{docs.error}</Alert> : null}
      {rows.length === 0 && !docs.loading ? (
        <EmptyState title="No contract document generated" hint="Generate the subcontract from the record so the document somebody signs is the document the platform holds." />
      ) : (
        <div className="space-y-2">
          {rows.map((d) => (
            <Card key={d.id}>
              <CardBody className="space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{d.title}</span>
                    <Badge tone={d.status === "signed" ? "success" : d.status === "out_for_signature" ? "info" : d.status === "void" ? "danger" : "neutral"} size="xs">
                      {titleCase(d.status)}
                    </Badge>
                    <span className="text-2xs text-content-subtle">
                      v{d.version} · {isoDate(d.createdAt)}
                      {d.sha256 ? ` · sha256 ${d.sha256.slice(0, 12)}…` : ""}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    <Button size="xs" variant="secondary" onClick={() => void open(d)} disabled={busy !== null}>
                      View
                    </Button>
                    {d.status === "draft" ? (
                      <Button size="xs" onClick={() => setRouting(d)} disabled={busy !== null}>
                        Route for signature
                      </Button>
                    ) : null}
                    {d.status !== "signed" && d.status !== "void" ? (
                      <Button size="xs" variant="ghost" onClick={() => void voidDoc(d)} disabled={busy !== null}>
                        Void
                      </Button>
                    ) : null}
                  </div>
                </div>
                {d.signers.length > 0 ? (
                  <ul className="space-y-1 text-meta">
                    {d.signers.map((s) => (
                      <li key={s.order} className="flex flex-wrap items-center justify-between gap-2">
                        <span>
                          #{s.order} {s.name} <span className="text-content-subtle">({s.role}{s.email ? ` · ${s.email}` : ""})</span>
                        </span>
                        {s.signedAt ? (
                          <Badge tone="success" size="xs">
                            signed {s.signedAt.slice(0, 10)} · {s.method}
                          </Badge>
                        ) : d.status === "out_for_signature" ? (
                          <Button size="xs" variant="secondary" onClick={() => void sign(d, s.order)} disabled={busy !== null}>
                            Record signature
                          </Button>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                ) : null}
                {d.voidReason ? <p className="text-2xs text-danger-fg">{d.voidReason}</p> : null}
              </CardBody>
            </Card>
          ))}
        </div>
      )}

      <Modal
        open={routing !== null}
        onClose={() => setRouting(null)}
        title={routing ? `Route ${routing.title} for signature` : "Route for signature"}
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setRouting(null)}>
              Cancel
            </Button>
            <Button onClick={() => void route()} disabled={signers.every((s) => !s.name.trim()) || busy !== null}>
              Send out for signature
            </Button>
          </div>
        }
      >
        <div className="space-y-2">
          <p className="text-meta text-content-muted">Signers sign in order. The last signature executes the commitment on the record.</p>
          {signers.map((s, i) => (
            <div key={i} className="grid gap-2 sm:grid-cols-[1fr_1fr_140px]">
              <Input value={s.name} placeholder="Name" onChange={(e) => setSigners(signers.map((x, xi) => (xi === i ? { ...x, name: e.target.value } : x)))} />
              <Input value={s.email} placeholder="Email (optional)" onChange={(e) => setSigners(signers.map((x, xi) => (xi === i ? { ...x, email: e.target.value } : x)))} />
              <Input value={s.role} placeholder="Role" onChange={(e) => setSigners(signers.map((x, xi) => (xi === i ? { ...x, role: e.target.value } : x)))} />
            </div>
          ))}
          <Button size="xs" variant="ghost" onClick={() => setSigners([...signers, { name: "", email: "", role: "Witness" }])}>
            Add signer
          </Button>
        </div>
      </Modal>

      <Modal open={preview !== null} onClose={() => setPreview(null)} title={preview?.title ?? "Document"} size="lg">
        {preview ? <div className="max-h-[70vh] overflow-auto rounded border border-border bg-white p-2 text-black" dangerouslySetInnerHTML={{ __html: preview.html }} /> : null}
      </Modal>
    </div>
  );
}
