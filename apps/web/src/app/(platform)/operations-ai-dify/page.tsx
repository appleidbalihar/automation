import { redirect } from "next/navigation";

// Redirect old dify URL to new RAG Assistant URL
export default function OldDifyRedirect(): never {
  redirect("/rag-assistant");
}
