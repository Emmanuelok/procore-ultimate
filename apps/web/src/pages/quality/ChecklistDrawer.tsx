/**
 * ONE CHECKLIST, item by item.
 *
 * The point of this screen is that a TICK IS NOT A RECORD. A measurement item
 * carries a target, an acceptance window and a reading, and all three are
 * drawn — the window as a band, the reading as a mark on it — because "26.4mm
 * against 25 ±2" is evidence and a green tick is an assertion.
 *
 * Three states, never two:
 *
 *   PASS / FAIL   the platform judged it against the item's own bounds.
 *   NOT JUDGEABLE the item cannot be judged — a measurement with a target but
 *                 no tolerance, a free-text answer, a select with no declared
 *                 passing set. These are drawn in their own colour, carry the
 *                 engine's reason, and are excluded from the score. A checklist
 *                 that scores 100% by counting unjudgeable items as passes is
 *                 worse than no checklist at all.
 *
 * The specification for each item comes from the issued template (fetched by
 * id) or, for an ad-hoc checklist, from the `detail.itemSpec` stamped on the
 * response itself — exactly the two sources the API reads.
 */
import { useMemo, useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  Drawer,
  Field,
  Input,
  Modal,
  Select,
  Skeleton,
  Textarea,
} from "../../ui";
import { cx } from "../../ui/cx";
import { toneClass, type Tone } from "../../ui/tokens";
import { api } from "../../lib/api";
import {
  CHECKLIST_STATUS_TONE,
  EM_DASH,
  Facts,
  LoadError,
  NothingHere,
  RESULT_TONE,
  ReasonList,
  RefusalNotice,
  SectionTitle,
  TONE_RAIL,
  dateTime,
  isNumericItemType,
  isStructuralItemType,
  isoDate,
  labelize,
  nameOf,
  num,
  pct,
  plural,
  specFromResponseDetail,
  specFromTemplateItem,
  toleranceBounds,
  useAction,
  useResource,
  type ItemSpec,
} from "./qualityShared";
import type {
  ChecklistDetail,
  ChecklistResponse,
  ItemEvaluation,
  TemplateDetail,
} from "./types";

export default function ChecklistDrawer({
  checklistId,
  projectId,
  users,
  onClose,
  onMutated,
}: {
  checklistId: string | null;
  projectId: string;
  users: Map<string, string>;
  onClose: () => void;
  onMutated: () => void;
}) {
  const [nonce, setNonce] = useState(0);
  const detail = useResource<ChecklistDetail>(
    (signal) =>
      api.get<ChecklistDetail>(`/api/v1/projects/${projectId}/checklists/${checklistId}`, {
        signal,
      }),
    [projectId, checklistId, nonce],
    checklistId !== null,
  );
  const templateId = detail.data?.templateId ?? null;
  const template = useResource<TemplateDetail>(
    (signal) =>
      api.get<TemplateDetail>(`/api/v1/companies/current/checklist-templates/${templateId}`, {
        signal,
      }),
    [templateId],
    templateId !== null,
  );

  function refresh() {
    setNonce((n) => n + 1);
    onMutated();
  }

  return (
    <Drawer
      open={checklistId !== null}
      onClose={onClose}
      size="xl"
      title={detail.data ? `${detail.data.reference} · ${detail.data.title}` : "Checklist"}
      description={
        detail.data
          ? `${labelize(detail.data.category)} · ${detail.data.answeredItemCount} of ${detail.data.responses.length} ${plural(detail.data.responses.length, "item")} answered`
          : undefined
      }
      resizable
      resizeStorageKey="quality.checklist.drawer"
    >
      {checklistId === null ? null : detail.error ? (
        <div className="p-4">
          <LoadError
            message={detail.error}
            onRetry={detail.reload}
            title="This checklist could not be loaded"
          />
        </div>
      ) : detail.loading && !detail.data ? (
        <div className="space-y-3 p-4">
          <Skeleton height={130} />
          <Skeleton height={90} />
          <Skeleton height={90} />
          <Skeleton height={90} />
        </div>
      ) : detail.data ? (
        <ChecklistBody
          checklist={detail.data}
          template={template.data}
          templateLoading={template.loading}
          templateError={template.error}
          projectId={projectId}
          users={users}
          onMutated={refresh}
        />
      ) : null}
    </Drawer>
  );
}

