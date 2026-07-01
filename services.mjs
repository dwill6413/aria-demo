// Shared third-party client singletons (R1 split, July 1 2026). Previously
// module-scope consts in server.mjs; dotenvConfig() runs here because these
// constructors read env at import time (it no-ops for already-set vars).
import Stripe from 'stripe';
import { Resend } from 'resend';
import { dotenvConfig } from './config.mjs';

dotenvConfig();

export const resend = new Resend(process.env.RESEND_API_KEY);
export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
