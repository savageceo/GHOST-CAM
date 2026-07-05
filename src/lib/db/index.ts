import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "./schema";

// Lazy singleton so importing this module never connects (keeps the build and
// any non-DB code paths working when DATABASE_URL is absent). Neon's HTTP driver
// is a good fit for Vercel's serverless/Fluid functions.
type Db = ReturnType<typeof drizzle<typeof schema>>;
let _db: Db | null = null;

export function hasDb(): boolean {
  return !!process.env.DATABASE_URL;
}

export function getDb(): Db {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  if (!_db) {
    _db = drizzle(neon(url), { schema });
  }
  return _db;
}

export { schema };
