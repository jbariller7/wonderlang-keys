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

  // TikTok
  TIKTOK_API_KEY,
  TIKTOK_ACCESS_TOKEN,
  TIKTOK_PIXEL,
  TIKTOK_TEST_EVENT_CODE,

  // Optional Stripe custom field keys
  LANGUAGE_FIELD_KEY,
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
    'plink_1QpUf9BFbQoDa6p09Gf8e8A9', 
    'plink_1RRoY8BFbQoDa6p0S9T2G8B9' 
  ]
};

// --- Product codes
const PRODUCT = {
  FR: 'French', ES: 'Spanish', DE: 'German', PT: 'Portuguese', 
  IT: 'Italian', KO: 'Korean', JA: 'Japanese', ZH: 'Mandarin',
  POLY_STEAM: 'POLY_STEAM', POLY_ITCH: 'POLY_ITCH', EN_PREORDER: 'EnglishPreorder'
};

const PLAY_MODE = { STEAM: 'STEAM', DIRECT: 'DIRECT' };

// Helper to normalize strings
function normalize(s) {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

const LANGUAGE_VALUE_TO_PRODUCT = {
  [normalize('French')]: PRODUCT.FR,
  [normalize('Spanish')]: PRODUCT.ES,
  [normalize('German')]: PRODUCT.DE,
  [normalize('Italian')]: PRODUCT.IT,
  [normalize('Portuguese')]: PRODUCT.PT,
  [normalize('Korean')]: PRODUCT.KO,
  [normalize('Japanese')]: PRODUCT.JA,
  [normalize('Mandarin Chinese')]: PRODUCT.ZH,
  [normalize('English (Pre-Order)')]: PRODUCT.EN_PREORDER
};

const SHEET_TAB_BY_PRODUCT = {
  [PRODUCT.FR]: 'French Steam', [PRODUCT.ES]: 'Spanish Steam', [PRODUCT.DE]: 'German Steam',
  [PRODUCT.PT]: 'Portuguese Steam', [PRODUCT.IT]: 'Italian Steam', [PRODUCT.KO]: 'Korean Steam',
  [PRODUCT.JA]: 'Japanese Steam', [PRODUCT.ZH]: 'Mandarin', [PRODUCT.POLY_STEAM]: 'Polyglot Steam',
  [PRODUCT.POLY_ITCH]: 'Polyglot Itch', [PRODUCT.EN_PREORDER]: 'English'
};

const inSet = (arr, id) => Array.isArray(arr) && arr.includes(id);

// --- Robust Field Extractors
function extractAllValues(f) {
  const vals = [];
  if (f.text && typeof f.text.value !== 'undefined') vals.push(f.text.value);
  if (f.dropdown && typeof f.dropdown.value !== 'undefined') vals.push(f.dropdown.value);
  if (f.dropdown && Array.isArray(f.dropdown.options)) {
    for (const opt of f.dropdown.options) {
      if (opt.value) vals.push(opt.value);
      if (opt.label) vals.push(opt.label);
    }
  }
  if (typeof f.value !== 'undefined') vals.push(f.value);
  return vals;
}

function getLanguageProductFromCustomFields(session) {
  const cfs = session.custom_fields || [];
  for (const f of cfs) {
    for (const raw of extractAllValues(f)) {
      const p = LANGUAGE_VALUE_TO_PRODUCT[normalize(raw)];
      if (p) return p;
      const nv = normalize(raw);
      if (nv.includes('french')) return PRODUCT.FR;
      if (nv.includes('spanish')) return PRODUCT.ES;
      if (nv.includes('german')) return PRODUCT.DE;
      if (nv.includes('mandarin') || nv.includes('chinese')) return PRODUCT.ZH;
    }
  }
  return null;
}

function getPlayModeFromCustomFields(session) {
  const cfs = session.custom_fields || [];
  console.log('DEBUG: Stripe Custom Fields:', JSON.stringify(cfs));
  for (const f of cfs) {
    for (const raw of extractAllValues(f)) {
      const nv = normalize(raw);
      console.log(`DEBUG: Testing field value: "${nv}"`);
      if (nv.includes('steam')) return PLAY_MODE.STEAM;
      if (nv.includes('direct') || nv.includes('itch')) return PLAY_MODE.DIRECT;
    }
  }
  return null;
}

// --- Google Sheets client
async function getSheets() {
  const jwt = new google.auth.JWT(
    GOOGLE_SA_EMAIL, undefined,
    (GOOGLE_SA_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    ['https://www.googleapis.com/auth/spreadsheets']
  );
  return google.sheets({ version: 'v4', auth: jwt });
}

async function findAndAssignKey({ sheetTab, email, sessionId, paymentLinkId, isBogo }) {
  const sheets = await getSheets();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: GOOGLE_SHEETS_ID,
    range: `${sheetTab}!A2:F`
  });
  const rows = res.data.values || [];
  const numNeeded = isBogo ? 2 : 1;
  
  const assigned = [];
  for (let i = 0; i < rows.length; i++) {
    if (rows[i][3] === sessionId) assigned.push(rows[i][0]);
  }
  if (assigned.length >= numNeeded) return { keys: assigned.slice(0, numNeeded) };

  const fresh = [];
  for (let i = 0; i < rows.length; i++) {
    if (rows[i][0] && (!rows[i][1] || rows[i][1] === '') && rows[i][3] !== sessionId) {
      fresh.push(i);
      if (fresh.length === numNeeded) break;
    }
  }

  if (fresh.length < numNeeded) return { keys: [] };

  const finalKeys = [];
  for (const idx of fresh) {
    const key = rows[idx][0];
    const targetRow = 2 + idx;
    await sheets.spreadsheets.values.update({
      spreadsheetId: GOOGLE_SHEETS_ID,
      range: `${sheetTab}!B${targetRow}:E${targetRow}`,
      valueInputOption: 'RAW',
      requestBody: { values: [[email, new Date().toISOString(), sessionId, paymentLinkId || '']] }
    });
    finalKeys.push(key);
  }
  return { keys: finalKeys };
}

