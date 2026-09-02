/**
 * CREATE A SUBCONTRACT OR PURCHASE ORDER — the register's only creation path
 * used to be bid award; anything bought outside bidding could not be
 * recorded. The modal carries the fields the API treats as load-bearing:
 * kind, vendor, currency, retainage, lien-waiver requirement, compliance
 * requirements (which policy types and bonds must be evidenced before
 * payment), and an optional first schedule of values pasted as CSV.
 */
import { useMemo, useState } from "react";
import { api } from "../../lib/api";
import { Alert, Button, Field, Input, Modal, Select, Textarea } from "../../ui";
import { RefusalPanel, money, useAction } from "./shared";
import type { Vendor } from "./types";

const POLICY_TYPES = [
  "general_liability",
  "employers_liability",
  "professional_indemnity",
  "contractors_all_risks",
  "workers_compensation",
  "auto_liability",
  "umbrella",
  "pollution",
] as const;
const BOND_TYPES = ["performance", "payment", "advance_payment", "retention", "bid", "warranty"] as const;

export interface ParsedSovLine {
  lineNumber: string;
  description: string;
  costCode: string | null;
  scheduledValue: number;
  retainagePercent?: number;
}

/**
 * Pure: parse a pasted schedule. Accepts `line,description,costCode,amount`
 * or `description,amount` per row, comma or tab separated, with an optional
 * header row. Rows that cannot be read are named, never dropped silently.
 */
export function parseSovCsv(text: string, defaultRetainage: number): { lines: ParsedSovLine[]; problems: string[] } {
  const lines: ParsedSovLine[] = [];
  const problems: string[] = [];
  const rows = text
    .split(/\r?\n/)
    .map((r) => r.trim())
    .filter((r) => r.length > 0);
  let n = 0;
  for (const [i, raw] of rows.entries()) {
    const cells = raw.split(raw.includes("\t") ? "\t" : ",").map((c) => c.trim().replace(/^"|"$/g, ""));
    if (i === 0 && cells.some((c) => /^(line|description|amount|scheduled|cost)/i.test(c)) && Number.isNaN(Number(cells[cells.length - 1]))) {
      continue; // header row
    }
    const amountCell = cells[cells.length - 1] ?? "";
    const amount = Number(amountCell.replace(/[^0-9.\-]/g, ""));
    if (!Number.isFinite(amount)) {
      problems.push(`Row ${i + 1}: "${raw}" — the last cell must be the scheduled value.`);
      continue;
    }
    n += 1;
    if (cells.length >= 4) {
      lines.push({ lineNumber: cells[0] || String(n).padStart(2, "0"), description: cells[1] || `Line ${n}`, costCode: cells[2] || null, scheduledValue: amount, retainagePercent: defaultRetainage });
    } else if (cells.length === 3) {
      lines.push({ lineNumber: cells[0] || String(n).padStart(2, "0"), description: cells[1] || `Line ${n}`, costCode: null, scheduledValue: amount, retainagePercent: defaultRetainage });
    } else {
      lines.push({ lineNumber: String(n).padStart(2, "0"), description: cells[0] || `Line ${n}`, costCode: null, scheduledValue: amount, retainagePercent: defaultRetainage });
    }
  }
  return { lines, problems };
}

