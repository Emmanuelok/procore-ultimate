/**
 * ANSWERING AN INSPECTION.
 *
 * The template is the question list; this is the walk. Three rules shape it:
 *
 *  1. NOT APPLICABLE IS AN ANSWER, and it is a different one from pass. An N/A
 *     leaves both the numerator and the denominator, so a form half of whose
 *     items do not apply still scores honestly on the half that do. A platform
 *     that counted N/A as a pass would inflate every score on site.
 *  2. A CRITICAL ITEM FAILING FAILS THE WHOLE INSPECTION whatever the
 *     percentage says, so the form marks those items before they are answered
 *     rather than explaining afterwards.
 *  3. A PHOTO-REQUIRED ITEM NEEDS A PHOTOGRAPH. The API refuses a completion
 *     that answers one without an image — the photograph is what distinguishes
 *     an inspection carried out from one filled in — so the form uploads it
 *     here rather than letting the walk be rejected at the end.
 *
 * Photographs go through the project photo register, which is where a site's
 * images already live; the inspection stores the file ids the register returns.
 */
import { useMemo, useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  Checkbox,
  Field,
  Input,
  Select,
  Textarea,
  cx,
} from "../../ui";
import { api } from "../../lib/api";
import {
  HIERARCHY_LABEL,
  HIERARCHY_ORDER,
  ReasonList,
  SectionHeading,
  count,
  errorMessage,
  labelize,
  type InspectionDetail,
  type TemplateItemSpec,
} from "./safetyShared";

interface Draft {
  isPass: boolean | null | undefined;
  response: string;
  note: string;
  photoFileIds: string[];
}

const NON_VERDICT_TYPES = new Set([
  "text",
  "long_text",
  "number",
  "date",
  "photo",
  "file_upload",
  "signature",
  "single_select",
  "multi_select",
]);

const blank = (): Draft => ({ isPass: undefined, response: "", note: "", photoFileIds: [] });

