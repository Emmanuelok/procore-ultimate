/**
 * Create / edit modal for a risk (spec Domain H #447-451): qualitative 1-5
 * pre/post scoring, the quantitative QCRA section (occurrence probability
 * slider + cost-impact distribution editor) and the QSRA schedule-task link
 * with a duration distribution. Distribution editing mirrors the API's
 * validation inline so a submit never bounces on shape errors.
 */
import { useEffect, useState, type FormEvent } from "react";
import { RISK_CATEGORIES } from "@constructos/shared";
import { api, ApiClientError } from "../../lib/api";
import { Button, ErrorAlert, Field, Input, Modal, Select, Textarea } from "../../ui";
import { humanize } from "../format";
import {
  DIST_KINDS,
  distProblem,
  type Dist,
  type DistKind,
  type RiskRow,
  type TaskOption,
  type UserLite,
} from "./riskShared";

/* --------------------------- distribution editor --------------------------- */

const num = (s: string): number => (s.trim() === "" ? Number.NaN : Number(s));

interface DistDraft {
  kind: DistKind | "";
  a: string;
  b: string;
  c: string;
  pairs: string;
}

function draftFrom(d: Dist | null): DistDraft {
  if (!d || typeof d !== "object" || !("kind" in d)) {
    return { kind: "", a: "", b: "", c: "", pairs: "" };
  }
  switch (d.kind) {
    case "triangular":
    case "pert":
      return { kind: d.kind, a: String(d.min), b: String(d.mode), c: String(d.max), pairs: "" };
    case "uniform":
      return { kind: d.kind, a: String(d.min), b: "", c: String(d.max), pairs: "" };
    case "normal":
      return { kind: d.kind, a: String(d.mean), b: String(d.stdDev), c: "", pairs: "" };
    case "lognormal":
      return { kind: d.kind, a: String(d.logMean), b: String(d.logStdDev), c: "", pairs: "" };
    case "discrete":
      return {
        kind: d.kind,
        a: "",
        b: "",
        c: "",
        pairs: (d.values ?? []).map((v) => `${v.value} ${v.weight}`).join("\n"),
      };
    default:
      return { kind: "", a: "", b: "", c: "", pairs: "" };
  }
}

function buildDist(draft: DistDraft): Dist | null {
  switch (draft.kind) {
    case "":
      return null;
    case "triangular":
    case "pert":
      return { kind: draft.kind, min: num(draft.a), mode: num(draft.b), max: num(draft.c) };
    case "uniform":
      return { kind: "uniform", min: num(draft.a), max: num(draft.c) };
    case "normal":
      return { kind: "normal", mean: num(draft.a), stdDev: num(draft.b) };
    case "lognormal":
      return { kind: "lognormal", logMean: num(draft.a), logStdDev: num(draft.b) };
    case "discrete": {
      const values = draft.pairs
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => {
          const [v, w] = l.split(/[\s,:]+/);
          return { value: num(v ?? ""), weight: num(w ?? "") };
        });
      return { kind: "discrete", values };
    }
  }
}

export function draftProblem(draft: DistDraft, required: boolean): string | null {
  const d = buildDist(draft);
  if (!d) return required ? "a distribution is required" : null;
  return distProblem(d);
}

function DistributionEditor({
  draft,
  onChange,
  allowNone,
  noneLabel,
  required,
}: {
  draft: DistDraft;
  onChange: (d: DistDraft) => void;
  allowNone?: boolean;
  noneLabel?: string;
  required: boolean;
}) {
  const problem = draftProblem(draft, required);
  const three = draft.kind === "triangular" || draft.kind === "pert";
  const numInput = (key: "a" | "b" | "c", label: string) => (
    <Field label={label}>
      <Input
        type="number"
        step="any"
        value={draft[key]}
        onChange={(e) => onChange({ ...draft, [key]: e.target.value })}
      />
    </Field>
  );
  return (
    <div className="rounded-md bg-ink-50 p-3 ring-1 ring-ink-100">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Field label="Distribution">
          <Select
            value={draft.kind}
            onChange={(e) => onChange({ ...draftFrom(null), kind: e.target.value as DistKind | "" })}
          >
            {allowNone ? <option value="">{noneLabel ?? "None"}</option> : null}
            {DIST_KINDS.map((k) => (
              <option key={k} value={k}>
                {humanize(k)}
              </option>
            ))}
          </Select>
        </Field>
        {three ? (
          <>
            {numInput("a", "Min")}
            {numInput("b", "Mode")}
            {numInput("c", "Max")}
          </>
        ) : draft.kind === "uniform" ? (
          <>
            {numInput("a", "Min")}
            {numInput("c", "Max")}
          </>
        ) : draft.kind === "normal" ? (
          <>
            {numInput("a", "Mean")}
            {numInput("b", "Std dev")}
          </>
        ) : draft.kind === "lognormal" ? (
          <>
            {numInput("a", "Log mean")}
            {numInput("b", "Log std dev")}
          </>
        ) : null}
      </div>
      {draft.kind === "discrete" ? (
        <div className="mt-2">
          <Field label="Outcomes" hint="One per line: value weight — e.g. “250000 0.7”.">
            <Textarea
              className="min-h-16 font-mono text-xs"
              value={draft.pairs}
              onChange={(e) => onChange({ ...draft, pairs: e.target.value })}
            />
          </Field>
        </div>
      ) : null}
      {problem ? <p className="mt-1.5 text-xs font-medium text-red-600">{problem}</p> : null}
    </div>
  );
}

