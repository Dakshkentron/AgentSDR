import { NextResponse } from "next/server";
import { withLinkedinOrg } from "@/lib/linkedin/organizations.server";
import { syncLinkedinMessages } from "@/lib/linkedin/messages/syncFromUnipile";
import { isPlatformNotConnectedError } from "@/lib/platform/credentials";
import { serializeError } from "@/lib/linkedin/serializeError";

// POST /api/linkedin/messages/sync — pulls existing LinkedIn conversations
// from Unipile into the inbox (Messages → Sync messages). Safe to repeat.
export async function POST(req: Request) {
  return withLinkedinOrg(req, async () => {
    try {
      return NextResponse.json({ ok: true, ...(await syncLinkedinMessages()) });
    } catch (err) {
      if (isPlatformNotConnectedError(err)) {
        return NextResponse.json({ ok: false, error: err.message }, { status: 409 });
      }
      console.error(`[messages/sync] ${serializeError(err)}`);
      return NextResponse.json({ ok: false, error: serializeError(err) }, { status: 500 });
    }
  });
}
