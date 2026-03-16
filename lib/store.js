import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import pg from "pg";

const { Pool } = pg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbPath = path.join(__dirname, "..", "data", "db.json");
const tempDbPath = path.join(__dirname, "..", "data", "db.tmp.json");

const databaseUrl = process.env.DATABASE_URL || "";
const pool = databaseUrl
  ? new Pool({
      connectionString: databaseUrl,
      ssl: databaseUrl.includes("localhost") ? false : { rejectUnauthorized: false }
    })
  : null;

let initialized = false;
let initPromise = null;
let writeQueue = Promise.resolve();

export async function getStore(shop) {
  if (pool) {
    await ensureSchema();
    const result = await pool.query("SELECT payload FROM stores WHERE shop = $1", [shop]);
    return result.rows[0]?.payload || null;
  }

  const db = await readFileDb();
  return db.stores[shop] || null;
}

export async function saveInstall(install) {
  if (pool) {
    await ensureSchema();
    await pool.query(
      `
        INSERT INTO stores (shop, payload, updated_at)
        VALUES ($1, $2::jsonb, NOW())
        ON CONFLICT (shop)
        DO UPDATE SET payload = EXCLUDED.payload, updated_at = NOW()
      `,
      [install.shop, JSON.stringify(install)]
    );
    return install;
  }

  return withWriteLock(async () => {
    const db = await readFileDb();
    db.stores[install.shop] = install;
    await writeFileDb(db);
    return install;
  });
}

export async function saveEvent(event) {
  if (pool) {
    await ensureSchema();

    const existing = await pool.query(
      `
        SELECT id, payload
        FROM events
        WHERE shop = $1
          AND read = false
          AND COALESCE(payload->'product'->>'variantId', '') = $2
          AND (
            COALESCE(payload->'product'->>'id', '') = ''
            OR $3 = ''
            OR COALESCE(payload->'product'->>'id', '') = $3
          )
        ORDER BY occurred_at DESC
        LIMIT 1
      `,
      [event.shop, event.product?.variantId || "", event.product?.id || ""]
    );

    if (existing.rows[0]) {
      const current = existing.rows[0].payload;
      const merged = mergeEvents(current, event);
      await pool.query(
        `
          UPDATE events
          SET payload = $2::jsonb,
              read = $3,
              occurred_at = $4::timestamptz,
              updated_at = NOW()
          WHERE id = $1
        `,
        [existing.rows[0].id, JSON.stringify(merged), merged.read, merged.occurredAt]
      );
      return merged;
    }

    const record = { id: crypto.randomUUID(), ...event };
    await pool.query(
      `
        INSERT INTO events (id, shop, read, occurred_at, payload)
        VALUES ($1, $2, $3, $4::timestamptz, $5::jsonb)
      `,
      [record.id, record.shop, record.read, record.occurredAt, JSON.stringify(record)]
    );
    return record;
  }

  return withWriteLock(async () => {
    const db = await readFileDb();
    const existingIndex = db.events.findIndex((existing) => matchesMergeCandidate(existing, event));

    if (existingIndex !== -1) {
      const merged = mergeEvents(db.events[existingIndex], event);
      db.events[existingIndex] = merged;
      await writeFileDb(db);
      return merged;
    }

    const record = { id: crypto.randomUUID(), ...event };
    db.events.unshift(record);
    await writeFileDb(db);
    return record;
  });
}

export async function listEventsForStore(shop) {
  if (pool) {
    await ensureSchema();
    const result = await pool.query(
      "SELECT payload FROM events WHERE shop = $1 ORDER BY occurred_at DESC, updated_at DESC",
      [shop]
    );
    return result.rows.map((row) => row.payload);
  }

  const db = await readFileDb();
  return db.events.filter((event) => event.shop === shop);
}

