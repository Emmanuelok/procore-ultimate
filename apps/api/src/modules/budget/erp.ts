/**
 * ERP IMPORT (spec #481) — a general-ledger budget export mapped onto the
 * project's cost codes through the company's GL → cost-code map.
 *
 * The parsers know the header dialects of the common construction ERPs
 * (Sage 300 CRE / Sage Intacct job cost, QuickBooks budget by class,
 * Viewpoint Vista/Spectrum job cost, Xero, generic). Nothing is guessed: an
 * account with no mapping is reported by row, never dropped or defaulted to
 * "other", and rows landing on the same cost code × cost type are summed
 * into one budget line with the GL accounts that fed it recorded on the
 * line's `detail.provenance`.
 */
import type { CostType, ErpSystem } from "@constructos/shared";
import { round2 } from "./calc.js";

export interface ErpDialect {
  system: ErpSystem;
  label: string;
  /** header aliases, lower-cased, whitespace → underscore */
  account: string[];
  subAccount: string[];
  description: string[];
  amount: string[];
  quantity: string[];
  unit: string[];
  /** a sample header row for the download template */
  template: string;
}

export const ERP_DIALECTS: Record<ErpSystem, ErpDialect> = {
  sage: {
    system: "sage",
    label: "Sage 300 CRE / Intacct job cost",
    account: ["cost_code", "account", "gl_account", "acct", "job_cost_account"],
    subAccount: ["category", "cost_type", "sub_account", "subaccount"],
    description: ["description", "account_description", "memo"],
    amount: ["original_estimate", "estimate", "budget", "amount", "net_amount"],
    quantity: ["estimated_units", "units", "quantity"],
    unit: ["unit_of_measure", "uom", "unit"],
    template: "job,cost_code,category,description,estimated_units,unit_of_measure,original_estimate",
  },
  quickbooks: {
    system: "quickbooks",
    label: "QuickBooks budget by account",
    account: ["account", "account_number", "acct_no", "gl_account"],
    subAccount: ["class", "sub_account", "subaccount"],
    description: ["account_name", "name", "description", "memo"],
    amount: ["budget", "amount", "total", "annual_budget"],
    quantity: ["quantity", "qty"],
    unit: ["unit", "uom"],
    template: "account_number,account_name,class,budget",
  },
  viewpoint: {
    system: "viewpoint",
    label: "Viewpoint Vista / Spectrum job cost",
    account: ["phase", "phase_code", "cost_code", "gl_account", "account"],
    subAccount: ["cost_type", "ct", "cost_type_code", "sub_account"],
    description: ["phase_description", "description", "memo"],
    amount: ["orig_est_cost", "original_estimate", "estimate", "budget", "amount"],
    quantity: ["orig_est_units", "estimated_units", "units", "quantity"],
    unit: ["um", "uom", "unit"],
    template: "job,phase,cost_type,phase_description,orig_est_units,um,orig_est_cost",
  },
  xero: {
    system: "xero",
    label: "Xero budget export",
    account: ["account_code", "account", "code", "gl_account"],
    subAccount: ["tracking_category", "tracking", "sub_account"],
    description: ["account_name", "name", "description"],
    amount: ["budget", "amount", "total"],
    quantity: ["quantity"],
    unit: ["unit"],
    template: "account_code,account_name,tracking_category,budget",
  },
  oracle: {
    system: "oracle",
    label: "Oracle EBS / Fusion project budget",
    account: ["task", "task_number", "expenditure_type", "account", "gl_account"],
    subAccount: ["expenditure_category", "sub_account", "resource"],
    description: ["task_name", "description"],
    amount: ["raw_cost", "budget_amount", "amount", "budget"],
    quantity: ["quantity", "units"],
    unit: ["uom", "unit"],
    template: "project,task_number,expenditure_type,task_name,quantity,uom,budget_amount",
  },
  sap: {
    system: "sap",
    label: "SAP PS / CO cost element",
    account: ["cost_element", "gl_account", "account", "wbs_element"],
    subAccount: ["cost_center", "activity_type", "sub_account"],
    description: ["cost_element_description", "description", "text"],
    amount: ["plan_value", "planned_cost", "amount", "budget"],
    quantity: ["plan_quantity", "quantity"],
    unit: ["unit", "uom"],
    template: "wbs_element,cost_element,cost_element_description,plan_quantity,unit,plan_value",
  },
  other: {
    system: "other",
    label: "Generic GL export",
    account: ["gl_account", "account", "account_number", "code"],
    subAccount: ["sub_account", "subaccount", "cost_type", "category"],
    description: ["description", "account_name", "name", "memo"],
    amount: ["amount", "budget", "original_budget", "total"],
    quantity: ["quantity", "qty", "units"],
    unit: ["unit", "uom"],
    template: "gl_account,sub_account,description,quantity,unit,amount",
  },
};

