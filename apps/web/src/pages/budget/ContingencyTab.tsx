/**
 * CONTINGENCY (spec #499) — the budget's contingency lines side by side with
 * the risk register's contingencies they fund. An approved contingency draw
 * on a linked line records a drawdown on the risk contingency, and this
 * screen shows whether the two registers agree — amount and drawn — or, when
 * they are kept in different currencies, says they cannot be compared.
 */
import { useState } from "react";
import { Alert, Badge, Button, Card, CardBody, EmptyState, ErrorAlert, Field, Modal, Select, Skeleton, Stat, Textarea } from "../../ui";
import { IconRisk } from "../../ui/icons";
import { api } from "../../lib/api";
import {
  FigureValue,
  LoadError,
  SectionHeading,
  errorMessage,
  labelize,
  money,
  percent,
  useResource,
  type BudgetDetail,
  type ContingencyView,
} from "./budgetShared";

export default function ContingencyTab({
  budget,
  currency,
  version,
  onChanged,
}: {
  budget: BudgetDetail;
  currency: string;
  version: number;
  onChanged: () => void;
}) {
  const [linking, setLinking] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const view = useResource<ContingencyView>(
    (signal) => api.get<ContingencyView>(`/api/v1/budgets/${budget.id}/contingency`, { signal }),
    [budget.id, version],
  );
  const data = view.data;

  async function unlink(linkId: string) {
    setActionError(null);
    try {
      await api.del(`/api/v1/budget-contingency-links/${linkId}`);
      onChanged();
    } catch (err) {
      setActionError(errorMessage(err, "The link could not be removed"));
    }
  }

  if (view.error) return <LoadError message={view.error} onRetry={view.reload} title="Contingency could not be loaded" />;
  if (view.loading && !data) return <Skeleton height={240} />;
  if (!data) return null;

  return (
    <div className="space-y-5">
      <ErrorAlert message={actionError} onDismiss={() => setActionError(null)} />
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Contingency original" value={money(data.totals.original, currency)} hint="Original budget + owner-funded increases on contingency lines" />
        <Stat label="Drawn" value={money(data.totals.drawn, currency)} hint="Approved contingency draws out of those lines" />
        <Stat label="Remaining" value={<FigureValue figure={data.remaining} currency={currency} />} hint="Revised budget on the contingency lines" />
      </div>

      <section>
        <SectionHeading title="Contingency lines" hint="A draw is a budget change of kind contingency_draw, approved by somebody other than the requester. Linking a line to a risk contingency mirrors each approved draw onto the risk register." />
        {data.items.length === 0 ? (
          <EmptyState icon={IconRisk} title="This budget carries no contingency line" hint="Add a line of kind 'contingency' on the grid; draws then move money out of it through approved changes." />
        ) : (
          <div className="space-y-3">
            {data.items.map((item) => (
              <Card key={item.lineItemId}>
                <CardBody className="space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="text-body font-semibold text-content">
                        <span className="font-mono">{item.costCode}</span> · {item.description}
                      </p>
                      <p className="text-meta text-content-muted">
                        {money(item.drawn, currency)} drawn of {money(item.original, currency)} ({item.drawnShare === null ? "share unavailable" : `${percent(item.drawnShare)} drawn`}) · {money(item.remaining, currency)} remaining
                      </p>
                    </div>
                    <Button size="sm" variant="secondary" onClick={() => setLinking(item.lineItemId)} disabled={data.unlinkedRiskContingencies.length === 0}>
                      Link a risk contingency
                    </Button>
                  </div>
                  {item.links.length === 0 ? (
                    <p className="text-meta text-content-subtle">Not linked to the risk register — draws are recorded on the budget only.</p>
                  ) : (
                    <ul className="space-y-1">
                      {item.links.map((link) => (
                        <li key={link.linkId} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border-subtle px-2 py-1 text-meta">
                          <span>
                            <span className="font-medium">{link.name ?? link.contingencyId}</span>{" "}
                            {link.confidenceLevel ? <Badge tone="neutral" size="xs" variant="outline">{link.confidenceLevel}</Badge> : null}{" "}
                            {link.isManagementReserve === 1 ? <Badge tone="info" size="xs">management reserve</Badge> : null}
                            <span className="block text-content-muted">
                              Risk register: {link.amount === null ? "—" : money(link.amount, link.currency ?? currency)} set, {link.drawn === null ? "—" : money(link.drawn, link.currency ?? currency)} drawn
                            </span>
                          </span>
                          <span className="flex items-center gap-2">
                            {link.agrees ? (
                              <>
                                <Badge tone={link.agrees.amount ? "success" : "warning"} size="xs">
                                  amount {link.agrees.amount ? "agrees" : "differs"}
                                </Badge>
                                <Badge tone={link.agrees.drawn ? "success" : "warning"} size="xs">
                                  drawn {link.agrees.drawn ? "agrees" : "differs"}
                                </Badge>
                              </>
                            ) : (
                              <Badge tone="neutral" size="xs">
                                not compared
                              </Badge>
                            )}
                            <Button size="xs" variant="ghost" onClick={() => void unlink(link.linkId)}>
                              Unlink
                            </Button>
                          </span>
                          {link.reasons.length > 0 ? <span className="basis-full text-2xs text-content-subtle">{link.reasons.join(" ")}</span> : null}
                        </li>
                      ))}
                    </ul>
                  )}
                </CardBody>
              </Card>
            ))}
          </div>
        )}
      </section>

      {data.unlinkedRiskContingencies.length > 0 ? (
        <Alert tone="info" size="sm" title={`${data.unlinkedRiskContingencies.length} risk contingenc${data.unlinkedRiskContingencies.length === 1 ? "y" : "ies"} on this project not yet linked to a budget line`}>
          <ul className="list-disc pl-4">
            {data.unlinkedRiskContingencies.map((r) => (
              <li key={r.id}>
                {r.name} — {money(r.amount, r.currency)} {r.confidenceLevel ? `(${r.confidenceLevel})` : ""}, {money(r.drawn, r.currency)} drawn
              </li>
            ))}
          </ul>
        </Alert>
      ) : null}

      <LinkModal
        open={linking !== null}
        lineId={linking}
        candidates={data.unlinkedRiskContingencies}
        onClose={() => setLinking(null)}
        onLinked={() => {
          setLinking(null);
          onChanged();
        }}
      />
    </div>
  );
}

