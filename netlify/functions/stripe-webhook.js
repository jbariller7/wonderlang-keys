
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
  ML_GROUPS_FR,
  ML_GROUPS_ES,
  ML_GROUPS_DE,
  ML_GROUPS_PT,
  ML_GROUPS_IT,
  ML_GROUPS_KO,
  ML_GROUPS_JA,
  ML_GROUPS_POLY_STEAM,
  ML_GROUPS_POLY_ITCH,
// MailerLite Extra Fields (BOGO)
  ML_FIELD_EXTRA_STEAM_KEY,
  ML_FIELD_EXTRA_ITCH_KEY,

  // TikTok
  TIKTOK_API_KEY,
  TIKTOK_ACCESS_TOKEN,
  TIKTOK_PIXEL,
  TIKTOK_TEST_EVENT_CODE,

  // Optional Stripe custom field "key" for language
  LANGUAGE_FIELD_KEY,

  // Optional Stripe custom field "key" for play mode
  // (the dropdown "How do you want to play the game?")
  PLAY_MODE_FIELD_KEY,

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
// SINGLE_LANGUAGE: the "single language" offer (with language selector).
// POLYGLOT: any "polyglot" offer.
// All links here are routed using the play mode custom field.
const PAYMENT_LINK = {
  SINGLE_LANGUAGE: [
    'plink_1RoKYZBFbQoDa6p0hCPS3d2g',
    'plink_1Rzg6lBFbQoDa6p0bmGphygN',
    'plink_1RvKx8BFbQoDa6p0PaVih8U5'
  ],
  // These trigger the "Get 2 keys" logic
  BOGO: [
    'plink_1SzYQNBFbQoDa6p0A1WwDTCI', 
    'plink_1SzYjcBFbQoDa6p08zbQWhKF'
  ],
  POLYGLOT: [
    'plink_1RoLRRBFbQoDa6p0g9zXIJaM',
    'plink_1Rzg0NBFbQoDa6p0fL5aVAsU',
    'plink_1RvL4VBFbQoDa6p09A00tNAR',
    'plink_1RoNLzBFbQoDa6p0lvW7lw5f',
    'plink_1RoN4QBFbQoDa6p0fQ8Xc3Vs',
    'plink_1S2w5eBFbQoDa6p06bwPV6Hp',
    'plink_1Rzg7fBFbQoDa6p0UCIOzCtk',
    'plink_1S2wD2BFbQoDa6p0w2tvZNiG',
    // Also add the BOGO links here so they Route correctly as Polyglot products
    'plink_1SzYQNBFbQoDa6p0A1WwDTCI',
    'plink_1SzYjcBFbQoDa6p08zbQWhKF',
    'plink_1T8M50BFbQoDa6p0UWptUJKq',
    'plink_1T8MBhBFbQoDa6p0y9whMizD',
    'plink_1THnvbBFbQoDa6p05T3MWuig',
    'plink_1THnmzBFbQoDa6p0Be0SlvMI'
  ]
};

// --- Product codes
const PRODUCT = {
  FR: 'French',
  ES: 'Spanish',
  DE: 'German',
  PT: 'Portuguese',
  IT: 'Italian',
  KO: 'Korean',
JA: 'Japanese',
  POLY_STEAM: 'POLY_STEAM',
  POLY_ITCH: 'POLY_ITCH',
  ZH: 'Mandarin',
  EN_PREORDER: 'EnglishPreorder'
};
// Play mode
const PLAY_MODE = {
  STEAM: 'STEAM',
  DIRECT: 'DIRECT' // "Direct Download" (mapped to the Itch product)
};

// Helper to normalize language strings
function normalizeLangString(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' '); // collapse whitespace
}

// Map of normalized language strings to products
const LANGUAGE_VALUE_TO_PRODUCT = {
  [normalizeLangString('French')]: PRODUCT.FR,
  [normalizeLangString('Spanish')]: PRODUCT.ES,
  [normalizeLangString('German')]: PRODUCT.DE,
  [normalizeLangString('Italian')]: PRODUCT.IT,
  [normalizeLangString('Portuguese')]: PRODUCT.PT,
  [normalizeLangString('Korean')]: PRODUCT.KO,
  [normalizeLangString('Japanese')]: PRODUCT.JA,
  [normalizeLangString('Mandarin Chinese')]: PRODUCT.ZH,
  [normalizeLangString('English (Pre-Order)')]: PRODUCT.EN_PREORDER
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
  [PRODUCT.POLY_ITCH]: 'Polyglot Itch',
  [PRODUCT.ZH]: 'Mandarin Steam',
  [PRODUCT.EN_PREORDER]: 'English'
};

