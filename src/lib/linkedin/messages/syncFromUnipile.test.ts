import { describe, expect, it } from "bun:test";
import { messageText } from "./syncFromUnipile";

describe("messageText", () => {
  it("keeps text, and labels messages that only carry attachments", () => {
    expect(messageText({ id: "1", text: "hi" })).toBe("hi");
    expect(messageText({ id: "2", text: "", attachments: [{ type: "img" }] })).toBe("📷 Photo");
    expect(messageText({ id: "3", text: null, attachments: [{ type: "file", file_name: "deck.pdf" }] })).toBe("📎 deck.pdf");
    expect(messageText({ id: "4", text: "  ", attachments: [] })).toBeNull();
  });
});
