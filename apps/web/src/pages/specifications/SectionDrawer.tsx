/**
 * ONE SECTION, in a drawer over whichever tab you were on.
 *
 *   Revisions   every issue of this section's text, newest first, with
 *               supersession stated in BOTH directions and an unchanged
 *               reissue shown as the non-event it is.
 *   Requirements what the section demands be submitted, each stamped with how
 *               it was found and whether a person has agreed with it.
 *   References  what this section points at — and, in red, what it conflicts
 *               with, because a clause contradicting a drawing is where a
 *               change order comes from.
 *
 * The revision list is the answer to the only question that matters in a
 * dispute: "what did the spec say on the day this work was priced". That is
 * answered by reading a superseded row, so superseded rows are dimmed but
 * never hidden.
 */
import { useMemo, useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  DescriptionList,
  Drawer,
  EmptyState,
  Field,
  Input,
  Modal,
  Select,
  Skeleton,
  Tabs,
  Textarea,
  Timeline,
  Tooltip,
  useConfirm,
  type DescriptionItem,
  type TimelineItem,
} from "../../ui";
import { IconLink, IconPlus, IconSpec } from "../../ui/icons";
import { api } from "../../lib/api";
import RequirementCard from "./RequirementCard";
import {
  EM_DASH,
  REFERENCE_KINDS,
  REFERENCE_KIND_TONE,
  REFERENCE_TARGETS,
  SECTION_STATUS_TONE,
  count,
  dateTime,
  isoDate,
  shortHash,
  titleCase,
  useAction,
  useSpecSection,
  type SpecRequirement,
  type SpecRevision,
} from "./specShared";

type Panel = "revisions" | "requirements" | "references";

