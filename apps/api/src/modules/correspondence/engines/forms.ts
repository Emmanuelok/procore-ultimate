/**
 * FORM LOGIC AND VALIDATION (spec #457–463).
 *
 * Two jobs, both pure:
 *
 *  1. VISIBILITY. A field can declare `visibleWhen`, a conjunction and/or a
 *     disjunction of simple `field <op> value` conditions. There is no
 *     expression language and nothing is ever evaluated as code — #459 asks
 *     for "simple to complex form logic", and complexity here means composing
 *     conditions, not embedding a interpreter in a jsonb column.
 *     Visibility is TRANSITIVE: a field controlled by a hidden field is
 *     itself hidden, because the controlling answer does not exist.
 *
 *  2. VALIDATION. A submitted response is checked against the exact template
 *     version it was captured on: required fields (only where visible),
 *     option membership, numeric and length bounds, date shape, and the
 *     signature #462 demands. Hidden fields are STRIPPED rather than
 *     rejected, so a form whose branch changed mid-fill does not trap the
 *     person filling it in.
 *
 * A cycle in the logic (A visible when B, B visible when A) cannot be
 * resolved; the engine reports it as a template defect and treats both fields
 * as visible, which is the safe direction — a required field is asked for
 * rather than silently dropped.
 */
import type {
  FormFieldDef,
  FormFieldType,
  FormLogicCondition,
  FormLogicRule,
  FormSignature,
} from "@constructos/shared";

/* ------------------------------------------------------------------ */
/* Conditions                                                          */
/* ------------------------------------------------------------------ */

function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Loose equality across the wire shapes a form value can arrive in. */
function looseEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === "boolean" || typeof b === "boolean") {
    const ab = typeof a === "boolean" ? a : a === "true" || a === 1;
    const bb = typeof b === "boolean" ? b : b === "true" || b === 1;
    return ab === bb;
  }
  const an = asNumber(a);
  const bn = asNumber(b);
  if (an !== null && bn !== null) return an === bn;
  if (a === null || a === undefined || b === null || b === undefined) return false;
  return String(a) === String(b);
}

export function evaluateCondition(
  condition: FormLogicCondition,
  values: Record<string, unknown>,
): boolean {
  const actual = values[condition.field];
  switch (condition.operator) {
    case "empty":
      return isEmpty(actual);
    case "not_empty":
      return !isEmpty(actual);
    case "eq":
      return looseEquals(actual, condition.value);
    case "ne":
      return !looseEquals(actual, condition.value);
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      const a = asNumber(actual);
      const b = asNumber(condition.value);
      if (a === null || b === null) return false;
      if (condition.operator === "gt") return a > b;
      if (condition.operator === "gte") return a >= b;
      if (condition.operator === "lt") return a < b;
      return a <= b;
    }
    case "in": {
      const list = Array.isArray(condition.value) ? condition.value : [];
      if (Array.isArray(actual)) return actual.some((v) => list.some((c) => looseEquals(v, c)));
      return list.some((c) => looseEquals(actual, c));
    }
    case "not_in": {
      const list = Array.isArray(condition.value) ? condition.value : [];
      if (Array.isArray(actual)) return !actual.some((v) => list.some((c) => looseEquals(v, c)));
      return !list.some((c) => looseEquals(actual, c));
    }
    case "contains": {
      if (Array.isArray(actual)) return actual.some((v) => looseEquals(v, condition.value));
      if (typeof actual === "string" && condition.value !== undefined && condition.value !== null) {
        return actual.toLowerCase().includes(String(condition.value).toLowerCase());
      }
      return false;
    }
    default:
      return false;
  }
}

export function evaluateRule(rule: FormLogicRule, values: Record<string, unknown>): boolean {
  const all = rule.all ?? [];
  const any = rule.any ?? [];
  if (all.length === 0 && any.length === 0) return true;
  const allPass = all.every((c) => evaluateCondition(c, values));
  const anyPass = any.length === 0 ? true : any.some((c) => evaluateCondition(c, values));
  return allPass && anyPass;
}

/* ------------------------------------------------------------------ */
/* Visibility                                                          */
/* ------------------------------------------------------------------ */

export interface VisibilityResult {
  visible: string[];
  hidden: string[];
  /** template defects found while resolving: cycles and unknown field refs */
  defects: string[];
}

/** The fields a rule depends on, so cycles and dangling refs can be found. */
export function ruleDependencies(rule: FormLogicRule | null | undefined): string[] {
  if (!rule) return [];
  return [...(rule.all ?? []), ...(rule.any ?? [])].map((c) => c.field);
}

/**
 * Which fields are on screen given the current answers. `extraLogic` is the
 * template-level `logic` map, merged on top of each field's own `visibleWhen`
 * (both must pass — a field is shown only when nothing hides it).
 */
