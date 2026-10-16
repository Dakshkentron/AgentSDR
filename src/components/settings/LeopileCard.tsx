"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import * as Badge from "@/components/alignui/badge";
import * as Button from "@/components/alignui/button";
import * as Input from "@/components/alignui/input";
import { Frame, FramePanel } from "@/components/analytics/kit/Frame";
import { Callout, Field } from "@/components/settings/SettingsKit";

export type LeopileAccountRow = { id: string; name: string; publicIdentifier: string; status: string };

/**
 * Leopile: LinkedIn run by AgentSDR itself, in place of Unipile. Connecting
 * saves the Unipile integration pointing at this app (src/lib/leopile), so
 * campaigns and the inbox work unchanged; accounts are added from the
 * member's own LinkedIn session cookie.
 */
export function LeopileCard({ connected, accounts }: { connected: boolean; accounts: LeopileAccountRow[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [liAt, setLiAt] = useState("");
  const [jsessionid, setJsessionid] = useState("");

  async function post(body: Record<string, string>) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/leopile/connect", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Something went wrong");
      setLiAt("");
      setJsessionid("");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Frame>
      <FramePanel className="flex flex-col gap-4">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-label-md text-text-strong-950">Leopile</h3>
              <Badge.Root size="medium" variant="lighter" color={connected ? "green" : "gray"}>
                {connected ? "Connected" : "Not connected"}
              </Badge.Root>
            </div>
            <p className="mt-1 text-paragraph-sm text-text-sub-600">LinkedIn run by AgentSDR itself — no Unipile account. Sends invitations and messages from your own LinkedIn session.</p>
          </div>
          <Button.Root variant="neutral" mode="stroke" size="small" disabled={busy} onClick={() => post({ action: "connect" })} className="shrink-0">
            {connected ? "Reissue token" : "Connect Leopile"}
          </Button.Root>
        </div>

        {!connected && (
          <Callout tone="info">Connecting replaces the Unipile connection below, which WhatsApp also uses. Leopile does not do WhatsApp or LinkedIn search yet.</Callout>
        )}
        {error && <Callout tone="error">{error}</Callout>}

        {connected && (
          <>
            <ul className="flex flex-col gap-2">
              {accounts.map((a) => (
                <li key={a.id} className="flex items-center justify-between gap-3 text-paragraph-sm">
                  <span className="min-w-0 truncate">
                    {a.name} <span className="text-text-soft-400">/in/{a.publicIdentifier}</span>
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    <Badge.Root size="medium" variant="lighter" color={a.status === "OK" ? "green" : "red"}>
                      {a.status === "OK" ? "Connected" : "Cookies expired"}
                    </Badge.Root>
                    <Button.Root variant="neutral" mode="ghost" size="xsmall" disabled={busy} onClick={() => post({ action: "remove", id: a.id })}>
                      Remove
                    </Button.Root>
                  </span>
                </li>
              ))}
              {accounts.length === 0 && <li className="text-paragraph-sm text-text-sub-600">No LinkedIn accounts yet.</li>}
            </ul>

            <div className="flex flex-col gap-3 border-t border-stroke-soft-200 pt-4">
              <Field
                label="li_at cookie"
                htmlFor="leopile-li-at"
                description="Signed in to linkedin.com: browser dev tools → Application → Cookies → www.linkedin.com → li_at. Pasting an expired account's cookie reconnects it. Use an account you can afford to lose — LinkedIn forbids automation."
              >
                <Input.Root size="medium">
                  <Input.Wrapper>
                    <Input.Input id="leopile-li-at" type="password" value={liAt} onChange={(e) => setLiAt(e.target.value)} autoComplete="off" />
                  </Input.Wrapper>
                </Input.Root>
              </Field>
              <Field label="JSESSIONID" htmlFor="leopile-jsession" optional description="Same place. Left empty, Leopile makes one up, which LinkedIn accepts.">
                <Input.Root size="medium">
                  <Input.Wrapper>
                    <Input.Input id="leopile-jsession" value={jsessionid} onChange={(e) => setJsessionid(e.target.value)} autoComplete="off" />
                  </Input.Wrapper>
                </Input.Root>
              </Field>
              <Button.Root size="small" disabled={busy || !liAt.trim()} onClick={() => post({ action: "account", liAt, jsessionid })} className="self-start">
                Add LinkedIn account
              </Button.Root>
            </div>
          </>
        )}
      </FramePanel>
    </Frame>
  );
}
