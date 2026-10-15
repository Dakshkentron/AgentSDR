import "server-only";
import { unipileJson } from "./unipileApi";

export type MessageAttachment = {
  id: string;
  type: "img" | "video" | "audio" | "file" | "linkedin_post" | string;
  name: string | null;
  mimetype: string | null;
  /** A LinkedIn post's own address; files are served through /api/linkedin/messages/attachment. */
  url: string | null;
  unavailable: boolean;
};

/** The label lines messageText writes for attachments ("📷 Photo", "📎 deck.pdf", …). */
const ATTACHMENT_LINE = /^(📷 Photo|🎥 Video|🎤 Voice message|🔗 Shared a LinkedIn post|📎 .+)$/mu;

export function hasAttachmentLabel(text: string): boolean {
  return ATTACHMENT_LINE.test(text);
}

type UnipileAttachment = { id?: string; type?: string; file_name?: string; mimetype?: string; url?: string; unavailable?: boolean };

/** The attachments of one LinkedIn message, read from Unipile. */
export async function loadMessageAttachments(linkedinMessageId: string): Promise<MessageAttachment[]> {
  const message = await unipileJson<{ attachments?: UnipileAttachment[] }>(`/messages/${encodeURIComponent(linkedinMessageId)}`);
  return (message.attachments ?? []).flatMap((a) =>
    a.id
      ? [{
          id: a.id,
          type: a.type ?? "file",
          name: a.file_name ?? null,
          mimetype: a.mimetype ?? null,
          url: a.type === "linkedin_post" ? (a.url ?? null) : null,
          unavailable: a.unavailable === true,
        }]
      : [],
  );
}
