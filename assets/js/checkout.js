/**
 * checkout.js — Client-Side Checkout Engine
 * SOLNET — Cargador Retráctil 60w
 *
 * Architecture (mirrors server-side src/ modules):
 *   PurchasesDB        ← src/lib/db/purchases.js   (in-memory mock)
 *   MockCheckoutProvider ← src/lib/checkout-provider.js
 *   CheckoutAPI        ← src/api/checkout.js        (route handlers)
 *
 * To go live: replace CheckoutAPI methods with fetch('/api/...') calls.
 */

'use strict';

// ================================================================
// PurchasesDB — In-Memory Store
// Mirrors schema from: .agents/skills/mercadopago-integration/assets/migration.sql
// Production: swap with Prisma | pg | Supabase (see src/lib/db/purchases.js)
// ================================================================
const _DB = { purchases: [], purchase_items: [] };

function _uuid() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
}

const PurchasesDB = {
    create({ user_email, status = 'pending', total_amount }) {
        const p = {
            id: _uuid(), user_email,
            provider_payment_id: null, provider_preference_id: null,
            status, total_amount,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
        };
        _DB.purchases.push(p);
        return Promise.resolve({ id: p.id });
    },
    update(id, data) {
        const p = _DB.purchases.find(x => x.id === id);
        if (p) Object.assign(p, data, { updated_at: new Date().toISOString() });
        return Promise.resolve();
    },
    getStatus(id) {
        const p = _DB.purchases.find(x => x.id === id);
        return Promise.resolve(p
            ? { id: p.id, status: p.status, total_amount: p.total_amount }
            : null
        );
    },
    /** Atomic update — prevents race conditions on status transitions */
    updateAtomically(id, expectedStatus, data) {
        const p = _DB.purchases.find(x => x.id === id && x.status === expectedStatus);
        if (!p) return Promise.resolve(false);
        Object.assign(p, data, { updated_at: new Date().toISOString() });
        return Promise.resolve(true);
    },
    createItems(purchaseId, items) {
        items.forEach(item => _DB.purchase_items.push({
            id: _uuid(), purchase_id: purchaseId,
            item_id: item.item_id, price: item.price
        }));
        return Promise.resolve();
    }
};

// ================================================================
// MockCheckoutProvider
// Implements CheckoutProvider interface (server-implementation.md)
// TODO 🔐: Replace with real MP SDK — see SECURITY HANDOFF below
// ================================================================
const MockCheckoutProvider = {
    async createSession({ orderId, amount, currency, user_email }) {
        const { id: purchaseId } = await PurchasesDB.create(
            { user_email, status: 'pending', total_amount: amount }
        );
        await PurchasesDB.createItems(purchaseId, [
            { item_id: 'cargador-retractil-60w', price: amount }
        ]);
        const sessionId = `mock_${purchaseId}_${orderId}`;
        await PurchasesDB.update(purchaseId, { provider_preference_id: sessionId });
        return {
            sessionId, purchaseId,
            redirectUrl: `/checkout/mock/${sessionId}`,
            expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString()
        };
    },
    async getStatus({ sessionId, purchaseId, forceResult }) {
        await new Promise(r => setTimeout(r, 800));
        const status = forceResult || (() => {
            const tail = sessionId.slice(-1);
            return tail === '0' ? 'rejected' : tail === '1' ? 'pending' : 'approved';
        })();
        await PurchasesDB.updateAtomically(purchaseId, 'pending', {
            status,
            provider_payment_id: `pay_${Math.random().toString(36).substr(2, 12)}`
        });
        return { status };
    },
    getPurchaseRecord: (purchaseId) => PurchasesDB.getStatus(purchaseId)
};

/* 🔐 SECURITY HANDOFF — Producción
 * ────────────────────────────────────────────────────────────────
 * 1. npm install mercadopago
 * 2. import { MercadoPagoConfig, Preference, Payment } from 'mercadopago'
 * 3. const mp = new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN })
 * 4. createSession → preference.create({ body: { items, back_urls, auto_return:'approved' }})
 * 5. getStatus     → payment.get({ id: paymentId })
 * 6. Webhook IPN   → POST /api/checkout/webhook — validar X-Signature antes de actualizar DB
 * 7. NUNCA exponer MP_ACCESS_TOKEN al frontend
 * 8. updatePurchaseStatusAtomically() para evitar race conditions en webhooks
 * ────────────────────────────────────────────────────────────────
 */

