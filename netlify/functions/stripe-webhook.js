// netlify/functions/stripe-webhook.js test
const Stripe = require('stripe');
const { google } = require('googleapis');
const crypto = require('crypto');

// --- ENV
const {
  // Stripe + Google
  STRIPE_API_KEY,
  STRIPE_WEBHOOK_SECRET,
  GOOGLE_SHEETS_ID,
  GOOGLE_SA_EMAIL,
  GOOGLE_SA_PRIVATE_KEY,

  // MailerLite
  MAILERLITE_API_KEY,
  ML_FIELD_STEAM_KEY,
  ML_FIELD_ITCH_KEY,
  ML_GROUPS_ALL,
  ML_GROUPS_FR, ML_GROUPS_ES, ML_GROUPS_DE, ML_GROUPS_PT, ML_GROUPS_IT, ML_GROUPS_KO, ML_GROUPS_JA,
  ML_GROUPS_POLY_STEAM, ML_GROUPS_POLY_ITCH,

  // TikTok
  TIKTOK_API_KEY,           // Access Token (alias supported below)
  TIKTOK_ACCESS_TOKEN,
  TIKTOK_PIXEL,             // Pixel ID
  TIKTOK_TEST_EVENT_CODE,   // optional for Test Events
  LANGUAGE_FIELD_KEY        // optional: Stripe custom field "key" for language
} = process.env;

const stripe = new Stripe(STRIPE_API_KEY, { apiVersion: '2024-06-20' });

// --- Payment Link mapping (include BOTH live and test IDs)
const PAYMENT_LINK = {
  SINGLE_LANGUAGE: [
    'plink_1RoKYZBFbQoDa6p0hCPS3d2g', 'plink_1Rzg6lBFbQoDa6p0bmGphygN', 'plink_1RvKx8BFbQoDa6p0PaVih8U5'
  ],
  POLYGLOT_STEAM: [
    'plink_1RoLRRBFbQoDa6p0g9zXIJaM', 'plink_1Rzg0NBFbQoDa6p0fL5aVAsU', 'plink_1RvL4VBFbQoDa6p09A00tNAR'
  ],
  POLYGLOT_ITCH: [
    'plink_1RoNLzBFbQoDa6p0lvW7lw5f', 'plink_1RoN4QBFbQoDa6p0fQ8Xc3Vs', 'plink_1S2w5eBFbQoDa6p06bwPV6Hp',
    'plink_1Rzg7fBFbQoDa6p0UCIOzCtk', 'plink_1S2wD2BFbQoDa6p0w2tvZNiG'
  ]
};

// --- Product codes
const PRODUCT = {
  FR: 'French', ES: 'Spanish', DE: 'German', PT: 'Portuguese', IT: 'Italian', KO: 'Korean', JA: 'Japanese',
  POLY_STEAM: 'POLY_STEAM',
  POLY_ITCH: 'POLY_ITCH'
};

const LANGUAGE_TO_PRODUCT = {
  French: PRODUCT.FR, Spanish: PRODUCT.ES, German: PRODUCT.DE, Portuguese: PRODUCT.PT,
  Italian: PRODUCT.IT, Korean: PRODUCT.KO, Japanese: PRODUCT.JA
};

const SHEET_TAB_BY_PRODUCT = {
  [PRODUCT.FR]: 'French Steam',
  [PRODUCT.ES]: 'Spanish Steam',
  [PRODUCT.DE]: 'German Steam',
  [PRODUCT.PT]: 'Portuguese Steam',
  [PRODUCT.IT]: 'Italian Steam',
  [PRODUCT.KO]: 'Korean Steam',
  [PRODUCT.JA]: 'Japanese Steam',
  [PRODUCT.POLY_STEAM]: 'Polyglot Steam',
  [PRODUCT.POLY_ITCH]: 'Polyglot Itch'
};

const inSet = (arr, id) => Array.isArray(arr) && arr.includes(id);
const LANGUAGE_FIELD_KEY_LC = (LANGUAGE_FIELD_KEY || 'language').toLowerCase();