/* ================================================================== */

interface ItemRow {
  response: ChecklistResponse;
  spec: ItemSpec;
  evaluation: ItemEvaluation | undefined;
}

function ChecklistBody({
  checklist,
  template,
  templateLoading,
  templateError,
  projectId,
  users,
  onMutated,
}: {
  checklist: ChecklistDetail;
  template: TemplateDetail | null;
  templateLoading: boolean;
  templateError: string | null;
  projectId: string;
  users: Map<string, string>;
  onMutated: () => void;
}) {
  const { busy, refusal, clear, run } = useAction();
  const [signOff, setSignOff] = useState<null | "witness" | "review">(null);
  const [signName, setSignName] = useState("");
  const [signNote, setSignNote] = useState("");

  const base = `/api/v1/projects/${projectId}/checklists/${checklist.id}`;

  const rows = useMemo<ItemRow[]>(() => {
    const itemById = new Map((template?.items ?? []).map((i) => [i.id, i] as const));
    const evalById = new Map(checklist.scoring.evaluations.map((e) => [e.itemId, e] as const));
    return checklist.responses.map((response) => {
      const templateItem = response.templateItemId ? itemById.get(response.templateItemId) : undefined;
      const spec = templateItem ? specFromTemplateItem(templateItem) : specFromResponseDetail(response);
      return { response, spec, evaluation: evalById.get(spec.id) };
    });
  }, [checklist.responses, checklist.scoring.evaluations, template]);

  const sections = useMemo(() => {
    const out: Array<{ name: string | null; items: ItemRow[] }> = [];
    for (const row of rows) {
      const name = row.spec.section ?? null;
      const last = out[out.length - 1];
      if (last && last.name === name) last.items.push(row);
      else out.push({ name, items: [row] });
    }
    return out;
  }, [rows]);

  async function act(action: "complete" | "close", body?: unknown) {
    const done = await run(action, () => api.post(`${base}/${action}`, body ?? {}));
    if (done) onMutated();
  }

  async function submitSignOff() {
    if (!signOff) return;
    const done = await run(signOff, () =>
      api.post(`${base}/${signOff}`, {
        name: signName.trim() === "" ? null : signName.trim(),
        note: signNote.trim() === "" ? null : signNote.trim(),
      }),
    );
    if (done) {
      setSignOff(null);
      setSignName("");
      setSignNote("");
      onMutated();
    }
  }

  const scoring = checklist.scoring;
  /**
   * Answers may only be edited while the record is still open. A completed
   * checklist is evidence of what was found at the time; the API refuses an
   * edit underneath a result rather than letting the verdict drift away from
   * the answers that produced it.
   */
  const answerable = ["draft", "scheduled", "in_progress"].includes(checklist.status);
  /** Answered, but the engine could not judge it — the third state. */
  const unjudgeable = rows.filter(
    (r) => r.evaluation !== undefined && r.evaluation.answered && !r.evaluation.judged,
  ).length;

  return (
    <div className="space-y-5 p-4">
      <RefusalNotice refusal={refusal} onDismiss={clear} />

      {/* -------- the verdict -------- */}
      <section className="space-y-2.5">
        <SectionTitle
          title="The verdict"
          hint="Computed by the same engine the completion will apply, from the answers as they stand."
          actions={
            <Badge tone={CHECKLIST_STATUS_TONE[checklist.status] ?? "neutral"} size="sm" dot>
              {labelize(checklist.status)}
            </Badge>
          }
        />
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <VerdictTile
            label="Result"
            value={scoring.result ? labelize(scoring.result) : null}
            unavailable="no verdict can be stated"
            tone={scoring.result ? (RESULT_TONE[scoring.result] ?? "neutral") : undefined}
          />
          <VerdictTile
            label="Score"
            value={scoring.scorePercent === null ? null : pct(scoring.scorePercent)}
            unavailable="this form produces no score"
            hint={
              scoring.score !== null && scoring.maxScore !== null
                ? `${num(scoring.score)} of ${num(scoring.maxScore)}`
                : undefined
            }
          />
          <VerdictTile
            label="Judged items"
            value={`${scoring.judgedItemCount} of ${scoring.answeredItemCount} answered`}
            unavailable=""
            hint={`${unjudgeable} answered ${plural(unjudgeable, "item")} could not be judged and ${plural(unjudgeable, "is", "are")} excluded from the score`}
          />
          <VerdictTile
            label="Failures"
            value={`${scoring.failedItemCount}`}
            unavailable=""
            tone={scoring.criticalFailureCount > 0 ? "danger" : scoring.failedItemCount > 0 ? "warning" : "success"}
            hint={
              scoring.criticalFailureCount > 0
                ? `${scoring.criticalFailureCount} critical — the checklist fails whatever the score says`
                : undefined
            }
          />
        </div>
        {scoring.reasons.length > 0 ? (
          <div className="rounded-md border border-border bg-surface-raised p-2.5">
            <p className="text-label uppercase tracking-wide text-content-subtle">
              Why the figures read as they do
            </p>
            <ReasonList reasons={scoring.reasons} className="mt-1" />
          </div>
        ) : null}
        {scoring.unansweredRequiredItemIds.length > 0 ? (
          <Alert tone="warning" size="sm" variant="subtle" title="Required items are unanswered">
            {scoring.unansweredRequiredItemIds.length}{" "}
            {plural(scoring.unansweredRequiredItemIds.length, "required item")}{" "}
            {plural(scoring.unansweredRequiredItemIds.length, "has", "have")} no answer. They are
            excluded from the score rather than counted as passes.
          </Alert>
        ) : null}
      </section>

      {/* -------- the record -------- */}
      <section className="space-y-2.5">
        <SectionTitle title="The record" />
        <Facts
          columns={3}
          items={[
            {
              label: "Form",
              value: template
                ? `${template.reference} v${template.version}`
                : checklist.templateId
                  ? templateLoading
                    ? "loading…"
                    : "template could not be read"
                  : "ad hoc — no controlled form",
              hint: template?.name ?? undefined,
            },
            {
              label: "Stamped version",
              value: checklist.templateVersion === null ? "n/a" : `v${checklist.templateVersion}`,
              hint: "Stamped so a later template revision cannot rewrite the past.",
            },
            { label: "Scoring method", value: template ? labelize(template.scoringMethod) : EM_DASH },
            {
              label: "Pass threshold",
              value:
                template && template.passThreshold !== null
                  ? pct(template.passThreshold)
                  : "none recorded",
            },
            { label: "Location", value: checklist.locationText ?? "not stated" },
            {
              label: "Performed",
              value: checklist.performedAt ? dateTime(checklist.performedAt) : "not yet performed",
              hint: checklist.performedBy
                ? `by ${nameOf(users, checklist.performedBy)}`
                : (checklist.performedByName ?? undefined),
            },
            {
              label: "Witnessed",
              value: checklist.witnessedAt ? dateTime(checklist.witnessedAt) : "not witnessed",
              hint: checklist.witnessedBy
                ? `by ${nameOf(users, checklist.witnessedBy)} — a second party, never the performer`
                : "A contractor's own signature on its own test is not evidence.",
            },
            {
              label: "Reviewed",
              value: checklist.reviewedAt ? dateTime(checklist.reviewedAt) : "not reviewed",
              hint: checklist.reviewedBy ? `by ${nameOf(users, checklist.reviewedBy)}` : undefined,
            },
            {
              label: "NCRs raised",
              value: String(checklist.ncrCount),
              hint: "Raised automatically where a failing item is flagged to raise one.",
            },
          ]}
        />
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Button
            size="sm"
            variant="secondary"
            loading={busy === "complete"}
            disabled={!["draft", "scheduled", "in_progress"].includes(checklist.status)}
            onClick={() => act("complete")}
          >
            Complete the record
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={checklist.status === "void"}
            onClick={() => setSignOff("witness")}
          >
            Witness
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={checklist.status !== "complete" && checklist.status !== "failed"}
            onClick={() => setSignOff("review")}
          >
            Review
          </Button>
          <Button
            size="sm"
            variant="ghost"
            loading={busy === "close"}
            disabled={checklist.status !== "reviewed"}
            onClick={() => act("close")}
          >
            Close
          </Button>
        </div>
        <p className="text-2xs text-content-subtle">
          Witnessing and reviewing are both refused to whoever performed the record. That is the
          only reason a signed checklist is worth anything.
        </p>
      </section>

      {/* -------- the items -------- */}
      <section className="space-y-3">
        <SectionTitle
          title={`Items (${rows.length})`}
          hint="A measurement shows its target, its acceptance window and the reading. A tick alone is an assertion, not a record."
        />
        {checklist.templateId && templateError ? (
          <Alert tone="warning" size="sm" title="The issued form could not be read">
            <p className="whitespace-pre-wrap">{templateError}</p>
            <p className="mt-1">
              Targets and tolerance bands come from the template. Without it, the answers below are
              shown as recorded but their acceptance windows cannot be drawn — they are not being
              assumed.
            </p>
          </Alert>
        ) : null}
        {rows.length === 0 ? (
          <NothingHere
            title="This checklist carries no items"
            reason="It was taken without a template and no ad-hoc items have been added, so there is nothing to answer and nothing to judge."
          />
        ) : (
          <div className="space-y-4">
            {sections.map((section, i) => (
              <div key={section.name ?? `section-${i}`} className="space-y-2">
                {section.name ? (
                  <h4 className="text-label uppercase tracking-wide text-content-subtle">
                    {section.name}
                  </h4>
                ) : null}
                <div className="space-y-2">
                  {section.items.map((row) => (
                    <ItemCard
                      key={row.response.id}
                      row={row}
                      base={base}
                      editable={answerable}
                      onSaved={onMutated}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <Modal
        open={signOff !== null}
        onClose={() => setSignOff(null)}
        title={signOff === "review" ? "Review this record" : "Witness this record"}
        description={
          signOff === "review"
            ? "A review is a third pair of eyes over a completed record. The API refuses a review by the person who performed it."
            : "A witness is a second party who watched the same test. The API refuses a witness signature from the person who performed it."
        }
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setSignOff(null)}>
              Cancel
            </Button>
            <Button variant="primary" loading={busy === signOff} onClick={submitSignOff}>
              Record it
            </Button>
          </div>
        }
      >
        <div className="space-y-3">
          <Field label="Name" hint="As it should read on the record.">
            <Input value={signName} onChange={(e) => setSignName(e.target.value)} />
          </Field>
          <Field label="Note">
            <Textarea rows={2} value={signNote} onChange={(e) => setSignNote(e.target.value)} />
          </Field>
        </div>
      </Modal>
    </div>
  );
}

function VerdictTile({
  label,
  value,
  unavailable,
  hint,
  tone,
}: {
  label: string;
  value: string | null;
  unavailable: string;
  hint?: string;
  tone?: Tone;
}) {
  return (
    <div className="rounded-lg border border-border bg-surface-raised p-3">
      <div className="text-label uppercase tracking-wide text-content-subtle">{label}</div>
      <div
        className={cx(
          "mt-1",
          value === null
            ? "text-sm italic text-content-subtle"
            : cx("text-base font-semibold", tone ? toneClass(tone, "text") : "text-content"),
        )}
      >
        {value ?? (unavailable === "" ? EM_DASH : unavailable)}
      </div>
      {hint ? <div className="mt-1 text-2xs text-content-subtle">{hint}</div> : null}
    </div>
  );
}

/* ================================================================== */
/* One item                                                            */
/* ================================================================== */

function ItemCard({
  row,
  base,
  editable,
  onSaved,
}: {
  row: ItemRow;
  base: string;
  editable: boolean;
  onSaved: () => void;
}) {
  const { response, spec, evaluation } = row;

  if (isStructuralItemType(spec.itemType)) {
    return (
      <div className="border-t border-border pt-3">
        <h4 className="text-sm font-semibold text-content">{spec.text || response.questionText}</h4>
      </div>
    );
  }

  const judged = evaluation?.judged ?? false;
  const isPass = evaluation?.isPass ?? null;
  const notApplicable = response.isNotApplicable === 1;
  const tone: Tone = notApplicable
    ? "neutral"
    : isPass === true
      ? "success"
      : isPass === false
        ? evaluation?.criticalFailure
          ? "danger"
          : "warning"
        : "info";

  return (
    <div
      className={cx(
        "rounded-lg border border-l-4 border-border bg-surface-raised p-3",
        TONE_RAIL[tone],
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            {spec.itemNumber ? (
              <span className="font-mono text-2xs text-content-subtle">{spec.itemNumber}</span>
            ) : null}
            <Badge tone="neutral" size="xs" variant="outline">
              {labelize(spec.itemType)}
            </Badge>
            {spec.isCritical ? (
              <Badge tone="danger" size="xs" variant="outline">
                critical
              </Badge>
            ) : null}
            {spec.isHoldPoint ? (
              <Badge tone="danger" size="xs" variant="outline">
                hold point
              </Badge>
            ) : null}
            {spec.raisesNcrOnFail ? (
              <Badge tone="warning" size="xs" variant="outline">
                raises an NCR on failure
              </Badge>
            ) : null}
            {spec.required ? null : (
              <Badge tone="neutral" size="xs" variant="outline">
                optional
              </Badge>
            )}
          </div>
          <p className="mt-1 text-sm text-content">{response.questionText}</p>
          {spec.acceptanceCriteria ? (
            <p className="mt-0.5 text-2xs text-content-muted">{spec.acceptanceCriteria}</p>
          ) : null}
          {spec.specReference ? (
            <p className="mt-0.5 text-2xs text-content-subtle">Spec {spec.specReference}</p>
          ) : null}
        </div>
        <Verdict
          judged={judged}
          isPass={isPass}
          notApplicable={notApplicable}
          critical={evaluation?.criticalFailure ?? false}
        />
      </div>

      <div className="mt-2.5">
        {isNumericItemType(spec.itemType) ? (
          <Measurement spec={spec} measured={response.numericValue} isPass={isPass} />
        ) : (
          <PlainAnswer response={response} spec={spec} />
        )}
      </div>

      {(response.note || response.instrumentSerial || response.measuredAt || response.ncrId) ? (
        <dl className="mt-2 flex flex-wrap gap-x-4 gap-y-1 border-t border-border-subtle pt-2 text-2xs">
          {response.instrumentSerial ? (
            <div className="flex gap-1.5">
              <dt className="text-content-subtle">Instrument</dt>
              <dd className="font-mono">{response.instrumentSerial}</dd>
            </div>
          ) : null}
          {response.measuredAt ? (
            <div className="flex gap-1.5">
              <dt className="text-content-subtle">Measured</dt>
              <dd className="tabular-nums">{dateTime(response.measuredAt)}</dd>
            </div>
          ) : null}
          {response.ncrId ? (
            <div className="flex gap-1.5">
              <dt className="text-content-subtle">NCR</dt>
              <dd className="font-mono">{response.ncrId}</dd>
            </div>
          ) : null}
          {response.note ? (
            <div className="basis-full text-content-muted">{response.note}</div>
          ) : null}
        </dl>
      ) : null}

      {evaluation && evaluation.reasons.length > 0 ? (
        <ReasonList reasons={evaluation.reasons} className="mt-2" />
      ) : null}

      {editable ? (
        <AnswerEditor
          /* Remount when the stored answer changes so the controls re-seed
           * from the record rather than keeping a stale local draft. */
          key={`${response.id}-${response.respondedAt ?? "unanswered"}`}
          response={response}
          spec={spec}
          base={base}
          onSaved={onSaved}
        />
      ) : null}
    </div>
  );
}

/* ================================================================== */
/* Recording an answer                                                 */
/* ================================================================== */

/**
 * The answer controls, typed by the item.
 *
 * Deliberately thin: it collects exactly what the item's type accepts and
 * hands it to the API, which validates it against the same engine that scores
 * it. Every refusal comes back in the validator's own words — "Item 4.2
 * expects one of pass / fail — received \"ok\"" — and is printed rather than
 * replaced with a generic message, because the sentence names the fix.
 */
function AnswerEditor({
  response,
  spec,
  base,
  onSaved,
}: {
  response: ChecklistResponse;
  spec: ItemSpec;
  base: string;
  onSaved: () => void;
}) {
  const { busy, refusal, clear, run } = useAction();
  const [numeric, setNumeric] = useState(
    response.numericValue === null ? "" : String(response.numericValue),
  );
  const [text, setText] = useState(response.response ?? "");
  const [chosen, setChosen] = useState<string[]>(response.selectedOptions);
  const [note, setNote] = useState(response.note ?? "");
  const [instrument, setInstrument] = useState(response.instrumentSerial ?? "");
  const [na, setNa] = useState(response.isNotApplicable === 1);
  const [naReason, setNaReason] = useState(response.naReason ?? "");

  const numericItem = isNumericItemType(spec.itemType);
  const booleanTokens = BOOLEAN_TOKENS[spec.itemType];
  const attachmentOnly =
    spec.itemType === "photo" || spec.itemType === "file_upload" || spec.itemType === "signature";

  async function save(overrideResponse?: string) {
    const body: Record<string, unknown> = { note: note.trim() === "" ? null : note.trim() };
    if (na) {
      body["isNotApplicable"] = true;
      body["naReason"] = naReason.trim() === "" ? null : naReason.trim();
    } else {
      body["isNotApplicable"] = false;
      if (numericItem) {
        const parsed = numeric.trim() === "" ? null : Number(numeric);
        body["numericValue"] = parsed !== null && Number.isFinite(parsed) ? parsed : null;
        if (instrument.trim() !== "") body["instrumentSerial"] = instrument.trim();
      } else if (spec.itemType === "multi_select") {
        body["selectedOptions"] = chosen;
      } else {
        const value = overrideResponse ?? text;
        body["response"] = value.trim() === "" ? null : value;
      }
    }
    const done = await run("save", () => api.put(`${base}/responses/${response.id}`, body));
    if (done) onSaved();
  }

  if (attachmentOnly) {
    return (
      <p className="mt-2 border-t border-border-subtle pt-2 text-2xs text-content-subtle">
        This item takes {spec.itemType === "signature" ? "a signature" : "an attachment"}, which is
        captured on the record rather than typed here. Nothing is being assumed about it in the
        meantime — it counts as unanswered.
      </p>
    );
  }

  return (
    <div className="mt-2 space-y-2 border-t border-border-subtle pt-2.5">
      <RefusalNotice refusal={refusal} onDismiss={clear} />
      {na ? (
        <Field
          label="Reason it does not apply"
          required
          hint="The API refuses a not-applicable answer with no reason — an unexplained NA is indistinguishable from a skipped item."
        >
          <Input value={naReason} onChange={(e) => setNaReason(e.target.value)} />
        </Field>
      ) : booleanTokens ? (
        <div className="flex flex-wrap gap-1.5">
          {booleanTokens.map((token) => (
            <Button
              key={token}
              size="sm"
              variant={response.response === token ? "primary" : "secondary"}
              loading={busy === "save" && text === token}
              onClick={() => {
                setText(token);
                void save(token);
              }}
            >
              {labelize(token)}
            </Button>
          ))}
        </div>
      ) : numericItem ? (
        <div className="grid gap-2 sm:grid-cols-[10rem_1fr]">
          <Field label={`Reading${spec.unit ? ` (${spec.unit})` : ""}`}>
            <Input
              type="number"
              step="any"
              value={numeric}
              onChange={(e) => setNumeric(e.target.value)}
              placeholder="no reading"
            />
          </Field>
          <Field
            label="Instrument serial"
            hint="A reading taken with an unrecorded instrument cannot be traced back to a calibration certificate."
          >
            <Input value={instrument} onChange={(e) => setInstrument(e.target.value)} />
          </Field>
        </div>
      ) : spec.itemType === "single_select" ? (
        <Field label="Answer">
          <Select value={text} onChange={(e) => setText(e.target.value)}>
            <option value="">No answer</option>
            {spec.options.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </Select>
        </Field>
      ) : spec.itemType === "multi_select" ? (
        <div className="flex flex-wrap gap-2">
          {spec.options.length === 0 ? (
            <p className="text-2xs text-content-subtle">
              This item declares no options, so there is nothing to choose and the API will refuse
              anything typed against it.
            </p>
          ) : (
            spec.options.map((option) => (
              <Checkbox
                key={option}
                size="sm"
                label={option}
                checked={chosen.includes(option)}
                onChange={(e) =>
                  setChosen((prev) =>
                    e.target.checked ? [...prev, option] : prev.filter((o) => o !== option),
                  )
                }
              />
            ))
          )}
        </div>
      ) : spec.itemType === "date" ? (
        <Field label="Date">
          <Input type="date" value={text} onChange={(e) => setText(e.target.value)} />
        </Field>
      ) : spec.itemType === "long_text" ? (
        <Field label="Answer">
          <Textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} />
        </Field>
      ) : (
        <Field label="Answer">
          <Input value={text} onChange={(e) => setText(e.target.value)} />
        </Field>
      )}

      <div className="flex flex-wrap items-end gap-2">
        <Field label="Note" className="min-w-[12rem] flex-1">
          <Input value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        {spec.itemType === "pass_fail_na" ? (
          <Checkbox
            size="sm"
            className="pb-2"
            label="Not applicable"
            checked={na}
            onChange={(e) => setNa(e.target.checked)}
          />
        ) : null}
        <Button size="sm" variant="secondary" loading={busy === "save"} onClick={() => save()}>
          Save the answer
        </Button>
      </div>
    </div>
  );
}

/** Accepted answer tokens per boolean item type — the API's own vocabulary. */
const BOOLEAN_TOKENS: Record<string, string[] | undefined> = {
  pass_fail: ["pass", "fail"],
  pass_fail_na: ["pass", "fail", "na"],
  yes_no: ["yes", "no"],
};

function Verdict({
  judged,
  isPass,
  notApplicable,
  critical,
}: {
  judged: boolean;
  isPass: boolean | null;
  notApplicable: boolean;
  critical: boolean;
}) {
  if (notApplicable) {
    return (
      <Badge tone="neutral" size="sm" variant="outline">
        Not applicable
      </Badge>
    );
  }
  if (!judged || isPass === null) {
    return (
      <Badge tone="info" size="sm" variant="outline">
        Not judgeable
      </Badge>
    );
  }
  return (
    <Badge tone={isPass ? "success" : critical ? "danger" : "warning"} size="sm" variant="solid">
      {isPass ? "Pass" : critical ? "Critical failure" : "Fail"}
    </Badge>
  );
}

/* ================================================================== */
/* The tolerance band                                                  */
/* ================================================================== */

/**
 * Target, acceptance window and reading, drawn together.
 *
 * The bounds are resolved exactly as the API resolves them: a min/max pair and
 * a target ± tolerance BOTH bind when both are present, and the tighter wins.
 * Where no bound exists at all, no band is drawn and the reason is printed —
 * a reading cannot be judged against a target alone, and drawing a band around
 * one would imply an acceptance criterion nobody wrote down.
 */
function Measurement({
  spec,
  measured,
  isPass,
}: {
  spec: ItemSpec;
  measured: number | null;
  isPass: boolean | null;
}) {
  const { lower, upper, reasons } = toleranceBounds(spec);
  const unit = spec.unit ? ` ${spec.unit}` : "";

  const domain = useMemo(() => {
    const known = [lower, upper, spec.targetValue, measured].filter(
      (v): v is number => v !== null && Number.isFinite(v),
    );
    if (known.length === 0) return null;
    let lo = Math.min(...known);
    let hi = Math.max(...known);
    if (hi - lo < 1e-9) {
      const nudge = Math.max(Math.abs(hi) * 0.1, 1);
      lo -= nudge;
      hi += nudge;
    }
    const pad = (hi - lo) * 0.18;
    return { lo: lo - pad, hi: hi + pad };
  }, [lower, upper, spec.targetValue, measured]);

  const place = (value: number): number => {
    if (!domain) return 50;
    return Math.min(100, Math.max(0, ((value - domain.lo) / (domain.hi - domain.lo)) * 100));
  };

  const hasBand = lower !== null || upper !== null;
  const bandLeft = lower === null ? 0 : place(lower);
  const bandRight = upper === null ? 100 : place(upper);
  const markerTone: Tone = isPass === true ? "success" : isPass === false ? "danger" : "info";

  return (
    <div className="space-y-2">
      <dl className="flex flex-wrap gap-x-5 gap-y-1 text-2xs">
        <Pair
          label="Target"
          value={spec.targetValue === null ? "none set" : `${num(spec.targetValue, 3)}${unit}`}
        />
        <Pair
          label="Tolerance"
          value={
            spec.tolerancePlus === null && spec.toleranceMinus === null
              ? "none set"
              : `−${num(Math.abs(spec.toleranceMinus ?? 0), 3)} / +${num(Math.abs(spec.tolerancePlus ?? 0), 3)}${unit}`
          }
        />
        <Pair
          label="Accepted window"
          value={
            hasBand
              ? `${lower === null ? "no lower bound" : `${num(lower, 3)}`} … ${upper === null ? "no upper bound" : `${num(upper, 3)}`}${unit}`
              : "cannot be computed"
          }
        />
        <Pair
          label="Measured"
          value={measured === null ? "no reading recorded" : `${num(measured, 3)}${unit}`}
          strong
        />
      </dl>

      {hasBand && domain ? (
        <div className="pt-1">
          <div className="relative h-7">
            {/* the full domain */}
            <div className="absolute inset-x-0 top-2.5 h-2 rounded-full bg-surface-sunken ring-1 ring-inset ring-border" />
            {/* the accepted window */}
            <div
              className={cx("absolute top-2.5 h-2 rounded-full", toneClass("success", "bg"))}
              style={{ left: `${bandLeft}%`, width: `${Math.max(bandRight - bandLeft, 0.75)}%` }}
              aria-hidden
            />
            {/* the target */}
            {spec.targetValue !== null ? (
              <div
                className="absolute top-1 h-5 w-px bg-content-subtle"
                style={{ left: `${place(spec.targetValue)}%` }}
                aria-hidden
              />
            ) : null}
            {/* the reading */}
            {measured !== null ? (
              <div
                className={cx(
                  "absolute size-3.5 -translate-x-1/2 rotate-45 rounded-[2px] ring-2 ring-surface",
                  toneClass(markerTone, "solid"),
                )}
                /* centred on the 8px track, which sits at top:0.625rem */
                style={{ left: `${place(measured)}%`, top: "0.4375rem" }}
                aria-hidden
              />
            ) : null}
          </div>
          <div className="flex justify-between text-2xs text-content-subtle">
            <span className="tabular-nums">
              {lower === null ? "open below" : `${num(lower, 3)}${unit}`}
            </span>
            <span className="tabular-nums">
              {upper === null ? "open above" : `${num(upper, 3)}${unit}`}
            </span>
          </div>
          <p className="sr-only">
            {measured === null
              ? "No reading recorded."
              : `Measured ${measured}${unit} against an accepted window of ${lower ?? "open"} to ${upper ?? "open"}.`}
          </p>
        </div>
      ) : null}

      <ReasonList reasons={reasons} />
    </div>
  );
}

function Pair({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex gap-1.5">
      <dt className="text-content-subtle">{label}</dt>
      <dd className={cx("tabular-nums", strong ? "font-semibold text-content" : "text-content")}>
        {value}
      </dd>
    </div>
  );
}

function PlainAnswer({ response, spec }: { response: ChecklistResponse; spec: ItemSpec }) {
  const answered =
    (response.response !== null && response.response.trim() !== "") ||
    response.selectedOptions.length > 0 ||
    response.photoFileIds.length > 0 ||
    response.fileIds.length > 0 ||
    response.isNotApplicable === 1;

  if (!answered) {
    return (
      <p className="text-2xs italic text-content-subtle">
        {spec.required
          ? "Required item, unanswered. It is excluded from the score rather than counted as a pass."
          : "Unanswered."}
      </p>
    );
  }
  if (response.isNotApplicable === 1) {
    return (
      <p className="text-meta text-content-muted">
        Marked not applicable
        {response.naReason ? ` — ${response.naReason}` : " with no reason recorded."}
      </p>
    );
  }
  if (response.selectedOptions.length > 0) {
    return (
      <div className="flex flex-wrap gap-1.5">
        {spec.options.length > 0
          ? spec.options.map((option) => (
              <Badge
                key={option}
                tone={response.selectedOptions.includes(option) ? "accent" : "neutral"}
                size="xs"
                variant={response.selectedOptions.includes(option) ? "solid" : "outline"}
              >
                {option}
              </Badge>
            ))
          : response.selectedOptions.map((option) => (
              <Badge key={option} tone="accent" size="xs" variant="solid">
                {option}
              </Badge>
            ))}
      </div>
    );
  }
  if (spec.itemType === "date") {
    return <p className="text-meta tabular-nums">{isoDate(response.response)}</p>;
  }
  if (response.photoFileIds.length > 0 || response.fileIds.length > 0) {
    return (
      <p className="text-meta text-content-muted">
        {response.photoFileIds.length + response.fileIds.length}{" "}
        {plural(response.photoFileIds.length + response.fileIds.length, "file")} attached.
      </p>
    );
  }
  return <p className="whitespace-pre-wrap text-meta text-content">{response.response}</p>;
}