// ================================================================
// CheckoutAPI — Route Handler Proxies
// In production: replace each method body with a fetch() call
//   e.g. CheckoutAPI.createCheckout → fetch('/api/checkout', { method:'POST', ... })
// ================================================================
const CheckoutAPI = {
    async createCheckout({ user_email }) {
        if (!user_email || !user_email.includes('@'))
            return { error: 'Email inválido', httpStatus: 400 };
        const orderId = `order_${Date.now().toString(36)}`;
        const session = await MockCheckoutProvider.createSession(
            { orderId, amount: 24990, currency: 'ARS', user_email }
        );
        return { ...session, httpStatus: 200 };
    },
    async confirmCheckout({ sessionId, purchaseId, forceResult }) {
        const { status } = await MockCheckoutProvider.getStatus(
            { sessionId, purchaseId, forceResult }
        );
        return { status, httpStatus: 200 };
    },
    async getStatus({ purchaseId }) {
        const record = await MockCheckoutProvider.getPurchaseRecord(purchaseId);
        if (!record) return { error: 'No encontrado', httpStatus: 404 };
        return { status: record.status, total_amount: record.total_amount, httpStatus: 200 };
    }
};

// ================================================================
// localStorage Store — Order History
// ================================================================
const STORAGE_KEY = 'mp_mock_orders';
const SESSION_KEY = 'mp_active_session';
let activeSession       = null;
let pollingInterval     = null;
let pollingAttempts     = 0;
const MAX_POLLS         = 4;
let pendingPaymentResult = null;

function getOrders() {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
}

function saveOrder(order) {
    const orders = getOrders();
    if (orders.find(o => o.sessionId === order.sessionId)) return; // idempotency
    orders.unshift({
        ...order,
        id:   'MP-' + Math.random().toString(36).substr(2, 9).toUpperCase(),
        date: new Date().toLocaleString('es-AR')
    });
    localStorage.setItem(STORAGE_KEY, JSON.stringify(orders));
    renderOrders();
}

function clearOrders() {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(SESSION_KEY);
    renderOrders();
}

function renderOrders() {
    const list   = document.getElementById('ordersList');
    const orders = getOrders();
    if (orders.length === 0) {
        list.innerHTML = '<div class="text-center py-10 text-slate-500"><p class="text-xs">No hay órdenes simuladas aún.</p></div>';
        return;
    }
    const statusLabel = { approved: 'Aprobado', rejected: 'Rechazado', pending: 'Pendiente' };
    list.innerHTML = orders.map(order => `
        <div class="bg-white/5 border border-white/5 p-4 rounded-2xl space-y-2">
            <div class="flex justify-between items-start">
                <span class="text-[10px] text-slate-400 font-mono">${order.id}</span>
                <span class="order-badge badge-${order.status}">${statusLabel[order.status] || order.status}</span>
            </div>
            <div class="flex justify-between items-end">
                <div>
                    <p class="text-xs text-white font-bold">${order.email}</p>
                    <p class="text-[9px] text-slate-500 font-mono">${order.sessionId || ''}</p>
                    <p class="text-[9px] text-slate-500">${order.date}</p>
                </div>
                <p class="text-sm font-black text-primary">$24.990 ARS</p>
            </div>
        </div>
    `).join('');
}

function toggleHistory() {
    document.getElementById('historyDrawer').classList.toggle('active');
    renderOrders();
}

// ================================================================
// Checkout Modal — Step 1: Summary + Email
// ================================================================
function openCheckoutModal() {
    document.getElementById('checkoutModal').classList.add('active');
    resetModal();
}

function closeCheckoutModal() {
    document.getElementById('checkoutModal').classList.remove('active');
}

function resetModal() {
    document.getElementById('modalSummary').classList.remove('hidden');
    ['modalLoading', 'modalSuccess', 'modalError'].forEach(id =>
        document.getElementById(id).classList.add('hidden')
    );
    document.getElementById('checkoutEmail').value = localStorage.getItem('last_mp_email') || '';
}

