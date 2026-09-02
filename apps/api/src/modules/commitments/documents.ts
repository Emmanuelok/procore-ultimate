import { createHash, randomBytes } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import { and, asc, desc, eq } from "drizzle-orm";
import { z } from "zod";
import {
  commitmentChanges,
  commitmentSovLines,
  commitments,
  contractDocuments,
  files,
  vendors,
} from "@constructos/db";
import { CONTRACT_DOCUMENT_KINDS, type ContractDocumentKind } from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { appendLedger } from "../../lib/ledger.js";
import { AppError, badRequest, conflict, notFound } from "../../lib/errors.js";
import type { Db } from "../../lib/db.js";
import { readRequirements } from "./compliance.js";
import {
  fetchCommitment,
  isoDateSchema,
  ledger,
  requireCommitmentsLevel,
  round2,
  todayIso,
  type CommitmentRow,
} from "./shared.js";

/**
 * CONTRACT DOCUMENT GENERATION AND SIGNATURE ROUTING (spec #525–527).
 *
 * The subcontract somebody signs must be the subcontract the platform holds:
 * the same schedule of values, the same inclusions and exclusions, the same
 * insurance and bonding requirements the compliance engine will later refuse
 * payment on. So the document is GENERATED from the record, from a
 * code-resident template with merge fields, and the merge data it was
 * rendered from is stored beside it — the audit trail is the data, not a
 * screenshot.
 *
 *   generate   render kind × template → HTML, stored in the documents module
 *              (`files`) so it carries a sha256 and lives with the project's
 *              other documents
 *   route      name the signers in order; the commitment goes out for
 *              signature; a per-document webhook token is minted ONCE and
 *              only its hash is kept
 *   sign       a signer's execution is recorded by hand, or by the e-sign
 *              provider posting to the webhook with the token; when the last
 *              signer signs the commitment is EXECUTED on the record
 *              (executed=1, executionDate, signedContractReceivedDate)
 *
 * Deliberately not done: PDF layout. The rendered document is print-ready
 * HTML — a PDF engine is a deployment choice, and every merge field is
 * already on the record for one to consume.
 */

/* ------------------------------------------------------------------ */
/* Templates (code-resident, merge fields named)                       */
/* ------------------------------------------------------------------ */

export interface ContractTemplate {
  key: string;
  kind: ContractDocumentKind;
  name: string;
  description: string;
  /** the merge fields the template consumes, for the UI's field list */
  mergeFields: string[];
}

export const CONTRACT_TEMPLATES: ContractTemplate[] = [
  {
    key: "subcontract_standard",
    kind: "subcontract",
    name: "Subcontract agreement (standard)",
    description:
      "Agreement, scope, schedule of values, inclusions/exclusions, retainage and payment terms, " +
      "insurance and bonding requirements, executed change orders, exhibits, signature blocks.",
    mergeFields: [
      "reference", "title", "vendor.name", "vendor.address", "currency", "originalCommitmentSum",
      "revisedCommitmentSum", "scopeOfWork", "inclusions", "exclusions", "defaultRetainagePercent",
      "paymentTermsDays", "requiresLienWaiver", "compliance.requiredPolicyTypes",
      "compliance.requiredBondTypes", "compliance.minimumInsuranceLimit", "compliance.minimumBondPercent",
      "sov[]", "changes[]", "exhibits[]", "signers[]",
    ],
  },
  {
    key: "purchase_order_standard",
    kind: "purchase_order",
    name: "Purchase order (standard)",
    description: "Order, items from the schedule of values, delivery, tax, terms and signature blocks.",
    mergeFields: [
      "reference", "title", "vendor.name", "currency", "revisedCommitmentSum", "shipTo", "shipVia",
      "deliveryDate", "taxable", "taxPercent", "taxAmount", "paymentTermsDays", "sov[]", "signers[]",
    ],
  },
  {
    key: "change_order_standard",
    kind: "change_order",
    name: "Commitment change order",
    description: "One change order: scope, amount, schedule impact, revised sum, signature blocks.",
    mergeFields: ["reference", "change.reference", "change.title", "change.amount", "change.scheduleImpactDays", "change.revisedCommitmentSum", "signers[]"],
  },
  {
    key: "closeout_final_release",
    kind: "closeout",
    name: "Closeout and final release",
    description: "Final account, retainage released, waiver and warranty acknowledgements.",
    mergeFields: ["reference", "revisedCommitmentSum", "totalPaid", "retainageHeld", "signers[]"],
  },
];

