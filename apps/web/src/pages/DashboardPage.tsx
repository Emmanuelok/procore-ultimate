import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { Badge, Card, CardBody, EmptyState, ErrorAlert, Spinner } from "../ui";
import { formatDateTime, formatMoney, humanize, locationLabel, stageTone } from "./format";

interface ProjectItem {
  id: string;
  name: string;
  number?: string | null;
  stage?: string | null;
  city?: string | null;
  country?: string | null;
  value?: string | number | null;
  currency?: string | null;
  startDate?: string | null;
  finishDate?: string | null;
}

interface NotificationItem {
  id: string;
  kind?: string | null;
  title?: string | null;
  body?: string | null;
  readAt?: string | null;
  createdAt?: string | null;
}

interface ListResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

function greeting(): string {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

const quickLinks = [
  { to: "/projects", label: "Projects", hint: "Portfolio & delivery" },
  { to: "/directory", label: "Directory", hint: "Vendors, contacts & users" },
  { to: "/notifications", label: "Notifications", hint: "Everything addressed to you" },
  { to: "/admin", label: "Admin", hint: "Permissions & access" },
];

export default function DashboardPage() {
  const { user, company } = useAuth();
  const [projects, setProjects] = useState<ProjectItem[] | null>(null);
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [unread, setUnread] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .get<ListResponse<ProjectItem>>("/api/v1/projects?page=1&pageSize=12")
      .then((res) => {
        if (!cancelled) setProjects(res.items);
      })
      .catch((err: Error) => {
        if (!cancelled) {
          setError(err.message);
          setProjects([]);
        }
      });
    api
      .get<ListResponse<NotificationItem>>("/api/v1/notifications?page=1&pageSize=8")
      .then((res) => {
        if (!cancelled) setNotifications(res.items);
      })
      .catch(() => undefined);
    api
      .get<Record<string, unknown>>("/api/v1/notifications/unread-count")
      .then((res) => {
        if (!cancelled) setUnread(Number(res["count"] ?? res["unread"] ?? 0));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const firstName = user?.name?.split(" ")[0] ?? "there";

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-ink-900">
          {greeting()}, {firstName}
        </h1>
        <p className="mt-0.5 text-sm text-ink-500">
          {company ? `${company.name} — delivery and assurance at a glance.` : "Welcome back."}
        </p>
      </div>

      <ErrorAlert message={error} />

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        <div className="xl:col-span-2">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-500">
              Your projects
            </h2>
            <Link to="/projects" className="text-sm font-medium text-brand-700 hover:text-brand-800">
              View all
            </Link>
          </div>
          {projects === null ? (
            <Spinner />
          ) : projects.length === 0 ? (
            <EmptyState
              title="Create your first project"
              hint="Projects hold your documents, drawings, RFIs, submittals, field records and the assurance evidence behind them."
              action={
                <Link
                  to="/projects"
                  className="inline-flex items-center rounded-md bg-brand-600 px-3.5 py-2 text-sm font-medium text-white hover:bg-brand-700"
                >
                  Go to Projects
                </Link>
              }
            />
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              {projects.map((p) => (
                <Link key={p.id} to={`/projects/${p.id}`} className="group">
                  <Card className="h-full transition-shadow group-hover:shadow-md">
                    <CardBody>
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="truncate text-sm font-semibold text-ink-900 group-hover:text-brand-700">
                            {p.name}
                          </div>
                          <div className="mt-0.5 text-xs text-ink-400">
                            {p.number ? `#${p.number}` : "No number"}
                          </div>
                        </div>
                        <Badge tone={stageTone(p.stage)}>{humanize(p.stage)}</Badge>
                      </div>
                      <div className="mt-3 flex items-center justify-between text-xs text-ink-500">
                        <span>{locationLabel(p.city, p.country)}</span>
                        <span className="font-medium text-ink-700">
                          {formatMoney(p.value, p.currency)}
                        </span>
                      </div>
                    </CardBody>
                  </Card>
                </Link>
              ))}
            </div>
          )}
        </div>

        <div className="space-y-6">
          <div>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-ink-500">
                Notifications
                {unread > 0 ? (
                  <span className="inline-flex items-center rounded-full bg-brand-600 px-2 py-0.5 text-[10px] font-semibold text-white">
                    {unread} unread
                  </span>
                ) : null}
              </h2>
              <Link
                to="/notifications"
                className="text-sm font-medium text-brand-700 hover:text-brand-800"
              >
                View all
              </Link>
            </div>
            <Card>
              {notifications.length === 0 ? (
                <CardBody>
                  <p className="py-4 text-center text-xs text-ink-400">You're all caught up.</p>
                </CardBody>
              ) : (
                <ul className="divide-y divide-ink-100">
                  {notifications.map((n) => (
                    <li key={n.id} className="px-4 py-2.5">
                      <div className="flex items-start gap-2">
                        <span
                          className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${
                            n.readAt ? "bg-ink-200" : "bg-brand-600"
                          }`}
                        />
                        <div className="min-w-0">
                          <p
                            className={`truncate text-sm ${
                              n.readAt ? "text-ink-600" : "font-medium text-ink-900"
                            }`}
                          >
                            {n.title || humanize(n.kind)}
                          </p>
                          <p className="text-xs text-ink-400">{formatDateTime(n.createdAt)}</p>
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>

          <div>
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-ink-500">
              Quick links
            </h2>
            <Card>
              <ul className="divide-y divide-ink-100">
                {quickLinks.map((q) => (
                  <li key={q.to}>
                    <Link to={q.to} className="block px-4 py-2.5 hover:bg-ink-50">
                      <span className="block text-sm font-medium text-ink-800">{q.label}</span>
                      <span className="block text-xs text-ink-400">{q.hint}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}
