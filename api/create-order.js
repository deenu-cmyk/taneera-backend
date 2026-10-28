import Razorpay from "razorpay";

const ALLOWED_ORIGINS = [
  "https://shop.taneeraa.com",
  "https://www.taneeraa.com",
  "https://taneeraa.com",
  "https://deenu-cmyk.github.io", // old address, remove once the new domain works
];

export default async function handler(req, res) {
  // CORS first, so every response below carries the headers
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const missing = ["RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET"].filter((k) => !process.env[k]);
    if (missing.length) {
      console.error("create-order: missing env vars:", missing.join(", "));
      return res.status(500).json({ error: "Server configuration error" });
    }

    const { items, couponCode } = req.body || {};
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "Cart is empty" });
    }

    // Imported here so a problem in shop.js is logged instead of crashing the function on load
    const { priceCart } = await import("./_lib/shop.js");
    const p = await priceCart(items, couponCode); // prices always come from Firestore

    const amount = Math.round(p.total * 100); // Razorpay uses paise
    if (!Number.isFinite(amount) || amount < 100) {
      return res.status(400).json({ error: "Invalid order total" });
    }

    const rzp = new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET,
    });

    const order = await rzp.orders.create({
      amount,
      currency: "INR",
      receipt: "TAN-" + Date.now(),
      notes: p.couponCode ? { coupon: p.couponCode } : {},
    });

    return res.status(200).json({
      orderId: order.id,
      amount: order.amount,
      keyId: process.env.RAZORPAY_KEY_ID,
      subtotal: p.subtotal,
      discount: p.discount,
      shipping: p.shipping,
      total: p.total,
    });
  } catch (err) {
    console.error("create-order failed:", err?.error || err);
    // Errors thrown by priceCart (bad coupon, unknown product) may carry a 4xx status.
    // Razorpay's SDK uses statusCode instead, and its messages shouldn't go to customers.
    const status = Number.isInteger(err?.status) ? err.status : 500;
    return res.status(status).json({
      error: status >= 500 ? "Could not create order" : err.message,
    });
  }
}
