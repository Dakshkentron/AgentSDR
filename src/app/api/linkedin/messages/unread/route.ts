import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq, sql } from "drizzle-orm";
import { withLinkedinOrg } from "@/lib/linkedin/organizations.server";
import { db } from "@/lib/db";
import { inOrg } from "@/lib/tenancy/scope";
import { messages } from "@/lib/linkedin/schema";

// POST /api/linkedin/messages/unread { connectionId } — Messages → Mark as unread.
// Flags the newest received message unseen (the newest message of any kind when
// they never wrote), so the conversation shows as unread until it is opened again.
export async function POST(req: NextRequest) {
  return withLinkedinOrg(req, async () => {
    const body = await req.json().catch(() => null);
    const connectionId = typeof body?.connectionId === "string" ? body.connectionId : null;
    if (!connectionId) return NextResponse.json({ ok: false, error: "connectionId required" }, { status: 400 });

    const [message] = await db
      .select({ id: messages.id })
      .from(messages)
      .where(and(inOrg(messages), eq(messages.connectionId, connectionId)))
      .orderBy(sql`${messages.type} = 'RECEIVED' DESC`, desc(messages.createdAt))
      .limit(1);
    if (!message) return NextResponse.json({ ok: false, error: "No messages in this conversation" }, { status: 404 });

    await db.update(messages).set({ seen: false }).where(and(inOrg(messages), eq(messages.id, message.id)));
    return NextResponse.json({ ok: true });
  });
}