// ---- Decide product from session (reads your custom field even if label != key)
function productFromSession(session) {
  const pl = session.payment_link;
  const cfs = Array.isArray(session.custom_fields) ? session.custom_fields : [];

  const valueOf = (f) => (f?.text && f.text.value) || (f?.dropdown && f.dropdown.value) || null;
  const langField =
    cfs.find(f => String(f.key || '').toLowerCase() === LANGUAGE_FIELD_KEY_LC) || cfs[0] || null;

  const val = langField ? String(valueOf(langField) || '').trim() : null;

  const LANG_TO_PRODUCT_LC = {
    french: PRODUCT.FR, spanish: PRODUCT.ES, german: PRODUCT.DE,
    portuguese: PRODUCT.PT, italian: PRODUCT.IT, korean: PRODUCT.KO, japanese: PRODUCT.JA
  };
  const mapped =
    (val && LANGUAGE_TO_PRODUCT[val]) ||
    (val && LANG_TO_PRODUCT_LC[val.toLowerCase()]) ||
    null;

  if (inSet(PAYMENT_LINK.SINGLE_LANGUAGE, pl)) {
    console.log('route: SINGLE_LANGUAGE', {
      payment_link: pl, chosenLabel: langField?.label || null, keyUsed: langField?.key || null, chosenValue: val, mapped
    });
    return mapped || PRODUCT.FR;
  }
  if (inSet(PAYMENT_LINK.POLYGLOT_STEAM, pl)) {
    console.log('route: POLYGLOT_STEAM', { payment_link: pl });
    return PRODUCT.POLY_STEAM;
  }
  if (inSet(PAYMENT_LINK.POLYGLOT_ITCH, pl)) {
    console.log('route: POLYGLOT_ITCH', { payment_link: pl });
    return PRODUCT.POLY_ITCH;
  }
  console.log('route: DEFAULT (no payment_link match)', { payment_link: pl });
  return PRODUCT.POLY_STEAM;
}

// --- Google Sheets client
async function getSheets() {
  const jwt = new google.auth.JWT(
    GOOGLE_SA_EMAIL,
    undefined,
    (GOOGLE_SA_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    ['https://www.googleapis.com/auth/spreadsheets']
  );
  return google.sheets({ version: 'v4', auth: jwt });
}

// --- Find/assign key in a tab
async function findAndAssignKey({ sheetTab, email, sessionId, paymentLinkId }) {
  console.log('sheets: reading tab', sheetTab);
  const sheets = await getSheets();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: GOOGLE_SHEETS_ID,
    range: `${sheetTab}!A2:F`
  });
  const rows = res.data.values || [];
  console.log('sheets: rows read', rows.length);

  // idempotency
  for (let i = 0; i < rows.length; i++) {
    const existingSession = rows[i][3];
    if (existingSession === sessionId) {
      const k = rows[i][0];
      console.log('sheets: already assigned; returning existing key', { row: i + 2, key: k });
      return { key: k };
    }
  }

  // first free row
  let rowIndex = -1, key = null;
  for (let i = 0; i < rows.length; i++) {
    const k = rows[i][0], assignedEmail = rows[i][1];
    if (k && (!assignedEmail || assignedEmail === '')) { rowIndex = i; key = k; break; }
  }
  if (!key) { console.warn('sheets: NO FREE KEY in tab', sheetTab); return { key: null }; }

  const when = new Date().toISOString();
  const targetRow = 2 + rowIndex;
  const updateRange = `${sheetTab}!B${targetRow}:E${targetRow}`;
  const values = [[email, when, sessionId, paymentLinkId || '']];
  console.log('sheets: assigning key', { key, row: targetRow, updateRange });

  await sheets.spreadsheets.values.update({
    spreadsheetId: GOOGLE_SHEETS_ID,
    range: updateRange,
    valueInputOption: 'RAW',
    requestBody: { values }
  });
  return { key };
}

