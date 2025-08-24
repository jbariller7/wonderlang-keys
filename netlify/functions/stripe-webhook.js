// netlify/functions/stripe-webhook.js
const Stripe = require('stripe');
const { google } = require('googleapis');

// --- ENV (from Netlify > Site configuration > Environment variables)
const {
  STRIPE_API_KEY,
  STRIPE_WEBHOOK_SECRET,
  GOOGLE_SHEETS_ID,
  GOOGLE_SA_EMAIL,
  GOOGLE_SA_PRIVATE_KEY,

  // MailerLite
  MAILERLITE_API_KEY,
  ML_FIELD_STEAM_KEY, // e.g. steam_key
  ML_FIELD_ITCH_KEY,  // e.g. itch_key
  ML_GROUPS_ALL,
  ML_GROUPS_FR, ML_GROUPS_ES, ML_GROUPS_DE, ML_GROUPS_PT, ML_GROUPS_IT, ML_GROUPS_KO, ML_GROUPS_JA,
  ML_GROUPS_POLY_STEAM, ML_GROUPS_POLY_ITCH
} = process.env;

const stripe = new Stripe(STRIPE_API_KEY, { apiVersion: '2024-06-20' });

// --- Payment Link mapping (include BOTH live and test IDs)
const PAYMENT_LINK = {
  SINGLE_LANGUAGE: [
    'plink_1RoKYZBFbQoDa6p0hCPS3d2g', 'plink_1Rzg6lBFbQoDa6p0bmGphygN'
  ],
  POLYGLOT_STEAM: [
    'plink_1RoLRRBFbQoDa6p0g9zXIJaM', 'plink_1Rzg0NBFbQoDa6p0fL5aVAsU'
  ],
  POLYGLOT_ITCH: [
    'plink_1RoNLzBFbQoDa6p0lvW7lw5f', 'plink_1RoN4QBFbQoDa6p0fQ8Xc3Vs',
    'plink_1Rzg7fBFbQoDa6p0UCIOzCtk'
  ]
};

// --- Product codes
const PRODUCT = {
  FR: 'French', ES: 'Spanish', DE: 'German', PT: 'Portuguese', IT: 'Italian', KO: 'Korean', JA: 'Japanese',
  POLY_STEAM: 'POLY_STEAM',
  POLY_ITCH: 'POLY_ITCH'
};

// --- Map the Stripe custom field value -> product code above
const LANGUAGE_TO_PRODUCT = {
  French: PRODUCT.FR,
  Spanish: PRODUCT.ES,
  German: PRODUCT.DE,
  Portuguese: PRODUCT.PT,
  Italian: PRODUCT.IT,
  Korean: PRODUCT.KO,
  Japanese: PRODUCT.JA
};

// --- Sheet tab names per product
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

