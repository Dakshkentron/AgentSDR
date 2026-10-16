import { redirect } from "next/navigation";
import { needsSetup } from "@/lib/auth/setup";
import { GOOGLE_SIGN_IN_ENABLED } from "@/lib/auth/server";
import { publicSignupAvailable } from "@/lib/auth/signup";
import { isDemoMode } from "@/lib/demo/mode";
import { safeFrom } from "@/components/auth/safeFrom";
import { SignInForm } from "./SignInForm";

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ from?: string; created?: string; email?: string }> }) {
  // A fresh instance has no one to sign in: send the visitor to first-run setup.
  if (!isDemoMode() && (await needsSetup())) redirect("/setup");
  const { from, created, email } = await searchParams;
  return <SignInForm googleEnabled={GOOGLE_SIGN_IN_ENABLED} from={safeFrom(from)} signupAvailable={await publicSignupAvailable()} created={created === "1"} initialEmail={email ?? ""} />;
}
