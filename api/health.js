// TEMPORARY diagnostic page. Upload as api/health.js, open /api/health once, then DELETE this file.
// It shows which settings the server sees (never the secret values) and tries one Firestore read.
import { clean, getDb } from "./_lib/shop.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  const projectId = clean(process.env.FIREBASE_PROJECT_ID);
  const email = clean(process.env.FIREBASE_CLIENT_EMAIL);
  const key = clean(process.env.FIREBASE_PRIVATE_KEY).replace(/\\n/g, "\n");
  const rk = clean(process.env.RAZORPAY_KEY_ID);

  const out = {
    FIREBASE_PROJECT_ID: projectId || "(missing)",
    FIREBASE_CLIENT_EMAIL_belongs_to_project: email.includes("@") ? email.split("@")[1] : "(missing or not an email)",
    FIREBASE_PRIVATE_KEY_has_BEGIN_line: key.includes("BEGIN PRIVATE KEY"),
    FIREBASE_PRIVATE_KEY_has_END_line: key.includes("END PRIVATE KEY"),
    FIREBASE_PRIVATE_KEY_has_line_breaks: key.includes("\n"),
    RAZORPAY_mode: rk.startsWith("rzp_live_") ? "LIVE" : rk.startsWith("rzp_test_") ? "test" : "(missing or wrong)",
  };

  try {
    const snap = await getDb().collection("products").limit(1).get();
    out.firestore_read = "OK (products found: " + snap.size + ")";
  } catch (e) {
    out.firestore_read = "FAILED: code " + (e.code || "?") + " " + String(e.message || e).slice(0, 200);
  }

  res.status(200).json(out);
}
