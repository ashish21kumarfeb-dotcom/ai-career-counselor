// One-time infrastructure step: install the pgvector extension.
//
// Kept OUT of the drizzle migrations deliberately. drizzle-kit generates DDL from
// the schema diff and has no notion of extensions, so the CREATE EXTENSION would
// have to be hand-written into a generated file — which the project rule forbids,
// and for a good reason: a hand-edited migration is silently overwritten the next
// time that file is regenerated. Installing an extension is also not a schema
// change but a database capability, needs elevated rights, and is idempotent.
//
// Run this ONCE per database (including any new environment) BEFORE applying the
// migration that adds the embedding column — that migration references the
// `vector` type and cannot be applied without it.
//
//   npm run db:pgvector
import "dotenv/config";
import { sql } from "drizzle-orm";
import { db } from "../src/db";

const [available] = (
  await db.execute(
    sql`select default_version from pg_available_extensions where name = 'vector'`
  )
).rows as Array<{ default_version: string } | undefined>;

if (!available) {
  console.error(
    "pgvector is not available on this Postgres instance. On Neon it ships by default; " +
      "elsewhere the server needs the extension installed at the OS level first."
  );
  process.exit(1);
}

await db.execute(sql`create extension if not exists vector`);

const [installed] = (
  await db.execute(
    sql`select extversion from pg_extension where extname = 'vector'`
  )
).rows as Array<{ extversion: string } | undefined>;

console.log(`pgvector ready — version ${installed?.extversion ?? "unknown"}.`);
