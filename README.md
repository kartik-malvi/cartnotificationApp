# SHOPLINE Cart Notifier

Embedded SHOPLINE app scaffold that records add-to-cart events and shows them in an app dashboard inside admin.

## What it does

- Starts a local Node/Express app.
- Supports SHOPLINE Developer Center OAuth install flow and embedded admin dashboard rendering.
- Stores install data and cart events in `data/db.json`.
- Exposes `/api/cart-events` for storefront add-to-cart tracking.
- Renders an admin-style dashboard at `/app?shop=your-store.myshopline.com`.
- Includes a minimal theme app extension block in `theme-app-extension/`.

## Current limitations

- The official SHOPLINE docs expose embedded apps, webhooks, and theme integrations, but I did not find a public API for pushing notifications into SHOPLINE's native admin notification bell.
- This app therefore shows notifications inside its own app dashboard, not the global SHOPLINE admin notification center.
- This project can run in private-app mode or Developer Center OAuth mode. For a real installed admin app, use Developer Center OAuth mode.
- The storefront script currently sends an empty signature. You must either:
  - add SHOPLINE app proxy signing if you route requests through a signed proxy, or
  - use `ALLOW_UNSIGNED_CART_EVENTS=true` only for development, then harden it before production.

## Files

- `src/server.js`: routes, dashboard rendering, event ingestion.
- `lib/shopline.js`: install URL generation and HMAC helpers.
- `lib/store.js`: file-backed storage.
- `theme-app-extension/blocks/cart-notifier.liquid`: block/app-embed settings.
- `theme-app-extension/assets/cart-notifier.js`: storefront add-to-cart listener.

## Local setup

1. Copy `.env.example` to `.env`.
2. Fill in:
   - `APP_URL`
   - `DATABASE_URL` if you want persistent hosted storage
   - `SHOPLINE_CLIENT_ID`
   - `SHOPLINE_CLIENT_SECRET`
3. Install packages:

```bash
npm install
```

4. Start the app:

```bash
npm run dev
```

5. Open `http://localhost:3000`.

## Deploy to Render

1. Push this project to GitHub.
2. In Render, create a new `Web Service` from that repo.
3. Render can read the included `render.yaml`, or use these values manually:
   - Build command: `npm install`
   - Start command: `npm run render-start`
4. Add these environment variables in Render:
   - `APP_URL=https://your-service-name.onrender.com`
   - `PRIVATE_APP_MODE=false`
   - `DEFAULT_SHOP_DOMAIN=testlive.myshopline.com`
   - `DATABASE_URL=postgresql://...`
   - `SHOPLINE_CLIENT_ID=...`
   - `SHOPLINE_CLIENT_SECRET=...`
   - `SHOPLINE_SCOPES=read_products,write_script_tags`
   - `SESSION_SECRET=...`
   - `ALLOW_UNSIGNED_CART_EVENTS=true` for testing only
5. After Render deploys, configure your SHOPLINE Developer Center app:
   - `App URL`: `https://your-service-name.onrender.com/auth/install`
   - `App callback URL`: `https://your-service-name.onrender.com/auth/callback`

Render sets `PORT` automatically. The included Render start command binds the app to `0.0.0.0`.
If `DATABASE_URL` is set, the app stores installs and cart history in Postgres. Otherwise it falls back to `data/db.json`.

## Recommended next steps

1. Add the storefront tracking script or theme block to your test theme.
2. Decide how you want storefront events authenticated.
3. Convert the HTML dashboard to the exact embedded app stack you prefer, such as React or Next.js.

## Storefront test snippet

If your theme blocks `fetch` cart tracking, use a pixel request instead:

```html
<script>
(function () {
  var endpoint = "https://cartnotificationapp.onrender.com/api/cart-events.gif";
  var shop = "testlive.myshopline.com";

  function sendCartEvent(data) {
    var params = new URLSearchParams({
      shop: shop,
      productId: data.productId || "",
      variantId: data.variantId || "",
      quantity: data.quantity || "1",
      productTitle: data.productTitle || document.title,
      productImage: data.productImage || "",
      pageUrl: window.location.href
    });

    new Image().src = endpoint + "?" + params.toString();
  }

  document.addEventListener("submit", function (event) {
    var form = event.target;
    if (!(form instanceof HTMLFormElement)) return;

    var action = (form.getAttribute("action") || "").toLowerCase();
    if (!action.includes("/cart")) return;

    var idField = form.querySelector('[name="id"], [name="variant_id"], [name="variantId"]');
    var qtyField = form.querySelector('[name="quantity"], [name="qty"]');

    sendCartEvent({
      variantId: idField ? idField.value : "",
      quantity: qtyField ? qtyField.value : "1"
    });
  });
})();
</script>
```