export default function SectionDrawer({
  projectId,
  sectionId,
  version,
  onClose,
  onMutated,
}: {
  projectId: string;
  sectionId: string | null;
  version: number;
  onClose: () => void;
  onMutated: () => void;
}) {
  const [panel, setPanel] = useState<Panel>("revisions");
  const [refOpen, setRefOpen] = useState(false);
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [withdrawReason, setWithdrawReason] = useState("");
  const detail = useSpecSection(projectId, sectionId, version);
  const { busy, refusal, clear, run } = useAction();
  const { confirm, dialog } = useConfirm();

  const section = detail.data;

  function reload() {
    detail.reload();
    onMutated();
  }

  async function acceptRevision(revision: SpecRevision) {
    const ok = await confirm({
      title: `Accept revision ${revision.revision}?`,
      description:
        "Accepting a reissue is an independent act: the person who loaded the text may not be the person who agrees the project is now building to it. If you loaded it, the platform will refuse and tell you so.",
      confirmLabel: "Accept this revision",
      tone: "warning",
    });
    if (!ok) return;
    const done = await run(`accept:${revision.id}`, () =>
      api.post(`/api/v1/projects/${projectId}/spec-revisions/${revision.id}/accept`, {}),
    );
    if (done !== null) reload();
  }

  /**
   * A section that is not in the current issue has not been "deleted": it has
   * been WITHDRAWN, by a person, for a stated reason. Coverage stops counting
   * it, the record keeps it, and any requirement still open on it is reported
   * rather than swept away.
   */
  async function withdraw() {
    if (!sectionId || withdrawReason.trim().length === 0) return;
    const done = await run("withdraw", () =>
      api.post<{ note?: string }>(
        `/api/v1/projects/${projectId}/spec-sections/${sectionId}/withdraw`,
        { reason: withdrawReason.trim() },
      ),
    );
    if (done !== null) {
      setWithdrawOpen(false);
      setWithdrawReason("");
      reload();
    }
  }

  async function reinstate() {
    const ok = await confirm({
      title: "Put this section back in force?",
      description:
        "Reinstating says the section is part of the current issue after all. Coverage counts it again from now on; the withdrawal and its reason stay on the ledger.",
      confirmLabel: "Reinstate",
    });
    if (!ok || !sectionId) return;
    const done = await run("reinstate", () =>
      api.post(`/api/v1/projects/${projectId}/spec-sections/${sectionId}/reinstate`, {}),
    );
    if (done !== null) reload();
  }

  async function extract() {
    const ok = await confirm({
      title: "Re-read this section's requirements?",
      description:
        "The extractor reads Part 1.3 of the current revision and proposes the submittals it demands. Everything it finds lands as IDENTIFIED — unconfirmed, unregistrable — and rows that are already held are skipped rather than duplicated. It confirms nothing.",
      confirmLabel: "Run the extractor",
    });
    if (!ok || !sectionId) return;
    const done = await run("extract", () =>
      api.post(
        `/api/v1/projects/${projectId}/spec-sections/${sectionId}/extract-requirements`,
        {},
      ),
    );
    if (done !== null) reload();
  }

  const conflicts = (section?.references ?? []).filter(
    (r) => r.referenceKind === "conflicts_with" && r.resolvedAt === null,
  );

  const tabs = useMemo(
    () => [
      {
        value: "revisions" as const,
        label: "Revisions",
        count: section?.revisions.length,
      },
      {
        value: "requirements" as const,
        label: "Requirements",
        count: section?.requirements.length,
        tone: section?.requirements.some((r) => r.status === "identified")
          ? ("warning" as const)
          : undefined,
      },
      {
        value: "references" as const,
        label: "References",
        count: section?.references.length,
        tone: conflicts.length > 0 ? ("danger" as const) : undefined,
      },
    ],
    [section, conflicts.length],
  );

  return (
    <Drawer
      open={sectionId !== null}
      onClose={onClose}
      size="xl"
      title={
        section ? (
          <span className="flex items-center gap-2">
            <span className="font-mono">{section.code}</span>
            <span className="truncate">{section.title}</span>
          </span>
        ) : (
          "Specification section"
        )
      }
      description={
        section
          ? `${section.division ? `${section.division.code} ${section.division.title}` : "No division"} · ${count(section.revisionCount)} revision${section.revisionCount === 1 ? "" : "s"}`
          : undefined
      }
      headerActions={
        section ? (
          <span className="flex items-center gap-2">
            <Badge tone={SECTION_STATUS_TONE[section.status] ?? "neutral"} dot>
              {titleCase(section.status)}
            </Badge>
            {section.status === "withdrawn" ? (
              <Button size="xs" variant="ghost" loading={busy === "reinstate"} onClick={() => void reinstate()}>
                Reinstate
              </Button>
            ) : (
              <Button
                size="xs"
                variant="ghost"
                onClick={() => {
                  setWithdrawReason("");
                  setWithdrawOpen(true);
                }}
              >
                Withdraw
              </Button>
            )}
          </span>
        ) : null
      }
    >
      {dialog}
      {detail.loading && !section ? (
        <div className="space-y-3 py-4">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-8 w-1/2" />
          <Skeleton className="h-40 w-full" />
        </div>
      ) : detail.error ? (
        <Alert tone="danger" title="This section could not be loaded">
          {detail.error}
        </Alert>
      ) : section ? (
        <div className="space-y-4">
          {refusal ? (
            <Alert
              tone={refusal.status === 403 ? "warning" : "danger"}
              title={
                refusal.status === 403
                  ? "Segregation of duties — this control did its job"
                  : "The server refused this"
              }
              onDismiss={clear}
            >
              <p className="whitespace-pre-wrap">{refusal.message}</p>
            </Alert>
          ) : null}

          {conflicts.length > 0 ? (
            <Alert
              tone="danger"
              title={`${count(conflicts.length)} unresolved conflict${conflicts.length === 1 ? "" : "s"} against this section`}
            >
              A <code className="font-mono">conflicts_with</code> reference says the contract
              documents disagree at a named paragraph. That is a change-order origin, not a tidy-up
              item — settle it with the RFI answer or addendum that decided it.
            </Alert>
          ) : null}

          <Card>
            <CardBody>
              <DescriptionList columns={3} size="sm" items={overviewItems(section)} />
            </CardBody>
          </Card>

          <Tabs items={tabs} value={panel} onChange={setPanel} size="sm" />

          {panel === "revisions" ? (
            <RevisionsPanel
              revisions={section.revisions}
              currentRevisionId={section.currentRevisionId}
              busy={busy}
              onAccept={(rev) => void acceptRevision(rev)}
            />
          ) : panel === "requirements" ? (
            <RequirementsPanel
              projectId={projectId}
              requirements={section.requirements}
              busy={busy}
              onExtract={() => void extract()}
              onMutated={reload}
            />
          ) : (
            <ReferencesPanel
              projectId={projectId}
              sectionId={section.id}
              references={section.references}
              onAdd={() => setRefOpen(true)}
              onMutated={reload}
            />
          )}

          {section.status === "withdrawn" && section.withdrawnReason ? (
            <Alert tone="warning" variant="subtle" size="sm" title="This section is withdrawn">
              <p className="whitespace-pre-wrap">{section.withdrawnReason}</p>
              <p className="mt-1 text-2xs text-content-muted">
                Withdrawn {isoDate(section.withdrawnAt ?? null)}. Coverage no longer counts it; the
                text and every requirement ever read from it stay on the record.
              </p>
            </Alert>
          ) : null}

          <Modal
            open={withdrawOpen}
            onClose={() => setWithdrawOpen(false)}
            title={`Withdraw section ${section.code}?`}
            description="Use this when the section is absent from the current issue. Coverage stops counting it, so the register is not measured against a section the project no longer builds to."
            size="md"
            footer={
              <>
                <Button variant="ghost" size="sm" onClick={() => setWithdrawOpen(false)}>
                  Cancel
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  loading={busy === "withdraw"}
                  disabled={withdrawReason.trim().length === 0}
                  onClick={() => void withdraw()}
                >
                  Withdraw the section
                </Button>
              </>
            }
          >
            <Field
              label="Why is it withdrawn?"
              required
              hint="Name the issue it is absent from. A withdrawal with no reason is indistinguishable from a mistake."
            >
              <Textarea
                value={withdrawReason}
                onChange={(e) => setWithdrawReason(e.target.value)}
                rows={3}
                maxLength={2000}
                placeholder="Not present in Issue C (2026-03-14); the work moved into 03 35 00."
              />
            </Field>
          </Modal>

          <AddReferenceModal
            open={refOpen}
            projectId={projectId}
            sectionId={section.id}
            onClose={() => setRefOpen(false)}
            onCreated={() => {
              setRefOpen(false);
              reload();
            }}
          />
        </div>
      ) : null}
    </Drawer>
  );
}

