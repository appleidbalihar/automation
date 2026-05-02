import { redirect } from "next/navigation";

// Redirect old URL to new branded URL
export default function OldSetupRedirect(): never {
  redirect("/knowledge-connector");
}
