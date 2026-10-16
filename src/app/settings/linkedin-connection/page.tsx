import { LeopileSection } from "@/components/settings/LeopileSection";
import { ConnectionSettingsPage } from "@/components/settings/ChannelSettingsPages";

export const metadata = { title: "LinkedIn connection" };
export const dynamic = "force-dynamic";

export default function Page() {
  return <ConnectionSettingsPage platforms={[{ platform: "unipile", note: "The same Unipile connection also powers WhatsApp; changing it here changes it there too." }]} title="LinkedIn connection" description="Unipile or Leopile connects your LinkedIn accounts for invitations, messages and inbox sync."><LeopileSection /></ConnectionSettingsPage>;
}