export interface Signer {
  name: string;
  email: string | null;
  role: string;
  order: number;
  signedAt: string | null;
  method: string | null;
  reference: string | null;
}

const esc = (v: unknown): string =>
  String(v ?? "—").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);

function section(title: string, body: string): string {
  return `<section style="margin:18px 0"><h3 style="margin:0 0 6px;font-size:14px;text-transform:uppercase;letter-spacing:.04em">${esc(title)}</h3>${body}</section>`;
}

function para(text: unknown): string {
  return `<p style="margin:0 0 8px;white-space:pre-wrap">${esc(text)}</p>`;
}

function table(headers: string[], rows: unknown[][]): string {
  const th = headers.map((h) => `<th style="text-align:left;border-bottom:1px solid #999;padding:4px 8px">${esc(h)}</th>`).join("");
  const tr = rows
    .map((r) => `<tr>${r.map((c) => `<td style="padding:4px 8px;border-bottom:1px solid #eee">${esc(c)}</td>`).join("")}</tr>`)
    .join("");
  return `<table style="border-collapse:collapse;width:100%;font-size:12px"><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table>`;
}

/** Pure: render the merge data through the template. Deterministic for tests. */
export function renderContractDocument(
  templateKey: string,
  data: Record<string, unknown>,
): string {
  const template = CONTRACT_TEMPLATES.find((t) => t.key === templateKey);
  if (!template) throw badRequest(`Unknown contract template "${templateKey}"`);
  const vendor = (data["vendor"] ?? {}) as Record<string, unknown>;
  const compliance = (data["compliance"] ?? {}) as Record<string, unknown>;
  const sov = (data["sov"] ?? []) as Array<Record<string, unknown>>;
  const changes = (data["changes"] ?? []) as Array<Record<string, unknown>>;
  const exhibits = (data["exhibits"] ?? []) as Array<{ title: string; text: string }>;
  const signers = (data["signers"] ?? []) as Signer[];
  const change = (data["change"] ?? null) as Record<string, unknown> | null;
  const currency = String(data["currency"] ?? "");

  const head =
    `<header style="border-bottom:2px solid #222;padding-bottom:8px;margin-bottom:12px">` +
    `<div style="font-size:11px;color:#666">${esc(template.name)} · generated ${esc(data["generatedOn"])}</div>` +
    `<h1 style="margin:4px 0 0;font-size:20px">${esc(data["reference"])} — ${esc(data["title"])}</h1>` +
    `<div style="font-size:12px;color:#444">${esc(vendor["name"])}${vendor["address"] ? ` · ${esc(vendor["address"])}` : ""} · ${esc(currency)}</div>` +
    `</header>`;

  const parts: string[] = [head];
  if (template.kind === "subcontract" || template.kind === "purchase_order") {
    parts.push(
      section(
        template.kind === "subcontract" ? "Agreement" : "Order",
        para(
          `${esc(data["companyName"] ?? "The Contractor")} engages ${esc(vendor["name"])} to perform the work described below ` +
            `for the sum of ${esc(data["revisedCommitmentSum"])} ${esc(currency)}` +
            (Number(data["approvedChangeSum"] ?? 0) !== 0
              ? ` (original ${esc(data["originalCommitmentSum"])} ${esc(currency)} plus executed changes of ${esc(data["approvedChangeSum"])} ${esc(currency)})`
              : "") +
            ".",
        ),
      ),
    );
    if (data["scopeOfWork"]) parts.push(section("Scope of work", para(data["scopeOfWork"])));
    if (data["inclusions"]) parts.push(section("Inclusions", para(data["inclusions"])));
    if (data["exclusions"]) parts.push(section("Exclusions", para(data["exclusions"])));
    parts.push(
      section(
        "Schedule of values",
        table(
          ["Line", "Description", "Cost code", `Scheduled (${currency})`, `Change orders (${currency})`, `Revised (${currency})`],
          sov.map((l) => [l["lineNumber"], l["description"], l["costCode"] ?? "", l["scheduledValue"], l["changeOrderValue"], l["revisedScheduledValue"]]),
        ),
      ),
    );
    if (template.kind === "subcontract") {
      parts.push(
        section(
          "Payment terms",
          para(
            `Retainage of ${esc(data["defaultRetainagePercent"])}% is withheld from each progress payment. ` +
              `Payment is due ${data["paymentTermsDays"] != null ? `${esc(data["paymentTermsDays"])} days` : "per the contract"} after an approved application. ` +
              (data["requiresLienWaiver"] ? "A lien waiver is required with each application for payment. " : "") +
              "No payment is due while the Subcontractor's insurance or bonding is not evidenced.",
          ),
        ),
      );
      const policies = (compliance["requiredPolicyTypes"] ?? []) as string[];
      const bondTypes = (compliance["requiredBondTypes"] ?? []) as string[];
      parts.push(
        section(
          "Insurance and bonding",
          para(
            (policies.length > 0
              ? `The Subcontractor shall maintain: ${policies.join(", ")}` +
                (compliance["minimumInsuranceLimit"] != null ? ` with a limit of not less than ${esc(compliance["minimumInsuranceLimit"])} ${esc(currency)}` : "") +
                ". "
              : "No insurance requirement is recorded on this commitment. ") +
              (bondTypes.length > 0
                ? `Bonds required: ${bondTypes.join(", ")}` +
                  (compliance["minimumBondPercent"] != null ? ` at not less than ${esc(compliance["minimumBondPercent"])}% of the commitment sum` : "") +
                  "."
                : ""),
          ),
        ),
      );
      if (changes.length > 0) {
        parts.push(
          section(
            "Executed change orders",
            table(["Reference", "Title", `Amount (${currency})`, "Executed"], changes.map((c) => [c["reference"], c["title"], c["amount"], c["executedDate"] ?? ""])),
          ),
        );
      }
    } else {
      parts.push(
        section(
          "Delivery and tax",
          para(
            `Ship to: ${esc(data["shipTo"])}. Via: ${esc(data["shipVia"])}. Delivery date: ${esc(data["deliveryDate"])}. ` +
              (data["taxable"] ? `Tax at ${esc(data["taxPercent"])}%: ${esc(data["taxAmount"])} ${esc(currency)}.` : "Not taxable."),
          ),
        ),
      );
    }
  } else if (template.kind === "change_order" && change) {
    parts.push(
      section(
        `Change order ${esc(change["reference"])}`,
        para(`${esc(change["title"])}\n${esc(change["description"] ?? "")}`) +
          para(`Amount: ${esc(change["amount"])} ${esc(currency)}. Schedule impact: ${esc(change["scheduleImpactDays"])} day(s). Revised commitment sum: ${esc(change["revisedCommitmentSum"])} ${esc(currency)}.`),
      ),
    );
  } else if (template.kind === "closeout") {
    parts.push(
      section(
        "Final account",
        para(
          `Revised commitment sum ${esc(data["revisedCommitmentSum"])} ${esc(currency)}; paid to date ${esc(data["totalPaid"])} ${esc(currency)}; ` +
            `retainage held ${esc(data["retainageHeld"])} ${esc(currency)}. The Subcontractor acknowledges that payment of the retainage is in full and final settlement, ` +
            "subject to the warranties and the final unconditional lien waiver delivered with this release.",
        ),
      ),
    );
  }
  for (const ex of exhibits) parts.push(section(`Exhibit — ${ex.title}`, para(ex.text)));
  parts.push(
    section(
      "Signatures",
      table(
        ["#", "Signer", "Role", "Signed", "Method", "Reference"],
        signers.length > 0
          ? signers.map((s) => [s.order, s.name, s.role, s.signedAt ?? "", s.method ?? "", s.reference ?? ""])
          : [["1", "________________________", "Contractor", "", "", ""], ["2", "________________________", "Subcontractor", "", "", ""]],
      ),
    ),
  );
  return `<article style="font-family:Georgia,serif;max-width:820px;margin:0 auto;padding:24px;color:#111">${parts.join("")}</article>`;
}