function overviewItems(section: {
  code: string;
  normalisedCode: string;
  status: string;
  tradeCode: string | null;
  currentRevisionId: string | null;
  currentRevision: SpecRevision | null;
  submittalRequirementCount: number;
  requirementsConfirmed: number;
  updatedAt: string;
}): DescriptionItem[] {
  return [
    { id: "code", label: "Section code", value: section.code, copyValue: section.code },
    {
      id: "normalised",
      label: "Normalised",
      value: <span className="font-mono text-2xs">{section.normalisedCode}</span>,
      hint: "Separators stripped, so 03 30 00 and 033000 match.",
    },
    { id: "trade", label: "Trade / discipline", value: section.tradeCode ?? EM_DASH },
    {
      id: "inforce",
      label: "Text in force",
      value: section.currentRevision ? `Revision ${section.currentRevision.revision}` : EM_DASH,
      hint: section.currentRevision
        ? `Issued ${isoDate(section.currentRevision.issuedDate)}${
            section.currentRevision.pageStart !== null
              ? ` · pages ${section.currentRevision.pageStart}–${section.currentRevision.pageEnd ?? section.currentRevision.pageStart} of the book`
              : ""
          }`
        : "No revision has ever been loaded for this section.",
    },
    {
      id: "reqs",
      label: "Requirements read",
      value: count(section.submittalRequirementCount),
      hint:
        section.submittalRequirementCount === 0
          ? "Nothing has been read or typed for this section."
          : section.requirementsConfirmed === 1
            ? "At least one has been confirmed by a person."
            : "None has been confirmed by a person yet.",
    },
    { id: "updated", label: "Last updated", value: dateTime(section.updatedAt) },
  ];
}

/* ================================================================== */
/* Revisions                                                           */
/* ================================================================== */

