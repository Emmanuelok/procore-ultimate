/**
 * Shared machinery for the SPECIFICATIONS workspace.
 *
 * THE ONE RULE THIS FILE EXISTS TO ENFORCE
 *
 *   A MACHINE READING IS NEVER DISPLAYED AS IF A HUMAN VALIDATED IT.
 *
 * Every submittal requirement the API returns carries `extractionMethod`,
 * `extractionConfidence` and a `provenance` block, and the API keeps a
 * machine-read requirement at `identified` until a *different* person moves it
 * to `confirmed`. The UI's job is to make that visible at a glance rather than
 * to smooth it away: `<Provenance>` is loud, `<ConfidenceMeter>` prints the
 * number the extractor actually produced, and nothing in this workspace shows
 * a requirement's title without the stamp that says who says so.
 *
 * The other two rules the platform enforces everywhere and this file obeys:
 *
 *  · A figure with no inputs renders `not available` PLUS the server's own
 *    reasons — never a zero. See `<Unknowable>` and `metrics.ts` on the API.
 *  · A refusal is printed VERBATIM. The specifications API writes long,
 *    specific sentences ("The person who extracted or typed a requirement may
 *    not confirm it…"); paraphrasing one would destroy the only thing that
 *    makes it actionable.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ApiClientError, api } from "../../lib/api";
import { Alert, Badge, Tooltip } from "../../ui";
import { cx } from "../../ui/cx";
import { IconAi, IconCheckCircle, IconImport, IconUser } from "../../ui/icons";
import { toneClass, type Tone } from "../../ui/tokens";

/* ================================================================== */
/* Wire types                                                          */
/* ================================================================== */

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

/** The platform-wide honest-figure shape (apps/api/.../benchmarks/metrics.ts). */
export interface Unknowable {
  value: number | null;
  unit: string;
  inputs: Record<string, unknown>;
  reasons: string[];
}

export type SpecBookProcessing = "pending" | "processing" | "ready" | "failed";

