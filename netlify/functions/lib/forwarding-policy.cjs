// VIP reservations must reach the private reservation database, but must never
// allocate a game key, grant game access, or trigger a game-order mailing flow.
function forwardingPolicy(event){
 const flow=event.data.object.metadata?.wl_checkout_flow;
 const vip=event.type.startsWith('checkout.session.')&&flow==='beyond-vip-reservation-v1';
 const website=flow==='website-session-v1';
 const lifecycle=['invoice.paid','invoice.payment_failed','customer.subscription.created','customer.subscription.updated','customer.subscription.deleted','customer.subscription.paused','customer.subscription.resumed','charge.refunded','charge.dispute.created','charge.dispute.closed'].includes(event.type);
 return {forward:vip||website||lifecycle,stopBeforeFulfillment:vip};
}
module.exports={forwardingPolicy};