export interface ErpRow {
  rowNumber: number;
  glAccount: string;
  glSubAccount: string | null;
  description: string | null;
  amount: number;
  quantity: number | null;
  unit: string | null;
}

export interface ErpParseIssue {
  row: number;
  field: string | null;
  message: string;
}

const normalise = (h: string): string => h.trim().toLowerCase().replace(/[\s\-/]+/g, "_");

/** Map a header row to the dialect's fields; unknown columns are reported. */
export function resolveErpHeader(header: readonly string[], system: ErpSystem): { mapped: Array<"account" | "subAccount" | "description" | "amount" | "quantity" | "unit" | null>; unknown: string[]; missing: string[] } {
  const d = ERP_DIALECTS[system];
  const mapped = header.map((h) => {
    const n = normalise(h);
    if (d.account.includes(n)) return "account" as const;
    if (d.subAccount.includes(n)) return "subAccount" as const;
    if (d.description.includes(n)) return "description" as const;
    if (d.amount.includes(n)) return "amount" as const;
    if (d.quantity.includes(n)) return "quantity" as const;
    if (d.unit.includes(n)) return "unit" as const;
    return null;
  });
  const unknown = header.filter((_, i) => mapped[i] === null);
  const missing: string[] = [];
  if (!mapped.includes("account")) missing.push("account");
  if (!mapped.includes("amount")) missing.push("amount");
  return { mapped, unknown, missing };
}

const toNumber = (cell: string): number | null => {
  const cleaned = cell.replace(/[,\s]/g, "").replace(/^\((.*)\)$/, "-$1").replace(/[£$€]/g, "");
  if (cleaned === "") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
};

export function parseErpRows(rows: readonly (readonly string[])[], system: ErpSystem): { rows: ErpRow[]; issues: ErpParseIssue[]; unknownColumns: string[] } {
  const header = rows[0] ?? [];
  const { mapped, unknown, missing } = resolveErpHeader(header, system);
  const issues: ErpParseIssue[] = [];
  if (missing.length > 0) {
    issues.push({ row: 1, field: null, message: `The ${ERP_DIALECTS[system].label} export needs ${missing.join(" and ")} column(s); recognised headers: ${missing.map((m) => ERP_DIALECTS[system][m as "account" | "amount"].join(" / ")).join("; ")}.` });
    return { rows: [], issues, unknownColumns: unknown };
  }
  const out: ErpRow[] = [];
  for (let r = 1; r < rows.length; r += 1) {
    const raw = rows[r] ?? [];
    const rowNumber = r + 1;
    if (raw.every((c) => (c ?? "").trim() === "")) continue;
    let glAccount = "";
    let glSubAccount: string | null = null;
    let description: string | null = null;
    let amount: number | null = null;
    let quantity: number | null = null;
    let unit: string | null = null;
    let bad = false;
    for (let c = 0; c < mapped.length; c += 1) {
      const field = mapped[c];
      const cell = (raw[c] ?? "").trim();
      if (!field || cell === "") continue;
      if (field === "account") glAccount = cell;
      else if (field === "subAccount") glSubAccount = cell;
      else if (field === "description") description = cell;
      else if (field === "unit") unit = cell;
      else {
        const n = toNumber(cell);
        if (n === null) {
          issues.push({ row: rowNumber, field, message: `"${cell}" is not a number.` });
          bad = true;
        } else if (field === "amount") amount = n;
        else quantity = n;
      }
    }
    if (bad) continue;
    if (glAccount === "") {
      issues.push({ row: rowNumber, field: "account", message: "The account column is empty." });
      continue;
    }
    if (amount === null) {
      issues.push({ row: rowNumber, field: "amount", message: "The amount column is empty." });
      continue;
    }
    out.push({ rowNumber, glAccount, glSubAccount, description, amount: round2(amount), quantity, unit });
  }
  return { rows: out, issues, unknownColumns: unknown };
}

