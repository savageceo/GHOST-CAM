import { hasValidSession } from "@/lib/auth";
import { signedUrlFor } from "@/lib/store";
import { isViewablePath } from "@/lib/lab";

// Redirects to a short-lived signed CDN URL. Frame paths are unique per
// capture, so the CDN can cache the content without ever serving stale.
export async function GET(request: Request) {
  if (!(await hasValidSession())) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const { searchParams } = new URL(request.url);
  const path = searchParams.get("path") ?? "";
  if (!isViewablePath(path)) {
    return Response.json({ error: "bad path" }, { status: 400 });
  }
  return Response.redirect(await signedUrlFor(path), 302);
}
