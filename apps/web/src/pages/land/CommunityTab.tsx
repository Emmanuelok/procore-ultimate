/**
 * Stakeholder register with influence/interest mapping, and the engagement /
 * consultation log (spec Domain J #579-584, with FPIC consent status from
 * #575 carried on the engagement record).
 *
 * The map is the point: a Mendelow grid tells you what to actually do with
 * each group — and a consultation programme that never touches the
 * manage-closely quadrant is the one that gets a scheme stopped.
 */
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { CONSENT_STATUSES } from "@constructos/shared";
import { api, ApiClientError } from "../../lib/api";
import {
  Badge,
  Button,
  Card,
  CardBody,
  EmptyState,
  ErrorAlert,
  Field,
  Input,
  Modal,
  Select,
  Spinner,
  Table,
  Td,
  Textarea,
  Th,
} from "../../ui";
import { formatDate, humanize } from "../format";
import {
  AXIS_INK,
  consentTone,
  quadrantLabel,
  type EngagementDetail,
  type EngagementRow,
  type FeedbackPoint,
  type ListResponse,
  type MatrixResponse,
  type StakeholderRow,
} from "./landShared";

const STAKEHOLDER_CATEGORIES = [
  "community",
  "authority",
  "ngo",
  "media",
  "business",
  "indigenous_group",
] as const;

const ENGAGEMENT_KINDS = ["consultation", "disclosure", "meeting", "site_visit", "notice"] as const;

const QUADRANT_FILL: Record<string, string> = {
  manage_closely: "#1d60f1",
  keep_satisfied: "#6d92f7",
  keep_informed: "#a9c1fb",
  monitor: "#c9d6ea",
};

const QUADRANT_WASH: Record<string, string> = {
  manage_closely: "#eaf0fe",
  keep_satisfied: "#f1f5ff",
  keep_informed: "#f6f8ff",
  monitor: "#fafbfd",
};

const QUADRANT_HINT: Record<string, string> = {
  manage_closely: "High influence, high interest — consult early, consult often, and in person.",
  keep_satisfied: "High influence, low interest — brief enough that they never feel surprised.",
  keep_informed: "Low influence, high interest — disclosure and a working grievance route.",
  monitor: "Low influence, low interest — watch for changes; do not spend the programme here.",
};

type MatrixSelection =
  | { kind: "cell"; influence: number; interest: number }
  | { kind: "quadrant"; quadrant: string }
  | null;

/**
 * 5×5 influence/interest lattice (#579) — one dot per stakeholder rather than
 * a heat count, because a supervision conversation is about *who* is in the
 * top-right box, not how many.
 */
