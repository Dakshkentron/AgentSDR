export type InboxSendConnection = {
  id: string;
  chatId: string | null;
  leadId: string | null;
  linkedinUrl: string | null;
  linkedinAccountId: string | null;
};

export type InboxCrmConversation = {
  id: string;
  recordId: string;
  personId: string;
};

export type InboxSentMessage = {
  id: string;
  type: "CUSTOM_SENT";
  text: string;
  seen: true;
  createdAt: string;
};

export class InboxSendError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "InboxSendError";
  }
}

export type InboxSendDependencies = {
  findConnection(connectionId: string): Promise<InboxSendConnection | null>;
  findNativePersonId(connection: InboxSendConnection): Promise<string | null>;
  findCrmConversation(connection: InboxSendConnection): Promise<InboxCrmConversation | null>;
  isPersonDoNotContact(personId: string): Promise<boolean>;
  sendThroughCrm(input: {
    conversation: InboxCrmConversation;
    text: string;
    idempotencyKey: string;
  }): Promise<InboxSentMessage>;
  sendThroughLinkedin(chatId: string, text: string, connection: InboxSendConnection): Promise<string | null>;
  saveNativeMessage(input: {
    connection: InboxSendConnection;
    text: string;
    providerMessageId: string | null;
  }): Promise<InboxSentMessage>;
};

/**
 * Manual sends from the LinkedIn inbox are always allowed to choose a delivery
 * path. Existing CRM conversations use CRM's durable send/audit pipeline;
 * every other connection uses the native LinkedIn path.
 */
export async function sendFromLinkedinInbox(
  input: { connectionId?: unknown; text?: unknown; idempotencyKey: string },
  dependencies: InboxSendDependencies,
): Promise<InboxSentMessage> {
  const connectionId = typeof input.connectionId === "string" ? input.connectionId.trim() : "";
  const text = typeof input.text === "string" ? input.text.trim() : "";
  if (!connectionId || !text) {
    throw new InboxSendError("connectionId and text required", 400);
  }

  const connection = await dependencies.findConnection(connectionId);
  if (!connection) throw new InboxSendError("Connection not found", 404);
  if (!connection.chatId) {
    throw new InboxSendError("No chatId for this connection — cannot send message", 400);
  }

  const [nativePersonId, crmConversation] = await Promise.all([
    dependencies.findNativePersonId(connection),
    dependencies.findCrmConversation(connection),
  ]);
  const personIds = new Set([nativePersonId, crmConversation?.personId].filter((id): id is string => Boolean(id)));
  for (const personId of personIds) {
    if (await dependencies.isPersonDoNotContact(personId)) {
      throw new InboxSendError("This Person is marked Do Not Contact", 409);
    }
  }

  if (crmConversation) {
    return dependencies.sendThroughCrm({
      conversation: crmConversation,
      text,
      idempotencyKey: input.idempotencyKey,
    });
  }

  const providerMessageId = await dependencies.sendThroughLinkedin(connection.chatId, text, connection);
  return dependencies.saveNativeMessage({ connection, text, providerMessageId });
}
