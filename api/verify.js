import crypto from "crypto";
import Razorpay from "razorpay";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { cors, clean, getDb, priceCart } from "./_lib/shop.js";

const DELIVERY_DAYS = 5;
const s = (v, n = 200) => String(v ?? "").trim().slice(0, n);

// Order as the checkout page needs it (no Firestore timestamps)
function publicOrder(d) {
  const { createdAt, estimatedDeliveryAt, deliveredAt, statusHistory, ...rest } = d;
  return rest;
}

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { razorpay_order_id, razorpay_payment_id, razorpay_signature, order: o } = req.body || {};
  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature || !o) {
    return res.status(400).json({ verified: false, error: "Missing details" });
  }

  const keyId = clean(process.env.RAZORPAY_KEY_ID);
  const keySecret = clean(process.env.RAZORPAY_KEY_SECRET);
  if (!keyId || !keySecret) {
    console.error("verify: missing Razorpay env vars");
    return res.status(500).json({ verified: false, error: "Server configuration error" });
  }

  // 1) Signature check
  const expected = crypto
    .createHmac("sha256", keySecret)
    .update(razorpay_order_id + "|" + razorpay_payment_id)
    .digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(String(razorpay_signature));
  if (!(a.length === b.length && crypto.timingSafeEqual(a, b))) {
    console.error("verify: signature mismatch", razorpay_payment_id);
    return res.status(400).json({ verified: false, error: "Signature mismatch" });
  }

  try {
    const db = getDb();

    // 2) Already saved (customer retried)? Return the same order, never a duplicate
    const orderRef = db.collection("orders").doc("rzp_" + razorpay_payment_id);
    const existing = await orderRef.get();
    if (existing.exists) {
      return res.status(200).json({ verified: true, order: publicOrder(existing.data()) });
    }

    // 3) Ask Razorpay itself about the payment
    const rzp = new Razorpay({ key_id: keyId, key_secret: keySecret });
    let payment = await rzp.payments.fetch(razorpay_payment_id);
    if (payment.order_id !== razorpay_order_id) {
      return res.status(400).json({ verified: false, error: "Order mismatch" });
    }

    // 4) Re-price the cart on the server and compare with what was actually paid
    const priced = await priceCart(o.items, o.couponCode);
    if (Math.round(priced.total * 100) !== Number(payment.amount)) {
      console.error("verify: AMOUNT MISMATCH", razorpay_payment_id, "paid", payment.amount, "expected", Math.round(priced.total * 100));
      return res.status(400).json({ verified: false, error: "Amount mismatch" });
    }

    if (payment.status === "authorized") {
      payment = await rzp.payments.capture(razorpay_payment_id, payment.amount, payment.currency);
    }
    if (payment.status !== "captured") {
      console.error("verify: payment not captured, status =", payment.status, razorpay_payment_id);
      return res.status(400).json({ verified: false, error: "Payment not captured" });
    }

    // 5) Save the Paid order (Admin SDK, so Firestore rules do not block it)
    const c = o.customer || {};
    const f = {
      email: s(c.email), phone: s(c.phone, 15), fname: s(c.fname), lname: s(c.lname),
      address: s(c.address, 300), apt: s(c.apt, 200), landmark: s(c.landmark, 200),
      city: s(c.city), state: s(c.state), pin: s(c.pin, 6), alt: s(c.alt, 15),
    };
    const fullName = (f.fname + " " + f.lname).trim();
    const addressText = [
      fullName,
      f.address + (f.apt ? ", " + f.apt : ""),
      f.landmark ? "Landmark: " + f.landmark : "",
      `${f.city}, ${f.state} - ${f.pin}`,
    ].filter(Boolean).join("\n");

    const data = {
      orderNumber: "TAN-" + Math.floor(10000 + Math.random() * 89999),
      customerId: s(o.customerId, 128), customerEmail: f.email, customerName: fullName, receiverName: fullName,
      items: priced.lines, subtotal: priced.subtotal, discount: priced.discount,
      shippingCost: priced.shipping, shippingMethod: "Standard", total: priced.total,
      address: addressText, customerPhone: f.phone, altPhone: f.alt,
      shippingAddress: { house: f.address, street: f.apt, landmark: f.landmark, city: f.city, state: f.state, pin: f.pin },
      utr: razorpay_payment_id, razorpayOrderId: razorpay_order_id,
      paymentMethod: "Razorpay", paymentStatus: "Paid", status: "Placed",
    };
    if (priced.couponCode && priced.discount) data.couponCode = priced.couponCode;

    await orderRef.set({
      ...data,
      createdAt: FieldValue.serverTimestamp(),
      estimatedDeliveryAt: Timestamp.fromDate(new Date(Date.now() + DELIVERY_DAYS * 86400000)),
      deliveredAt: null,
      statusHistory: [{ status: "Placed", timestamp: Timestamp.now() }],
    });

    await db.collection("verifiedPayments").doc(razorpay_payment_id).set({
      orderId: razorpay_order_id, amount: Number(payment.amount), currency: payment.currency,
      verifiedAt: FieldValue.serverTimestamp(),
    });

    return res.status(200).json({ verified: true, order: data });
  } catch (err) {
    console.error("verify failed:", err);
    return res.status(500).json({ verified: false, error: "Could not verify payment" });
  }
}
