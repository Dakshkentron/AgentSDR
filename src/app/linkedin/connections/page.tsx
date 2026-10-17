import { linkedinProfileUrl } from "@/lib/leads/identity";
import { count, desc, eq } from "drizzle-orm";
import { requirePageOrgContext } from "@/lib/auth/context";
import { inOrg, runInOrganization } from "@/lib/tenancy/scope";
import { db } from "@/lib/db";
import { campaigns, connections as connectionsTable, leads, linkedInAccounts } from "@/lib/linkedin/schema";
import { RiUserAddLine } from "@remixicon/react";
import * as Badge from "@/components/alignui/badge";
import * as Table from "@/components/alignui/table";
import { Frame, FrameHeader, FramePanel } from "@/components/analytics/kit/Frame";
import { ContactAvatar } from "@/components/crm/ContactAvatar";
import { EmptyState } from "@/components/page/EmptyState";
import { PageHeader } from "@/components/page/PageHeader";
import { LinkedInAccountTag } from "@/components/linkedin/LinkedInAccountTag";
import { ListPagination } from "@/components/linkedin/ListPagination";
import { clampPage, pageSlice, parsePageParam } from "@/lib/linkedin/pagination";

export const dynamic = "force-dynamic";

type Props = {
  searchParams: Promise<{ page?: string }>;
};

function timeAgo(date: Date): string {
  const diff = Math.floor((Date.now() - date.getTime()) / 1000);
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

const initialsOf = (name: string) =>
  name.split(" ").filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? "").join("") || "?";