function RevisionsPanel({
  revisions,
  currentRevisionId,
  busy,
  onAccept,
}: {
  revisions: SpecRevision[];
  currentRevisionId: string | null;
  busy: string | null;
  onAccept: (revision: SpecRevision) => void;
}) {
  const items = useMemo<TimelineItem[]>(
    () =>
      revisions.map((r) => {
        const inForce = r.id === currentRevisionId;
        return {
          id: r.id,
          title: (
            <span className="flex flex-wrap items-center gap-2">
              <span className="font-semibold">Revision {r.revision}</span>
              {inForce ? (
                <Badge tone="success" size="xs" variant="solid">
                  In force
                </Badge>
              ) : null}
              {r.isSuperseded === 1 ? (
                <Badge tone="neutral" size="xs">
                  Superseded
                </Badge>
              ) : null}
              {r.acceptedAt ? (
                <Badge tone="success" size="xs">
                  Accepted {isoDate(r.acceptedAt)}
                </Badge>
              ) : (
                <Badge tone="warning" size="xs">
                  Not accepted
                </Badge>
              )}
            </span>
          ),
          timestamp: r.issuedDate ?? r.createdAt,
          tone: inForce ? "success" : r.isSuperseded === 1 ? "neutral" : "info",
          muted: r.isSuperseded === 1,
          body: (
            <div className="space-y-1.5">
              {r.changeSummary ? (
                <p className="text-meta text-content-muted">{r.changeSummary}</p>
              ) : null}
              <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5 text-2xs">
                <dt className="text-content-subtle">Issued by</dt>
                <dd className="text-content">{r.issuedBy ?? EM_DASH}</dd>
                <dt className="text-content-subtle">Effective from</dt>
                <dd className="text-content">{isoDate(r.effectiveFrom)}</dd>
                <dt className="text-content-subtle">Pages in the book</dt>
                <dd className="text-content">
                  {r.pageStart === null
                    ? EM_DASH
                    : `${r.pageStart}–${r.pageEnd ?? r.pageStart}`}
                </dd>
                <dt className="text-content-subtle">Content hash</dt>
                <dd className="font-mono text-content">
                  <Tooltip
                    content={
                      r.contentSha256 ??
                      "No text hash is held for this revision, so an identical reissue could not be detected."
                    }
                  >
                    <span>{shortHash(r.contentSha256)}</span>
                  </Tooltip>
                </dd>
              </dl>
              {r.supersedesRevisionId || r.supersededByRevisionId ? (
                <p className="text-2xs text-content-subtle">
                  {r.supersedesRevisionId ? "Supersedes an earlier revision. " : ""}
                  {r.supersededByRevisionId
                    ? `Superseded by a later revision${r.supersededAt ? ` on ${isoDate(r.supersededAt)}` : ""}. It stays readable — a submittal approved against this text was approved against this text.`
                    : ""}
                </p>
              ) : null}
              {Array.isArray(r.changedClauses) && r.changedClauses.length > 0 ? (
                <p className="text-2xs text-content-muted">
                  {count(r.changedClauses.length)} clause
                  {r.changedClauses.length === 1 ? "" : "s"} differ from the previous revision.
                </p>
              ) : null}
            </div>
          ),
          actions: r.acceptedAt ? undefined : (
            <Button
              size="xs"
              variant="secondary"
              disabled={busy !== null}
              onClick={() => onAccept(r)}
            >
              Accept
            </Button>
          ),
        };
      }),
    [revisions, currentRevisionId, busy, onAccept],
  );

  if (revisions.length === 0) {
    return (
      <EmptyState
        icon={IconSpec}
        title="No revision has ever been loaded for this section"
        hint="The section row exists but no text has been attributed to an issue. Upload the book that contains it, or add the text by hand with the issue it came from — a revision with no issue behind it cannot be traced."
      />
    );
  }

  return (
    <Card>
      <CardBody>
        <Timeline items={items} timeFormat="absolute" aria-label="Section revisions" />
        <p className="mt-3 text-2xs text-content-subtle">
          Superseded revisions are dimmed, never removed. The question a dispute asks is what the
          spec said on the day the work was priced, and that is answered by reading the superseded
          row itself.
        </p>
      </CardBody>
    </Card>
  );
}

/* ================================================================== */
/* Requirements                                                        */
/* ================================================================== */