// --- MailerLite helpers
function envList(name) {
  const v = process.env[name];
  return v ? v.split(',').map(s => s.trim()).filter(Boolean) : [];
}
function groupsForProduct(product) {
  const common = envList('ML_GROUPS_ALL');
  switch (product) {
    case PRODUCT.FR:
    case PRODUCT.ES:
    case PRODUCT.DE:
    case PRODUCT.PT:
    case PRODUCT.IT:
    case PRODUCT.KO:
    case PRODUCT.JA:
    case PRODUCT.POLY_STEAM:
      return common.concat(envList('ML_GROUPS_POLY_STEAM'));
    case PRODUCT.POLY_ITCH:
      return common.concat(envList('ML_GROUPS_POLY_ITCH'));
    default:
      return common;
  }
}
async function upsertMailerLite({ email, product, key }) {
  const api = 'https://connect.mailerlite.com/api';
  const groups = groupsForProduct(product);
  const steamKeyField = ML_FIELD_STEAM_KEY || 'steam_key';
  const itchKeyField  = ML_FIELD_ITCH_KEY  || 'itch_key';
  const fields = {};
  if (product === PRODUCT.POLY_ITCH) fields[itchKeyField] = key;
  else fields[steamKeyField] = key;

  const payload = { email, fields, groups };
  console.log('ml: upsert', { email, product, groups, fields });

  const res = await fetch(`${api}/subscribers`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${MAILERLITE_API_KEY}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  const text = await res.text().catch(() => '');
  console.log('ml: response', { status: res.status, ok: res.ok, len: text.length, preview: text.slice(0, 120) });
  return res.ok;
}
// Optional: try to fetch an existing subscriber and reuse their IP if present
async function lookupMailerLiteIp(email) {
  if (!MAILERLITE_API_KEY) return null;
  try {
    const res = await fetch(`https://connect.mailerlite.com/api/subscribers/${encodeURIComponent(email)}`, {
      headers: {
        'Authorization': `Bearer ${MAILERLITE_API_KEY}`,
        'Accept': 'application/json'
      }
    });
    if (!res.ok) return null;
    const json = await res.json();
    const ip = json?.data?.ip_address || json?.data?.optin_ip || null;
    if (ip) console.log('ml: found subscriber IP', ip);
    return ip || null;
  } catch {
    return null;
  }
}

// --- Stripe helpers for TikTok payload
async function getLineItemInfo(sessionId) {
  try {
    const li = await stripe.checkout.sessions.listLineItems(sessionId, {
      limit: 1,
      expand: ['data.price.product']
    });
    const item = li?.data?.[0];
    if (!item) return {};
    const unitPrice = typeof item.amount_total === 'number'
      ? item.amount_total / 100
      : (item.price?.unit_amount ? item.price.unit_amount / 100 : null);
    const currency = (item.currency || '').toUpperCase() || null;
    const name = item.description || item.price?.product?.name || null;
    return { unitPrice, currency, name };
  } catch (e) {
    console.log('stripe: listLineItems failed', e.message);
    return {};
  }
}
async function getPaymentLinkUrl(paymentLinkId) {
  if (!paymentLinkId) return null;
  try {
    const pl = await stripe.paymentLinks.retrieve(paymentLinkId);
    return pl?.url || null;
  } catch (e) {
    console.log('stripe: retrieve payment link failed', e.message);
    return null;
  }
}
async function getCustomerPhone(session) {
  const phone = session?.customer_details?.phone || null;
  if (phone) return phone;
  if (session.customer) {
    try {
      const cust = await stripe.customers.retrieve(session.customer);
      return cust?.phone || null;
    } catch (e) {
      console.log('stripe: retrieve customer failed', e.message);
    }
  }
  return null;
}

// --- TikTok Events API helpers (always use Purchase)
const TIKTOK_TOKEN = TIKTOK_ACCESS_TOKEN || TIKTOK_API_KEY;
const TIKTOK_ENDPOINT = 'https://business-api.tiktok.com/open_api/v1.3/event/track/'; // v1.3
function sha256Lower(s) {
  return crypto.createHash('sha256').update(String(s || '').trim().toLowerCase()).digest('hex');
}

async function sendTikTokEvent({ session, email, product, ip, url, phone, ttclid, ttp, contentName }) {
  if (!TIKTOK_TOKEN || !TIKTOK_PIXEL) {
    console.log('tiktok: missing token or pixel; skipping');
    return false;
  }

  // Prefer exact amounts; fallback to 15 USD as requested
  const sessionTotal = typeof session.amount_total === 'number' ? session.amount_total / 100 : null;
  const { unitPrice, currency: liCurrency, name: liName } = await getLineItemInfo(session.id);
  const value = sessionTotal ?? unitPrice ?? 15;
  const currency = (session.currency || liCurrency || 'USD').toUpperCase();
  const price = unitPrice ?? value;
  const contentNameFinal = contentName || liName || product;

  // TikTok requires a top-level "data" array with events
  const eventObj = {
    event: 'Purchase',
    event_id: session.id,
    event_time: Math.floor(Date.now() / 1000), // seconds
    user: {
      email: sha256Lower(email),
      phone: phone ? sha256Lower(phone) : undefined,
      external_id: session.customer ? sha256Lower(session.customer) : undefined,
      ip: ip || undefined,
      // user_agent: undefined (not available from Stripe webhook)
      ttclid: ttclid || undefined,
      ttp: ttp || undefined
    },
    properties: {
      value,
      currency,
      // include both a concise set of props and the contents array
      content_id: product,
      content_type: 'product',
      content_name: contentNameFinal,
      price,
      url: url || undefined,
      contents: [{
        content_id: product,
        content_type: 'product',
        content_name: contentNameFinal,
        price,
        quantity: 1
      }]
    }
  };

  const body = {
    event_source: 'web',
    event_source_id: TIKTOK_PIXEL,
    data: [eventObj],
    test_event_code: TIKTOK_TEST_EVENT_CODE || undefined
  };

  console.log('tiktok: sending', {
    event: eventObj.event,
    event_id: eventObj.event_id,
    value: eventObj.properties.value,
    currency: eventObj.properties.currency,
    price: eventObj.properties.price,
    url: eventObj.properties.url,
    has_ip: !!eventObj.user.ip,
    has_ttclid: !!eventObj.user.ttclid,
    has_ttp: !!eventObj.user.ttp
  });

  const res = await fetch(TIKTOK_ENDPOINT, {
    method: 'POST',
    headers: {
      'Access-Token': TIKTOK_TOKEN,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: JSON.stringify(body)
  });

  const text = await res.text().catch(() => '');
  console.log('tiktok: response', { status: res.status, ok: res.ok, len: text.length, preview: text.slice(0, 200) });
  return res.ok;
}

// --- Main handler
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  // Signature header (case-insensitive)
  const sig =
    event.headers['stripe-signature'] ||
    event.headers['Stripe-Signature'] ||
    event.headers['STRIPE-SIGNATURE'];

  // Debug: prove what we received
  console.log('dbg sig present:', !!sig, 'len:', sig ? sig.length : 0);
  console.log('dbg isBase64Encoded:', !!event.isBase64Encoded);
  console.log('dbg body prefix:', (event.body || '').slice(0, 60));
  console.log('dbg whsec prefix:', (process.env.STRIPE_WEBHOOK_SECRET || '').slice(0, 6));

  let stripeEvent;
  try {
    stripeEvent = stripe.webhooks.constructEvent(event.body, sig, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('sig fail:', err.message);
    return { statusCode: 400, body: `Webhook signature verification failed: ${err.message}` };
  }

  console.log('ok: event verified', { id: stripeEvent.id, type: stripeEvent.type });

  if (stripeEvent.type !== 'checkout.session.completed' &&
      stripeEvent.type !== 'checkout.session.async_payment_succeeded') {
    console.log('info: ignored event type', stripeEvent.type);
    return { statusCode: 200, body: 'Ignored' };
  }

  const session = stripeEvent.data.object;
  console.log('session info', {
    id: session.id,
    payment_status: session.payment_status,
    payment_link: session.payment_link,
    has_custom_fields: Array.isArray(session.custom_fields)
  });

  if (session.payment_status !== 'paid') {
    console.log('info: not paid yet');
    return { statusCode: 200, body: 'Not paid yet' };
  }

  const email = session?.customer_details?.email || session?.customer_email || null;
  if (!email) {
    console.warn('warn: no email in session');
    return { statusCode: 200, body: 'No email in session' };
  }

  const product = productFromSession(session);
  const sheetTab = SHEET_TAB_BY_PRODUCT[product];
  console.log('routing decision', { product, sheetTab });
  if (!sheetTab) {
    console.warn('warn: unknown product', { product });
    return { statusCode: 200, body: 'Unknown product' };
  }

  // Assign key
  let key;
  try {
    const r = await findAndAssignKey({
      sheetTab,
      email,
      sessionId: session.id,
      paymentLinkId: session.payment_link || ''
    });
    key = r.key;
  } catch (err) {
    console.error('sheets error:', err.message);
    return { statusCode: 500, body: 'Sheets error' };
  }

  if (!key) {
    console.warn('warn: no keys available for', { sheetTab });
    return { statusCode: 200, body: 'No keys available' };
  }
  console.log('ok: got key', { product, sheetTab, keyPreview: String(key).slice(0, 4) + '...' });

  // Upsert in MailerLite (don’t block if it fails)
  try {
    const ok = await upsertMailerLite({ email, product, key });
    if (!ok) console.warn('warn: mailerlite upsert not ok');
  } catch (err) {
    console.error('mailerlite error:', err.message);
  }

  // TikTok Conversion (best-effort, doesn’t block)
  try {
    const ip = await lookupMailerLiteIp(email); // may be null
    const url = await getPaymentLinkUrl(session.payment_link);
    const phone = await getCustomerPhone(session);
    const ttclid = session?.metadata?.ttclid || null;
    const ttp = session?.metadata?.ttp || null;
    await sendTikTokEvent({
      session,
      email,
      product,
      ip,
      url,
      phone,
      ttclid,
      ttp,
      contentName: sheetTab // e.g. "French Steam"
    });
  } catch (err) {
    console.error('tiktok error:', err.message);
  }

  console.log('ok: fulfillment complete');
  return { statusCode: 200, body: 'OK' };
};



