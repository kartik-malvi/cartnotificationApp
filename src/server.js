import "dotenv/config";
import express from "express";
import helmet from "helmet";
import morgan from "morgan";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isValidProxySignature } from "../lib/shopline.js";
import { getStore, listEventsForStore, markAllRead, saveInstall, saveEvent } from "../lib/store.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "127.0.0.1";
const appUrl = process.env.APP_URL || `http://localhost:${port}`;
const privateAppMode = process.env.PRIVATE_APP_MODE !== "false";
const defaultShop = normalizeShop(process.env.DEFAULT_SHOP_DOMAIN);

app.set("trust proxy", true);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(morgan("dev"));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use("/static", express.static(path.join(__dirname, "..", "public")));

app.get("/", async (req, res) => {
  if (privateAppMode && defaultShop && req.query.shop !== defaultShop) {
    res.redirect(`/app?shop=${encodeURIComponent(defaultShop)}`);
    return;
  }

  res.type("html").send(renderLandingPage({ defaultShop, privateAppMode }));
});

app.get("/auth/install", async (req, res) => {
  const shop = normalizeShop(req.query.shop) || defaultShop;
  if (!shop) {
    res.status(400).json({ error: "Missing or invalid `shop` query parameter." });
    return;
  }

  if (privateAppMode) {
    await ensurePrivateInstall(shop);
    res.redirect(`/app?shop=${encodeURIComponent(shop)}`);
    return;
  }

  res.status(400).json({ error: "OAuth install flow is disabled in private app mode." });
});

app.get("/auth/callback", async (req, res) => {
  const shop = normalizeShop(req.query.shop) || defaultShop;
  if (!shop) {
    res.status(400).send("Missing `shop`.");
    return;
  }

  await ensurePrivateInstall(shop);
  res.redirect(`/app?shop=${encodeURIComponent(shop)}`);
});

app.get("/app", async (req, res) => {
  const shop = normalizeShop(req.query.shop) || defaultShop;
  if (!shop) {
    res.status(400).send("Missing `shop`.");
    return;
  }

  if (privateAppMode) {
    await ensurePrivateInstall(shop);
  }

  const store = await getStore(shop);
  const events = await listEventsForStore(shop);
  const unreadCount = events.filter((event) => !event.read).length;

  res.type("html").send(
    renderDashboardPage({
      appUrl,
      events,
      installed: Boolean(store),
      shop,
      unreadCount
    })
  );
});

app.post("/app/notifications/read", async (req, res) => {
  const shop = normalizeShop(req.body.shop);
  if (!shop) {
    res.status(400).json({ error: "Missing `shop`." });
    return;
  }

  await markAllRead(shop);
  res.redirect(`/app?shop=${encodeURIComponent(shop)}`);
});

app.post("/api/cart-events", async (req, res) => {
  const body = req.body || {};
  const shop = normalizeShop(body.shop);
  if (!shop) {
    res.status(400).json({ error: "Missing `shop`." });
    return;
  }

  if (!isValidProxySignature(body)) {
    res.status(401).json({ error: "Invalid signature." });
    return;
  }

  const event = await saveEvent({
    customer: {
      email: body.customerEmail || "",
      id: body.customerId || "",
      name: body.customerName || ""
    },
    product: {
      id: body.productId || "",
      image: body.productImage || "",
      title: body.productTitle || "Unknown product",
      variantId: body.variantId || ""
    },
    quantity: Number(body.quantity || 1),
    read: false,
    shop,
    storefrontUrl: body.pageUrl || "",
    occurredAt: new Date().toISOString()
  });

  res.status(201).json({ ok: true, eventId: event.id });
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, now: new Date().toISOString() });
});

app.listen(port, host, () => {
  console.log(`SHOPLINE cart notifier running at ${appUrl}`);
});

function normalizeShop(value) {
  if (typeof value !== "string") {
    return "";
  }

  const trimmed = value.trim().toLowerCase();
  if (!trimmed) {
    return "";
  }

  return trimmed;
}

