import { hasValidSession } from "@/lib/auth";
import { deletePin, listPins } from "@/lib/lab";

export async function GET() {
  if (!(await hasValidSession())) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  return Response.json(
    { pins: await listPins() },
    { headers: { "cache-control": "private, no-store" } },
  );
}

export async function DELETE(request: Request) {
  if (!(await hasValidSession())) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const { searchParams } = new URL(request.url);
  const path = searchParams.get("path") ?? "";
  if (!/^pinned\/[A-Za-z0-9/._-]+$/.test(path) || path.includes("..")) {
    return Response.json({ error: "bad path" }, { status: 400 });
  }
  return Response.json({ ok: await deletePin(path) });
}
