/**
 * PLAYERLY — Order Lookup API
 * ════════════════════════════
 * Vercel Serverless Function
 * 
 * Endpoint: GET /api/order-lookup?order=1001  OR  ?email=cliente@email.com
 * 
 * ENV VARS (set in Vercel dashboard):
 *   SHOPIFY_STORE_DOMAIN  = tu-tienda.myshopify.com
 *   SHOPIFY_ADMIN_TOKEN   = shpat_xxxxxxxxxxxxx
 *   ALLOWED_ORIGINS       = https://playerly.com,https://www.playerly.com  (optional, * for dev)
 * 
 * SETUP:
 *   1. In Shopify Admin → Settings → Apps → Develop apps → Create app
 *   2. Configure Admin API scopes: read_orders
 *   3. Install app → copy Admin API access token
 *   4. Add env vars in Vercel project settings
 *   5. Deploy this file to /api/order-lookup.js in your Vercel project
 *   6. In the Liquid section, set api_proxy_url to your Vercel domain:
 *      https://tu-proyecto.vercel.app/api/order-lookup
 *      OR set up Shopify App Proxy to forward /apps/order-lookup → your Vercel URL
 */

// Simple in-memory rate limiter (per serverless instance)
const rateMap = new Map();
const RATE_LIMIT = 10;       // max requests
const RATE_WINDOW = 60000;   // per 60 seconds

function isRateLimited(ip) {
  const now = Date.now();
  const entry = rateMap.get(ip);
  if (!entry || now - entry.start > RATE_WINDOW) {
    rateMap.set(ip, { start: now, count: 1 });
    return false;
  }
  entry.count++;
  if (entry.count > RATE_LIMIT) return true;
  return false;
}

// CORS headers
function corsHeaders(origin) {
  const allowed = (process.env.ALLOWED_ORIGINS || '*').split(',').map(s => s.trim());
  const isAllowed = allowed.includes('*') || allowed.includes(origin);
  return {
    'Access-Control-Allow-Origin': isAllowed ? origin : allowed[0],
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  };
}

// Sanitize order — strip sensitive data before sending to client
function sanitizeOrder(order) {
  return {
    name: order.name,
    order_number: order.order_number,
    created_at: order.created_at,
    financial_status: order.financial_status,
    fulfillment_status: order.fulfillment_status,
    cancelled_at: order.cancelled_at,
    total_price: order.total_price,
    currency: order.currency,
    fulfillments: (order.fulfillments || []).map(f => ({
      status: f.status,
      shipment_status: f.shipment_status,
      tracking_number: f.tracking_number,
      tracking_numbers: f.tracking_numbers,
      tracking_url: f.tracking_url,
      tracking_urls: f.tracking_urls,
      tracking_company: f.tracking_company,
      created_at: f.created_at,
      updated_at: f.updated_at,
    })),
    line_items: (order.line_items || []).map(item => ({
      title: item.title,
      variant_title: item.variant_title,
      quantity: item.quantity,
      price: item.price,
      image: item.image ? (item.image.src || null) : null,
    })),
  };
}

export default async function handler(req, res) {
  const origin = req.headers.origin || req.headers.referer || '';
  const headers = corsHeaders(origin);

  // Handle preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).setHeader('Access-Control-Allow-Origin', headers['Access-Control-Allow-Origin']).end();
  }

  // Set headers
  Object.entries(headers).forEach(([k, v]) => res.setHeader(k, v));

  // Only GET
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Rate limit
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
  if (isRateLimited(ip)) {
    return res.status(429).json({ error: 'Too many requests. Try again in a minute.' });
  }

  // Validate env
  const { SHOPIFY_STORE_DOMAIN, SHOPIFY_ADMIN_TOKEN } = process.env;
  if (!SHOPIFY_STORE_DOMAIN || !SHOPIFY_ADMIN_TOKEN) {
    console.error('[OrderLookup] Missing SHOPIFY_STORE_DOMAIN or SHOPIFY_ADMIN_TOKEN');
    return res.status(500).json({ error: 'Server misconfigured' });
  }

  // Get params — either order number or email (one is enough)
  const { order, email } = req.query;
  if (!order && !email) {
    return res.status(400).json({ error: 'Missing order or email parameter' });
  }

  const orderNum = order ? order.replace(/^#/, '').trim() : null;
  const emailClean = email ? email.trim().toLowerCase() : null;

  // Input validation
  if (orderNum && !/^\d{1,10}$/.test(orderNum)) {
    return res.status(400).json({ error: 'Invalid order number format' });
  }
  if (emailClean && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailClean)) {
    return res.status(400).json({ error: 'Invalid email format' });
  }

  try {
    let apiUrl;

    if (orderNum) {
      // Search by order number
      apiUrl = `https://${SHOPIFY_STORE_DOMAIN}/admin/api/2024-01/orders.json?name=${encodeURIComponent(orderNum)}&status=any&fields=name,order_number,created_at,email,financial_status,fulfillment_status,cancelled_at,total_price,currency,fulfillments,line_items`;
    } else {
      // Search by email — get most recent order
      apiUrl = `https://${SHOPIFY_STORE_DOMAIN}/admin/api/2024-01/orders.json?email=${encodeURIComponent(emailClean)}&status=any&limit=1&fields=name,order_number,created_at,email,financial_status,fulfillment_status,cancelled_at,total_price,currency,fulfillments,line_items`;
    }

    const shopifyRes = await fetch(apiUrl, {
      headers: {
        'X-Shopify-Access-Token': SHOPIFY_ADMIN_TOKEN,
        'Content-Type': 'application/json',
      },
    });

    if (!shopifyRes.ok) {
      const errText = await shopifyRes.text();
      console.error('[OrderLookup] Shopify API error:', shopifyRes.status, errText);
      return res.status(502).json({ error: 'Could not fetch order data' });
    }

    const data = await shopifyRes.json();
    const orders = data.orders || [];

    // Find order
    let found;
    if (orderNum) {
      // Match by order number
      found = orders.find(o => {
        const num = String(o.order_number);
        const name = (o.name || '').replace(/^#/, '');
        return num === orderNum || name === orderNum;
      });
    } else {
      // Email search: Shopify already filtered, take first result
      found = orders[0] || null;
    }

    if (!found) {
      return res.status(404).json({ error: 'Order not found' });
    }

    // Return sanitized order (no email, no address, no payment info)
    return res.status(200).json({ order: sanitizeOrder(found) });

  } catch (err) {
    console.error('[OrderLookup] Error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