/* ------------------------------------------------------------------ */
/* Merge data                                                          */
/* ------------------------------------------------------------------ */

export async function buildMergeData(
  db: Db,
  commitment: CommitmentRow,
  options: { changeId?: string | null; exhibits?: Array<{ title: string; text: string }>; companyName?: string | null },
): Promise<Record<string, unknown>> {
  const [vendorRows, sov, changes] = await Promise.all([
    commitment.vendorId
      ? db.select({ name: vendors.name, address: vendors.address, email: vendors.email }).from(vendors).where(eq(vendors.id, commitment.vendorId)).limit(1)
      : Promise.resolve([] as Array<{ name: string; address: string | null; email: string | null }>),
    db
      .select()
      .from(commitmentSovLines)
      .where(eq(commitmentSovLines.commitmentId, commitment.id))
      .orderBy(asc(commitmentSovLines.sortOrder), asc(commitmentSovLines.lineNumber)),
    db
      .select()
      .from(commitmentChanges)
      .where(and(eq(commitmentChanges.commitmentId, commitment.id), eq(commitmentChanges.status, "executed")))
      .orderBy(asc(commitmentChanges.number)),
  ]);
  const change = options.changeId ? changes.find((c) => c.id === options.changeId) ?? null : null;
  if (options.changeId && !change) {
    const anyChange = (await db.select().from(commitmentChanges).where(eq(commitmentChanges.id, options.changeId)).limit(1))[0];
    if (!anyChange || anyChange.commitmentId !== commitment.id) throw badRequest("changeId is not a change order on this commitment");
    return buildMergeDataWithChange(commitment, vendorRows[0] ?? null, sov, changes, anyChange, options);
  }
  return buildMergeDataWithChange(commitment, vendorRows[0] ?? null, sov, changes, change, options);
}