function RequirementsPanel({
  projectId,
  requirements,
  busy,
  onExtract,
  onMutated,
}: {
  projectId: string;
  requirements: SpecRequirement[];
  busy: string | null;
  onExtract: () => void;
  onMutated: () => void;
}) {
  const machine = requirements.filter((r) => r.extractionMethod !== "manual").length;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-meta text-content-muted">
          {count(requirements.length)} requirement{requirements.length === 1 ? "" : "s"} —{" "}
          {count(requirements.filter((r) => r.status === "identified").length)} awaiting
          confirmation, {count(machine)} read by a machine.
        </p>
        <Button size="xs" variant="secondary" disabled={busy !== null} onClick={onExtract}>
          Re-read the current revision
        </Button>
      </div>

      {requirements.length === 0 ? (
        <EmptyState
          icon={IconSpec}
          size="sm"
          title="No submittal requirement has been read out of this section"
          hint="Part 1.3 of a section lists what must be submitted. Nothing has been extracted or typed here, so no submittal on this project can cite this section as its basis. Run the extractor over the current revision, or add a requirement by hand."
        />
      ) : (
        <div className="space-y-2">
          {requirements.map((requirement) => (
            <RequirementCard
              key={requirement.id}
              projectId={projectId}
              requirement={requirement}
              onMutated={onMutated}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/* ================================================================== */
/* References                                                          */
/* ================================================================== */

function ReferencesPanel({
  projectId,
  sectionId,
  references,
  onAdd,
  onMutated,
}: {
  projectId: string;
  sectionId: string;
  references: Array<{
    id: string;
    paragraphRef: string | null;
    targetType: string;
    targetId: string;
    targetLabel: string | null;
    referenceKind: string;
    note: string | null;
    resolvedAt: string | null;
    resolutionNote: string | null;
    createdAt: string;
  }>;
  onAdd: () => void;
  onMutated: () => void;
}) {
  const { busy, run } = useAction();
  const [resolving, setResolving] = useState<string | null>(null);
  const [note, setNote] = useState("");

  async function resolve(referenceId: string) {
    if (!note.trim()) return;
    const done = await run(`resolve:${referenceId}`, () =>
      api.post(`/api/v1/projects/${projectId}/spec-references/${referenceId}/resolve`, {
        resolutionNote: note.trim(),
      }),
    );
    if (done !== null) {
      setResolving(null);
      setNote("");
      onMutated();
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-meta text-content-muted">
          {count(references.length)} cross-reference{references.length === 1 ? "" : "s"} anchored at
          a paragraph of this section.
        </p>
        <Button size="xs" variant="secondary" icon={IconPlus} onClick={onAdd}>
          Record a reference
        </Button>
      </div>

      {references.length === 0 ? (
        <EmptyState
          icon={IconLink}
          size="sm"
          title="Nothing is cross-referenced from this section"
          hint="A spec cross-reference is anchored at a paragraph and asserts a kind — detailed on this sheet, clarified by that RFI, or conflicts with a drawing. None has been recorded here, which is a statement about the record, not about the documents."
        />
      ) : (
        <ul className="space-y-2">
          {references.map((r) => {
            const unresolvedConflict = r.referenceKind === "conflicts_with" && !r.resolvedAt;
            return (
              <li
                key={r.id}
                className={
                  unresolvedConflict
                    ? "rounded-lg border border-danger-border bg-danger-subtle p-3"
                    : "rounded-lg border border-border bg-surface-raised p-3"
                }
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={REFERENCE_KIND_TONE[r.referenceKind] ?? "neutral"} size="xs">
                    {titleCase(r.referenceKind)}
                  </Badge>
                  <span className="font-mono text-2xs text-content-subtle">
                    {r.paragraphRef ?? "no paragraph"}
                  </span>
                  <span className="text-meta text-content">
                    → {titleCase(r.targetType)}: {r.targetLabel ?? r.targetId}
                  </span>
                  {r.resolvedAt ? (
                    <Badge tone="success" size="xs">
                      Resolved {isoDate(r.resolvedAt)}
                    </Badge>
                  ) : null}
                </div>
                {r.note ? <p className="mt-1 text-meta text-content-muted">{r.note}</p> : null}
                {r.resolutionNote ? (
                  <p className="mt-1 text-meta text-content-muted">
                    <span className="font-medium text-content">Settled:</span> {r.resolutionNote}
                  </p>
                ) : null}
                {unresolvedConflict ? (
                  resolving === r.id ? (
                    <div className="mt-2 space-y-2">
                      <Field
                        label="What settled it?"
                        required
                        hint="The RFI answer, the addendum, or the decision that resolved the disagreement. This travels with the record."
                      >
                        <Textarea
                          rows={2}
                          value={note}
                          onChange={(e) => setNote(e.target.value)}
                          autoFocus
                        />
                      </Field>
                      <div className="flex gap-2">
                        <Button
                          size="xs"
                          disabled={note.trim().length === 0 || busy !== null}
                          onClick={() => void resolve(r.id)}
                        >
                          Record the resolution
                        </Button>
                        <Button
                          size="xs"
                          variant="ghost"
                          onClick={() => {
                            setResolving(null);
                            setNote("");
                          }}
                        >
                          Cancel
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <Button
                      size="xs"
                      variant="secondary"
                      className="mt-2"
                      onClick={() => {
                        setResolving(r.id);
                        setNote("");
                      }}
                    >
                      Resolve this conflict
                    </Button>
                  )
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      <p className="text-2xs text-content-subtle">
        Section id <span className="font-mono">{sectionId}</span>. A reference to a spec section,
        drawing sheet, RFI or submittal is verified against the project before it is stored; other
        target types keep the label you supply and are marked as unverified.
      </p>
    </div>
  );
}

function AddReferenceModal({
  open,
  projectId,
  sectionId,
  onClose,
  onCreated,
}: {
  open: boolean;
  projectId: string;
  sectionId: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const { busy, refusal, clear, run } = useAction();
  const [kind, setKind] = useState<string>("conflicts_with");
  const [targetType, setTargetType] = useState<string>("drawing_sheet");
  const [targetId, setTargetId] = useState("");
  const [targetLabel, setTargetLabel] = useState("");
  const [paragraphRef, setParagraphRef] = useState("");
  const [note, setNote] = useState("");

  async function submit() {
    const done = await run("create", () =>
      api.post(`/api/v1/projects/${projectId}/spec-sections/${sectionId}/references`, {
        targetType,
        targetId: targetId.trim(),
        targetLabel: targetLabel.trim() || null,
        referenceKind: kind,
        paragraphRef: paragraphRef.trim() || null,
        note: note.trim() || null,
      }),
    );
    if (done !== null) {
      setTargetId("");
      setTargetLabel("");
      setParagraphRef("");
      setNote("");
      onCreated();
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Record a cross-reference"
      size="lg"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={targetId.trim().length === 0 || busy !== null}
            loading={busy === "create"}
          >
            Record it
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        {refusal ? (
          <Alert tone="danger" title="The reference was refused" onDismiss={clear}>
            <p className="whitespace-pre-wrap">{refusal.message}</p>
          </Alert>
        ) : null}
        {kind === "conflicts_with" ? (
          <Alert tone="warning" variant="subtle" size="sm" title="This is a change-order origin">
            A conflict says the contract documents disagree at a named paragraph, on a named target,
            from a named date. It is recorded so the disagreement is provable later — record it even
            if you expect it to be resolved next week.
          </Alert>
        ) : null}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="What does this reference assert?">
            <Select value={kind} onChange={(e) => setKind(e.target.value)}>
              {REFERENCE_KINDS.map((k) => (
                <option key={k} value={k}>
                  {titleCase(k)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Target type">
            <Select value={targetType} onChange={(e) => setTargetType(e.target.value)}>
              {REFERENCE_TARGETS.map((t) => (
                <option key={t} value={t}>
                  {titleCase(t)}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label="Target id"
            required
            hint="Verified against this project for sections, sheets, RFIs and submittals."
          >
            <Input value={targetId} onChange={(e) => setTargetId(e.target.value)} />
          </Field>
          <Field label="Target label" hint="Used only when the target type cannot be verified.">
            <Input value={targetLabel} onChange={(e) => setTargetLabel(e.target.value)} />
          </Field>
          <Field label="Paragraph" hint="Where in the section it sits, e.g. 2.3.C.4.">
            <Input
              value={paragraphRef}
              placeholder="2.3.C.4"
              onChange={(e) => setParagraphRef(e.target.value)}
            />
          </Field>
        </div>
        <Field label="Note">
          <Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}
