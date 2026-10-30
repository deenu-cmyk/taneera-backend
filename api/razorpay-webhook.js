import crypto from "crypto";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { clean, getDb } from "./_lib/shop.js";

// Razorpay signs the RAW request body, so Vercel must not parse it first
export const config = { api: { bodyParser: false } };

function readRaw(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const secret = clean(process.env.RAZORPAY_WEBHOOK_SECRET);
  if (!secret) {
    console.error("webhook: RAZORPAY_WEBHOOK_SECRET is missing");
    return res.status(500).json({ error: "Server configuration error" });
  }

  const raw = await readRaw(req);

  // 1) Check the signature, so only Razorpay can write to your admin data
  const expected = crypto.createHmac("sha256", secret).update(raw).digest("hex");
  const given = String(req.headers["x-razorpay-signature"] || "");
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  if (!(a.length === b.length && crypto.timingSafeEqual(a, b))) {
    console.error("webhook: bad signature");
    return res.status(400).json({ error: "Invalid signature" });
  }

  let event;
  try {
    event = JSON.parse(raw.toString("utf8"));
  } catch {
    return res.status(400).json({ error: "Invalid JSON" });
  }

  try {
    const db = getDb();
    const name = event.event || "";
    const payload = event.payload || {};

    // 2) Payment events: payment.authorized / captured / failed
    const p = payload.payment && payload.payment.entity;
    if (p && p.id) {
      const data = {
        paymentId: p.id,
        razorpayOrderId: p.order_id || "",
        orderDocId: "rzp_" + p.id, // the order that verify.js saves in the "orders" collection
        amount: Number(p.amount || 0) / 100, // rupees
        amountPaise: Number(p.amount || 0),
        currency: p.currency || "INR",
        status: p.status || "",
        method: p.method || "",
        email: p.email || "",
        contact: p.contact || "",
        vpa: p.vpa || "",
        bank: p.bank || "",
        wallet: p.wallet || "",
        cardLast4: (p.card && p.card.last4) || "",
        cardNetwork: (p.card && p.card.network) || "",
        fee: Number(p.fee || 0) / 100,
        tax: Number(p.tax || 0) / 100,
        errorCode: p.error_code || "",
        errorDescription: p.error_description || "",
        lastEvent: name,
        paidAt: p.created_at ? Timestamp.fromMillis(p.created_at * 1000) : null,
        updatedAt: FieldValue.serverTimestamp(),
      };
      // merge: true, so repeated or out-of-order events never create duplicates
      await db.collection("razorpayPayments").doc(p.id).set(data, { merge: true });
    }

    // 3) Refund events
    const r = payload.refund && payload.refund.entity;
    if (r && r.payment_id) {
      await db.collection("razorpayPayments").doc(r.payment_id).set(
        {
          refundId: r.id,
          refundAmount: Number(r.amount || 0) / 100,
          refundStatus: r.status || "",
          lastEvent: name,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("webhook failed:", err);
    // 500 makes Razorpay retry the event later
    return res.status(500).json({ error: "Could not record payment" });
  }
}
