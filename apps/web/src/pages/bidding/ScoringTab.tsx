/**
 * SCORING — price and quality, with every gap left visible.
 *
 * THE RULE THAT MATTERS: an unscored criterion is NOT zero. A gap makes the
 * total null and names the criterion, because a bidder losing an award on a
 * criterion nobody assessed them on is the failure this arrangement exists to
 * prevent. This screen therefore never renders 0 for a missing score, never
 * ranks an unscored bid last, and prints the reason the API gave.
 *
 * A price score is a COMPARISON across the package, so it cannot be formed for
 * one bid in isolation — the per-bid form records quality scores, and the
 * package-wide compute produces price, totals and ranks.
 */
import { useMemo, useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  DataTable,
  EmptyState,
  Field,
  Input,
  Modal,
  Textarea,
} from "../../ui";
import type { DataColumns } from "../../ui";
import { IconAnalytics, IconLock } from "../../ui/icons";
import { api } from "../../lib/api";
import {
  Figure,
  LoadError,
  LoadingBlock,
  ReasonList,
  RefusalPanel,
  money,
  num,
  titleCase,
  useAction,
  useResource,
} from "./biddingShared";
import type { PackageDetail, ScoringResponse, SubmissionScoring } from "./types";

export default function ScoringTab({
  projectId,
  packageId,
  pkg,
  onMutated,
}: {
  projectId: string;
  packageId: string;
  pkg: PackageDetail | null;
  onMutated: () => void;
}) {
  const [version, setVersion] = useState(0);
  const scoring = useResource<ScoringResponse>(
    packageId
      ? `/api/v1/projects/${projectId}/bid-packages/${packageId}/scoring?_v=${version}`
      : null,
  );
  const action = useAction();
  const [scoringFor, setScoringFor] = useState<SubmissionScoring | null>(null);

  function refresh() {
    setVersion((n) => n + 1);
    onMutated();
  }

  const data = scoring.data;
  const currency = pkg?.currency ?? "USD";

  const rankOf = useMemo(() => {
    const map = new Map<string, number | null>();
    for (const r of data?.ranked ?? []) map.set(r.submissionId, r.rank);
    return map;
  }, [data]);

  const columns: DataColumns<SubmissionScoring> = useMemo(
    () => [
      {
        id: "vendor",
        header: "Bidder",
        accessor: (row) => row.vendorName ?? row.reference,
        type: "text",
        width: 200,
        sticky: "start",
        cell: ({ row }) => (
          <div className="min-w-0">
            <p className="truncate font-medium">{row.vendorName ?? row.reference}</p>
            <p className="text-2xs text-content-subtle">
              {row.reference}
              {row.inContention ? "" : " · not in contention"}
            </p>
          </div>
        ),
      },
      {
        id: "priceBasis",
        header: "Compared on",
        accessor: (row) => row.priceBasis,
        width: 190,
        cell: ({ row }) => (
          <div className="min-w-0">
            <Badge
              tone={
                row.priceBasis === "levelled"
                  ? "success"
                  : row.priceBasis === "as_bid"
                    ? "warning"
                    : "neutral"
              }
              size="xs"
              variant="subtle"
            >
              {row.priceBasis === "levelled"
                ? "Levelled amount"
                : row.priceBasis === "as_bid"
                  ? "As-bid total"
                  : "No amount"}
            </Badge>
            <p className="mt-0.5 tabular-nums text-2xs text-content-subtle">
              {row.priceAmount === null ? "no comparable figure" : money(row.priceAmount, currency)}
            </p>
          </div>
        ),
      },
      {
        id: "price",
        header: "Price score",
        accessor: (row) => row.commercialScore.value,
        width: 200,
        align: "right",
        cell: ({ row }) => (
          <Figure
            figure={row.commercialScore}
            className="block text-right"
            render={(v) => <span className="tabular-nums font-medium">{num(v, 1)}</span>}
          />
        ),
      },
      {
        id: "quality",
        header: "Quality score",
        accessor: (row) => row.technicalScore.value,
        width: 220,
        align: "right",
        cell: ({ row }) => (
          <Figure
            figure={row.technicalScore}
            className="block text-right"
            render={(v) => <span className="tabular-nums font-medium">{num(v, 1)}</span>}
          />
        ),
      },
      {
        id: "total",
        header: "Total",
        accessor: (row) => row.totalScore.value,
        width: 240,
        align: "right",
        cell: ({ row }) => (
          <Figure
            figure={row.totalScore}
            className="block text-right"
            render={(v) => <span className="tabular-nums text-sm font-semibold">{num(v, 1)}</span>}
          />
        ),
      },
      {
        id: "rank",
        header: "Rank",
        accessor: (row) => rankOf.get(row.submissionId) ?? null,
        width: 150,
        align: "right",
        cell: ({ row }) => {
          const rank = rankOf.get(row.submissionId) ?? null;
          return rank === null ? (
            <span
              className="text-2xs italic text-content-subtle"
              title="A bid with no total is not ranked at all. Ranking an unscored bid bottom is the same error as scoring its gap zero."
            >
              not ranked
            </span>
          ) : (
            <Badge tone={rank === 1 ? "success" : "neutral"} size="xs">
              #{rank}
            </Badge>
          );
        },
      },
    ],
    [currency, rankOf],
  );

  if (scoring.loading && !data) return <LoadingBlock rows={5} />;
  if (scoring.error) return <LoadError message={scoring.error} onRetry={scoring.reload} />;

  if (data?.sealed) {
    return (
      <EmptyState
        icon={IconLock}
        tone="warning"
        title="Scores are withheld while this package is sealed"
        hint={
          data.note ??
          "A price score IS the price, expressed as a comparison. Nothing here can be computed until the seal lawfully lifts."
        }
      />
    );
  }

  const criteria = data?.criteria ?? [];
  const rows = data?.rows ?? [];
  const unscored = rows.filter((r) => r.inContention && r.totalScore.value === null);

  async function compute() {
    const done = await action.run("compute", () =>
      api.post(`/api/v1/projects/${projectId}/bid-packages/${packageId}/scoring/compute`, {}),
    );
    if (done) refresh();
  }

  if (criteria.length === 0) {
    return (
      <EmptyState
        icon={IconAnalytics}
        title="This package declares no evaluation criteria"
        hint="There is nothing to score against. The basis on which a winner is chosen is declared on the package before bids open — never after, because changing it once the prices are visible is the classic procurement-integrity failure. Only price can decide this package as it stands."
      />
    );
  }

  return (
    <div className="space-y-4">
      <RefusalPanel refusal={action.refusal} onDismiss={action.clear} />

      <Card>
        <CardBody className="space-y-2">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-sm font-semibold">The declared basis</p>
              <p className="mt-0.5 text-meta text-content-muted">
                {data?.priceWeight != null && data?.qualityWeight != null
                  ? `Weighted ${num(data.priceWeight, 0)}% price / ${num(data.qualityWeight, 0)}% quality.`
                  : "No price/quality weighting is declared on this package, so no combined score can be formed. Declare the weights before bids open — never after."}
              </p>
            </div>
            <Button onClick={() => void compute()} loading={action.busy === "compute"}>
              Compute scores across the package
            </Button>
          </div>
          <ul className="flex flex-wrap gap-2">
            {criteria.map((c) => (
              <li key={c.key}>
                <Badge tone={c.kind === "price" ? "info" : "highlight"} size="sm" variant="subtle">
                  {c.label} · {titleCase(c.kind)} · weight {num(c.weight, 0)}
                </Badge>
              </li>
            ))}
          </ul>
        </CardBody>
      </Card>

      {data?.notes && data.notes.length > 0 ? (
        <Alert tone="warning" title="Read the comparison with these in mind">
          <ReasonList reasons={data.notes} tone="warning" />
        </Alert>
      ) : null}

      {unscored.length > 0 ? (
        <Alert
          tone="warning"
          title={`${unscored.length} bid${unscored.length === 1 ? "" : "s"} in contention carry no total`}
        >
          <p>
            A bid with an unscored criterion carries a NULL total and no rank, with the criterion
            named. It is never scored zero: a gap counted as zero decides awards wrongly.
          </p>
          <ul className="mt-2 space-y-1.5">
            {unscored.map((r) => (
              <li key={r.submissionId}>
                <span className="text-meta font-medium">{r.vendorName ?? r.reference}</span>
                <ReasonList reasons={r.totalScore.reasons} tone="warning" />
              </li>
            ))}
          </ul>
        </Alert>
      ) : null}

      {rows.length === 0 ? (
        <EmptyState
          title="No bids to score"
          hint="Scores are recorded against bids. None has been received on this package yet."
        />
      ) : (
        <DataTable<SubmissionScoring>
          tableId="bidding.scoring"
          data={rows}
          columns={columns}
          getRowId={(row) => row.submissionId}
          height={440}
          rowHeight={64}
          stickyHeader
          exportFileName="bid-scoring"
          onRowClick={({ row }) => setScoringFor(row)}
          rowTone={(row) => (row.inContention && row.totalScore.value === null ? "warning" : undefined)}
          rowActions={(row) => [
            { id: "score", label: "Score this bid", onSelect: () => setScoringFor(row) },
          ]}
          empty={{ title: "No bids match", description: "The filters exclude every bid." }}
        />
      )}

      <ScoreModal
        row={scoringFor}
        onClose={() => setScoringFor(null)}
        onSaved={() => {
          setScoringFor(null);
          refresh();
        }}
      />
    </div>
  );
}