const inSet = (arr, id) => Array.isArray(arr) && arr.includes(id);

// --- Language helpers

function productFromLanguageValue(value) {
  if (!value) return null;
  const key = normalizeLangString(value);

  // Exact match on our normalized map
  if (LANGUAGE_VALUE_TO_PRODUCT[key]) {
    return LANGUAGE_VALUE_TO_PRODUCT[key];
  }

  // Extra safety: match on substrings in case Stripe appends or alters tokens
  if (key.includes('french')) return PRODUCT.FR;
  if (key.includes('spanish')) return PRODUCT.ES;
  if (key.includes('german')) return PRODUCT.DE;
  if (key.includes('italian')) return PRODUCT.IT;
  if (key.includes('portuguese')) return PRODUCT.PT;
  if (key.includes('korean')) return PRODUCT.KO;
  if (key.includes('japanese')) return PRODUCT.JA;
  if (key.includes('mandarin') || key.includes('chinese')) return PRODUCT.ZH;
  if (key.includes('english') ) return PRODUCT.EN_PREORDER;

  return null;
}

function extractLanguageFromField(f) {
  if (!f) return null;
  const candidates = [];

  // Text field
  if (f.text && typeof f.text.value !== 'undefined' && f.text.value !== null) {
    candidates.push(f.text.value);
  }

  // Dropdown field: selected value plus all option labels and values
  if (f.dropdown) {
    if (typeof f.dropdown.value !== 'undefined' && f.dropdown.value !== null) {
      candidates.push(f.dropdown.value);
    }

    if (Array.isArray(f.dropdown.options)) {
      for (const opt of f.dropdown.options) {
        if (typeof opt.value !== 'undefined' && opt.value !== null) {
          candidates.push(opt.value);
        }
        if (typeof opt.label !== 'undefined' && opt.label !== null) {
          candidates.push(opt.label);
        }
      }
    }
  }

  // Last resort: some integrations might store a plain value at top level
  if (typeof f.value !== 'undefined' && f.value !== null) {
    candidates.push(f.value);
  }

  for (const c of candidates) {
    const p = productFromLanguageValue(c);
    if (p) {
      return { product: p, rawValue: c };
    }
  }
  return null;
}

function getLanguageProductFromCustomFields(session) {
  const cfs = Array.isArray(session.custom_fields) ? session.custom_fields : [];
  if (!cfs.length) {
    console.log('lang: no custom_fields on session');
    return null;
  }

  const normalizeKey = (s) =>
    String(s || '').trim().toLowerCase().replace(/[\s_-]+/g, '');
  const configuredKeyNorm = normalizeKey(LANGUAGE_FIELD_KEY || 'language');

  let chosen = null;

  // 1) Prefer the configured key if we find a matching field
  for (const f of cfs) {
    if (normalizeKey(f.key) === configuredKeyNorm) {
      const got = extractLanguageFromField(f);
      if (got) {
        chosen = { field: f, ...got };
        break;
      }
    }
  }

  // 2) Fallback: try all fields in order for a recognizable language string
  if (!chosen) {
    for (const f of cfs) {
      const got = extractLanguageFromField(f);
      if (got) {
        chosen = { field: f, ...got };
        break;
      }
    }
  }

  console.log('lang from custom_fields', {
    keys: cfs.map((f) => f.key),
    chosenKey: chosen && chosen.field ? chosen.field.key : null,
    rawValue: chosen ? chosen.rawValue : null,
    product: chosen ? chosen.product : null
  });

  return chosen ? chosen.product : null;
}

// --- Play mode helpers ("Steam Key" vs "Direct Download")

function parsePlayMode(raw) {
  const key = normalizeLangString(raw);
  if (!key) return null;
  if (key.includes('steam')) return PLAY_MODE.STEAM;
  if (key.includes('direct')) return PLAY_MODE.DIRECT;
  if (key.includes('itch')) return PLAY_MODE.DIRECT; // safety, in case label mentions Itch
  return null;
}

