/**
 * THE COMPLIANCE REGISTER — every commitment on the project with its
 * insurance, bonding and lien-waiver position, worst first.
 *
 * This is the page that makes an expired certificate somebody's problem before
 * a payment run rather than after one. It is deliberately not a dashboard of
 * counts: each row carries the finding sentences the compliance engine wrote,
 * with the certificate's actual expiry date and how many days ago it lapsed.
 */
import { useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  EmptyState,
  ErrorAlert,
  Spinner,
} from "../../ui";
import {
  COMPLIANCE_LABEL,
  FindingList,
  complianceTone,
  money,
  titleCase,
  type Loadable,
} from "./shared";
import type { ComplianceEntry, ComplianceReport, ComplianceStatus } from "./types";

const ORDER: ComplianceStatus[] = ["blocked", "warning", "unknown", "compliant"];

export default function ComplianceTab({
  report,
  onOpen,
}: {
  report: Loadable<ComplianceReport>;
  onOpen: (commitmentId: string) => void;
}) {
  const [only, setOnly] = useState<ComplianceStatus | "all">("all");

  if (report.loading && !report.data) {
    return (
      <div className="py-12">
        <Spinner label="Reading the certificate and bond register…" />
      </div>
    );
  }
  if (report.error) return <ErrorAlert message={report.error} onRetry={report.reload} />;
  const data = report.data;
  if (!data) return null;

  if (data.entries.length === 0) {
    return (
      <EmptyState
        title="No live commitments to assess"
        hint="The compliance sweep covers every commitment on the project that is not void. There are none."
      />
    );
  }

  const entries =
    only === "all" ? data.entries : data.entries.filter((e) => e.compliance.status === only);

  return (
    <div className="space-y-4">
      <Card>
        <CardBody className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-label uppercase text-content-subtle">
              Assessed {data.asOf}
            </span>
            <Button
              size="xs"
              variant={only === "all" ? "secondary" : "ghost"}
              onClick={() => setOnly("all")}
            >
              All {data.summary.total}
            </Button>
            {ORDER.map((status) => (
              <Button
                key={status}
                size="xs"
                variant={only === status ? "secondary" : "ghost"}
                onClick={() => setOnly(status)}
              >
                {COMPLIANCE_LABEL[status]} {countOf(data, status)}
              </Button>
            ))}
          </div>
          <p className="text-2xs text-content-muted">
            {data.summary.paymentBlocked} commitment
            {data.summary.paymentBlocked === 1 ? "" : "s"} cannot have a payment issued against
            {data.summary.paymentBlocked === 1 ? " it" : " them"} right now. The certificate and
            bond records are read live from the insurance module — this register never holds its own
            copy of a certificate, so it cannot disagree with the insurance dashboard about one.
          </p>
          {data.notes.map((note) => (
            <Alert key={note} tone="info" size="sm">
              {note}
            </Alert>
          ))}
        </CardBody>
      </Card>

      {entries.length === 0 ? (
        <EmptyState
          title={`No commitment is ${COMPLIANCE_LABEL[only as ComplianceStatus].toLowerCase()}`}
          hint="Pick another bucket above."
        />
      ) : (
        <div className="space-y-3">
          {entries.map((entry) => (
            <EntryCard key={entry.commitmentId} entry={entry} onOpen={onOpen} />
          ))}
        </div>
      )}
    </div>
  );
}

function countOf(report: ComplianceReport, status: ComplianceStatus): number {
  switch (status) {
    case "blocked":
      return report.summary.blocked;
    case "warning":
      return report.summary.warning;
    case "unknown":
      return report.summary.unknown;
    default:
      return report.summary.compliant;
  }
}

function EntryCard({
  entry,
  onOpen,
}: {
  entry: ComplianceEntry;
  onOpen: (commitmentId: string) => void;
}) {
  const c = entry.compliance;
  return (
    <Card>
      <CardBody className="space-y-2">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-sm font-semibold">{entry.reference}</span>
              <span className="truncate text-sm">{entry.title}</span>
              <Badge tone={complianceTone(c.status)} dot size="xs">
                {COMPLIANCE_LABEL[c.status]}
              </Badge>
              <Badge tone="neutral" size="xs" variant="outline">
                strictness {c.strictness}
              </Badge>
            </div>
            <p className="mt-0.5 text-2xs text-content-subtle">
              {entry.vendorName ?? "no vendor bound"} · {titleCase(entry.kind)} ·{" "}
              {titleCase(entry.status)} ·{" "}
              {money(entry.revisedCommitmentSum, entry.currency)}
            </p>
          </div>
          <Button size="xs" variant="secondary" onClick={() => onOpen(entry.commitmentId)}>
            Open commitment
          </Button>
        </div>

        {c.note ? <p className="text-meta text-content-muted">{c.note}</p> : null}
        <FindingList findings={c.blocking} heading="Blocking — payment refused" />
        <FindingList findings={c.warnings} heading="Warnings — payment permitted, exposure recorded" />
        {c.findings.length === 0 ? (
          <p className="text-2xs text-content-subtle">
            {c.requirementsKnown
              ? `Every recorded requirement is satisfied. ${c.evidence.certificatesConsidered} certificate(s) and ${c.evidence.bondsConsidered} bond(s) were consulted.`
              : "No insurance or bond requirement is recorded on this commitment, so nothing was tested."}
          </p>
        ) : null}
      </CardBody>
    </Card>
  );
}