export default function CreateCommitmentModal({
  open,
  projectId,
  vendors,
  onClose,
  onCreated,
}: {
  open: boolean;
  projectId: string;
  vendors: Vendor[];
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const { busy, refusal, clear, run } = useAction();
  const [kind, setKind] = useState<"subcontract" | "purchase_order">("subcontract");
  const [title, setTitle] = useState("");
  const [vendorId, setVendorId] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [retainage, setRetainage] = useState("10");
  const [requiresWaiver, setRequiresWaiver] = useState(true);
  const [terms, setTerms] = useState("30");
  const [scope, setScope] = useState("");
  const [strictness, setStrictness] = useState<"off" | "warn" | "block">("warn");
  const [policies, setPolicies] = useState<string[]>([]);
  const [bondTypes, setBondTypes] = useState<string[]>([]);
  const [minLimit, setMinLimit] = useState("");
  const [csv, setCsv] = useState("");
  const [taxable, setTaxable] = useState(false);
  const [taxPercent, setTaxPercent] = useState("");

  const parsed = useMemo(() => parseSovCsv(csv, Number(retainage) || 0), [csv, retainage]);
  const total = parsed.lines.reduce((s, l) => s + l.scheduledValue, 0);

  const problems: string[] = [];
  if (!title.trim()) problems.push("A commitment needs a title.");
  if (!vendorId) problems.push("Pick the vendor — the binding is what carries insurance, bonding and waiver compliance onto the commitment.");
  if (!/^[A-Za-z]{3,8}$/.test(currency.trim())) problems.push("Currency must be a 3-letter code.");

  async function submit() {
    const body: Record<string, unknown> = {
      kind,
      title: title.trim(),
      vendorId,
      currency: currency.trim().toUpperCase(),
      defaultRetainagePercent: Number(retainage) || 0,
      requiresLienWaiver: requiresWaiver,
      ...(terms.trim() ? { paymentTermsDays: Number(terms) } : {}),
      ...(scope.trim() ? { scopeOfWork: scope.trim() } : {}),
      compliance: {
        strictness,
        requiredPolicyTypes: policies,
        requiredBondTypes: bondTypes,
        minimumInsuranceLimit: minLimit.trim() ? Number(minLimit) : null,
      },
      ...(kind === "purchase_order" && taxable ? { taxable: true, taxPercent: Number(taxPercent) || 0 } : {}),
      ...(parsed.lines.length > 0 ? { sovLines: parsed.lines } : {}),
    };
    const created = await run("create", () => api.post<{ commitment?: { id: string }; id?: string }>(`/api/v1/projects/${projectId}/commitments`, body));
    if (created !== null) {
      const id = created.commitment?.id ?? created.id;
      if (id) onCreated(id);
      onClose();
    }
  }

  const toggle = (list: string[], set: (v: string[]) => void, value: string) =>
    set(list.includes(value) ? list.filter((x) => x !== value) : [...list, value]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New commitment"
      size="lg"
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={problems.length > 0 || parsed.problems.length > 0 || busy !== null}>
            Create as draft
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <RefusalPanel refusal={refusal} onDismiss={clear} />
        <div className="grid gap-3 sm:grid-cols-[160px_1fr]">
          <Field label="Kind">
            <Select value={kind} onChange={(e) => setKind(e.target.value as "subcontract" | "purchase_order")}>
              <option value="subcontract">Subcontract</option>
              <option value="purchase_order">Purchase order</option>
            </Select>
          </Field>
          <Field label="Title" required>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Structural steel supply and erect" />
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Vendor" required>
            <Select value={vendorId} onChange={(e) => setVendorId(e.target.value)}>
              <option value="">Pick a vendor…</option>
              {vendors.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Currency">
            <Input value={currency} onChange={(e) => setCurrency(e.target.value)} maxLength={8} />
          </Field>
          <Field label="Retainage %" hint="withheld on every schedule line">
            <Input value={retainage} inputMode="decimal" onChange={(e) => setRetainage(e.target.value)} />
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Payment terms (days)" optional>
            <Input value={terms} inputMode="numeric" onChange={(e) => setTerms(e.target.value)} />
          </Field>
          <Field label="Lien waiver with each invoice">
            <Select value={requiresWaiver ? "yes" : "no"} onChange={(e) => setRequiresWaiver(e.target.value === "yes")}>
              <option value="yes">Required</option>
              <option value="no">Not required</option>
            </Select>
          </Field>
          <Field label="Compliance strictness" hint="what an expired certificate does to a payment">
            <Select value={strictness} onChange={(e) => setStrictness(e.target.value as "off" | "warn" | "block")}>
              <option value="block">Block payment</option>
              <option value="warn">Warn</option>
              <option value="off">Off</option>
            </Select>
          </Field>
        </div>
        {kind === "purchase_order" ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Taxable">
              <Select value={taxable ? "yes" : "no"} onChange={(e) => setTaxable(e.target.value === "yes")}>
                <option value="no">No</option>
                <option value="yes">Yes</option>
              </Select>
            </Field>
            <Field label="Tax %" optional>
              <Input value={taxPercent} inputMode="decimal" onChange={(e) => setTaxPercent(e.target.value)} disabled={!taxable} />
            </Field>
          </div>
        ) : null}
        <Field label="Required insurance" optional hint="tested against the insurance module's certificates for this vendor at every payment">
          <div className="flex flex-wrap gap-2">
            {POLICY_TYPES.map((p) => (
              <label key={p} className="flex items-center gap-1 text-meta">
                <input type="checkbox" checked={policies.includes(p)} onChange={() => toggle(policies, setPolicies, p)} />
                {p.replace(/_/g, " ")}
              </label>
            ))}
          </div>
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Required bonds" optional>
            <div className="flex flex-wrap gap-2">
              {BOND_TYPES.map((b) => (
                <label key={b} className="flex items-center gap-1 text-meta">
                  <input type="checkbox" checked={bondTypes.includes(b)} onChange={() => toggle(bondTypes, setBondTypes, b)} />
                  {b.replace(/_/g, " ")}
                </label>
              ))}
            </div>
          </Field>
          <Field label="Minimum insurance limit" optional hint="in the commitment currency">
            <Input value={minLimit} inputMode="decimal" onChange={(e) => setMinLimit(e.target.value)} />
          </Field>
        </div>
        <Field label="Scope of work" optional>
          <Textarea rows={3} value={scope} onChange={(e) => setScope(e.target.value)} />
        </Field>
        <Field
          label="Schedule of values (paste CSV)"
          optional
          hint="One line per row: line, description, cost code, amount — or description, amount. The schedule IS the commitment sum."
        >
          <Textarea rows={5} value={csv} onChange={(e) => setCsv(e.target.value)} placeholder={"01,Mobilisation,01-100,25000\n02,Steel supply,05-120,180000"} className="font-mono" />
        </Field>
        {parsed.lines.length > 0 ? (
          <p className="text-meta">
            {parsed.lines.length} line(s) · original commitment sum{" "}
            <span className="font-mono tabular-nums">{money(total, currency.toUpperCase())}</span>
          </p>
        ) : null}
        {parsed.problems.length > 0 ? (
          <Alert tone="warning" size="sm" title="Rows that could not be read">
            <ul className="list-disc pl-4">
              {parsed.problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </Alert>
        ) : null}
        {problems.length > 0 ? (
          <Alert tone="warning" size="sm" title="Not ready">
            <ul className="list-disc pl-4">
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </Alert>
        ) : null}
      </div>
    </Modal>
  );
}
