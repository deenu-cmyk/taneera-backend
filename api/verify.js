import crypto from "crypto";
import Razorpay from "razorpay";
import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

const ALLOWED_ORIGINS = [
  "https://shop.taneeraa.com",
  "https://www.taneeraa.com",
  "https://taneeraa.com",
  "https://deenu-cmyk.github.io", // old address, remove once the new domain works
];

const rzp = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// Firebase Admin (service account) — can write to Firestore even though the public rules are strict.
function getDb() {
  if (!getApps().length) {
    initializeApp({
      credential: cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
      }),
    });
  }
  return getFirestore();
}

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {};
  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    return res.status(400).json({ verified: false });
  }

  // 1) Check the signature Razorpay gave the customer's browser
  const expected = crypto
    .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
    .update(razorpay_order_id + "|" + razorpay_payment_id)
    .digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(String(razorpay_signature));
  if (!(a.length === b.length && crypto.timingSafeEqual(a, b))) {
    return res.status(200).json({ verified: false });
  }

  try {
    // 2) Ask Razorpay itself for the payment: must belong to this order and be paid
    let payment = await rzp.payments.fetch(razorpay_payment_id);
    if (payment.order_id !== razorpay_order_id) return res.status(200).json({ verified: false });
    if (payment.status === "authorized") {
      payment = await rzp.payments.capture(razorpay_payment_id, payment.amount, payment.currency);
    }
    if (payment.status !== "captured") return res.status(200).json({ verified: false });

    // 3) Record it, so the Firestore rules can accept a "Paid" order for exactly this payment and amount
    await getDb().collection("verifiedPayments").doc(razorpay_payment_id).set({
      orderId: razorpay_order_id,
      amount: Number(payment.amount), // in paise
      currency: payment.currency,
      verifiedAt: FieldValue.serverTimestamp(),
    });
    return res.status(200).json({ verified: true });
  } catch (err) {
    console.error("verify failed:", err);
    return res.status(500).json({ verified: false, error: "Could not verify payment" });
  }
}
