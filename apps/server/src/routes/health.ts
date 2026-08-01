import { Hono } from "hono";
import type { PlotroomDatabase } from "@plotroom/db";

export function healthRoutes(db: PlotroomDatabase): Hono {
  const app = new Hono();

  app.get("/health", (c) => {
    // A trivial query proves the DB connection is alive, not just the
    // process — a hung/locked SQLite file should surface here, not as a
    // mysterious timeout on the first real request.
    db.sqlite.prepare("SELECT 1").get();
    return c.json({ status: "ok", stateDir: db.layout.dir });
  });

  return app;
}
