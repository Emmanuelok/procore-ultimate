/**
 * Logic model for a business case (spec Vol I #418).
 *
 * Inputs → outputs → outcomes → impacts, in columns, with the links between
 * them drawn. This is the chain a benefit claim has to hang from: a benefit
 * with no outcome behind it is an assertion, and the point of the model is
 * to make that visible rather than argue about it.
 *
 * The editor is deliberately plain — one row per node, one row per link — so
 * a business-case author can build the chain without learning a diagram tool.
 * Nodes may cite a registered benefit; the server refuses one from another
 * project.
 */
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { LOGIC_MODEL_LEVELS } from "@constructos/shared";
import { api, ApiClientError } from "../../lib/api";
import { Button, Card, CardBody, ErrorAlert, Input, Select } from "../../ui";
import { humanize } from "../format";
import { SectionTitle, type BenefitRow, type BusinessCaseRow } from "./governanceShared";

interface NodeDraft {
  id?: string;
  level: string;
  label: string;
  benefitId: string;
}

const LEVEL_TONE: Record<string, string> = {
  input: "bg-ink-100 text-ink-700 ring-ink-200",
  output: "bg-blue-50 text-blue-800 ring-blue-200",
  outcome: "bg-violet-50 text-violet-800 ring-violet-200",
  impact: "bg-emerald-50 text-emerald-800 ring-emerald-200",
};