/* --------------------------------- modal ---------------------------------- */

const SCORES = [1, 2, 3, 4, 5];

export default function RiskModal({
  open,
  onClose,
  projectId,
  risk,
  users,
  tasks,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  projectId: string;
  /** null → create */
  risk: RiskRow | null;
  users: UserLite[];
  tasks: TaskOption[];
  onSaved: (saved: RiskRow) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [title, setTitle] = useState("");
  const [category, setCategory] = useState<string>(RISK_CATEGORIES[0]);
  const [ownerId, setOwnerId] = useState("");
  const [description, setDescription] = useState("");
  const [pScore, setPScore] = useState("3");
  const [iScore, setIScore] = useState("3");
  const [postP, setPostP] = useState("");
  const [postI, setPostI] = useState("");
  const [quantify, setQuantify] = useState(false);
  const [occProb, setOccProb] = useState("0.3");
  const [costDraft, setCostDraft] = useState(draftFrom(null));
  const [taskId, setTaskId] = useState("");
  const [durDraft, setDurDraft] = useState(draftFrom(null));
  const [mitCost, setMitCost] = useState("");

  useEffect(() => {
    if (!open) return;
    setError(null);
    setTitle(risk?.title ?? "");
    setCategory(risk?.category ?? RISK_CATEGORIES[0]);
    setOwnerId(risk?.ownerId ?? "");
    setDescription(risk?.description ?? "");
    setPScore(String(risk?.probabilityScore ?? 3));
    setIScore(String(risk?.impactScore ?? 3));
    setPostP(risk?.postProbabilityScore != null ? String(risk.postProbabilityScore) : "");
    setPostI(risk?.postImpactScore != null ? String(risk.postImpactScore) : "");
    const quantified = risk?.occurrenceProbability != null || risk?.costImpact != null;
    setQuantify(Boolean(quantified));
    setOccProb(risk?.occurrenceProbability != null ? String(risk.occurrenceProbability) : "0.3");
    setCostDraft(
      risk?.costImpact
        ? draftFrom(risk.costImpact as unknown as Dist)
        : { kind: "triangular", a: "", b: "", c: "", pairs: "" },
    );
    setTaskId(risk?.scheduleTaskId ?? "");
    setDurDraft(risk?.durationImpact ? draftFrom(risk.durationImpact as unknown as Dist) : draftFrom(null));
    setMitCost(risk?.mitigationCost != null ? String(risk.mitigationCost) : "");
  }, [open, risk]);

  const postMismatch = (postP === "") !== (postI === "");
  const costProblem = quantify ? draftProblem(costDraft, true) : null;
  const durProblem = taskId ? draftProblem(durDraft, false) : null;
  const blocked = postMismatch || costProblem !== null || durProblem !== null;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (blocked) return;
    setError(null);
    setBusy(true);
    try {
      const payload: Record<string, unknown> = {
        title: title.trim(),
        category,
        description: description.trim() || null,
        ownerId: ownerId || null,
        probabilityScore: Number(pScore),
        impactScore: Number(iScore),
        postProbabilityScore: postP === "" ? null : Number(postP),
        postImpactScore: postI === "" ? null : Number(postI),
        occurrenceProbability: quantify ? Number(occProb) : null,
        costImpact: quantify ? buildDist(costDraft) : null,
        scheduleTaskId: taskId || null,
        durationImpact: taskId ? buildDist(durDraft) : null,
        mitigationCost: mitCost.trim() === "" ? null : Number(mitCost),
      };
      const saved = risk
        ? await api.patch<RiskRow>(`/api/v1/projects/${projectId}/risks/${risk.id}`, payload)
        : await api.post<RiskRow>(`/api/v1/projects/${projectId}/risks`, payload);
      onSaved(saved);
      onClose();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Failed to save the risk.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} title={risk ? `Edit ${title || "risk"}` : "New risk"} onClose={onClose} wide>
      <ErrorAlert message={error} />
      <form onSubmit={onSubmit} className="space-y-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Title">
            <Input required value={title} onChange={(e) => setTitle(e.target.value)} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Category">
              <Select value={category} onChange={(e) => setCategory(e.target.value)}>
                {RISK_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {humanize(c)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Owner">
              <Select value={ownerId} onChange={(e) => setOwnerId(e.target.value)}>
                <option value="">Unassigned</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        </div>

        <Field label="Description">
          <Textarea
            className="min-h-12"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What could happen, and why it matters…"
          />
        </Field>

        {/* qualitative scoring */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Field label="Probability (1-5)">
            <Select value={pScore} onChange={(e) => setPScore(e.target.value)}>
              {SCORES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Impact (1-5)">
            <Select value={iScore} onChange={(e) => setIScore(e.target.value)}>
              {SCORES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Post-mitigation P" hint="Optional — after mitigation.">
            <Select value={postP} onChange={(e) => setPostP(e.target.value)}>
              <option value="">Not set</option>
              {SCORES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Post-mitigation I">
            <Select value={postI} onChange={(e) => setPostI(e.target.value)}>
              <option value="">Not set</option>
              {SCORES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        {postMismatch ? (
          <p className="text-xs font-medium text-red-600">
            Set both post-mitigation scores, or neither.
          </p>
        ) : null}

        {/* quantitative (QCRA) */}
        <div className="rounded-md ring-1 ring-ink-100">
          <label className="flex cursor-pointer items-center gap-2 px-3 py-2.5">
            <input
              type="checkbox"
              checked={quantify}
              onChange={(e) => setQuantify(e.target.checked)}
              className="h-4 w-4 rounded border-ink-300 text-brand-600 focus:ring-brand-500"
            />
            <span className="text-sm font-medium text-ink-800">Quantify for cost simulation (QCRA)</span>
            <span className="text-xs text-ink-400">occurrence probability + cost-impact distribution</span>
          </label>
          {quantify ? (
            <div className="space-y-3 border-t border-ink-100 p-3">
              <Field label={`Occurrence probability — ${Math.round(Number(occProb) * 100)}%`}>
                <div className="flex items-center gap-3">
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.01}
                    value={occProb}
                    onChange={(e) => setOccProb(e.target.value)}
                    className="h-2 w-full cursor-pointer appearance-none rounded-full bg-ink-200 accent-brand-600"
                    aria-label="Occurrence probability"
                  />
                  <Input
                    type="number"
                    min={0}
                    max={1}
                    step={0.01}
                    value={occProb}
                    onChange={(e) => setOccProb(e.target.value)}
                    className="w-24 tabular-nums"
                  />
                </div>
              </Field>
              <div>
                <span className="mb-1 block text-xs font-medium text-ink-600">Cost impact</span>
                <DistributionEditor draft={costDraft} onChange={setCostDraft} required />
              </div>
            </div>
          ) : null}
        </div>

        {/* schedule link (QSRA) */}
        <div className="rounded-md ring-1 ring-ink-100 p-3 space-y-3">
          <Field
            label="Linked schedule task (QSRA)"
            hint="Optional — links this risk's duration uncertainty to a task for schedule simulation."
          >
            <Select value={taskId} onChange={(e) => setTaskId(e.target.value)}>
              <option value="">Not linked</option>
              {tasks.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.scheduleName} — {t.name}
                </option>
              ))}
            </Select>
          </Field>
          {taskId ? (
            <div>
              <span className="mb-1 block text-xs font-medium text-ink-600">
                Duration impact (days)
              </span>
              <DistributionEditor
                draft={durDraft}
                onChange={setDurDraft}
                allowNone
                noneLabel="No duration modelling"
                required={false}
              />
            </div>
          ) : null}
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Mitigation cost" hint="Total cost of the planned mitigation actions.">
            <Input
              type="number"
              min={0}
              step="any"
              value={mitCost}
              onChange={(e) => setMitCost(e.target.value)}
            />
          </Field>
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy || blocked}>
            {busy ? "Saving…" : risk ? "Save changes" : "Create risk"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