// --- Full Tracking Helpers
async function getLineItemInfo(sessionId) {
  try {
    const li = await stripe.checkout.sessions.listLineItems(sessionId, { limit: 1, expand: ['data.price.product'] });
    const item = li?.data?.[0];
    if (!item) return {};
    const unitPrice = typeof item.amount_total === 'number' ? item.amount_total / 100 : (item.price?.unit_amount ? item.price.unit_amount / 100 : null);
    return { unitPrice, currency: (item.currency || '').toUpperCase(), name: item.description || item.price?.product?.name };
  } catch (e) { return {}; }
}

async function getPaymentLinkUrl(paymentLinkId) {
  if (!paymentLinkId) return null;
  try {
    const pl = await stripe.paymentLinks.retrieve(paymentLinkId);
    return pl?.url || null;
  } catch { return null; }
}

async function getCustomerPhone(session) {
  const phone = session?.customer_details?.phone || null;
  if (phone) return phone;
  if (session.customer) {
    try {
      const cust = await stripe.customers.retrieve(session.customer);
      return cust?.phone || null;
    } catch { return null; }
  }
  return null;
}

// --- Pixel Logic
async function sendMetaPurchase({ session, email, product, ip, url, phone, fbc, fbp, contentName }) {
  if (!META_PIXEL || !META_ACCESS_TOKEN) return;
  const { unitPrice, currency: liCurrency, name: liName } = await getLineItemInfo(session.id);
  const value = (session.amount_total / 100) || unitPrice || 15;
  const currency = (session.currency || liCurrency || 'USD').toUpperCase();
  
  const body = {
    data: [{
      event_name: 'Purchase',
      event_time: Math.floor(Date.now() / 1000),
      action_source: 'website',
      event_id: session.id,
      event_source_url: url || undefined,
      user_data: {
        em: crypto.createHash('sha256').update(email.toLowerCase().trim()).digest('hex'),
        ph: phone ? crypto.createHash('sha256').update(phone).digest('hex') : undefined,
        client_ip_address: ip || undefined,
        fbc: fbc || undefined,
        fbp: fbp || undefined
      },
      custom_data: { currency, value, content_name: contentName || liName || product, content_type: 'product', content_ids: [product] }
    }],
    test_event_code: META_TEST_EVENT_CODE || undefined
  };

  await fetch(`https://graph.facebook.com/v20.0/${META_PIXEL}/events?access_token=${META_ACCESS_TOKEN}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
}

async function sendTikTokEvent({ session, email, product, ip, url, phone, ttclid, ttp, contentName }) {
  if (!TIKTOK_ACCESS_TOKEN || !TIKTOK_PIXEL) return;
  const { unitPrice, currency: liCurrency, name: liName } = await getLineItemInfo(session.id);
  const value = (session.amount_total / 100) || unitPrice || 15;
  const currency = (session.currency || liCurrency || 'USD').toUpperCase();

  const body = {
    event_source: 'web', event_source_id: TIKTOK_PIXEL,
    data: [{
      event: 'Purchase', event_id: session.id, event_time: Math.floor(Date.now() / 1000),
      user: {
        email: crypto.createHash('sha256').update(email.toLowerCase().trim()).digest('hex'),
        phone: phone ? crypto.createHash('sha256').update(phone).digest('hex') : undefined,
        ip: ip || undefined, ttclid: ttclid || undefined, ttp: ttp || undefined
      },
      properties: { value, currency, content_id: product, content_type: 'product', content_name: contentName || liName || product }
    }],
    test_event_code: TIKTOK_TEST_EVENT_CODE || undefined
  };

  await fetch('https://business-api.tiktok.com/open_api/v1.3/event/track/', {
    method: 'POST', headers: { 'Access-Token': TIKTOK_ACCESS_TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
}

// --- MailerLite logic
async function upsertMailerLite({ email, product, keys, playMode }) {
  const allGroups = (process.env.ML_GROUPS_ALL || '').split(',').map(s => s.trim());
  const modeGroups = playMode === PLAY_MODE.DIRECT ? (process.env.ML_GROUPS_POLY_ITCH || '').split(',') : (process.env.ML_GROUPS_POLY_STEAM || '').split(',');
  const groups = allGroups.concat(modeGroups).filter(Boolean);

  const fields = {};
  if (keys[0]) fields[playMode === PLAY_MODE.DIRECT ? (ML_FIELD_ITCH_KEY || 'itch_key') : (ML_FIELD_STEAM_KEY || 'steam_key')] = keys[0];
  if (keys[1]) fields[ML_FIELD_EXTRA_KEY || 'extra_steam_key'] = keys[1];

  await fetch('https://connect.mailerlite.com/api/subscribers', {
    method: 'POST',
    headers: { Authorization: `Bearer ${MAILERLITE_API_KEY}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ email, fields, groups })
  });
}

