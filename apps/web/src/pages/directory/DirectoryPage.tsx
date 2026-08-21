import { useCallback, useEffect, useState, type FormEvent } from "react";
import { COMPANY_ROLES } from "@constructos/shared";
import { api, ApiClientError } from "../../lib/api";
import {
  Badge,
  Button,
  EmptyState,
  ErrorAlert,
  Field,
  Input,
  Modal,
  PageHeader,
  Select,
  Spinner,
  Table,
  Td,
  Th,
  statusTone,
} from "../../ui";
import { humanize, locationLabel } from "../format";

/* ------------------------------- shared bits ------------------------------- */

interface ListResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

const TABS = ["Vendors", "Contacts", "Users", "Groups"] as const;
type Tab = (typeof TABS)[number];

function errMsg(err: unknown, fallback: string): string {
  return err instanceof ApiClientError || err instanceof Error ? err.message : fallback;
}

/* --------------------------------- Vendors --------------------------------- */

interface Vendor {
  id: string;
  name: string;
  tradeCodes?: string[] | null;
  email?: string | null;
  phone?: string | null;
  city?: string | null;
  country?: string | null;
  status?: string | null;
}

interface VendorForm {
  name: string;
  tradeCodes: string;
  email: string;
  phone: string;
  city: string;
  country: string;
}

const emptyVendorForm: VendorForm = {
  name: "",
  tradeCodes: "",
  email: "",
  phone: "",
  city: "",
  country: "",
};

