import {
  RiBookOpenLine,
  RiBuilding2Line,
  RiCpuLine,
  RiEqualizerLine,
  RiGroupLine,
  RiTeamLine,
  RiLayoutColumnLine,
  RiLinkedinBoxLine,
  RiPlugLine,
  RiPaletteLine,
  RiPriceTag3Line,
  RiQuillPenLine,
  type RemixiconComponentType,
} from "@remixicon/react";

export type SettingsTab = { href: string; label: string; icon: RemixiconComponentType };

/** A row in the settings rail. With `tabs`, it opens the first and stays active on any of them. */
export type SettingsNavItem = SettingsTab & { tabs?: SettingsTab[] };

/** Every page a row covers: itself, or its tabs. */
export function itemPages(item: SettingsNavItem): SettingsTab[] {
  return item.tabs ?? [item];
}

/**
 * Every settings screen in the app. Each is its own route under /settings;
 * the pages they replaced redirect here (next.config.ts).
 */
export const SETTINGS_NAV: { label: string; items: SettingsNavItem[] }[] = [
  {
    label: "Organization",
    items: [
      { href: "/settings/organization", label: "General", icon: RiBuilding2Line },
      { href: "/settings/members", label: "Members", icon: RiGroupLine },
      { href: "/settings/teams", label: "Teams", icon: RiTeamLine },
    ],
  },
  // Each channel is one row here; its pages — the connected accounts, the
  // integration it runs on, its sending rules (src/lib/channels/rules.ts) —
  // are tabs across the top of the section (SettingsShell).
  //
  // ponytail: Email and WhatsApp rows are hidden for now, matching the main
  // nav and Analytics (same decision as d66f055) — their routes still exist
  // and work, just not linked from here. Add their items back to re-enable.
  {
    label: "Channels",
    items: [
      {
        href: "/settings/linkedin-accounts",
        label: "LinkedIn",
        icon: RiLinkedinBoxLine,
        tabs: [
          { href: "/settings/linkedin-accounts", label: "Accounts", icon: RiLinkedinBoxLine },
          { href: "/settings/linkedin-connection", label: "Connection", icon: RiPlugLine },
          { href: "/settings/linkedin-rules", label: "Sending rules", icon: RiEqualizerLine },
        ],
      },
    ],
  },
  {
    label: "AI",
    items: [
      { href: "/settings/instructions", label: "Instructions", icon: RiQuillPenLine },
      { href: "/settings/knowledge", label: "Knowledge", icon: RiBookOpenLine },
      { href: "/settings/ai", label: "AI provider", icon: RiCpuLine },
    ],
  },
  {
    label: "CRM & leads",
    items: [
      { href: "/settings/lead-categories", label: "Lead categories", icon: RiPriceTag3Line },
      { href: "/settings/columns", label: "Lead columns", icon: RiLayoutColumnLine },
    ],
  },
  {
    label: "Preferences",
    items: [{ href: "/settings/appearance", label: "Appearance", icon: RiPaletteLine }],
  },
];

/** Where "Settings" opens. */
export const SETTINGS_HOME = SETTINGS_NAV[0].items[0].href;

