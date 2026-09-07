/**
 * Developer sandbox tenants (#123).
 *
 * GET/POST/DELETE /integrations/sandbox were implemented and ledgered, and the
 * flag was consumed in three places — the ERP export caveat, the webhook
 * envelope and the benchmark contribution refusal — but nothing in the app
 * could see it or set it. A capability whose only door is curl is not
 * delivered, and this one in particular is a claim the platform makes ABOUT a
 * tenant's data: whoever is looking at an export that says "not a record of
 * real trade" should be able to find out why here.
 *
 * The card states the effects verbatim from the server rather than repeating
 * them in the client, so the two can never drift.
 */
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "../../lib/api";
import { Badge, Button, Card, CardBody, ErrorAlert, Field, Input, Spinner } from "../../ui";
import { Caveat, errorMessage } from "./integrationsShared";

interface SandboxResponse {
  sandbox: boolean;
  record: {
    companyId: string;
    purpose: string | null;
    enabledBy: string;
    createdAt: string;
  } | null;
  effects: string[];
  note: string;
}

export default function SandboxCard({ isAdmin }: { isAdmin: boolean }) {
  const [data, setData] = useState<SandboxResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [purpose, setPurpose] = useState("");

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await api.get<SandboxResponse>("/api/v1/integrations/sandbox"));
    } catch (err) {
      setData(null);
      setError(errorMessage(err, "Could not read the sandbox flag"));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function enable() {
    setBusy(true);
    setError(null);
    try {
      await api.post<unknown>("/api/v1/integrations/sandbox", {
        ...(purpose.trim() ? { purpose: purpose.trim() } : {}),
      });
      toast.success("Tenant marked as a developer sandbox");
      setPurpose("");
      await load();
    } catch (err) {
      setError(errorMessage(err, "Could not mark this tenant as a sandbox"));
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    if (
      !window.confirm(
        "Clear the sandbox flag?\n\nExports will stop carrying the SANDBOX caveat, webhook " +
          "envelopes will stop declaring sandbox:true, and this tenant's figures will be allowed " +
          "into the cross-tenant benchmark pool. Both directions are ledgered.",
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.del<unknown>("/api/v1/integrations/sandbox");
      toast.success("Sandbox flag cleared");
      await load();
    } catch (err) {
      setError(errorMessage(err, "Could not clear the sandbox flag"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="mb-4">
      <CardBody className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold text-ink-900">Developer sandbox</h2>
            {data === null ? null : data.sandbox ? (
              <Badge tone="amber">Sandbox tenant</Badge>
            ) : (
              <Badge tone="green">Production tenant</Badge>
            )}
          </div>
          <Button variant="ghost" size="sm" onClick={() => void load()} disabled={busy}>
            Refresh
          </Button>
        </div>

        <ErrorAlert message={error} />

        {data === null && !error ? (
          <Spinner label="Reading the sandbox flag…" />
        ) : data === null ? null : (
          <>
            <p className="text-xs text-ink-500">{data.note}</p>
            <ul className="list-inside list-disc text-xs text-ink-600">
              {data.effects.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>

            {data.sandbox ? (
              <>
                <Caveat tone="amber">
                  This tenant is a sandbox
                  {data.record?.purpose ? <> — {data.record.purpose}</> : null}. Nothing it exports
                  or emits should be read as a record of real trade.
                </Caveat>
                <div className="flex items-center gap-2">
                  <Button variant="danger" onClick={() => void disable()} disabled={!isAdmin || busy}>
                    {busy ? "Working…" : "Clear the sandbox flag"}
                  </Button>
                  {!isAdmin ? (
                    <span className="text-xs text-ink-400">
                      Owner or admin only — the API refuses this for other roles.
                    </span>
                  ) : null}
                </div>
              </>
            ) : (
              <div className="flex flex-wrap items-end gap-2">
                <Field label="Purpose (optional)" hint="Recorded on the flag and in the ledger">
                  <Input
                    value={purpose}
                    onChange={(e) => setPurpose(e.target.value)}
                    maxLength={500}
                    placeholder="e.g. partner integration testing"
                    className="w-72"
                  />
                </Field>
                <Button
                  variant="secondary"
                  className="mb-5"
                  onClick={() => void enable()}
                  disabled={!isAdmin || busy}
                >
                  {busy ? "Working…" : "Mark this tenant as a sandbox"}
                </Button>
                {!isAdmin ? (
                  <span className="mb-6 text-xs text-ink-400">
                    Owner or admin only — the API refuses this for other roles.
                  </span>
                ) : null}
              </div>
            )}
          </>
        )}
      </CardBody>
    </Card>
  );
}
