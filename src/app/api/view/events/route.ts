import { hasValidSession } from "@/lib/auth";
import { deleteMotionEvent, listMotionEvents } from "@/lib/store";

const EVENT_CAP = 80;

export async function GET() {
  if (!(await hasValidSession())) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  return Response.json(
    { events: await listMotionEvents(EVENT_CAP) },
    { headers: { "cache-control": "private, no-store" } },
  );
}

export async function DELETE(request: Request) {
  if (!(await hasValidSession())) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const { searchParams } = new URL(request.url);
  const event = searchParams.get("event") ?? "";
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,49}$/.test(event)) {
    return Response.json({ error: "bad event" }, { status: 400 });
  }
  const removed = await deleteMotionEvent(event);
  return Response.json({ ok: true, removed });
}
