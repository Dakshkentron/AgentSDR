/** Client-safe labels for a LinkedIn campaign's trigger time (California time). */
// Date and time formatted separately: the joiner between them (", " or " at ")
// differs across ICU versions, i.e. between server and browser.
const PT_DATE = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric", year: "numeric" });
const PT_TIME = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", minute: "2-digit" });

/** "Oct 17, 2026, 11:26 AM PT" */
export const formatPacific = (iso: string): string => {
  const d = new Date(iso);
  return `${PT_DATE.format(d)}, ${PT_TIME.format(d).replace(/\s/g, " ")} PT`;
};

export function campaignTriggerLabel(c: { status: "ACTIVE" | "PAUSED"; triggerAt: string; triggeredAt: string | null }): string {
  if (c.triggeredAt) return `Triggered at ${formatPacific(c.triggeredAt)}`;
  if (c.status !== "ACTIVE") return "Paused — will not trigger until resumed";
  return `Triggers at ${formatPacific(c.triggerAt)}`;
}
