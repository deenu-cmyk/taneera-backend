import Razorpay from "razorpay";

const rzp = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

const ALLOWED_ORIGINS = [
  "https://shop.taneeraa.com",
  "https://www.taneeraa.com",
  "https://taneeraa.com",
  "https://deenu-cmyk.github.io", // old address, remove once the new domain works
];

// Your Firebase project ID (set it in Vercel as FIREBASE_PROJECT_ID)
const PROJECT_ID = process.env.FIREBASE_PROJECT_ID;
const FS = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;

// Reads a number out of a Firestore REST field
function numVal(f) {
  if (!f) return NaN;
  if (f.integerValue !== undefined) return Number(f.integerValue);
  if (f.doubleValue !== undefined) return Number(f.doubleValue);
  if (f.stringValue !== undefined) return Number(f.stringValue);
  return NaN;
}

async function getProduct(id) {
  const r = await fetch(`${FS}/products/${encodeURIComponent(id)}`);
  if (!r.ok) return null;
  const f = (await r.json()).fields || {};
  const price = numVal(f.sellingPrice);
  const stock = numVal(f.stock);
  const status = f.status && f.status.stringValue;
  const inStock = status !== "Out of Stock" && stock > 0; // same rule as your website
  if (!Number.isFinite(price) || price < 0) return null;
  return { id, price, inStock };
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

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { items, couponCode } = req.body || {};
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "Cart is empty" });
    }

    // Prices always come from Firestore, never from the browser
    const rows = [];
    for (const item of items) {
      const qty = Number(item.qty);
      if (!item.id || !Number.isInteger(qty) || qty < 1 || qty > 50) {
        return res.status(400).json({ error: "Invalid item in cart" });
      }
      const p = await getProduct(String(item.id));
      if (!p) return res.status(400).json({ error: "Product not found" });
      if (!p.inStock) return res.status(400).json({ error: "A product in your cart is out of stock" });
      rows.push({ id: p.id, price: p.price, qty });
    }

    const subtotal = rows.reduce((n, r) => n + r.price * r.qty, 0);

    // Coupon: same rule as your website (percentage off eligible items only)
    let discount = 0;
    let appliedCode = null;
    if (couponCode) {
      const coupon = await getCoupon(String(couponCode).trim().toUpperCase());
      if (!coupon) return res.status(400).json({ error: "Invalid or inactive coupon code" });
      const eligible = rows.reduce(
        (n, r) => (coupon.appliesToAllProducts || coupon.productIds.includes(r.id) ? n + r.price * r.qty : n),
        0
      );
      if (eligible === 0) return res.status(400).json({ error: "Coupon not valid for these products" });
      discount = Math.round((eligible * coupon.discountPercentage) / 100);
      appliedCode = coupon.code;
    }

    const total = Math.max(0, subtotal - discount);
    if (total < 1) return res.status(400).json({ error: "Order total is too low" });

    const order = await rzp.orders.create({
      amount: Math.round(total * 100), // Razorpay uses paise
      currency: "INR",
      receipt: "TAN-" + Date.now(),
      notes: appliedCode ? { coupon: appliedCode } : {},
    });

    return res.status(200).json({
      orderId: order.id,
      amount: order.amount,
      keyId: process.env.RAZORPAY_KEY_ID,
      subtotal,
      discount,
      total,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Could not create order" });
  }
}