export interface SpecBook {
  id: string;
  projectId: string;
  number: number;
  reference: string;
  name: string;
  description: string | null;
  issueLabel: string | null;
  issuedDate: string | null;
  issuedByOrganisation: string | null;
  classificationSystem: string;
  status: string;
  processing: SpecBookProcessing;
  processingError: string | null;
  sourceFileId: string | null;
  sourceFileSha256: string | null;
  pageCount: number | null;
  divisionCount: number;
  sectionCount: number;
  isCurrent: number;
  supersedesId: string | null;
  supersededById: string | null;
  registerBuiltAt: string | null;
  registerBuiltBy: string | null;
  contractId: string | null;
  createdBy: string;
  acceptedBy: string | null;
  acceptedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** What POST /spec-books answers with: the book plus the split's arithmetic. */
export interface SpecBookUploadResult extends SpecBook {
  divisionsCreated: number;
  sectionsInBook: number;
  sectionsCreated: number;
  revisionsAdded: number;
  unchangedSections: number;
  requirementsExtracted: number;
  requirementsConfirmed: number;
  error: string | null;
}

export interface SpecDivision {
  id: string;
  bookId: string;
  code: string;
  title: string;
  description: string | null;
  pageStart: number | null;
  pageEnd: number | null;
  sortOrder: number;
  sectionCount: number;
}

export interface SpecSection {
  id: string;
  divisionId: string | null;
  code: string;
  normalisedCode: string;
  title: string;
  divisionCode: string | null;
  status: string;
  currentRevisionId: string | null;
  revisionCount: number;
  responsibleVendorId: string | null;
  responsibleUserId: string | null;
  tradeCode: string | null;
  requirementsConfirmed: number;
  submittalRequirementCount: number;
  /** withdrawal (#288): a section absent from the current issue, retired by a person */
  withdrawnAt?: string | null;
  withdrawnBy?: string | null;
  withdrawnReason?: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface SpecRevision {
  id: string;
  sectionId: string;
  bookId: string;
  revision: string;
  revisionOrdinal: number;
  issuedDate: string | null;
  effectiveFrom: string | null;
  pageStart: number | null;
  pageEnd: number | null;
  fileId: string | null;
  fileSha256: string | null;
  extractedText: string | null;
  contentSha256: string | null;
  changeSummary: string | null;
  changedClauses: unknown[];
  isSuperseded: number;
  supersedesRevisionId: string | null;
  supersededByRevisionId: string | null;
  supersededAt: string | null;
  createdBy: string;
  issuedBy: string | null;
  acceptedBy: string | null;
  acceptedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type SpecExtractionMethod = "manual" | "ai_extracted" | "imported";

export type SpecRequirementStatus =
  | "identified"
  | "confirmed"
  | "registered"
  | "not_required"
  | "superseded";

/** The block the API attaches to every requirement, on every response. */
export interface SpecProvenance {
  extractionMethod: SpecExtractionMethod;
  extractionConfidence: number | null;
  humanConfirmed: boolean;
  confirmedBy: string | null;
  confirmedAt: string | null;
  registered: boolean;
  extractor: unknown;
}

export interface SpecRequirement {
  id: string;
  sectionId: string;
  sectionRevisionId: string | null;
  sectionCode: string;
  paragraphRef: string | null;
  title: string;
  description: string | null;
  clauseText: string | null;
  submittalType: string;
  requiredCopies: number | null;
  requiredBefore: string | null;
  leadTimeDays: number | null;
  reviewDays: number | null;
  isDeferred: number;
  status: SpecRequirementStatus;
  extractionMethod: SpecExtractionMethod;
  extractionConfidence: number | null;
  confirmedBy: string | null;
  confirmedAt: string | null;
  notRequiredReason: string | null;
  registeredSubmittalId: string | null;
  registeredAt: string | null;
  registeredBy: string | null;
  responsibleVendorId: string | null;
  commitmentId: string | null;
  bidPackageId: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  provenance: SpecProvenance;
}

export interface SpecReference {
  id: string;
  sectionId: string;
  sectionRevisionId: string | null;
  paragraphRef: string | null;
  pageIndex: number | null;
  targetType: string;
  targetId: string;
  targetLabel: string | null;
  referenceKind: string;
  note: string | null;
  extractionMethod: SpecExtractionMethod;
  extractionConfidence: number | null;
  resolvedBy: string | null;
  resolvedAt: string | null;
  resolutionNote: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface SpecConflict extends SpecReference {
  section: { id: string; code: string; title: string } | null;
  ageDays: number;
}

export interface SpecConflictsResponse {
  items: SpecConflict[];
  total: number;
  unresolved: number;
  note: string;
}

export interface SpecBookDetail extends SpecBook {
  divisions: SpecDivision[];
  sections: SpecSection[];
}

export interface SpecSectionDetail extends SpecSection {
  division: SpecDivision | null;
  currentRevision: SpecRevision | null;
  revisions: SpecRevision[];
  requirements: SpecRequirement[];
  references: SpecReference[];
}

export interface BuildRegisterResult {
  bookId: string;
  bookReference?: string;
  registeredCount: number;
  skippedCount: number;
  registered: Array<{ requirementId: string; submittalId: string; sectionCode: string }>;
  skipped: Array<{
    requirementId: string;
    sectionCode: string;
    status: string;
    reason: string;
  }>;
  reasons: string[];
}

export interface SpecCoverage {
  registerCompleteness: Unknowable;
  summary: {
    sections: number;
    requirements: number;
    identified: number;
    confirmed: number;
    registered: number;
    notRequired: number;
    submittals: number;
    sectionsWithoutConfirmedRequirements: number;
    requirementsNeverRegistered: number;
    submittalsWithoutSpecBasis: number;
  };
  sectionsWithoutConfirmedRequirements: Array<{
    sectionId: string;
    code: string;
    title: string;
    extractedButUnconfirmed: number;
    reason: string;
  }>;
  requirementsNeverRegistered: Array<{
    requirementId: string;
    sectionCode: string;
    paragraphRef: string | null;
    title: string;
    submittalType: string;
    status: string;
    extractionMethod: SpecExtractionMethod;
    extractionConfidence: number | null;
    humanConfirmed: boolean;
    blocker: string;
  }>;
  submittalsWithoutSpecBasis: Array<{
    submittalId: string;
    number: number;
    revision: number;
    title: string;
    specSection: string | null;
    reason: string;
  }>;
}

/* ================================================================== */
/* Vocabulary                                                          */
/* ================================================================== */

export const SUBMITTAL_TYPES = [
  "shop_drawing",
  "product_data",
  "sample",
  "mock_up",
  "o_and_m",
  "warranty",
  "certificate",
  "other",
] as const;

export const REQUIREMENT_STATUSES: readonly SpecRequirementStatus[] = [
  "identified",
  "confirmed",
  "registered",
  "not_required",
  "superseded",
];

export const REFERENCE_KINDS = [
  "detailed_on",
  "clarified_by",
  "coordinates_with",
  "conflicts_with",
  "procured_under",
  "superseded_by",
  "referenced_by",
] as const;

export const REFERENCE_TARGETS = [
  "drawing_sheet",
  "drawing_revision",
  "rfi",
  "submittal",
  "document",
  "spec_section",
  "change_event",
  "bid_package",
] as const;

export const REQUIREMENT_STATUS_TONE: Record<string, Tone> = {
  identified: "warning",
  confirmed: "info",
  registered: "success",
  not_required: "neutral",
  superseded: "neutral",
};

/** What each state *means*, in the words the API's own comments use. */
export const REQUIREMENT_STATUS_MEANING: Record<string, string> = {
  identified:
    "A machine or a person put this row here. Nobody has independently agreed it is real yet, so it cannot be registered.",
  confirmed:
    "A second person read the clause and agreed the requirement exists. It is now eligible to become a submittal.",
  registered: "A real submittal was built from this requirement. The submittal is the live record now.",
  not_required: "Ruled out with a written reason. It stays on the record rather than being deleted.",
  superseded: "The clause it was read out of has been reissued; a later requirement replaces it.",
};

export const BOOK_STATUS_TONE: Record<string, Tone> = {
  draft: "neutral",
  processing: "info",
  current: "success",
  superseded: "neutral",
  archived: "neutral",
  failed: "danger",
};

export const PROCESSING_TONE: Record<SpecBookProcessing, Tone> = {
  pending: "neutral",
  processing: "info",
  ready: "success",
  failed: "danger",
};

export const SECTION_STATUS_TONE: Record<string, Tone> = {
  draft: "neutral",
  current: "success",
  superseded: "warning",
  withdrawn: "danger",
};

export const REFERENCE_KIND_TONE: Record<string, Tone> = {
  conflicts_with: "danger",
  superseded_by: "warning",
  clarified_by: "info",
  detailed_on: "neutral",
  coordinates_with: "neutral",
  procured_under: "neutral",
  referenced_by: "neutral",
};

export const EXTRACTION_LABEL: Record<SpecExtractionMethod, string> = {
  manual: "Typed by a person",
  ai_extracted: "Read by the extractor",
  imported: "Imported from another system",
};

/* ================================================================== */
/* Formatting                                                          */
/* ================================================================== */

export const EM_DASH = "—";

export function titleCase(value: string | null | undefined): string {
  if (!value) return EM_DASH;
  return value
    .split(/[_\s]+/)
    .map((word) => (word ? word.charAt(0).toUpperCase() + word.slice(1) : word))
    .join(" ");
}

export function isoDate(value: string | null | undefined): string {
  if (!value) return EM_DASH;
  return value.slice(0, 10);
}

export function dateTime(value: string | null | undefined): string {
  if (!value) return EM_DASH;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function count(n: number): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

export function shortHash(value: string | null | undefined): string {
  if (!value) return EM_DASH;
  return value.slice(0, 12);
}

/** A confidence as the extractor produced it: a fraction, printed as a percent. */
export function confidencePercent(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return EM_DASH;
  return `${Math.round(value * 100)}%`;
}

/* ================================================================== */
/* Errors and refusals — printed, never paraphrased                    */
/* ================================================================== */

export interface Refusal {
  status: number;
  message: string;
  reasons: string[];
  extra: Array<{ key: string; value: string }>;
}

const SUPPRESSED_KEYS = new Set(["reasons"]);

function stringifyDetail(value: unknown): string {
  if (value === null || value === undefined) return EM_DASH;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

export function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiClientError) return err.message;
  return err instanceof Error ? err.message : fallback;
}

export function refusalFrom(err: unknown): Refusal {
  if (!(err instanceof ApiClientError)) {
    return {
      status: 0,
      message: err instanceof Error ? err.message : "The request failed.",
      reasons: [],
      extra: [],
    };
  }
  const body = err.details as { details?: unknown } | undefined;
  const detail =
    body && typeof body === "object" && body.details && typeof body.details === "object"
      ? (body.details as Record<string, unknown>)
      : {};
  const rawReasons = detail["reasons"];
  return {
    status: err.status,
    message: err.message,
    reasons: Array.isArray(rawReasons) ? rawReasons.map((r) => String(r)) : [],
    extra: Object.entries(detail)
      .filter(([k]) => !SUPPRESSED_KEYS.has(k))
      .map(([key, value]) => ({ key, value: stringifyDetail(value) })),
  };
}

/**
 * The refusal panel. A 403 out of this module is almost always a segregation
 * control firing — the uploader trying to accept their own book, the extractor
 * trying to confirm their own reading — so it is framed as the control working,
 * not as a fault the user should route around.
 */
export function RefusalPanel({
  refusal,
  title,
  onDismiss,
}: {
  refusal: Refusal | null;
  title?: string;
  onDismiss?: () => void;
}) {
  if (!refusal) return null;
  const segregation = refusal.status === 403;
  const heading =
    title ??
    (segregation
      ? "Segregation of duties — this control did its job"
      : refusal.status === 409
        ? "Refused: the record is already in that state"
        : refusal.status === 400
          ? "Refused: a precondition is not met"
          : "The server refused this");
  return (
    <Alert
      tone={segregation ? "warning" : "danger"}
      title={heading}
      {...(onDismiss ? { onDismiss } : {})}
    >
      <p className="whitespace-pre-wrap">{refusal.message}</p>
      <ReasonList reasons={refusal.reasons} className="mt-2" />
      {refusal.extra.length > 0 ? (
        <dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5 text-2xs">
          {refusal.extra.map((e) => (
            <div key={e.key} className="contents">
              <dt className="font-medium text-content-muted">{e.key}</dt>
              <dd className="font-mono text-content">{e.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </Alert>
  );
}

export function ReasonList({
  reasons,
  className,
}: {
  reasons: readonly string[];
  className?: string;
}) {
  if (reasons.length === 0) return null;
  return (
    <ul className={cx("space-y-1", className)}>
      {reasons.map((reason, index) => (
        <li key={index} className="flex items-start gap-1.5 text-meta text-content-muted">
          <span aria-hidden className="mt-0.5 shrink-0 text-content-disabled">
            ▪
          </span>
          <span>{reason}</span>
        </li>
      ))}
    </ul>
  );
}

export function LoadError({
  message,
  onRetry,
  title = "This view could not be loaded",
}: {
  message: string;
  onRetry?: () => void;
  title?: string;
}) {
  return (
    <Alert
      tone="danger"
      title={title}
      actions={
        onRetry ? (
          <button
            type="button"
            onClick={onRetry}
            className="rounded-md border border-danger-border bg-surface-raised px-2.5 py-1 text-meta font-medium text-content hover:bg-surface-hover"
          >
            Retry
          </button>
        ) : undefined
      }
    >
      {message}
    </Alert>
  );
}

/* ================================================================== */
/* Honest figures                                                      */
/* ================================================================== */

/**
 * An `Unknowable`: the number when the platform holds the inputs, and
 * "not available" plus the server's reasons when it does not. A zero here
 * would read like an answer, and coverage of 0% is a very different claim
 * from "there is nothing to measure coverage against".
 */
export function UnknowableValue({
  figure,
  render,
  className,
  reasonsBelow = true,
}: {
  figure: Unknowable | null | undefined;
  render: (value: number) => ReactNode;
  className?: string;
  reasonsBelow?: boolean;
}) {
  if (!figure) return <span className={className}>{EM_DASH}</span>;
  if (figure.value === null) {
    return (
      <span className={className}>
        <span className="italic text-content-subtle">not available</span>
        {reasonsBelow && figure.reasons.length > 0 ? (
          <ReasonList reasons={figure.reasons} className="mt-1.5" />
        ) : null}
      </span>
    );
  }
  return <span className={className}>{render(figure.value)}</span>;
}

/* ================================================================== */
/* PROVENANCE — the loudest thing in this workspace                    */
/* ================================================================== */

const METHOD_TONE: Record<SpecExtractionMethod, Tone> = {
  ai_extracted: "warning",
  manual: "info",
  imported: "neutral",
};

const METHOD_ICON = {
  ai_extracted: IconAi,
  manual: IconUser,
  imported: IconImport,
} as const;

/**
 * The stamp that says WHO SAYS SO.
 *
 * `size="row"` is the compact form for a grid cell; `size="full"` is the block
 * used in a drawer, which spells the whole position out in a sentence. Both
 * always show the extraction method, and both always show whether a human has
 * confirmed it — an AI reading with 92% confidence and a human confirmation are
 * different facts and must never render alike.
 */
export function Provenance({
  provenance,
  size = "row",
  className,
}: {
  provenance: SpecProvenance;
  size?: "row" | "full";
  className?: string;
}) {
  const method = provenance.extractionMethod;
  const Glyph = METHOD_ICON[method] ?? IconUser;
  const machine = method !== "manual";
  const confirmed = provenance.humanConfirmed;

  if (size === "row") {
    return (
      <span className={cx("flex min-w-0 flex-wrap items-center gap-1", className)}>
        <Tooltip
          content={
            machine
              ? `${EXTRACTION_LABEL[method]}. This is a machine reading of the clause, not a human assertion that the requirement exists.`
              : "A person typed this row. There is no confidence score because no measurement was taken."
          }
        >
          <span>
            <Badge tone={METHOD_TONE[method]} size="xs" icon={Glyph} variant="subtle">
              {machine ? "Machine read" : "Human typed"}
            </Badge>
          </span>
        </Tooltip>
        {provenance.extractionConfidence !== null ? (
          <ConfidenceMeter value={provenance.extractionConfidence} />
        ) : null}
        <Badge
          tone={confirmed ? "success" : "warning"}
          size="xs"
          variant={confirmed ? "subtle" : "solid"}
          icon={confirmed ? IconCheckCircle : undefined}
        >
          {confirmed ? "Human confirmed" : "Unconfirmed"}
        </Badge>
      </span>
    );
  }

  return (
    <div
      className={cx(
        "rounded-lg border p-3",
        confirmed ? "border-border bg-surface-raised" : "border-warning-border bg-warning-subtle",
        className,
      )}
    >
      <p className="text-label uppercase text-content-subtle">Provenance</p>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        <Badge tone={METHOD_TONE[method]} size="sm" icon={Glyph}>
          {EXTRACTION_LABEL[method]}
        </Badge>
        {provenance.extractionConfidence !== null ? (
          <ConfidenceMeter value={provenance.extractionConfidence} showLabel />
        ) : (
          <Badge tone="neutral" size="sm">
            No confidence recorded
          </Badge>
        )}
        <Badge
          tone={confirmed ? "success" : "warning"}
          size="sm"
          variant={confirmed ? "subtle" : "solid"}
        >
          {confirmed ? "Confirmed by a human" : "Not confirmed by a human"}
        </Badge>
      </div>
      <p className="mt-2 text-meta text-content-muted">
        {machine
          ? confirmed
            ? `The extractor (${String(provenance.extractor ?? "unknown build")}) read this out of the clause; a person then read the clause and agreed with it${
                provenance.confirmedAt ? ` on ${isoDate(provenance.confirmedAt)}` : ""
              }.`
            : `The extractor (${String(
                provenance.extractor ?? "unknown build",
              )}) read this out of the clause. Nobody has agreed with it yet — extraction is not validation, and this row cannot be registered as a submittal until somebody other than the extractor confirms it.`
          : confirmed
            ? `A person typed this requirement, and a second person confirmed it${
                provenance.confirmedAt ? ` on ${isoDate(provenance.confirmedAt)}` : ""
              }. No confidence figure exists because no measurement was ever taken.`
            : "A person typed this requirement. It still needs an independent confirmation from someone else before it can be registered — the author may not confirm their own row."}
      </p>
      {provenance.registered ? (
        <p className="mt-1.5 text-meta text-content-muted">
          A submittal has been built from this requirement. The requirement is frozen; the submittal
          is the live record from here on.
        </p>
      ) : null}
    </div>
  );
}

/** The extractor's confidence, drawn as well as printed. Never rounded away. */
export function ConfidenceMeter({
  value,
  showLabel = false,
  className,
}: {
  value: number;
  showLabel?: boolean;
  className?: string;
}) {
  const pct = Math.max(0, Math.min(1, value));
  const tone: Tone = pct >= 0.8 ? "success" : pct >= 0.6 ? "warning" : "danger";
  return (
    <Tooltip
      content={`The extractor scored this reading ${confidencePercent(value)}. It is a measure of how confidently the text was parsed — not of whether the requirement is real.`}
    >
      <span className={cx("inline-flex items-center gap-1.5", className)}>
        <span
          aria-hidden
          className="h-1.5 w-10 overflow-hidden rounded-full bg-neutral-subtle"
        >
          <span
            className={cx("block h-full rounded-full", toneClass(tone, "dot"))}
            style={{ width: `${pct * 100}%` }}
          />
        </span>
        <span className={cx("text-2xs tabular-nums", toneClass(tone, "text"))}>
          {confidencePercent(value)}
          {showLabel ? " confidence" : ""}
        </span>
      </span>
    </Tooltip>
  );
}

/**
 * The header banner for any list of extracted rows. Stated once, at the top,
 * so the grid underneath is read in the right frame.
 */
export function ExtractionDisclaimer({ machineCount }: { machineCount: number }) {
  if (machineCount === 0) return null;
  return (
    <Alert tone="warning" variant="subtle" size="sm" title="Extraction is not validation">
      {count(machineCount)} requirement{machineCount === 1 ? " on this list was" : "s on this list were"}{" "}
      read out of the spec text by the extractor. A machine reading is a candidate, not a register
      entry: it stays <strong>identified</strong> until a person who did not run the extraction
      confirms it, and registration refuses anything that is not confirmed. There is no override.
    </Alert>
  );
}

/* ================================================================== */
/* Data hooks                                                          */
/* ================================================================== */

export interface Loadable<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

/** One GET, reloadable, aborting on unmount. `path` null means "not yet". */
export function useResource<T>(path: string | null): Loadable<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(path !== null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (path === null) {
      setData(null);
      setLoading(false);
      setError(null);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    api
      .get<T>(path, { signal: controller.signal })
      .then((res) => {
        if (controller.signal.aborted) return;
        setData(res);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setError(errorMessage(err, "This view could not be loaded."));
        setLoading(false);
      });
    return () => controller.abort();
  }, [path, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { data, loading, error, reload };
}

/** A mutation with its refusal held beside it, never swallowed. */
export function useAction(): {
  busy: string | null;
  refusal: Refusal | null;
  clear: () => void;
  run: <T>(key: string, fn: () => Promise<T>) => Promise<T | null>;
} {
  const [busy, setBusy] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const run = useCallback(async <T,>(key: string, fn: () => Promise<T>): Promise<T | null> => {
    setBusy(key);
    setRefusal(null);
    try {
      return await fn();
    } catch (err) {
      if (alive.current) setRefusal(refusalFrom(err));
      return null;
    } finally {
      if (alive.current) setBusy(null);
    }
  }, []);
  const clear = useCallback(() => setRefusal(null), []);
  return { busy, refusal, clear, run };
}

/* ---------------------------------------------------------------- */
/* Resource hooks, one per endpoint                                   */
/* ---------------------------------------------------------------- */

const base = (projectId: string) => `/api/v1/projects/${projectId}`;

export function useSpecBooks(projectId: string | undefined, version: number) {
  const path = useMemo(
    () => (projectId ? `${base(projectId)}/spec-books?page=1&pageSize=200&_v=${version}` : null),
    [projectId, version],
  );
  return useResource<Paginated<SpecBook>>(path);
}

export function useSpecBook(projectId: string | undefined, bookId: string | null, version: number) {
  const path = useMemo(
    () => (projectId && bookId ? `${base(projectId)}/spec-books/${bookId}?_v=${version}` : null),
    [projectId, bookId, version],
  );
  return useResource<SpecBookDetail>(path);
}

export function useSpecDivisions(projectId: string | undefined, version: number) {
  const path = useMemo(
    () => (projectId ? `${base(projectId)}/spec-divisions?_v=${version}` : null),
    [projectId, version],
  );
  return useResource<{ items: SpecDivision[]; total: number }>(path);
}

export interface SectionFilters {
  status: string;
  divisionCode: string;
  bookId: string;
  search: string;
}

export const EMPTY_SECTION_FILTERS: SectionFilters = {
  status: "",
  divisionCode: "",
  bookId: "",
  search: "",
};

export function useSpecSections(
  projectId: string | undefined,
  filters: SectionFilters,
  version: number,
) {
  const path = useMemo(() => {
    if (!projectId) return null;
    const params = new URLSearchParams({ page: "1", pageSize: "200", _v: String(version) });
    if (filters.status) params.set("status", filters.status);
    if (filters.divisionCode) params.set("divisionCode", filters.divisionCode);
    if (filters.bookId) params.set("bookId", filters.bookId);
    if (filters.search) params.set("search", filters.search);
    return `${base(projectId)}/spec-sections?${params.toString()}`;
  }, [projectId, filters.status, filters.divisionCode, filters.bookId, filters.search, version]);
  return useResource<Paginated<SpecSection>>(path);
}

export function useSpecSection(
  projectId: string | undefined,
  sectionId: string | null,
  version: number,
) {
  const path = useMemo(
    () =>
      projectId && sectionId
        ? `${base(projectId)}/spec-sections/${sectionId}?_v=${version}`
        : null,
    [projectId, sectionId, version],
  );
  return useResource<SpecSectionDetail>(path);
}

export interface RequirementFilters {
  status: string;
  submittalType: string;
  extractionMethod: string;
  bookId: string;
  registered: string;
}

export const EMPTY_REQUIREMENT_FILTERS: RequirementFilters = {
  status: "",
  submittalType: "",
  extractionMethod: "",
  bookId: "",
  registered: "",
};

export function useSpecRequirements(
  projectId: string | undefined,
  filters: RequirementFilters,
  version: number,
) {
  const path = useMemo(() => {
    if (!projectId) return null;
    const params = new URLSearchParams({ page: "1", pageSize: "200", _v: String(version) });
    if (filters.status) params.set("status", filters.status);
    if (filters.submittalType) params.set("submittalType", filters.submittalType);
    if (filters.extractionMethod) params.set("extractionMethod", filters.extractionMethod);
    if (filters.bookId) params.set("bookId", filters.bookId);
    if (filters.registered) params.set("registered", filters.registered);
    return `${base(projectId)}/spec-requirements?${params.toString()}`;
  }, [
    projectId,
    filters.status,
    filters.submittalType,
    filters.extractionMethod,
    filters.bookId,
    filters.registered,
    version,
  ]);
  return useResource<Paginated<SpecRequirement>>(path);
}

export function useSpecCoverage(projectId: string | undefined, version: number) {
  const path = useMemo(
    () => (projectId ? `${base(projectId)}/spec-coverage?_v=${version}` : null),
    [projectId, version],
  );
  return useResource<SpecCoverage>(path);
}

export function useSpecConflicts(
  projectId: string | undefined,
  includeResolved: boolean,
  version: number,
) {
  const path = useMemo(
    () =>
      projectId
        ? `${base(projectId)}/spec-references/conflicts?includeResolved=${
            includeResolved ? "1" : "0"
          }&_v=${version}`
        : null,
    [projectId, includeResolved, version],
  );
  return useResource<SpecConflictsResponse>(path);
}

/* ---------------------------------------------------------------- */
/* Reissue notices and full-text search (#288, #298)                  */
/* ---------------------------------------------------------------- */

export interface SpecAffectedSubmittal {
  submittalId: string;
  requirementId: string;
  paragraphRef: string | null;
  kind: "removed" | "amended";
}

export interface SpecRevisionNotice {
  id: string;
  sectionId: string;
  sectionCode: string;
  sectionTitle: string | null;
  sectionStatus: string | null;
  revisionId: string;
  previousRevisionId: string | null;
  bookId: string | null;
  revision: string;
  changedClauseCount: number;
  requirementsSuperseded: number;
  requirementsToReconfirm: number;
  requirementsNew: number;
  submittalsAffected: SpecAffectedSubmittal[];
  notifiedUserIds: string[];
  notifiedNames: string[];
  acknowledgedBy: string | null;
  acknowledgedByName: string | null;
  acknowledgedAt: string | null;
  detail: Record<string, unknown>;
  createdBy: string;
  createdByName: string | null;
  createdAt: string;
}

export interface SpecRevisionNoticesResponse extends Paginated<SpecRevisionNotice> {
  unacknowledged: number;
}

export function useSpecRevisionNotices(
  projectId: string | undefined,
  acknowledged: "" | "0" | "1",
  version: number,
) {
  const path = useMemo(() => {
    if (!projectId) return null;
    const params = new URLSearchParams({ page: "1", pageSize: "200", _v: String(version) });
    if (acknowledged) params.set("acknowledged", acknowledged);
    return `${base(projectId)}/spec-revision-notices?${params.toString()}`;
  }, [projectId, acknowledged, version]);
  return useResource<SpecRevisionNoticesResponse>(path);
}

export interface SpecSearchHit {
  sectionId: string;
  code: string;
  title: string;
  status: string;
  revisionId: string;
  revision: string;
  pageStart: number | null;
  rank: number;
  snippet: string;
}

export interface SpecSearchResponse {
  q: string;
  items: SpecSearchHit[];
  total: number;
  basis: string;
}

export function useSpecSearch(projectId: string | undefined, query: string, version: number) {
  const path = useMemo(() => {
    const term = query.trim();
    if (!projectId || term.length < 2) return null;
    return `${base(projectId)}/spec-search?q=${encodeURIComponent(term)}&limit=50&_v=${version}`;
  }, [projectId, query, version]);
  return useResource<SpecSearchResponse>(path);
}

/**
 * `ts_headline` marks matches with `[[ ]]` (the server picks delimiters that
 * cannot appear in a spec clause). Split into runs so React renders the
 * emphasis rather than the API echoing HTML back into the page.
 */
export function snippetRuns(snippet: string): Array<{ text: string; hit: boolean }> {
  const out: Array<{ text: string; hit: boolean }> = [];
  const re = /\[\[(.*?)\]\]/gs;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(snippet)) !== null) {
    if (m.index > last) out.push({ text: snippet.slice(last, m.index), hit: false });
    out.push({ text: m[1] ?? "", hit: true });
    last = m.index + m[0].length;
  }
  if (last < snippet.length) out.push({ text: snippet.slice(last), hit: false });
  return out;
}
