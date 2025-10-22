export const PLANS = {
  free: { code:'free', label:'Free', maxWatches:1, minFrequencyMinutes:180, channels:['email'] },
  pro: { code:'pro', label:'Pro', maxWatches:3, minFrequencyMinutes:60, channels:['email','sms','whatsapp'] },
  agency: { code:'agency', label:'Agency', maxWatches:50, minFrequencyMinutes:15, channels:['email','sms','whatsapp'] },
};
export function planFromStripePrice(priceId){
  if (!priceId) return 'free';
  if (priceId === process.env.STRIPE_PRICE_PRO) return 'pro';
  if (priceId === process.env.STRIPE_PRICE_AGENCY) return 'agency';
  return 'free';
}
