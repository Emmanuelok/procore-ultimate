/**
 * Custom field value validation (Vol I §0.3 #62–#64).
 *
 * `PUT .../custom-values` used to write whatever JSON it was handed against
 * a field definition: a dropdown accepted a value that was not one of its
 * options, a number field accepted "banana", a currency field accepted a bare
 * string, and `required` meant nothing. Every report and filter built on
 * custom fields then had to defend itself against data the platform had
 * promised was typed.
 *
 * This module is the type system for those values: one validator per
 * fieldType, returning either the coerced value or the reason it was refused.
 * Pure — no database, no request — so every branch is unit-testable.
 */

export const CUSTOM_FIELD_TYPES = [
  "text",
  "number",
  "date",
  "dropdown",
  "multi_select",
  "checkbox",
  "currency",
  "lookup",
] as const;
export type CustomFieldType = (typeof CUSTOM_FIELD_TYPES)[number];

export interface FieldDefLike {
  id: string;
  key: string;
  label: string;
  fieldType: string;
  options: string[];
  required: number;
}

export type FieldValidation =
  | { ok: true; value: unknown }
  | { ok: false; reason: string };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const CURRENCY_CODE = /^[A-Z]{3}$/;

function isEmpty(value: unknown): boolean {
  return (
    value === null ||
    value === undefined ||
    (typeof value === "string" && value.trim() === "") ||
    (Array.isArray(value) && value.length === 0)
  );
}

/**
 * Validate one value against its definition.
 *
 * Coercion is deliberately narrow: a numeric STRING becomes a number (an
 * HTML input hands strings back), but nothing else is guessed. A value that
 * would need guessing is refused with the reason, which is what the caller
 * shows the user.
 */
export function validateFieldValue(def: FieldDefLike, value: unknown): FieldValidation {
  if (isEmpty(value)) {
    if (def.required) return { ok: false, reason: `"${def.label}" is required` };
    return { ok: true, value: null };
  }

  switch (def.fieldType as CustomFieldType) {
    case "text": {
      if (typeof value !== "string") return { ok: false, reason: `"${def.label}" must be text` };
      if (value.length > 10_000) return { ok: false, reason: `"${def.label}" is too long` };
      return { ok: true, value };
    }
    case "number": {
      const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
      if (!Number.isFinite(n)) return { ok: false, reason: `"${def.label}" must be a number` };
      return { ok: true, value: n };
    }
    case "date": {
      if (typeof value !== "string" || !ISO_DATE.test(value.slice(0, 10))) {
        return { ok: false, reason: `"${def.label}" must be an ISO date (YYYY-MM-DD)` };
      }
      const iso = value.slice(0, 10);
      const parsed = Date.parse(`${iso}T00:00:00Z`);
      if (Number.isNaN(parsed)) {
        return { ok: false, reason: `"${def.label}" is not a real date` };
      }
      return { ok: true, value: iso };
    }
    case "checkbox": {
      if (typeof value === "boolean") return { ok: true, value };
      if (value === "true" || value === "false") return { ok: true, value: value === "true" };
      return { ok: false, reason: `"${def.label}" must be true or false` };
    }
    case "dropdown": {
      if (typeof value !== "string") return { ok: false, reason: `"${def.label}" must be one option` };
      if (!def.options.includes(value)) {
        return {
          ok: false,
          reason: `"${value}" is not an option for "${def.label}" (${def.options.join(", ") || "no options defined"})`,
        };
      }
      return { ok: true, value };
    }
    case "multi_select": {
      if (!Array.isArray(value)) {
        return { ok: false, reason: `"${def.label}" must be a list of options` };
      }
      const bad = value.filter((v) => typeof v !== "string" || !def.options.includes(v));
      if (bad.length > 0) {
        return {
          ok: false,
          reason: `Not options for "${def.label}": ${bad.map((b) => String(b)).join(", ")}`,
        };
      }
      return { ok: true, value: [...new Set(value as string[])] };
    }
    case "currency": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return {
          ok: false,
          reason: `"${def.label}" must be { amount, currency } — money without a currency is not a number`,
        };
      }
      const record = value as Record<string, unknown>;
      const rawAmount = record["amount"];
      const amount =
        typeof rawAmount === "number"
          ? rawAmount
          : typeof rawAmount === "string"
            ? Number(rawAmount)
            : NaN;
      if (!Number.isFinite(amount)) {
        return { ok: false, reason: `"${def.label}" needs a numeric amount` };
      }
      const currency = record["currency"];
      if (typeof currency !== "string" || !CURRENCY_CODE.test(currency)) {
        return { ok: false, reason: `"${def.label}" needs a 3-letter currency code` };
      }
      return { ok: true, value: { amount, currency } };
    }
    case "lookup": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return { ok: false, reason: `"${def.label}" must be { type, id }` };
      }
      const record = value as Record<string, unknown>;
      const type = record["type"];
      const id = record["id"];
      if (typeof type !== "string" || type === "" || typeof id !== "string" || id === "") {
        return { ok: false, reason: `"${def.label}" must name a record type and id` };
      }
      return { ok: true, value: { type, id } };
    }
    default:
      return { ok: false, reason: `Unknown field type "${def.fieldType}"` };
  }
}

export interface ValidationReport {
  values: Record<string, unknown>;
  errors: Array<{ fieldDefId: string; key: string; reason: string }>;
}

/** Validate a whole `{ defId: value }` payload against its definitions. */
export function validateFieldValues(
  defs: FieldDefLike[],
  input: Record<string, unknown>,
): ValidationReport {
  const byId = new Map(defs.map((d) => [d.id, d]));
  const values: Record<string, unknown> = {};
  const errors: ValidationReport["errors"] = [];
  for (const [defId, raw] of Object.entries(input)) {
    const def = byId.get(defId);
    if (!def) {
      errors.push({ fieldDefId: defId, key: defId, reason: "Unknown field definition" });
      continue;
    }
    const result = validateFieldValue(def, raw);
    if (result.ok) values[defId] = result.value;
    else errors.push({ fieldDefId: defId, key: def.key, reason: result.reason });
  }
  return { values, errors };
}

/** Required definitions the payload does not answer. */
export function missingRequired(
  defs: FieldDefLike[],
  provided: Record<string, unknown>,
  alreadyStored: Set<string>,
): FieldDefLike[] {
  return defs.filter(
    (d) =>
      d.required === 1 &&
      !alreadyStored.has(d.id) &&
      (!(d.id in provided) || isEmpty(provided[d.id])),
  );
}
