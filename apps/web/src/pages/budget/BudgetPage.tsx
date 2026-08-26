/**
 * BUDGET workspace — spec Vol I §3.1 / module M2. Routed at
 * /projects/:projectId/budget.
 *
 * The cost-control screen a project manager lives in all day, laid out the way
 * the money actually moves:
 *
 *   Summary   the six figures, and the bridge from original budget to forecast
 *   Grid      the cost report itself — dense, grouped, editable, exportable
 *   Changes   the only way money moves after lock, with its approval trail
 *   Snapshots immutable period captures and the diff between any two
 *   Forecast  what each line will cost, and BY WHICH METHOD
 *   Import    bulk line intake, validated before a single row is written
 *
 * The workspace is scoped to ONE budget at a time and every figure on screen is
 * denominated in that budget's currency. Where a project holds budgets in more
 * than one currency they are listed as separate totals; nothing here ever adds
 * a euro to a dollar.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import {
  Badge,
  Button,
  Card,
  CardBody,
  Checkbox,
  DropdownMenu,
  EmptyState,
  ErrorAlert,
  Field,
  Input,
  Modal,
  Select,
  Skeleton,
  Tabs,
  Textarea,
  useConfirm,
} from "../../ui";
import type { MenuItemSpec } from "../../ui";
import { IconBudget, IconEdit, IconMore, IconPlus, IconRefresh } from "../../ui/icons";
import { api } from "../../lib/api";
import ChangesTab from "./ChangesTab";
import ForecastTab from "./ForecastTab";
import GridTab from "./GridTab";
import ImportTab from "./ImportTab";
import SnapshotsTab from "./SnapshotsTab";
import SummaryHeader from "./SummaryHeader";
import {
  BUDGET_STATUS_TONE,
  LoadError,
  ReasonList,
  RefusalNotice,
  count,
  dateTime,
  errorMessage,
  errorReasons,
  groupByCurrency,
  labelize,
  money,
  useCompanyUsers,
  useResource,
  type BudgetDetail,
  type BudgetRecord,
  type BudgetSummary,
  type ListResponse,
  type RecalculateResult,
} from "./budgetShared";

type TabKey = "grid" | "changes" | "snapshots" | "forecast" | "import";

const TABS: Array<{ value: TabKey; label: string }> = [
  { value: "grid", label: "Budget grid" },
  { value: "changes", label: "Changes & transfers" },
  { value: "snapshots", label: "Snapshots" },
  { value: "forecast", label: "Forecasting" },
  { value: "import", label: "Import" },
];

const isTabKey = (value: string | null): value is TabKey =>
  value !== null && TABS.some((tab) => tab.value === value);

export default function BudgetPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const projectKey = projectId ?? "";
  const users = useCompanyUsers();
  const { confirm, dialog } = useConfirm();

  const [searchParams, setSearchParams] = useSearchParams();
  const [tab, setTab] = useState<TabKey>(() => {
    const requested = searchParams.get("tab");
    return isTabKey(requested) ? requested : "grid";
  });
  const [budgetId, setBudgetId] = useState<string>(() => searchParams.get("budget") ?? "");
  /** Bumped by any write anywhere in the workspace; every read depends on it. */
  const [version, setVersion] = useState(0);
  const refresh = useCallback(() => setVersion((n) => n + 1), []);

  const [actionError, setActionError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<{ title: string; message: string; reasons: string[] } | null>(
    null,
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [recalcResult, setRecalcResult] = useState<RecalculateResult | null>(null);

  const budgets = useResource<ListResponse<BudgetRecord>>(
    (signal) =>
      api.get<ListResponse<BudgetRecord>>(
        `/api/v1/projects/${projectKey}/budgets?page=1&pageSize=200`,
        { signal },
      ),
    [projectKey, version],
    projectKey !== "",
  );

  const items = useMemo(() => budgets.data?.items ?? [], [budgets.data]);

  useEffect(() => {
    if (items.length === 0) return;
    if (items.some((budget) => budget.id === budgetId)) return;
    const preferred = items.find((budget) => budget.isActive === 1) ?? items[0];
    if (preferred) setBudgetId(preferred.id);
  }, [items, budgetId]);

  const detail = useResource<BudgetDetail>(
    (signal) => api.get<BudgetDetail>(`/api/v1/budgets/${budgetId}`, { signal }),
    [budgetId, version],
    budgetId !== "",
  );

  const summary = useResource<BudgetSummary>(
    (signal) => api.get<BudgetSummary>(`/api/v1/budgets/${budgetId}/summary`, { signal }),
    [budgetId, version],
    budgetId !== "",
  );

  const budget = detail.data;
  const currency = budget?.currency ?? "USD";
  const currencyGroups = useMemo(() => groupByCurrency(items), [items]);

  const selectTab = useCallback(
    (next: TabKey) => {
      setTab(next);
      const params = new URLSearchParams(searchParams);
      params.set("tab", next);
      setSearchParams(params, { replace: true });
    },
    [searchParams, setSearchParams],
  );

  const selectBudget = useCallback(
    (next: string) => {
      setBudgetId(next);
      const params = new URLSearchParams(searchParams);
      params.set("budget", next);
      setSearchParams(params, { replace: true });
    },
    [searchParams, setSearchParams],
  );

  /**
   * Every budget-level write goes through here so a refusal is presented the
   * same way everywhere: the server's own wording, never a paraphrase, and a
   * deliberate refusal (403 / 409) framed as the control working rather than
   * as a fault.
   */
  const runAction = useCallback(
    async (key: string, action: () => Promise<void>, refusalTitle: string) => {
      setBusy(key);
      setActionError(null);
      setRefusal(null);
      try {
        await action();
        refresh();
      } catch (err) {
        const status = (err as { status?: number }).status;
        if (status === 403 || status === 409 || status === 400) {
          setRefusal({
            title: refusalTitle,
            message: errorMessage(err, "The platform refused this action."),
            reasons: errorReasons(err),
          });
        } else {
          setActionError(errorMessage(err, "That action could not be completed"));
        }
      } finally {
        setBusy(null);
      }
    },
    [refresh],
  );

  const recalculate = useCallback(async () => {
    if (!budget) return;
    setBusy("recalculate");
    setActionError(null);
    try {
      const result = await api.post<RecalculateResult>(
        `/api/v1/budgets/${budget.id}/recalculate`,
        {},
      );
      setRecalcResult(result);
      refresh();
    } catch (err) {
      setActionError(errorMessage(err, "The budget could not be recalculated"));
    } finally {
      setBusy(null);
    }
  }, [budget, refresh]);

  const menuItems = useMemo<MenuItemSpec[]>(() => {
    if (!budget) return [];
    return [
      { type: "label", label: budget.reference },
      {
        id: "edit",
        label: "Rename or re-describe",
        icon: IconEdit,
        disabled: budget.status === "closed",
        onSelect: () => setEditOpen(true),
      },
      {
        id: "recalculate",
        label: "Recalculate from source tools",
        icon: IconRefresh,
        description: "Re-reads commitments and invoices; a component with no source is skipped, never zeroed.",
        onSelect: () => void recalculate(),
      },
      {
        id: "activate",
        label: "Make this the active budget",
        disabled: budget.isActive === 1 || budget.status === "closed",
        onSelect: () =>
          void runAction(
            "activate",
            async () => {
              await api.post(`/api/v1/budgets/${budget.id}/activate`, {});
            },
            "This budget cannot be made active",
          ),
      },
      { type: "separator" },
      {
        id: "lock",
        label: "Lock the budget",
        description: "Freezes the original budget. After this, money moves only through an approved change.",
        disabled: Boolean(budget.lockedAt) || budget.status === "closed",
        onSelect: () =>
          void (async () => {
            const ok = await confirm({
              title: `Lock ${budget.reference}?`,
              description:
                "Locking freezes the plan amounts. From then on the only way to move money on this budget is an approved budget change, approved by somebody other than the person who requested it. This cannot be undone.",
              confirmLabel: "Lock budget",
              tone: "warning",
            });
            if (!ok) return;
            await runAction(
              "lock",
              async () => {
                await api.post(`/api/v1/budgets/${budget.id}/lock`, {});
              },
              "This budget cannot be locked",
            );
          })(),
      },
      {
        id: "close",
        label: "Close the budget",
        destructive: true,
        disabled: budget.status === "closed",
        onSelect: () =>
          void (async () => {
            const ok = await confirm({
              title: `Close ${budget.reference}?`,
              description:
                "A closed budget can no longer be edited, changed, or re-forecast. Any budget change still in draft or pending approval must be resolved first.",
              confirmLabel: "Close budget",
              destructive: true,
            });
            if (!ok) return;
            await runAction(
              "close",
              async () => {
                await api.post(`/api/v1/budgets/${budget.id}/close`, {});
              },
              "This budget cannot be closed",
            );
          })(),
      },
      {
        id: "delete",
        label: "Delete the budget",
        destructive: true,
        disabled: budget.status !== "draft" || Boolean(budget.lockedAt),
        onSelect: () =>
          void (async () => {
            const ok = await confirm({
              title: `Delete ${budget.reference}?`,
              description:
                "Every line, change and forecast on this budget is deleted with it. Only a draft, unlocked budget with no period capture can be deleted.",
              confirmLabel: "Delete budget",
              destructive: true,
              confirmationText: budget.reference,
              confirmationLabel: `Type ${budget.reference} to confirm`,
            });
            if (!ok) return;
            await runAction(
              "delete",
              async () => {
                await api.del(`/api/v1/budgets/${budget.id}`);
                setBudgetId("");
              },
              "This budget cannot be deleted",
            );
          })(),
      },
    ];
  }, [budget, confirm, recalculate, runAction]);

  if (!projectId) {
    return (
      <EmptyState
        title="No project in the URL"
        hint="The budget workspace is project-scoped. Open it from a project."
      />
    );
  }

  return (
    <div>
      <PageTitle
        budget={budget}
        loading={detail.loading}
        budgets={items}
        budgetId={budgetId}
        onSelectBudget={selectBudget}
        menuItems={menuItems}
        onNew={() => setCreateOpen(true)}
        busy={busy !== null}
      />

      {budgets.error ? (
        <div className="mb-4">
          <LoadError
            message={budgets.error}
            onRetry={budgets.reload}
            title="The project's budgets could not be loaded"
          />
        </div>
      ) : null}

      <ErrorAlert message={actionError} onDismiss={() => setActionError(null)} />

      {refusal ? (
        <div className="mb-3">
          <RefusalNotice
            title={refusal.title}
            message={refusal.message}
            reasons={refusal.reasons}
            onDismiss={() => setRefusal(null)}
          />
        </div>
      ) : null}

      {recalcResult ? (
        <div className="mb-3">
          <Card variant="sunken">
            <CardBody>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-body text-content">
                  Recalculated {count(recalcResult.updatedLines)} line
                  {recalcResult.updatedLines === 1 ? "" : "s"} from the source tools.
                </p>
                <Button size="xs" variant="ghost" onClick={() => setRecalcResult(null)}>
                  Dismiss
                </Button>
              </div>
              {recalcResult.skipped.length > 0 ? (
                <div className="mt-2">
                  <p className="text-meta font-semibold text-content">
                    Left alone rather than zeroed:
                  </p>
                  {recalcResult.skipped.map((entry) => (
                    <div key={entry.component} className="mt-1.5">
                      <p className="text-meta font-medium text-content-muted">{entry.component}</p>
                      <ReasonList reasons={entry.reasons} />
                    </div>
                  ))}
                </div>
              ) : null}
            </CardBody>
          </Card>
        </div>
      ) : null}

      {currencyGroups.length > 1 ? (
        <Card variant="sunken" className="mb-4">
          <CardBody>
            <p className="text-label uppercase text-content-subtle">
              This project holds budgets in {currencyGroups.length} currencies
            </p>
            <div className="mt-2 flex flex-wrap gap-4">
              {currencyGroups.map((group) => (
                <div key={group.currency} className="min-w-40">
                  <p className="text-meta font-semibold text-content">{group.currency}</p>
                  <p className="text-body tabular-nums text-content">
                    {money(
                      group.items.reduce((sum, item) => sum + item.revisedBudgetTotal, 0),
                      group.currency,
                    )}
                  </p>
                  <p className="text-meta text-content-subtle">
                    {group.items.length} budget{group.items.length === 1 ? "" : "s"}
                  </p>
                </div>
              ))}
            </div>
            <p className="mt-2 text-meta text-content-muted">
              Totals are stated per currency and never combined — this platform holds no exchange
              rate, and inventing one would be a fabrication.
            </p>
          </CardBody>
        </Card>
      ) : null}

      {budgets.loading && items.length === 0 ? (
        <div className="space-y-3">
          <Skeleton height={104} />
          <Skeleton height={280} />
        </div>
      ) : items.length === 0 && !budgets.error ? (
        <EmptyState
          icon={IconBudget}
          title="This project has no budget yet"
          hint="A budget is the root of construction financial management: every commitment, change order and invoice on this project reconciles back to one of its lines."
          action={
            <Button leadingIcon={IconPlus} onClick={() => setCreateOpen(true)}>
              Create the first budget
            </Button>
          }
        />
      ) : (
        <>
          {detail.error ? (
            <div className="mb-4">
              <LoadError
                message={detail.error}
                onRetry={detail.reload}
                title="This budget could not be loaded"
              />
            </div>
          ) : null}

          <SummaryHeader
            budget={budget}
            summary={summary.data}
            loading={summary.loading || detail.loading}
            error={summary.error}
            onRetry={summary.reload}
            onRecalculate={() => void recalculate()}
            recalculating={busy === "recalculate"}
          />

          <div className="mb-4">
            <Tabs items={TABS} value={tab} onChange={selectTab} aria-label="Budget sections" />
          </div>

          {budget === null ? (
            <Skeleton height={320} />
          ) : tab === "grid" ? (
            <GridTab
              budget={budget}
              currency={currency}
              users={users}
              summary={summary.data}
              version={version}
              onChanged={refresh}
            />
          ) : tab === "changes" ? (
            <ChangesTab
              budget={budget}
              currency={currency}
              users={users}
              version={version}
              onChanged={refresh}
            />
          ) : tab === "snapshots" ? (
            <SnapshotsTab
              budget={budget}
              currency={currency}
              users={users}
              version={version}
              onChanged={refresh}
            />
          ) : tab === "forecast" ? (
            <ForecastTab
              budget={budget}
              currency={currency}
              users={users}
              version={version}
              onChanged={refresh}
            />
          ) : (
            <ImportTab budget={budget} currency={currency} onChanged={refresh} />
          )}
        </>
      )}

      <EditBudgetModal
        open={editOpen && budget !== null}
        budget={budget}
        onClose={() => setEditOpen(false)}
        onSaved={() => {
          setEditOpen(false);
          refresh();
        }}
      />

      <NewBudgetModal
        open={createOpen}
        projectId={projectKey}
        onClose={() => setCreateOpen(false)}
        onCreated={(created) => {
          setCreateOpen(false);
          selectBudget(created.id);
          refresh();
        }}
      />

      {dialog}
    </div>
  );
}

/* ========================================================================== */
/* Header                                                                      */
/* ========================================================================== */

function PageTitle({
  budget,
  loading,
  budgets,
  budgetId,
  onSelectBudget,
  menuItems,
  onNew,
  busy,
}: {
  budget: BudgetDetail | null;
  loading: boolean;
  budgets: readonly BudgetRecord[];
  budgetId: string;
  onSelectBudget: (id: string) => void;
  menuItems: MenuItemSpec[];
  onNew: () => void;
  busy: boolean;
}) {
  return (
    <div className="mb-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <span className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-lg border border-border bg-surface-raised text-content-muted shadow-e0">
            <IconBudget size={18} />
          </span>
          <div className="min-w-0">
            <h1 className="truncate text-xl font-semibold tracking-[-0.012em] text-content">
              Budget
            </h1>
            <p className="mt-0.5 text-body text-content-muted">
              The cost report every commitment, change order and invoice on this project
              reconciles back to.
            </p>
            {budget ? (
              <div className="mt-2 flex flex-wrap items-center gap-2 text-meta text-content-subtle">
                <Badge tone={BUDGET_STATUS_TONE[budget.status]} size="sm" dot>
                  {labelize(budget.status)}
                </Badge>
                {budget.isActive === 1 ? (
                  <Badge tone="accent" size="sm">
                    Active budget
                  </Badge>
                ) : null}
                <Badge tone="neutral" size="sm" variant="outline">
                  {budget.currency}
                </Badge>
                <span>{count(budget.lineCount)} lines</span>
                {budget.lockedAt ? <span>· Locked {dateTime(budget.lockedAt)}</span> : null}
                {budget.lastSnapshot ? (
                  <span>
                    · Captured as at {budget.lastSnapshot.asOfDate} ({budget.lastSnapshot.reference})
                  </span>
                ) : null}
                {budget.planEditable ? null : (
                  <Badge tone="warning" size="sm">
                    Plan amounts frozen
                  </Badge>
                )}
              </div>
            ) : loading ? (
              <div className="mt-2">
                <Skeleton height={18} width={280} />
              </div>
            ) : null}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {budgets.length > 0 ? (
            <Select
              value={budgetId}
              onChange={(event) => onSelectBudget(event.target.value)}
              aria-label="Budget"
              className="min-w-56"
            >
              {budgets.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.reference} · {option.name} ({option.currency})
                  {option.isActive === 1 ? " — active" : ""}
                </option>
              ))}
            </Select>
          ) : null}
          <Button variant="secondary" leadingIcon={IconPlus} onClick={onNew}>
            New budget
          </Button>
          {budget ? (
            <DropdownMenu
              items={menuItems}
              placement="bottom-end"
              trigger={
                <Button variant="ghost" iconOnly aria-label="Budget actions" loading={busy}>
                  <IconMore size={16} />
                </Button>
              }
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}

/* ========================================================================== */
/* New budget                                                                  */
/* ========================================================================== */

function NewBudgetModal({
  open,
  projectId,
  onClose,
  onCreated,
}: {
  open: boolean;
  projectId: string;
  onClose: () => void;
  onCreated: (budget: BudgetRecord) => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [makeActive, setMakeActive] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName("");
    setDescription("");
    setCurrency("USD");
    setMakeActive(true);
    setError(null);
  }, [open]);

  async function submit() {
    if (name.trim() === "") {
      setError("A budget needs a name.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const created = await api.post<BudgetRecord>(`/api/v1/projects/${projectId}/budgets`, {
        name: name.trim(),
        description: description.trim() === "" ? null : description.trim(),
        currency: currency.trim().toUpperCase(),
        isActive: makeActive,
      });
      onCreated(created);
    } catch (err) {
      setError(errorMessage(err, "The budget could not be created"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New budget"
      description="A budget is denominated in one currency, and the stored amounts are never converted."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} loading={saving}>
            Create budget
          </Button>
        </>
      }
    >
      <ErrorAlert message={error} />
      <div className="space-y-3">
        <Field label="Name" required>
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Construction budget — GMP"
            autoFocus
          />
        </Field>
        <Field label="Description" optional>
          <Textarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            rows={3}
          />
        </Field>
        <Field
          label="Currency"
          hint="Cannot be changed once the budget holds lines — the stored amounts are denominated in it."
        >
          <Input
            value={currency}
            onChange={(event) => setCurrency(event.target.value)}
            maxLength={8}
            className="max-w-32"
          />
        </Field>
        <Checkbox
          checked={makeActive}
          onChange={(event) => setMakeActive(event.target.checked)}
          label="Make this the project's active budget"
          description="Exactly one budget per project is active, and it is the one every rollup reads."
        />
      </div>
    </Modal>
  );
}