// --- Decide product from session (add logs)
function productFromSession(session) {
  const pl = session.payment_link;
  const cfs = Array.isArray(session.custom_fields) ? session.custom_fields : [];
  const langField = cfs.find(f => f.key === 'language');
  const langVal = langField && (langField.text?.value || langField.dropdown?.value);

  if (inSet(PAYMENT_LINK.SINGLE_LANGUAGE, pl)) {
    const mapped = langVal && LANGUAGE_TO_PRODUCT[String(langVal).trim()];
    console.log('route: SINGLE_LANGUAGE', { payment_link: pl, language: langVal, mapped });
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
  console.log('route: DEFAULT (no match for payment_link)', { payment_link: pl });
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

// Each tab columns: A key | B assigned_to_email | C assigned_at_iso | D stripe_session_id | E payment_link_id | F notes
async function findAndAssignKey({ sheetTab, email, sessionId, paymentLinkId }) {
  console.log('sheets: reading tab', sheetTab);
  const sheets = await getSheets();
  const readRange = `${sheetTab}!A2:F`;
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: GOOGLE_SHEETS_ID,
    range: readRange
  });
  const rows = res.data.values || [];
  console.log('sheets: rows read', rows.length);

  // Idempotency: if this session already processed, return that key
  for (let i = 0; i < rows.length; i++) {
    const existingSession = rows[i][3];
    if (existingSession === sessionId) {
      const k = rows[i][0];
      console.log('sheets: already assigned for this session; returning existing key', { row: i + 2, key: k });
      return { key: k };
    }
  }

  // Find first unused row (no assigned_to_email in column B)
  let rowIndex = -1;
  let key = null;
  for (let i = 0; i < rows.length; i++) {
    const k = rows[i][0];
    const assignedEmail = rows[i][1];
    if (k && (!assignedEmail || assignedEmail === '')) {
      rowIndex = i;
      key = k;
      break;
    }
  }

  if (!key) {
    console.warn('sheets: NO FREE KEY in tab', sheetTab);
    return { key: null };
  }

  const when = new Date().toISOString();
  const targetRow = 2 + rowIndex; // actual sheet row number
  const updateRange = `${sheetTab}!B${targetRow}:E${targetRow}`; // write cols B..E
  const values = [[email, when, sessionId, paymentLinkId || '']];

  console.log('sheets: assigning key', { key, row: targetRow, updateRange, email, when, sessionId, paymentLinkId });
  await sheets.spreadsheets.values.update({
    spreadsheetId: GOOGLE_SHEETS_ID,
    range: updateRange,
    valueInputOption: 'RAW',
    requestBody: { values }
  });

  console.log('sheets: assignment complete');
  return { key };
}

// --- Helpers for MailerLite group handling
function envList(name) {
  const v = process.env[name];
  return v ? v.split(',').map(s => s.trim()).filter(Boolean) : [];
}

// Map product -> groups (IDs from env)
function groupsForProduct(product) {
  const common = envList('ML_GROUPS_ALL');
  switch (product) {
    case PRODUCT.FR: return common.concat(envList('ML_GROUPS_FR'));
    case PRODUCT.ES: return common.concat(envList('ML_GROUPS_ES'));
    case PRODUCT.DE: return common.concat(envList('ML_GROUPS_DE'));
    case PRODUCT.PT: return common.concat(envList('ML_GROUPS_PT'));
    case PRODUCT.IT: return common.concat(envList('ML_GROUPS_IT'));
    case PRODUCT.KO: return common.concat(envList('ML_GROUPS_KO'));
    case PRODUCT.JA: return common.concat(envList('ML_GROUPS_JA'));
    case PRODUCT.POLY_STEAM: return common.concat(envList('ML_GROUPS_POLY_STEAM'));
    case PRODUCT.POLY_ITCH: return common.concat(envList('ML_GROUPS_POLY_ITCH'));
    default: return common;
  }
}

// --- Upsert subscriber in MailerLite and set key field (uses Node 18+ global fetch)
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
    // IMPORTANT: pass the raw string body to Stripe
    stripeEvent = stripe.webhooks.constructEvent(
      event.body,
      sig,
      STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('sig fail:', err.message);
    return { statusCode: 400, body: `Webhook signature verification failed: ${err.message}` };
  }

  console.log('ok: event verified', { id: stripeEvent.id, type: stripeEvent.type });

  // Only handle paid sessions
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

  // Read/assign key in Sheets
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
    // Return 500 so Stripe retries; safer than silently dropping fulfillment
    return { statusCode: 500, body: 'Sheets error' };
  }

  if (!key) {
    console.warn('warn: no keys available for', { sheetTab });
    return { statusCode: 200, body: 'No keys available' };
  }

  console.log('ok: got key', { product, sheetTab, keyPreview: String(key).slice(0, 4) + '...' });

  // Upsert subscriber in MailerLite
  try {
    const ok = await upsertMailerLite({ email, product, key });
    if (!ok) console.warn('warn: mailerlite upsert not ok');
  } catch (err) {
    console.error('mailerlite error:', err.message);
    // Do NOT throw; key is already consumed. We acknowledge to avoid duplicate key assignment.
  }

  console.log('ok: fulfillment complete');
  return { statusCode: 200, body: 'OK' };
};
