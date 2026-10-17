import type * as Badge from "@/components/alignui/badge";

/**
 * What a LinkedIn campaign's lead-status counts add up to. Every figure on
 * the list and detail pages comes from here, so the two can't disagree.
 *
 * A lead's status is where it is now, not a history, so the cumulative
 * stages are sums of every status at or past them:
 * - accepted: connected, messaged, any follow-up, completed or replied
 * - invited: accepted plus those still waiting on the invitation
 *
 * Reply rate is replied / accepted — the same definition as the LinkedIn
 * view on Analytics — because a lead can only reply once connected.
 */
export type CampaignFunnel = {
  total: number;
  queued: number;
  awaiting: number;
  inSequence: number;
  completed: number;
  replied: number;
  failed: number;
  cancelled: number;
  invited: number;
  accepted: number;
  acceptanceRate: number | null;
  replyRate: number | null;
  /** 0–1 share of leads that have left the queue; null with no leads. */
  progress: number | null;
};

const n = (s: Record<string, number>, key: string) => s[key] ?? 0;

export function campaignFunnel(s: Record<string, number>, totalLeads?: number): CampaignFunnel {
  const queued = n(s, "PENDING");
  const awaiting = n(s, "REQUEST_SENT");
  const inSequence =
    n(s, "CONNECTED") + n(s, "ACCEPT_MESSAGE_SENT") + n(s, "FOLLOW_UP_1_SENT") + n(s, "FOLLOW_UP_2_SENT") + n(s, "FOLLOW_UP_3_SENT");
  const completed = n(s, "COMPLETED");
  const replied = n(s, "REPLIED");
  const failed = n(s, "FAILED");
  const cancelled = n(s, "CANCELLED");
  const accepted = inSequence + completed + replied;
  const invited = awaiting + accepted;
  const total = totalLeads ?? Object.values(s).reduce((sum, v) => sum + v, 0);
  return {
    total,
    queued,
    awaiting,
    inSequence,
    completed,
    replied,
    failed,
    cancelled,
    invited,
    accepted,
    acceptanceRate: invited > 0 ? accepted / invited : null,
    replyRate: accepted > 0 ? replied / accepted : null,
    progress: total > 0 ? Math.min((total - queued) / total, 1) : null,
  };
}

type BadgeColor = React.ComponentProps<typeof Badge.Root>["color"];

/** Every lead status, in sequence order, with its label and badge colour. */
export const LEAD_STATUS: Record<string, { label: string; color: BadgeColor }> = {
  PENDING: { label: "Pending", color: "gray" },
  REQUEST_SENT: { label: "Invited", color: "sky" },
  CONNECTED: { label: "Connected", color: "teal" },
  ACCEPT_MESSAGE_SENT: { label: "Accepted", color: "teal" },
  FOLLOW_UP_1_SENT: { label: "Follow-up 1", color: "blue" },
  FOLLOW_UP_2_SENT: { label: "Follow-up 2", color: "blue" },
  FOLLOW_UP_3_SENT: { label: "Follow-up 3", color: "blue" },
  COMPLETED: { label: "Completed", color: "purple" },
  REPLIED: { label: "Replied", color: "green" },
  FAILED: { label: "Failed", color: "red" },
  // Only sendInvitations sets CANCELLED on a lead: the person is already a 1st-degree
  // connection of the sender, so nothing (invitation or message) is sent.
  CANCELLED: { label: "Already connected", color: "teal" },
};

export const CAMPAIGN_STATUS: Record<"ACTIVE" | "PAUSED", { label: string; color: BadgeColor }> = {
  ACTIVE: { label: "Active", color: "green" },
  PAUSED: { label: "Paused", color: "orange" },
};