function Matrix({
  matrix,
  selection,
  onSelect,
}: {
  matrix: MatrixResponse;
  selection: MatrixSelection;
  onSelect: (next: MatrixSelection) => void;
}) {
  const W = 440;
  const H = 400;
  const PAD = { top: 14, right: 14, bottom: 40, left: 44 };
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const cellW = plotW / 5;
  const cellH = plotH / 5;

  // Quadrant blocks: interest 4-5 is the right 2 columns, influence 4-5 the
  // top 2 rows (the split the API's quadrantFor uses).
  const quadrantRects = [
    { q: "keep_satisfied", x: 0, y: 0, w: cellW * 3, h: cellH * 2 },
    { q: "manage_closely", x: cellW * 3, y: 0, w: cellW * 2, h: cellH * 2 },
    { q: "monitor", x: 0, y: cellH * 2, w: cellW * 3, h: cellH * 3 },
    { q: "keep_informed", x: cellW * 3, y: cellH * 2, w: cellW * 2, h: cellH * 3 },
  ];

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="h-auto w-full"
      role="img"
      aria-label="Stakeholder influence against interest, 5 by 5"
    >
      {quadrantRects.map((r) => {
        const active = selection?.kind === "quadrant" && selection.quadrant === r.q;
        return (
          <g key={r.q}>
            <rect
              x={PAD.left + r.x}
              y={PAD.top + r.y}
              width={r.w}
              height={r.h}
              fill={QUADRANT_WASH[r.q] ?? "#fafbfd"}
              stroke={active ? QUADRANT_FILL[r.q] : "#e4e8f0"}
              strokeWidth={active ? 2 : 1}
              className="cursor-pointer"
              onClick={() => onSelect(active ? null : { kind: "quadrant", quadrant: r.q })}
            >
              <title>{`${quadrantLabel(r.q)} — ${matrix.quadrants[r.q] ?? 0} stakeholder(s). ${
                QUADRANT_HINT[r.q] ?? ""
              }`}</title>
            </rect>
            <text
              x={PAD.left + r.x + 6}
              y={PAD.top + r.y + 13}
              fontSize={9}
              fontWeight={600}
              fill={active ? (QUADRANT_FILL[r.q] ?? AXIS_INK) : AXIS_INK}
              className="pointer-events-none uppercase"
              style={{ letterSpacing: "0.04em" }}
            >
              {quadrantLabel(r.q)}
            </text>
          </g>
        );
      })}

      {/* cell grid lines — decorative, so they never swallow a click */}
      {[1, 2, 3, 4].map((i) => (
        <g key={i} className="pointer-events-none">
          <line
            x1={PAD.left + i * cellW}
            x2={PAD.left + i * cellW}
            y1={PAD.top}
            y2={PAD.top + plotH}
            stroke="#eef1f6"
          />
          <line
            x1={PAD.left}
            x2={PAD.left + plotW}
            y1={PAD.top + i * cellH}
            y2={PAD.top + i * cellH}
            stroke="#eef1f6"
          />
        </g>
      ))}

      {/* one dot per stakeholder, laid out inside its cell */}
      {matrix.grid.map((cell) => {
        const col = cell.interest - 1;
        const row = 5 - cell.influence;
        const x0 = PAD.left + col * cellW;
        const y0 = PAD.top + row * cellH;
        const n = cell.stakeholders.length;
        if (n === 0) return null;
        const cols = Math.ceil(Math.sqrt(n));
        const rowsN = Math.ceil(n / cols);
        const cellActive =
          selection?.kind === "cell" &&
          selection.influence === cell.influence &&
          selection.interest === cell.interest;
        return (
          <g key={`${cell.influence}-${cell.interest}`}>
            {cell.stakeholders.map((s, i) => {
              const c = i % cols;
              const r = Math.floor(i / cols);
              const cx = x0 + ((c + 0.5) / cols) * cellW;
              const cy = y0 + ((r + 0.5) / rowsN) * cellH;
              return (
                <circle
                  key={s.id}
                  cx={cx}
                  cy={cy}
                  r={cellActive ? 7 : 5.5}
                  fill={QUADRANT_FILL[cell.quadrant] ?? "#1d60f1"}
                  stroke="#ffffff"
                  strokeWidth={1.5}
                  className="cursor-pointer"
                  onClick={() =>
                    onSelect(
                      cellActive
                        ? null
                        : { kind: "cell", influence: cell.influence, interest: cell.interest },
                    )
                  }
                >
                  <title>
                    {`${s.name}${s.organisation ? ` — ${s.organisation}` : ""}\ninfluence ${
                      cell.influence
                    }, interest ${cell.interest} · ${quadrantLabel(cell.quadrant)}`}
                  </title>
                </circle>
              );
            })}
          </g>
        );
      })}

      {/* axes */}
      {[5, 4, 3, 2, 1].map((v, i) => (
        <text
          key={v}
          x={PAD.left - 8}
          y={PAD.top + i * cellH + cellH / 2 + 4}
          textAnchor="end"
          fontSize={10}
          fill={AXIS_INK}
          className="tabular-nums"
        >
          {v}
        </text>
      ))}
      {[1, 2, 3, 4, 5].map((v, i) => (
        <text
          key={v}
          x={PAD.left + i * cellW + cellW / 2}
          y={H - 22}
          textAnchor="middle"
          fontSize={10}
          fill={AXIS_INK}
          className="tabular-nums"
        >
          {v}
        </text>
      ))}
      <text x={PAD.left + plotW / 2} y={H - 6} textAnchor="middle" fontSize={10} fill={AXIS_INK}>
        Interest →
      </text>
      <text
        x={13}
        y={PAD.top + plotH / 2}
        textAnchor="middle"
        fontSize={10}
        fill={AXIS_INK}
        transform={`rotate(-90 13 ${PAD.top + plotH / 2})`}
      >
        Influence →
      </text>
    </svg>
  );
}

interface FeedbackDraft {
  point: string;
  raisedBy: string;
  disposition: string;
}

