import { LeopileCard } from "@/components/settings/LeopileCard";
import { requirePageOrgContext } from "@/lib/auth/context";
import { listAccounts } from "@/lib/leopile/accounts";
import { getPlatformCredentials } from "@/lib/platform/credentials";
import { runInOrganization } from "@/lib/tenancy/scope";

/** Settings → LinkedIn → Connection: Leopile's card, "connected" when the Unipile integration points at this app. */
export async function LeopileSection() {
  const ctx = await requirePageOrgContext();
  const { connected, accounts } = await runInOrganization(ctx.organizationId, async () => ({
    connected: ((await getPlatformCredentials("unipile"))?.baseUrl ?? "").endsWith("/api/leopile"),
    accounts: await listAccounts(),
  }));
  return <LeopileCard connected={connected} accounts={accounts.map(({ id, name, publicIdentifier, status }) => ({ id, name, publicIdentifier, status }))} />;
}