export async function markAllRead(shop) {
  if (pool) {
    await ensureSchema();
    const result = await pool.query("SELECT id, payload FROM events WHERE shop = $1", [shop]);
    for (const row of result.rows) {
      const payload = { ...row.payload, read: true };
      await pool.query(
        "UPDATE events SET payload = $2::jsonb, read = true, updated_at = NOW() WHERE id = $1",
        [row.id, JSON.stringify(payload)]
      );
    }
    return;
  }

  await withWriteLock(async () => {
    const db = await readFileDb();
    db.events = db.events.map((event) => (event.shop === shop ? { ...event, read: true } : event));
    await writeFileDb(db);
  });
}

export async function deleteEvent(shop, eventId) {
  if (pool) {
    await ensureSchema();
    await pool.query("DELETE FROM events WHERE shop = $1 AND id = $2", [shop, eventId]);
    return;
  }

  await withWriteLock(async () => {
    const db = await readFileDb();
    db.events = db.events.filter((event) => !(event.shop === shop && event.id === eventId));
    await writeFileDb(db);
  });
}

export async function deleteAllEvents(shop) {
  if (pool) {
    await ensureSchema();
    await pool.query("DELETE FROM events WHERE shop = $1", [shop]);
    return;
  }

  await withWriteLock(async () => {
    const db = await readFileDb();
    db.events = db.events.filter((event) => event.shop !== shop);
    await writeFileDb(db);
  });
}

async function ensureSchema() {
  if (!pool || initialized) {
    return;
  }

  if (!initPromise) {
    initPromise = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS stores (
          shop text PRIMARY KEY,
          payload jsonb NOT NULL,
          updated_at timestamptz NOT NULL DEFAULT NOW()
        )
      `);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS events (
          id text PRIMARY KEY,
          shop text NOT NULL,
          read boolean NOT NULL DEFAULT false,
          occurred_at timestamptz NOT NULL,
          payload jsonb NOT NULL,
          updated_at timestamptz NOT NULL DEFAULT NOW()
        )
      `);

      await pool.query("CREATE INDEX IF NOT EXISTS idx_events_shop_time ON events (shop, occurred_at DESC)");
      initialized = true;
    })().catch((error) => {
      initPromise = null;
      throw error;
    });
  }

  await initPromise;
}

function matchesMergeCandidate(existing, event) {
  if (existing.shop !== event.shop) return false;
  if (existing.read) return false;
  if ((existing.product?.variantId || "") !== (event.product?.variantId || "")) return false;

  const existingProductId = existing.product?.id || "";
  const incomingProductId = event.product?.id || "";
  if (existingProductId && incomingProductId && existingProductId !== incomingProductId) {
    return false;
  }

  return true;
}

function mergeEvents(existing, event) {
  const incomingProduct = event.product || {};
  const existingProduct = existing.product || {};

  return {
    ...existing,
    occurredAt: event.occurredAt,
    product: {
      ...existingProduct,
      id: incomingProduct.id || existingProduct.id || "",
      image: incomingProduct.image || existingProduct.image || "",
      title: incomingProduct.title || existingProduct.title || "Product",
      variantId: incomingProduct.variantId || existingProduct.variantId || ""
    },
    quantity: Number(existing.quantity || 0) + Number(event.quantity || 1),
    storefrontUrl: event.storefrontUrl || existing.storefrontUrl
  };
}

async function readFileDb() {
  try {
    const raw = await fs.readFile(dbPath, "utf8");
    if (!raw.trim()) {
      return { stores: {}, events: [] };
    }
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === "ENOENT" || error.name === "SyntaxError") {
      return { stores: {}, events: [] };
    }

    throw error;
  }
}

async function writeFileDb(db) {
  await fs.mkdir(path.dirname(dbPath), { recursive: true });
  const contents = JSON.stringify(db, null, 2);
  await fs.writeFile(tempDbPath, contents);
  await fs.rename(tempDbPath, dbPath);
}

function withWriteLock(operation) {
  writeQueue = writeQueue.then(operation, operation);
  return writeQueue;
}