export function resolveVisibility(
  fields: readonly FormFieldDef[],
  values: Record<string, unknown>,
  extraLogic: Record<string, FormLogicRule> = {},
): VisibilityResult {
  const byKey = new Map(fields.map((f) => [f.key, f]));
  const defects: string[] = [];
  const memo = new Map<string, boolean>();
  const stack = new Set<string>();

  const rulesFor = (key: string): FormLogicRule[] => {
    const out: FormLogicRule[] = [];
    const field = byKey.get(key);
    if (field?.visibleWhen) out.push(field.visibleWhen);
    const extra = extraLogic[key];
    if (extra) out.push(extra);
    return out;
  };

  const visibleOf = (key: string): boolean => {
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    if (stack.has(key)) {
      defects.push(
        `Field "${key}" takes part in a visibility cycle; the engine shows every field in the cycle rather than guessing.`,
      );
      return true;
    }
    stack.add(key);
    let visible = true;
    for (const rule of rulesFor(key)) {
      for (const dep of ruleDependencies(rule)) {
        if (!byKey.has(dep)) {
          defects.push(`Field "${key}" is controlled by "${dep}", which this template does not define.`);
          continue;
        }
        // A hidden controller has no answer, so anything it controls is hidden.
        if (!visibleOf(dep)) visible = false;
      }
      if (visible && !evaluateRule(rule, values)) visible = false;
      if (!visible) break;
    }
    stack.delete(key);
    memo.set(key, visible);
    return visible;
  };

  const visible: string[] = [];
  const hidden: string[] = [];
  for (const field of fields) {
    if (visibleOf(field.key)) visible.push(field.key);
    else hidden.push(field.key);
  }
  return { visible, hidden, defects: [...new Set(defects)] };
}

/* ------------------------------------------------------------------ */
/* Template validation                                                 */
/* ------------------------------------------------------------------ */

const VALUE_BEARING: ReadonlySet<FormFieldType> = new Set<FormFieldType>([
  "text",
  "textarea",
  "number",
  "date",
  "time",
  "select",
  "multiselect",
  "checkbox",
  "radio",
  "rating",
  "signature",
  "photo",
  "file",
  "user",
  "location",
]);

const OPTION_BEARING: ReadonlySet<FormFieldType> = new Set<FormFieldType>([
  "select",
  "multiselect",
  "radio",
]);

/** Structural problems in a template, checked before it can be published. */
export function validateTemplate(
  fields: readonly FormFieldDef[],
  extraLogic: Record<string, FormLogicRule> = {},
): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  if (fields.length === 0) problems.push("A template needs at least one field.");
  for (const field of fields) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(field.key)) {
      problems.push(`Field key "${field.key}" must start with a letter and contain only letters, digits and underscores.`);
    }
    if (seen.has(field.key)) problems.push(`Field key "${field.key}" is used more than once.`);
    seen.add(field.key);
    if (field.label.trim() === "") problems.push(`Field "${field.key}" has no label.`);
    if (OPTION_BEARING.has(field.type)) {
      const options = field.options ?? [];
      if (options.length === 0) problems.push(`Field "${field.key}" is a ${field.type} with no options.`);
      const optionValues = new Set<string>();
      for (const option of options) {
        if (optionValues.has(option.value)) {
          problems.push(`Field "${field.key}" repeats the option value "${option.value}".`);
        }
        optionValues.add(option.value);
      }
    }
    if (field.type === "heading" && field.required) {
      problems.push(`Field "${field.key}" is a heading and cannot be required.`);
    }
    if (
      typeof field.min === "number" &&
      typeof field.max === "number" &&
      field.min > field.max
    ) {
      problems.push(`Field "${field.key}" has a minimum above its maximum.`);
    }
  }
  // Reuse the visibility resolver to surface cycles and dangling references.
  const { defects } = resolveVisibility(fields, {}, extraLogic);
  problems.push(...defects);
  for (const key of Object.keys(extraLogic)) {
    if (!seen.has(key)) problems.push(`Logic references field "${key}", which this template does not define.`);
  }
  return [...new Set(problems)];
}

/* ------------------------------------------------------------------ */
/* Response validation                                                 */
/* ------------------------------------------------------------------ */

export interface FieldError {
  field: string;
  message: string;
}

export interface ResponseValidation {
  ok: boolean;
  errors: FieldError[];
  /** values with hidden fields removed and simple types coerced */
  cleaned: Record<string, unknown>;
  visible: string[];
  hidden: string[];
  defects: string[];
  /** visible, value-bearing fields that were answered */
  answered: number;
  /** visible, value-bearing fields in total */
  askable: number;
}

