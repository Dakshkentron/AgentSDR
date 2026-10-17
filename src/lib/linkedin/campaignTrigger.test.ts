import assert from "node:assert/strict";
import { test } from "node:test";
import { campaignTriggerLabel, formatPacific } from "./campaignTrigger";

test("formats in California time", () => {
  assert.equal(formatPacific("2026-10-17T18:26:00.000Z"), "Oct 17, 2026, 11:26 AM PT");
});

test("trigger label by state", () => {
  const triggerAt = "2026-10-17T18:56:00.000Z";
  assert.equal(campaignTriggerLabel({ status: "ACTIVE", triggerAt, triggeredAt: null }), "Triggers at Oct 17, 2026, 11:56 AM PT");
  assert.equal(campaignTriggerLabel({ status: "PAUSED", triggerAt, triggeredAt: null }), "Paused — will not trigger until resumed");
  assert.equal(campaignTriggerLabel({ status: "PAUSED", triggerAt, triggeredAt: "2026-10-17T19:00:00.000Z" }), "Triggered at Oct 17, 2026, 12:00 PM PT");
});
