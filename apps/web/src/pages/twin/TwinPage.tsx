/**
 * Digital Twin workspace — asset register, sensor/IoT channels, ISO 19650
 * delivery milestones and COBie handover (spec Vol II Domain L).
 */
import { useState } from "react";
import { useParams } from "react-router-dom";
import { PageHeader } from "../../ui";
import AssetsTab from "./AssetsTab";
import SensorsTab from "./SensorsTab";
import MilestonesTab from "./MilestonesTab";
import HandoverTab from "./HandoverTab";

type TwinTab = "assets" | "sensors" | "milestones" | "handover";

const TABS: { id: TwinTab; label: string }[] = [
  { id: "assets", label: "Assets" },
  { id: "sensors", label: "Sensors" },
  { id: "milestones", label: "Delivery Milestones" },
  { id: "handover", label: "Handover" },
];

export default function TwinPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [tab, setTab] = useState<TwinTab>("assets");

  if (!projectId) return null;

  return (
    <div>
      <PageHeader
        title="Digital Twin"
        subtitle="Asset register, IoT telemetry, ISO 19650 information delivery and COBie handover"
      />

      <div className="mb-5 flex flex-wrap gap-1 rounded-lg bg-white p-1 shadow-sm ring-1 ring-ink-100">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={`rounded-md px-3.5 py-1.5 text-sm font-medium transition-colors ${
              tab === t.id
                ? "bg-brand-600 text-white"
                : "text-ink-600 hover:bg-ink-100 hover:text-ink-900"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "assets" && <AssetsTab projectId={projectId} />}
      {tab === "sensors" && <SensorsTab projectId={projectId} />}
      {tab === "milestones" && <MilestonesTab projectId={projectId} />}
      {tab === "handover" && <HandoverTab projectId={projectId} />}
    </div>
  );
}
