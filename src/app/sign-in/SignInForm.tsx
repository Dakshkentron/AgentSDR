"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { authClient } from "@/lib/auth/client";
import { AuthShell } from "@/components/auth/AuthShell";
import { ErrorCallout, Field, InfoCallout, SubmitButton, linkClass, quietLinkClass } from "@/components/auth/fields";
import { GoogleButton, OrDivider } from "@/components/auth/GoogleButton";

const ACCESS_REQUEST_TO = "pulkit@kandid.ai";

/** A mailto asking for an account on AgentSDR Managed, carrying the email typed into the form when there is one. */
function accessRequestHref(email: string) {
  const body = [
    "Hi Pulkit,",
    "",
    "I'd like to use AgentSDR Managed rather than self-host it. Could you send me an invite?",
    "",
    `Work email: ${email.trim()}`,
  ].join("\n");
  const subject = "I need access to AgentSDR Managed";
  return `mailto:${ACCESS_REQUEST_TO}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

export function SignInForm({
  googleEnabled,
  from,
  signupAvailable = true,
  created = false,
  initialEmail = "",
}: {
  googleEnabled: boolean;
  from: string | null;
  /** False on an invite-only instance: accounts come from invitations, so "Create one" is not offered. */
  signupAvailable?: boolean;
  /** Just came from sign-up: the account exists, so say so. */
  created?: boolean;
  initialEmail?: string;
}) {
  const target = from || "/analytics";
  const [email, setEmail] = useState(initialEmail);
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    const { error: err } = await authClient.signIn.email({ email, password, callbackURL: target });
    if (!err) {
      window.location.href = target;
      return;
    }
    if (err.code === "INVALID_EMAIL_OR_PASSWORD") setError("Incorrect email or password.");
    else setError(err.message || "Something went wrong. Please try again.");
    setLoading(false);
  }

  const q = from ? `?from=${encodeURIComponent(from)}` : "";

  return (
    <AuthShell
      title="Sign in to AgentSDR"
      footer={
        signupAvailable ? (
          <>
            Don&apos;t have an account?{" "}
            <Link href={`/sign-up${q}`} className={linkClass}>
              Create one
            </Link>
          </>
        ) : (
          <>
            Need access?{" "}
            <a href={accessRequestHref(email)} className={linkClass}>
              Ask your admin for an invite
            </a>
          </>
        )
      }
    >
      {created && (
        <div className="mb-5">
          <InfoCallout>Your account is ready. Sign in with the password you just chose.</InfoCallout>
        </div>
      )}
      <form onSubmit={submit} className="flex flex-col gap-5">
        <Field
          label="Work email"
          type="email"
          autoComplete="email"
          placeholder="name@company.com"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <Field
          label="Password"
          labelAside={
            <Link href="/forgot-password" className={quietLinkClass}>
              Forgot password?
            </Link>
          }
          type="password"
          autoComplete="current-password"
          placeholder="Enter your password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {error && <ErrorCallout>{error}</ErrorCallout>}
        <div className="pt-1">
          <SubmitButton loading={loading} loadingLabel="Signing in...">
            Sign in
          </SubmitButton>
        </div>
      </form>
      {googleEnabled && (
        <>
          <OrDivider label="Or continue with" />
          <GoogleButton callbackURL={target} onError={setError} label="Google" />
        </>
      )}
    </AuthShell>
  );
}
