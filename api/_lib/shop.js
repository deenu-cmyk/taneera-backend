import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

// ---- CONFIG: change these to match your store ----
const PRODUCTS_COLLECTION = "products";
const COUPONS_COLLECTION = "coupons";
const PRICE_FIELD = "price";        // your price field name in Firestore

// Shipping rules (in rupees):
// - Always free:            SHIPPING_FEE = 0
// - Flat fee, e.g. Rs 50:   SHIPPING_FEE = 50, FREE_SHIPPING_ABOVE = 0
// - Free above Rs 500:      SHIPPING_FEE = 50, FREE_SHIPPING_ABOVE = 500
const SHIPPING_FEE = 100;
const FREE_SHIPPING_ABOVE = 0;
// --------------------------------------------------

const ALLOWED_ORIGINS = [
  "https://shop.taneeraa.com",
  "https://www.taneeraa.com",
  "https://taneeraa.com",
  "https://deenu-cmyk.github.io", // old address, remove once the new domain works
];

export function cors(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return true;
  }
  return false;
}

// Removes stray spaces, line breaks and wrapping quotes from env values
function clean(v) {
  return String(v || "").trim().replace(/^["']|["']$/g, "");
}

function getDb() {
  if (!getApps().length) {
    initializeApp({
      credential: cert({
        projectId: clean(process.env.FIREBASE_PROJECT_ID),
        clientEmail: clean(process.env.FIREBASE_CLIENT_EMAIL),
        privateKey: clean(process.env.FIREBASE_PRIVATE_KEY).replace(/\\n/g, "\n"),
      }),
    });
  }
  return getFirestore();
}

function badRequest(message) {
  const e = new Error(message);
  e.status = 400;
  return e;
}

// Finds the price on a product document, whatever it is called or however it is typed
function readPrice(data) {
  const raw =
    data[PRICE_FIELD] ??
    data.salePrice ??
    data.sellingPrice ??
    data.offerPrice ??
    data.amount ??
    data.mrp;
  return Number(String(raw ?? "").replace(/[^0-9.]/g, ""));
}

function shippingFor(amountAfterDiscount) {
  if (SHIPPING_FEE <= 0) return 0;
  if (FREE_SHIPPING_ABOVE > 0 && amountAfterDiscount >= FREE_SHIPPING_ABOVE) return 0;
  return SHIPPING_FEE;
}

export async function priceCart(items, couponCode) {
  if (!Array.isArray(items) || items.length === 0) throw badRequest("Cart is empty");

  const db = getDb();
  let subtotal = 0;

  for (const item of items) {
    const id = item.id ?? item.productId;
    const qty = Number(item.qty ?? item.quantity ?? 1);
    if (!id || !Number.isInteger(qty) || qty < 1 || qty > 50) {
      throw badRequest("Invalid cart item");
    }

    const snap = await db.collection(PRODUCTS_COLLECTION).doc(String(id)).get();
    if (!snap.exists) {
      console.error("priceCart: product not found:", String(id));
      throw badRequest("A product in your cart is no longer available");
    }

    const data = snap.data();
    const price = readPrice(data);
    if (!Number.isFinite(price) || price <= 0) {
      console.error("priceCart: invalid price for", String(id), "fields:", Object.keys(data).join(", "));
      throw badRequest("A product has an invalid price");
    }
    subtotal += price * qty;
  }

  let discount = 0;
  let appliedCode = null;

  if (couponCode) {
    const code = String(couponCode).trim().toUpperCase();
    const snap = await db.collection(COUPONS_COLLECTION).doc(code).get();
    if (!snap.exists) throw badRequest("Invalid coupon code");
    const c = snap.data();
    if (c.active === false) throw badRequest("This coupon is no longer active");
    if (c.expiresAt && c.expiresAt.toDate && c.expiresAt.toDate() < new Date()) {
      throw badRequest("This coupon has expired");
    }
    if (c.minOrder && subtotal < Number(c.minOrder)) {
      throw badRequest("Order total is too low for this coupon");
    }
    discount = c.type === "percent" ? (subtotal * Number(c.value)) / 100 : Number(c.value);
    discount = Math.min(Math.max(discount, 0), subtotal);
    appliedCode = code;
  }

  const afterDiscount = subtotal - discount;
  const shipping = shippingFor(afterDiscount);
  const total = Math.round((afterDiscount + shipping) * 100) / 100;

  return {
    subtotal: Math.round(subtotal * 100) / 100,
    discount: Math.round(discount * 100) / 100,
    shipping,
    total,
    couponCode: appliedCode,
  };
}
