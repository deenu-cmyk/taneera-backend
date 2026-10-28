import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

// ---- CONFIG: change these to match your Firestore data ----
const PRODUCTS_COLLECTION = "products";
const COUPONS_COLLECTION = "coupons";
const PRICE_FIELD = "price";          // price in rupees
const SHIPPING_FEE = 60;              // flat shipping fee in rupees
const FREE_SHIPPING_ABOVE = 999;      // free shipping when the total reaches this
// ------------------------------------------------------------

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

export async function priceCart(items, couponCode) {
  if (!Array.isArray(items) || items.length === 0) throw badRequest("Cart is empty");

  const db = getDb();
  let subtotal = 0;

  for (const item of items) {
    const qty = Number(item.qty);
    if (!item.id || !Number.isInteger(qty) || qty < 1 || qty > 50) {
      throw badRequest("Invalid cart item");
    }
    const snap = await db.collection(PRODUCTS_COLLECTION).doc(String(item.id)).get();
    if (!snap.exists) throw badRequest("A product in your cart is no longer available");
    const price = Number(snap.data()[PRICE_FIELD]);
    if (!Number.isFinite(price) || price <= 0) throw badRequest("A product has an invalid price");
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
  const shipping = afterDiscount >= FREE_SHIPPING_ABOVE ? 0 : SHIPPING_FEE;
  const total = Math.round((afterDiscount + shipping) * 100) / 100;

  return {
    subtotal: Math.round(subtotal * 100) / 100,
    discount: Math.round(discount * 100) / 100,
    shipping,
    total,
    couponCode: appliedCode,
  };
}
