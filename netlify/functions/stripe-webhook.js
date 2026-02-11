// netlify/functions/stripe-webhook.js
const Stripe = require('stripe');
const { google } = require('googleapis');
const crypto = require('crypto');

// --- ENV
const {
  STRIPE_API_KEY,
  STRIPE_WEBHOOK_SECRET,
  GOOGLE_SHEETS_ID,
  GOOGLE_SA_EMAIL,
  GOOGLE_SA_PRIVATE_KEY,

  MAILERLITE_API_KEY,
  ML_FIELD_STEAM_KEY,
  ML_FIELD_ITCH_KEY,
  ML_FIELD_EXTRA_KEY, // Set this to 'extra_steam_key' in your ENV
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

  TIKTOK_API_KEY,
  TIKTOK_ACCESS_TOKEN,
  TIKTOK_PIXEL,
  TIKTOK_TEST_EVENT_CODE,

  LANGUAGE_FIELD_KEY,
  PLAY_MODE_FIELD_KEY,

  META_PIXEL,
  META_ACCESS_TOKEN,
  META_TEST_EVENT_CODE
} = process.env;

const stripe = new Stripe(STRIPE_API_KEY, { apiVersion: '2024-06-20' });

const ADMIN_EMAIL_FOR_BAIL = 'wonderlang.thegame@gmail.com';
const ML_BAILED_GROUP_ID = '158395915765286796';

// --- Payment Link mapping
const PAYMENT_LINK = {
  SINGLE_LANGUAGE: [
    'plink_1RoKYZBFbQoDa6p0hCPS3d2g',
    'plink_1Rzg6lBFbQoDa6p0bmGphygN',
    'plink_1RvKx8BFbQoDa6p0PaVih8U5'
  ],
  POLYGLOT: [
    'plink_1RoLRRBFbQoDa6p0g9zXIJaM',
    'plink_1Rzg0NBFbQoDa6p0fL5aVAsU',
    'plink_1RvL4VBFbQoDa6p09A00tNAR',
    'plink_1RoNLzBFbQoDa6p0lvW7lw5f',
    'plink_1RoN4QBFbQoDa6p0fQ8Xc3Vs',
    'plink_1S2w5eBFbQoDa6p06bwPV6Hp',
    'plink_1Rzg7fBFbQoDa6p0UCIOzCtk',
    'plink_1S2wD2BFbQoDa6p0w2tvZNiG'
  ],
  // BOGO PROMOTION LINKS (2 keys)
  BOGO: [
    'plink_1QpUf9BFbQoDa6p09Gf8e8A9', // Corresponds to buy.stripe.com/00wcN42TVaPubLK1tldby16
    'plink_1RRoY8BFbQoDa6p0S9T2G8B9'  // Corresponds to buy.stripe.com/4gM7sK3XZaPuaHG0phdby15
  ]
};

const PRODUCT = {
  FR: 'French',
  ES: 'Spanish',
  DE: 'German',
  PT: 'Portuguese',
  IT: 'Italian',
  KO: 'Korean',
  JA: 'Japanese',
  ZH: 'Mandarin',
  POLY_STEAM: 'POLY_STEAM',
  POLY_ITCH: 'POLY_ITCH',
  EN_PREORDER: 'EnglishPreorder'
};

const PLAY_MODE = {
  STEAM: 'STEAM',
  DIRECT: 'DIRECT'
};

// --- Normalization Helpers
function normalizeLangString(s) {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

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
  [PRODUCT.ZH]: 'Mandarin',
  [PRODUCT.POLY_STEAM]: 'Polyglot Steam',
  [PRODUCT.POLY_ITCH]: 'Polyglot Itch',
  [PRODUCT.EN_PREORDER]: 'English'
};

const inSet = (arr, id) => Array.isArray(arr) && arr.includes(id);