async function ensurePrivateInstall(shop) {
  const existing = await getStore(shop);
  if (existing) {
    return existing;
  }

  const install = {
    accessToken: process.env.SHOPLINE_CLIENT_SECRET || "",
    installedAt: new Date().toISOString(),
    mode: "private",
    shop
  };

  await saveInstall(install);
  return install;
}

function renderLandingPage({ defaultShop, privateAppMode }) {
  const title = privateAppMode ? "Open app dashboard" : "Install app";
  const helper = privateAppMode
    ? "This SHOPLINE private app opens directly inside admin for your store."
    : "Install this app on a SHOPLINE store to track add-to-cart events and view them inside an admin dashboard.";
  const action = privateAppMode ? "/app" : "/auth/install";

  return `<!doctype html>
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>SHOPLINE Cart Notifier</title>
      <link rel="stylesheet" href="/static/styles.css" />
    </head>
    <body class="shell">
      <main class="panel narrow">
        <p class="eyebrow">SHOPLINE App</p>
        <h1>Cart notifier</h1>
        <p class="muted">${escapeHtml(helper)}</p>
        <form action="${action}" method="get" class="install-form">
          <label for="shop">Store domain</label>
          <input id="shop" name="shop" placeholder="example.myshopline.com" value="${escapeHtml(defaultShop || "")}" required />
          <button type="submit">${escapeHtml(title)}</button>
        </form>
      </main>
    </body>
  </html>`;
}

function renderDashboardPage({ appUrl, events, installed, shop, unreadCount }) {
  const eventCards = events.length
    ? events
        .map((event) => {
          const when = new Date(event.occurredAt).toLocaleString("en-US", {
            dateStyle: "medium",
            timeStyle: "short"
          });

          return `<article class="event-card ${event.read ? "read" : "unread"}">
            <div class="event-header">
              <div>
                <h3>${escapeHtml(event.product.title)}</h3>
                <p>${escapeHtml(when)}</p>
              </div>
              <span class="badge">${event.read ? "Read" : "New"}</span>
            </div>
            <dl class="meta">
              <div><dt>Qty</dt><dd>${escapeHtml(String(event.quantity))}</dd></div>
              <div><dt>Product ID</dt><dd>${escapeHtml(event.product.id || "-")}</dd></div>
              <div><dt>Variant ID</dt><dd>${escapeHtml(event.product.variantId || "-")}</dd></div>
              <div><dt>Customer</dt><dd>${escapeHtml(event.customer.email || event.customer.name || "Guest")}</dd></div>
              <div><dt>Page</dt><dd>${event.storefrontUrl ? `<a href="${escapeHtml(event.storefrontUrl)}" target="_blank" rel="noreferrer">Open</a>` : "-"}</dd></div>
            </dl>
          </article>`;
        })
        .join("")
    : `<div class="empty-state">
        <h3>No cart notifications yet</h3>
        <p>After the theme extension is enabled, new add-to-cart events will appear here.</p>
      </div>`;

  return `<!doctype html>
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>Cart Notifications</title>
      <link rel="stylesheet" href="/static/styles.css" />
    </head>
    <body class="shell">
      <main class="panel wide">
        <header class="page-header">
          <div>
            <p class="eyebrow">Embedded dashboard</p>
            <h1>${escapeHtml(shop)}</h1>
            <p class="muted">${installed ? "App install saved locally." : "App install not found yet."}</p>
          </div>
          <div class="stats">
            <span class="stat-label">Unread</span>
            <strong>${escapeHtml(String(unreadCount))}</strong>
          </div>
        </header>
        <section class="callout">
          <p>App URL: <code>${escapeHtml(appUrl)}</code></p>
          <p>Theme block file: <code>theme-app-extension/blocks/cart-notifier.liquid</code></p>
        </section>
        <form action="/app/notifications/read" method="post" class="toolbar">
          <input type="hidden" name="shop" value="${escapeHtml(shop)}" />
          <button type="submit">Mark all read</button>
        </form>
        <section class="grid">${eventCards}</section>
      </main>
    </body>
  </html>`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
