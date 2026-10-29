// Shared helpers used by create-order.js and verify.js
// (the underscore folder name tells Vercel this is NOT an endpoint)

const PROJECT_ID = process.env.FIREBASE_PROJECT_ID;
const FS = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;

// Defaults, used only if the admin has not saved shipping settings yet
const SHIPPING_FEE = 100;
const FREE_SHIPPING_ABOVE = 999;

const ALLOWED_ORIGINS = [
  "https://shop.taneeraa.com",
  "https://www.taneeraa.com",
  "https://taneeraa.com",
  "https://deenu-cmyk.github.io", // old address, remove once the new domain works
];

// Sets CORS headers. Returns true if the request was a preflight and is already answered.
export function cors(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  if (req.method === "OPTIONS") { res.status(204).end(); return true; }
  return false;
}

const fail = (msg) => Object.assign(new Error(msg), { status: 400 });

function numVal(f) {
  if (!f) return NaN;
  if (f.integerValue !== undefined) return Number(f.integerValue);
  if (f.doubleValue !== undefined) return Number(f.doubleValue);
  if (f.stringValue !== undefined) return Number(f.stringValue);
  return NaN;
}
const strVal = (f) => (f && f.stringValue !== undefined ? f.stringValue : "");

async function getProduct(id) {
  const r = await fetch(`${FS}/products/${encodeURIComponent(id)}`);
  if (!r.ok) return null;
  const f = (await r.json()).fields || {};
  const price = numVal(f.sellingPrice);
  const stock = numVal(f.stock);
  const status = strVal(f.status);
  if (!Number.isFinite(price) || price < 0) return null;
  return {
    id, price,
    name: strVal(f.name),
    imageUrl: strVal(f.imageUrl),
    inStock: status !== "Out of Stock" && stock > 0, // same rule as your website
  };
}

// Shipping charge and free-shipping limit, as saved by the admin in the "settings" collection.
// Same rule as checkout.html: a number whose name contains "free", "above", "min", "limit" or
// "threshold" is the free-shipping limit; any other number whose name (or document name) contains
// "ship" or "deliver" is the shipping charge.
async function getShipping() {
  let fee = null, free = null;
  try {
    const r = await fetch(`${FS}/settings?pageSize=50`);
    if (r.ok) {
      const docs = (await r.json()).documents || [];
      for (const d of docs) {
        const id = d.name.split("/").pop();
        const docIsShipping = /ship|deliver|freight/i.test(id);
        for (const [k, f] of Object.entries(d.fields || {})) {
          if (f.booleanValue !== undefined || f.nullValue !== undefined) continue;
          if (f.stringValue !== undefined && f.stringValue.trim() === "") continue;
          const n = numVal(f);
          if (!Number.isFinite(n) || n < 0) continue;
          if (!docIsShipping && !/ship|deliver|freight/i.test(k)) continue;
          if (/free|above|min|limit|threshold|over/i.test(k)) { if (free === null) free = n; }
          else if (fee === null) fee = n;
        }
      }
    }
  } catch (e) { console.error("Shipping settings not read, using defaults", e); }
  return { fee: fee !== null ? fee : SHIPPING_FEE, free: free !== null ? free : FREE_SHIPPING_ABOVE };
}

async function getCoupon(code) {
  const r = await fetch(`${FS}:runQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: "coupons" }],
        where: {
          compositeFilter: {
            op: "AND",
            filters: [
              { fieldFilter: { field: { fieldPath: "code" }, op: "EQUAL", value: { stringValue: code } } },
              { fieldFilter: { field: { fieldPath: "active" }, op: "EQUAL", value: { booleanValue: true } } },
            ],
          },
        },
        limit: 1,
      },
    }),
  });
  if (!r.ok) return null;
  const rows = await r.json();
  const docu = Array.isArray(rows) ? rows.find((x) => x.document) : null;
  if (!docu) return null;
  const f = docu.document.fields || {};
  return {
    code,
    discountPercentage: numVal(f.discountPercentage),
    appliesToAllProducts: !!(f.appliesToAllProducts && f.appliesToAllProducts.booleanValue),
    productIds: ((f.productIds && f.productIds.arrayValue && f.productIds.arrayValue.values) || []).map((v) => v.stringValue),
  };
}

// Works out the real order amount from your product list and coupon list
export async function priceCart(items, couponCode) {
  if (!Array.isArray(items) || items.length === 0) throw fail("Cart is empty");
  const rows = [];
  for (const item of items) {
    const qty = Number(item.qty);
    if (!item.id || !Number.isInteger(qty) || qty < 1 || qty > 50) throw fail("Invalid item in cart");
    const p = await getProduct(String(item.id));
    if (!p) throw fail("Product not found");
    if (!p.inStock) throw fail("A product in your cart is out of stock");
    rows.push({ productId: p.id, name: p.name, price: p.price, qty, imageUrl: p.imageUrl });
  }
  const subtotal = rows.reduce((n, r) => n + r.price * r.qty, 0);

  let discount = 0;
  let appliedCode = null;
  if (couponCode) {
    const coupon = await getCoupon(String(couponCode).trim().toUpperCase());
    if (!coupon) throw fail("Invalid or inactive coupon code");
    const eligible = rows.reduce(
      (n, r) => (coupon.appliesToAllProducts || coupon.productIds.includes(r.productId) ? n + r.price * r.qty : n), 0);
    if (eligible === 0) throw fail("Coupon not valid for these products");
    discount = Math.round((eligible * coupon.discountPercentage) / 100);
    appliedCode = coupon.code;
  }

  const afterDiscount = Math.max(0, subtotal - discount);
  const ship = await getShipping();
  const shipping = afterDiscount > ship.free ? 0 : ship.fee;
  const total = afterDiscount + shipping;
  if (total < 1) throw fail("Order total is too low");
  return { rows, subtotal, discount, shipping, total, couponCode: appliedCode };
}
