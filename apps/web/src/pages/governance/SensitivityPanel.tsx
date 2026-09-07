/**
 * Sensitivity, switching values and the tornado (spec Vol I #400, #406).
 *
 * The question an approver actually asks is not "what is the NPV" but "how
 * wrong would we have to be for this to be the wrong decision". The
 * switching value answers it in one number per variable; the tornado ranks
 * which variable the answer is most sensitive to. A variable with no
 * switching point inside ±1000% is reported as having none — never as 0%.
 */
import { useState } from "react";
import { Card, CardBody, Select, Table, Td, Th } from "../../ui";
import { fmtNum, SectionTitle, type BcOption } from "./governanceShared";

const VARIABLE_LABEL: Record<string, string> = {
  capex: "Capex",
  benefits: "Benefits",
  costs: "Operating costs",
  discountRate: "Discount rate",
};

const STEPS = [-30, -20, -10, 10, 20, 30];

export default function SensitivityPanel({ options }: { options: BcOption[] }) {
  const [optionId, setOptionId] = useState<string>(options[0]?.id ?? "");
  const option = options.find((o) => o.id === optionId) ?? options[0];

  if (!option) {
    return (
      <p className="rounded-md bg-ink-50 px-3 py-2 text-xs text-ink-500 ring-1 ring-ink-100">
        Add an option to see its sensitivity analysis.
      </p>
    );
  }

  const sensitivity = option.computed.sensitivity;
  if (!sensitivity) {
    return (
      <p className="rounded-md bg-ink-50 px-3 py-2 text-xs text-ink-500 ring-1 ring-ink-100">
        — this option was appraised before sensitivity analysis was available. Re-save the option
        set to compute it.
      </p>
    );
  }

  const maxSwing = Math.max(1e-9, ...sensitivity.tornado.map((t) => Math.abs(t.swing)));
  const variables = [...new Set(sensitivity.grid.map((c) => c.variable))];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <SectionTitle>Sensitivity &amp; switching values</SectionTitle>
        <div className="w-56">
          <Select
            value={option.id}
            onChange={(e) => setOptionId(e.target.value)}
            aria-label="Option to analyse"
          >
            {options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </Select>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* --------------------------------- tornado -------------------------------- */}
        <Card>
          <CardBody>
            <div className="mb-1 text-xs font-semibold text-ink-700">Tornado — ΔNPV at ±20%</div>
            <p className="mb-3 text-xs text-ink-400">
              Base NPV{" "}
              <span className="font-semibold tabular-nums text-ink-700">
                {fmtNum(option.computed.npv)}
              </span>
              {option.computed.eirr === null ? (
                <> · EIRR — no sign change in the net cashflow series</>
              ) : (
                <>
                  {" "}
                  · EIRR{" "}
                  <span className="font-semibold tabular-nums text-ink-700">
                    {fmtNum(option.computed.eirr, 2, 2)}%
                  </span>
                </>
              )}
            </p>
            {sensitivity.tornado.length === 0 ? (
              <p className="text-xs text-ink-400">No variable moves the NPV at ±20%.</p>
            ) : (
              <ul className="space-y-2">
                {sensitivity.tornado.map((t) => {
                  const lowPct = (Math.abs(t.low - option.computed.npv) / maxSwing) * 50;
                  const highPct = (Math.abs(t.high - option.computed.npv) / maxSwing) * 50;
                  return (
                    <li key={t.variable}>
                      <div className="mb-0.5 flex items-baseline justify-between text-xs">
                        <span className="font-medium text-ink-800">
                          {VARIABLE_LABEL[t.variable] ?? t.variable}
                        </span>
                        <span className="tabular-nums text-ink-500">
                          {fmtNum(t.low)} … {fmtNum(t.high)} (swing {fmtNum(t.swing)})
                        </span>
                      </div>
                      <div className="flex h-3 items-center">
                        <div className="flex w-1/2 justify-end">
                          <div
                            className="h-3 rounded-l bg-red-400"
                            style={{ width: `${Math.min(100, lowPct * 2)}%` }}
                          />
                        </div>
                        <div className="h-4 w-px bg-ink-400" />
                        <div className="flex w-1/2 justify-start">
                          <div
                            className="h-3 rounded-r bg-emerald-400"
                            style={{ width: `${Math.min(100, highPct * 2)}%` }}
                          />
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </CardBody>
        </Card>

        {/* ----------------------------- switching values ---------------------------- */}
        <Card>
          <CardBody>
            <div className="mb-2 text-xs font-semibold text-ink-700">
              Switching values — the change that drives NPV to zero
            </div>
            <Table>
              <thead>
                <tr>
                  <Th>Variable</Th>
                  <Th className="text-right">Change</Th>
                  <Th className="text-right">Switches at</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {sensitivity.switching.map((sv) => (
                  <tr key={sv.variable}>
                    <Td className="text-xs font-medium">
                      {VARIABLE_LABEL[sv.variable] ?? sv.variable}
                      <div className="text-[11px] font-normal text-ink-400">{sv.note}</div>
                    </Td>
                    <Td className="text-right tabular-nums">
                      {sv.changePercent === null ? (
                        <span className="text-ink-400">none</span>
                      ) : (
                        `${sv.changePercent > 0 ? "+" : ""}${fmtNum(sv.changePercent, 1, 1)}%`
                      )}
                    </Td>
                    <Td className="text-right tabular-nums">
                      {sv.switchesAt === null ? (
                        <span className="text-ink-400">—</span>
                      ) : (
                        fmtNum(sv.switchesAt, 2)
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </CardBody>
        </Card>
      </div>

      {/* -------------------------------- the grid -------------------------------- */}
      <Card>
        <CardBody>
          <div className="mb-2 text-xs font-semibold text-ink-700">NPV under ±10/20/30%</div>
          <div className="overflow-x-auto">
            <Table>
              <thead>
                <tr>
                  <Th>Variable</Th>
                  {STEPS.map((s) => (
                    <Th key={s} className="text-right">
                      {s > 0 ? `+${s}%` : `${s}%`}
                    </Th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {variables.map((v) => (
                  <tr key={v}>
                    <Td className="text-xs font-medium">{VARIABLE_LABEL[v] ?? v}</Td>
                    {STEPS.map((s) => {
                      const cell = sensitivity.grid.find(
                        (c) => c.variable === v && c.changePercent === s,
                      );
                      return (
                        <Td
                          key={s}
                          className={`text-right tabular-nums ${
                            cell && cell.npv < 0 ? "font-semibold text-red-700" : "text-ink-700"
                          }`}
                        >
                          {cell ? fmtNum(cell.npv) : "—"}
                        </Td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
          <p className="mt-2 text-xs leading-5 text-ink-400">{sensitivity.basis}</p>
        </CardBody>
      </Card>
    </div>
  );
}
