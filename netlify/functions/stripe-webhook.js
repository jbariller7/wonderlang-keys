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
  ML_GROUPS_ALL,
  LANGUAGE_FIELD_KEY,
  PLAY_MODE_FIELD_KEY,
  TIKTOK_PIXEL,
  TIKTOK_ACCESS_TOKEN,
  TIKTOK_TEST_EVENT_CODE,
  META_PIXEL,
  META_ACCESS_TOKEN,
  META_TEST_EVENT_CODE
} = process.env;

const stripe = new Stripe(STRIPE_API_KEY, { apiVersion: '2024-06-20' });

const ADMIN_EMAIL_FOR_BAIL = 'wonderlang.thegame@gmail.com';
const ML_BAILED_GROUP_ID = '158395915765286796';

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
  ZH: 'Mandarin', // Updated: No longer a preorder
  POLY_STEAM: 'POLY_STEAM',
  POLY_ITCH: 'POLY_ITCH',
  EN_PREORDER: 'EnglishPreorder'
};

const PLAY_MODE = {
  STEAM: 'STEAM',
  DIRECT: 'DIRECT'
};

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
  [normalizeLangString('Mandarin Chinese')]: PRODUCT.ZH, // Updated label
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
  [PRODUCT.ZH]: 'Mandarin', // Points to your 'Mandarin' tab
  [PRODUCT.POLY_STEAM]: 'Polyglot Steam',
  [PRODUCT.POLY_ITCH]: 'Polyglot Itch',
  [PRODUCT.EN_PREORDER]: 'English'
};

const inSet = (arr, id) => Array.isArray(arr) && arr.includes(id);

// --- Helpers (Kept as in original for brevity, logic remains same)
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
  if (key.includes('mandarin') || key.includes('chinese')) return PRODUCT.ZH; // Updated
  if (key.includes('english') && key.includes('pre-order')) return PRODUCT.EN_PREORDER;
  return null;
}

// ... [Include extractLanguageFromField, getLanguageProductFromCustomFields, parsePlayMode, extractPlayModeFromField, getPlayModeFromCustomFields from original]
// (Ensure these functions are in your final file)

// --- Sheets, MailerLite, Meta, TikTok functions remain identical to your source ---
// ... [Include getSheets, appendBailedEmailToSheet, appendPreorderToSheet, findAndAssignKey, groupsForProduct, upsertMailerLite, lookupMailerLiteIp, notifyBailAdmin, sendMetaPurchase, getLineItemInfo, getPaymentLinkUrl, getCustomerPhone, sendTikTokEvent]

// --- Updated Product Routing ---
async function productFromSession(session) {
  const pl = session.payment_link;
  const langProduct = getLanguageProductFromCustomFields(session);
  const playMode = getPlayModeFromCustomFields(session);

  // ONLY English remains as a preorder special case
  if (langProduct === PRODUCT.EN_PREORDER) {
    console.log('route: PREORDER', { payment_link: pl, langProduct });
    return { product: langProduct, playMode: null };
  }

  if (!playMode) {
    throw new BailError('Play mode selection missing', null);
  }

  // Single language checkout (Now includes Mandarin)
  if (inSet(PAYMENT_LINK.SINGLE_LANGUAGE, pl)) {
    if (playMode === PLAY_MODE.STEAM) {
      if (!langProduct) {
        throw new BailError('Language selection missing for SINGLE_LANGUAGE Steam', null);
      }
      return { product: langProduct, playMode };
    } else {
      // Direct Download always goes to Polyglot Itch
      return { product: PRODUCT.POLY_ITCH, playMode };
    }
  }

  // Polyglot logic remains same
  if (inSet(PAYMENT_LINK.POLYGLOT, pl)) {
    return { 
      product: playMode === PLAY_MODE.STEAM ? PRODUCT.POLY_STEAM : PRODUCT.POLY_ITCH, 
      playMode 
    };
  }

  return { product: langProduct || PRODUCT.POLY_STEAM, playMode };
}

// --- Main Handler ---
exports.handler = async (event) => {
  // ... [Signature verification block from original]

  const session = stripeEvent.data.object;
  const email = session?.customer_details?.email || session?.customer_email || null;

  try {
    const { product, playMode } = await productFromSession(session);
    const sheetTab = SHEET_TAB_BY_PRODUCT[product];

    // UPDATED: Now ONLY English skips key assignment
    if (product === PRODUCT.EN_PREORDER) {
      await appendPreorderToSheet({
        sheetTab,
        email,
        sessionId: session.id,
        paymentLinkId: session.payment_link || ''
      });
    } else {
      // MANDARIN and others follow this path now
      const r = await findAndAssignKey({
        sheetTab,
        email,
        sessionId: session.id,
        paymentLinkId: session.payment_link || ''
      });
      
      if (r.key) {
        await upsertMailerLite({ email, product, key: r.key, playMode });
      }
    }

    // Pixels fire for everyone
    try {
        const ip = await lookupMailerLiteIp(email);
        const url = await getPaymentLinkUrl(session.payment_link);
        const phone = await getCustomerPhone(session);
        // ... [Fire TikTok and Meta events as in original]
    } catch (pixelErr) {
        console.error('Pixel error:', pixelErr.message);
    }

    return { statusCode: 200, body: 'OK' };

  } catch (err) {
    // ... [BailError handling from original]
  }
};
