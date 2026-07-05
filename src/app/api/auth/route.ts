import { cookies } from "next/headers";
import {
  checkPassword,
  createSessionToken,
  getConfig,
  rateLimit,
  SESSION_COOKIE,
  SESSION_TTL_MS,
} from "@/lib/auth";

export async function POST(request: Request) {
  const config = getConfig();
  if (!config) {
    return Response.json({ error: "not configured" }, { status: 503 });
  }

  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  if (!rateLimit(ip)) {
    return Response.json({ error: "too many attempts" }, { status: 429 });
  }

  let password: unknown;
  try {
    ({ password } = await request.json());
  } catch {
    return Response.json({ error: "bad request" }, { status: 400 });
  }

  if (
    typeof password !== "string" ||
    !checkPassword(config.password, password)
  ) {
    await new Promise((resolve) => setTimeout(resolve, 400));
    return Response.json({ error: "wrong password" }, { status: 401 });
  }

  const store = await cookies();
  store.set(SESSION_COOKIE, createSessionToken(config.secret), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_MS / 1000,
  });
  return Response.json({ ok: true });
}

export async function DELETE() {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
  return Response.json({ ok: true });
}
