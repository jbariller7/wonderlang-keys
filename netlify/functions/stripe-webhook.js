const Stripe = require('stripe');
const { google } = require('googleapis');


const {
  STRIPE_API_KEY,
  STRIPE_WEBHOOK_SECRET,
  GOOGLE_SHEETS_ID,
  GOOGLE_SA_EMAIL,
  GOOGLE_SA_PRIVATE_KEY, // paste with \n escaped in Netlify env, we unescape below
  EMAIL_FROM,            // "WonderLang Keys <keys@yourdomain.com>"
  SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS
} = process.env;

const stripe = new Stripe(STRIPE_API_KEY, { apiVersion: '2024-06-20' });



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

// 2) Map language custom field to a product key
const PRODUCT = {
  FR: 'French', ES: 'Spanish', DE: 'German', PT: 'Portuguese', IT: 'Italian', KO: 'Korean', JA: 'Japanese',
  POLY_STEAM: 'POLY_STEAM',
  POLY_ITCH: 'POLY_ITCH'
};

const LANGUAGE_TO_PRODUCT = {
  French: PRODUCT.FR,
  Spanish: PRODUCT.ES,
  German: PRODUCT.DE,
  Portuguese: PRODUCT.PT,
  Italian: PRODUCT.IT,
  Korean: PRODUCT.KO,
  Japanese: PRODUCT.JA
};

// 3) Which tab to use for each product
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

function productFromSession(session) {
  const pl = session.payment_link;

  if (inSet(PAYMENT_LINK.SINGLE_LANGUAGE, pl)) {
    const fields = Array.isArray(session.custom_fields) ? session.custom_fields : [];
    const langField = fields.find(f => f.key === 'language');
    const val = langField && (langField.text?.value || langField.dropdown?.value);
    return (val && LANGUAGE_TO_PRODUCT[String(val).trim()]) || PRODUCT.FR;
  }
  if (inSet(PAYMENT_LINK.POLYGLOT_STEAM, pl)) return PRODUCT.POLY_STEAM;
  if (inSet(PAYMENT_LINK.POLYGLOT_ITCH, pl)) return PRODUCT.POLY_ITCH;
  return PRODUCT.POLY_STEAM;
}
async function getSheets() {
  const jwt = new google.auth.JWT(
    GOOGLE_SA_EMAIL,
    undefined,
    (GOOGLE_SA_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    ['https://www.googleapis.com/auth/spreadsheets']
  );
  return google.sheets({ version: 'v4', auth: jwt });
}

// For each tab we use columns:
// A key | B assigned_to_email | C assigned_at_iso | D stripe_session_id | E payment_link_id | F notes
async function findAndAssignKey({ sheetTab, email, sessionId, paymentLinkId }) {
  const sheets = await getSheets();
  const readRange = `${sheetTab}!A2:F`;
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: GOOGLE_SHEETS_ID,
    range: readRange
  });
  const rows = res.data.values || [];

  // Idempotency: if this session already processed, return that key
  for (let i = 0; i < rows.length; i++) {
    const [k, , , existingSession] = [
      rows[i][0],
      rows[i][1],
      rows[i][2],
      rows[i][3]
    ];
    if (existingSession === sessionId) {
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
  if (!key) return { key: null };

  const when = new Date().toISOString();
  const targetRow = 2 + rowIndex; // actual sheet row number
  const updateRange = `${sheetTab}!B${targetRow}:E${targetRow}`; // write cols B..E
  const values = [[email, when, sessionId, paymentLinkId || '']];

  await sheets.spreadsheets.values.update({
    spreadsheetId: GOOGLE_SHEETS_ID,
    range: updateRange,
    valueInputOption: 'RAW',
    requestBody: { values }
  });

  return { key };
}

function envList(name) {
  const v = process.env[name];
  return v ? v.split(',').map(s => s.trim()).filter(Boolean) : [];
}

function groupsForProduct(product) {
  const common = envList('ML_GROUPS_ALL');
  switch (product) {
    case PRODUCT.FR: return common.concat(envList('ML_GROUPS_POLY_STEAM'));
    case PRODUCT.ES: return common.concat(envList('ML_GROUPS_POLY_STEAM'));
    case PRODUCT.DE: return common.concat(envList('ML_GROUPS_POLY_STEAM'));
    case PRODUCT.PT: return common.concat(envList('ML_GROUPS_POLY_STEAM'));
    case PRODUCT.IT: return common.concat(envList('ML_GROUPS_POLY_STEAM'));
    case PRODUCT.KO: return common.concat(envList('ML_GROUPS_POLY_STEAM'));
    case PRODUCT.JA: return common.concat(envList('ML_GROUPS_POLY_STEAM'));
    case PRODUCT.POLY_STEAM: return common.concat(envList('ML_GROUPS_POLY_STEAM'));
    case PRODUCT.POLY_ITCH: return common.concat(envList('ML_GROUPS_POLY_ITCH'));
    default: return common;
  }
}

async function upsertMailerLite({ email, product, key }) {
  const api = 'https://connect.mailerlite.com/api';
  const groups = groupsForProduct(product);

  // Decide which custom field to set
  const fields = {};
  const steamKeyField = process.env.ML_FIELD_STEAM_KEY || 'steam_key';
  const itchKeyField  = process.env.ML_FIELD_ITCH_KEY  || 'itch_key';
  if (product === PRODUCT.POLY_ITCH) {
    fields[itchKeyField] = key;
  } else {
    fields[steamKeyField] = key;
  }

  const payload = { email, fields, groups };

  const res = await fetch(`${api}/subscribers`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.MAILERLITE_API_KEY}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  if (res.status === 200 || res.status === 201) return true;

  const text = await res.text().catch(() => '');
  console.error('MailerLite upsert failed', res.status, text);
  // Do not throw, we still want to ack Stripe to avoid repeated retries
  return false;
}


exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const buf = event.isBase64Encoded
    ? Buffer.from(event.body || '', 'base64')
    : Buffer.from(event.body || '', 'utf8');

  const sig = event.headers['stripe-signature'];
  let stripeEvent;
  try {
    stripeEvent = stripe.webhooks.constructEvent(buf, sig, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return { statusCode: 400, body: `Webhook signature verification failed: ${err.message}` };
  }

  const type = stripeEvent.type;
  if (type !== 'checkout.session.completed' && type !== 'checkout.session.async_payment_succeeded') {
    return { statusCode: 200, body: 'Ignored' };
  }

  const session = stripeEvent.data.object;
  if (session.payment_status !== 'paid') {
    return { statusCode: 200, body: 'Not paid yet' };
  }

  const email = session?.customer_details?.email || session?.customer_email || null;
  if (!email) return { statusCode: 200, body: 'No email in session' };

  const product = productFromSession(session);
  const sheetTab = SHEET_TAB_BY_PRODUCT[product];
  if (!sheetTab) return { statusCode: 200, body: 'Unknown product' };

  const { key } = await findAndAssignKey({
    sheetTab,
    email,
    sessionId: session.id,
    paymentLinkId: session.payment_link || ''
  });

  if (!key) {
    // Optional: notify yourself here via email or Slack
    return { statusCode: 200, body: 'No keys available' };
  }

 await upsertMailerLite({ email, product, key });
  return { statusCode: 200, body: 'OK' };
};

