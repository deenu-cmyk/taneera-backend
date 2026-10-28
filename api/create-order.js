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

// Prices are kept on the server so customers cannot change them.
// Replace these with your real product IDs and prices (in rupees).
const PRICES = {
  "prod-1": 499,
  "prod-2": 799,
};

const FREE_SHIPPING_ABOVE = 999;
const SHIPPING_FEE = 0; // set a fee here if orders below the free-shipping limit should pay shipping

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
    const { items } = req.body || {};
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "Cart is empty" });
    }

    let subtotal = 0;
    for (const item of items) {
      const price = PRICES[item.id];
      const qty = Number(item.qty);
      if (price === undefined || !Number.isInteger(qty) || qty < 1 || qty > 50) {
        return res.status(400).json({ error: "Invalid item in cart" });
      }
      subtotal += price * qty;
    }

    const shipping = subtotal >= FREE_SHIPPING_ABOVE ? 0 : SHIPPING_FEE;
    const total = subtotal + shipping;

    const order = await rzp.orders.create({
      amount: Math.round(total * 100), // Razorpay uses paise
      currency: "INR",
      receipt: "TAN-" + Date.now(),
    });

    return res.status(200).json({
      orderId: order.id,
      amount: order.amount,
      keyId: process.env.RAZORPAY_KEY_ID,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Could not create order" });
  }
}
