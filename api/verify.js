import crypto from "crypto";
import Razorpay from "razorpay";
import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { cors, priceCart } from "./_lib/shop.js";

const rzp = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

function getDb() {
  if (!getApps().length) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) throw Object.assign(new Error("Server setup incomplete: FIREBASE_SERVICE_ACCOUNT is missing in Vercel"), { status: 503 });
    let creds;
    try { creds = JSON.parse(raw); }
    catch { throw Object.assign(new Error("Server setup incomplete: FIREBASE_SERVICE_ACCOUNT is not valid JSON"), { status: 503 }); }
    initializeApp({ credential: cert(creds) });
  }
  return getFirestore();
}

const fail = (msg) => Object.assign(new Error(msg), { status: 400 });

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, items, couponCode } = req.body || {};
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature || !items) {
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

    // 3) The amount paid must match the order worked out from your product list
    const priced = await priceCart(items, couponCode);
    if (Number(payment.amount) !== Math.round(priced.total * 100)) throw fail("Amount paid does not match the order");

    // 4) Record the verified payment. Your Firestore rules only let a Paid order be saved
    //    when this record exists for the same payment ID and amount.
    await getDb().collection("verifiedPayments").doc(razorpay_payment_id).set({
      amount: Number(payment.amount),
      razorpayOrderId: razorpay_order_id,
      status: payment.status,
      verifiedAt: FieldValue.serverTimestamp(),
    });

    return res.status(200).json({ verified: true, total: priced.total });
  } catch (err) {
    console.error(err);
    const status = err.status || 500;
    return res.status(status).json({ verified: false, error: status === 500 ? "Could not verify the payment" : err.message });
  }
}
