import { ConnectionSettingsPage } from "@/components/settings/ChannelSettingsPages";

export const metadata = { title: "LinkedIn connection" };
export const dynamic = "force-dynamic";

export default function Page() {
  return <ConnectionSettingsPage platforms={[
        { platform: "unipile", note: "The same Unipile connection also powers WhatsApp; changing it here changes it there too." },
        { platform: "leopile", note: "Leopile is a faster, Unipile-compatible alternative. Connect one LinkedIn provider at a time." },
      ]} title="LinkedIn connection" description="Unipile or Leopile connects your LinkedIn accounts for invitations, messages, search and inbox sync." />;
}