// --- Extraction logic
function productFromLanguageValue(value) {
  if (!value) return null;
  const key = normalizeLangString(value);
  if (LANGUAGE_VALUE_TO_PRODUCT[key]) return LANGUAGE_VALUE_TO_PRODUCT[key];
  if (key.includes('french')) return PRODUCT.FR;
  if (key.includes('spanish')) return PRODUCT.ES;
  if (key.includes('german')) return PRODUCT.DE;
  if (key.includes('italian')) return PRODUCT.IT;
  if (key.includes('portuguese')) return PRODUCT.PT;
  if (key.includes('korean')) return PRODUCT.KO;
  if (key.includes('japanese')) return PRODUCT.JA;
  if (key.includes('mandarin') || key.includes('chinese')) return PRODUCT.ZH;
  if (key.includes('english')) return PRODUCT.EN_PREORDER;
  return null;
}

function extractFieldData(f) {
  if (!f) return [];
  const candidates = [];
  if (f.text?.value) candidates.push(f.text.value);
  if (f.dropdown?.value) candidates.push(f.dropdown.value);
  if (Array.isArray(f.dropdown?.options)) {
    f.dropdown.options.forEach(opt => {
      if (opt.value) candidates.push(opt.value);
      if (opt.label) candidates.push(opt.label);
    });
  }
  if (f.value) candidates.push(f.value);
  return candidates;
}

function getLanguageProductFromCustomFields(session) {
  const cfs = session.custom_fields || [];
  const normKey = (s) => String(s || '').trim().toLowerCase().replace(/[\s_-]+/g, '');
  const configKey = normKey(LANGUAGE_FIELD_KEY || 'language');
  for (const f of cfs) {
    if (normKey(f.key) === configKey) {
      for (const val of extractFieldData(f)) {
        const p = productFromLanguageValue(val);
        if (p) return p;
      }
    }
  }
  return null;
}

function getPlayModeFromCustomFields(session) {
  const cfs = session.custom_fields || [];
  const normKey = (s) => String(s || '').trim().toLowerCase().replace(/[\s_-]+/g, '');
  const configKey = normKey(PLAY_MODE_FIELD_KEY || 'play_mode');
  const parse = (raw) => {
    const k = normalizeLangString(raw);
    if (k.includes('steam')) return PLAY_MODE.STEAM;
    if (k.includes('direct') || k.includes('itch')) return PLAY_MODE.DIRECT;
    return null;
  };
  for (const f of cfs) {
    if (normKey(f.key) === configKey) {
      for (const val of extractFieldData(f)) {
        const pm = parse(val);
        if (pm) return pm;
      }
    }
  }
  return null;
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

// --- Modified Find and Assign (Handles 1 or 2 keys)
async function findAndAssignKey({ sheetTab, email, sessionId, paymentLinkId, isBogo }) {
  const sheets = await getSheets();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: GOOGLE_SHEETS_ID,
    range: `${sheetTab}!A2:F`
  });
  const rows = res.data.values || [];
  const numNeeded = isBogo ? 2 : 1;
  const assignedKeys = [];

  // Idempotency: Check if session already has keys
  for (let i = 0; i < rows.length; i++) {
    if (rows[i][3] === sessionId) {
      assignedKeys.push(rows[i][0]);
    }
  }

  // If we already found the right number of keys for this session, return them
  if (assignedKeys.length >= numNeeded) {
    return { keys: assignedKeys.slice(0, numNeeded) };
  }

  // Find fresh rows
  const freshIndices = [];
  for (let i = 0; i < rows.length; i++) {
    const k = rows[i][0];
    const assignedEmail = rows[i][1];
    const rowSession = rows[i][3];
    if (k && (!assignedEmail || assignedEmail === '') && rowSession !== sessionId) {
      freshIndices.push(i);
      if (freshIndices.length === numNeeded) break;
    }
  }

  if (freshIndices.length < numNeeded) {
    console.error('NOT ENOUGH KEYS AVAILABLE', { sheetTab, needed: numNeeded, found: freshIndices.length });
    return { keys: [] };
  }

  const when = new Date().toISOString();
  const finalKeys = [];

  for (const idx of freshIndices) {
    const targetRow = 2 + idx;
    const key = rows[idx][0];
    await sheets.spreadsheets.values.update({
      spreadsheetId: GOOGLE_SHEETS_ID,
      range: `${sheetTab}!B${targetRow}:E${targetRow}`,
      valueInputOption: 'RAW',
      requestBody: { values: [[email, when, sessionId, paymentLinkId || '']] }
    });
    finalKeys.push(key);
  }

  return { keys: finalKeys };
}

