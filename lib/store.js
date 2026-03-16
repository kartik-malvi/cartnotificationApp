import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbPath = path.join(__dirname, "..", "data", "db.json");
const tempDbPath = path.join(__dirname, "..", "data", "db.tmp.json");
let writeQueue = Promise.resolve();

export async function getStore(shop) {
  const db = await readDb();
  return db.stores[shop] || null;
}

export async function saveInstall(install) {
  return withWriteLock(async () => {
    const db = await readDb();
    db.stores[install.shop] = install;
    await writeDb(db);
    return install;
  });
}

export async function saveEvent(event) {
  return withWriteLock(async () => {
    const db = await readDb();
    const existingIndex = db.events.findIndex((existing) => {
      if (existing.shop !== event.shop) return false;
      if (existing.read) return false;
      if ((existing.product?.variantId || "") !== (event.product?.variantId || "")) return false;

      const existingProductId = existing.product?.id || "";
      const incomingProductId = event.product?.id || "";
      if (existingProductId && incomingProductId && existingProductId !== incomingProductId) {
        return false;
      }

      return true;
    });

    if (existingIndex !== -1) {
      const existing = db.events[existingIndex];
      const merged = {
        ...existing,
        occurredAt: event.occurredAt,
        product: {
          ...existing.product,
          ...event.product
        },
        quantity: Number(event.quantity || existing.quantity || 1),
        storefrontUrl: event.storefrontUrl || existing.storefrontUrl
      };

      db.events[existingIndex] = merged;
      await writeDb(db);
      return merged;
    }

    const record = {
      id: crypto.randomUUID(),
      ...event
    };

    db.events.unshift(record);
    await writeDb(db);
    return record;
  });
}

export async function listEventsForStore(shop) {
  const db = await readDb();
  return db.events.filter((event) => event.shop === shop);
}

export async function markAllRead(shop) {
  await withWriteLock(async () => {
    const db = await readDb();
    db.events = db.events.map((event) => (event.shop === shop ? { ...event, read: true } : event));
    await writeDb(db);
  });
}

export async function deleteEvent(shop, eventId) {
  await withWriteLock(async () => {
    const db = await readDb();
    db.events = db.events.filter((event) => !(event.shop === shop && event.id === eventId));
    await writeDb(db);
  });
}

export async function deleteAllEvents(shop) {
  await withWriteLock(async () => {
    const db = await readDb();
    db.events = db.events.filter((event) => event.shop !== shop);
    await writeDb(db);
  });
}

async function readDb() {
  try {
    const raw = await fs.readFile(dbPath, "utf8");
    if (!raw.trim()) {
      return { stores: {}, events: [] };
    }
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === "ENOENT") {
      return { stores: {}, events: [] };
    }

    if (error.name === "SyntaxError") {
      return { stores: {}, events: [] };
    }

    throw error;
  }
}

async function writeDb(db) {
  await fs.mkdir(path.dirname(dbPath), { recursive: true });
  const contents = JSON.stringify(db, null, 2);
  await fs.writeFile(tempDbPath, contents);
  await fs.rename(tempDbPath, dbPath);
}

function withWriteLock(operation) {
  writeQueue = writeQueue.then(operation, operation);
  return writeQueue;
}
