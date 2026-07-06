import { hasValidSession } from "@/lib/auth";
import { pushConfigured, sendPushToAll } from "@/lib/push";

// Fire a test notification to every subscribed device — the "does this work?"
// button in the dashboard.
export async function POST() {
  if (!(await hasValidSession())) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!pushConfigured()) {
    return Response.json({ error: "push not configured" }, { status: 503 });
  }
  const result = await sendPushToAll({
    title: "SAVAGE LAB — test alert",
    body: "Push is working. You'll get one of these when motion is detected.",
    url: "/",
    tag: "savage-test",
  });
  return Response.json({ ok: true, ...result });
}
