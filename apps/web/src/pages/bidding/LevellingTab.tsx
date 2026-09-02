/**
 * LEVELLING — the analytical core.
 *
 * Two bids are never comparable as submitted. One excludes the scaffold, one
 * prices a provisional sum the others left out, a third corrects a quantity it
 * thinks is wrong. The buyer defines neutral scope rows; every bidder is mapped
 * onto them with an inclusion status and an adjustment that STATES ITS REASON;
 * and the levelled amount — not the as-bid amount — is what gets compared.
 *
 * THE FAILURE THIS SCREEN EXISTS TO MAKE VISIBLE
 *
 * An exclusion priced at nothing silently makes the cheapest bidder whoever
 * excluded the most. So an excluded row with no adjustment does not render a
 * cheap-looking number, and does not render a blank either: it renders the
 * server's sentence, in the danger tone, in the cell. The same goes for a
 * partial inclusion left at face value, an unclear answer, and an adjustment
 * with no stated reason. Every one of them refuses to produce a figure, and
 * every one of them says why in the words the API used.
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
  Select,
  Textarea,
} from "../../ui";
import type { DataColumns } from "../../ui";
import { cx } from "../../ui/cx";
import { IconLock, IconPlus, IconTarget, IconWarning, IconZap } from "../../ui/icons";
import { api } from "../../lib/api";
import {
  INCLUSION_LABEL,
  INCLUSION_TONE,
  LEVELLING_ADJUSTMENT_REASONS,
  LEVELLING_INCLUSIONS,
  LEVELLING_ITEM_CATEGORIES,
  LoadError,
  LoadingBlock,
  ReasonList,
  RefusalPanel,
  distinctCurrencies,
  money,
  titleCase,
  useAction,
  useResource,
} from "./biddingShared";
import type {
  ComparisonSubmission,
  LevelledCell,
  LevellingGrid,
  PackageDetail,
  SubmissionLevelling,
} from "./types";

interface GridRow {
  id: string;
  itemCode: string | null;
  description: string;
  category: string;
  isMandatory: boolean;
  engineersEstimate: number | null;
  currency: string;
  cells: Record<string, LevelledCell | undefined>;
}

export default function LevellingTab({
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
  const grid = useResource<LevellingGrid>(
    packageId
      ? `/api/v1/projects/${projectId}/bid-packages/${packageId}/levelling/grid?_v=${version}`
      : null,
  );
  const action = useAction();
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<{
    submission: ComparisonSubmission;
    cell: LevelledCell | undefined;
    itemId: string;
    itemLabel: string;
    priceable: boolean;
  } | null>(null);

  function refresh() {
    setVersion((n) => n + 1);
    onMutated();
  }

  const data = grid.data;
  const currency = data?.package?.currency ?? pkg?.currency ?? "USD";

  const byId = useMemo(() => {
    const map = new Map<string, SubmissionLevelling>();
    for (const s of data?.grid ?? []) map.set(s.submissionId, s);
    return map;
  }, [data]);

  const rows: GridRow[] = useMemo(() => {
    const items = data?.items ?? [];
    return items.map((item) => {
      const cells: Record<string, LevelledCell | undefined> = {};
      for (const s of data?.grid ?? []) {
        cells[s.submissionId] = s.cells.find((c) => c.levellingItemId === item.id);
      }
      return {
        id: item.id,
        itemCode: item.itemCode,
        description: item.description,
        category: item.category,
        isMandatory: item.isMandatory,
        engineersEstimate: item.engineersEstimate,
        currency: item.currency,
        cells,
      };
    });
  }, [data]);

  const contenders = useMemo(
    () => (data?.submissions ?? []).filter((s) => s.inContention),
    [data],
  );

  const rankOf = useMemo(() => {
    const map = new Map<string, number>();
    for (const r of data?.ranking ?? []) map.set(r.submissionId, r.rank);
    return map;
  }, [data]);

  const columns: DataColumns<GridRow> = useMemo(() => {
    const base: DataColumns<GridRow> = [
      {
        id: "item",
        header: "Scope row",
        accessor: (row) => `${row.itemCode ?? ""} ${row.description}`.trim(),
        type: "text",
        width: 300,
        sticky: "start",
        cell: ({ row }) => (
          <div className="min-w-0 py-0.5">
            <p className="truncate font-medium">
              {row.itemCode ? (
                <code className="mr-1.5 font-mono text-2xs text-content-subtle">
                  {row.itemCode}
                </code>
              ) : null}
              {row.description}
            </p>
            <p className="text-2xs text-content-subtle">
              {titleCase(row.category)}
              {row.category === "exclusion_check"
                ? " — carries no price by design; it forces an in-or-out answer"
                : ""}
              {row.isMandatory ? " · mandatory" : " · optional"}
            </p>
          </div>
        ),
      },
      {
        id: "estimate",
        header: "Our estimate",
        accessor: "engineersEstimate",
        type: "currency",
        width: 140,
        align: "right",
        cell: ({ row }) =>
          row.engineersEstimate === null ? (
            <span className="text-2xs text-content-subtle">—</span>
          ) : (
            <span className="tabular-nums">{money(row.engineersEstimate, row.currency)}</span>
          ),
      },
    ];
    const bidderColumns: DataColumns<GridRow> = (data?.submissions ?? []).map((s) => ({
      id: `sub:${s.id}`,
      header: s.vendorName ?? s.reference,
      headerText: s.vendorName ?? s.reference,
      headerTooltip: `${s.reference}${s.inContention ? "" : " — not in contention"}`,
      accessor: (row: GridRow) => row.cells[s.id]?.levelledAmount ?? null,
      width: 230,
      truncate: false,
      cell: ({ row }: { row: GridRow }) => (
        <LevelledCellView
          cell={row.cells[s.id]}
          currency={currency}
          onEdit={() =>
            setEditing({
              submission: s,
              cell: row.cells[s.id],
              itemId: row.id,
              itemLabel: `${row.itemCode ? `${row.itemCode} — ` : ""}${row.description}`,
              priceable: row.category !== "exclusion_check",
            })
          }
        />
      ),
    }));
    return [...base, ...bidderColumns];
  }, [data, currency]);

  if (grid.loading && !data) return <LoadingBlock rows={6} />;
  if (grid.error) return <LoadError message={grid.error} onRetry={grid.reload} />;

  /* ---------------------------------------------------------------- */
  /* Sealed — the grid is withheld in full, and says so                */
  /* ---------------------------------------------------------------- */
  if (data?.sealed) {
    return (
      <div className="space-y-4">
        <EmptyState
          icon={IconLock}
          tone="warning"
          title="The comparison grid is withheld in full"
          hint={
            data.note ??
            "Every cell in this grid is a price, so none of it is returned while the package is sealed."
          }
        />
        <Alert tone="info" variant="subtle" size="sm" title={`${data.items.length} scope rows are defined`}>
          Scope rows can be written before the seal lifts — they are the buyer's own neutral
          description of the work and contain no bidder's price. {data.submissions.length} bid(s)
          are waiting behind the seal.
        </Alert>
        <Button icon={IconPlus} onClick={() => setAddOpen(true)}>
          Add scope rows
        </Button>
        <AddItemsModal
          open={addOpen}
          projectId={projectId}
          packageId={packageId}
          currency={currency}
          onClose={() => setAddOpen(false)}
          onDone={() => {
            setAddOpen(false);
            refresh();
          }}
        />
      </div>
    );
  }

  const complete = data?.complete ?? false;
  const blockers = data?.blockers ?? [];
  const currencies = distinctCurrencies(contenders.map((s) => s.currency));

  async function autoMap() {
    const done = await action.run("automap", () =>
      api.post(`/api/v1/projects/${projectId}/bid-packages/${packageId}/levelling/auto-map`, {}),
    );
    if (done) refresh();
  }

  async function completeLevelling() {
    const done = await action.run("complete", () =>
      api.post(`/api/v1/projects/${projectId}/bid-packages/${packageId}/levelling/complete`, {}),
    );
    if (done) refresh();
  }

  return (
    <div className="space-y-4">
      <RefusalPanel refusal={action.refusal} onDismiss={action.clear} />

      {currencies.length > 1 ? (
        <Alert tone="danger" title="These bids are not in one currency">
          Bids still in contention are priced in {currencies.join(", ")}. Figures in different
          currencies are never summed and never ranked against each other here — no rate is on the
          record, and choosing one would be choosing the winner.
        </Alert>
      ) : null}

      {/* ------------------------------------------------------------ */}
      {/* The comparison, per bidder                                    */}
      {/* ------------------------------------------------------------ */}
      {contenders.length > 0 ? (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {contenders.map((s) => (
            <BidderCard
              key={s.id}
              submission={s}
              levelling={byId.get(s.id)}
              rank={rankOf.get(s.id) ?? null}
              currency={currency}
            />
          ))}
        </div>
      ) : null}

      {/* ------------------------------------------------------------ */}
      {/* Completeness                                                  */}
      {/* ------------------------------------------------------------ */}
      <Alert
        tone={complete ? "success" : "warning"}
        icon={complete ? IconTarget : IconWarning}
        title={
          complete
            ? "The comparison is complete and may be relied on"
            : `The comparison is not complete — ${blockers.length} thing${blockers.length === 1 ? "" : "s"} block it`
        }
        actions={
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="ghost" icon={IconZap} onClick={() => void autoMap()} loading={action.busy === "automap"}>
              Auto-map priced lines
            </Button>
            <Button size="sm" variant="secondary" icon={IconPlus} onClick={() => setAddOpen(true)}>
              Add scope rows
            </Button>
            <Button
              size="sm"
              onClick={() => void completeLevelling()}
              loading={action.busy === "complete"}
              disabled={!complete}
            >
              Declare levelling complete
            </Button>
          </div>
        }
      >
        {complete ? (
          <p>
            Every bidder still in contention has answered every mandatory scope row. Completing the
            levelling freezes each bidder&rsquo;s levelled amount onto their submission as the
            figure the award is measured against.
          </p>
        ) : (
          <>
            <p>
              Each one is a bidder still in contention who has not answered a mandatory scope row,
              so comparing them would be comparing different scopes. Auto-mapping deliberately does
              not fix these: it maps an excluded line as an exclusion with NO adjustment, which
              leaves the row uncovered until somebody prices what buying that scope elsewhere
              costs.
            </p>
            <ReasonList reasons={blockers} tone="warning" className="mt-2" />
          </>
        )}
      </Alert>

      {/* ------------------------------------------------------------ */}
      {/* The grid                                                      */}
      {/* ------------------------------------------------------------ */}
      {rows.length === 0 ? (
        <EmptyState
          icon={IconTarget}
          title="No scope rows have been defined"
          hint="There is nothing to compare bidders on until the buyer states the neutral scope rows. A row is what the buyer says the work is; the bidders' answers are mapped onto it, and the difference between the two is what levelling prices."
          action={
            <Button icon={IconPlus} onClick={() => setAddOpen(true)}>
              Add scope rows
            </Button>
          }
        />
      ) : data?.submissions.length === 0 ? (
        <EmptyState
          title="Scope rows are defined, but no bid has arrived"
          hint="The grid compares bidders against these rows. Until a bid is recorded there is one column and nothing to put in it."
        />
      ) : (
        <DataTable<GridRow>
          /*
           * No `tableId`, deliberately: the columns of this grid ARE the bidders
           * on one package, so a saved layout or view keyed by table would carry
           * column ids from a different tender.
           */
          data={rows}
          columns={columns}
          getRowId={(row) => row.id}
          height={560}
          rowHeight={96}
          stickyHeader
          gridLines
          searchPlaceholder="Search scope rows…"
          exportFileName="levelling-grid"
          rowTone={(row) =>
            Object.values(row.cells).some(
              (c) => c && c.priceable && !c.covered && c.includedStatus === "excluded",
            )
              ? "danger"
              : undefined
          }
          empty={{
            title: "No scope rows match",
            description: "Every scope row is filtered out by the current filters.",
          }}
        />
      )}

      <CellEditor
        editing={editing}
        projectId={projectId}
        packageId={packageId}
        currency={currency}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          refresh();
        }}
      />

      <AddItemsModal
        open={addOpen}
        projectId={projectId}
        packageId={packageId}
        currency={currency}
        onClose={() => setAddOpen(false)}
        onDone={() => {
          setAddOpen(false);
          refresh();
        }}
      />
    </div>
  );
}