function buildMergeDataWithChange(
  commitment: CommitmentRow,
  vendor: { name: string; address: string | null; email: string | null } | null,
  sov: Array<typeof commitmentSovLines.$inferSelect>,
  changes: Array<typeof commitmentChanges.$inferSelect>,
  change: typeof commitmentChanges.$inferSelect | null,
  options: { exhibits?: Array<{ title: string; text: string }>; companyName?: string | null },
): Record<string, unknown> {
  const req = readRequirements(commitment.complianceDetail);
  return {
    generatedOn: todayIso(),
    companyName: options.companyName ?? null,
    reference: commitment.reference,
    title: commitment.title,
    kind: commitment.kind,
    vendor: vendor ? { name: vendor.name, address: vendor.address, email: vendor.email } : { name: "No vendor bound", address: null, email: null },
    currency: commitment.currency,
    originalCommitmentSum: round2(commitment.originalCommitmentSum),
    approvedChangeSum: round2(commitment.approvedChangeSum),
    revisedCommitmentSum: round2(commitment.revisedCommitmentSum),
    totalPaid: round2(commitment.totalPaid),
    retainageHeld: round2(commitment.retainageHeld),
    scopeOfWork: commitment.scopeOfWork,
    inclusions: commitment.inclusions,
    exclusions: commitment.exclusions,
    defaultRetainagePercent: commitment.defaultRetainagePercent,
    paymentTermsDays: commitment.paymentTermsDays,
    requiresLienWaiver: commitment.requiresLienWaiver === 1,
    shipTo: commitment.shipTo,
    shipVia: commitment.shipVia,
    deliveryDate: commitment.deliveryDate,
    taxable: commitment.taxable === 1,
    taxPercent: commitment.taxPercent,
    taxAmount: commitment.taxAmount,
    compliance: {
      strictness: req.strictness,
      requiredPolicyTypes: req.requiredPolicyTypes,
      requiredBondTypes: req.requiredBondTypes,
      minimumInsuranceLimit: req.minimumInsuranceLimit,
      minimumBondPercent: req.minimumBondPercent,
    },
    sov: sov.map((l) => ({
      lineNumber: l.lineNumber,
      description: l.description,
      costCode: l.costCode,
      scheduledValue: round2(l.scheduledValue),
      changeOrderValue: round2(l.changeOrderValue),
      revisedScheduledValue: round2(l.revisedScheduledValue),
    })),
    changes: changes.map((c) => ({ reference: c.reference, title: c.title, amount: round2(c.amount), executedDate: c.executedDate })),
    change: change
      ? {
          id: change.id,
          reference: change.reference,
          title: change.title,
          description: change.description,
          amount: round2(change.amount),
          scheduleImpactDays: change.scheduleImpactDays,
          revisedCommitmentSum: round2(change.revisedCommitmentSum),
        }
      : null,
    exhibits: options.exhibits ?? [],
    signers: [],
  };
}

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

