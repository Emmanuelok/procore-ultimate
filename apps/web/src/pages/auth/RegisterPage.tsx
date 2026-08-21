import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../../lib/auth";
import { ApiClientError } from "../../lib/api";
import { Button, ErrorAlert, Field, Input } from "../../ui";

export default function RegisterPage() {
  const { register } = useAuth();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await register({
        name: name.trim(),
        email: email.trim(),
        password,
        companyName: companyName.trim(),
      });
      navigate("/");
    } catch (err) {
      setError(
        err instanceof ApiClientError ? err.message : "Unable to register. Please try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-ink-50 px-4 py-8">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-brand-600 text-lg font-bold text-white shadow-sm">
            C
          </div>
          <h1 className="mt-3 text-xl font-semibold text-ink-900">ConstructOS</h1>
          <p className="text-xs uppercase tracking-widest text-ink-400">Delivery + Assurance</p>
        </div>
        <div className="rounded-xl bg-white p-6 shadow-sm ring-1 ring-ink-100">
          <h2 className="mb-1 text-base font-semibold text-ink-900">Create your account</h2>
          <p className="mb-4 text-xs text-ink-500">
            Sets up a new company workspace with you as owner.
          </p>
          <ErrorAlert message={error} />
          <form onSubmit={onSubmit} className="space-y-4">
            <Field label="Full name">
              <Input
                autoComplete="name"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Jane Rivera"
              />
            </Field>
            <Field label="Work email">
              <Input
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@company.com"
              />
            </Field>
            <Field label="Password" hint="At least 8 characters.">
              <Input
                type="password"
                autoComplete="new-password"
                required
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
              />
            </Field>
            <Field label="Company name">
              <Input
                required
                value={companyName}
                onChange={(e) => setCompanyName(e.target.value)}
                placeholder="Rivera Construction Ltd"
              />
            </Field>
            <Button type="submit" className="w-full" disabled={busy}>
              {busy ? "Creating account…" : "Create account"}
            </Button>
          </form>
        </div>
        <p className="mt-4 text-center text-sm text-ink-500">
          Already have an account?{" "}
          <Link to="/login" className="font-medium text-brand-700 hover:text-brand-800">
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
