// netlify/functions/stripe-webhook.js
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
  TIKTOK_API_KEY,
  TIKTOK_ACCESS_TOKEN,
  TIKTOK_PIXEL,
  TIKTOK_TEST_EVENT_CODE,

  // Optional Stripe custom field "key" for language
  LANGUAGE_FIELD_KEY,

  // Meta
  META_PIXEL,
  META_ACCESS_TOKEN,
  META_TEST_EVENT_CODE
} = process.env;

const stripe = new Stripe(STRIPE_API_KEY, { apiVersion: '2024-06-20' });

// --- Admin + bail config
const ADMIN_EMAIL_FOR_BAIL = 'wonderlang.thegame@gmail.com';
const ML_BAILED_GROUP_ID = '158395915765286796';

// --- Payment Link mapping (live + test)
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

// --- Robust normalization + aliasing
function norm(s) {
  return String(s || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

const LANG_ALIASES = {
  [PRODUCT.FR]: ['fr', 'fra', 'fr-fr', 'french', 'francais', 'français'],
  [PRODUCT.ES]: ['es', 'spa', 'es-es', 'spanish', 'espanol', 'español', 'castellano'],
  [PRODUCT.DE]: ['de', 'deu', 'ger', 'de-de', 'german', 'deutsch'],
  [PRODUCT.PT]: ['pt', 'por', 'pt-pt', 'pt-br', 'portuguese', 'portugues', 'português'],
  [PRODUCT.IT]: ['it', 'ita', 'it-it', 'italian', 'italiano'],
  [PRODUCT.KO]: ['ko', 'kor', 'ko-kr', 'korean', 'hangul', 'hangeul', '한국어', '한글', '조선말'],
  [PRODUCT.JA]: ['ja', 'jpn', 'ja-jp', 'japanese', 'nihongo', 'にほんご', '日本語', 'にっぽんご']
};

function resolveLanguageToProduct(raw) {
  const n = norm(raw);
  if (!n) return null;

  // Alias hits
  for (const [prod, aliases] of Object.entries(LANG_ALIASES)) {
    if (aliases.includes(n)) return prod;
  }

  // Substring hybrids like "Japanese / 日本語"
  for (const [prod, aliases] of Object.entries(LANG_ALIASES)) {
    if (aliases.some(a => a.length >= 2 && n.includes(a))) return prod;
  }

  // Exact canonical name
  if (LANGUAGE_TO_PRODUCT[raw]) return LANGUAGE_TO_PRODUCT[raw];

  return null;
}

function inferFromSessionLocale(locale) {
  const n = norm(locale);
  if (!n) return null;
  if (n.startsWith('fr')) return PRODUCT.FR;
  if (n.startsWith('es')) return PRODUCT.ES;
  if (n.startsWith('de')) return PRODUCT.DE;
  if (n.startsWith('pt')) return PRODUCT.PT;
  if (n.startsWith('it')) return PRODUCT.IT;
  if (n.startsWith('ko')) return PRODUCT.KO;
  if (n.startsWith('ja')) return PRODUCT.JA;
  return null;
}

function inferFromNameLike(s) {
  const n = norm(s);
  if (!n) return null;
  if (/japan|nihon|nihongo|日本語|にほんご/.test(n)) return PRODUCT.JA;
  if (/korea|hangul|hangeul|한국어|한글|조선말/.test(n)) return PRODUCT.KO;
  if (/french|francais|français/.test(n)) return PRODUCT.FR;
  if (/spanish|espanol|español|castellano/.test(n)) return PRODUCT.ES;
  if (/german|deutsch/.test(n)) return PRODUCT.DE;
  if (/portuguese|portugues|português/.test(n)) return PRODUCT.PT;
  if (/italian|italiano/.test(n)) return PRODUCT.IT;
  return null;
}

function extractAllCustomFieldValues(cfs) {
  const out = [];
  if (!Array.isArray(cfs)) return out;
  for (const f of cfs) {
    const key = f?.key || null;
    const label = f?.label || null;
    const type = f?.type || (f?.text ? 'text' : f?.dropdown ? 'dropdown' : null);
    const val = (f?.text && f.text.value) || (f?.dropdown && f.dropdown.value) || null;
    out.push({ key, label, value: val, type });
  }
  return out;
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

// Append buyer email to Bailed!A:A
async function appendBailedEmailToSheet(email) {
  try {
    const sheets = await getSheets();
    await sheets.spreadsheets.values.append({
      spreadsheetId: GOOGLE_SHEETS_ID,
      range: 'Bailed!A:A',
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [[email]] }
    });
    console.log('bailed: appended to sheet', { email });
  } catch (e) {
    console.error('bailed: sheet append error', e.message);
  }
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

  // Idempotency
  for (let i = 0; i < rows.length; i++) {
    const existingSession = rows[i][3];
    if (existingSession === sessionId) {
      const k = rows[i][0];
      console.log('sheets: already assigned; returning existing key', { row: i + 2, key: k });
      return { key: k };
    }
  }

  // First free row
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

// Optional: try to fetch subscriber and reuse their IP
async function lookupMailerLiteIp(email) {
  if (!MAILERLITE_API_KEY) return null;
  try {
    const res = await fetch(`https://connect.mailerlite.com/api/subscribers/${encodeURIComponent(email)}`, {
      headers: { 'Authorization': `Bearer ${MAILERLITE_API_KEY}`, 'Accept': 'application/json' }
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

// Bail notifier: set admin field and add to group
async function notifyBailAdmin({ buyerEmail }) {
  if (!MAILERLITE_API_KEY) {
    console.warn('bailed: no ML key so admin notify skipped');
    return;
  }
  const api = 'https://connect.mailerlite.com/api';
  try {
    // 1) Update admin subscriber custom field `bailed_email`
    const payload = {
      email: ADMIN_EMAIL_FOR_BAIL,
      fields: { bailed_email: buyerEmail }
    };
    const patch = await fetch(`${api}/subscribers/${encodeURIComponent(ADMIN_EMAIL_FOR_BAIL)}`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${MAILERLITE_API_KEY}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify(payload)
    });
    const ptxt = await patch.text().catch(() => '');
    console.log('bailed: ML admin patch', { status: patch.status, ok: patch.ok, preview: ptxt.slice(0, 120) });

    // 2) Add admin to the bail group so your automation triggers
    const add = await fetch(`${api}/groups/${ML_BAILED_GROUP_ID}/subscribers`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${MAILERLITE_API_KEY}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({ email: ADMIN_EMAIL_FOR_BAIL })
    });
    const atxt = await add.text().catch(() => '');
    console.log('bailed: ML add-to-group', { status: add.status, ok: add.ok, preview: atxt.slice(0, 120) });
  } catch (e) {
    console.error('bailed: ML notify error', e.message);
  }
}

const META_ENDPOINT = (pixel) => `https://graph.facebook.com/v20.0/${pixel}/events`;

function cleanForHash(s) { return String(s || '').trim(); }
function sha256LowerRaw(s) {
  return crypto.createHash('sha256').update(cleanForHash(s).toLowerCase()).digest('hex');
}

async function sendMetaPurchase({ session, email, product, ip, url, phone, fbc, fbp, contentName }) {
  if (!META_PIXEL || !META_ACCESS_TOKEN) {
    console.log('meta: missing token or pixel; skipping');
    return false;
  }
  const sessionTotal = typeof session.amount_total === 'number' ? session.amount_total / 100 : null;
  const { unitPrice, currency: liCurrency, name: liName } = await getLineItemInfo(session.id);
  const value = sessionTotal ?? unitPrice ?? 15;
  const currency = (session.currency || liCurrency || 'USD').toUpperCase();
  const price = unitPrice ?? value;
  const contentNameFinal = contentName || liName || product;

  const user_data = {
    em: sha256LowerRaw(email),
    ph: phone ? sha256LowerRaw(phone) : undefined,
    external_id: session.customer ? sha256LowerRaw(session.customer) : undefined,
    client_ip_address: ip || undefined,
    fbp: fbp || undefined,
    fbc: fbc || undefined
  };

  const custom_data = {
    currency,
    value,
    content_type: 'product',
    content_ids: [product],
    content_name: contentNameFinal,
    contents: [{ id: product, quantity: 1, item_price: price }]
  };

  const ev = {
    event_name: 'Purchase',
    event_time: Math.floor(Date.now() / 1000),
    action_source: 'website',
    event_source_url: url || undefined,
    event_id: session.id,
    user_data,
    custom_data
  };

  const body = { data: [ev], test_event_code: META_TEST_EVENT_CODE || undefined };

  console.log('meta: sending', {
    event_id: ev.event_id,
    value: custom_data.value,
    currency: custom_data.currency,
    has_ip: !!user_data.client_ip_address,
    has_fbp: !!user_data.fbp,
    has_fbc: !!user_data.fbc
  });

  const res = await fetch(`${META_ENDPOINT(META_PIXEL)}?access_token=${encodeURIComponent(META_ACCESS_TOKEN)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify(body)
  });

  const text = await res.text().catch(() => '');
  console.log('meta: response', { status: res.status, ok: res.ok, len: text.length, preview: text.slice(0, 200) });
  return res.ok;
}

// --- Stripe helpers
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

// --- TikTok Events API
const TIKTOK_TOKEN = TIKTOK_ACCESS_TOKEN || TIKTOK_API_KEY;
const TIKTOK_ENDPOINT = 'https://business-api.tiktok.com/open_api/v1.3/event/track/';
function sha256Lower(s) {
  return crypto.createHash('sha256').update(String(s || '').trim().toLowerCase()).digest('hex');
}

async function sendTikTokEvent({ session, email, product, ip, url, phone, ttclid, ttp, contentName }) {
  if (!TIKTOK_TOKEN || !TIKTOK_PIXEL) {
    console.log('tiktok: missing token or pixel; skipping');
    return false;
  }

  const sessionTotal = typeof session.amount_total === 'number' ? session.amount_total / 100 : null;
  const { unitPrice, currency: liCurrency, name: liName } = await getLineItemInfo(session.id);
  const value = sessionTotal ?? unitPrice ?? 15;
  const currency = (session.currency || liCurrency || 'USD').toUpperCase();
  const price = unitPrice ?? value;
  const contentNameFinal = contentName || liName || product;

  const eventObj = {
    event: 'Purchase',
    event_id: session.id,
    event_time: Math.floor(Date.now() / 1000),
    user: {
      email: sha256Lower(email),
      phone: phone ? sha256Lower(phone) : undefined,
      external_id: session.customer ? sha256Lower(session.customer) : undefined,
      ip: ip || undefined,
      ttclid: ttclid || undefined,
      ttp: ttp || undefined
    },
    properties: {
      value,
      currency,
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

// --- Bail error class
class BailError extends Error {
  constructor(message, buyerEmail) {
    super(message);
    this.name = 'BailError';
    this.buyerEmail = buyerEmail || null;
  }
}

// --- Robust product routing
async function productFromSession(session) {
  const pl = session.payment_link;
  const cfs = Array.isArray(session.custom_fields) ? session.custom_fields : [];
  const allFields = extractAllCustomFieldValues(cfs);

  // 1) Explicit metadata first
  const metaLang = session?.metadata?.language || session?.metadata?.lang || null;
  let resolved = resolveLanguageToProduct(metaLang);

  // 2) Custom field by configured key
  if (!resolved && allFields.length) {
    const byKey = allFields.find(f => String(f.key || '').toLowerCase() === LANGUAGE_FIELD_KEY_LC);
    if (byKey) resolved = resolveLanguageToProduct(byKey.value);
    console.log('lang via custom_field by key', { key: byKey?.key || null, value: byKey?.value || null, resolved });
  }

  // 3) Scan every custom field
  if (!resolved && allFields.length) {
    for (const f of allFields) {
      const r = resolveLanguageToProduct(f.value);
      if (r) { resolved = r; break; }
    }
    console.log('lang via any custom_field', { fields: allFields, resolved });
  }

  // 4) Fallback to line item name
  if (!resolved) {
    try {
      const { name } = await getLineItemInfo(session.id);
      resolved = inferFromNameLike(name);
      if (resolved) console.log('lang via line item name', { name, resolved });
    } catch {}
  }

  // 5) Fallback to session.locale
  if (!resolved) {
    resolved = inferFromSessionLocale(session?.locale);
    if (resolved) console.log('lang via session.locale', { locale: session?.locale, resolved });
  }

  // Routing decisions
  if (inSet(PAYMENT_LINK.SINGLE_LANGUAGE, pl)) {
    console.log('route: SINGLE_LANGUAGE', { payment_link: pl, resolved, allFields, metaLang });
    if (!resolved) {
      throw new BailError('Language selection missing or unrecognized for SINGLE_LANGUAGE', null);
    }
    return resolved;
  }
  if (inSet(PAYMENT_LINK.POLYGLOT_STEAM, pl)) {
    console.log('route: POLYGLOT_STEAM', { payment_link: pl });
    return PRODUCT.POLY_STEAM;
  }
  if (inSet(PAYMENT_LINK.POLYGLOT_ITCH, pl)) {
    console.log('route: POLYGLOT_ITCH', { payment_link: pl });
    return PRODUCT.POLY_ITCH;
  }

  console.log('route: DEFAULT (no payment_link match)', { payment_link: pl, resolved });
  return resolved || PRODUCT.POLY_STEAM;
}

// --- Main handler
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  // Signature header
  const sig =
    event.headers['stripe-signature'] ||
    event.headers['Stripe-Signature'] ||
    event.headers['STRIPE-SIGNATURE'];

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
    has_custom_fields: Array.isArray(session.custom_fields),
    locale: session.locale || null,
    customer: session.customer || null
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

  try {
    const product = await productFromSession(session);

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

    // Upsert in MailerLite (best effort)
    try {
      const ok = await upsertMailerLite({ email, product, key });
      if (!ok) console.warn('warn: mailerlite upsert not ok');
    } catch (err) {
      console.error('mailerlite error:', err.message);
    }

    // TikTok + Meta (best effort)
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
        contentName: sheetTab
      });

      const fbc = session?.metadata?.fbc || null;
      const fbp = session?.metadata?.fbp || null;
      await sendMetaPurchase({
        session,
        email,
        product,
        ip,
        url,
        phone,
        fbc,
        fbp,
        contentName: sheetTab
      });
    } catch (err) {
      console.error('tiktok/meta error:', err.message);
    }

    console.log('ok: fulfillment complete');
    return { statusCode: 200, body: 'OK' };

  } catch (err) {
    // Handle bail with side effects
    if (err instanceof BailError) {
      console.warn('bailed: single-language language resolution failed');
      try {
        await appendBailedEmailToSheet(email);
      } catch {}
      try {
        await notifyBailAdmin({ buyerEmail: email });
      } catch {}
      return { statusCode: 200, body: 'Bailed' };
    }

    console.error('routing error:', err.message);
    return { statusCode: 200, body: 'Language not recognized for single-language link' };
  }
};