const generateSchema = z.object({
  templateKey: z.string().min(1).max(80).optional(),
  kind: z.enum(CONTRACT_DOCUMENT_KINDS).optional(),
  title: z.string().min(1).max(300).optional(),
  changeId: z.string().min(1).max(64).nullable().optional(),
  exhibits: z.array(z.object({ title: z.string().min(1).max(200), text: z.string().max(20000) })).max(50).optional(),
});

const signerSchema = z.object({
  name: z.string().min(1).max(200),
  email: z.string().email().max(300).nullable().optional(),
  role: z.string().min(1).max(80),
});

const routeSchema = z.object({ signers: z.array(signerSchema).min(1).max(10) });

const signSchema = z.object({
  order: z.number().int().min(1).max(10),
  signedAt: z.string().min(4).optional(),
  method: z.enum(["wet_ink", "e_signature", "notarized"]).default("wet_ink"),
  reference: z.string().max(300).nullable().optional(),
});

const webhookSchema = z.object({
  event: z.enum(["signed", "declined", "viewed"]),
  signerEmail: z.string().max(300).optional(),
  signerOrder: z.number().int().min(1).max(10).optional(),
  signedAt: z.string().min(4).optional(),
  method: z.string().max(80).optional(),
  reference: z.string().max(300).nullable().optional(),
  reason: z.string().max(4000).optional(),
});

const hashToken = (raw: string): string => createHash("sha256").update(raw).digest("hex");