function LinkModal({
  open,
  lineId,
  candidates,
  onClose,
  onLinked,
}: {
  open: boolean;
  lineId: string | null;
  candidates: ContingencyView["unlinkedRiskContingencies"];
  onClose: () => void;
  onLinked: () => void;
}) {
  const [contingencyId, setContingencyId] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!lineId || contingencyId === "") return;
    setSaving(true);
    setError(null);
    try {
      await api.post(`/api/v1/budget-lines/${lineId}/contingency-links`, { contingencyId, notes: notes.trim() === "" ? null : notes.trim() });
      setContingencyId("");
      setNotes("");
      onLinked();
    } catch (err) {
      setError(errorMessage(err, "The link could not be created"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Link a risk contingency"
      description="Once linked, every approved draw on this line records a drawdown on the risk contingency, so both registers say the same thing about what has been spent."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} loading={saving} disabled={contingencyId === ""}>
            Link
          </Button>
        </>
      }
    >
      <ErrorAlert message={error} />
      <div className="space-y-3">
        <Field label="Risk contingency" required>
          <Select value={contingencyId} onChange={(e) => setContingencyId(e.target.value)}>
            <option value="">Choose…</option>
            {candidates.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} — {money(c.amount, c.currency)} {c.confidenceLevel ? `(${labelize(c.confidenceLevel)})` : ""}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Notes" optional>
          <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}
