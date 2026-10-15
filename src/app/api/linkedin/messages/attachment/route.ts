import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { withLinkedinOrg } from "@/lib/linkedin/organizations.server";
import { db } from "@/lib/db";
import { inOrg } from "@/lib/tenancy/scope";
import { messages } from "@/lib/linkedin/schema";
import { unipileGet } from "@/lib/linkedin/messages/unipileApi";
import { serializeError } from "@/lib/linkedin/serializeError";

// GET /api/linkedin/messages/attachment?message=<Message.id>&attachment=<Unipile attachment id>[&download=1]
// Streams a photo, video, voice note or file from Unipile, which needs the
// workspace API key. The message must belong to this organization.
export async function GET(req: NextRequest) {
  return withLinkedinOrg(req, async () => {
    const messageId = req.nextUrl.searchParams.get("message");
    const attachmentId = req.nextUrl.searchParams.get("attachment");
    if (!messageId || !attachmentId) return NextResponse.json({ error: "message and attachment are required" }, { status: 400 });

    const [message] = await db
      .select({ linkedinMessageId: messages.linkedinMessageId })
      .from(messages)
      .where(and(inOrg(messages), eq(messages.id, messageId)))
      .limit(1);
    if (!message?.linkedinMessageId) return NextResponse.json({ error: "Message not found" }, { status: 404 });

    try {
      const upstream = await unipileGet(
        `/messages/${encodeURIComponent(message.linkedinMessageId)}/attachments/${encodeURIComponent(attachmentId)}`,
        { accept: "*/*" },
      );
      const name = req.nextUrl.searchParams.get("name");
      const headers = new Headers({
        "Content-Type": upstream.headers.get("content-type") ?? "application/octet-stream",
        "Cache-Control": "private, max-age=3600",
        // Files come from whoever messaged you: never let one run as a page on this origin.
        "Content-Security-Policy": "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'",
        "X-Content-Type-Options": "nosniff",
      });
      if (req.nextUrl.searchParams.get("download") === "1") {
        headers.set("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(name || "attachment")}`);
      }
      return new Response(upstream.body, { headers });
    } catch (err) {
      return NextResponse.json({ error: serializeError(err) }, { status: 502 });
    }
  });
}