/* ========================================================================== */
/* Edit budget                                                                 */
/* ========================================================================== */

function EditBudgetModal({
  open,
  budget,
  onClose,
  onSaved,
}: {
  open: boolean;
  budget: BudgetDetail | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [currency, setCurrency] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !budget) return;
    setName(budget.name);
    setDescription(budget.description ?? "");
    setCurrency(budget.currency);
    setError(null);
  }, [open, budget]);

  if (!budget) return null;

  const currencyLocked = budget.lineCount > 0;

  async function submit() {
    if (!budget) return;
    if (name.trim() === "") {
      setError("A budget needs a name.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        name: name.trim(),
        description: description.trim() === "" ? null : description.trim(),
      };
      if (!currencyLocked && currency.trim().toUpperCase() !== budget.currency) {
        body["currency"] = currency.trim().toUpperCase();
      }
      await api.patch(`/api/v1/budgets/${budget.id}`, body);
      onSaved();
    } catch (err) {
      setError(errorMessage(err, "The budget could not be updated"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Edit ${budget.reference}`}
      description="Naming only. Amounts move through the grid, a budget change, or a forecast — never here."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} loading={saving}>
            Save
          </Button>
        </>
      }
    >
      <ErrorAlert message={error} />
      <div className="space-y-3">
        <Field label="Name" required>
          <Input value={name} onChange={(event) => setName(event.target.value)} autoFocus />
        </Field>
        <Field label="Description" optional>
          <Textarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            rows={3}
          />
        </Field>
        <Field
          label="Currency"
          hint={
            currencyLocked
              ? `Locked: this budget holds ${count(budget.lineCount)} lines, and the stored amounts are denominated in ${budget.currency}. They are never converted implicitly.`
              : "Changeable only while the budget holds no lines."
          }
        >
          <Input
            value={currency}
            onChange={(event) => setCurrency(event.target.value)}
            disabled={currencyLocked}
            maxLength={8}
            className="max-w-32"
          />
        </Field>
      </div>
    </Modal>
  );
}
