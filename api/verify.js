import crypto from "crypto";
import Razorpay from "razorpay";
import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import { cors, priceCart } from "./_lib/shop.js";

const rzp = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

const DELIVERY_DAYS = 5;

function getDb() {
  if (!getApps().length) {
    initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
  }
  return getFirestore();
}

const fail = (msg) => Object.assign(new Error(msg), { status: 400 });
const clean = (v, max = 200) => String(v ?? "").trim().slice(0, max);

// The part of the order the website needs to show the thank-you page and send emails
function publicOrder(o) {
  return {
    orderNumber: o.orderNumber, customerEmail: o.customerEmail, customerName: o.customerName,
    receiverName: o.receiverName, items: o.items, subtotal: o.subtotal, discount: o.discount,
    shippingCost: o.shippingCost, total: o.total, address: o.address, customerPhone: o.customerPhone,
    altPhone: o.altPhone, utr: o.utr, paymentMethod: o.paymentMethod, paymentStatus: o.paymentStatus,
    couponCode: o.couponCode || "",
  };
}

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, order } = req.body || {};
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature || !order) {
      throw fail("Missing payment details");
    }

    // 1) Check the payment signature
    const expected = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(razorpay_order_id + "|" + razorpay_payment_id)
      .digest("hex");
    const a = Buffer.from(expected);
    const b = Buffer.from(String(razorpay_signature));
    if (!(a.length === b.length && crypto.timingSafeEqual(a, b))) throw fail("Payment could not be verified");

    // 2) Ask Razorpay itself whether this payment is real, and for this order
    const payment = await rzp.payments.fetch(razorpay_payment_id);
    if (payment.order_id !== razorpay_order_id || !["captured", "authorized"].includes(payment.status)) {
      throw fail("Payment is not completed");
    }

    // 3) Work out the order again from your product list; the amount paid must match
    const priced = await priceCart(order.items, order.couponCode);
    if (Number(payment.amount) !== Math.round(priced.total * 100)) throw fail("Amount paid does not match the order");

    // 4) Check the customer details
    const c = order.customer || {};
    const cust = {
      email: clean(c.email), phone: clean(c.phone, 10), fname: clean(c.fname, 60), lname: clean(c.lname, 60),
      address: clean(c.address, 200), apt: clean(c.apt, 100), landmark: clean(c.landmark, 100),
      city: clean(c.city, 80), state: clean(c.state, 60), pin: clean(c.pin, 6), alt: clean(c.alt, 10),
    };
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(cust.email) || !/^[6-9]\d{9}$/.test(cust.phone) ||
        !cust.fname || !cust.address || !cust.city || !cust.state || !/^[1-9]\d{5}$/.test(cust.pin)) {
      throw fail("Delivery details are incomplete");
    }

    // 5) Save the order. One Razorpay order can only ever create one saved order.
    const db = getDb();
    const ref = db.collection("orders").doc("rzp_" + razorpay_order_id);
    const existing = await ref.get();
    if (existing.exists) return res.status(200).json({ verified: true, order: publicOrder(existing.data()) });

    const fullName = (cust.fname + " " + cust.lname).trim();
    const addressText = [
      fullName,
      cust.address + (cust.apt ? ", " + cust.apt : ""),
      cust.landmark ? "Landmark: " + cust.landmark : "",
      `${cust.city}, ${cust.state} - ${cust.pin}`,
    ].filter(Boolean).join("\n");

    const data = {
      orderNumber: "TAN-" + Math.floor(10000 + Math.random() * 89999),
      customerId: clean(order.customerId, 128),
      customerEmail: cust.email, customerName: fullName, receiverName: fullName,
      items: priced.rows, subtotal: priced.subtotal, discount: priced.discount,
      shippingCost: priced.shipping, shippingMethod: "Standard", total: priced.total,
      address: addressText, customerPhone: cust.phone, altPhone: cust.alt,
      shippingAddress: { house: cust.address, street: cust.apt, landmark: cust.landmark, city: cust.city, state: cust.state, pin: cust.pin },
      utr: razorpay_payment_id, paymentMethod: "Razorpay", paymentStatus: "Paid", status: "Placed",
      razorpayOrderId: razorpay_order_id, razorpayPaymentId: razorpay_payment_id,
      createdAt: FieldValue.serverTimestamp(),
      estimatedDeliveryAt: Timestamp.fromDate(new Date(Date.now() + DELIVERY_DAYS * 86400000)),
      deliveredAt: null,
      statusHistory: [{ status: "Placed", timestamp: Timestamp.now() }],
    };
    if (priced.couponCode) data.couponCode = priced.couponCode;

    await ref.create(data);
    return res.status(200).json({ verified: true, order: publicOrder(data) });
  } catch (err) {
    console.error(err);
    const status = err.status || 500;
    return res.status(status).json({ verified: false, error: status === 500 ? "Could not save the order" : err.message });
  }
}
