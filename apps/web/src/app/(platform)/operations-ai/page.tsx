import { redirect } from "next/navigation";

// Redirect old URL to new branded URL
export default function OldOperationsAiRedirect(): never {
  redirect("/rag-assistant");
}
