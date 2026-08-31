/**
 * App — routing and the provider stack.
 *
 * Provider order matters and is deliberate:
 *
 *   BrowserRouter        useNavigate must exist for everything below
 *     AuthProvider       identity + the active company
 *       ShortcutsProvider  one window listener + the "?" cheat sheet
 *         ShellDataProvider live badge counts and the project cache
 *           SearchProvider   the ⌘K palette (claims its own binding)
 *             Routes
 *
 * ThemeProvider, <Toaster /> and the root <AppErrorBoundary> are mounted a
 * level up, in main.tsx.
 */
import { lazy, Suspense, type ReactNode } from "react";
import { BrowserRouter, Route, Routes, useNavigate } from "react-router-dom";
import { AuthProvider, RequireAuth, useAuth } from "./lib/auth";
import { SearchProvider } from "./lib/search";
import { ShortcutsProvider } from "./lib/shortcuts";
import { ShellDataProvider } from "./layouts/shell/shell-data";
import { RouteFallback } from "./layouts/shell/RouteFallback";
import AppLayout from "./layouts/AppLayout";
import ProjectLayout from "./layouts/ProjectLayout";
import { Button, EmptyState } from "./ui";
import { IconEmpty } from "./ui/icons";

const LoginPage = lazy(() => import("./pages/auth/LoginPage"));
const RegisterPage = lazy(() => import("./pages/auth/RegisterPage"));
const DashboardPage = lazy(() => import("./pages/DashboardPage"));
const ProjectsPage = lazy(() => import("./pages/projects/ProjectsPage"));
const ProjectOverviewPage = lazy(() => import("./pages/projects/ProjectOverviewPage"));
const DirectoryPage = lazy(() => import("./pages/directory/DirectoryPage"));
const NotificationsPage = lazy(() => import("./pages/NotificationsPage"));
const AdminPage = lazy(() => import("./pages/admin/AdminPage"));
const DocumentsPage = lazy(() => import("./pages/documents/DocumentsPage"));
const DrawingsPage = lazy(() => import("./pages/drawings/DrawingsPage"));
const SheetViewerPage = lazy(() => import("./pages/drawings/SheetViewerPage"));
const BimPage = lazy(() => import("./pages/bim/BimPage"));
const ModelViewerPage = lazy(() => import("./pages/bim/ModelViewerPage"));
const TwinPage = lazy(() => import("./pages/twin/TwinPage"));
const RfisPage = lazy(() => import("./pages/rfis/RfisPage"));
const RfiDetailPage = lazy(() => import("./pages/rfis/RfiDetailPage"));
const SubmittalsPage = lazy(() => import("./pages/submittals/SubmittalsPage"));
const SubmittalDetailPage = lazy(() => import("./pages/submittals/SubmittalDetailPage"));
const DailyLogsPage = lazy(() => import("./pages/dailylogs/DailyLogsPage"));
const PunchPage = lazy(() => import("./pages/punch/PunchPage"));
const PhotosPage = lazy(() => import("./pages/photos/PhotosPage"));
const AssurancePage = lazy(() => import("./pages/assurance/AssurancePage"));
const CommercialPage = lazy(() => import("./pages/commercial/CommercialPage"));
const SchedulePage = lazy(() => import("./pages/schedule/SchedulePage"));
const RiskPage = lazy(() => import("./pages/risk/RiskPage"));
const LandPage = lazy(() => import("./pages/land/LandPage"));
const WorkforcePage = lazy(() => import("./pages/workforce/WorkforcePage"));
const EsgPage = lazy(() => import("./pages/esg/EsgPage"));
const JurisdictionPage = lazy(() => import("./pages/jurisdiction/JurisdictionPage"));
const AnalyticsPage = lazy(() => import("./pages/analytics/AnalyticsPage"));
const GovernancePage = lazy(() => import("./pages/governance/GovernancePage"));
const FinancePage = lazy(() => import("./pages/finance/FinancePage"));
const DisputesPage = lazy(() => import("./pages/disputes/DisputesPage"));
const ForensicsPage = lazy(() => import("./pages/forensics/ForensicsPage"));
const PaymentsPage = lazy(() => import("./pages/payments/PaymentsPage"));
const ContractsPage = lazy(() => import("./pages/contracts/ContractsPage"));
const ContractDetailPage = lazy(() => import("./pages/contracts/ContractDetailPage"));
const CompanyAssurancePage = lazy(() => import("./pages/assurance/CompanyAssurancePage"));
const AiPage = lazy(() => import("./pages/ai/AiPage"));
const IngestionPage = lazy(() => import("./pages/ingestion/IngestionPage"));
const BenchmarksPage = lazy(() => import("./pages/benchmarks/BenchmarksPage"));
const LedgerPage = lazy(() => import("./pages/ledger/LedgerPage"));
const LearningPage = lazy(() => import("./pages/learning/LearningPage"));
const IntegrationsPage = lazy(() => import("./pages/integrations/IntegrationsPage"));
const InsurancePage = lazy(() => import("./pages/insurance/InsurancePage"));

