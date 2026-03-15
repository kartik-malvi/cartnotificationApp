# SHOPLINE Cart Notifier

Embedded SHOPLINE app scaffold that records add-to-cart events and shows them in an app dashboard inside admin.

## What it does

- Starts a local Node/Express app.
- Provides a basic SHOPLINE install flow at `/auth/install`.
- Stores install data and cart events in `data/db.json`.
- Exposes `/api/cart-events` for storefront add-to-cart tracking.
- Renders an admin-style dashboard at `/app?shop=your-store.myshopline.com`.
- Includes a minimal theme app extension block in `theme-app-extension/`.

## Current limitations

- The official SHOPLINE docs expose embedded apps, webhooks, and theme integrations, but I did not find a public API for pushing notifications into SHOPLINE's native admin notification bell.
- This app therefore shows notifications inside its own app dashboard, not the global SHOPLINE admin notification center.
- OAuth callback token exchange is left as a scaffold. The callback currently stores `access_token` if SHOPLINE sends it directly.
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
   - `SHOPLINE_CLIENT_ID`
   - `SHOPLINE_CLIENT_SECRET`
   - `APP_URL`
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
   - `SHOPLINE_CLIENT_ID=...`
   - `SHOPLINE_CLIENT_SECRET=...`
   - `SHOPLINE_SCOPES=read_products,write_script_tags`
   - `SESSION_SECRET=...`
   - `ALLOW_UNSIGNED_CART_EVENTS=true` for testing only
5. After Render deploys, use that HTTPS URL in your SHOPLINE app settings.

Render sets `PORT` automatically. The included Render start command binds the app to `0.0.0.0`.

## Recommended next steps

1. Replace the placeholder OAuth callback with SHOPLINE's exact token exchange flow from your app config.
2. Decide how you want storefront events authenticated.
3. Convert the HTML dashboard to the exact embedded app stack you prefer, such as React or Next.js.
4. Package and publish the theme extension with SHOPLINE CLI.
