import { getConfig, hasValidSession } from "@/lib/auth";
import Gate from "./gate";
import Viewer from "./viewer";

// The whole page depends on the session cookie; never prerender a stale gate.
export const dynamic = "force-dynamic";

export default async function Page() {
  const configured = getConfig() !== null;
  const authed = configured && (await hasValidSession());
  return authed ? <Viewer /> : <Gate configured={configured} />;
}