function extractPlayModeFromField(f) {
  if (!f) return null;
  const candidates = [];

  if (f.text && typeof f.text.value !== 'undefined' && f.text.value !== null) {
    candidates.push(f.text.value);
  }

  if (f.dropdown) {
    if (typeof f.dropdown.value !== 'undefined' && f.dropdown.value !== null) {
      candidates.push(f.dropdown.value);
    }
    if (Array.isArray(f.dropdown.options)) {
      for (const opt of f.dropdown.options) {
        if (typeof opt.value !== 'undefined' && opt.value !== null) {
          candidates.push(opt.value);
        }
        if (typeof opt.label !== 'undefined' && opt.label !== null) {
          candidates.push(opt.label);
        }
      }
    }
  }

  if (typeof f.value !== 'undefined' && f.value !== null) {
    candidates.push(f.value);
  }

  for (const c of candidates) {
    const pm = parsePlayMode(c);
    if (pm) return { playMode: pm, rawValue: c };
  }
  return null;
}

function getPlayModeFromCustomFields(session) {
  const cfs = Array.isArray(session.custom_fields) ? session.custom_fields : [];
  if (!cfs.length) {
    console.log('playMode: no custom_fields on session');
    return null;
  }

  const normalizeKey = (s) =>
    String(s || '').trim().toLowerCase().replace(/[\s_-]+/g, '');
  const configuredKeyNorm = normalizeKey(PLAY_MODE_FIELD_KEY || 'play_mode');

  let chosen = null;

  // 1) Prefer the configured key if we find a matching field
  for (const f of cfs) {
    if (normalizeKey(f.key) === configuredKeyNorm) {
      const got = extractPlayModeFromField(f);
      if (got) {
        chosen = { field: f, ...got };
        break;
      }
    }
  }

  // 2) Fallback: try all fields in order for something that looks like a play mode
  if (!chosen) {
    for (const f of cfs) {
      const got = extractPlayModeFromField(f);
      if (got) {
        chosen = { field: f, ...got };
        break;
      }
    }
  }

  console.log('playMode from custom_fields', {
    keys: cfs.map((f) => f.key),
    chosenKey: chosen && chosen.field ? chosen.field.key : null,
    rawValue: chosen ? chosen.rawValue : null,
    playMode: chosen ? chosen.playMode : null
  });

  return chosen ? chosen.playMode : null;
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

// Append preorder info: email, when, sessionId, paymentLinkId
async function appendPreorderToSheet({ sheetTab, email, sessionId, paymentLinkId }) {
  try {
    const sheets = await getSheets();
    const when = new Date().toISOString();
    await sheets.spreadsheets.values.append({
      spreadsheetId: GOOGLE_SHEETS_ID,
      range: `${sheetTab}!A:D`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: {
        values: [[email, when, sessionId, paymentLinkId || '']]
      }
    });
    console.log('preorder: appended row', { sheetTab, email });
  } catch (e) {
    console.error('preorder: sheet append error', e.message);
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

  // Idempotency: if session already recorded, reuse its key
  for (let i = 0; i < rows.length; i++) {
    const existingSession = rows[i][3];
    if (existingSession === sessionId) {
      const k = rows[i][0];
      console.log('sheets: already assigned; returning existing key', {
        row: i + 2,
        key: k
      });
      return { key: k };
    }
  }

  // First free row (key present, email empty)
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
  return v ? v.split(',').map((s) => s.trim()).filter(Boolean) : [];
}

function groupsForProduct(product, playMode) {
  const common = envList('ML_GROUPS_ALL');
  const steamGroups = envList('ML_GROUPS_POLY_STEAM');
  const directGroups = envList('ML_GROUPS_POLY_ITCH');

  // Prefer play mode based grouping if known
  if (playMode === PLAY_MODE.STEAM) {
    return common.concat(steamGroups);
  }
  if (playMode === PLAY_MODE.DIRECT) {
    return common.concat(directGroups);
  }

  // Fallback to product based mapping
  switch (product) {
    case PRODUCT.FR:
    case PRODUCT.ES:
    case PRODUCT.DE:
    case PRODUCT.PT:
    case PRODUCT.IT:
    case PRODUCT.KO:
    case PRODUCT.JA:
    case PRODUCT.ZH:
    case PRODUCT.POLY_STEAM:
      return common.concat(steamGroups);
   
    case PRODUCT.POLY_ITCH:
      return common.concat(directGroups);
    default:
      return common;
  }
}

async function upsertMailerLite({ email, product, key, extraKey, playMode }) {
  const api = 'https://connect.mailerlite.com/api';
  const groups = groupsForProduct(product, playMode);
  
  // Standard fields
  const steamKeyField = ML_FIELD_STEAM_KEY || 'steam_key';
  const itchKeyField = ML_FIELD_ITCH_KEY || 'itch_key';
  
  // Extra (BOGO) fields
  const extraSteamField = ML_FIELD_EXTRA_STEAM_KEY || 'extra_steam_key';
  const extraItchField = ML_FIELD_EXTRA_ITCH_KEY || 'extra_itch_link';

  const fields = {};

  // 1. Assign Primary Key
  if (key) {
    if (playMode === PLAY_MODE.DIRECT) {
      fields[itchKeyField] = key;
    } else {
      fields[steamKeyField] = key;
    }
  }

  // 2. Assign Extra BOGO Key (if present)
  if (extraKey) {
    if (playMode === PLAY_MODE.DIRECT) {
      fields[extraItchField] = extraKey;
    } else {
      fields[extraSteamField] = extraKey;
    }
  }

const payload = { email, fields, groups };
  console.log('ml: upsert', { email, product, playMode, groups, fields });

  const res = await fetch(`${api}/subscribers`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${MAILERLITE_API_KEY}`,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify(payload)
  });

  const text = await res.text().catch(() => '');
  console.log('ml: response', {
    status: res.status,
    ok: res.ok,
    len: text.length,
    preview: text.slice(0, 120)
  });
  return res.ok;
}

// Optional: try to fetch subscriber and reuse their IP
async function lookupMailerLiteIp(email) {
  if (!MAILERLITE_API_KEY) return null;
  try {
    const res = await fetch(
      `https://connect.mailerlite.com/api/subscribers/${encodeURIComponent(
        email
      )}`,
      {
        headers: {
          Authorization: `Bearer ${MAILERLITE_API_KEY}`,
          Accept: 'application/json'
        }
      }
    );
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
    const patch = await fetch(
      `${api}/subscribers/${encodeURIComponent(ADMIN_EMAIL_FOR_BAIL)}`,
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${MAILERLITE_API_KEY}`,
          'Content-Type': 'application/json',
          Accept: 'application/json'
        },
        body: JSON.stringify(payload)
      }
    );
    const ptxt = await patch.text().catch(() => '');
    console.log('bailed: ML admin patch', {
      status: patch.status,
      ok: patch.ok,
      preview: ptxt.slice(0, 120)
    });

    // 2) Add admin to the bail group so your automation triggers
    const add = await fetch(`${api}/groups/${ML_BAILED_GROUP_ID}/subscribers`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${MAILERLITE_API_KEY}`,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify({ email: ADMIN_EMAIL_FOR_BAIL })
    });
    const atxt = await add.text().catch(() => '');
    console.log('bailed: ML add-to-group', {
      status: add.status,
      ok: add.ok,
      preview: atxt.slice(0, 120)
    });
  } catch (e) {
    console.error('bailed: ML notify error', e.message);
  }
}

// --- Meta (Facebook) helpers

const META_ENDPOINT = (pixel) =>
  `https://graph.facebook.com/v20.0/${pixel}/events`;

function cleanForHash(s) {
  return String(s || '').trim();
}

function sha256LowerRaw(s) {
  return crypto
    .createHash('sha256')
    .update(cleanForHash(s).toLowerCase())
    .digest('hex');
}

async function sendMetaPurchase({
  session,
  email,
  product,
  ip,
  url,
  phone,
  fbc,
  fbp,
  contentName
}) {
  if (!META_PIXEL || !META_ACCESS_TOKEN) {
    console.log('meta: missing token or pixel; skipping');
    return false;
  }
  const sessionTotal =
    typeof session.amount_total === 'number' ? session.amount_total / 100 : null;
  const { unitPrice, currency: liCurrency, name: liName } = await getLineItemInfo(
    session.id
  );
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

  const body = {
    data: [ev],
    test_event_code: META_TEST_EVENT_CODE || undefined
  };

  console.log('meta: sending', {
    event_id: ev.event_id,
    value: custom_data.value,
    currency: custom_data.currency,
    has_ip: !!user_data.client_ip_address,
    has_fbp: !!user_data.fbp,
    has_fbc: !!user_data.fbc
  });

  const res = await fetch(
    `${META_ENDPOINT(META_PIXEL)}?access_token=${encodeURIComponent(
      META_ACCESS_TOKEN
    )}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body)
    }
  );

  const text = await res.text().catch(() => '');
  console.log('meta: response', {
    status: res.status,
    ok: res.ok,
    len: text.length,
    preview: text.slice(0, 200)
  });
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
    const unitPrice =
      typeof item.amount_total === 'number'
        ? item.amount_total / 100
        : item.price?.unit_amount
        ? item.price.unit_amount / 100
        : null;
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
const TIKTOK_ENDPOINT =
  'https://business-api.tiktok.com/open_api/v1.3/event/track/';

function sha256Lower(s) {
  return crypto
    .createHash('sha256')
    .update(String(s || '').trim().toLowerCase())
    .digest('hex');
}

async function sendTikTokEvent({
  session,
  email,
  product,
  ip,
  url,
  phone,
  ttclid,
  ttp,
  contentName
}) {
  if (!TIKTOK_TOKEN || !TIKTOK_PIXEL) {
    console.log('tiktok: missing token or pixel; skipping');
    return false;
  }

  const sessionTotal =
    typeof session.amount_total === 'number' ? session.amount_total / 100 : null;
  const { unitPrice, currency: liCurrency, name: liName } = await getLineItemInfo(
    session.id
  );
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
      contents: [
        {
          content_id: product,
          content_type: 'product',
          content_name: contentNameFinal,
          price,
          quantity: 1
        }
      ]
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
      Accept: 'application/json'
    },
    body: JSON.stringify(body)
  });

  const text = await res.text().catch(() => '');
  console.log('tiktok: response', {
    status: res.status,
    ok: res.ok,
    len: text.length,
    preview: text.slice(0, 200)
  });
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

// --- Robust product routing using language + play mode custom fields

async function productFromSession(session) {
  const pl = session.payment_link;
  const langProduct = getLanguageProductFromCustomFields(session);
  const playMode = getPlayModeFromCustomFields(session);

  // Preorders are driven by the language field and ignore payment link and play mode
 if (langProduct === PRODUCT.EN_PREORDER) {
    console.log('route: PREORDER', { payment_link: pl, langProduct });
    return { product: langProduct, playMode: null };
  }

  if (!playMode) {
    // For normal products, play mode is required
    throw new BailError('Play mode selection missing', null);
  }

  // Single language checkout:
  // - If Steam Key: use language specific Steam product (FR, ES, DE, PT, IT, KO, JA).
  // - If Direct Download: always polyglot Itch, language choice ignored.
  if (inSet(PAYMENT_LINK.SINGLE_LANGUAGE, pl)) {
    if (playMode === PLAY_MODE.STEAM) {
      console.log('route: SINGLE_LANGUAGE + STEAM', { payment_link: pl, langProduct });
      if (!langProduct) {
        throw new BailError(
          'Language selection missing for SINGLE_LANGUAGE Steam',
          null
        );
      }
      return { product: langProduct, playMode };
    } else {
      console.log('route: SINGLE_LANGUAGE + DIRECT => POLY_ITCH', {
        payment_link: pl
      });
      return { product: PRODUCT.POLY_ITCH, playMode };
    }
  }

  // Polyglot checkout:
  // - Steam Key: Polyglot Steam.
  // - Direct Download: Polyglot Itch.
  if (inSet(PAYMENT_LINK.POLYGLOT, pl)) {
    if (playMode === PLAY_MODE.STEAM) {
      console.log('route: POLYGLOT + STEAM', { payment_link: pl });
      return { product: PRODUCT.POLY_STEAM, playMode };
    } else {
      console.log('route: POLYGLOT + DIRECT', { payment_link: pl });
      return { product: PRODUCT.POLY_ITCH, playMode };
    }
  }

  // Fallback: unknown payment link
  console.log('route: DEFAULT', { payment_link: pl, langProduct, playMode });

  if (playMode === PLAY_MODE.STEAM) {
    // Prefer language product if present, otherwise fall back to polyglot steam
    return { product: langProduct || PRODUCT.POLY_STEAM, playMode };
  }

  // Direct Download fallback: polyglot Itch
  return { product: PRODUCT.POLY_ITCH, playMode };
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
  console.log(
    'dbg whsec prefix:',
    (process.env.STRIPE_WEBHOOK_SECRET || '').slice(0, 6)
  );

  let stripeEvent;
  try {
    // If your Netlify site sends base64 bodies, you may need:
    // const body = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
    // stripeEvent = stripe.webhooks.constructEvent(body, sig, STRIPE_WEBHOOK_SECRET);
    stripeEvent = stripe.webhooks.constructEvent(
      event.body,
      sig,
      STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('sig fail:', err.message);
    return {
      statusCode: 400,
      body: `Webhook signature verification failed: ${err.message}`
    };
  }

  console.log('ok: event verified', { id: stripeEvent.id, type: stripeEvent.type });

  if (
    stripeEvent.type !== 'checkout.session.completed' &&
    stripeEvent.type !== 'checkout.session.async_payment_succeeded'
  ) {
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

  const email =
    session?.customer_details?.email || session?.customer_email || null;
  if (!email) {
    console.warn('warn: no email in session');
    return { statusCode: 200, body: 'No email in session' };
  }

  try {
    const { product, playMode } = await productFromSession(session);
    const sheetTab = SHEET_TAB_BY_PRODUCT[product];
    console.log('routing decision', { product, sheetTab, playMode });

    if (!sheetTab) {
      console.warn('warn: unknown product', { product });
      return { statusCode: 200, body: 'Unknown product' };
    }

    // Mandarin and English pre orders:
    // just log the order in the language sheet and do not assign keys or touch MailerLite.
   if (product === PRODUCT.EN_PREORDER) {
      try {
        await appendPreorderToSheet({
          sheetTab,
          email,
          sessionId: session.id,
          paymentLinkId: session.payment_link || ''
        });
        console.log('ok: preorder recorded', { product, sheetTab });
      } catch (err) {
        console.error('preorder sheet error:', err.message);
        return { statusCode: 500, body: 'Preorder sheet error' };
      }
    } else {
      // Normal products (Steam or Direct/Itch): assign a key and sync with MailerLite.
// Normal products (Steam or Direct/Itch): assign a key (or two) and sync with MailerLite.
      let key;
      let extraKey = null;

      try {
        // 1. Fetch First Key
        const r1 = await findAndAssignKey({
          sheetTab,
          email,
          sessionId: session.id,
          paymentLinkId: session.payment_link || ''
        });
        key = r1.key;

        // 2. Check for BOGO and Fetch Second Key
        if (key && inSet(PAYMENT_LINK.BOGO, session.payment_link)) {
          console.log('bogo: fetching extra key...');
          const r2 = await findAndAssignKey({
            sheetTab,
            email,
            // We append _BOGO to the session ID so the sheet treats it as a new row
            sessionId: session.id + '_BOGO', 
            paymentLinkId: session.payment_link || ''
          });
          extraKey = r2.key;
          console.log('bogo: got extra key', { keyPreview: String(extraKey).slice(0, 4) + '...' });
        }

      } catch (err) {
        console.error('sheets error:', err.message);
        return { statusCode: 500, body: 'Sheets error' };
      }

      if (!key) {
        console.warn('warn: no keys available for', { sheetTab });
        return { statusCode: 200, body: 'No keys available' };
      }
      
      console.log('ok: got key', {
        product,
        sheetTab,
        keyPreview: String(key).slice(0, 4) + '...',
        hasExtra: !!extraKey
      });

      // Upsert in MailerLite (best effort).
      try {
        const okMl = await upsertMailerLite({ email, product, key, extraKey, playMode });
        if (!okMl) console.warn('warn: mailerlite upsert not ok');
      } catch (err) {
        console.error('mailerlite error:', err.message);
      }
    }

    // TikTok + Meta (best effort) for all products, including pre orders.
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
      console.warn('bailed: language/play mode resolution failed');
      try {
        await appendBailedEmailToSheet(email);
      } catch {}
      try {
        await notifyBailAdmin({ buyerEmail: email });
      } catch {}
      return { statusCode: 200, body: 'Bailed' };
    }

    console.error('routing error:', err.message);
    return {
      statusCode: 200,
      body: 'Language / play mode not recognized for single-language link'
    };
  }
};

