import { useEffect, useState } from "react";
import { NavLink, Outlet, useParams } from "react-router-dom";
import { api } from "../lib/api";

interface ProjectSummary {
  id: string;
  name: string;
  number: string | null;
  stage: string;
}

const tabs = [
  { to: "", label: "Overview", end: true },
  { to: "drawings", label: "Drawings" },
  { to: "bim", label: "BIM" },
  { to: "twin", label: "Digital Twin" },
  { to: "rfis", label: "RFIs" },
  { to: "submittals", label: "Submittals" },
  { to: "daily-logs", label: "Daily Logs" },
  { to: "punch", label: "Punch" },
  { to: "photos", label: "Photos" },
  { to: "documents", label: "Documents" },
  { to: "schedule", label: "Schedule" },
  { to: "commercial", label: "Commercial" },
  { to: "contracts", label: "Contracts" },
  { to: "forensics", label: "Forensics" },
  { to: "payments", label: "Payments" },
  { to: "assurance", label: "Assurance" },
  { to: "ai", label: "AI" },
];

export default function ProjectLayout() {
  const { projectId } = useParams<{ projectId: string }>();
  const [project, setProject] = useState<ProjectSummary | null>(null);

  useEffect(() => {
    if (!projectId) return;
    api
      .get<ProjectSummary>(`/api/v1/projects/${projectId}`)
      .then(setProject)
      .catch(() => setProject(null));
  }, [projectId]);

  return (
    <div>
      <div className="mb-4">
        <div className="text-xs uppercase tracking-wide text-ink-400">
          {project?.number ?? "Project"}
        </div>
        <h1 className="text-lg font-semibold text-ink-900">{project?.name ?? "…"}</h1>
      </div>
      <div className="mb-5 flex flex-wrap gap-1 border-b border-ink-200">
        {tabs.map((tab) => (
          <NavLink
            key={tab.to}
            to={tab.to}
            end={tab.end}
            className={({ isActive }) =>
              `-mb-px border-b-2 px-3 py-2 text-sm transition-colors ${
                isActive
                  ? "border-brand-600 font-medium text-brand-700"
                  : "border-transparent text-ink-500 hover:border-ink-300 hover:text-ink-800"
              }`
            }
          >
            {tab.label}
          </NavLink>
        ))}
      </div>
      <Outlet />
    </div>
  );
}