function coerce(field: FormFieldDef, raw: unknown): { value: unknown; error: string | null } {
  switch (field.type) {
    case "number":
    case "rating": {
      const n = asNumber(raw);
      if (n === null) return { value: null, error: "must be a number" };
      if (typeof field.min === "number" && n < field.min) {
        return { value: n, error: `must be at least ${field.min}` };
      }
      if (typeof field.max === "number" && n > field.max) {
        return { value: n, error: `must be at most ${field.max}` };
      }
      return { value: n, error: null };
    }
    case "checkbox": {
      if (typeof raw === "boolean") return { value: raw, error: null };
      if (raw === "true" || raw === 1 || raw === "1") return { value: true, error: null };
      if (raw === "false" || raw === 0 || raw === "0") return { value: false, error: null };
      return { value: null, error: "must be true or false" };
    }
    case "date": {
      if (typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
        return { value: null, error: "must be a date (YYYY-MM-DD)" };
      }
      if (Number.isNaN(Date.parse(`${raw}T00:00:00.000Z`))) {
        return { value: null, error: "is not a real date" };
      }
      return { value: raw, error: null };
    }
    case "time": {
      if (typeof raw !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(raw)) {
        return { value: null, error: "must be a time (HH:MM, 24-hour)" };
      }
      return { value: raw, error: null };
    }
    case "multiselect":
    case "photo":
    case "file": {
      if (!Array.isArray(raw)) return { value: null, error: "must be a list" };
      return { value: raw.map((v) => (typeof v === "string" ? v : String(v))), error: null };
    }
    case "select":
    case "radio":
    case "text":
    case "textarea":
    case "user":
    case "location": {
      if (typeof raw !== "string") return { value: null, error: "must be text" };
      if (typeof field.maxLength === "number" && raw.length > field.maxLength) {
        return { value: raw, error: `must be at most ${field.maxLength} characters` };
      }
      return { value: raw, error: null };
    }
    case "signature": {
      if (typeof raw !== "string" || raw.trim() === "") {
        return { value: null, error: "must be a signed name" };
      }
      return { value: raw.trim(), error: null };
    }
    default:
      return { value: raw, error: null };
  }
}

export interface ValidateResponseOptions {
  /** a draft is checked for shape but not for completeness */
  requireComplete: boolean;
  /** the template asks for a signature (#462) */
  signatureRequired: boolean;
  signature?: FormSignature | null;
}

export function validateResponse(
  fields: readonly FormFieldDef[],
  values: Record<string, unknown>,
  extraLogic: Record<string, FormLogicRule>,
  options: ValidateResponseOptions,
): ResponseValidation {
  const { visible, hidden, defects } = resolveVisibility(fields, values, extraLogic);
  const visibleSet = new Set(visible);
  const byKey = new Map(fields.map((f) => [f.key, f]));
  const errors: FieldError[] = [];
  const cleaned: Record<string, unknown> = {};
  let answered = 0;
  let askable = 0;

  for (const key of Object.keys(values)) {
    if (!byKey.has(key)) {
      errors.push({ field: key, message: "is not a field on this template" });
    }
  }

  for (const field of fields) {
    if (!VALUE_BEARING.has(field.type)) continue;
    if (!visibleSet.has(field.key)) continue;
    askable += 1;
    const raw = values[field.key];
    if (isEmpty(raw)) {
      if (options.requireComplete && field.required) {
        errors.push({ field: field.key, message: "is required" });
      }
      continue;
    }
    const { value, error } = coerce(field, raw);
    if (error) {
      errors.push({ field: field.key, message: error });
      continue;
    }
    if (OPTION_BEARING.has(field.type)) {
      const allowed = new Set((field.options ?? []).map((o) => o.value));
      const chosen = Array.isArray(value) ? value : [value];
      for (const one of chosen) {
        if (!allowed.has(String(one))) {
          errors.push({ field: field.key, message: `"${String(one)}" is not one of the offered options` });
        }
      }
    }
    cleaned[field.key] = value;
    answered += 1;
  }

  if (options.requireComplete && options.signatureRequired) {
    const sig = options.signature;
    if (!sig || typeof sig.name !== "string" || sig.name.trim() === "") {
      errors.push({ field: "__signature", message: "this form must be signed before it is submitted" });
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    cleaned,
    visible,
    hidden,
    defects,
    answered,
    askable,
  };
}

/* ------------------------------------------------------------------ */
/* PDF field mapping (#458)                                            */
/* ------------------------------------------------------------------ */

export interface PdfMappingReport {
  /** acroform name → template field key, for the fields that map */
  mapped: Record<string, string>;
  /** acroform names in the mapping that no template field claims */
  danglingPdfFields: string[];
  /** template fields with no acroform counterpart */
  unmappedFields: string[];
}

/**
 * Reconcile the stored acroform mapping with the template's own fields. A PDF
 * field that maps nowhere and a template field that maps to nothing are both
 * printed rather than silently dropped: #458 is only useful if the person
 * building the form can see what will not be filled in.
 */
export function reconcilePdfMapping(
  fields: readonly FormFieldDef[],
  pdfFieldMap: Record<string, string>,
): PdfMappingReport {
  const keys = new Set(fields.filter((f) => f.type !== "heading").map((f) => f.key));
  const mapped: Record<string, string> = {};
  const dangling: string[] = [];
  const claimed = new Set<string>();
  for (const [pdfField, key] of Object.entries(pdfFieldMap)) {
    if (keys.has(key)) {
      mapped[pdfField] = key;
      claimed.add(key);
    } else {
      dangling.push(pdfField);
    }
  }
  for (const field of fields) {
    if (field.type === "heading") continue;
    if (field.pdfField && !claimed.has(field.key)) {
      mapped[field.pdfField] = field.key;
      claimed.add(field.key);
    }
  }
  return {
    mapped,
    danglingPdfFields: dangling.sort(),
    unmappedFields: [...keys].filter((k) => !claimed.has(k)).sort(),
  };
}
