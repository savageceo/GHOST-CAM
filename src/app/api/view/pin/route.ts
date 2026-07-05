import { hasValidSession } from "@/lib/auth";
import { isViewablePath, pinFrame, PINNED_PREFIX } from "@/lib/lab";

// Copy a frame into the permanent archive. Pinned blobs are never pruned.
export async function POST(request: Request) {
  if (!(await hasValidSession())) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  let body: { path?: unknown; label?: unknown; kind?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "bad request" }, { status: 400 });
  }
  const path = typeof body.path === "string" ? body.path : "";
  if (!isViewablePath(path) || path.startsWith(PINNED_PREFIX)) {
    return Response.json({ error: "bad path" }, { status: 400 });
  }
  const label = typeof body.label === "string" ? body.label.slice(0, 60) : "pinned";
  const kind = typeof body.kind === "string" ? body.kind.slice(0, 16) : "frame";
  try {
    const pin = await pinFrame(path, label, kind);
    return Response.json({ ok: true, pin });
  } catch {
    return Response.json({ error: "pin failed" }, { status: 500 });
  }
}