export default function CommunityTab({ projectId }: { projectId: string }) {
  const base = `/api/v1/projects/${projectId}`;
  const [stakeholders, setStakeholders] = useState<StakeholderRow[] | null>(null);
  const [matrix, setMatrix] = useState<MatrixResponse | null>(null);
  const [engagements, setEngagements] = useState<EngagementRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState<MatrixSelection>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [list, m, eng] = await Promise.all([
        api.get<ListResponse<StakeholderRow>>(`${base}/stakeholders?pageSize=200`),
        api.get<MatrixResponse>(`${base}/stakeholders/matrix`),
        api.get<ListResponse<EngagementRow>>(`${base}/engagements?pageSize=100`),
      ]);
      setStakeholders(list.items);
      setMatrix(m);
      setEngagements(eng.items);
    } catch (err) {
      setStakeholders([]);
      setEngagements([]);
      setError(err instanceof Error ? err.message : "Failed to load the stakeholder register");
    }
  }, [base]);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = useMemo(() => {
    if (stakeholders === null) return null;
    if (selection === null) return stakeholders;
    if (selection.kind === "quadrant") {
      return stakeholders.filter((s) => s.quadrant === selection.quadrant);
    }
    return stakeholders.filter(
      (s) => s.influence === selection.influence && s.interest === selection.interest,
    );
  }, [stakeholders, selection]);

  const selectionLabel =
    selection === null
      ? null
      : selection.kind === "quadrant"
        ? quadrantLabel(selection.quadrant)
        : `Influence ${selection.influence} · interest ${selection.interest}`;

  /* ----------------------------- stakeholder form --------------------------- */

  const [sOpen, setSOpen] = useState(false);
  const [sError, setSError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sName, setSName] = useState("");
  const [sOrg, setSOrg] = useState("");
  const [sCategory, setSCategory] = useState<string>("community");
  const [sInfluence, setSInfluence] = useState("3");
  const [sInterest, setSInterest] = useState("3");
  const [sContact, setSContact] = useState("");
  const [sNotes, setSNotes] = useState("");

  function openStakeholder() {
    setSError(null);
    setSName("");
    setSOrg("");
    setSCategory("community");
    setSInfluence("3");
    setSInterest("3");
    setSContact("");
    setSNotes("");
    setSOpen(true);
  }

  async function onCreateStakeholder(e: FormEvent) {
    e.preventDefault();
    setSError(null);
    setBusy(true);
    try {
      const payload: Record<string, unknown> = {
        name: sName.trim(),
        category: sCategory,
        influence: Number(sInfluence),
        interest: Number(sInterest),
      };
      if (sOrg.trim()) payload["organisation"] = sOrg.trim();
      if (sContact.trim()) payload["contact"] = sContact.trim();
      if (sNotes.trim()) payload["notes"] = sNotes.trim();
      await api.post(`${base}/stakeholders`, payload);
      setSOpen(false);
      await load();
    } catch (err) {
      setSError(err instanceof ApiClientError ? err.message : "Failed to add the stakeholder.");
    } finally {
      setBusy(false);
    }
  }

  /* ------------------------------ engagement form --------------------------- */

  const [eOpen, setEOpen] = useState(false);
  const [eError, setEError] = useState<string | null>(null);
  const [eTitle, setETitle] = useState("");
  const [eKind, setEKind] = useState<string>("consultation");
  const [eDate, setEDate] = useState("");
  const [eLocation, setELocation] = useState("");
  const [eAttendees, setEAttendees] = useState("");
  const [eConsent, setEConsent] = useState("");
  const [eSummary, setESummary] = useState("");
  const [eStakeholders, setEStakeholders] = useState<string[]>([]);
  const [eFeedback, setEFeedback] = useState<FeedbackDraft[]>([]);

  function openEngagement() {
    setEError(null);
    setETitle("");
    setEKind("consultation");
    setEDate(new Date().toISOString().slice(0, 10));
    setELocation("");
    setEAttendees("");
    setEConsent("");
    setESummary("");
    setEStakeholders([]);
    setEFeedback([{ point: "", raisedBy: "", disposition: "" }]);
    setEOpen(true);
  }

  async function onCreateEngagement(e: FormEvent) {
    e.preventDefault();
    setEError(null);
    setBusy(true);
    try {
      const payload: Record<string, unknown> = {
        title: eTitle.trim(),
        kind: eKind,
        engagementDate: eDate,
      };
      if (eLocation.trim()) payload["location"] = eLocation.trim();
      if (eAttendees !== "" && Number(eAttendees) >= 0) {
        payload["attendeeCount"] = Number(eAttendees);
      }
      if (eConsent) payload["consentStatus"] = eConsent;
      if (eSummary.trim()) payload["summary"] = eSummary.trim();
      if (eStakeholders.length > 0) payload["stakeholderIds"] = eStakeholders;
      const feedback = eFeedback
        .filter((f) => f.point.trim())
        .map((f) => ({
          point: f.point.trim(),
          raisedBy: f.raisedBy.trim() || null,
          disposition: f.disposition.trim() || null,
        }));
      if (feedback.length > 0) payload["feedback"] = feedback;
      await api.post(`${base}/engagements`, payload);
      setEOpen(false);
      await load();
    } catch (err) {
      setEError(err instanceof ApiClientError ? err.message : "Failed to log the engagement.");
    } finally {
      setBusy(false);
    }
  }

  /* ---------------------------- engagement detail --------------------------- */

  const [detail, setDetail] = useState<EngagementDetail | null>(null);

  async function openDetail(id: string) {
    try {
      setDetail(await api.get<EngagementDetail>(`${base}/engagements/${id}`));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to open the engagement");
    }
  }

  /* --------------------------------- render -------------------------------- */

  return (
    <div className="space-y-4">
      <ErrorAlert message={error} />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
        <Card className="lg:col-span-2">
          <CardBody>
            <div className="mb-2 flex items-center justify-between gap-2">
              <h3 className="text-sm font-semibold text-ink-900">
                Influence / interest map <span className="font-normal text-ink-400">(#579)</span>
              </h3>
              {selection ? (
                <Button variant="ghost" size="sm" onClick={() => setSelection(null)}>
                  Clear filter
                </Button>
              ) : null}
            </div>
            {matrix === null ? (
              <Spinner label="Loading the map…" />
            ) : matrix.total === 0 ? (
              <EmptyState
                title="No stakeholders registered"
                hint="Map who holds influence over the scheme and who has an interest in it — the quadrant tells you how to engage each group."
                action={<Button onClick={openStakeholder}>Add the first stakeholder</Button>}
              />
            ) : (
              <>
                <Matrix matrix={matrix} selection={selection} onSelect={setSelection} />
                <p className="mt-1 text-xs text-ink-400">
                  Click a dot or a quadrant to filter the register.
                </p>
                <ul className="mt-2 grid grid-cols-2 gap-2">
                  {(["manage_closely", "keep_satisfied", "keep_informed", "monitor"] as const).map(
                    (q) => {
                      const active = selection?.kind === "quadrant" && selection.quadrant === q;
                      return (
                        <li key={q}>
                          <button
                            type="button"
                            title={QUADRANT_HINT[q]}
                            onClick={() =>
                              setSelection(active ? null : { kind: "quadrant", quadrant: q })
                            }
                            className={`flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-xs ${
                              active ? "bg-brand-50 text-brand-800" : "text-ink-600 hover:bg-ink-50"
                            }`}
                          >
                            <span
                              aria-hidden
                              className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm"
                              style={{ background: QUADRANT_FILL[q] }}
                            />
                            <span className="min-w-0 flex-1 truncate">{quadrantLabel(q)}</span>
                            <span className="font-semibold tabular-nums text-ink-800">
                              {matrix.quadrants[q] ?? 0}
                            </span>
                          </button>
                        </li>
                      );
                    },
                  )}
                </ul>
              </>
            )}
          </CardBody>
        </Card>

        <div className="space-y-2 lg:col-span-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-ink-900">
              Stakeholder register
              {selectionLabel ? (
                <span className="ml-2 font-normal text-ink-500">
                  filtered to <span className="font-medium text-brand-700">{selectionLabel}</span>
                </span>
              ) : null}
            </h3>
            <Button variant="secondary" size="sm" onClick={openStakeholder}>
              Add stakeholder
            </Button>
          </div>

          {filtered === null ? (
            <Spinner label="Loading the register…" />
          ) : filtered.length === 0 ? (
            <EmptyState
              title={selection ? "No stakeholder in this part of the map" : "Nobody on the register"}
              hint={
                selection
                  ? "Clear the map filter to see the whole register."
                  : "Add the communities, authorities, NGOs and businesses the scheme touches."
              }
              action={
                selection ? (
                  <Button variant="secondary" onClick={() => setSelection(null)}>
                    Clear filter
                  </Button>
                ) : (
                  <Button onClick={openStakeholder}>Add stakeholder</Button>
                )
              }
            />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Name</Th>
                  <Th>Organisation</Th>
                  <Th>Category</Th>
                  <Th className="text-right">Influence</Th>
                  <Th className="text-right">Interest</Th>
                  <Th>Engagement stance</Th>
                  <Th>Contact</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {filtered.map((s) => (
                  <tr key={s.id} className="hover:bg-ink-50">
                    <Td className="font-medium text-ink-900">{s.name}</Td>
                    <Td className="max-w-[12rem] truncate">{s.organisation ?? "—"}</Td>
                    <Td>{s.category ? humanize(s.category) : "—"}</Td>
                    <Td className="text-right tabular-nums">{s.influence}</Td>
                    <Td className="text-right tabular-nums">{s.interest}</Td>
                    <Td>
                      <span title={QUADRANT_HINT[s.quadrant]}>
                        <Badge tone={s.quadrant === "manage_closely" ? "blue" : "gray"}>
                          {quadrantLabel(s.quadrant)}
                        </Badge>
                      </span>
                    </Td>
                    <Td className="max-w-[12rem] truncate text-xs text-ink-500">
                      {s.contact ?? "—"}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </div>
      </div>

      {/* ------------------------------- timeline -------------------------------- */}
      <div className="flex flex-wrap items-center justify-between gap-2 pt-2">
        <h3 className="text-sm font-semibold text-ink-900">
          Engagement &amp; consultation log{" "}
          <span className="font-normal text-ink-400">(#580-584)</span>
        </h3>
        <Button onClick={openEngagement}>Log engagement</Button>
      </div>

      {engagements === null ? (
        <Spinner label="Loading the engagement log…" />
      ) : engagements.length === 0 ? (
        <EmptyState
          title="No engagements logged"
          hint="Consultations, disclosures and public notices belong on one dated record with the feedback raised and how it was dispositioned — that record is what a lender's supervision mission asks to see."
          action={<Button onClick={openEngagement}>Log the first engagement</Button>}
        />
      ) : (
        <ol className="relative space-y-3 border-l border-ink-200 pl-5">
          {engagements.map((e) => (
            <li key={e.id} className="relative">
              <span
                aria-hidden
                className="absolute left-[-1.5625rem] top-3 h-2.5 w-2.5 rounded-full bg-brand-500 ring-2 ring-white"
              />
              <Card>
                <CardBody className="py-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-xs font-medium tabular-nums text-ink-500">
                          {formatDate(e.engagementDate)}
                        </span>
                        <Badge tone="blue">{humanize(e.kind)}</Badge>
                        {e.consentStatus ? (
                          <span title="Free, prior and informed consent status (#575)">
                            <Badge tone={consentTone(e.consentStatus)}>
                              Consent {humanize(e.consentStatus)}
                            </Badge>
                          </span>
                        ) : null}
                      </div>
                      <button
                        type="button"
                        className="mt-1 block truncate text-left text-sm font-medium text-brand-700 hover:text-brand-800"
                        onClick={() => void openDetail(e.id)}
                      >
                        {e.title}
                      </button>
                      <p className="mt-0.5 text-xs text-ink-500">
                        {e.location ? <>{e.location} · </> : null}
                        <span className="tabular-nums">{e.attendeeCount ?? "—"}</span> attendee
                        {e.attendeeCount === 1 ? "" : "s"}
                        {(e.stakeholderNames ?? []).length > 0 ? (
                          <> · {(e.stakeholderNames ?? []).join(", ")}</>
                        ) : null}
                      </p>
                    </div>
                    <div className="shrink-0 text-right">
                      <div className="text-xs tabular-nums text-ink-500">
                        {e.feedbackCount ?? 0} feedback point
                        {(e.feedbackCount ?? 0) === 1 ? "" : "s"}
                      </div>
                      <Button variant="ghost" size="sm" onClick={() => void openDetail(e.id)}>
                        Open
                      </Button>
                    </div>
                  </div>
                  {e.summary ? (
                    <p className="mt-2 line-clamp-2 text-sm text-ink-600">{e.summary}</p>
                  ) : null}
                </CardBody>
              </Card>
            </li>
          ))}
        </ol>
      )}

      {/* --------------------------- stakeholder modal --------------------------- */}
      <Modal open={sOpen} title="Add a stakeholder" onClose={() => setSOpen(false)}>
        <ErrorAlert message={sError} />
        <form onSubmit={onCreateStakeholder} className="space-y-4">
          <Field label="Name">
            <Input required value={sName} onChange={(e) => setSName(e.target.value)} />
          </Field>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Organisation">
              <Input value={sOrg} onChange={(e) => setSOrg(e.target.value)} />
            </Field>
            <Field label="Category">
              <Select value={sCategory} onChange={(e) => setSCategory(e.target.value)}>
                {STAKEHOLDER_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {humanize(c)}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field label="Influence (1-5)" hint="4-5 counts as high.">
              <Select value={sInfluence} onChange={(e) => setSInfluence(e.target.value)}>
                {[1, 2, 3, 4, 5].map((n) => (
                  <option key={n} value={String(n)}>
                    {n}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Interest (1-5)" hint="4-5 counts as high.">
              <Select value={sInterest} onChange={(e) => setSInterest(e.target.value)}>
                {[1, 2, 3, 4, 5].map((n) => (
                  <option key={n} value={String(n)}>
                    {n}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Contact">
              <Input value={sContact} onChange={(e) => setSContact(e.target.value)} />
            </Field>
          </div>
          <Field label="Notes">
            <Textarea
              className="min-h-12"
              value={sNotes}
              onChange={(e) => setSNotes(e.target.value)}
              placeholder="Chairs the parish land committee; must be present before any disclosure meeting is called."
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setSOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Adding…" : "Add stakeholder"}
            </Button>
          </div>
        </form>
      </Modal>

      {/* --------------------------- engagement modal ---------------------------- */}
      <Modal open={eOpen} title="Log an engagement" onClose={() => setEOpen(false)} wide>
        <ErrorAlert message={eError} />
        <form onSubmit={onCreateEngagement} className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Title">
              <Input
                required
                value={eTitle}
                onChange={(e) => setETitle(e.target.value)}
                placeholder="Disclosure of the draft Resettlement Action Plan"
              />
            </Field>
            <Field label="Kind">
              <Select value={eKind} onChange={(e) => setEKind(e.target.value)}>
                {ENGAGEMENT_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {humanize(k)}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
            <Field label="Date">
              <Input
                type="date"
                required
                value={eDate}
                onChange={(e) => setEDate(e.target.value)}
              />
            </Field>
            <Field label="Location">
              <Input value={eLocation} onChange={(e) => setELocation(e.target.value)} />
            </Field>
            <Field label="Attendees">
              <Input
                type="number"
                min="0"
                value={eAttendees}
                onChange={(e) => setEAttendees(e.target.value)}
              />
            </Field>
            <Field label="Consent status" hint="FPIC documentation (#575).">
              <Select value={eConsent} onChange={(e) => setEConsent(e.target.value)}>
                <option value="">Not applicable</option>
                {CONSENT_STATUSES.map((c) => (
                  <option key={c} value={c}>
                    {humanize(c)}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          <Field label="Stakeholders present">
            {stakeholders === null || stakeholders.length === 0 ? (
              <p className="rounded-md border border-dashed border-ink-200 px-3 py-2.5 text-center text-xs text-ink-400">
                Add stakeholders to the register first to link them to this engagement.
              </p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {stakeholders.map((s) => {
                  const on = eStakeholders.includes(s.id);
                  return (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() =>
                        setEStakeholders((cur) =>
                          on ? cur.filter((x) => x !== s.id) : [...cur, s.id],
                        )
                      }
                      className={`rounded-full px-2.5 py-1 text-xs font-medium ring-1 ${
                        on
                          ? "bg-brand-100 text-brand-800 ring-brand-200"
                          : "bg-white text-ink-600 ring-ink-200 hover:bg-ink-50"
                      }`}
                    >
                      {s.name}
                    </button>
                  );
                })}
              </div>
            )}
          </Field>

          <Field label="Summary">
            <Textarea
              className="min-h-16"
              value={eSummary}
              onChange={(e) => setESummary(e.target.value)}
              placeholder="What was disclosed, what was asked, what was committed."
            />
          </Field>

          {/* feedback repeater (#582) */}
          <div>
            <div className="mb-1 flex items-baseline justify-between">
              <span className="text-xs font-medium text-ink-600">
                Feedback raised, and its disposition{" "}
                <span className="font-normal text-ink-400">(#582)</span>
              </span>
              <span className="text-xs text-ink-400">
                {eFeedback.filter((f) => f.point.trim()).length} point
                {eFeedback.filter((f) => f.point.trim()).length === 1 ? "" : "s"}
              </span>
            </div>
            <p className="mb-2 text-xs text-ink-400">
              A consultation record that lists attendance but not what was said — and what was done
              about it — is attendance, not consultation.
            </p>
            <div className="space-y-2">
              {eFeedback.map((f, i) => (
                <div key={i} className="flex items-start gap-2">
                  <Input
                    className="flex-1"
                    placeholder="Point raised — e.g. Compensation rates are below market"
                    value={f.point}
                    onChange={(ev) =>
                      setEFeedback((rows) =>
                        rows.map((x, j) => (j === i ? { ...x, point: ev.target.value } : x)),
                      )
                    }
                  />
                  <Input
                    className="w-40"
                    placeholder="Raised by"
                    value={f.raisedBy}
                    onChange={(ev) =>
                      setEFeedback((rows) =>
                        rows.map((x, j) => (j === i ? { ...x, raisedBy: ev.target.value } : x)),
                      )
                    }
                  />
                  <Input
                    className="flex-1"
                    placeholder="Disposition — what was done"
                    value={f.disposition}
                    onChange={(ev) =>
                      setEFeedback((rows) =>
                        rows.map((x, j) => (j === i ? { ...x, disposition: ev.target.value } : x)),
                      )
                    }
                  />
                  <Button
                    className="w-8"
                    variant="ghost"
                    size="sm"
                    aria-label={`Remove feedback point ${i + 1}`}
                    onClick={() => setEFeedback((rows) => rows.filter((_, j) => j !== i))}
                  >
                    ✕
                  </Button>
                </div>
              ))}
            </div>
            <Button
              className="mt-2"
              variant="secondary"
              size="sm"
              onClick={() =>
                setEFeedback((rows) => [...rows, { point: "", raisedBy: "", disposition: "" }])
              }
            >
              Add feedback point
            </Button>
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setEOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Logging…" : "Log engagement"}
            </Button>
          </div>
        </form>
      </Modal>

      {/* --------------------------- engagement detail --------------------------- */}
      <Modal
        open={detail !== null}
        title={detail ? detail.title : ""}
        onClose={() => setDetail(null)}
        wide
      >
        {detail ? (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone="blue">{humanize(detail.kind)}</Badge>
              <span className="text-sm tabular-nums text-ink-600">
                {formatDate(detail.engagementDate)}
              </span>
              {detail.location ? (
                <span className="text-sm text-ink-500">{detail.location}</span>
              ) : null}
              {detail.consentStatus ? (
                <Badge tone={consentTone(detail.consentStatus)}>
                  Consent {humanize(detail.consentStatus)}
                </Badge>
              ) : null}
              <span className="text-sm tabular-nums text-ink-500">
                {detail.attendeeCount ?? "—"} attendees
              </span>
            </div>

            {detail.summary ? (
              <p className="rounded-md bg-ink-50 px-3 py-2 text-sm text-ink-700">
                {detail.summary}
              </p>
            ) : null}

            <div>
              <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-ink-500">
                Stakeholders present ({detail.stakeholders.length})
              </h4>
              {detail.stakeholders.length === 0 ? (
                <p className="text-xs text-ink-400">No stakeholder from the register was linked.</p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {detail.stakeholders.map((s) => (
                    <Badge key={s.id} tone={s.quadrant === "manage_closely" ? "blue" : "gray"}>
                      {s.name}
                    </Badge>
                  ))}
                </div>
              )}
            </div>

            <div>
              <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-ink-500">
                Feedback &amp; disposition (#582)
              </h4>
              {detail.feedback.length === 0 ? (
                <p className="text-xs text-ink-400">
                  No feedback was recorded against this engagement.
                </p>
              ) : (
                <Table>
                  <thead>
                    <tr>
                      <Th>Point raised</Th>
                      <Th>Raised by</Th>
                      <Th>Disposition</Th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-ink-100">
                    {detail.feedback.map((f: FeedbackPoint, i) => (
                      <tr key={`${f.point}-${i}`}>
                        <Td>{f.point}</Td>
                        <Td className="text-ink-500">{f.raisedBy ?? "—"}</Td>
                        <Td className={f.disposition ? "text-ink-700" : "text-amber-700"}>
                          {f.disposition ?? "Not yet dispositioned"}
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </div>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