async function appendPreorderToSheet({ sheetTab, email, sessionId, paymentLinkId }) {
  const sheets = await getSheets();
  await sheets.spreadsheets.values.append({
    spreadsheetId: GOOGLE_SHEETS_ID,
    range: `${sheetTab}!A:D`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [[email, new Date().toISOString(), sessionId, paymentLinkId || '']] }
  });
}

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
  } catch (e) { console.error('bailed sheet error', e.message); }
}

// --- MailerLite
function envList(name) {
  const v = process.env[name];
  return v ? v.split(',').map(s => s.trim()).filter(Boolean) : [];
}

async function upsertMailerLite({ email, product, keys, playMode }) {
  const groups = envList('ML_GROUPS_ALL').concat(
    playMode === PLAY_MODE.DIRECT ? envList('ML_GROUPS_POLY_ITCH') : envList('ML_GROUPS_POLY_STEAM')
  );
  
  const fields = {};
  const primaryKey = keys[0];
  const secondaryKey = keys[1];

  if (primaryKey) {
    const fieldName = playMode === PLAY_MODE.DIRECT ? (ML_FIELD_ITCH_KEY || 'itch_key') : (ML_FIELD_STEAM_KEY || 'steam_key');
    fields[fieldName] = primaryKey;
  }

  if (secondaryKey) {
    fields[ML_FIELD_EXTRA_KEY || 'extra_steam_key'] = secondaryKey;
  }

  const res = await fetch('https://connect.mailerlite.com/api/subscribers', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${MAILERLITE_API_KEY}`,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify({ email, fields, groups })
  });
  return res.ok;
}

async function lookupMailerLiteIp(email) {
  if (!MAILERLITE_API_KEY) return null;
  try {
    const res = await fetch(`https://connect.mailerlite.com/api/subscribers/${encodeURIComponent(email)}`, {
      headers: { Authorization: `Bearer ${MAILERLITE_API_KEY}`, Accept: 'application/json' }
    });
    if (!res.ok) return null;
    const json = await res.json();
    return json?.data?.ip_address || json?.data?.optin_ip || null;
  } catch { return null; }
}

