/**
 * @fileoverview CheckoutProvider — Mock Adapter
 * Based on: mercadopago-integration skill — server-implementation.md
 *
 * Implements the CheckoutProvider interface:
 *   createSession({ orderId, amount, currency }) → CheckoutSession
 *   getStatus({ sessionId })                     → { status: CheckoutStatus }
 *
 * CheckoutStatus: 'pending' | 'approved' | 'rejected'
 *
 * TODO 🔐 SECURITY HANDOFF — for live MercadoPago:
 *   1. npm install mercadopago
 *   2. Initialize with: new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN })
 *   3. Replace createSession → preference.create({ body: { items, back_urls, ... } })
 *   4. Replace getStatus   → payment.get({ id: sessionId })
 *   5. Verify IPN/webhook signatures before updating DB
 *   6. Never expose MP_ACCESS_TOKEN to the frontend
 */

import {
  createPurchase,
  updatePurchase,
  getPurchaseStatus,
  updatePurchaseStatusAtomically,
  createPurchaseItems,
} from './db/purchases.js';

// ============================================================
// Product catalog (static for now — connect to DB later)
// ============================================================
export const PRODUCT = {
  id: 'cargador-retractil-60w',
  name: 'Cargador Retráctil 60w',
  description: 'Carga Ultra Rápida 4 en 1 — SOLNET',
  price: 24990, // ARS
  currency: 'ARS',
};

// ============================================================
// MockCheckoutProvider
// ============================================================
export const MockCheckoutProvider = {

  /**
   * createSession({ orderId, amount, currency })
   * → Persists a new purchase row in 'pending' status
   * → Returns { sessionId, redirectUrl, expiresAt }
   */
  async createSession({ orderId, amount, currency, user_email }) {
    // 1. Insert purchase record (mirrors real MP preference creation)
    const { id: purchaseId } = await createPurchase({
      user_email,
      status: 'pending',
      total_amount: amount,
    });

    // 2. Insert associated line items
    await createPurchaseItems(purchaseId, [{
      item_id: PRODUCT.id,
      price: amount,
    }]);

    // 3. Build session (mirrors MP preference response)
    const sessionId = `mock_${purchaseId}_${orderId}`;

    // 4. Update purchase with mock preference ID (mirrors provider_preference_id)
    await updatePurchase(purchaseId, {
      provider_preference_id: sessionId,
    });

    return {
      sessionId,
      purchaseId,
      redirectUrl: `/checkout/mock/${sessionId}`,
      expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    };
  },

  /**
   * getStatus({ sessionId, purchaseId, forceResult? })
   * → Reads status from DB (mirrors GET /payment/:id from real MP)
   * → forceResult allows the gateway UI to inject the final outcome
   */
  async getStatus({ sessionId, purchaseId, forceResult }) {
    // Simulate network latency
    await new Promise(r => setTimeout(r, 800));

    if (forceResult) {
      // Atomically update status (prevents race conditions / double-processing)
      await updatePurchaseStatusAtomically(
        purchaseId,
        'pending',
        {
          status: forceResult,
          provider_payment_id: `pay_${Math.random().toString(36).substr(2, 12)}`,
        }
      );
      return { status: forceResult };
    }

    // Deterministic fallback based on session tail (mirrors skill's getStatus)
    const tail = sessionId.slice(-1);
    const status = tail === '0' ? 'rejected' : tail === '1' ? 'pending' : 'approved';

    await updatePurchaseStatusAtomically(purchaseId, 'pending', { status });
    return { status };
  },

  /**
   * getPurchaseStatus(purchaseId)
   * → Used for polling / status page after redirect back
   */
  async getPurchaseRecord(purchaseId) {
    return getPurchaseStatus(purchaseId);
  },
};

export default MockCheckoutProvider;
