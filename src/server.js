import "dotenv/config";
import express from "express";
import helmet from "helmet";
import morgan from "morgan";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildInstallUrl,
  isValidProxySignature,
  signShoplinePostBody,
  verifyInstallSignature
} from "../lib/shopline.js";
import {
  deleteEvent,
  deleteAllEvents,
  getStore,
  listEventsForStore,
  markAllRead,
  saveInstall,
  saveEvent
} from "../lib/store.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "127.0.0.1";
const appUrl = process.env.APP_URL || `http://localhost:${port}`;
const privateAppMode = process.env.PRIVATE_APP_MODE !== "false";
const defaultShop = normalizeShop(process.env.DEFAULT_SHOP_DOMAIN);

app.set("trust proxy", true);
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: "cross-origin" },
    frameguard: false
  })
);
app.use(morgan("dev"));
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }

  next();
});
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
  const handle = normalizeHandle(req.query.handle) || handleFromShop(req.query.shop) || handleFromShop(defaultShop);
  if (!handle) {
    res.status(400).json({ error: "Missing or invalid `shop` query parameter." });
    return;
  }

  if (privateAppMode) {
    const shop = `${handle}.myshopline.com`;
    await ensurePrivateInstall(shop);
    res.redirect(`/app?shop=${encodeURIComponent(shop)}`);
    return;
  }

  res.redirect(buildInstallUrl(handle, appUrl));
});