async function notifyBailAdmin({ buyerEmail }) {
  if (!MAILERLITE_API_KEY) return;
  const api = 'https://connect.mailerlite.com/api';
  try {
    await fetch(`${api}/subscribers/${encodeURIComponent(ADMIN_EMAIL_FOR_BAIL)}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${MAILERLITE_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: ADMIN_EMAIL_FOR_BAIL, fields: { bailed_email: buyerEmail } })
    });
    await fetch(`${api}/groups/${ML_BAILED_GROUP_ID}/subscribers`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${MAILERLITE_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: ADMIN_EMAIL_FOR_BAIL })
    });
  } catch (e) { console.error('bailed ML error', e.message); }
}

// --- Tracking
async function sendTikTokEvent({ session, email, product, ip, url, phone, ttclid, ttp, contentName }) {
  if (!TIKTOK_ACCESS_TOKEN || !TIKTOK_PIXEL) return;
  const val = session.amount_total / 100;
  const body = {
    event_source: 'web',
    event_source_id: TIKTOK_PIXEL,
    data: [{
      event: 'Purchase',
      event_id: session.id,
      event_time: Math.floor(Date.now() / 1000),
      user: {
        email: crypto.createHash('sha256').update(email.toLowerCase()).digest('hex'),
        ip: ip || undefined,
        ttclid: ttclid || undefined,
        ttp: ttp || undefined
      },
      properties: {
        value: val,
        currency: (session.currency || 'USD').toUpperCase(),
        content_name: contentName,
        content_type: 'product',
        content_id: product
      }
    }]
  };
  await fetch('https://business-api.tiktok.com/open_api/v1.3/event/track/', {
    method: 'POST',
    headers: { 'Access-Token': TIKTOK_ACCESS_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}

async function sendMetaPurchase({ session, email, product, ip, url, fbc, fbp, contentName }) {
  if (!META_PIXEL || !META_ACCESS_TOKEN) return;
  const val = session.amount_total / 100;
  const body = {
    data: [{
      event_name: 'Purchase',
      event_time: Math.floor(Date.now() / 1000),
      action_source: 'website',
      event_id: session.id,
      user_data: {
        em: crypto.createHash('sha256').update(email.toLowerCase()).digest('hex'),
        client_ip_address: ip || undefined,
        fbc: fbc || undefined,
        fbp: fbp || undefined
      },
      custom_data: {
        value: val,
        currency: (session.currency || 'USD').toUpperCase(),
        content_name: contentName,
        content_type: 'product'
      }
    }]
  };
  await fetch(`https://graph.facebook.com/v20.0/${META_PIXEL}/events?access_token=${META_ACCESS_TOKEN}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}

class BailError extends Error {
  constructor(message, email) { super(message); this.name = 'BailError'; this.buyerEmail = email; }
}

// --- Routing Logic
async function productFromSession(session) {
  const pl = session.payment_link;
  const langProduct = getLanguageProductFromCustomFields(session);
  const playMode = getPlayModeFromCustomFields(session);

  if (langProduct === PRODUCT.EN_PREORDER) return { product: langProduct, playMode: null };

  if (!playMode) throw new BailError('Play mode selection missing', session?.customer_details?.email);

  // BOGO DETECTION
  const isBogo = inSet(PAYMENT_LINK.BOGO, pl);

  if (isBogo || inSet(PAYMENT_LINK.POLYGLOT, pl)) {
    return { 
      product: playMode === PLAY_MODE.STEAM ? PRODUCT.POLY_STEAM : PRODUCT.POLY_ITCH, 
      playMode,
      isBogo
    };
  }

  if (inSet(PAYMENT_LINK.SINGLE_LANGUAGE, pl)) {
    if (playMode === PLAY_MODE.STEAM) {
      if (!langProduct) throw new BailError('Language missing for single-lang steam', session?.customer_details?.email);
      return { product: langProduct, playMode, isBogo: false };
    }
    return { product: PRODUCT.POLY_ITCH, playMode, isBogo: false };
  }

  return { product: langProduct || PRODUCT.POLY_STEAM, playMode, isBogo: false };
}

// --- Main Handler
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
  const sig = event.headers['stripe-signature'];
  let stripeEvent;

  try {
    stripeEvent = stripe.webhooks.constructEvent(event.body, sig, STRIPE_WEBHOOK_SECRET);
  } catch (err) { return { statusCode: 400, body: `Sig Fail: ${err.message}` }; }

  if (!['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(stripeEvent.type)) {
    return { statusCode: 200, body: 'Ignored' };
  }

  const session = stripeEvent.data.object;
  if (session.payment_status !== 'paid') return { statusCode: 200, body: 'Not paid' };

  const email = session?.customer_details?.email || session?.customer_email;
  if (!email) return { statusCode: 200, body: 'No email' };

  try {
    const { product, playMode, isBogo } = await productFromSession(session);
    const sheetTab = SHEET_TAB_BY_PRODUCT[product];

    if (product === PRODUCT.EN_PREORDER) {
      await appendPreorderToSheet({ sheetTab, email, sessionId: session.id, paymentLinkId: session.payment_link });
    } else {
      const { keys } = await findAndAssignKey({ sheetTab, email, sessionId: session.id, paymentLinkId: session.payment_link, isBogo });
      if (keys.length > 0) {
        await upsertMailerLite({ email, product, keys, playMode });
      }
    }

    // Best effort tracking
    try {
      const ip = await lookupMailerLiteIp(email);
      const trackingData = {
        session, email, product, ip, 
        contentName: sheetTab,
        ttclid: session.metadata?.ttclid, 
        ttp: session.metadata?.ttp,
        fbc: session.metadata?.fbc,
        fbp: session.metadata?.fbp
      };
      await sendTikTokEvent(trackingData);
      await sendMetaPurchase(trackingData);
    } catch (e) { console.error('Tracking Error', e); }

    return { statusCode: 200, body: 'OK' };

  } catch (err) {
    if (err instanceof BailError) {
      await appendBailedEmailToSheet(email);
      await notifyBailAdmin({ buyerEmail: email });
      return { statusCode: 200, body: 'Bailed' };
    }
    console.error('General Error:', err.message);
    return { statusCode: 200, body: 'Processed with error' };
  }
};
