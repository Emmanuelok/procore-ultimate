/**
 * Handover tab — O&M readiness and the validated COBie deliverable
 * (spec Domain L #630-631, #645-649).
 *
 * The score is a weighted coverage figure with its basis printed next to it,
 * and every dimension names the assets responsible for the gap. The COBie
 * pack is validated before it is downloaded: referential errors, duplicate
 * names and bad dates are listed rather than shipped to the client's CAFM
 * team to discover.
 */
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "../../lib/api";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  ErrorAlert,
  Progress,
  Spinner,
  Stat,
  Table,
  Td,
  Th,
} from "../../ui";
import { humanize } from "../format";
import { downloadText } from "../bim/bimShared";
import type { CobieValidation, HandoverReadiness } from "./twinShared";

export default function HandoverTab({ projectId }: { projectId: string }) {
  const [readiness, setReadiness] = useState<HandoverReadiness | null>(null);
  const [validation, setValidation] = useState<CobieValidation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [r, v] = await Promise.all([
        api.get<HandoverReadiness>(`/api/v1/projects/${projectId}/twin/handover-readiness`),
        api.get<CobieValidation>(`/api/v1/projects/${projectId}/cobie/validate`),
      ]);
      setReadiness(r);
      setValidation(v);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load handover readiness");
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function download(path: string, filename: string) {
    setBusy(filename);
    try {
      await downloadText(path, filename);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Download failed");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <ErrorAlert message={error} />

      <div className="mb-4 grid grid-cols-2 gap-4 md:grid-cols-4">
        <Card>
          <CardBody>
            <Stat
              label="Handover readiness"
              value={readiness?.score === null || readiness === null ? "—" : `${readiness.score}%`}
              hint={readiness?.scoreBasis ?? "loading"}
              tone={
                readiness?.score === null || readiness === null
                  ? "neutral"
                  : readiness.score >= 90
                    ? "success"
                    : readiness.score >= 60
                      ? "warning"
                      : "danger"
              }
            />
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <Stat
              label="COBie completeness"
              value={validation ? `${validation.completeness.score}%` : "—"}
              hint="required Component fields populated"
            />
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <Stat
              label="COBie errors"
              value={validation ? validation.errors : "—"}
              tone={(validation?.errors ?? 0) > 0 ? "danger" : "success"}
              hint={validation ? `${validation.warnings} warnings` : ""}
            />
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <Stat
              label="Assets assessed"
              value={readiness ? readiness.assetsAssessed : "—"}
              hint={
                readiness
                  ? `${readiness.milestones["accepted"] ?? 0} milestone(s) accepted`
                  : ""
              }
            />
          </CardBody>
        </Card>
      </div>

      {readiness && readiness.blockers.length > 0 ? (
        <Alert tone="warning" title="Blocking gaps" className="mb-4">
          <ul className="list-inside list-disc text-xs">
            {readiness.blockers.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
        </Alert>
      ) : null}

      <Card className="mb-4">
        <CardBody>
          <h3 className="mb-3 text-sm font-semibold text-ink-900">Readiness by criterion</h3>
          {readiness === null ? (
            <Spinner label="Scoring the register…" />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Criterion</Th>
                  <Th className="w-48">Coverage</Th>
                  <Th className="text-right">Populated</Th>
                  <Th>Basis</Th>
                  <Th>Missing on</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {readiness.dimensions.map((d) => (
                  <tr key={d.key}>
                    <Td>{d.label}</Td>
                    <Td>
                      <Progress value={d.percent} max={100} />
                      <span className="text-[11px] text-ink-500">{d.percent}%</span>
                    </Td>
                    <Td className="text-right tabular-nums">
                      {d.populated}/{d.total}
                    </Td>
                    <Td className="text-xs text-ink-500">{d.basis}</Td>
                    <Td className="text-xs text-ink-500">
                      {d.missingTagCodes.length === 0
                        ? "—"
                        : d.missingTagCodes.slice(0, 6).join(", ") +
                          (d.missingTagCodes.length > 6 ? "…" : "")}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </CardBody>
      </Card>

      <Card className="mb-4">
        <CardBody>
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-ink-900">COBie deliverable</h3>
            <div className="flex flex-wrap gap-2">
              {(validation?.sheets ?? [])
                .filter((s) => s.rows > 0)
                .slice(0, 6)
                .map((s) => (
                  <Button
                    key={s.name}
                    size="sm"
                    variant="secondary"
                    disabled={busy !== null}
                    onClick={() =>
                      void download(
                        `/api/v1/projects/${projectId}/cobie.csv?sheet=${s.name}`,
                        `cobie-${s.name.toLowerCase()}.csv`,
                      )
                    }
                  >
                    {s.name} CSV
                  </Button>
                ))}
              <Button
                size="sm"
                disabled={busy !== null}
                onClick={() =>
                  void download(`/api/v1/projects/${projectId}/cobie.json`, "cobie.json")
                }
              >
                Full workbook JSON
              </Button>
            </div>
          </div>
          {validation === null ? (
            <Spinner label="Validating…" />
          ) : (
            <>
              <div className="mb-3 flex flex-wrap gap-2 text-xs">
                {validation.sheets.map((s) => (
                  <span
                    key={s.name}
                    className="rounded border border-ink-200 px-2 py-1"
                    title={s.reason ?? undefined}
                  >
                    {s.name}: {s.rows}
                    {s.reason ? <span className="ml-1 text-ink-400">(empty)</span> : null}
                  </span>
                ))}
              </div>
              {validation.issues.length === 0 ? (
                <p className="text-xs text-emerald-700">
                  No validation issues — the pack is referentially consistent.
                </p>
              ) : (
                <Table>
                  <thead>
                    <tr>
                      <Th>Sheet</Th>
                      <Th>Row</Th>
                      <Th>Column</Th>
                      <Th>Severity</Th>
                      <Th>Message</Th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-ink-100">
                    {validation.issues.slice(0, 50).map((i, index) => (
                      <tr key={`${i.sheet}-${i.row}-${i.column}-${index}`}>
                        <Td>{i.sheet}</Td>
                        <Td className="tabular-nums">{i.row ?? "—"}</Td>
                        <Td>{i.column ?? "—"}</Td>
                        <Td>
                          <Badge size="sm" tone={i.severity === "error" ? "danger" : "warning"}>
                            {i.severity}
                          </Badge>
                        </Td>
                        <Td className="text-xs">{i.message}</Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </>
          )}
        </CardBody>
      </Card>

      {validation && validation.completeness.missingByComponent.length > 0 ? (
        <Card>
          <CardBody>
            <h3 className="mb-2 text-sm font-semibold text-ink-900">
              Components missing required COBie fields
            </h3>
            <ul className="space-y-1 text-xs">
              {validation.completeness.missingByComponent.slice(0, 30).map((m) => (
                <li key={m.tagCode}>
                  <span className="font-mono">{m.tagCode}</span>{" "}
                  <span className="text-ink-500">
                    — {m.missing.map((f) => humanize(f)).join(", ")}
                  </span>
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      ) : null}
    </div>
  );
}