export default function LogicModelPanel({
  base,
  bc,
  onChanged,
}: {
  base: string;
  bc: BusinessCaseRow;
  onChanged: () => void;
}) {
  const editable = bc.status !== "approved" && bc.status !== "rejected";

  const [nodes, setNodes] = useState<NodeDraft[]>([]);
  const [edges, setEdges] = useState<{ from: string; to: string }[]>([]);
  const [benefits, setBenefits] = useState<BenefitRow[]>([]);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setNodes(
      (bc.logicModel?.nodes ?? []).map((n) => ({
        id: n.id,
        level: n.level,
        label: n.label,
        benefitId: n.benefitId ?? "",
      })),
    );
    setEdges(bc.logicModel?.edges ?? []);
  }, [bc]);

  useEffect(() => {
    let cancelled = false;
    api
      .get<{ items: BenefitRow[] }>(`${base}/benefits?pageSize=200`)
      .then((res) => {
        if (!cancelled) setBenefits(res.items ?? []);
      })
      .catch(() => {
        if (!cancelled) setBenefits([]);
      });
    return () => {
      cancelled = true;
    };
  }, [base]);

  const byLevel = useMemo(
    () =>
      LOGIC_MODEL_LEVELS.map((level) => ({
        level,
        nodes: (bc.logicModel?.nodes ?? []).filter((n) => n.level === level),
      })),
    [bc],
  );

  const labelOf = (id: string) =>
    (bc.logicModel?.nodes ?? []).find((n) => n.id === id)?.label ?? id;

  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const cleaned = nodes.filter((n) => n.label.trim());
      await api.put(`${base}/business-cases/${bc.id}/logic-model`, {
        nodes: cleaned.map((n) => ({
          ...(n.id ? { id: n.id } : {}),
          level: n.level,
          label: n.label.trim(),
          ...(n.benefitId ? { benefitId: n.benefitId } : {}),
        })),
        // Only links between nodes that survived the clean-up are sent; the
        // server rejects an edge to an unknown node, and rightly so.
        edges: edges.filter(
          (e2) =>
            cleaned.some((n) => n.id === e2.from) && cleaned.some((n) => n.id === e2.to),
        ),
      });
      setEditing(false);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Could not save the logic model");
    } finally {
      setBusy(false);
    }
  }

  const hasModel = (bc.logicModel?.nodes ?? []).length > 0;

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <SectionTitle>Logic model</SectionTitle>
        {editable ? (
          <Button size="sm" variant="secondary" onClick={() => setEditing((v) => !v)}>
            {editing ? "Cancel" : hasModel ? "Edit model" : "Build model"}
          </Button>
        ) : null}
      </div>

      <ErrorAlert message={error} />

      {!hasModel && !editing ? (
        <p className="rounded-md bg-ink-50 px-3 py-2 text-xs leading-5 text-ink-500 ring-1 ring-ink-100">
          — no logic model has been captured, so the chain from what this case buys to what it
          changes is not on the record.
        </p>
      ) : null}

      {hasModel ? (
        <Card>
          <CardBody>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
              {byLevel.map((col) => (
                <div key={col.level}>
                  <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-ink-400">
                    {humanize(col.level)}s
                  </div>
                  {col.nodes.length === 0 ? (
                    <div className="rounded-md border border-dashed border-ink-200 px-2 py-3 text-center text-[11px] text-ink-400">
                      none
                    </div>
                  ) : (
                    <ul className="space-y-1.5">
                      {col.nodes.map((n) => (
                        <li
                          key={n.id}
                          className={`rounded-md px-2 py-1.5 text-xs ring-1 ${
                            LEVEL_TONE[n.level] ?? "bg-ink-100 text-ink-700 ring-ink-200"
                          }`}
                        >
                          {n.label}
                          {n.benefitId ? (
                            <div className="mt-0.5 text-[10px] uppercase tracking-wide opacity-70">
                              measured benefit
                            </div>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </div>

            {(bc.logicModel?.edges ?? []).length > 0 ? (
              <div className="mt-3 border-t border-ink-100 pt-2">
                <div className="text-xs font-semibold uppercase tracking-wide text-ink-400">
                  Links
                </div>
                <ul className="mt-1 grid grid-cols-1 gap-x-6 gap-y-0.5 text-xs text-ink-600 sm:grid-cols-2">
                  {(bc.logicModel?.edges ?? []).map((e2) => (
                    <li key={`${e2.from}-${e2.to}`}>
                      {labelOf(e2.from)} <span className="text-ink-400">→</span> {labelOf(e2.to)}
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className="mt-3 border-t border-ink-100 pt-2 text-xs text-ink-400">
                No links recorded — the columns are a list, not yet a chain.
              </p>
            )}
          </CardBody>
        </Card>
      ) : null}

      {editing ? (
        <Card className="mt-3">
          <CardBody>
            <form onSubmit={save} className="space-y-3">
              <div>
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-xs font-semibold uppercase tracking-wide text-ink-400">
                    Nodes
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      setNodes((ns) => [
                        ...ns,
                        { id: `new-${ns.length + 1}-${Date.now()}`, level: "output", label: "", benefitId: "" },
                      ])
                    }
                  >
                    + Add node
                  </Button>
                </div>
                <div className="space-y-2">
                  {nodes.map((n, i) => (
                    <div key={n.id ?? i} className="grid grid-cols-1 gap-2 sm:grid-cols-12">
                      <div className="sm:col-span-3">
                        <Select
                          value={n.level}
                          onChange={(e) =>
                            setNodes((ns) =>
                              ns.map((x, j) => (j === i ? { ...x, level: e.target.value } : x)),
                            )
                          }
                        >
                          {LOGIC_MODEL_LEVELS.map((l) => (
                            <option key={l} value={l}>
                              {humanize(l)}
                            </option>
                          ))}
                        </Select>
                      </div>
                      <div className="sm:col-span-5">
                        <Input
                          value={n.label}
                          placeholder="What it is"
                          onChange={(e) =>
                            setNodes((ns) =>
                              ns.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)),
                            )
                          }
                        />
                      </div>
                      <div className="sm:col-span-3">
                        <Select
                          value={n.benefitId}
                          onChange={(e) =>
                            setNodes((ns) =>
                              ns.map((x, j) => (j === i ? { ...x, benefitId: e.target.value } : x)),
                            )
                          }
                        >
                          <option value="">No measured benefit</option>
                          {benefits.map((b) => (
                            <option key={b.id} value={b.id}>
                              B-{String(b.number).padStart(3, "0")} {b.name}
                            </option>
                          ))}
                        </Select>
                      </div>
                      <div className="flex items-center sm:col-span-1">
                        <button
                          type="button"
                          className="text-xs text-ink-400 hover:text-red-700"
                          aria-label="Remove node"
                          onClick={() => {
                            const removed = nodes[i];
                            setNodes((ns) => ns.filter((_, j) => j !== i));
                            setEdges((es) =>
                              es.filter((e2) => e2.from !== removed?.id && e2.to !== removed?.id),
                            );
                          }}
                        >
                          ✕
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div>
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-xs font-semibold uppercase tracking-wide text-ink-400">
                    Links
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={nodes.length < 2}
                    onClick={() =>
                      setEdges((es) => [
                        ...es,
                        { from: nodes[0]?.id ?? "", to: nodes[1]?.id ?? "" },
                      ])
                    }
                  >
                    + Add link
                  </Button>
                </div>
                <div className="space-y-2">
                  {edges.map((e2, i) => (
                    <div key={i} className="grid grid-cols-1 gap-2 sm:grid-cols-12">
                      <div className="sm:col-span-5">
                        <Select
                          value={e2.from}
                          onChange={(ev) =>
                            setEdges((es) =>
                              es.map((x, j) => (j === i ? { ...x, from: ev.target.value } : x)),
                            )
                          }
                        >
                          {nodes.map((n) => (
                            <option key={n.id} value={n.id}>
                              {n.label || "(unnamed)"}
                            </option>
                          ))}
                        </Select>
                      </div>
                      <div className="flex items-center justify-center text-ink-400 sm:col-span-1">
                        →
                      </div>
                      <div className="sm:col-span-5">
                        <Select
                          value={e2.to}
                          onChange={(ev) =>
                            setEdges((es) =>
                              es.map((x, j) => (j === i ? { ...x, to: ev.target.value } : x)),
                            )
                          }
                        >
                          {nodes.map((n) => (
                            <option key={n.id} value={n.id}>
                              {n.label || "(unnamed)"}
                            </option>
                          ))}
                        </Select>
                      </div>
                      <div className="flex items-center sm:col-span-1">
                        <button
                          type="button"
                          className="text-xs text-ink-400 hover:text-red-700"
                          aria-label="Remove link"
                          onClick={() => setEdges((es) => es.filter((_, j) => j !== i))}
                        >
                          ✕
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="flex justify-end">
                <Button type="submit" size="sm" disabled={busy}>
                  {busy ? "Saving…" : "Save logic model"}
                </Button>
              </div>
            </form>
          </CardBody>
        </Card>
      ) : null}
    </div>
  );
}
