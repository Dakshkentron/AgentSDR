"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { authClient, useListOrganizations, useSession } from "@/lib/auth/client";
import { slugify } from "@/lib/auth/slug";
import { AuthShell } from "@/components/auth/AuthShell";
import { ErrorCallout, Field, SecondaryButton, SubmitButton } from "@/components/auth/fields";

export default function OnboardingPage() {
  const { data: session, isPending } = useSession();
  const { data: orgs, isPending: orgsPending } = useListOrganizations();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [switching, setSwitching] = useState<string | null>(null);
  // Nobody is asked for an organization: the first one they belong to opens,
  // or one named after them is made. The form only shows if that failed.
  const [auto, setAuto] = useState(true);
  const started = useRef(false);

  useEffect(() => {
    if (!isPending && !session) window.location.href = "/sign-in?from=/onboarding";
  }, [isPending, session]);

  useEffect(() => {
    if (isPending || orgsPending || !session || started.current) return;
    started.current = true;
    void (async () => {
      if (orgs?.[0]) {
        if (!(await switchTo(orgs[0].id))) setAuto(false);
        return;
      }
      const orgName = session.user.name?.trim() || session.user.email.split("@")[0];
      // A short random suffix keeps the URL name unique without asking for one.
      const created = await authClient.organization.create({ name: orgName, slug: `${slugify(orgName) || "workspace"}-${crypto.randomUUID().slice(0, 6)}` });
      if (created.error || !created.data) {
        setError(created.error?.message || "Could not create your organization.");
        return setAuto(false);
      }
      if (!(await switchTo(created.data.id))) setAuto(false);
    })();
  }, [isPending, orgsPending, session, orgs]);

  function onName(value: string) {
    setName(value);
    if (!slugEdited) setSlug(slugify(value));
  }

  async function create(e: FormEvent) {
    e.preventDefault();
    setError("");
    const finalSlug = slugify(slug);
    if (!name.trim() || !finalSlug) return setError("Enter a name for your organization.");
    setLoading(true);
    const check = await authClient.organization.checkSlug({ slug: finalSlug });
    if (check.error || !check.data?.status) {
      setError("That URL name is already taken. Try another.");
      return setLoading(false);
    }
    const created = await authClient.organization.create({ name: name.trim(), slug: finalSlug });
    if (created.error || !created.data) {
      setError(created.error?.message || "Could not create the organization.");
      return setLoading(false);
    }
    const active = await authClient.organization.setActive({ organizationId: created.data.id });
    if (active.error) {
      setError(active.error.message || "Created, but could not switch into it. Reload and try again.");
      return setLoading(false);
    }
    window.location.assign("/analytics");
  }

  async function switchTo(id: string): Promise<boolean> {
    setError("");
    setSwitching(id);
    const { error: err } = await authClient.organization.setActive({ organizationId: id });
    if (err) {
      setError(err.message || "Could not switch organization.");
      setSwitching(null);
      return false;
    }
    window.location.assign("/analytics");
    return true;
  }

  const hasOrgs = !!orgs && orgs.length > 0;

  if (auto) return <AuthShell title="Setting up your workspace…" subtitle="This takes a second.">{null}</AuthShell>;

  return (
    <AuthShell
      title={hasOrgs ? "Choose an organization" : "Create your organization"}
      subtitle={hasOrgs ? "Pick one to continue, or create another." : "Your workspace for leads, outreach and conversations."}
    >
      <div className="flex flex-col gap-4">
        {hasOrgs && (
          <div className="flex flex-col gap-2">
            {orgs.map((o) => (
              <SecondaryButton key={o.id} onClick={() => switchTo(o.id)} loading={switching === o.id} disabled={!!switching}>
                {o.name}
              </SecondaryButton>
            ))}
            <div className="mt-2 text-xs uppercase tracking-widest text-slate-600">Or create a new one</div>
          </div>
        )}
        <form onSubmit={create} className="flex flex-col gap-4">
          <Field label="Organization name" type="text" autoComplete="organization" required value={name} onChange={(e) => onName(e.target.value)} />
          <Field
            label="URL name"
            type="text"
            autoComplete="off"
            required
            hint="Lowercase letters, numbers and dashes."
            value={slug}
            onChange={(e) => {
              setSlugEdited(true);
              setSlug(e.target.value);
            }}
          />
          {error && <ErrorCallout>{error}</ErrorCallout>}
          <SubmitButton loading={loading} loadingLabel="Creating..." disabled={!!switching}>
            Create organization
          </SubmitButton>
        </form>
      </div>
    </AuthShell>
  );
}