/* --------------------------------------------------------------------------
 * The financial suite (M2–M6). Five complete, project-scoped workspaces that
 * shipped without routes; each exports a default component and reads
 * `projectId` from useParams.
 * ----------------------------------------------------------------------- */
const BudgetPage = lazy(() => import("./pages/budget/BudgetPage"));
const PrimeContractPage = lazy(() => import("./pages/primecontracts/PrimeContractPage"));
const CommitmentsPage = lazy(() => import("./pages/commitments/CommitmentsPage"));
const ChangesPage = lazy(() => import("./pages/changes/ChangesPage"));
const InvoicingPage = lazy(() => import("./pages/invoicing/InvoicingPage"));

/* --------------------------------------------------------------------------
 * Procore-parity workspaces (M19–M25) and the Phase 8 authentication screens.
 * Every one of them shipped complete and UNREACHABLE: nothing imported them,
 * so vite emitted no chunk and `pnpm build` passing said nothing about them.
 * Two of these paths are load-bearing rather than cosmetic — the SSO callback
 * redirects the browser to /auth/sso/complete, and the links inside every
 * verification, reset and invitation message point at /verify-email,
 * /reset-password and /invitations/accept.
 * ----------------------------------------------------------------------- */
const SafetyPage = lazy(() => import("./pages/safety/SafetyPage"));
const QualityPage = lazy(() => import("./pages/quality/QualityPage"));
const SpecificationsPage = lazy(() => import("./pages/specifications/SpecificationsPage"));
const MeetingsPage = lazy(() => import("./pages/meetings/MeetingsPage"));
const EquipmentPage = lazy(() => import("./pages/equipment/EquipmentPage"));
const TimecardsPage = lazy(() => import("./pages/timecards/TimecardsPage"));
const BiddingPage = lazy(() => import("./pages/bidding/BiddingPage"));

const ForgotPasswordPage = lazy(() => import("./pages/auth/ForgotPasswordPage"));
const ResetPasswordPage = lazy(() => import("./pages/auth/ResetPasswordPage"));
const VerifyEmailPage = lazy(() => import("./pages/auth/VerifyEmailPage"));
const AcceptInvitationPage = lazy(() => import("./pages/auth/AcceptInvitationPage"));
const SsoCompletePage = lazy(() => import("./pages/auth/SsoCompletePage"));
const AccountSecurityPage = lazy(() => import("./pages/auth/AccountSecurityPage"));

/** Per-route suspense: only the page body swaps, never the surrounding chrome. */
function S({ children }: { children: ReactNode }) {
  return <Suspense fallback={<RouteFallback />}>{children}</Suspense>;
}

function NotFound() {
  const navigate = useNavigate();
  return (
    <div className="flex min-h-dvh items-center justify-center bg-surface p-6">
      <EmptyState
        size="lg"
        icon={IconEmpty}
        title="Page not found"
        hint="That address does not match any route in ConstructOS. It may have moved, or the link may be incomplete."
        action={
          <Button size="sm" onClick={() => navigate("/")}>
            Back to dashboard
          </Button>
        }
      />
    </div>
  );
}