class BailError extends Error {
  constructor(message, email) { super(message); this.name = 'BailError'; this.buyerEmail = email; }
}

// --- Main Handler
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405 };
  const sig = event.headers['stripe-signature'];
  let stripeEvent;
  try { stripeEvent = stripe.webhooks.constructEvent(event.body, sig, STRIPE_WEBHOOK_SECRET); } 
  catch (err) { return { statusCode: 400, body: `Sig Fail: ${err.message}` }; }

  if (!['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(stripeEvent.type)) return { statusCode: 200 };
  
  const session = stripeEvent.data.object;
  if (session.payment_status !== 'paid') return { statusCode: 200 };
  const email = session?.customer_details?.email || session?.customer_email;
  if (!email) return { statusCode: 200 };

  try {
    const pl = session.payment_link;
    const langProduct = getLanguageProductFromCustomFields(session);
    const playMode = getPlayModeFromCustomFields(session);
    const isBogo = inSet(PAYMENT_LINK.BOGO, pl);

    console.log(`Decision: pl=${pl}, lang=${langProduct}, mode=${playMode}, bogo=${isBogo}`);

    if (langProduct === PRODUCT.EN_PREORDER) {
      const sheets = await getSheets();
      await sheets.spreadsheets.values.append({
        spreadsheetId: GOOGLE_SHEETS_ID, range: 'English!A:D', valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS',
        requestBody: { values: [[email, new Date().toISOString(), session.id, pl]] }
      });
    } else {
      if (!playMode) throw new BailError('Play mode selection missing', email);
      
      let product = langProduct;
      if (isBogo || inSet(PAYMENT_LINK.POLYGLOT, pl)) {
        product = playMode === PLAY_MODE.STEAM ? PRODUCT.POLY_STEAM : PRODUCT.POLY_ITCH;
      } else if (inSet(PAYMENT_LINK.SINGLE_LANGUAGE, pl)) {
        if (playMode === PLAY_MODE.STEAM && !langProduct) throw new BailError('Lang missing for Single Steam', email);
        product = (playMode === PLAY_MODE.STEAM) ? langProduct : PRODUCT.POLY_ITCH;
      }

      const sheetTab = SHEET_TAB_BY_PRODUCT[product];
      const { keys } = await findAndAssignKey({ sheetTab, email, sessionId: session.id, paymentLinkId: pl, isBogo });
      
      if (keys.length > 0) {
        await upsertMailerLite({ email, product, keys, playMode });
      }
    }

    // Best effort tracking
    try {
      const ip = await (async () => {
        try {
          const res = await fetch(`https://connect.mailerlite.com/api/subscribers/${encodeURIComponent(email)}`, { headers: { Authorization: `Bearer ${MAILERLITE_API_KEY}` } });
          const json = await res.json();
          return json?.data?.ip_address || json?.data?.optin_ip || null;
        } catch { return null; }
      })();
      const url = await getPaymentLinkUrl(pl);
      const phone = await getCustomerPhone(session);
      const trackingData = {
        session, email, product: langProduct || 'Polyglot', ip, url, phone,
        contentName: SHEET_TAB_BY_PRODUCT[langProduct] || 'Polyglot',
        ttclid: session.metadata?.ttclid, ttp: session.metadata?.ttp,
        fbc: session.metadata?.fbc, fbp: session.metadata?.fbp
      };
      await sendTikTokEvent(trackingData);
      await sendMetaPurchase(trackingData);
    } catch (e) { console.error('Tracking Error', e); }

    return { statusCode: 200, body: 'OK' };

  } catch (err) {
    if (err instanceof BailError) {
      const sheets = await getSheets();
      await sheets.spreadsheets.values.append({ spreadsheetId: GOOGLE_SHEETS_ID, range: 'Bailed!A:A', valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS', requestBody: { values: [[email]] } });
      if (MAILERLITE_API_KEY) {
        await fetch(`https://connect.mailerlite.com/api/subscribers/${encodeURIComponent(ADMIN_EMAIL_FOR_BAIL)}`, { method: 'PATCH', headers: { Authorization: `Bearer ${MAILERLITE_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ fields: { bailed_email: email } }) });
        await fetch(`https://connect.mailerlite.com/api/groups/${ML_BAILED_GROUP_ID}/subscribers`, { method: 'POST', headers: { Authorization: `Bearer ${MAILERLITE_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: ADMIN_EMAIL_FOR_BAIL }) });
      }
    }
    return { statusCode: 200, body: 'Processed' };
  }
};