app.get("/auth/callback", async (req, res) => {
  const params = Object.fromEntries(
    Object.entries(req.query).map(([key, value]) => [key, Array.isArray(value) ? value[0] : value])
  );

  const handle = normalizeHandle(params.handle) || handleFromShop(params.shop);
  if (!handle) {
    res.status(400).send("Missing `shop`.");
    return;
  }

  const shop = `${handle}.myshopline.com`;

  if (privateAppMode) {
    await ensurePrivateInstall(shop);
    res.redirect(`/app?shop=${encodeURIComponent(shop)}`);
    return;
  }

  if (!verifyInstallSignature(params)) {
    res.status(401).send("Invalid SHOPLINE install signature.");
    return;
  }

  const accessToken = params.access_token || (await exchangeCodeForToken(params.code, handle));
  await saveInstall({
    handle,
    shop,
    accessToken,
    installedAt: new Date().toISOString(),
    mode: "oauth"
  });
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

app.get("/api/events", async (req, res) => {
  const shop = normalizeShop(req.query.shop) || defaultShop;
  if (!shop) {
    res.status(400).json({ error: "Missing `shop`." });
    return;
  }

  const store = await getStore(shop);
  const events = await listEventsForStore(shop);
  const unreadCount = events.filter((event) => !event.read).length;

  res.json({
    events,
    installed: Boolean(store),
    shop,
    unreadCount
  });
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

app.post("/app/events/delete", async (req, res) => {
  const shop = normalizeShop(req.body.shop) || defaultShop;
  const eventId = typeof req.body.eventId === "string" ? req.body.eventId : "";

  if (!shop || !eventId) {
    res.status(400).json({ error: "Missing `shop` or `eventId`." });
    return;
  }

  await deleteEvent(shop, eventId);
  res.redirect(`/app?shop=${encodeURIComponent(shop)}`);
});

app.post("/app/events/delete-all", async (req, res) => {
  const shop = normalizeShop(req.body.shop) || defaultShop;
  if (!shop) {
    res.status(400).json({ error: "Missing `shop`." });
    return;
  }

  await deleteAllEvents(shop);
  res.redirect(`/app?shop=${encodeURIComponent(shop)}`);
});

app.post("/api/cart-events", async (req, res) => {
  const event = await createCartEvent(req.body || {});

  res.status(201).json({ ok: true, eventId: event.id });
});

app.get("/api/cart-events.gif", async (req, res) => {
  try {
    await createCartEvent(req.query || {});
  } catch (error) {
    console.error("cart-events.gif failed", {
      message: error instanceof Error ? error.message : String(error),
      query: req.query || {}
    });
  }

  res.setHeader("Content-Type", "image/gif");
  res.setHeader("Cache-Control", "no-store");
  res.end(
    Buffer.from(
      "R0lGODlhAQABAPAAAAAAAAAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==",
      "base64"
    )
  );
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

function normalizeHandle(value) {
  if (typeof value !== "string") {
    return "";
  }

  return value.trim().toLowerCase().replace(/\.myshopline\.com$/, "");
}

function handleFromShop(value) {
  return normalizeHandle(value);
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

async function exchangeCodeForToken(code, handle) {
  if (typeof code !== "string" || !code) {
    return "";
  }

  const appKey = process.env.SHOPLINE_CLIENT_ID || "";
  const timestamp = String(Date.now());
  const payload = JSON.stringify({
    appKey,
    code,
    handle
  });
  const sign = signShoplinePostBody(payload, timestamp);

  const response = await fetch("https://developer.shopline.com/api/v1/oauth/access_token", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      sign,
      timestamp
    },
    body: payload
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`SHOPLINE token exchange failed: ${response.status} ${text}`);
  }

  const data = await response.json();
  return data.accessToken || data.access_token || "";
}

async function createCartEvent(payload) {
  const shop = normalizeShop(payload.shop);
  if (!shop) {
    throw new Error("Missing `shop`.");
  }

  if (!isValidProxySignature(payload)) {
    throw new Error("Invalid signature.");
  }

  return saveEvent({
    customer: {
      email: payload.customerEmail || "",
      id: payload.customerId || "",
      name: payload.customerName || ""
    },
    product: {
      id: payload.productId || "",
      image: payload.productImage || "",
      title: payload.productTitle || "Unknown product",
      variantId: payload.variantId || ""
    },
    quantity: Number(payload.quantity || 1),
    read: false,
    shop,
    storefrontUrl: payload.pageUrl || "",
    occurredAt: new Date().toISOString()
  });
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
  const eventCards = renderEventCards(events);

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
            <p class="muted" id="install-status">${installed ? "App install saved locally." : "App install not found yet."}</p>
          </div>
          <div class="stats">
            <span class="stat-label">Unread</span>
            <strong id="unread-count">${escapeHtml(String(unreadCount))}</strong>
          </div>
        </header>
        <section class="callout">
          <p>App URL: <code>${escapeHtml(appUrl)}</code></p>
          <p>Theme block file: <code>theme-app-extension/blocks/cart-notifier.liquid</code></p>
        </section>
        <div class="toolbar">
          <form action="/app/notifications/read" method="post">
            <input type="hidden" name="shop" value="${escapeHtml(shop)}" />
            <button type="submit">Mark all read</button>
          </form>
          <form action="/app/events/delete-all" method="post">
            <input type="hidden" name="shop" value="${escapeHtml(shop)}" />
            <button type="submit" class="ghost-button">Delete all history</button>
          </form>
        </div>
        <p class="muted history-note">This dashboard keeps cart history until you delete individual records.</p>
        <section class="grid" id="events-grid">${eventCards}</section>
      </main>
      <script>
        const shop = ${JSON.stringify(shop)};
        const eventsGrid = document.getElementById("events-grid");
        const unreadCount = document.getElementById("unread-count");
        const installStatus = document.getElementById("install-status");
        let lastSignature = ${JSON.stringify(buildEventsSignature(events, unreadCount, installed))};

        async function refreshEvents() {
          try {
            const response = await fetch("/api/events?shop=" + encodeURIComponent(shop), {
              headers: { Accept: "application/json" },
              cache: "no-store"
            });
            if (!response.ok) return;

            const data = await response.json();
            const signature = JSON.stringify({
              installed: data.installed,
              unreadCount: data.unreadCount,
              ids: data.events.map(function (event) {
                return [event.id, event.read, event.occurredAt];
              })
            });

            if (signature === lastSignature) return;
            lastSignature = signature;

            unreadCount.textContent = String(data.unreadCount);
            installStatus.textContent = data.installed
              ? "App install saved locally."
              : "App install not found yet.";
            eventsGrid.innerHTML = renderEventsHtml(data.events);
          } catch (_error) {
            // Ignore transient polling errors.
          }
        }

        function renderEventsHtml(events) {
          if (!events.length) {
            return '<div class="empty-state"><h3>No cart notifications yet</h3><p>After the theme extension is enabled, new add-to-cart events will appear here.</p></div>';
          }

          return events.map(function (event) {
            const when = new Date(event.occurredAt).toLocaleString("en-US", {
              dateStyle: "medium",
              timeStyle: "short"
            });
            const page = event.storefrontUrl
              ? '<a href="' + escapeHtml(event.storefrontUrl) + '" target="_blank" rel="noreferrer">Open</a>'
              : "-";

            return '<article class="event-card ' + (event.read ? "read" : "unread") + '">' +
              '<div class="event-header"><div><h3>' + escapeHtml(event.product.title) + '</h3><p>' + escapeHtml(when) + '</p></div><span class="badge">' + (event.read ? "Read" : "New") + '</span></div>' +
              '<dl class="meta">' +
              '<div><dt>Qty</dt><dd>' + escapeHtml(String(event.quantity)) + '</dd></div>' +
              '<div><dt>Product ID</dt><dd>' + escapeHtml(event.product.id || "-") + '</dd></div>' +
              '<div><dt>Variant ID</dt><dd>' + escapeHtml(event.product.variantId || "-") + '</dd></div>' +
              '<div><dt>Customer</dt><dd>' + escapeHtml(event.customer.email || event.customer.name || "Guest") + '</dd></div>' +
              '<div><dt>Page</dt><dd>' + page + '</dd></div>' +
              '</dl>' +
              '<form action="/app/events/delete" method="post" class="delete-form">' +
              '<input type="hidden" name="shop" value="' + escapeHtml(shop) + '">' +
              '<input type="hidden" name="eventId" value="' + escapeHtml(event.id) + '">' +
              '<button type="submit" class="ghost-button">Delete record</button>' +
              '</form></article>';
          }).join("");
        }

        function escapeHtml(value) {
          return String(value)
            .replaceAll("&", "&amp;")
            .replaceAll("<", "&lt;")
            .replaceAll(">", "&gt;")
            .replaceAll('"', "&quot;")
            .replaceAll("'", "&#39;");
        }

        setInterval(refreshEvents, 1000);
      </script>
    </body>
  </html>`;
}

function renderEventCards(events) {
  return events.length
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
            <form action="/app/events/delete" method="post" class="delete-form">
              <input type="hidden" name="shop" value="${escapeHtml(event.shop)}" />
              <input type="hidden" name="eventId" value="${escapeHtml(event.id)}" />
              <button type="submit" class="ghost-button">Delete record</button>
            </form>
          </article>`;
        })
        .join("")
    : `<div class="empty-state">
        <h3>No cart notifications yet</h3>
        <p>After the theme extension is enabled, new add-to-cart events will appear here.</p>
      </div>`;
}

function buildEventsSignature(events, unreadCount, installed) {
  return JSON.stringify({
    installed,
    unreadCount,
    ids: events.map((event) => [event.id, event.read, event.occurredAt])
  });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
