// Shared booking-price math used by pages/listing/[id].jsx (the booking
// widget). Pulled out of pages/index.jsx so there's exactly one place these
// formulas live — the actual charge is still always recomputed server-side
// (bookings.mjs) from catalog.mjs; these are display-only mirrors of that
// same math so the guest sees the right numbers before they sign.
export const getJurisdiction = (p) => (p?.taxRate != null ? { rate: p.taxRate, name: p.taxName } : { rate: 0.08, name: 'Occupancy Tax' });
export const getSubtotal     = (p, n) => p.price * n;
export const getAriaFee      = (p, n) => Math.round(getSubtotal(p, n) * 0.05);
export const getTax          = (p, n) => Math.round(getSubtotal(p, n) * getJurisdiction(p).rate);
export const getBookingTotal = (p, n) => getSubtotal(p, n) + getAriaFee(p, n) + getTax(p, n);
export const getDeposit      = (p, n) => Math.round(getBookingTotal(p, n) * 0.20);
export const getChargeTotal  = (p, n) => getBookingTotal(p, n) + getDeposit(p, n);
// M6: getCardTotal/getCardFee now apply Stripe's processing surcharge to the
// stay cost only (getBookingTotal), not getChargeTotal (which includes the
// refundable deposit). The 