const {test}=require('node:test');
const assert=require('node:assert/strict');
const {websiteRoute}=require('../netlify/functions/lib/website-route.cjs');
const session=(offer,delivery='steam',language='french')=>({livemode:true,metadata:{wl_checkout_flow:'website-session-v1',wl_website_offer:offer,wl_desktop_delivery:delivery,wl_learning_language:language}});
test('old payment links keep their existing router',()=>assert.equal(websiteRoute({metadata:{}}),undefined));
test('all desktop offers reach their correct inventory',()=>{
 assert.deepEqual(websiteRoute(session('single')),{product:'French',playMode:'STEAM'});
 assert.deepEqual(websiteRoute(session('single','steam','mandarin')),{product:'Mandarin',playMode:'STEAM'});
 for(const offer of ['single','polyglot','premium'])assert.deepEqual(websiteRoute(session(offer,'direct')),{product:'POLY_ITCH',playMode:'DIRECT'});
 for(const offer of ['polyglot','premium'])assert.deepEqual(websiteRoute(session(offer)),{product:'POLY_STEAM',playMode:'STEAM'});
});
test('mobile orders never receive PC keys',()=>{
 for(const offer of ['mobile_monthly','mobile_permanent'])assert.deepEqual(websiteRoute(session(offer)),{mobileOnly:true});
});
test('invalid new orders are not routed to a fallback product',()=>{
 assert.throws(()=>websiteRoute(session('unknown')));
 assert.throws(()=>websiteRoute(session('premium','unknown')));
 assert.throws(()=>websiteRoute(session('single','steam','unknown')));
 assert.throws(()=>websiteRoute({...session('premium'),livemode:false}));
});
