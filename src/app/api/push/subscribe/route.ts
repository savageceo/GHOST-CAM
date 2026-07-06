import { hasValidSession } from "@/lib/auth";
import { deleteSubscription, pushConfigured, saveSubscription } from "@/lib/push";

// The PWA registers its push subscription here (session cookie required). The
// browser's PushManager gives us { endpoint, keys:{p256dh, auth} }.
export async function POST(request: Request) {
  if (!(await hasValidSession())) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!pushConfigured()) {
    return Response.json({ error: "push not configured" }, { status: 503 });
  }
  let body: {
    subscription?: {
      endpoint?: string;
      keys?: { p256dh?: string; auth?: string };
    };
  };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "bad request" }, { status: 400 });
  }
  const s = body.subscription;
  if (!s?.endpoint || !s.keys?.p256dh || !s.keys?.auth) {
    return Response.json({ error: "bad subscription" }, { status: 400 });
  }
  await saveSubscription(
    { endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth } },
    request.headers.get("user-agent") ?? undefined,
  );
  return Response.json({ ok: true });
}

export async function DELETE(request: Request) {
  if (!(await hasValidSession())) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  let endpoint = new URL(request.url).searchParams.get("endpoint") ?? "";
  if (!endpoint) {
    try {
      endpoint = ((await request.json()) as { endpoint?: string })?.endpoint ?? "";
    } catch {}
  }
  if (endpoint) await deleteSubscription(endpoint);
  return Response.json({ ok: true });
}