export const contractDocumentRoutes: FastifyPluginAsync = async (app) => {
  const companyGate = [app.authenticate, app.requireCompany];

  async function fetchDoc(docId: string, companyId: string) {
    const rows = await app.db
      .select()
      .from(contractDocuments)
      .where(and(eq(contractDocuments.id, docId), eq(contractDocuments.companyId, companyId)))
      .limit(1);
    if (!rows[0]) throw notFound("Contract document not found");
    return rows[0];
  }

  async function readHtml(fileId: string | null): Promise<string | null> {
    if (!fileId) return null;
    const f = (await app.db.select({ storageKey: files.storageKey }).from(files).where(eq(files.id, fileId)).limit(1))[0];
    if (!f) return null;
    const chunks: Buffer[] = [];
    for await (const chunk of app.storage.readStream(f.storageKey)) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
    }
    return Buffer.concat(chunks).toString("utf8");
  }

  /** When the last signer signs, the commitment is executed on the record. */
  async function completeIfFullySigned(
    docId: string,
    actorId: string | null,
  ): Promise<{ complete: boolean }> {
    const doc = (await app.db.select().from(contractDocuments).where(eq(contractDocuments.id, docId)).limit(1))[0];
    if (!doc) return { complete: false };
    const signers = doc.signers as Signer[];
    if (signers.length === 0 || signers.some((s) => !s.signedAt)) return { complete: false };
    const now = new Date().toISOString();
    await app.db.transaction(async (tx) => {
      await tx
        .update(contractDocuments)
        .set({ status: "signed", signedAt: now, updatedAt: now })
        .where(and(eq(contractDocuments.id, docId), eq(contractDocuments.status, "out_for_signature")));
      if (doc.kind === "subcontract" || doc.kind === "purchase_order") {
        await tx
          .update(commitments)
          .set({
            executed: 1,
            executionDate: now.slice(0, 10),
            signedContractReceivedDate: now.slice(0, 10),
            executedBy: actorId,
            updatedAt: now,
          })
          .where(eq(commitments.id, doc.commitmentId));
      }
    });
    await appendLedger(app.db, {
      companyId: doc.companyId,
      actorId,
      action: "state_change",
      objectType: "commitment",
      objectId: doc.commitmentId,
      projectId: doc.projectId,
      payload: { contractDocumentId: docId, status: "signed", executed: doc.kind === "subcontract" || doc.kind === "purchase_order" },
      storePayload: true,
    });
    return { complete: true };
  }

  app.get("/contract-templates", { preHandler: companyGate }, async () => ({ items: CONTRACT_TEMPLATES }));

  app.get("/commitments/:commitmentId/documents", { preHandler: companyGate }, async (req, reply) => {
    const { commitmentId } = req.params as { commitmentId: string };
    const commitment = await fetchCommitment(app.db, commitmentId, req.companyId!);
    await requireCommitmentsLevel(app, req, reply, commitment.projectId, "read");
    const items = await app.db
      .select()
      .from(contractDocuments)
      .where(eq(contractDocuments.commitmentId, commitmentId))
      .orderBy(desc(contractDocuments.createdAt));
    return { items: items.map((d) => ({ ...d, webhookTokenHash: undefined })) };
  });

  app.post("/commitments/:commitmentId/documents/generate", { preHandler: companyGate }, async (req, reply) => {
    const { commitmentId } = req.params as { commitmentId: string };
    const body = generateSchema.parse(req.body ?? {});
    const commitment = await fetchCommitment(app.db, commitmentId, req.companyId!);
    await requireCommitmentsLevel(app, req, reply, commitment.projectId, "standard");
    const kind: ContractDocumentKind =
      body.kind ?? (body.changeId ? "change_order" : commitment.kind === "purchase_order" ? "purchase_order" : "subcontract");
    const template =
      CONTRACT_TEMPLATES.find((t) => t.key === body.templateKey) ?? CONTRACT_TEMPLATES.find((t) => t.kind === kind);
    if (!template) throw badRequest(`No template for kind ${kind}`);
    if (template.kind !== kind) throw badRequest(`Template ${template.key} renders a ${template.kind}, not a ${kind}`);
    if (kind === "change_order" && !body.changeId) throw badRequest("A change order document needs changeId");

    const mergeData = await buildMergeData(app.db, commitment, {
      changeId: body.changeId ?? null,
      exhibits: body.exhibits ?? [],
    });
    const prior = await app.db
      .select({ version: contractDocuments.version })
      .from(contractDocuments)
      .where(and(eq(contractDocuments.commitmentId, commitmentId), eq(contractDocuments.kind, kind)))
      .orderBy(desc(contractDocuments.version))
      .limit(1);
    const version = (prior[0]?.version ?? 0) + 1;
    const title = body.title ?? `${commitment.reference} ${template.name} v${version}`;
    const html = renderContractDocument(template.key, { ...mergeData, title: commitment.title });
    const buf = Buffer.from(html, "utf8");
    const saved = await app.storage.saveBuffer(req.companyId!, buf);
    const fileId = newId("fil");
    const docId = newId("cdoc");
    await app.db.transaction(async (tx) => {
      await tx.insert(files).values({
        id: fileId,
        companyId: req.companyId!,
        projectId: commitment.projectId,
        folderId: null,
        name: `${title}.html`,
        contentType: "text/html",
        sizeBytes: saved.sizeBytes,
        sha256: saved.sha256,
        storageKey: saved.storageKey,
        description: `Generated ${template.name} for ${commitment.reference}`,
        tags: ["contract", kind],
        metadata: { contractDocumentId: docId, commitmentId, templateKey: template.key, version },
        uploadedBy: req.user!.id,
      });
      await tx.insert(contractDocuments).values({
        id: docId,
        companyId: req.companyId!,
        projectId: commitment.projectId,
        commitmentId,
        kind,
        templateKey: template.key,
        title,
        version,
        status: "draft",
        fileId,
        sha256: saved.sha256,
        contentType: "text/html",
        mergeData,
        signers: [],
        generatedBy: req.user!.id,
      });
      await tx
        .update(commitments)
        .set({ documentIds: [...new Set([...commitment.documentIds, fileId])], updatedAt: new Date().toISOString() })
        .where(eq(commitments.id, commitmentId));
    });
    await ledger(app.db, req, "create", "commitment", commitmentId, {
      contractDocumentId: docId,
      fileId,
      sha256: saved.sha256,
      kind,
      templateKey: template.key,
      version,
    }, commitment.projectId);
    const doc = await fetchDoc(docId, req.companyId!);
    return reply.status(201).send({ ...doc, webhookTokenHash: undefined, html });
  });

  app.get("/contract-documents/:docId", { preHandler: companyGate }, async (req, reply) => {
    const { docId } = req.params as { docId: string };
    const doc = await fetchDoc(docId, req.companyId!);
    await requireCommitmentsLevel(app, req, reply, doc.projectId, "read");
    return { ...doc, webhookTokenHash: undefined, html: await readHtml(doc.fileId) };
  });

  /** Name the signers, in order; mint the provider token once. */
  app.post("/contract-documents/:docId/route", { preHandler: companyGate }, async (req, reply) => {
    const { docId } = req.params as { docId: string };
    const body = routeSchema.parse(req.body);
    const doc = await fetchDoc(docId, req.companyId!);
    await requireCommitmentsLevel(app, req, reply, doc.projectId, "standard");
    if (doc.status !== "draft") throw conflict(`A ${doc.status} document cannot be routed again; generate a new version.`);
    const rawToken = randomBytes(24).toString("base64url");
    const signers: Signer[] = body.signers.map((s, i) => ({
      name: s.name,
      email: s.email ?? null,
      role: s.role,
      order: i + 1,
      signedAt: null,
      method: null,
      reference: null,
    }));
    const now = new Date().toISOString();
    await app.db.transaction(async (tx) => {
      await tx
        .update(contractDocuments)
        .set({
          status: "out_for_signature",
          signers,
          routedAt: now,
          routedBy: req.user!.id,
          webhookTokenHash: hashToken(rawToken),
          mergeData: { ...(doc.mergeData as Record<string, unknown>), signers },
          updatedAt: now,
        })
        .where(eq(contractDocuments.id, docId));
      if (doc.kind === "subcontract" || doc.kind === "purchase_order") {
        await tx
          .update(commitments)
          .set({ status: "out_for_signature", updatedAt: now })
          .where(and(eq(commitments.id, doc.commitmentId), eq(commitments.status, "draft")));
      }
    });
    await ledger(app.db, req, "state_change", "commitment", doc.commitmentId, {
      contractDocumentId: docId,
      status: "out_for_signature",
      signers: signers.map((s) => ({ name: s.name, role: s.role, order: s.order })),
    }, doc.projectId);
    return {
      ...(await fetchDoc(docId, req.companyId!)),
      webhookTokenHash: undefined,
      /** shown once; the e-sign provider posts to /contract-documents/webhook/<token> */
      webhookToken: rawToken,
      webhookPath: `/api/v1/contract-documents/webhook/${rawToken}`,
    };
  });

  /** Record one signer's execution by hand (a wet-ink copy came back). */
  app.post("/contract-documents/:docId/sign", { preHandler: companyGate }, async (req, reply) => {
    const { docId } = req.params as { docId: string };
    const body = signSchema.parse(req.body);
    const doc = await fetchDoc(docId, req.companyId!);
    await requireCommitmentsLevel(app, req, reply, doc.projectId, "standard");
    if (doc.status !== "out_for_signature") throw conflict(`A ${doc.status} document is not out for signature`);
    const signers = doc.signers as Signer[];
    const target = signers.find((s) => s.order === body.order);
    if (!target) throw badRequest(`No signer #${body.order} on this document`);
    if (target.signedAt) throw conflict(`Signer #${body.order} (${target.name}) has already signed`);
    const earlier = signers.filter((s) => s.order < body.order && !s.signedAt);
    if (earlier.length > 0) {
      throw conflict(`Signers sign in order; ${earlier.map((s) => `#${s.order} ${s.name}`).join(", ")} have not signed yet.`);
    }
    const signedAt = body.signedAt ? new Date(body.signedAt).toISOString() : new Date().toISOString();
    if (Number.isNaN(Date.parse(signedAt))) throw badRequest("signedAt is not a valid timestamp");
    const next = signers.map((s) => (s.order === body.order ? { ...s, signedAt, method: body.method, reference: body.reference ?? null } : s));
    await app.db
      .update(contractDocuments)
      .set({ signers: next, updatedAt: new Date().toISOString() })
      .where(eq(contractDocuments.id, docId));
    await ledger(app.db, req, "update", "commitment", doc.commitmentId, {
      contractDocumentId: docId,
      signed: { order: body.order, name: target.name, method: body.method },
    }, doc.projectId);
    const done = await completeIfFullySigned(docId, req.user!.id);
    return { ...(await fetchDoc(docId, req.companyId!)), webhookTokenHash: undefined, complete: done.complete };
  });

  /**
   * E-SIGN WEBHOOK. No user session: the token IS the credential, hashed at
   * rest and bound to one document. A `signed` event records the signer and,
   * on the last signature, executes the commitment as a system act.
   */
  app.post("/contract-documents/webhook/:token", async (req, reply) => {
    const { token } = req.params as { token: string };
    if (!token || token.length < 16 || token.length > 200) throw new AppError(401, "Invalid token");
    const body = webhookSchema.parse(req.body ?? {});
    const doc = (
      await app.db.select().from(contractDocuments).where(eq(contractDocuments.webhookTokenHash, hashToken(token))).limit(1)
    )[0];
    if (!doc) throw new AppError(401, "Invalid token");
    if (doc.status !== "out_for_signature") {
      return reply.status(200).send({ accepted: false, reason: `document is ${doc.status}` });
    }
    const signers = doc.signers as Signer[];
    const now = new Date().toISOString();
    if (body.event === "viewed") {
      await appendLedger(app.db, {
        companyId: doc.companyId,
        actorId: null,
        action: "access",
        objectType: "commitment",
        objectId: doc.commitmentId,
        projectId: doc.projectId,
        payload: { contractDocumentId: doc.id, event: "viewed", signerEmail: body.signerEmail ?? null },
      });
      return { accepted: true };
    }
    if (body.event === "declined") {
      await app.db
        .update(contractDocuments)
        .set({ status: "void", voidReason: `Declined by signer: ${body.reason ?? "no reason given"}`, updatedAt: now })
        .where(eq(contractDocuments.id, doc.id));
      await appendLedger(app.db, {
        companyId: doc.companyId,
        actorId: null,
        action: "state_change",
        objectType: "commitment",
        objectId: doc.commitmentId,
        projectId: doc.projectId,
        payload: { contractDocumentId: doc.id, status: "void", declined: true, reason: body.reason ?? null },
        storePayload: true,
      });
      return { accepted: true };
    }
    const target =
      (body.signerOrder ? signers.find((s) => s.order === body.signerOrder) : undefined) ??
      (body.signerEmail ? signers.find((s) => s.email && s.email.toLowerCase() === body.signerEmail!.toLowerCase()) : undefined) ??
      signers.find((s) => !s.signedAt);
    if (!target) return reply.status(200).send({ accepted: false, reason: "no matching signer" });
    if (target.signedAt) return reply.status(200).send({ accepted: true, alreadySigned: true });
    const signedAt = body.signedAt && !Number.isNaN(Date.parse(body.signedAt)) ? new Date(body.signedAt).toISOString() : now;
    const next = signers.map((s) =>
      s.order === target.order ? { ...s, signedAt, method: body.method ?? "e_signature", reference: body.reference ?? null } : s,
    );
    await app.db.update(contractDocuments).set({ signers: next, updatedAt: now }).where(eq(contractDocuments.id, doc.id));
    await appendLedger(app.db, {
      companyId: doc.companyId,
      actorId: null,
      action: "update",
      objectType: "commitment",
      objectId: doc.commitmentId,
      projectId: doc.projectId,
      payload: { contractDocumentId: doc.id, signed: { order: target.order, name: target.name, method: body.method ?? "e_signature" } },
      storePayload: true,
    });
    const done = await completeIfFullySigned(doc.id, null);
    return { accepted: true, complete: done.complete };
  });

  app.post("/contract-documents/:docId/void", { preHandler: companyGate }, async (req, reply) => {
    const { docId } = req.params as { docId: string };
    const body = z.object({ reason: z.string().min(1).max(4000) }).parse(req.body);
    const doc = await fetchDoc(docId, req.companyId!);
    await requireCommitmentsLevel(app, req, reply, doc.projectId, "standard");
    if (doc.status === "signed") throw conflict("A signed contract document is evidence and is never voided; generate a superseding version.");
    if (doc.status === "void") throw conflict("Already void");
    await app.db
      .update(contractDocuments)
      .set({ status: "void", voidReason: body.reason, updatedAt: new Date().toISOString() })
      .where(eq(contractDocuments.id, docId));
    await ledger(app.db, req, "state_change", "commitment", doc.commitmentId, {
      contractDocumentId: docId,
      status: "void",
      reason: body.reason,
    }, doc.projectId);
    return { ...(await fetchDoc(docId, req.companyId!)), webhookTokenHash: undefined };
  });

  /** Kept for callers that want a date-only check of what "signed" means. */
  app.get("/contract-documents/:docId/status", { preHandler: companyGate }, async (req, reply) => {
    const { docId } = req.params as { docId: string };
    const doc = await fetchDoc(docId, req.companyId!);
    await requireCommitmentsLevel(app, req, reply, doc.projectId, "read");
    const signers = doc.signers as Signer[];
    return {
      id: doc.id,
      status: doc.status,
      signed: signers.filter((s) => s.signedAt).length,
      total: signers.length,
      nextSigner: signers.find((s) => !s.signedAt) ?? null,
      signedAt: doc.signedAt,
      isoToday: isoDateSchema.parse(todayIso()),
    };
  });
};
