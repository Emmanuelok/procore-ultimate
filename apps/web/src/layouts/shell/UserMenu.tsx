/**
 * shell/UserMenu.tsx — identity, company switching and sign out.
 *
 * The company list comes from GET /api/v1/me (via AuthProvider); switching
 * rewrites the `x-company-id` header the API client sends on every request,
 * so the whole app re-scopes. With more than a handful of companies the
 * switcher becomes a searchable command list rather than an unusable menu.
 */
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Avatar,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandRoot,
  Dialog,
  DropdownMenu,
  MenuItem,
  MenuLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
} from "../../ui";
import { cx } from "../../ui/cx";
import {
  IconCheck,
  IconChevronsUpDown,
  IconCompany,
  IconKeyboard,
  IconLock,
  IconLogout,
} from "../../ui/icons";
import { useAuth } from "../../lib/auth";
import { useShortcuts } from "../../lib/shortcuts";

/** Above this many companies the menu becomes a searchable dialog. */
const SEARCHABLE_THRESHOLD = 5;

export function UserMenu() {
  const { user, company, companyId, setCompanyId, logout } = useAuth();
  const { openHelp } = useShortcuts();
  const navigate = useNavigate();
  const [switcherOpen, setSwitcherOpen] = useState(false);

  const companies = useMemo(() => user?.companies ?? [], [user]);
  const many = companies.length > SEARCHABLE_THRESHOLD;

  if (!user) return null;

  const signOut = () => {
    logout();
    navigate("/login");
  };

  return (
    <>
      <DropdownMenu
        placement="bottom-end"
        width={264}
        trigger={
          <button
            type="button"
            aria-label="Account menu"
            className={cx(
              "flex h-8 max-w-[13rem] shrink-0 items-center gap-2 rounded-md pl-1 pr-1.5",
              "text-content-muted transition-colors duration-fast",
              "hover:bg-surface-hover hover:text-content focus-visible:ring-2 focus-visible:ring-ring",
            )}
          >
            <Avatar name={user.name} size="xs" />
            <span className="hidden min-w-0 flex-col items-start leading-none md:flex">
              <span className="max-w-[9rem] truncate text-meta font-medium text-content">
                {user.name}
              </span>
              {company ? (
                <span className="mt-0.5 max-w-[9rem] truncate text-2xs text-content-subtle">
                  {company.name}
                </span>
              ) : null}
            </span>
            <IconChevronsUpDown size={13} className="shrink-0 opacity-70" />
          </button>
        }
        header={
          <div className="flex items-start gap-2.5 px-3 py-2.5">
            <Avatar name={user.name} size="sm" />
            <div className="min-w-0">
              <div className="truncate text-body font-medium text-content">{user.name}</div>
              <div className="truncate text-meta text-content-subtle">{user.email}</div>
            </div>
          </div>
        }
      >
        {companies.length > 1 && !many ? (
          <>
            <MenuRadioGroup
              label="Company"
              value={companyId ?? ""}
              onValueChange={(next) => setCompanyId(next)}
            >
              {companies.map((entry) => (
                <MenuRadioItem key={entry.id} value={entry.id} icon={IconCompany}>
                  {entry.name}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
            <MenuSeparator />
          </>
        ) : null}

        {many ? (
          <>
            <MenuLabel>Company</MenuLabel>
            <MenuItem
              icon={IconCompany}
              description={company?.name ?? "No company selected"}
              onSelect={() => setSwitcherOpen(true)}
            >
              Switch company…
            </MenuItem>
            <MenuSeparator />
          </>
        ) : null}

        {companies.length === 1 && company ? (
          <>
            <MenuLabel>Company</MenuLabel>
            <MenuItem icon={IconCompany} disabled>
              {company.name}
            </MenuItem>
            <MenuSeparator />
          </>
        ) : null}

        {/* The only route into /account/security, which owns sessions and
            devices, the second factor, linked identities and the account's
            own security trail. Without a link it was reachable by typing the
            URL and nothing else. */}
        <MenuItem
          icon={IconLock}
          description="Devices, two-factor, sign-in methods"
          onSelect={() => navigate("/account/security")}
        >
          Account security
        </MenuItem>
        <MenuItem icon={IconKeyboard} shortcut="?" onSelect={openHelp}>
          Keyboard shortcuts
        </MenuItem>
        <MenuSeparator />
        <MenuItem icon={IconLogout} destructive onSelect={signOut}>
          Sign out
        </MenuItem>
      </DropdownMenu>

      <CompanySwitcher
        open={switcherOpen}
        onOpenChange={setSwitcherOpen}
        companies={companies}
        currentId={companyId}
        onPick={(id) => {
          setCompanyId(id);
          setSwitcherOpen(false);
        }}
      />
    </>
  );
}

/* ==========================================================================
   Searchable switcher
========================================================================== */

interface CompanyOption {
  id: string;
  name: string;
  slug: string;
  role: string;
}

function CompanySwitcher({
  open,
  onOpenChange,
  companies,
  currentId,
  onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  companies: readonly CompanyOption[];
  currentId: string | null;
  onPick: (id: string) => void;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Switch company"
      description="Everything in ConstructOS is scoped to one company at a time."
      icon={IconCompany}
      size="sm"
      unpaddedBody
    >
      <CommandRoot label="Companies" loop>
        <CommandInput placeholder="Search companies…" autoFocus />
        <CommandList>
          <CommandEmpty>
            <p className="px-6 py-8 text-center text-meta text-content-subtle">
              No company matches that name.
            </p>
          </CommandEmpty>
          <CommandGroup>
            {companies.map((entry) => (
              <CommandItem
                key={entry.id}
                value={`${entry.name} ${entry.slug} ${entry.role}`}
                icon={IconCompany}
                description={entry.role}
                trailing={
                  entry.id === currentId ? (
                    <IconCheck size={14} className="text-accent-text" />
                  ) : null
                }
                onSelect={() => onPick(entry.id)}
              >
                {entry.name}
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      </CommandRoot>
    </Dialog>
  );
}
