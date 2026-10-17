import { Suspense } from "react";

import { SettingsPage } from "@/components/settings/SettingsPage";
import { RequiresPlatform } from "@/components/settings/RequiresPlatform";
import { AccountsClient } from "@/components/linkedin/AccountsClient";
import { ConnectAccountButton, HostedAuthReturn } from "@/components/linkedin/HostedAuth";
import { requirePageOrgContext } from "@/lib/auth/context";
import { runInOrganization } from "@/lib/tenancy/scope";
import { loadConnectedAccounts } from "@/lib/linkedin/connectedAccounts.server";
import { channelRules } from "@/lib/channels/rules.server";

export const dynamic = "force-dynamic";

export const metadata = { title: "LinkedIn accounts" };

async function loadData() {
  const ctx = await requirePageOrgContext();
  const [{ accountRows, sentTodayMap, pendingLeadsMap }, rules] = await runInOrganization(ctx.organizationId, () =>
    Promise.all([loadConnectedAccounts(), channelRules("linkedin")]),
  );
  return { accountRows, sentTodayMap, pendingLeadsMap, rules };
}

export default async function LinkedInAccountsPage() {
  const { accountRows, sentTodayMap, pendingLeadsMap, rules } = await loadData();

  return (
    <SettingsPage
      title="LinkedIn accounts"
      description="The LinkedIn profiles campaigns send from, connected through Unipile."
      actions={
        accountRows.length === 0 && (
          <RequiresPlatform platform="unipile" fallback={null}>
            <ConnectAccountButton />
          </RequiresPlatform>
        )
      }
    >
      <RequiresPlatform platform="unipile">
        <Suspense fallback={null}>
          <HostedAuthReturn />
        </Suspense>

        <AccountsClient
          accounts={accountRows}
          sentTodayMap={sentTodayMap}
          pendingLeadsMap={pendingLeadsMap}
          inviteLimits={{ premium: rules.invitesPerDayPremium, free: rules.invitesPerDayFree }}
        />
      </RequiresPlatform>
    </SettingsPage>
  );
}
