import Razorpay from "razorpay";
import { cors, priceCart } from "./_lib/shop.js";

const rzp = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { items, couponCode } = req.body || {};
    const p = await priceCart(items, couponCode); // prices always come from Firestore

    const order = await rzp.orders.create({
      amount: Math.round(p.total * 100), // Razorpay uses paise
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
    console.error(err);
    const status = err.status || 500;
    return res.status(status).json({ error: status === 500 ? "Could not create order" : err.message });
  }
}
