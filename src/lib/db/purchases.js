/**
 * @fileoverview Purchase Database Helper (Mock/In-Memory)
 * Based on: mercadopago-integration skill — database-postgresql.md
 *
 * IMPORTANTE: Este archivo implementa la misma interfaz que los helpers de
 * Prisma, PostgreSQL y Supabase definidos en el skill, pero usando memoria
 * en lugar de una base de datos real.
 *
 * Para producción, reemplazar este archivo con:
 *   - database-prisma.md     → si usás Prisma ORM
 *   - database-postgresql.md → si usás pg directo o Drizzle
 *   - database-supabase.md   → si usás Supabase
 *
 * El schema SQL está en assets/migration.sql
 *
 * TODO 🔐 SECURITY HANDOFF:
 *  - Conectar DATABASE_URL en variables de entorno
 *  - Verificar signatures de webhooks IPN
 *  - Implementar idempotency keys en createPurchase
 *  - Auditar accesos con logging
 */

// ============================================================
// In-Memory Store (simula la tabla `purchases` de PostgreSQL)
// Estructura espeja exactamente el schema de assets/migration.sql
// ============================================================
const inMemoryDB = {
  purchases: [],    // { id, user_email, provider_payment_id, provider_preference_id, status, total_amount, created_at, updated_at }
  purchase_items: []// { id, purchase_id, item_id, price }
};

function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

// ============================================================
// createPurchase({ user_email, status, total_amount })
// Equivalent to: INSERT INTO purchases (...) RETURNING id
// ============================================================
export function createPurchase({ user_email, status = 'pending', total_amount }) {
  const purchase = {
    id:                     uuid(),
    user_email,
    provider_payment_id:    null,
    provider_preference_id: null,
    status,
    total_amount,
    created_at:             new Date().toISOString(),
    updated_at:             new Date().toISOString(),
  };
  inMemoryDB.purchases.push(purchase);
  return Promise.resolve({ id: purchase.id });
}

// ============================================================
// updatePurchase(id, { status, provider_payment_id, ... })
// Equivalent to: UPDATE purchases SET ... WHERE id = $1
// ============================================================
export function updatePurchase(id, data) {
  const purchase = inMemoryDB.purchases.find(p => p.id === id);
  if (!purchase) return Promise.resolve(null);
  Object.assign(purchase, data, { updated_at: new Date().toISOString() });
  return Promise.resolve();
}

// ============================================================
// getPurchaseStatus(id)
// Equivalent to: SELECT id, status, total_amount FROM purchases WHERE id = $1
// ============================================================
export function getPurchaseStatus(id) {
  const purchase = inMemoryDB.purchases.find(p => p.id === id);
  if (!purchase) return Promise.resolve(null);
  return Promise.resolve({
    id: purchase.id,
    status: purchase.status,
    total_amount: purchase.total_amount,
  });
}

// ============================================================
// updatePurchaseStatusAtomically(id, expectedStatus, data)
// Equivalent to: UPDATE purchases SET ... WHERE id=$1 AND status=$2
// Prevents race conditions on status transitions
// ============================================================
export function updatePurchaseStatusAtomically(id, expectedStatus, data) {
  const purchase = inMemoryDB.purchases.find(
    p => p.id === id && p.status === expectedStatus
  );
  if (!purchase) return Promise.resolve(false);
  Object.assign(purchase, data, { updated_at: new Date().toISOString() });
  return Promise.resolve(true);
}

// ============================================================
// createPurchaseItems(purchaseId, [{ item_id, price }])
// Equivalent to: INSERT INTO purchase_items (...) VALUES ...
// ============================================================
export function createPurchaseItems(purchaseId, items) {
  const rows = items.map(item => ({
    id:          uuid(),
    purchase_id: purchaseId,
    item_id:     item.item_id,
    price:       item.price,
  }));
  inMemoryDB.purchase_items.push(...rows);
  return Promise.resolve();
}

// ============================================================
// listPurchasesByEmail(email) — helper extra para el historial
// ============================================================
export function listPurchasesByEmail(email) {
  return Promise.resolve(
    inMemoryDB.purchases
      .filter(p => p.user_email === email)
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
  );
}

// Dev-only: expose in-memory store for debugging
export const _db = inMemoryDB;
