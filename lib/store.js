import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbPath = path.join(__dirname, "..", "data", "db.json");

export async function getStore(shop) {
  const db = await readDb();
  return db.stores[shop] || null;
}

export async function saveInstall(install) {
  const db = await readDb();
  db.stores[install.shop] = install;
  await writeDb(db);
  return install;
}

export async function saveEvent(event) {
  const db = await readDb();
  const record = {
    id: crypto.randomUUID(),
    ...event
  };

  db.events.unshift(record);
  await writeDb(db);
  return record;
}

export async function listEventsForStore(shop) {
  const db = await readDb();
  return db.events.filter((event) => event.shop === shop);
}

export async function markAllRead(shop) {
  const db = await readDb();
  db.events = db.events.map((event) => (event.shop === shop ? { ...event, read: true } : event));
  await writeDb(db);
}

async function readDb() {
  try {
    const raw = await fs.readFile(dbPath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === "ENOENT") {
      return { stores: {}, events: [] };
    }

    throw error;
  }
}

async function writeDb(db) {
  await fs.mkdir(path.dirname(dbPath), { recursive: true });
  await fs.writeFile(dbPath, JSON.stringify(db, null, 2));
}
