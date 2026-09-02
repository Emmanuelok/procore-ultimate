/**
 * Sheet-level segregation (spec Vol I #265, #282) — pure.
 *
 * A rule RESTRICTS a scope. Once at least one rule exists for
 * (scope, scopeValue) — a discipline, an area, or one sheet — only the
 * subjects listed for it can see those sheets: a user by id, or everyone on
 * a permission template. Nothing listed → nobody but the bypass roles
 * (company owner/admin, drawings admin) sees them. Scopes with no rules are
 * open, so a project that never configures segregation behaves as before.
 *
 * `standard` on a rule lets the subject mutate (markups, pins, calibration)
 * what they can see; `read` lets them look. A subject's level on a sheet is
 * the highest level any matching scope grants; a sheet hidden by ANY scope
 * (discipline, area or sheet) is hidden — restrictions compose as AND.
 */

export type RuleScope = "discipline" | "area" | "sheet";
export type RuleSubject = "user" | "template";
export type RuleLevel = "read" | "standard";

export interface SheetRule {
  scope: RuleScope;
  scopeValue: string;
  subjectType: RuleSubject;
  subjectId: string;
  level: RuleLevel;
}

export interface SheetSubject {
  userId: string;
  /** the user's permission template on the project, if a member */
  templateKey: string | null;
}

export interface HiddenScopes {
  /** disciplines this subject may not see (restricted, and not listed) */
  disciplines: Set<string>;
  areas: Set<string>;
  sheetIds: Set<string>;
  /** scope values this subject may see at `standard` level */
  standard: { disciplines: Set<string>; areas: Set<string>; sheetIds: Set<string> };
  /** true when the project has any rule at all */
  anyRules: boolean;
}

function matches(rule: SheetRule, subject: SheetSubject): boolean {
  if (rule.subjectType === "user") return rule.subjectId === subject.userId;
  return subject.templateKey !== null && rule.subjectId === subject.templateKey;
}

/** Compute what a subject cannot see, from every rule on the project. */
export function computeHiddenScopes(rules: SheetRule[], subject: SheetSubject): HiddenScopes {
  const groups = new Map<string, SheetRule[]>();
  for (const r of rules) {
    const k = `${r.scope}|${r.scopeValue}`;
    const list = groups.get(k) ?? [];
    list.push(r);
    groups.set(k, list);
  }
  const hidden: HiddenScopes = {
    disciplines: new Set(),
    areas: new Set(),
    sheetIds: new Set(),
    standard: { disciplines: new Set(), areas: new Set(), sheetIds: new Set() },
    anyRules: rules.length > 0,
  };
  for (const [, list] of groups) {
    const first = list[0]!;
    const mine = list.filter((r) => matches(r, subject));
    const bucket =
      first.scope === "discipline" ? "disciplines" : first.scope === "area" ? "areas" : "sheetIds";
    if (mine.length === 0) {
      hidden[bucket].add(first.scopeValue);
      continue;
    }
    if (mine.some((r) => r.level === "standard")) hidden.standard[bucket].add(first.scopeValue);
  }
  return hidden;
}

export interface SheetLike {
  id: string;
  discipline: string;
  area: string | null;
}

/** Can the subject see this sheet at all? */
export function sheetVisible(sheet: SheetLike, hidden: HiddenScopes): boolean {
  if (!hidden.anyRules) return true;
  if (hidden.sheetIds.has(sheet.id)) return false;
  if (hidden.disciplines.has(sheet.discipline)) return false;
  if (sheet.area && hidden.areas.has(sheet.area)) return false;
  return true;
}

/**
 * Does a rule explicitly grant `standard` on this sheet? Only consulted when
 * the caller's tool level is `read` — a rule can raise a reader to
 * standard within a segregated scope, never lower a standard user.
 */
export function sheetGrantsStandard(sheet: SheetLike, hidden: HiddenScopes): boolean {
  return (
    hidden.standard.sheetIds.has(sheet.id) ||
    hidden.standard.disciplines.has(sheet.discipline) ||
    (sheet.area !== null && hidden.standard.areas.has(sheet.area))
  );
}
