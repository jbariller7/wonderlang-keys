const {test}=require('node:test');
const assert=require('node:assert/strict');
const {forwardingPolicy}=require('../netlify/functions/lib/forwarding-policy.cjs');
const event=(type,flow)=>({type,data:{object:{metadata:{wl_checkout_flow:flow}}}});
test('VIP checkout completion is forwarded and cannot reach game fulfillment',()=>{
 for(const type of ['checkout.session.completed','checkout.session.async_payment_succeeded'])assert.deepEqual(forwardingPolicy(event(type,'beyond-vip-reservation-v1')),{forward:true,stopBeforeFulfillment:true});
});
test('existing website purchases retain forwarding and normal fulfillment',()=>assert.deepEqual(forwardingPolicy(event('checkout.session.completed','website-session-v1')),{forward:true,stopBeforeFulfillment:false}));
test('old Payment Link purchases retain their existing fulfillment',()=>assert.deepEqual(forwardingPolicy(event('checkout.session.completed',undefined)),{forward:false,stopBeforeFulfillment:false}));
test('refunds and disputes reach the receiver for verified Stripe ownership classification',()=>{
 for(const type of ['charge.refunded','charge.dispute.created','charge.dispute.closed'])assert.deepEqual(forwardingPolicy(event(type,undefined)),{forward:true,stopBeforeFulfillment:false});
});
