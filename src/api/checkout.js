/**
 * @fileoverview Mock API Routes — Checkout
 * Based on: mercadopago-integration skill — server-implementation.md
 *
 * These are the server-side route handlers.
 * In a real Next.js project these become:
 *   POST /api/checkout         → app/api/checkout/route.ts
 *   GET  /api/checkout/status  → app/api/checkout/status/route.ts
 *   POST /api/checkout/webhook → app/api/checkout/webhook/route.ts  (future)
 *
 * Currently exported as plain async functions callable from the mock
 * in-page simulation. Replace with fetch() calls when using a real server.
 */

import MockCheckoutProvider, { PRODUCT } from '../lib/checkout-provider.js';

// ============================================================
// POST /api/checkout
// Body: { user_email: string }
// Returns: { sessionId, purchaseId, redirectUrl, expiresAt }
// ============================================================
export async function handleCreateCheckout({ user_email }) {
  if (!user_email || !user_email.includes('@')) {
    return { error: 'Email inválido', status: 400 };
  }

  try {
    const orderId = `order_${Date.now().toString(36)}`;
    const session = await MockCheckoutProvider.createSession({
      orderId,
      amount:     PRODUCT.price,
      currency:   PRODUCT.currency,
      user_email,
    });

    return { ...session, status: 200 };
  } catch (err) {
    console.error('[checkout] Error creating session:', err);
    return { error: 'Error interno al crear sesión', status: 500 };
  }
}

// ============================================================
// GET /api/checkout/status?purchaseId=xxx
// Returns: { status: 'pending' | 'approved' | 'rejected', total_amount }
// ============================================================
export async function handleGetStatus({ purchaseId }) {
  if (!purchaseId) return { error: 'purchaseId requerido', status: 400 };

  try {
    const record = await MockCheckoutProvider.getPurchaseRecord(purchaseId);
    if (!record) return { error: 'Compra no encontrada', status: 404 };
    return { status: record.status, total_amount: record.total_amount, httpStatus: 200 };
  } catch (err) {
    console.error('[checkout] Error getting status:', err);
    return { error: 'Error interno', status: 500 };
  }
}

// ============================================================
// POST /api/checkout/confirm (gateway confirm action)
// Body: { sessionId, purchaseId, paymentMethod, forceResult }
// Used by gateway UI to finalise the mock payment
// ============================================================
export async function handleConfirmCheckout({ sessionId, purchaseId, paymentMethod, forceResult }) {
  if (!sessionId || !purchaseId) {
    return { error: 'sessionId y purchaseId son requeridos', status: 400 };
  }

  try {
    const { status } = await MockCheckoutProvider.getStatus({
      sessionId,
      purchaseId,
      forceResult,
    });
    return { status, httpStatus: 200 };
  } catch (err) {
    console.error('[checkout] Error confirming payment:', err);
    return { error: 'Error al confirmar pago', status: 500 };
  }
}

/**
 * TODO 🔐 SECURITY HANDOFF — Webhook handler (IPN)
 *
 * POST /api/checkout/webhook
 * - Validate X-Signature header from MercadoPago
 * - Parse payment.id from body
 * - Call real MP SDK: payment.get({ id })
 * - Use updatePurchaseStatusAtomically() to prevent race conditions
 * - Return 200 OK immediately (async processing)
 *
 * NEVER trust the status from the webhook body directly.
 * Always re-fetch from MP API to verify.
 */
