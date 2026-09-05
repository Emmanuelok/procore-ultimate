/**
 * CERTIFICATES — the register exists to watch one column: `validTo`.
 *
 * The screen is ordered by consequence, not by date:
 *
 *  1. EXPIRED, STATUTORY, ON PLANT IN SERVICE. That is uninsured, unlawful
 *     operation. It gets a solid danger banner, a solid row rail, and its own
 *     block at the top of the page with the machine named. Nobody should be
 *     able to leave this tab without having seen it.
 *  2. Expired but not statutory, or not in service — still a breach of the
 *     register, still high, but not a criminal exposure today.
 *  3. Expiring inside the 28-day window — the ones a renewal can still catch.
 *  4. Unverified — filed by someone, never checked by anyone. A forged
 *     thorough examination is not a rare thing on a busy site, which is why
 *     verification may never be the person who filed the certificate.
 */
import { useMemo, useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  EmptyState,
  SegmentedControl,
  SkeletonTable,
  Switch,
  Tooltip,
} from "../../ui";
import { DataTable, type DataColumns } from "../../ui/data";
import type { Tone } from "../../ui/tokens";
import { IconCompliance, IconWarning } from "../../ui/icons";
import {
  CERTIFICATE_TYPE_LABEL,
  EM_DASH,
  LoadError,
  SectionHeading,
  certificateLabel,
  certificateTone,
  isoDate,
  labelize,
  type CertificateRegister,
  type CertificateRow,
  type Loadable,
} from "./equipmentShared";

type Bucket = "critical" | "expired" | "expiring" | "unverified" | "all";