function VendorsTab() {
  const [items, setItems] = useState<Vendor[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Vendor | null>(null);
  const [form, setForm] = useState<VendorForm>(emptyVendorForm);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await api.get<ListResponse<Vendor>>("/api/v1/vendors?page=1&pageSize=100");
      setItems(res.items);
    } catch (err) {
      setItems([]);
      setError(errMsg(err, "Failed to load vendors"));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function openCreate() {
    setEditing(null);
    setForm(emptyVendorForm);
    setFormError(null);
    setModalOpen(true);
  }

  function openEdit(v: Vendor) {
    setEditing(v);
    setForm({
      name: v.name,
      tradeCodes: (v.tradeCodes ?? []).join(", "),
      email: v.email ?? "",
      phone: v.phone ?? "",
      city: v.city ?? "",
      country: v.country ?? "",
    });
    setFormError(null);
    setModalOpen(true);
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    setBusy(true);
    try {
      const payload = {
        name: form.name.trim(),
        tradeCodes: form.tradeCodes
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        email: form.email.trim() || null,
        phone: form.phone.trim() || null,
        city: form.city.trim() || null,
        country: form.country.trim() || null,
      };
      if (editing) await api.patch(`/api/v1/vendors/${editing.id}`, payload);
      else await api.post("/api/v1/vendors", payload);
      setModalOpen(false);
      await load();
    } catch (err) {
      setFormError(errMsg(err, "Failed to save vendor"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="mb-3 flex justify-end">
        <Button size="sm" onClick={openCreate}>
          New vendor
        </Button>
      </div>
      <ErrorAlert message={error} />
      {items === null ? (
        <Spinner />
      ) : items.length === 0 ? (
        <EmptyState
          title="No vendors yet"
          hint="Add the subcontractors and suppliers you work with."
          action={<Button onClick={openCreate}>Add vendor</Button>}
        />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Name</Th>
              <Th>Trades</Th>
              <Th>Email</Th>
              <Th>Phone</Th>
              <Th>Location</Th>
              <Th>Status</Th>
              <Th />
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {items.map((v) => (
              <tr key={v.id} className="hover:bg-ink-50/60">
                <Td className="font-medium">{v.name}</Td>
                <Td>
                  <span className="flex flex-wrap gap-1">
                    {(v.tradeCodes ?? []).length === 0
                      ? "—"
                      : (v.tradeCodes ?? []).map((t) => (
                          <Badge key={t} tone="gray">
                            {t}
                          </Badge>
                        ))}
                  </span>
                </Td>
                <Td>{v.email ?? "—"}</Td>
                <Td>{v.phone ?? "—"}</Td>
                <Td>{locationLabel(v.city, v.country)}</Td>
                <Td>
                  <Badge tone={statusTone(v.status ?? "")}>{humanize(v.status ?? "active")}</Badge>
                </Td>
                <Td className="text-right">
                  <Button variant="ghost" size="sm" onClick={() => openEdit(v)}>
                    Edit
                  </Button>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      <Modal
        open={modalOpen}
        title={editing ? "Edit vendor" : "New vendor"}
        onClose={() => setModalOpen(false)}
      >
        <ErrorAlert message={formError} />
        <form onSubmit={onSubmit} className="space-y-4">
          <Field label="Name">
            <Input
              required
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </Field>
          <Field label="Trade codes" hint="Comma-separated, e.g. 03 30 00, 09 91 00">
            <Input
              value={form.tradeCodes}
              onChange={(e) => setForm({ ...form, tradeCodes: e.target.value })}
            />
          </Field>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Email">
              <Input
                type="email"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
              />
            </Field>
            <Field label="Phone">
              <Input
                value={form.phone}
                onChange={(e) => setForm({ ...form, phone: e.target.value })}
              />
            </Field>
            <Field label="City">
              <Input
                value={form.city}
                onChange={(e) => setForm({ ...form, city: e.target.value })}
              />
            </Field>
            <Field label="Country">
              <Input
                value={form.country}
                onChange={(e) => setForm({ ...form, country: e.target.value })}
              />
            </Field>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setModalOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Saving…" : editing ? "Save changes" : "Create vendor"}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

/* --------------------------------- Contacts -------------------------------- */

interface Contact {
  id: string;
  name: string;
  email?: string | null;
  phone?: string | null;
  title?: string | null;
  vendorId?: string | null;
}

interface ContactForm {
  name: string;
  email: string;
  phone: string;
  title: string;
  vendorId: string;
}

const emptyContactForm: ContactForm = { name: "", email: "", phone: "", title: "", vendorId: "" };

function ContactsTab() {
  const [items, setItems] = useState<Contact[] | null>(null);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Contact | null>(null);
  const [form, setForm] = useState<ContactForm>(emptyContactForm);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await api.get<ListResponse<Contact>>("/api/v1/contacts?page=1&pageSize=100");
      setItems(res.items);
    } catch (err) {
      setItems([]);
      setError(errMsg(err, "Failed to load contacts"));
    }
    try {
      const res = await api.get<ListResponse<Vendor>>("/api/v1/vendors?page=1&pageSize=100");
      setVendors(res.items);
    } catch {
      setVendors([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const vendorName = (id: string | null | undefined) =>
    vendors.find((v) => v.id === id)?.name ?? "—";

  function openCreate() {
    setEditing(null);
    setForm(emptyContactForm);
    setFormError(null);
    setModalOpen(true);
  }

  function openEdit(c: Contact) {
    setEditing(c);
    setForm({
      name: c.name,
      email: c.email ?? "",
      phone: c.phone ?? "",
      title: c.title ?? "",
      vendorId: c.vendorId ?? "",
    });
    setFormError(null);
    setModalOpen(true);
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    setBusy(true);
    try {
      const payload = {
        name: form.name.trim(),
        email: form.email.trim() || null,
        phone: form.phone.trim() || null,
        title: form.title.trim() || null,
        vendorId: form.vendorId || null,
      };
      if (editing) await api.patch(`/api/v1/contacts/${editing.id}`, payload);
      else await api.post("/api/v1/contacts", payload);
      setModalOpen(false);
      await load();
    } catch (err) {
      setFormError(errMsg(err, "Failed to save contact"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="mb-3 flex justify-end">
        <Button size="sm" onClick={openCreate}>
          New contact
        </Button>
      </div>
      <ErrorAlert message={error} />
      {items === null ? (
        <Spinner />
      ) : items.length === 0 ? (
        <EmptyState
          title="No contacts yet"
          hint="Track the people you coordinate with at each vendor."
          action={<Button onClick={openCreate}>Add contact</Button>}
        />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Name</Th>
              <Th>Title</Th>
              <Th>Vendor</Th>
              <Th>Email</Th>
              <Th>Phone</Th>
              <Th />
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {items.map((c) => (
              <tr key={c.id} className="hover:bg-ink-50/60">
                <Td className="font-medium">{c.name}</Td>
                <Td>{c.title ?? "—"}</Td>
                <Td>{vendorName(c.vendorId)}</Td>
                <Td>{c.email ?? "—"}</Td>
                <Td>{c.phone ?? "—"}</Td>
                <Td className="text-right">
                  <Button variant="ghost" size="sm" onClick={() => openEdit(c)}>
                    Edit
                  </Button>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      <Modal
        open={modalOpen}
        title={editing ? "Edit contact" : "New contact"}
        onClose={() => setModalOpen(false)}
      >
        <ErrorAlert message={formError} />
        <form onSubmit={onSubmit} className="space-y-4">
          <Field label="Name">
            <Input
              required
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </Field>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Title">
              <Input
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
                placeholder="Project Manager"
              />
            </Field>
            <Field label="Vendor">
              <Select
                value={form.vendorId}
                onChange={(e) => setForm({ ...form, vendorId: e.target.value })}
              >
                <option value="">No vendor</option>
                {vendors.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Email">
              <Input
                type="email"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
              />
            </Field>
            <Field label="Phone">
              <Input
                value={form.phone}
                onChange={(e) => setForm({ ...form, phone: e.target.value })}
              />
            </Field>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setModalOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Saving…" : editing ? "Save changes" : "Create contact"}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

/* ---------------------------------- Users ---------------------------------- */

interface CompanyUser {
  userId: string;
  name?: string | null;
  email?: string | null;
  role?: string | null;
}

function roleTone(role: string | null | undefined): string {
  if (role === "owner") return "violet";
  if (role === "admin") return "blue";
  if (role === "guest") return "amber";
  return "gray";
}

function UsersTab() {
  const [items, setItems] = useState<CompanyUser[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [form, setForm] = useState({ name: "", email: "", role: "member" });
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tempPassword, setTempPassword] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await api.get<ListResponse<CompanyUser>>(
        "/api/v1/company/users?page=1&pageSize=100",
      );
      setItems(res.items);
    } catch (err) {
      setItems([]);
      setError(errMsg(err, "Failed to load users"));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function openInvite() {
    setForm({ name: "", email: "", role: "member" });
    setFormError(null);
    setTempPassword(null);
    setCopied(false);
    setInviteOpen(true);
  }

  async function onInvite(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    setBusy(true);
    try {
      const res = await api.post<{ tempPassword?: string }>("/api/v1/company/users/invite", {
        email: form.email.trim(),
        name: form.name.trim(),
        role: form.role,
      });
      if (res && res.tempPassword) {
        setTempPassword(res.tempPassword);
      } else {
        setInviteOpen(false);
      }
      await load();
    } catch (err) {
      setFormError(errMsg(err, "Failed to invite user"));
    } finally {
      setBusy(false);
    }
  }

  async function copyPassword() {
    if (!tempPassword) return;
    try {
      await navigator.clipboard.writeText(tempPassword);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div>
      <div className="mb-3 flex justify-end">
        <Button size="sm" onClick={openInvite}>
          Invite user
        </Button>
      </div>
      <ErrorAlert message={error} />
      {items === null ? (
        <Spinner />
      ) : items.length === 0 ? (
        <EmptyState title="No users yet" hint="Invite teammates into this company." />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Name</Th>
              <Th>Email</Th>
              <Th>Company role</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {items.map((u) => (
              <tr key={u.userId} className="hover:bg-ink-50/60">
                <Td className="font-medium">{u.name ?? "—"}</Td>
                <Td>{u.email ?? "—"}</Td>
                <Td>
                  <Badge tone={roleTone(u.role)}>{humanize(u.role ?? "member")}</Badge>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      <Modal
        open={inviteOpen}
        title={tempPassword ? "User invited" : "Invite user"}
        onClose={() => setInviteOpen(false)}
      >
        {tempPassword ? (
          <div>
            <p className="mb-3 text-sm text-ink-600">
              Share this temporary password securely with the new user. It is shown{" "}
              <span className="font-semibold">only once</span> — it cannot be retrieved later.
            </p>
            <div className="flex items-center gap-2 rounded-md bg-amber-50 px-3 py-2 ring-1 ring-amber-200">
              <code className="flex-1 select-all break-all font-mono text-sm text-amber-900">
                {tempPassword}
              </code>
              <Button variant="secondary" size="sm" onClick={copyPassword}>
                {copied ? "Copied" : "Copy"}
              </Button>
            </div>
            <div className="mt-4 flex justify-end">
              <Button onClick={() => setInviteOpen(false)}>Done</Button>
            </div>
          </div>
        ) : (
          <>
            <ErrorAlert message={formError} />
            <form onSubmit={onInvite} className="space-y-4">
              <Field label="Full name">
                <Input
                  required
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
              </Field>
              <Field label="Email">
                <Input
                  type="email"
                  required
                  value={form.email}
                  onChange={(e) => setForm({ ...form, email: e.target.value })}
                />
              </Field>
              <Field label="Company role">
                <Select
                  value={form.role}
                  onChange={(e) => setForm({ ...form, role: e.target.value })}
                >
                  {COMPANY_ROLES.filter((r) => r !== "owner").map((r) => (
                    <option key={r} value={r}>
                      {humanize(r)}
                    </option>
                  ))}
                </Select>
              </Field>
              <div className="flex justify-end gap-2">
                <Button variant="secondary" onClick={() => setInviteOpen(false)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={busy}>
                  {busy ? "Inviting…" : "Send invite"}
                </Button>
              </div>
            </form>
          </>
        )}
      </Modal>
    </div>
  );
}

/* ---------------------------------- Groups --------------------------------- */

interface Group {
  id: string;
  name: string;
  memberCount?: number | null;
}

interface GroupMember {
  id: string;
  userId?: string | null;
  name?: string | null;
  email?: string | null;
}

function GroupsTab() {
  const [items, setItems] = useState<Group[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [expanded, setExpanded] = useState<string | null>(null);
  const [members, setMembers] = useState<GroupMember[] | null>(null);
  const [memberError, setMemberError] = useState<string | null>(null);
  const [users, setUsers] = useState<CompanyUser[]>([]);
  const [addUserId, setAddUserId] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await api.get<ListResponse<Group>>(
        "/api/v1/distribution-groups?page=1&pageSize=100",
      );
      setItems(res.items);
    } catch (err) {
      setItems([]);
      setError(errMsg(err, "Failed to load distribution groups"));
    }
  }, []);

  useEffect(() => {
    void load();
    api
      .get<ListResponse<CompanyUser>>("/api/v1/company/users?page=1&pageSize=100")
      .then((res) => setUsers(res.items))
      .catch(() => setUsers([]));
  }, [load]);

  const loadMembers = useCallback(async (groupId: string) => {
    setMembers(null);
    setMemberError(null);
    try {
      const res = await api.get<ListResponse<GroupMember>>(
        `/api/v1/distribution-groups/${groupId}/members`,
      );
      setMembers(res.items);
    } catch (err) {
      setMembers([]);
      setMemberError(errMsg(err, "Failed to load members"));
    }
  }, []);

  function toggleExpand(groupId: string) {
    if (expanded === groupId) {
      setExpanded(null);
      setMembers(null);
    } else {
      setExpanded(groupId);
      void loadMembers(groupId);
    }
  }

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    setBusy(true);
    try {
      await api.post("/api/v1/distribution-groups", { name: name.trim() });
      setCreateOpen(false);
      setName("");
      await load();
    } catch (err) {
      setFormError(errMsg(err, "Failed to create group"));
    } finally {
      setBusy(false);
    }
  }

  async function addMember() {
    if (!expanded || !addUserId) return;
    setMemberError(null);
    try {
      await api.post(`/api/v1/distribution-groups/${expanded}/members`, { userId: addUserId });
      setAddUserId("");
      await loadMembers(expanded);
    } catch (err) {
      setMemberError(errMsg(err, "Failed to add member"));
    }
  }

  async function removeMember(m: GroupMember) {
    if (!expanded) return;
    setMemberError(null);
    try {
      await api.del(`/api/v1/distribution-groups/${expanded}/members/${m.userId ?? m.id}`);
      await loadMembers(expanded);
    } catch (err) {
      setMemberError(errMsg(err, "Failed to remove member"));
    }
  }

  return (
    <div>
      <div className="mb-3 flex justify-end">
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          New group
        </Button>
      </div>
      <ErrorAlert message={error} />
      {items === null ? (
        <Spinner />
      ) : items.length === 0 ? (
        <EmptyState
          title="No distribution groups"
          hint="Groups make it easy to distribute RFIs, submittals and notices to the right people."
          action={<Button onClick={() => setCreateOpen(true)}>Create group</Button>}
        />
      ) : (
        <div className="space-y-2">
          {items.map((g) => (
            <div key={g.id} className="rounded-lg bg-white shadow-sm ring-1 ring-ink-100">
              <button
                type="button"
                onClick={() => toggleExpand(g.id)}
                className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-ink-50"
              >
                <span className="text-sm font-medium text-ink-900">{g.name}</span>
                <span className="text-xs text-ink-400">
                  {g.memberCount !== null && g.memberCount !== undefined
                    ? `${g.memberCount} member${g.memberCount === 1 ? "" : "s"} · `
                    : ""}
                  {expanded === g.id ? "Hide" : "Show"} members
                </span>
              </button>
              {expanded === g.id ? (
                <div className="border-t border-ink-100 px-4 py-3">
                  <ErrorAlert message={memberError} />
                  {members === null ? (
                    <Spinner />
                  ) : (
                    <>
                      {members.length === 0 ? (
                        <p className="mb-2 text-xs text-ink-400">No members yet.</p>
                      ) : (
                        <ul className="mb-3 divide-y divide-ink-100">
                          {members.map((m) => (
                            <li
                              key={m.id}
                              className="flex items-center justify-between py-1.5 text-sm"
                            >
                              <span>
                                <span className="font-medium text-ink-800">
                                  {m.name ?? m.email ?? m.userId ?? m.id}
                                </span>{" "}
                                {m.email && m.name ? (
                                  <span className="text-xs text-ink-400">{m.email}</span>
                                ) : null}
                              </span>
                              <Button variant="ghost" size="sm" onClick={() => removeMember(m)}>
                                Remove
                              </Button>
                            </li>
                          ))}
                        </ul>
                      )}
                      <div className="flex items-center gap-2">
                        <div className="w-64">
                          <Select
                            value={addUserId}
                            onChange={(e) => setAddUserId(e.target.value)}
                          >
                            <option value="">Add a member…</option>
                            {users
                              .filter((u) => !members.some((m) => m.userId === u.userId))
                              .map((u) => (
                                <option key={u.userId} value={u.userId}>
                                  {u.name ?? u.email ?? u.userId}
                                </option>
                              ))}
                          </Select>
                        </div>
                        <Button size="sm" disabled={!addUserId} onClick={addMember}>
                          Add
                        </Button>
                      </div>
                    </>
                  )}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}

      <Modal open={createOpen} title="New distribution group" onClose={() => setCreateOpen(false)}>
        <ErrorAlert message={formError} />
        <form onSubmit={onCreate} className="space-y-4">
          <Field label="Group name">
            <Input
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Design team"
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Creating…" : "Create group"}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

/* ---------------------------------- Page ----------------------------------- */

export default function DirectoryPage() {
  const [tab, setTab] = useState<Tab>("Vendors");

  return (
    <div>
      <PageHeader
        title="Directory"
        subtitle="Vendors, contacts, company users and distribution groups"
      />
      <div className="mb-5 flex gap-1 border-b border-ink-200">
        {TABS.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm transition-colors ${
              tab === t
                ? "border-brand-600 font-medium text-brand-700"
                : "border-transparent text-ink-500 hover:border-ink-300 hover:text-ink-800"
            }`}
          >
            {t}
          </button>
        ))}
      </div>
      {tab === "Vendors" ? <VendorsTab /> : null}
      {tab === "Contacts" ? <ContactsTab /> : null}
      {tab === "Users" ? <UsersTab /> : null}
      {tab === "Groups" ? <GroupsTab /> : null}
    </div>
  );
}