/* ================================================================== */
/* Scoring one bid                                                     */
/* ================================================================== */

function ScoreModal({
  row,
  onClose,
  onSaved,
}: {
  row: SubmissionScoring | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const action = useAction();
  const [values, setValues] = useState<Record<string, { score: string; max: string; note: string }>>(
    {},
  );
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [evaluationNote, setEvaluationNote] = useState("");

  if (row && row.submissionId !== loadedFor) {
    setLoadedFor(row.submissionId);
    const next: Record<string, { score: string; max: string; note: string }> = {};
    for (const c of row.criteria) {
      next[c.key] = {
        score: c.score === null ? "" : String(c.score),
        max: c.maxScore === null ? "100" : String(c.maxScore),
        note: c.note ?? "",
      };
    }
    setValues(next);
    setEvaluationNote("");
  }

  async function save() {
    if (!row) return;
    const scores = row.criteria.map((c) => {
      const v = values[c.key] ?? { score: "", max: "100", note: "" };
      return {
        key: c.key,
        score: v.score.trim() === "" ? null : Number(v.score),
        maxScore: v.max.trim() === "" ? 100 : Number(v.max),
        note: v.note.trim() || null,
      };
    });
    const done = await action.run("score", () =>
      api.post(`/api/v1/bid-submissions/${row.submissionId}/scores`, {
        scores,
        evaluationNote: evaluationNote.trim() || null,
      }),
    );
    if (done) onSaved();
  }

  const quality = (row?.criteria ?? []).filter((c) => c.kind === "quality");
  const price = (row?.criteria ?? []).filter((c) => c.kind === "price");

  return (
    <Modal
      open={row !== null}
      onClose={onClose}
      size="lg"
      title={row ? `Score ${row.vendorName ?? row.reference}` : "Score"}
      description="An unscored criterion leaves the total null with the criterion named — it is never counted as zero."
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void save()} loading={action.busy === "score"}>
            Record the scores
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <RefusalPanel refusal={action.refusal} onDismiss={action.clear} />

        <Alert tone="info" variant="subtle" size="sm">
          Totals and ranks are produced across the whole package, not one bid at a time, because a
          price score is a comparison against the other bids. Record quality here, then compute.
        </Alert>

        {[
          { label: "Quality criteria", list: quality },
          { label: "Price criteria", list: price },
        ]
          .filter((g) => g.list.length > 0)
          .map((group) => (
            <section key={group.label}>
              <h3 className="text-label uppercase text-content-subtle">{group.label}</h3>
              <ul className="mt-2 space-y-3">
                {group.list.map((c) => {
                  const v = values[c.key] ?? { score: "", max: "100", note: "" };
                  return (
                    <li key={c.key} className="rounded-lg border border-border p-3">
                      <div className="flex items-baseline justify-between gap-2">
                        <p className="text-meta font-semibold">{c.label}</p>
                        <Badge tone="neutral" size="xs">
                          weight {num(c.weight, 0)}
                        </Badge>
                      </div>
                      <div className="mt-2 grid gap-2 sm:grid-cols-[8rem_8rem_1fr]">
                        <Field label="Score">
                          <Input
                            type="number"
                            inputMode="decimal"
                            value={v.score}
                            onChange={(e) =>
                              setValues((prev) => ({
                                ...prev,
                                [c.key]: { ...v, score: e.target.value },
                              }))
                            }
                          />
                        </Field>
                        <Field label="Out of">
                          <Input
                            type="number"
                            inputMode="decimal"
                            value={v.max}
                            onChange={(e) =>
                              setValues((prev) => ({
                                ...prev,
                                [c.key]: { ...v, max: e.target.value },
                              }))
                            }
                          />
                        </Field>
                        <Field label="Note" optional>
                          <Input
                            value={v.note}
                            onChange={(e) =>
                              setValues((prev) => ({
                                ...prev,
                                [c.key]: { ...v, note: e.target.value },
                              }))
                            }
                          />
                        </Field>
                      </div>
                      {c.missing ? (
                        <p className="mt-1 text-2xs text-warning-fg">
                          Not scored. While it stays unscored this bidder has no total and no rank —
                          which is right, and better than a zero that would decide the award.
                        </p>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}

        <Field label="Evaluation note" optional>
          <Textarea
            rows={3}
            value={evaluationNote}
            onChange={(e) => setEvaluationNote(e.target.value)}
          />
        </Field>
      </div>
    </Modal>
  );
}