export default function CertificatesTab({
  register,
  inServiceOnly,
  onInServiceOnly,
  onOpenMachine,
  onVerify,
}: {
  register: Loadable<CertificateRegister>;
  inServiceOnly: boolean;
  onInServiceOnly: (next: boolean) => void;
  onOpenMachine: (equipmentId: string) => void;
  /** Countersign a certificate — never offered to whoever filed it; the API
   *  refuses that and the modal renders the refusal. */
  onVerify?: (certificateId: string, label: string) => void;
}) {
  const [bucket, setBucket] = useState<Bucket>("critical");
  const data = register.data;
  const items = useMemo(() => data?.items ?? [], [data]);

  const critical = useMemo(
    () => items.filter((row) => row.verdict.detector === "equipment_certificate_expired_in_service"),
    [items],
  );

  const filtered = useMemo(() => {
    switch (bucket) {
      case "critical":
        return critical;
      case "expired":
        return items.filter((row) => row.verdict.status === "expired");
      case "expiring":
        return items.filter((row) => row.verdict.status === "expiring");
      case "unverified":
        return items.filter((row) => row.verifiedBy === null);
      default:
        return items;
    }
  }, [bucket, items, critical]);

  const columns = useMemo<DataColumns<CertificateRow>>(
    () => [
      {
        id: "equipmentReference",
        header: "Plant",
        accessor: (row) => row.equipmentReference ?? "",
        type: "code",
        sticky: "start",
        width: 118,
        mono: true,
        cell: ({ row }) => (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onOpenMachine(row.equipmentId);
            }}
            className="font-mono text-accent-text hover:underline"
          >
            {row.equipmentReference ?? row.equipmentId.slice(0, 10)}
          </button>
        ),
        interactive: true,
      },
      {
        id: "equipmentName",
        header: "Machine",
        accessor: (row) => row.equipmentName ?? "",
        type: "text",
        width: 210,
      },
      {
        id: "certificateType",
        header: "Certificate",
        accessor: "certificateType",
        type: "enum",
        width: 220,
        groupable: true,
        cell: ({ row }) => (
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate">
              {CERTIFICATE_TYPE_LABEL[row.certificateType] ?? labelize(row.certificateType)}
            </span>
            {row.statutory ? (
              <Tooltip content="Statutory: this certificate is required by law before the machine may be operated. Its absence is not a paperwork failure, it is an offence.">
                <span>
                  <Badge tone="danger" size="xs" variant="outline">
                    Statutory
                  </Badge>
                </span>
              </Tooltip>
            ) : null}
          </span>
        ),
      },
      {
        id: "verdict",
        header: "Position today",
        accessor: (row) => row.verdict.status,
        type: "enum",
        width: 200,
        options: [
          { value: "expired", label: "Expired", text: "Expired", tone: "danger" },
          { value: "expiring", label: "Expiring", text: "Expiring", tone: "warning" },
          { value: "valid", label: "Valid", text: "Valid", tone: "success" },
          { value: "pending", label: "Not yet in force", text: "Not yet in force", tone: "info" },
        ],
        cell: ({ row }) => (
          <span className="flex items-center gap-1.5">
            <Badge
              tone={certificateTone(row.verdict)}
              size="xs"
              dot
              variant={row.verdict.severity === "critical" ? "solid" : "subtle"}
            >
              {certificateLabel(row.verdict)}
            </Badge>
            {row.verdict.severity === "critical" ? (
              <Tooltip content="Statutory certificate expired on plant that is currently assigned to a project. That is unlawful, uninsured operation — a critical signal, raised the moment this register is read.">
                <span>
                  <Badge tone="danger" size="xs" variant="solid" icon={IconWarning}>
                    Unlawful
                  </Badge>
                </span>
              </Tooltip>
            ) : null}
          </span>
        ),
      },
      {
        id: "validTo",
        header: "Valid to",
        accessor: "validTo",
        type: "date",
        width: 130,
        sortDescFirst: false,
      },
      {
        id: "inService",
        header: "In service",
        accessor: (row) => (row.inServiceProjectId ? "yes" : "no"),
        type: "enum",
        width: 130,
        options: [
          { value: "yes", label: "Assigned", text: "Assigned", tone: "warning" },
          { value: "no", label: "Not assigned", text: "Not assigned" },
        ],
        cell: ({ row }) =>
          row.inServiceProjectId ? (
            <Badge tone="warning" size="xs" dot>
              Assigned
            </Badge>
          ) : (
            <span className="text-2xs text-content-subtle">off site</span>
          ),
      },
      {
        id: "issuedByName",
        header: "Issued by",
        accessor: (row) => row.issuedByName ?? "",
        type: "text",
        width: 200,
        cell: ({ row }) =>
          row.issuedByName ? (
            <span className="truncate">
              {row.issuedByName}
              {row.issuerAccreditation ? (
                <span className="text-content-subtle"> · {row.issuerAccreditation}</span>
              ) : null}
            </span>
          ) : (
            <span className="text-2xs text-content-subtle italic">
              no competent person recorded
            </span>
          ),
      },
      {
        id: "verified",
        header: "Verified",
        headerTooltip:
          "Verification that the certificate is GENUINE — and never by the person who filed it. A certificate nobody independently checked is a photocopy with a date on it.",
        accessor: (row) => (row.verifiedBy ? "yes" : "no"),
        type: "enum",
        width: 150,
        options: [
          { value: "yes", label: "Verified", text: "Verified", tone: "success" },
          { value: "no", label: "Unverified", text: "Unverified", tone: "warning" },
        ],
        cell: ({ row }) =>
          row.verifiedBy ? (
            <Badge tone="success" size="xs" variant="outline">
              {isoDate(row.verifiedAt)}
            </Badge>
          ) : onVerify ? (
            <Button
              size="xs"
              variant="secondary"
              onClick={(e) => {
                e.stopPropagation();
                onVerify(
                  row.id,
                  `${row.equipmentReference ?? row.equipmentId} · ${
                    CERTIFICATE_TYPE_LABEL[row.certificateType] ?? labelize(row.certificateType)
                  } to ${row.validTo}`,
                );
              }}
            >
              Verify
            </Button>
          ) : (
            <Badge tone="warning" size="xs">
              Never checked
            </Badge>
          ),
      },
      {
        id: "certificateNumber",
        header: "Number",
        accessor: (row) => row.certificateNumber ?? "",
        type: "code",
        width: 150,
        mono: true,
        defaultHidden: true,
      },
      {
        id: "safeWorkingLoad",
        header: "SWL",
        accessor: (row) => row.safeWorkingLoad ?? "",
        type: "text",
        width: 120,
        defaultHidden: true,
      },
    ],
    [onOpenMachine, onVerify],
  );

  if (register.error) return <LoadError message={register.error} onRetry={register.reload} />;
  if (register.loading && !data) return <SkeletonTable rows={10} columns={7} />;
  if (!data) return null;

  const summary = data.summary;

  return (
    <div className="space-y-4">
      {summary.expiredInServiceStatutory > 0 ? (
        <UnlawfulBlock rows={critical} onOpenMachine={onOpenMachine} asOf={data.asOf} />
      ) : (
        <Alert tone="success" title="No plant is operating on an expired statutory certificate">
          Every statutory certificate held against a machine currently assigned to a project is in
          date as at {data.asOf}. That is the one question an inspector asks first, and today the
          answer is clean.
        </Alert>
      )}

      <Card>
        <CardBody className="space-y-3">
          <SectionHeading
            title="The certificate register"
            hint="Company-wide, because a certificate belongs to the machine and follows it between projects. Reading this page is what runs the lapse sweep — the read is the trigger, and the evidence key is what stops one lapse being raised twice."
            className="mb-0"
            actions={
              <Switch
                checked={inServiceOnly}
                onChange={onInServiceOnly}
                label="Only plant in service"
                size="sm"
              />
            }
          />
          <div className="flex flex-wrap items-center gap-3">
            <SegmentedControl<Bucket>
              value={bucket}
              onChange={setBucket}
              size="sm"
              aria-label="Certificate bucket"
              options={[
                {
                  value: "critical",
                  label: `Unlawful (${summary.expiredInServiceStatutory})`,
                },
                { value: "expired", label: `Expired (${summary.expired})` },
                { value: "expiring", label: `Expiring (${summary.expiring})` },
                { value: "unverified", label: `Unverified (${summary.unverified})` },
                { value: "all", label: `All (${data.total})` },
              ]}
            />
            <span className="text-2xs text-content-subtle">assessed {data.asOf}</span>
          </div>
          <p className="text-2xs text-content-muted">
            &ldquo;Expiring&rdquo; is the 28-day window the platform warns in — long enough to book
            a competent person, short enough that the warning still means something. A certificate
            that has not yet come into force reads as <em>not yet in force</em>, never as valid.
          </p>
        </CardBody>
      </Card>

      {filtered.length === 0 ? (
        <EmptyState
          icon={IconCompliance}
          tone={bucket === "critical" ? "success" : "neutral"}
          title={emptyTitle(bucket)}
          hint={emptyHint(bucket, data.asOf, inServiceOnly)}
          action={
            bucket !== "all" ? (
              <Button size="sm" variant="secondary" onClick={() => setBucket("all")}>
                Show the whole register
              </Button>
            ) : undefined
          }
        />
      ) : (
        <DataTable<CertificateRow>
          tableId="equipment-certificates"
          data={filtered}
          columns={columns}
          getRowId={(row) => row.id}
          loading={register.loading}
          height={620}
          stickyHeader
          gridLines
          filterRow
          exportFileName="equipment-certificates"
          searchPlaceholder="Search certificates…"
          defaultSort={[{ id: "validTo", desc: false }]}
          rowTone={(row) => certificateRail(row)}
          onRowClick={({ row }) => onOpenMachine(row.equipmentId)}
          rowActions={(row) => [
            { id: "open", label: "Open the machine", onSelect: () => onOpenMachine(row.equipmentId) },
          ]}
          empty={{ title: "No certificates in this bucket" }}
          aria-label="Equipment certificate register"
        />
      )}
    </div>
  );
}

