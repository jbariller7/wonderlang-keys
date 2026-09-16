'use strict';
// Called only after Stripe webhook signature verification. Stable metadata
// replaces checkout custom fields for the new website; old links are unchanged.
const languages={french:'French',spanish:'Spanish',german:'German',portuguese:'Portuguese',italian:'Italian',korean:'Korean',japanese:'Japanese',mandarin:'Mandarin',english:'English'};
function websiteRoute(session){
 const m=session.metadata||{};
 if(m.wl_checkout_flow!=='website-session-v1')return undefined;
 if(!session.livemode)throw new Error('Website order must be a live Stripe checkout.');
 if(['mobile_monthly','mobile_permanent'].includes(m.wl_website_offer))return {mobileOnly:true};
 if(!['single','polyglot','premium'].includes(m.wl_website_offer))throw new Error('Unknown website offer.');
 if(!['steam','direct'].includes(m.wl_desktop_delivery))throw new Error('Missing website delivery choice.');
 if(m.wl_website_offer==='single'&&!languages[m.wl_learning_language])throw new Error('Missing website learning language.');
 const playMode=m.wl_desktop_delivery==='steam'?'STEAM':'DIRECT';
 const product=playMode==='DIRECT'?'POLY_ITCH':m.wl_website_offer==='single'?languages[m.wl_learning_language]:'POLY_STEAM';
 return {product,playMode};
}
module.exports={websiteRoute};
