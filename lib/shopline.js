import crypto from "node:crypto";

export function buildInstallUrl(handle, appUrl) {
  const redirectUri = `${appUrl}/auth/callback`;
  const scopes = process.env.SHOPLINE_SCOPES || "";
  const clientId = process.env.SHOPLINE_CLIENT_ID || "";

  const query = new URLSearchParams({
    appKey: clientId,
    redirectUri,
    responseType: "code",
    scope: scopes
  });

  return `https://${handle}.myshopline.com/admin/oauth-web/#/oauth/authorize?${query.toString()}`;
}

export function verifyInstallSignature(params) {
  const secret = process.env.SHOPLINE_CLIENT_SECRET || "";
  const providedSignature = params.sign || "";
  if (!secret || !providedSignature) {
    return false;
  }

  const sanitized = { ...params };
  delete sanitized.sign;

  const message = Object.keys(sanitized)
    .sort()
    .map((key) => `${key}=${sanitized[key]}`)
    .join("&");

  const expectedSignature = crypto.createHmac("sha256", secret).update(message).digest("hex");
  return safeCompare(expectedSignature, providedSignature);
}

export function isValidProxySignature(payload) {
  if (process.env.ALLOW_UNSIGNED_CART_EVENTS === "true") {
    return true;
  }

  const secret = process.env.SESSION_SECRET || process.env.SHOPLINE_CLIENT_SECRET || "";
  const signature = typeof payload.signature === "string" ? payload.signature : "";
  if (!secret || !signature) {
    return false;
  }

  const sanitized = { ...payload };
  delete sanitized.signature;

  const message = Object.keys(sanitized)
    .sort()
    .map((key) => `${key}=${sanitized[key]}`)
    .join("&");

  const expected = crypto.createHmac("sha256", secret).update(message).digest("hex");
  return safeCompare(expected, signature);
}

export function signPayload(payload) {
  const secret = process.env.SESSION_SECRET || process.env.SHOPLINE_CLIENT_SECRET || "";
  const message = Object.keys(payload)
    .sort()
    .map((key) => `${key}=${payload[key]}`)
    .join("&");

  return crypto.createHmac("sha256", secret).update(message).digest("hex");
}

export function signShoplinePostBody(body, timestamp) {
  const secret = process.env.SHOPLINE_CLIENT_SECRET || "";
  return crypto.createHmac("sha256", secret).update(`${body}${timestamp}`).digest("hex");
}

function safeCompare(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);

  if (left.length !== right.length) {
    return false;
  }

  return crypto.timingSafeEqual(left, right);
}