/* ================================================================== */
/* One cell of the grid                                                */
/* ================================================================== */

function LevelledCellView({
  cell,
  currency,
  onEdit,
}: {
  cell: LevelledCell | undefined;
  currency: string;
  onEdit: () => void;
}) {
  if (!cell) {
    return (
      <button
        type="button"
        onClick={onEdit}
        className="w-full rounded px-1 py-1 text-left text-2xs italic text-content-subtle hover:bg-surface-hover"
      >
        no answer recorded — silence is not agreement
      </button>
    );
  }

  const failing = cell.priceable && cell.levelledAmount === null;
  const danger = failing && cell.includedStatus === "excluded";

  return (
    <button
      type="button"
      onClick={onEdit}
      className={cx(
        "w-full rounded-md px-1.5 py-1 text-left transition-colors hover:bg-surface-hover",
        danger ? "bg-danger-subtle/60" : failing ? "bg-warning-subtle/50" : undefined,
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <Badge tone={INCLUSION_TONE[cell.includedStatus] ?? "neutral"} size="xs" variant="subtle">
          {INCLUSION_LABEL[cell.includedStatus] ?? cell.includedStatus}
        </Badge>
        {cell.priceable ? (
          cell.levelledAmount === null ? (
            <span className={cx("text-2xs font-semibold", danger ? "text-danger-fg" : "text-warning-fg")}>
              no comparable figure
            </span>
          ) : (
            <span className="tabular-nums text-sm font-semibold">
              {money(cell.levelledAmount, cell.currency || currency)}
            </span>
          )
        ) : (
          <span className="text-2xs text-content-subtle">
            {cell.covered ? "answered" : "no answer"}
          </span>
        )}
      </div>

      {cell.priceable && cell.levelledAmount !== null ? (
        <p className="mt-0.5 text-2xs tabular-nums text-content-subtle">
          as bid {cell.asBidAmount === null ? "—" : money(cell.asBidAmount, cell.currency || currency)}
          {Math.abs(cell.adjustmentAmount) > 0.005 ? (
            <>
              {" · adj "}
              {money(cell.adjustmentAmount, cell.currency || currency)}
              {cell.adjustmentReason ? ` (${titleCase(cell.adjustmentReason)})` : ""}
            </>
          ) : null}
        </p>
      ) : null}

      {cell.reasons.length > 0 ? (
        <p
          className={cx(
            "mt-0.5 whitespace-normal text-2xs leading-snug",
            danger ? "text-danger-fg" : "text-content-muted",
          )}
        >
          {cell.reasons[0]}
        </p>
      ) : null}
    </button>
  );
}

/* ================================================================== */
/* One bidder's comparison                                             */
/* ================================================================== */

function BidderCard({
  submission,
  levelling,
  rank,
  currency,
}: {
  submission: ComparisonSubmission;
  levelling: SubmissionLevelling | undefined;
  rank: number | null;
  currency: string;
}) {
  const total = levelling?.levelledTotal;
  const usable = total && total.value !== null;
  const exclusionGaps = (levelling?.cells ?? []).filter(
    (c) => c.priceable && !c.covered && c.includedStatus === "excluded",
  );

  return (
    <Card accent={usable ? (rank === 1 ? "success" : undefined) : "warning"}>
      <CardBody className="space-y-2">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">
              {submission.vendorName ?? submission.reference}
            </p>
            <p className="text-2xs text-content-subtle">
              {submission.reference} · {titleCase(submission.status)}
            </p>
          </div>
          {rank !== null ? (
            <Badge tone={rank === 1 ? "success" : "neutral"} size="sm">
              #{rank} on levelled price
            </Badge>
          ) : null}
        </div>

        <div>
          <div className="text-label uppercase text-content-subtle">Levelled total</div>
          {usable ? (
            <div className="text-xl font-semibold tabular-nums">
              {money(total!.value, levelling?.currency ?? currency)}
            </div>
          ) : (
            <>
              <div className="text-base font-medium italic text-content-subtle">not available</div>
              <ReasonList
                reasons={total?.reasons ?? ["This bidder has not been levelled."]}
                tone="warning"
                className="mt-1"
              />
            </>
          )}
        </div>

        <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-2xs">
          <dt className="text-content-subtle">As bid, over these rows</dt>
          <dd className="text-right tabular-nums">
            {levelling?.asBidSubtotal.value === null || !levelling
              ? "—"
              : money(levelling.asBidSubtotal.value, levelling.currency ?? currency)}
          </dd>
          <dt className="text-content-subtle">Adjustments</dt>
          <dd className="text-right tabular-nums">
            {levelling?.adjustmentSubtotal.value === null || !levelling
              ? "—"
              : money(levelling.adjustmentSubtotal.value, levelling.currency ?? currency)}
          </dd>
          <dt className="text-content-subtle">Rows answered</dt>
          <dd className="text-right tabular-nums">
            {levelling ? `${levelling.itemsCovered} / ${levelling.itemsTotal}` : "—"}
          </dd>
          <dt className="text-content-subtle">Mandatory answered</dt>
          <dd className="text-right tabular-nums">
            {levelling ? `${levelling.mandatoryCovered} / ${levelling.mandatoryTotal}` : "—"}
          </dd>
        </dl>

        {exclusionGaps.length > 0 ? (
          <Alert tone="danger" variant="subtle" size="sm" title="Excluded, and priced at nothing">
            <p>
              {exclusionGaps.length} scope row{exclusionGaps.length === 1 ? " is" : "s are"} excluded
              by this bidder with no adjustment against{" "}
              {exclusionGaps.length === 1 ? "it" : "them"}. Left like this the comparison treats
              the missing scope as free — which is exactly how the bidder who excluded the most
              becomes the cheapest.
            </p>
            <ul className="mt-1 space-y-0.5">
              {exclusionGaps.slice(0, 4).map((c) => (
                <li key={c.levellingItemId} className="text-2xs">
                  {c.itemCode ? `${c.itemCode} — ` : ""}
                  {c.description}
                </li>
              ))}
              {exclusionGaps.length > 4 ? (
                <li className="text-2xs text-content-subtle">
                  +{exclusionGaps.length - 4} more
                </li>
              ) : null}
            </ul>
          </Alert>
        ) : null}
      </CardBody>
    </Card>
  );
}

/* ================================================================== */
/* Cell editor                                                         */
/* ================================================================== */

function CellEditor({
  editing,
  projectId,
  packageId,
  currency,
  onClose,
  onSaved,
}: {
  editing: {
    submission: ComparisonSubmission;
    cell: LevelledCell | undefined;
    itemId: string;
    itemLabel: string;
    priceable: boolean;
  } | null;
  projectId: string;
  packageId: string;
  currency: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const action = useAction();
  const [status, setStatus] = useState<string>("included");
  const [asBid, setAsBid] = useState("");
  const [adjustment, setAdjustment] = useState("");
  const [reason, setReason] = useState<string>("");
  const [note, setNote] = useState("");
  const [loadedFor, setLoadedFor] = useState<string | null>(null);

  const key = editing ? `${editing.itemId}:${editing.submission.id}` : null;
  if (key && key !== loadedFor) {
    setLoadedFor(key);
    setStatus(editing?.cell?.includedStatus ?? "included");
    setAsBid(editing?.cell?.asBidAmount != null ? String(editing.cell.asBidAmount) : "");
    setAdjustment(
      editing?.cell?.adjustmentAmount != null && editing.cell.adjustmentAmount !== 0
        ? String(editing.cell.adjustmentAmount)
        : "",
    );
    setReason(editing?.cell?.adjustmentReason ?? "");
    setNote("");
  }

  const adjustmentValue = adjustment.trim() ? Number(adjustment) : 0;
  const needsReason = Math.abs(adjustmentValue) > 0.005 && !reason;

  async function save() {
    if (!editing) return;
    const body: Record<string, unknown> = {
      levellingItemId: editing.itemId,
      submissionId: editing.submission.id,
      includedStatus: status,
      adjustmentAmount: adjustmentValue,
      currency,
    };
    body["asBidAmount"] = asBid.trim() ? Number(asBid) : null;
    if (reason) body["adjustmentReason"] = reason;
    if (note.trim()) body["adjustmentNote"] = note.trim();
    const done = await action.run("cell", () =>
      api.post(`/api/v1/projects/${projectId}/bid-packages/${packageId}/levelling/entries`, {
        entries: [body],
      }),
    );
    if (done) onSaved();
  }

  const guidance: Record<string, string> = {
    included:
      "An 'included' row needs an amount. “Included” with no figure is a claim about scope, not a price that can be compared.",
    partially_included:
      "A partial inclusion needs BOTH an amount and a non-zero adjustment. Levelled at its face value it has not been levelled at all — price the missing part.",
    excluded:
      "An exclusion is levelled at the ADJUSTMENT alone: what buying this scope elsewhere costs. Zero adjustment yields no figure, because an exclusion priced at nothing silently makes the cheapest bidder whoever excluded the most.",
    unclear:
      "Unclear yields no figure and no guess. Raise a tender query and record the answer — an assumption made here decides the award on our guess, not their price.",
    not_priced: "The bidder did not price this row. No figure is produced.",
  };

  return (
    <Modal
      open={editing !== null}
      onClose={onClose}
      size="lg"
      title={editing ? `${editing.submission.vendorName ?? editing.submission.reference}` : "Levelling"}
      description={editing?.itemLabel}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void save()} loading={action.busy === "cell"} disabled={needsReason}>
            Save the answer
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <RefusalPanel refusal={action.refusal} onDismiss={action.clear} />

        {editing && !editing.priceable ? (
          <Alert tone="info" variant="subtle" size="sm" title="An in-or-out check">
            This row carries no price by design. It exists only to force a definite answer, and is
            &ldquo;covered&rdquo; when the bidder has said definitely in or definitely out.
          </Alert>
        ) : null}

        <Field label="What did this bidder do with this scope?" required>
          <Select value={status} onChange={(e) => setStatus(e.target.value)}>
            {LEVELLING_INCLUSIONS.map((s) => (
              <option key={s} value={s}>
                {INCLUSION_LABEL[s] ?? s}
              </option>
            ))}
          </Select>
        </Field>

        <Alert tone="neutral" variant="subtle" size="sm">
          {guidance[status] ?? ""}
        </Alert>

        {editing?.priceable ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label={`As bid (${currency})`}
              hint="The number the bidder actually wrote against this scope."
            >
              <Input
                type="number"
                inputMode="decimal"
                value={asBid}
                onChange={(e) => setAsBid(e.target.value)}
              />
            </Field>
            <Field
              label={`Adjustment (${currency})`}
              hint="What must be added to make this comparable with the others."
            >
              <Input
                type="number"
                inputMode="decimal"
                value={adjustment}
                onChange={(e) => setAdjustment(e.target.value)}
              />
            </Field>
          </div>
        ) : null}

        {editing?.priceable ? (
          <Field
            label="Why the comparable number differs from the number the bidder wrote"
            required={Math.abs(adjustmentValue) > 0.005}
            error={
              needsReason
                ? "An unexplained adjustment is an opinion, and the losing bidder's challenge to it succeeds. The API refuses it."
                : null
            }
          >
            <Select value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Choose a reason">
              {LEVELLING_ADJUSTMENT_REASONS.map((r) => (
                <option key={r} value={r}>
                  {titleCase(r)}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}

        <Field label="Note" optional hint="Anything the coded reason cannot carry.">
          <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>

        {editing?.cell && editing.cell.reasons.length > 0 ? (
          <ReasonList
            reasons={editing.cell.reasons}
            heading="Why this cell currently produces no figure"
            tone="warning"
          />
        ) : null}
      </div>
    </Modal>
  );
}

/* ================================================================== */
/* Scope rows                                                          */
/* ================================================================== */

function AddItemsModal({
  open,
  projectId,
  packageId,
  currency,
  onClose,
  onDone,
}: {
  open: boolean;
  projectId: string;
  packageId: string;
  currency: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const action = useAction();
  const [itemCode, setItemCode] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState<string>("base_scope");
  const [estimate, setEstimate] = useState("");
  const [mandatory, setMandatory] = useState(true);

  const priceable = category !== "exclusion_check";

  async function submit() {
    const body: Record<string, unknown> = {
      description: description.trim(),
      category,
      isMandatory: mandatory,
      currency,
    };
    if (itemCode.trim()) body["itemCode"] = itemCode.trim();
    if (priceable && estimate.trim()) body["engineersEstimate"] = Number(estimate);
    const done = await action.run("item", () =>
      api.post(`/api/v1/projects/${projectId}/bid-packages/${packageId}/levelling/items`, {
        items: [body],
      }),
    );
    if (done) {
      setItemCode("");
      setDescription("");
      setEstimate("");
      onDone();
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add a scope row"
      description="The buyer's own neutral description of the work. Every bidder is mapped onto it."
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => void submit()}
            loading={action.busy === "item"}
            disabled={description.trim().length === 0}
          >
            Add the row
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <RefusalPanel refusal={action.refusal} onDismiss={action.clear} />
        <div className="grid gap-3 sm:grid-cols-[10rem_1fr]">
          <Field label="Code" optional hint="Matches bid lines on auto-map.">
            <Input value={itemCode} onChange={(e) => setItemCode(e.target.value)} />
          </Field>
          <Field label="Description" required>
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Access scaffold to the north elevation"
            />
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Category">
            <Select value={category} onChange={(e) => setCategory(e.target.value)}>
              {LEVELLING_ITEM_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {titleCase(c)}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label={`Our estimate (${currency})`}
            optional
            disabled={!priceable}
            hint={
              priceable
                ? "What we think this scope is worth."
                : "An exclusion check carries no price by design — it exists only to force an in-or-out answer."
            }
          >
            <Input
              type="number"
              inputMode="decimal"
              value={estimate}
              disabled={!priceable}
              onChange={(e) => setEstimate(e.target.value)}
            />
          </Field>
        </div>
        <label className="flex items-start gap-2 text-meta">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={mandatory}
            onChange={(e) => setMandatory(e.target.checked)}
          />
          <span>
            Mandatory. A bidder still in contention who leaves a mandatory row unanswered blocks the
            comparison from being declared complete, and is named when it refuses.
          </span>
        </label>
      </div>
    </Modal>
  );
}