export default async function ConnectionsPage({ searchParams }: Props) {
  const ctx = await requirePageOrgContext();
  return runInOrganization(ctx.organizationId, async () => {
    const { page: pageParam } = await searchParams;
    const [{ totalCount }] = await db.select({ totalCount: count() }).from(connectionsTable).where(inOrg(connectionsTable));
    const page = clampPage(parsePageParam(pageParam), totalCount);
    const { skip, take } = pageSlice(page);

    // The two `include`s become leftJoins (both FKs are nullable). Lead's own
    // nested `campaign` include is a third leftJoin off Lead. The rows are
    // reshaped back into `lead` / `lead.campaign` / `linkedInAccount` below.
    const connectionRows = await db
      .select({
        connection: connectionsTable,
        leadId: leads.id,
        leadStatus: leads.status,
        campaignId: campaigns.id,
        campaignName: campaigns.name,
        accountId: linkedInAccounts.id,
        accountUsername: linkedInAccounts.username,
        accountName: linkedInAccounts.name,
        accountProfilePictureUrl: linkedInAccounts.profilePictureUrl,
      })
      .from(connectionsTable)
      .leftJoin(leads, eq(connectionsTable.leadId, leads.id))
      .leftJoin(campaigns, eq(leads.campaignId, campaigns.id))
      .leftJoin(linkedInAccounts, eq(connectionsTable.linkedinAccountId, linkedInAccounts.id))
      .where(inOrg(connectionsTable))
      .orderBy(desc(connectionsTable.connectedAt))
      .limit(take)
      .offset(skip);

    const connections = connectionRows.map((r) => ({
      ...r.connection,
      lead: r.leadId
        ? {
            id: r.leadId,
            status: r.leadStatus!,
            campaign: r.campaignId ? { name: r.campaignName! } : null,
          }
        : null,
      linkedInAccount: r.accountId
        ? {
            username: r.accountUsername!,
            name: r.accountName,
            profilePictureUrl: r.accountProfilePictureUrl,
          }
        : null,
    }));

    return (
      <div className="mx-auto w-full max-w-[1440px]">
        <PageHeader
          title="Connections"
          description={
            totalCount === 0
              ? "People who accept your LinkedIn invitations"
              : `${totalCount.toLocaleString("en-US")} ${totalCount === 1 ? "person has" : "people have"} accepted your invitations, newest first`
          }
        />

        <Frame className="mt-5">
          <FrameHeader title="Accepted invitations" description="Each connection is matched to its lead, campaign and sending account" />
          {totalCount === 0 ? (
            <FramePanel>
              <EmptyState icon={RiUserAddLine} title="No connections yet" description="Connections appear here when leads accept your invitations." />
            </FramePanel>
          ) : (
            <>
              <FramePanel className="overflow-x-auto p-2 sm:p-2">
                <Table.Root className="min-w-[760px]">
                  <Table.Header>
                    <Table.Row>
                      <Table.Head scope="col" className="px-4">Connection</Table.Head>
                      <Table.Head scope="col" className="w-56 px-4">Campaign</Table.Head>
                      <Table.Head scope="col" className="w-48 px-4">Account</Table.Head>
                      <Table.Head scope="col" className="w-32 px-4">Connected</Table.Head>
                    </Table.Row>
                  </Table.Header>
                  <Table.Body spacing={4}>
                    {connections.map((conn) => {
                      const displayName = conn.name ?? conn.linkedinUrl ?? "Unknown";
                      return (
                        <Table.Row key={conn.id}>
                          <Table.Cell className="h-16 px-4">
                            <div className="flex min-w-0 items-center gap-3">
                              <ContactAvatar
                                src={conn.profilePictureUrl}
                                fallback={initialsOf(displayName)}
                                className="size-9 bg-bg-weak-50 text-label-xs text-text-sub-600 ring-1 ring-inset ring-stroke-soft-200"
                              />
                              <div className="min-w-0">
                                {linkedinProfileUrl(conn.linkedinUrl, conn.providerId) ? (
                                  <a
                                    href={linkedinProfileUrl(conn.linkedinUrl, conn.providerId) ?? undefined}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    title={displayName}
                                    className="block truncate rounded text-label-sm text-text-strong-950 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-primary-base"
                                  >
                                    {displayName}
                                  </a>
                                ) : (
                                  <p className="truncate text-label-sm text-text-strong-950" title={displayName}>{displayName}</p>
                                )}
                                {conn.headline && (
                                  <p className="mt-0.5 max-w-md truncate text-paragraph-xs text-text-sub-600" title={conn.headline}>{conn.headline}</p>
                                )}
                              </div>
                            </div>
                          </Table.Cell>

                          <Table.Cell className="px-4">
                            {conn.lead ? (
                              <div className="flex min-w-0 flex-col items-start gap-1">
                                <Badge.Root size="small" variant="lighter" color="green">
                                  <Badge.Dot />
                                  Lead
                                </Badge.Root>
                                {conn.lead.campaign?.name && (
                                  <p className="max-w-52 truncate text-paragraph-xs text-text-sub-600" title={conn.lead.campaign.name}>
                                    {conn.lead.campaign.name}
                                  </p>
                                )}
                              </div>
                            ) : (
                              <span className="text-paragraph-sm text-text-soft-400">Not from a campaign</span>
                            )}
                          </Table.Cell>

                          <Table.Cell className="px-4">
                            {conn.linkedInAccount ? (
                              <LinkedInAccountTag account={conn.linkedInAccount} size="sm" />
                            ) : (
                              <span className="text-paragraph-sm text-text-soft-400">—</span>
                            )}
                          </Table.Cell>

                          <Table.Cell className="whitespace-nowrap px-4 text-paragraph-sm text-text-sub-600">
                            {conn.connectedAt ? (
                              <span title={conn.connectedAt.toISOString()}>{timeAgo(conn.connectedAt)}</span>
                            ) : (
                              "—"
                            )}
                          </Table.Cell>
                        </Table.Row>
                      );
                    })}
                  </Table.Body>
                </Table.Root>
              </FramePanel>
              <ListPagination basePath="/linkedin/connections" page={page} totalCount={totalCount} />
            </>
          )}
        </Frame>
      </div>
    );
  });
}