export interface GlMapRow {
  id: string;
  projectId: string | null;
  erpSystem: string;
  glAccount: string;
  glSubAccount: string | null;
  costCodeId: string;
  costCode: string;
  costType: string;
  isActive: number;
}

export interface MappedBudgetLine {
  costCodeId: string;
  costCode: string;
  costType: CostType;
  description: string;
  originalBudget: number;
  quantity: number | null;
  unit: string | null;
  /** the GL rows summed into this line */
  provenance: Array<{ row: number; glAccount: string; glSubAccount: string | null; amount: number; mapId: string }>;
}

export interface UnmappedErpRow extends ErpRow {
  reason: string;
}

/**
 * Resolve every parsed row to a cost code × cost type through the map. A
 * project-scoped map row beats a company one; a sub-account-specific row
 * beats a bare account row. Rows landing on the same coordinate are summed.
 */
export function mapErpRows(rows: readonly ErpRow[], maps: readonly GlMapRow[], projectId: string, system: ErpSystem): { lines: MappedBudgetLine[]; unmapped: UnmappedErpRow[] } {
  const key = (acc: string, sub: string | null): string => `${normalise(acc)}|${sub === null ? "" : normalise(sub)}`;
  const active = maps.filter((m) => m.isActive === 1 && (m.erpSystem === system || m.erpSystem === "other"));
  const rank = (m: GlMapRow): number => (m.projectId === projectId ? 2 : 0) + (m.glSubAccount ? 1 : 0) + (m.erpSystem === system ? 4 : 0);
  const index = new Map<string, GlMapRow>();
  for (const m of active) {
    const k = key(m.glAccount, m.glSubAccount);
    const cur = index.get(k);
    if (!cur || rank(m) > rank(cur)) index.set(k, m);
  }
  const lines = new Map<string, MappedBudgetLine>();
  const unmapped: UnmappedErpRow[] = [];
  for (const row of rows) {
    const match = index.get(key(row.glAccount, row.glSubAccount)) ?? index.get(key(row.glAccount, null));
    if (!match) {
      unmapped.push({ ...row, reason: `No GL → cost-code mapping for account ${row.glAccount}${row.glSubAccount ? ` / ${row.glSubAccount}` : ""} (${ERP_DIALECTS[system].label}). Add the mapping and re-run.` });
      continue;
    }
    const coord = `${match.costCode}|${match.costType}`;
    const existing = lines.get(coord);
    if (existing) {
      existing.originalBudget = round2(existing.originalBudget + row.amount);
      existing.quantity = existing.quantity !== null && row.quantity !== null ? existing.quantity + row.quantity : null;
      if (existing.unit !== row.unit) existing.unit = null;
      existing.provenance.push({ row: row.rowNumber, glAccount: row.glAccount, glSubAccount: row.glSubAccount, amount: row.amount, mapId: match.id });
      if (row.description && !existing.description.includes(row.description)) existing.description = `${existing.description}; ${row.description}`.slice(0, 2000);
    } else {
      lines.set(coord, {
        costCodeId: match.costCodeId,
        costCode: match.costCode,
        costType: match.costType as CostType,
        description: row.description ?? `${row.glAccount}${row.glSubAccount ? ` / ${row.glSubAccount}` : ""}`,
        originalBudget: row.amount,
        quantity: row.quantity,
        unit: row.unit,
        provenance: [{ row: row.rowNumber, glAccount: row.glAccount, glSubAccount: row.glSubAccount, amount: row.amount, mapId: match.id }],
      });
    }
  }
  return { lines: [...lines.values()], unmapped };
}