export default function InspectionAnswerForm({
  projectId,
  inspection,
  users,
  onCompleted,
}: {
  projectId: string;
  inspection: InspectionDetail;
  users: Map<string, string>;
  onCompleted: () => void;
}) {
  const items = useMemo<TemplateItemSpec[]>(
    () =>
      [...(inspection.template?.items ?? [])].sort(
        (a, b) => (a.position ?? 0) - (b.position ?? 0),
      ),
    [inspection.template],
  );

  const [answers, setAnswers] = useState<Record<string, Draft>>({});
  const [raiseActions, setRaiseActions] = useState(true);
  const [defectOwnerId, setDefectOwnerId] = useState("");
  const [defectHierarchy, setDefectHierarchy] = useState("engineering");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState<string | null>(null);

  const draft = (id: string): Draft => answers[id] ?? blank();
  const set = (id: string, patch: Partial<Draft>) =>
    setAnswers((prev) => ({ ...prev, [id]: { ...(prev[id] ?? blank()), ...patch } }));

  async function attach(item: TemplateItemSpec, files: FileList | null) {
    if (!files || files.length === 0) return;
    setUploading(item.id);
    setError(null);
    try {
      const ids: string[] = [];
      for (const file of Array.from(files)) {
        const form = new FormData();
        form.append("file", file);
        const created = await api.upload<{ file: { id: string } }>(
          `/api/v1/projects/${projectId}/photos`,
          form,
        );
        ids.push(created.file.id);
      }
      set(item.id, { photoFileIds: [...draft(item.id).photoFileIds, ...ids] });
    } catch (err) {
      setError(errorMessage(err, "That photograph could not be uploaded"));
    } finally {
      setUploading(null);
    }
  }

  /* What the API will refuse, said here instead of after the click. */
  const unanswered = items.filter((item) => {
    if (item.required !== true || item.itemType === "section_header") return false;
    const d = draft(item.id);
    return d.isPass === undefined && d.response.trim() === "";
  });
  const missingPhotos = items.filter((item) => {
    if (item.photoRequired !== true) return false;
    const d = draft(item.id);
    const answered = d.isPass !== undefined || d.response.trim() !== "";
    return answered && d.photoFileIds.length === 0;
  });
  const failures = items.filter((item) => draft(item.id).isPass === false);
  const criticalFailures = failures.filter((item) => item.isCritical === true);

  async function complete() {
    setBusy(true);
    setError(null);
    try {
      const responses = items
        .filter((item) => item.itemType !== "section_header")
        .map((item) => {
          const d = draft(item.id);
          const answered = d.isPass !== undefined || d.response.trim() !== "";
          if (!answered) return null;
          return {
            itemId: item.id,
            ...(d.isPass !== undefined ? { isPass: d.isPass } : {}),
            ...(d.response.trim() ? { response: d.response.trim() } : {}),
            ...(d.note.trim() ? { note: d.note.trim() } : {}),
            ...(d.photoFileIds.length > 0 ? { photoFileIds: d.photoFileIds } : {}),
          };
        })
        .filter((r): r is NonNullable<typeof r> => r !== null);
      await api.post(
        `/api/v1/projects/${projectId}/safety/inspections/${inspection.id}/complete`,
        {
          responses,
          raiseActions,
          ...(defectOwnerId ? { defectActionOwnerId: defectOwnerId } : {}),
          defectHierarchyOfControl: defectHierarchy,
        },
      );
      onCompleted();
    } catch (err) {
      setError(errorMessage(err, "This inspection could not be completed"));
    } finally {
      setBusy(false);
    }
  }

  if (!inspection.template) {
    return (
      <Alert tone="warning" title="This inspection has no template">
        It cannot be scored, and its answers cannot even be checked against a question list. Attach a
        template before performing it — a free-form walk recorded as a percentage is a number nobody
        can defend.
      </Alert>
    );
  }

  return (
    <section className="space-y-3">
      <SectionHeading
        title="Perform the inspection"
        hint={`${inspection.template.name} · v${inspection.template.version}. The version is stamped when you complete it, so a later revision cannot rewrite what was asked today.`}
      />

      {error ? (
        <Alert tone="danger" title="That could not be saved" onDismiss={() => setError(null)}>
          {error}
        </Alert>
      ) : null}

      <ul className="space-y-1.5">
        {items.map((item) => {
          if (item.itemType === "section_header") {
            return (
              <li key={item.id} className="pt-2 text-label uppercase text-content-subtle">
                {item.text}
              </li>
            );
          }
          const d = draft(item.id);
          const verdictItem = !NON_VERDICT_TYPES.has(item.itemType);
          const failed = d.isPass === false;
          const photoMissing =
            item.photoRequired === true &&
            (d.isPass !== undefined || d.response.trim() !== "") &&
            d.photoFileIds.length === 0;
          return (
            <li
              key={item.id}
              className={cx(
                "rounded-md border px-2.5 py-2",
                failed && item.isCritical
                  ? "border-danger-border bg-danger-subtle/50"
                  : failed
                    ? "border-warning-border bg-warning-subtle/40"
                    : photoMissing
                      ? "border-warning-border bg-surface-raised"
                      : "border-border bg-surface-raised",
              )}
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <span className="min-w-0 text-meta text-content">
                  {item.text}
                  {item.required ? <span className="text-danger-fg"> *</span> : null}
                  {item.section ? (
                    <span className="block text-2xs text-content-subtle">{item.section}</span>
                  ) : null}
                  {item.guidance ? (
                    <span className="block text-2xs text-content-muted">{item.guidance}</span>
                  ) : null}
                </span>
                <span className="flex shrink-0 flex-wrap items-center gap-1.5">
                  {item.isCritical ? (
                    <Badge tone="danger" size="xs" variant="outline">
                      Critical
                    </Badge>
                  ) : null}
                  {item.photoRequired ? (
                    <Badge tone={photoMissing ? "warning" : "neutral"} size="xs" variant="outline">
                      Photo required
                    </Badge>
                  ) : null}
                </span>
              </div>

              {verdictItem ? (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <Button
                    size="xs"
                    variant={d.isPass === true ? "primary" : "outline"}
                    onClick={() => set(item.id, { isPass: d.isPass === true ? undefined : true })}
                  >
                    Pass
                  </Button>
                  <Button
                    size="xs"
                    variant={d.isPass === false ? "danger" : "outline"}
                    onClick={() => set(item.id, { isPass: d.isPass === false ? undefined : false })}
                  >
                    Fail
                  </Button>
                  <Button
                    size="xs"
                    variant={d.isPass === null ? "secondary" : "outline"}
                    onClick={() => set(item.id, { isPass: d.isPass === null ? undefined : null })}
                  >
                    Not applicable
                  </Button>
                </div>
              ) : (
                <div className="mt-2">
                  <Input
                    value={d.response}
                    type={item.itemType === "number" ? "number" : item.itemType === "date" ? "date" : "text"}
                    placeholder="Answer"
                    onChange={(e) => set(item.id, { response: e.target.value })}
                  />
                </div>
              )}

              <div className="mt-2 grid gap-2 sm:grid-cols-[1fr_auto]">
                <Textarea
                  rows={failed ? 2 : 1}
                  value={d.note}
                  placeholder={failed ? "What is wrong, and where exactly" : "Note (optional)"}
                  onChange={(e) => set(item.id, { note: e.target.value })}
                />
                <div className="flex items-start gap-2">
                  <label className="cursor-pointer text-2xs text-accent">
                    <input
                      type="file"
                      accept="image/*"
                      multiple
                      className="hidden"
                      onChange={(e) => void attach(item, e.target.files)}
                    />
                    {uploading === item.id ? "Uploading…" : "Attach photo"}
                  </label>
                  {d.photoFileIds.length > 0 ? (
                    <Badge tone="success" size="xs">
                      {count(d.photoFileIds.length)} attached
                    </Badge>
                  ) : null}
                </div>
              </div>
            </li>
          );
        })}
      </ul>

      <Card variant="sunken">
        <CardBody className="space-y-3">
          {criticalFailures.length > 0 ? (
            <Alert
              tone="danger"
              size="sm"
              title={`${count(criticalFailures.length)} critical item${criticalFailures.length === 1 ? "" : "s"} failed`}
            >
              This inspection will be recorded as a FAIL whatever the percentage comes out at. That
              is what marking an item critical means.
            </Alert>
          ) : null}

          {unanswered.length > 0 || missingPhotos.length > 0 ? (
            <ReasonList
              reasons={[
                ...(unanswered.length > 0
                  ? [
                      `${unanswered.length} required item(s) are unanswered: ${unanswered
                        .map((i) => i.text)
                        .slice(0, 3)
                        .join("; ")}${unanswered.length > 3 ? "…" : ""}. Scoring a shorter question list than the form asks would report a percentage over the wrong denominator.`,
                    ]
                  : []),
                ...(missingPhotos.length > 0
                  ? [
                      `${missingPhotos.length} photo-required item(s) have been answered with no photograph: ${missingPhotos
                        .map((i) => i.text)
                        .slice(0, 3)
                        .join("; ")}. The photograph is the evidence the inspector was at the thing they signed off.`,
                    ]
                  : []),
              ]}
            />
          ) : null}

          <div className="grid gap-3 sm:grid-cols-3">
            <div className="flex items-end pb-2">
              <Checkbox
                checked={raiseActions}
                onChange={(e) => setRaiseActions(e.target.checked)}
                label="Raise a corrective action per defect"
                description="Critical defects are dated today."
              />
            </div>
            <Field label="Defect actions owned by">
              <Select value={defectOwnerId} onChange={(e) => setDefectOwnerId(e.target.value)}>
                <option value="">The inspector</option>
                {[...users.entries()].map(([id, name]) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field
              label="Control level"
              hint="The level of the hierarchy the fix sits at. Administrative and PPE are the weakest and depend on somebody behaving correctly every time."
            >
              <Select value={defectHierarchy} onChange={(e) => setDefectHierarchy(e.target.value)}>
                {HIERARCHY_ORDER.map((h) => (
                  <option key={h} value={h}>
                    {HIERARCHY_LABEL[h]}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              disabled={unanswered.length > 0 || missingPhotos.length > 0}
              loading={busy}
              onClick={() => void complete()}
            >
              Complete the inspection
            </Button>
            <span className="text-2xs text-content-subtle">
              {count(failures.length)} defect{failures.length === 1 ? "" : "s"} recorded ·{" "}
              {labelize(inspection.template.scoringMethod)} scoring
            </span>
          </div>
        </CardBody>
      </Card>
    </section>
  );
}
