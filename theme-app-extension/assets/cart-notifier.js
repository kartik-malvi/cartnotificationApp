(function () {
  const config = window.ShoplineCartNotifier;
  if (!config || !config.enabled || !config.endpoint) {
    return;
  }

  document.addEventListener("submit", async function (event) {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) {
      return;
    }

    const action = (form.getAttribute("action") || "").toLowerCase();
    if (!action.includes("/cart")) {
      return;
    }

    const productId = readValue(form, ["product_id", "id", "product-id"]);
    const variantId = readValue(form, ["variant_id", "variantId", "id"]);
    const quantity = readValue(form, ["quantity", "qty"]) || "1";
    const productTitle =
      form.dataset.productTitle ||
      document.querySelector("[data-product-title]")?.getAttribute("data-product-title") ||
      document.title;
    const productImage =
      document.querySelector("[data-product-image]")?.getAttribute("data-product-image") ||
      document.querySelector("meta[property='og:image']")?.getAttribute("content") ||
      "";

    const payload = {
      customerEmail: "",
      customerId: "",
      customerName: "",
      pageUrl: window.location.href,
      productId: productId || "",
      productImage,
      productTitle,
      quantity,
      shop: config.shop,
      signature: "",
      variantId: variantId || ""
    };

    try {
      if (navigator.sendBeacon) {
        const blob = new Blob([JSON.stringify(payload)], { type: "application/json" });
        navigator.sendBeacon(config.endpoint, blob);
        return;
      }

      fetch(config.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        keepalive: true
      }).catch(function () {});
    } catch (_error) {
      // Swallow errors so storefront add-to-cart is unaffected.
    }
  });

  function readValue(form, names) {
    for (const name of names) {
      const field = form.querySelector(`[name="${name}"]`);
      if (field && "value" in field) {
        return field.value;
      }
    }

    return "";
  }
})();
