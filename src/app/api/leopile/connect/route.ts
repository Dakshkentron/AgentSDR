import { NextRequest, NextResponse } from "next/server";
import { authContextErrorResponse, requirePermission, withOrgContext } from "@/lib/auth/context";
import { syncAllAccounts } from "@/functions/syncAllAccounts";
import { connectAccount, issueAccessToken, removeAccount } from "@/lib/leopile/accounts";
import { leopileDsn } from "@/lib/leopile/core";
import { savePlatformIntegration } from "@/lib/platform/credentials";

// Behind the session cookie. Settings → LinkedIn → Connection → Leopile.
//   { action: "connect" }                          → issue a token and save the Unipile integration pointing at this app
//   { action: "account", liAt, jsessionid? }       → connect a LinkedIn account from its cookies
//   { action: "remove", id }                       → drop a connected account (its LinkedIn row stays until removed there)

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as { action?: string; liAt?: string; jsessionid?: string; id?: string } | null;
  try {
    return await withOrgContext(req, async (ctx) => {
      requirePermission(ctx, { integrations: ["manage"] });
      if (body?.action === "connect") {
        const apiKey = await issueAccessToken();
        await savePlatformIntegration("unipile", { baseUrl: leopileDsn(req.nextUrl.origin), apiKey });
        return NextResponse.json({ ok: true });
      }
      if (body?.action === "account") {
        await connectAccount(String(body.liAt ?? ""), body.jsessionid);
        await syncAllAccounts();
        return NextResponse.json({ ok: true });
      }
      if (body?.action === "remove" && body.id) {
        await removeAccount(body.id);
        return NextResponse.json({ ok: true });
      }
      return NextResponse.json({ error: "Unknown action" }, { status: 400 });
    });
  } catch (error) {
    const denied = authContextErrorResponse(error);
    if (denied) return denied;
    return NextResponse.json({ error: error instanceof Error ? error.message : "Leopile failed" }, { status: 400 });
  }
}
