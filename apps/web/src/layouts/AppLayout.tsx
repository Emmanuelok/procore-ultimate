import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useAuth } from "../lib/auth";

const navItems = [
  { to: "/", label: "Dashboard", end: true },
  { to: "/projects", label: "Projects" },
  { to: "/directory", label: "Directory" },
  { to: "/assurance", label: "Assurance" },
  { to: "/ingestion", label: "Ingestion" },
  { to: "/benchmarks", label: "Benchmarks" },
  { to: "/ledger", label: "Ledger" },
  { to: "/learning", label: "Learning" },
  { to: "/integrations", label: "Integrations" },
  { to: "/notifications", label: "Notifications" },
  { to: "/admin", label: "Admin" },
];

export default function AppLayout() {
  const { user, company, setCompanyId, logout } = useAuth();
  const navigate = useNavigate();

  return (
    <div className="flex h-screen">
      <aside className="flex w-56 shrink-0 flex-col bg-ink-950 text-ink-200">
        <div className="flex items-center gap-2 px-4 py-4">
          <div className="flex h-8 w-8 items-center justify-center rounded-md bg-brand-600 text-sm font-bold text-white">
            C
          </div>
          <div>
            <div className="text-sm font-semibold text-white">ConstructOS</div>
            <div className="text-[10px] uppercase tracking-widest text-ink-400">
              Delivery + Assurance
            </div>
          </div>
        </div>
        <nav className="mt-2 flex-1 space-y-0.5 px-2">
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                `block rounded-md px-3 py-2 text-sm transition-colors ${
                  isActive
                    ? "bg-brand-600/20 font-medium text-white"
                    : "text-ink-300 hover:bg-white/5 hover:text-white"
                }`
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="border-t border-white/10 px-4 py-3">
          {user && user.companies.length > 1 ? (
            <select
              value={company?.id ?? ""}
              onChange={(e) => setCompanyId(e.target.value)}
              className="mb-2 w-full rounded bg-ink-800 px-2 py-1 text-xs text-ink-100"
            >
              {user.companies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          ) : (
            <div className="mb-1 truncate text-xs text-ink-400">{company?.name}</div>
          )}
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-xs text-ink-300">{user?.name}</span>
            <button
              type="button"
              className="text-xs text-ink-400 hover:text-white"
              onClick={() => {
                logout();
                navigate("/login");
              }}
            >
              Sign out
            </button>
          </div>
        </div>
      </aside>
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-7xl px-6 py-6">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
