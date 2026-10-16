import { redirect } from "next/navigation";
import { needsSetup } from "@/lib/auth/setup";
import { GOOGLE_SIGN_IN_ENABLED } from "@/lib/auth/server";
import { isDemoMode } from "@/lib/demo/mode";
import { safeFrom } from "@/components/auth/safeFrom";
import { SignUpForm } from "./SignUpForm";

export default async function SignUpPage({ searchParams }: { searchParams: Promise<{ from?: string }> }) {
  // A fresh instance has no one to sign in: send the visitor to first-run setup.
  if (!isDemoMode() && (await needsSetup())) redirect("/setup");
  const { from } = await searchParams;
  return <SignUpForm googleEnabled={GOOGLE_SIGN_IN_ENABLED} from={safeFrom(from)} />;
}