/** Keeps the keyboard layer quiet on the unauthenticated screens. */
function Providers({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  return (
    <ShortcutsProvider disabled={!user}>
      <ShellDataProvider>
        <SearchProvider>{children}</SearchProvider>
      </ShellDataProvider>
    </ShortcutsProvider>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Providers>
          <Routes>
            <Route
              path="/login"
              element={
                <S>
                  <LoginPage />
                </S>
              }
            />
            <Route
              path="/register"
              element={
                <S>
                  <RegisterPage />
                </S>
              }
            />
            {/* Public, because the person holding the link is not signed in yet. */}
            <Route
              path="/forgot-password"
              element={
                <S>
                  <ForgotPasswordPage />
                </S>
              }
            />
            <Route
              path="/reset-password"
              element={
                <S>
                  <ResetPasswordPage />
                </S>
              }
            />
            <Route
              path="/verify-email"
              element={
                <S>
                  <VerifyEmailPage />
                </S>
              }
            />
            <Route
              path="/invitations/accept"
              element={
                <S>
                  <AcceptInvitationPage />
                </S>
              }
            />
            {/* The SSO callback redirects the browser here with a single-use
                ticket; it must be reachable without a session. */}
            <Route
              path="/auth/sso/complete"
              element={
                <S>
                  <SsoCompletePage />
                </S>
              }
            />
            <Route
              path="/"
              element={
                <RequireAuth>
                  <AppLayout />
                </RequireAuth>
              }
            >
              <Route
                index
                element={
                  <S>
                    <DashboardPage />
                  </S>
                }
              />
              <Route
                path="projects"
                element={
                  <S>
                    <ProjectsPage />
                  </S>
                }
              />
              <Route
                path="directory"
                element={
                  <S>
                    <DirectoryPage />
                  </S>
                }
              />
              <Route
                path="account/security"
                element={
                  <S>
                    <AccountSecurityPage />
                  </S>
                }
              />
              <Route
                path="assurance"
                element={
                  <S>
                    <CompanyAssurancePage />
                  </S>
                }
              />
              <Route
                path="ingestion"
                element={
                  <S>
                    <IngestionPage />
                  </S>
                }
              />
              <Route
                path="benchmarks"
                element={
                  <S>
                    <BenchmarksPage />
                  </S>
                }
              />
              <Route
                path="ledger"
                element={
                  <S>
                    <LedgerPage />
                  </S>
                }
              />
              <Route
                path="learning"
                element={
                  <S>
                    <LearningPage />
                  </S>
                }
              />
              <Route
                path="integrations"
                element={
                  <S>
                    <IntegrationsPage />
                  </S>
                }
              />
              <Route
                path="notifications"
                element={
                  <S>
                    <NotificationsPage />
                  </S>
                }
              />
              <Route
                path="admin"
                element={
                  <S>
                    <AdminPage />
                  </S>
                }
              />
              <Route path="projects/:projectId" element={<ProjectLayout />}>
                <Route
                  index
                  element={
                    <S>
                      <ProjectOverviewPage />
                    </S>
                  }
                />
                <Route
                  path="documents"
                  element={
                    <S>
                      <DocumentsPage />
                    </S>
                  }
                />
                <Route
                  path="drawings"
                  element={
                    <S>
                      <DrawingsPage />
                    </S>
                  }
                />
                <Route
                  path="drawings/:sheetId"
                  element={
                    <S>
                      <SheetViewerPage />
                    </S>
                  }
                />
                <Route
                  path="bim"
                  element={
                    <S>
                      <BimPage />
                    </S>
                  }
                />
                <Route
                  path="bim/:modelId"
                  element={
                    <S>
                      <ModelViewerPage />
                    </S>
                  }
                />
                <Route
                  path="twin"
                  element={
                    <S>
                      <TwinPage />
                    </S>
                  }
                />
                <Route
                  path="rfis"
                  element={
                    <S>
                      <RfisPage />
                    </S>
                  }
                />
                <Route
                  path="rfis/:rfiId"
                  element={
                    <S>
                      <RfiDetailPage />
                    </S>
                  }
                />
                <Route
                  path="submittals"
                  element={
                    <S>
                      <SubmittalsPage />
                    </S>
                  }
                />
                <Route
                  path="submittals/:submittalId"
                  element={
                    <S>
                      <SubmittalDetailPage />
                    </S>
                  }
                />
                <Route
                  path="daily-logs"
                  element={
                    <S>
                      <DailyLogsPage />
                    </S>
                  }
                />
                <Route
                  path="punch"
                  element={
                    <S>
                      <PunchPage />
                    </S>
                  }
                />
                <Route
                  path="photos"
                  element={
                    <S>
                      <PhotosPage />
                    </S>
                  }
                />
                <Route
                  path="schedule"
                  element={
                    <S>
                      <SchedulePage />
                    </S>
                  }
                />
                <Route
                  path="risk"
                  element={
                    <S>
                      <RiskPage />
                    </S>
                  }
                />
                <Route
                  path="land"
                  element={
                    <S>
                      <LandPage />
                    </S>
                  }
                />
                <Route
                  path="workforce"
                  element={
                    <S>
                      <WorkforcePage />
                    </S>
                  }
                />
                <Route
                  path="esg"
                  element={
                    <S>
                      <EsgPage />
                    </S>
                  }
                />
                <Route
                  path="jurisdiction"
                  element={
                    <S>
                      <JurisdictionPage />
                    </S>
                  }
                />
                <Route
                  path="insurance"
                  element={
                    <S>
                      <InsurancePage />
                    </S>
                  }
                />
                <Route
                  path="analytics"
                  element={
                    <S>
                      <AnalyticsPage />
                    </S>
                  }
                />
                <Route
                  path="governance"
                  element={
                    <S>
                      <GovernancePage />
                    </S>
                  }
                />
                <Route
                  path="finance"
                  element={
                    <S>
                      <FinancePage />
                    </S>
                  }
                />
                <Route
                  path="disputes"
                  element={
                    <S>
                      <DisputesPage />
                    </S>
                  }
                />
                <Route
                  path="forensics"
                  element={
                    <S>
                      <ForensicsPage />
                    </S>
                  }
                />
                <Route
                  path="payments"
                  element={
                    <S>
                      <PaymentsPage />
                    </S>
                  }
                />
                <Route
                  path="commercial"
                  element={
                    <S>
                      <CommercialPage />
                    </S>
                  }
                />
                <Route
                  path="contracts"
                  element={
                    <S>
                      <ContractsPage />
                    </S>
                  }
                />
                <Route
                  path="contracts/:contractId"
                  element={
                    <S>
                      <ContractDetailPage />
                    </S>
                  }
                />
                <Route
                  path="assurance"
                  element={
                    <S>
                      <AssurancePage />
                    </S>
                  }
                />
                <Route
                  path="ai"
                  element={
                    <S>
                      <AiPage />
                    </S>
                  }
                />

                {/* ---- financial suite ---- */}
                <Route
                  path="budget"
                  element={
                    <S>
                      <BudgetPage />
                    </S>
                  }
                />
                <Route
                  path="prime-contract"
                  element={
                    <S>
                      <PrimeContractPage />
                    </S>
                  }
                />
                <Route
                  path="commitments"
                  element={
                    <S>
                      <CommitmentsPage />
                    </S>
                  }
                />
                <Route
                  path="changes"
                  element={
                    <S>
                      <ChangesPage />
                    </S>
                  }
                />
                <Route
                  path="invoicing"
                  element={
                    <S>
                      <InvoicingPage />
                    </S>
                  }
                />

                {/* ---- Procore-parity workspaces (M19–M25) ---- */}
                <Route
                  path="specifications"
                  element={
                    <S>
                      <SpecificationsPage />
                    </S>
                  }
                />
                <Route
                  path="meetings"
                  element={
                    <S>
                      <MeetingsPage />
                    </S>
                  }
                />
                <Route
                  path="safety"
                  element={
                    <S>
                      <SafetyPage />
                    </S>
                  }
                />
                <Route
                  path="quality"
                  element={
                    <S>
                      <QualityPage />
                    </S>
                  }
                />
                <Route
                  path="equipment"
                  element={
                    <S>
                      <EquipmentPage />
                    </S>
                  }
                />
                <Route
                  path="timecards"
                  element={
                    <S>
                      <TimecardsPage />
                    </S>
                  }
                />
                <Route
                  path="bidding"
                  element={
                    <S>
                      <BiddingPage />
                    </S>
                  }
                />
              </Route>
            </Route>
            <Route path="*" element={<NotFound />} />
          </Routes>
        </Providers>
      </AuthProvider>
    </BrowserRouter>
  );
}
