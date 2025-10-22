import Stripe from 'stripe';
import { upsertUserByEmail, setUserPlan } from './db.js';
import { planFromStripePrice } from './plans.js';

const stripe = process.env.STRIPE_SECRET ? new Stripe(process.env.STRIPE_SECRET) : null;
export function hasStripe(){ return !!stripe; }

export async function createCheckoutSession({ email, plan }){
  if (!stripe) throw new Error('Stripe not configured');
  const price =
    plan === 'pro' ? process.env.STRIPE_PRICE_PRO :
    plan === 'agency' ? process.env.STRIPE_PRICE_AGENCY : null;
  if (!price) throw new Error('Missing price id for plan');
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer_email: email,
    line_items: [{ price, quantity: 1 }],
    success_url: process.env.STRIPE_PORTAL_RETURN_URL || 'http://localhost:8787',
    cancel_url: process.env.STRIPE_PORTAL_RETURN_URL || 'http://localhost:8787'
  });
  return session;
}
export function stripeWebhookHandler(rawBody, signature){
  if (!stripe) throw new Error('Stripe not configured');
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  const event = stripe.webhooks.constructEvent(rawBody, signature, secret);
  if (event.type === 'checkout.session.completed'){
    const session = event.data.object;
    const email = session.customer_details?.email || session.customer_email;
    const line = session?.display_items?.[0]?.plan?.id || session?.line_items?.data?.[0]?.price?.id;
    if (email){
      upsertUserByEmail(email);
      const p = planFromStripePrice(line);
      setUserPlan(email, p);
      console.log('[Stripe] Set plan', email, p);
    }
  }
  return { received:true };
}