function processToPayment() {
    const emailInput = document.getElementById('checkoutEmail');
    if (!emailInput.value || !emailInput.value.includes('@')) {
        emailInput.classList.add('border-red-500');
        setTimeout(() => emailInput.classList.remove('border-red-500'), 1000);
        return;
    }
    localStorage.setItem('last_mp_email', emailInput.value);
    document.getElementById('displayEmail').innerText = emailInput.value;

    document.getElementById('modalSummary').classList.add('hidden');
    document.getElementById('modalLoading').classList.remove('hidden');
    document.getElementById('modalLoading').querySelector('p').textContent = 'Generando sesión segura...';

    // POST /api/checkout
    CheckoutAPI.createCheckout({ user_email: emailInput.value })
        .then(response => {
            if (response.error) { openCheckoutModal(); return; }
            activeSession = { ...response, email: emailInput.value };
            localStorage.setItem(SESSION_KEY, JSON.stringify(activeSession));
            closeCheckoutModal();
            openMpGateway(response.sessionId);
        });
}

// ================================================================
// Mock MP Gateway Screen
// ================================================================
function openMpGateway(sessionId) {
    document.getElementById('gatewaySessionId').textContent = sessionId;
    document.getElementById('mpGatewayActions').classList.remove('hidden');
    document.getElementById('mpGatewayProcessing').classList.add('hidden');
    document.getElementById('mpGatewayProcessing').style.display = '';
    document.querySelector('input[name="mp_method"][value="card"]').checked = true;
    highlightSelectedMethod();
    document.getElementById('mpGateway').classList.add('active');
    document.querySelectorAll('input[name="mp_method"]').forEach(radio => {
        radio.addEventListener('change', highlightSelectedMethod);
    });
}

function highlightSelectedMethod() {
    const opts = { card: 'mp-opt-card', transfer: 'mp-opt-transfer', cash: 'mp-opt-cash' };
    const selected = document.querySelector('input[name="mp_method"]:checked').value;
    Object.entries(opts).forEach(([val, id]) => {
        const el = document.getElementById(id);
        if (val === selected) {
            el.classList.add('border-blue-400', 'bg-blue-50');
            el.classList.remove('border-gray-200');
        } else {
            el.classList.remove('border-blue-400', 'bg-blue-50');
            el.classList.add('border-gray-200');
        }
    });
}

function cancelGateway() {
    document.getElementById('mpGateway').classList.remove('active');
    openCheckoutModal();
}

function submitGatewayPayment() {
    document.getElementById('mpGatewayActions').classList.add('hidden');
    const processingEl = document.getElementById('mpGatewayProcessing');
    processingEl.classList.remove('hidden');
    processingEl.style.display = 'flex';

    // Tarjeta ~85% éxito, otros métodos ~60%
    const method = document.querySelector('input[name="mp_method"]:checked').value;
    const successRate = method === 'card' ? 0.85 : 0.6;
    pendingPaymentResult = Math.random() < successRate ? 'approved' : 'rejected';

    pollingAttempts = 0;
    startPolling();
}

function startPolling() {
    const pollingMessages = [
        'Verificando sesión...',
        'Validando fondos disponibles...',
        'Aplicando protocolos de seguridad...',
        'Confirmando transacción...'
    ];
    const bar = document.getElementById('mpProgressBar');

    pollingInterval = setInterval(() => {
        pollingAttempts++;
        bar.style.width = (pollingAttempts / MAX_POLLS * 100) + '%';
        document.getElementById('mpPollingStatus').textContent =
            pollingMessages[pollingAttempts - 1] || 'Finalizando...';

        if (pollingAttempts >= MAX_POLLS) {
            clearInterval(pollingInterval);
            // POST /api/checkout/confirm
            CheckoutAPI.confirmCheckout({
                sessionId:   activeSession.sessionId,
                purchaseId:  activeSession.purchaseId,
                forceResult: pendingPaymentResult
            }).then(({ status }) => {
                document.getElementById('mpGateway').classList.remove('active');
                handleFinalStatus(status);
            });
        }
    }, 900);
}

// ================================================================
// Final Resolution
// ================================================================
function handleFinalStatus(status) {
    saveOrder({
        email:     activeSession.email,
        sessionId: activeSession.sessionId,
        status
    });

    openCheckoutModal();
    resetModal();
    document.getElementById('modalSummary').classList.add('hidden');
    document.getElementById('displayEmail').innerText = activeSession.email;

    document.getElementById(status === 'approved' ? 'modalSuccess' : 'modalError')
        .classList.remove('hidden');

    activeSession       = null;
    pendingPaymentResult = null;
}

function startMockPayment() {
    closeCheckoutModal();
    if (activeSession) openMpGateway(activeSession.sessionId);
    else openCheckoutModal();
}

// ── Init ─────────────────────────────────────────────────────────
renderOrders();
