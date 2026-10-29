import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

// ---- CONFIG: must match checkout.html ----
const PRODUCTS_COLLECTION = "products";
const COUPONS_COLLECTION = "coupons";
const PRICE_FIELD = "sellingPrice"; // checkout.html reads p.sellingPrice

// Shipping (in rupees). Same rule as checkout.html:
// Rs 100, free when the amount after discount is ABOVE Rs 999.
// For flat Rs 100 on every order, set FREE_SHIPPING_ABOVE = 0 here AND in checkout.html.
const SHIPPING_FEE = 100;
const FREE_SHIPPING_ABOVE = 999;
// ------------------------------------------

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
export function clean(v) {
  return String(v || "").trim().replace(/^["']|["']$/g, "");
}

export function getDb() {
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
    data.sellingPrice ??
    data.salePrice ??
    data.offerPrice ??
    data.price ??
    data.amount ??
    data.mrp;
  return Number(String(raw ?? "").replace(/[^0-9.]/g, ""));
}

// Shipping charges are set by the admin (Firestore doc settings/shipping); the constants above are the fallback.
async function getShipping(db) {
  let fee = SHIPPING_FEE, freeAbove = FREE_SHIPPING_ABOVE;
  try {
    const snap = await db.collection("settings").doc("shipping").get();
    if (snap.exists) {
      const d = snap.data();
      if (Number.isFinite(Number(d.fee)) && Number(d.fee) >= 0) fee = Number(d.fee);
      if (Number.isFinite(Number(d.freeAbove)) && Number(d.freeAbove) >= 0) freeAbove = Number(d.freeAbove);
    }
  } catch (e) { console.error("getShipping: using default charges:", e.message); }
  return { fee, freeAbove };
}

function shippingFor(amountAfterDiscount, ship) {
  if (ship.fee <= 0) return 0;
  if (ship.freeAbove > 0 && amountAfterDiscount > ship.freeAbove) return 0;
  return ship.fee;
}

async function findCoupon(db, code) {
  // checkout.html stores the code in a "code" field; also accept the code as the document ID
  const q = await db.collection(COUPONS_COLLECTION).where("code", "==", code).limit(1).get();
  if (!q.empty) return q.docs[0].data();
  const snap = await db.collection(COUPONS_COLLECTION).doc(code).get();
  return snap.exists ? snap.data() : null;
}

export async function priceCart(items, couponCode) {
  if (!Array.isArray(items) || items.length === 0) throw badRequest("Cart is empty");

  const db = getDb();
  let subtotal = 0;
  const lines = [];

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
    lines.push({
      productId: String(id),
      name: data.name || "",
      price,
      qty,
      imageUrl: data.imageUrl || "",
    });
  }

  let discount = 0;
  let appliedCode = null;

  if (couponCode) {
    const code = String(couponCode).trim().toUpperCase();
    const c = await findCoupon(db, code);
    if (!c) throw badRequest("Invalid coupon code");
    if (c.active === false) throw badRequest("This coupon is no longer active");
    if (c.expiresAt && c.expiresAt.toDate && c.expiresAt.toDate() < new Date()) {
      throw badRequest("This coupon has expired");
    }
    if (c.minOrder && subtotal < Number(c.minOrder)) {
      throw badRequest("Order total is too low for this coupon");
    }

    // Percentage coupons (same maths as checkout.html), with fallback to the older type/value format
    const pct =
      c.discountPercentage != null
        ? Number(c.discountPercentage)
        : c.type === "percent"
        ? Number(c.value)
        : null;

    if (pct != null) {
      const ids = Array.isArray(c.productIds) ? c.productIds : [];
      const legacy = c.discountPercentage == null; // older format applies to everything
      const eligible = lines.reduce(
        (n, l) => (legacy || c.appliesToAllProducts || ids.includes(l.productId) ? n + l.price * l.qty : n),
        0
      );
      discount = Math.round((eligible * pct) / 100);
    } else {
      discount = Number(c.value) || 0; // flat amount
    }
    discount = Math.min(Math.max(discount, 0), subtotal);
    appliedCode = code;
  }

  const afterDiscount = subtotal - discount;
  const shipping = shippingFor(afterDiscount, await getShipping(db));
  const total = Math.round((afterDiscount + shipping) * 100) / 100;

  return {
    subtotal: Math.round(subtotal * 100) / 100,
    discount: Math.round(discount * 100) / 100,
    shipping,
    total,
    couponCode: appliedCode,
    lines,
  };
}