function certificateRail(row: CertificateRow): Tone | undefined {
  if (row.verdict.severity === "critical") return "danger";
  if (row.verdict.status === "expired") return "danger";
  if (row.verdict.status === "expiring") return "warning";
  return undefined;
}

function emptyTitle(bucket: Bucket): string {
  switch (bucket) {
    case "critical":
      return "No machine is operating unlawfully";
    case "expired":
      return "No certificate has lapsed";
    case "expiring":
      return "Nothing expires in the next 28 days";
    case "unverified":
      return "Every certificate has been independently verified";
    default:
      return "No certificates are held";
  }
}

function emptyHint(bucket: Bucket, asOf: string, inServiceOnly: boolean): string {
  const scope = inServiceOnly ? " among plant currently assigned to a project" : "";
  switch (bucket) {
    case "critical":
      return `No statutory certificate has lapsed on plant in service as at ${asOf}${scope}. This is the empty state you want: it means the test ran and found nothing, not that nothing was tested.`;
    case "expired":
      return `Every certificate on the register is in date as at ${asOf}${scope}.`;
    case "expiring":
      return `No certificate falls due inside the 28-day warning window from ${asOf}${scope}. The window is deliberately short — a warning that fires six months out is one nobody acts on.`;
    case "unverified":
      return `Every certificate carries an independent verification. Verification may never be the person who filed the certificate, so each of these was checked by a second pair of hands.`;
    default:
      return `No certificate has been filed against any machine${scope}. A machine that requires certification and holds none is worse than one with an expired certificate: there is nothing at all to check.`;
  }
}

function UnlawfulBlock({
  rows,
  asOf,
  onOpenMachine,
}: {
  rows: readonly CertificateRow[];
  asOf: string;
  onOpenMachine: (equipmentId: string) => void;
}) {
  return (
    <Alert
      tone="danger"
      variant="solid"
      icon={IconWarning}
      title={`${rows.length} machine${rows.length === 1 ? "" : "s"} in service on an expired statutory certificate`}
    >
      <p>
        A lapsed statutory examination on plant still assigned to a project is not late paperwork.
        The machine is uninsured, its operation is unlawful, and the exposure sits with whoever let
        it run. Assessed {asOf}.
      </p>
      <ul className="mt-2 space-y-1">
        {rows.slice(0, 8).map((row) => (
          <li key={row.id} className="text-meta">
            <button
              type="button"
              onClick={() => onOpenMachine(row.equipmentId)}
              className="font-mono font-semibold underline underline-offset-2"
            >
              {row.equipmentReference ?? row.equipmentId}
            </button>{" "}
            {row.equipmentName ?? EM_DASH} —{" "}
            {CERTIFICATE_TYPE_LABEL[row.certificateType] ?? labelize(row.certificateType)} expired{" "}
            {row.validTo} ({Math.abs(row.verdict.daysToExpiry)} days ago)
          </li>
        ))}
      </ul>
      {rows.length > 8 ? (
        <p className="mt-1 text-meta">…and {rows.length - 8} more in the table below.</p>
      ) : null}
    </Alert>
  );
}
