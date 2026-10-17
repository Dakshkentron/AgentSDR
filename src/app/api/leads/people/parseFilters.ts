/** The People list's query-string filters, shared by the list route and the ids (select-all-matching) route. */
export function parsePeopleFilters(searchParams: URLSearchParams) {
  const campaignChannel = searchParams.get("campaignChannel");
  const crmCategory = searchParams.get("crmCategory");
  const crmWorkflowState = searchParams.get("crmWorkflowState");
  return {
    q: searchParams.get("q") ?? undefined,
    campaignChannel: campaignChannel === "email" || campaignChannel === "linkedin" || campaignChannel === "unassigned" ? campaignChannel : undefined,
    hasEmail: searchParams.get("hasEmail") === "true" ? true : undefined,
    hasLinkedin: searchParams.get("hasLinkedin") === "true" ? true : undefined,
    crmCategory: crmCategory === "customer" || crmCategory === "interested" || crmCategory === "not_interested" || crmCategory === "other" ? crmCategory : undefined,
    crmWorkflowState: crmWorkflowState === "unclassified" || crmWorkflowState === "classifying" || crmWorkflowState === "action_required" || crmWorkflowState === "waiting" || crmWorkflowState === "idle" || crmWorkflowState === "paused" || crmWorkflowState === "closed" || crmWorkflowState === "error" ? crmWorkflowState : undefined,
    crmSubcategoryId: searchParams.get("crmSubcategoryId") ?? undefined,
    crmAiChange: searchParams.get("crmAiChange") === "true" ? true : undefined,
  } as const;
}
