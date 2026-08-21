/**
 * Handover tab — COBie deliverable generation from the live asset register
 * (spec Domain L #630, #658).
 */
import { useState } from "react";
import { fetchBlobUrl } from "../../lib/api";
import { Button, Card, CardBody, ErrorAlert } from "../../ui";

export default function HandoverTab({ projectId }: { projectId: string }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function download(path: string, filename: string) {
    setBusy(filename);
    setError(null);
    try {
      const url = await fetchBlobUrl(path);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Download failed");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="max-w-3xl">
      <Card>
        <CardBody>
          <h2 className="text-sm font-semibold text-ink-900">COBie handover deliverable</h2>
          <p className="mt-2 text-sm leading-6 text-ink-600">
            COBie (Construction-Operations Building information exchange) is the standard
            spreadsheet-shaped handover format owners and CAFM/CMMS systems ingest at practical
            completion. ConstructOS generates the <span className="font-medium">Component</span>{" "}
            sheet live from the asset register — every tagged asset with its type, space,
            serial number, installation date and warranty start — so the deliverable is a
            by-product of construction data capture, not a document-assembly scramble at
            closeout.
          </p>
          <ul className="mt-3 list-inside list-disc space-y-1 text-xs text-ink-500">
            <li>
              <span className="font-medium text-ink-700">CSV</span> — COBie.Component columns
              (Name, CreatedBy, TypeName, Space, SerialNumber, InstallationDate,
              WarrantyStartDate, TagNumber, AssetIdentifier), one row per asset.
            </li>
            <li>
              <span className="font-medium text-ink-700">JSON</span> — the same components plus
              derived <span className="font-mono">types</span> roll-ups and the project{" "}
              <span className="font-mono">spaces</span> (location) register, for programmatic
              ingestion.
            </li>
          </ul>
          <ErrorAlert message={error} />
          <div className="mt-4 flex flex-wrap gap-2">
            <Button
              disabled={busy !== null}
              onClick={() =>
                void download(`/api/v1/projects/${projectId}/cobie.csv`, "cobie-components.csv")
              }
            >
              {busy === "cobie-components.csv" ? "Preparing…" : "Download COBie CSV"}
            </Button>
            <Button
              variant="secondary"
              disabled={busy !== null}
              onClick={() =>
                void download(`/api/v1/projects/${projectId}/cobie.json`, "cobie-components.json")
              }
            >
              {busy === "cobie-components.json" ? "Preparing…" : "Download COBie JSON"}
            </Button>
          </div>
        </CardBody>
      </Card>

      <Card className="mt-4">
        <CardBody>
          <h3 className="text-sm font-semibold text-ink-900">
            Why this matters (ISO 19650 golden thread)
          </h3>
          <p className="mt-2 text-xs leading-5 text-ink-500">
            The asset then lives 30-60 years. Handover quality is enforced upstream in this
            module: assets carry unique persistent tag codes, BIM element links preserve the
            geometry thread from the IFC GlobalId, delivery milestones gate information
            containers by CDE state and suitability code, and sensor channels keep the same
            asset identities alive through operation — so the twin created here is the twin the
            operator runs.
          </p>
        </CardBody>
      </Card>
    </div>
  );
}
