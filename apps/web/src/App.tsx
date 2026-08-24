import { lazy, Suspense, type ReactNode } from "react";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { AuthProvider, RequireAuth } from "./lib/auth";
import AppLayout from "./layouts/AppLayout";
import ProjectLayout from "./layouts/ProjectLayout";
import { Spinner } from "./ui";

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
const GovernancePage = lazy(() => import("./pages/governance/GovernancePage"));
const FinancePage = lazy(() => import("./pages/finance/FinancePage"));
const DisputesPage = lazy(() => import("./pages/disputes/DisputesPage"));
const ForensicsPage = lazy(() => import("./pages/forensics/ForensicsPage"));
const PaymentsPage = lazy(() => import("./pages/payments/PaymentsPage"));
const ContractsPage = lazy(() => import("./pages/contracts/ContractsPage"));
const ContractDetailPage = lazy(() => import("./pages/contracts/ContractDetailPage"));
const CompanyAssurancePage = lazy(() => import("./pages/assurance/CompanyAssurancePage"));
const AiPage = lazy(() => import("./pages/ai/AiPage"));

function S({ children }: { children: ReactNode }) {
  return <Suspense fallback={<Spinner />}>{children}</Suspense>;
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
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
              path="assurance"
              element={
                <S>
                  <CompanyAssurancePage />
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
            </Route>
          </Route>
          <Route
            path="*"
            element={
              <div className="flex h-screen items-center justify-center text-ink-400">
                Page not found
              </div>
            }
          />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
