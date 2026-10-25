// Data Store (Mock Database & Subscriptions)
const PRICING = {
    walkin: { name: 'Walk-in / Per Session', price: 50, duration: '1 Session' },
    monthly: { name: 'Monthly Standard Plan', price: 500, duration: '1 Month' },
    '6month': { name: '6-Month Plan (₱450/mo)', price: 2700, duration: '6 Months' },
    trainer: 1500
};

let customersData = [];
let ordersPageData = [];
let membersData = [];
let editingMemberId = null;
let memberRefreshTimeout;
let adminDataLoaded = false;
let adminUnlocked = false;
let mfaChallengePending = false;

let currentAdminTab = 'customers';
let revenueChart;
let orderSearchQuery = '';
let orderStatusFilter = 'All';
let orderPageOffset = 0;
let orderPageTotal = 0;
let pendingOrderCount = 0;
let paymentReturnFocus = null;
const ORDER_PAGE_SIZE = 25;

// Calculate Plan Summary
function calculateTotal() {
    const selectedPlan = document.querySelector('input[name="planSelection"]:checked').value;
    const hasTrainer = document.getElementById('trainerAddon').checked;

    const planDetails = PRICING[selectedPlan];
    let total = planDetails.price;
    let trainerCost = 0;

    if (hasTrainer) {
        trainerCost = PRICING.trainer;
        total += trainerCost;
    }

    // Update UI elements
    document.getElementById('summaryPlanName').textContent = planDetails.name;
    document.getElementById('summaryPlanCost').textContent = `₱${planDetails.price.toLocaleString()}`;
    document.getElementById('summaryTrainerCost').textContent = hasTrainer ? `₱${PRICING.trainer.toLocaleString()}` : '₱0';
    document.getElementById('summaryGrandTotal').textContent = `₱${total.toLocaleString()}`;

    return { selectedPlan, planDetails, hasTrainer, total };
}

function selectPlanInCalc(planKey) {
    const radio = document.querySelector(`input[name="planSelection"][value="${planKey}"]`);
    if (radio) {
        radio.checked = true;
        calculateTotal();
        scrollToCalculator();
    }
}

function scrollToCalculator() {
    document.getElementById('calculator').scrollIntoView({ behavior: 'smooth' });
}

async function getAdminSessionState() {
    try {
        const response = await fetch('/api/session', {
            method: 'GET',
            credentials: 'same-origin',
            headers: { 'Accept': 'application/json' }
        });

        if (!response.ok) {
            return { authenticated: false, user: null };
        }

        const data = await response.json();
        return { authenticated: !!data.authenticated, user: data.user || null };
    } catch (error) {
        return { authenticated: false, user: null };
    }
}

function updatePortalButtonState(isAuthenticated) {
    const portalBtnText = document.getElementById('portalBtnText');
    if (portalBtnText) {
        const dashboardVisible = !document.getElementById('adminView').classList.contains('hidden');
        portalBtnText.textContent = dashboardVisible ? 'Public Website' : 'Admin Dashboard';
    }
}

function openAdminLoginModal() {
    const modal = document.getElementById('adminLoginModal');
    if (modal) {
        modal.classList.remove('hidden');
        setTimeout(() => document.getElementById('adminUsername')?.focus(), 100);
    }
}

function closeAdminLoginModal() {
    const modal = document.getElementById('adminLoginModal');
    if (modal) {
        modal.classList.add('hidden');
    }
    const statusEl = document.getElementById('adminLoginStatus');
    if (statusEl) {
        statusEl.textContent = 'Only authorized administrators may sign in.';
        statusEl.className = 'text-xs text-gray-400 min-h-[20px]';
    }
    mfaChallengePending = false;
    document.getElementById('adminMfaStep')?.classList.add('hidden');
    document.getElementById('adminMfaCode').required = false;
    document.getElementById('adminMfaQr')?.classList.add('hidden');
    document.getElementById('adminMfaSetupSecret')?.classList.add('hidden');
    const form = document.getElementById('adminLoginForm');
    if (form) {
        form.reset();
    }
}

async function showSection(view) {
    if (view === 'public') {
        document.getElementById('publicView').classList.remove('hidden');
        document.getElementById('adminView').classList.add('hidden');
        updatePortalButtonState(adminUnlocked);
        return;
    }

    if (view === 'admin') {
        const session = await getAdminSessionState();
        document.getElementById('publicView').classList.add('hidden');
        document.getElementById('adminView').classList.remove('hidden');
        adminUnlocked = session.authenticated;
        updatePortalButtonState(adminUnlocked);
        document.getElementById('adminTabNavigation').classList.toggle('hidden', !adminUnlocked);
        document.getElementById('adminActions').classList.toggle('hidden', !adminUnlocked);
        document.getElementById('resetDashboardRecordsButton').classList.toggle(
            'hidden',
            !adminUnlocked || session.user?.role !== 'owner'
        );
        document.getElementById('adminCodeButton').classList.toggle('hidden', adminUnlocked);
        if (!adminUnlocked) {
            await renderPublicDashboardOverview();
            return;
        }
        try {
            await loadAdminData();
            adminDataLoaded = true;
            updateAdminStats();
        } catch (error) {
            showAdminDataError(error);
            return;
        }
        renderAdminTabContent();
    }
}

async function renderPublicDashboardOverview() {
    const container = document.getElementById('adminTabContent');
    container.innerHTML = `
        <section class="bg-cardbg border border-gray-800 rounded-2xl p-6 space-y-3">
            <h2 class="text-xl font-bold text-white">Gym overview</h2>
            <p class="text-sm text-gray-400">This is a read-only summary. Customer details, member records, payments, and admin tools are available only after entering the admin code.</p>
            <button onclick="openAdminLoginModal()" class="bg-gold-500 hover:bg-gold-600 text-black px-4 py-2.5 rounded-xl font-bold text-sm">
                <i class="fa-solid fa-key mr-1"></i> Enter admin code to manage the dashboard
            </button>
        </section>
    `;
    try {
        const response = await fetch('/api/dashboard/overview', {
            headers: { Accept: 'application/json' },
            credentials: 'same-origin'
        });
        const overview = await response.json();
        if (!response.ok) throw new Error(overview.message || 'Could not load the public dashboard summary.');
        document.getElementById('statTotalRevenue').textContent = `₱${Number(overview.totalRevenue).toLocaleString()}`;
        document.getElementById('statActiveMembers').textContent = Number(overview.activeMembers).toLocaleString();
        document.getElementById('statWalkins').textContent = Number(overview.walkinsToday).toLocaleString();
        document.getElementById('statTrainers').textContent = Number(overview.trainerCount).toLocaleString();
    } catch (error) {
        console.error('Unable to load public dashboard overview.', error);
        container.insertAdjacentHTML('beforeend', `<p role="alert" class="text-sm text-red-300">${escapeHtml(error.message)}</p>`);
    }
}

async function adminApi(endpoint, options = {}) {
    const headers = { Accept: 'application/json', ...(options.headers || {}) };
    if (options.body) headers['Content-Type'] = 'application/json';
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes((options.method || 'GET').toUpperCase())) {
        headers['X-Requested-With'] = 'fetch';
    }

    const response = await fetch(endpoint, {
        ...options,
        credentials: 'same-origin',
        headers
    });
    if (response.status === 204) return null;

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.toLowerCase().includes('application/json')) {
        throw new Error(`The server returned an unexpected response (HTTP ${response.status}). Check the server or Vercel function logs.`);
    }
    const data = await response.json();
    if (!response.ok) {
        throw new Error(data.message || `Request failed (${response.status}).`);
    }
    return data;
}

async function readLoginResponse(response) {
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.toLowerCase().includes('application/json')) {
        if (!response.ok) {
            throw new Error(`The sign-in service returned an unexpected response (HTTP ${response.status}). Check the Vercel function logs and required environment variables.`);
        }
        throw new Error('The sign-in service returned an unexpected response. Refresh the page and try again.');
    }
    return response.json();
}

async function loadAdminData() {
    const [serverMembers, orders] = await Promise.all([
        adminApi('/api/admin/members'),
        adminApi('/api/admin/orders')
    ]);

    membersData = serverMembers;
    customersData = orders;
    ordersPageData = orders.slice(0, ORDER_PAGE_SIZE);
    orderPageTotal = orders.length;
    pendingOrderCount = orders.filter(order => order.status === 'Unpaid').length;
    updatePendingOrderBadge();

    let legacyMembers;
    try {
        const stored = localStorage.getItem('bbf-members');
        legacyMembers = stored ? JSON.parse(stored) : null;
    } catch (error) {
        console.error('Unable to read legacy browser member records.', error);
        throw new Error('Could not safely read saved member data from this browser.');
    }

    if (Array.isArray(legacyMembers) && legacyMembers.length) {
        const migrationResult = await adminApi('/api/admin/members/import-legacy', {
            method: 'POST',
            body: JSON.stringify({ members: legacyMembers })
        });
        membersData = migrationResult.members;
    }

    if (legacyMembers) {
        try {
            localStorage.removeItem('bbf-members');
        } catch (error) {
            console.error('Unable to clear migrated browser member records.', error);
        }
    }
}

function showAdminDataError(error) {
    console.error('Unable to load dashboard records.', error);
    const container = document.getElementById('adminTabContent');
    container.innerHTML = `
        <div role="alert" class="bg-red-500/10 border border-red-500/30 text-red-200 p-5 rounded-2xl">
            <p class="font-bold">Dashboard data could not be loaded.</p>
            <p class="text-sm mt-1">${escapeHtml(error.message)}</p>
            <button onclick="showSection('admin')" class="mt-3 border border-red-500/40 px-3 py-1.5 rounded-lg text-xs font-semibold hover:bg-red-500/20">Try again</button>
        </div>
    `;
}

async function togglePortal() {
    const isAdminVisible = !document.getElementById('adminView').classList.contains('hidden');
    if (isAdminVisible) {
        showSection('public');
    } else if (adminUnlocked) {
        showSection('admin');
    } else {
        openAdminLoginModal();
    }
}

async function initializeAdminAccess() {
    const session = await getAdminSessionState();
    adminUnlocked = session.authenticated;
    updatePortalButtonState(adminUnlocked);
    if (!session.authenticated) {
        showSection('public');
    } else {
        showSection('admin');
    }
}

async function logoutAdmin() {
    try {
        const response = await fetch('/api/logout', {
            method: 'POST',
            credentials: 'same-origin'
        });
        if (!response.ok) throw new Error(`Logout failed (${response.status}).`);
    } catch (error) {
        console.error('Unable to logout from the server.', error);
        window.alert('The server could not confirm logout. Please try again.');
        return;
    }

    closeAdminLoginModal();
    adminUnlocked = false;
    await showSection('admin');
}

function bindAdminLoginForm() {
    const form = document.getElementById('adminLoginForm');
    if (!form) return;

    form.addEventListener('submit', async function (event) {
        event.preventDefault();

        const statusEl = document.getElementById('adminLoginStatus');
        statusEl.textContent = 'Checking credentials...';
        statusEl.className = 'text-xs text-yellow-300 min-h-[20px]';

        try {
            let data;
            if (!mfaChallengePending) {
                const response = await fetch('/api/login', {
                    method: 'POST',
                    credentials: 'same-origin',
                    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
                    body: JSON.stringify({
                        username: document.getElementById('adminUsername').value,
                        password: document.getElementById('adminPassword').value
                    })
                });
                data = await readLoginResponse(response);
                if (!response.ok) throw new Error(data.message || 'Sign in failed.');

                mfaChallengePending = true;
                document.getElementById('adminMfaStep').classList.remove('hidden');
                document.getElementById('adminMfaCode').required = true;
                document.getElementById('adminMfaCode').focus();
                if (data.mfaSetupRequired) {
                    const qr = document.getElementById('adminMfaQr');
                    qr.src = data.qrCodeDataUrl;
                    qr.classList.remove('hidden');
                    const secret = document.getElementById('adminMfaSetupSecret');
                    secret.textContent = `Manual setup key: ${data.manualSecret}`;
                    secret.classList.remove('hidden');
                    statusEl.textContent = 'Scan the QR code, then enter the authenticator code to finish setup.';
                } else {
                    statusEl.textContent = 'Enter the current authenticator code or a recovery code.';
                }
                statusEl.className = 'text-xs text-yellow-300 min-h-[20px]';
                return;
            }

            const response = await fetch('/api/login/verify-mfa', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
                body: JSON.stringify({ code: document.getElementById('adminMfaCode').value })
            });
            data = await readLoginResponse(response);
            if (!response.ok) throw new Error(data.message || 'Verification failed.');
            statusEl.textContent = 'Admin controls unlocked. Opening dashboard...';
            statusEl.className = 'text-xs text-green-300 min-h-[20px]';
            if (data.recoveryCodes) {
                window.alert(`Save these one-time recovery codes in a secure place. They will not be shown again:\n\n${data.recoveryCodes.join('\n')}`);
            }
            closeAdminLoginModal();
            adminUnlocked = true;
            await showSection('admin');
        } catch (error) {
            statusEl.textContent = error.message || 'Unable to sign in right now. Please try again.';
            statusEl.className = 'text-xs text-red-300 min-h-[20px]';
        }
    });
}

function toggleMobileMenu() {
    document.getElementById('mobileMenu').classList.toggle('hidden');
}

// Registration & Receipt Generation
async function handleRegistrationSubmit(event) {
    event.preventDefault();
    const status = document.getElementById('registrationStatus');
    const submitButton = event.currentTarget.querySelector('[type="submit"]');
    status.textContent = 'Submitting registration and preparing your receipt…';
    status.className = 'text-sm text-yellow-300 min-h-[20px]';
    submitButton.disabled = true;
    const name = document.getElementById('regName').value;
    const phone = document.getElementById('regPhone').value;
    const calc = calculateTotal();

    const dateStr = new Date().toLocaleDateString('en-PH', { year: 'numeric', month: 'short', day: 'numeric' });

    try {
        const order = await adminApi('/api/registrations', {
            method: 'POST',
            body: JSON.stringify({
                name,
                phone,
                email: document.getElementById('regEmail').value.trim(),
                preferredStartDate: document.getElementById('regStartDate').value,
                planKey: calc.selectedPlan,
                trainer: calc.hasTrainer
            })
        });
        if (!order || !order.receiptId || !order.name || !order.phone || !order.plan ||
            !Number.isFinite(Number(order.total)) || !Number.isSafeInteger(Number(order.id))) {
            throw new Error('The registration was received, but the receipt details were incomplete. Please contact the gym before submitting again.');
        }

        document.getElementById('rcptNo').textContent = `#${order.receiptId}`;
        document.getElementById('rcptDate').textContent = dateStr;
        document.getElementById('rcptName').textContent = order.name;
        document.getElementById('rcptPhone').textContent = order.phone;
        document.getElementById('rcptPlanName').textContent = order.plan;
        const planPrice = Number(order.total) - (order.trainer ? PRICING.trainer : 0);
        document.getElementById('rcptPlanPrice').textContent = `₱${planPrice.toLocaleString()}`;
        document.getElementById('rcptTrainerRow').classList.toggle('hidden', !order.trainer);
        document.getElementById('rcptTotal').textContent = `₱${Number(order.total).toLocaleString()}`;
        document.getElementById('rcptStatus').textContent = 'UNPAID / RESERVED';
        document.getElementById('rcptPaymentDetails').classList.add('hidden');

        customersData.unshift(order);
        document.getElementById('receiptActionStatus').textContent = '';
        document.getElementById('receiptModal').classList.remove('hidden');
        status.textContent = `Registration received. Receipt ${order.receiptId} is ready.`;
        status.className = 'text-sm text-green-300 min-h-[20px]';
        updateAdminStats();
    } catch (error) {
        console.error('Unable to create or display membership receipt.', error);
        status.textContent = error.message || 'We could not prepare your receipt. Please contact the gym before submitting again.';
        status.className = 'text-sm text-red-300 min-h-[20px]';
    } finally {
        submitButton.disabled = false;
    }

}

function closeReceiptModal() {
    document.getElementById('receiptModal').classList.add('hidden');
}

function showPaidReceipt(order) {
    document.getElementById('rcptNo').textContent = `#${order.receiptId}`;
    document.getElementById('rcptDate').textContent = formatMemberDate(order.paidAt ? order.paidAt.slice(0, 10) : order.date);
    document.getElementById('rcptName').textContent = order.name;
    document.getElementById('rcptPhone').textContent = order.phone;
    document.getElementById('rcptPlanName').textContent = order.plan;
    const planPrice = order.total - (order.trainer ? PRICING.trainer : 0);
    document.getElementById('rcptPlanPrice').textContent = `₱${planPrice.toLocaleString()}`;
    document.getElementById('rcptTrainerRow').classList.toggle('hidden', !order.trainer);
    document.getElementById('rcptTotal').textContent = `₱${Number(order.total).toLocaleString()}`;
    document.getElementById('rcptStatus').textContent = 'PAID';
    document.getElementById('rcptPaymentMethod').textContent = order.paymentMethod || 'Cash';
    document.getElementById('rcptPaymentReference').textContent = order.paymentReference || '—';
    document.getElementById('rcptConfirmedBy').textContent = order.confirmedBy || '—';
    document.getElementById('rcptPaymentDetails').classList.remove('hidden');
    document.getElementById('receiptModal').classList.remove('hidden');
}

function openPaymentModal(orderId) {
    const order = customersData.find(item => Number(item.id) === Number(orderId));
    if (!order || order.status !== 'Unpaid') return;
    const form = document.getElementById('paymentConfirmationForm');
    form.reset();
    document.getElementById('paymentOrderId').value = order.id;
    document.getElementById('paymentOrderSummary').textContent =
        `${order.name} · ${order.receiptId} · ₱${Number(order.total).toLocaleString()}`;
    document.getElementById('amountReceived').value = Number(order.total).toFixed(2);
    updatePaymentReferenceRequirement();
    document.getElementById('paymentMismatch').checked = false;
    document.getElementById('paymentFormStatus').textContent = '';
    document.getElementById('paymentFormStatus').className = 'text-sm text-gray-400 min-h-[20px]';
    paymentReturnFocus = document.activeElement;
    const modal = document.getElementById('paymentConfirmationModal');
    modal.classList.remove('hidden');
    document.getElementById('paymentMethod').focus();
}

function closePaymentModal() {
    document.getElementById('paymentConfirmationModal').classList.add('hidden');
    if (paymentReturnFocus instanceof HTMLElement) paymentReturnFocus.focus();
    paymentReturnFocus = null;
}

function handlePaymentModalKeydown(event) {
    const modal = document.getElementById('paymentConfirmationModal');
    if (modal.classList.contains('hidden')) return;
    if (event.key === 'Escape') {
        closePaymentModal();
        return;
    }
    if (event.key === 'Tab') {
        const focusable = [...modal.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled])')];
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
        }
    }
}

function updatePaymentReferenceRequirement() {
    const isGCash = document.getElementById('paymentMethod').value === 'GCash';
    const reference = document.getElementById('paymentReference');
    reference.required = isGCash;
    reference.setAttribute('aria-required', String(isGCash));
}

async function submitPaymentConfirmation(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const orderId = Number(document.getElementById('paymentOrderId').value);
    const status = document.getElementById('paymentFormStatus');
    const submitButton = form.querySelector('[type="submit"]');
    const payload = {
        status: 'Paid',
        paymentMethod: document.getElementById('paymentMethod').value,
        paymentReference: document.getElementById('paymentReference').value.trim(),
        amountReceived: Number(document.getElementById('amountReceived').value),
        allowMismatch: document.getElementById('paymentMismatch').checked
    };
    status.textContent = 'Saving payment…';
    submitButton.disabled = true;
    let paidOrder;
    try {
        paidOrder = await adminApi(`/api/admin/orders/${orderId}/payment`, {
            method: 'PATCH',
            body: JSON.stringify(payload)
        });
    } catch (error) {
        console.error('Unable to confirm order payment.', error);
        status.textContent = error.message;
        status.className = 'text-sm text-red-300 min-h-[20px]';
        submitButton.disabled = false;
        return;
    }

    closePaymentModal();
    customersData = customersData.map(order => order.id === paidOrder.id ? paidOrder : order);
    ordersPageData = ordersPageData.map(order => order.id === paidOrder.id ? paidOrder : order);
    updateAdminStats();
    let refreshError;
    try {
        await loadAdminData();
        updateAdminStats();
        if (currentAdminTab === 'orders') await loadOrdersPage();
        else renderAdminTabContent();
    } catch (error) {
        refreshError = error;
        console.error('Payment was confirmed, but dashboard data could not be refreshed.', error);
    }
    showPaidReceipt(paidOrder);
    if (refreshError) {
        window.alert(`Payment was confirmed${paidOrder.memberId ? ' and the membership was recorded' : ''}, but the dashboard could not refresh: ${refreshError.message}. Refresh the page to reload the latest records.`);
    }
    submitButton.disabled = false;
}

// Download Receipt as PDF
async function downloadReceiptPDF() {
    const status = document.getElementById('receiptActionStatus');
    try {
        if (!window.jspdf?.jsPDF || typeof window.html2canvas !== 'function') {
            throw new Error('PDF tools could not load. You can still print this receipt.');
        }
        const { jsPDF } = window.jspdf;
        const element = document.getElementById('printableReceipt');
        const canvas = await window.html2canvas(element, { scale: 2 });
        const imgData = canvas.toDataURL('image/png');
        const pdf = new jsPDF('p', 'mm', 'a6');
        const imgProps = pdf.getImageProperties(imgData);
        const pdfWidth = pdf.internal.pageSize.getWidth();
        const pdfHeight = (imgProps.height * pdfWidth) / imgProps.width;

        pdf.addImage(imgData, 'PNG', 0, 0, pdfWidth, pdfHeight);
        pdf.save(`BigBozz_Receipt_${document.getElementById('rcptNo').textContent}.pdf`);
        status.textContent = 'Receipt PDF downloaded.';
        status.className = 'text-xs text-green-300 min-h-[20px] text-center';
    } catch (error) {
        console.error('Unable to generate the receipt PDF in the browser.', error);
        status.textContent = error.message || 'PDF generation failed. Use Print to save or print this receipt.';
        status.className = 'text-xs text-red-300 min-h-[20px] text-center';
    }
}

// Admin Dashboard Functions
function switchAdminTab(tabName) {
    currentAdminTab = tabName;

    document.querySelectorAll('.admin-tab-btn').forEach(btn => {
        btn.classList.remove('border-gold-500', 'text-gold-400');
        btn.classList.add('border-transparent', 'text-gray-400');
    });

    const activeBtn = document.getElementById(`tab-${tabName}`);
    if (activeBtn) {
        activeBtn.classList.add('border-gold-500', 'text-gold-400');
        activeBtn.classList.remove('border-transparent', 'text-gray-400');
    }

    if (adminDataLoaded) {
        renderAdminTabContent();
        if (tabName === 'orders') loadOrdersPage();
    }
}

function updatePendingOrderBadge() {
    const badge = document.getElementById('pendingPaymentsNavBadge');
    if (badge) badge.textContent = pendingOrderCount;
}

async function loadOrdersPage() {
    const params = new URLSearchParams({
        status: orderStatusFilter,
        q: orderSearchQuery,
        limit: String(ORDER_PAGE_SIZE),
        offset: String(orderPageOffset)
    });
    try {
        const result = await adminApi(`/api/admin/orders?${params}`);
        ordersPageData = result.orders;
        orderPageTotal = result.total;
        pendingOrderCount = result.pendingCount;
        updatePendingOrderBadge();
        if (currentAdminTab === 'orders') renderAdminTabContent();
    } catch (error) {
        console.error('Unable to load filtered orders.', error);
        const container = document.getElementById('adminTabContent');
        container.innerHTML = `<div role="alert" class="text-red-300 p-4">${escapeHtml(error.message)}</div>`;
    }
}

function applyOrderFilters(event) {
    event.preventDefault();
    orderSearchQuery = document.getElementById('orderSearch').value.trim();
    orderStatusFilter = document.getElementById('orderStatus').value;
    orderPageOffset = 0;
    loadOrdersPage();
}

function showPendingOrders() {
    orderSearchQuery = '';
    orderStatusFilter = 'Unpaid';
    orderPageOffset = 0;
    loadOrdersPage();
}

function changeOrderPage(direction) {
    orderPageOffset = Math.max(0, orderPageOffset + direction * ORDER_PAGE_SIZE);
    loadOrdersPage();
}

function renderAdminTabContent() {
    const container = document.getElementById('adminTabContent');

    if (currentAdminTab === 'members') {
        renderMembersTab(container);
    } else if (currentAdminTab === 'customers' || currentAdminTab === 'orders') {
        const visibleOrders = currentAdminTab === 'customers'
            ? customersData.filter(order => order.planKey !== 'walkin')
            : ordersPageData;
        const ordersHeader = currentAdminTab === 'orders' ? `
            <form id="orderFilterForm" onsubmit="applyOrderFilters(event)" class="p-4 border-b border-gray-800 flex flex-wrap items-center gap-3">
                <label class="sr-only" for="orderSearch">Search orders</label>
                <input id="orderSearch" type="search" maxlength="100" value="${escapeHtml(orderSearchQuery)}" placeholder="Search name, phone, or receipt ID" class="min-w-[220px] flex-1 bg-black/50 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white">
                <label class="sr-only" for="orderStatus">Order status</label>
                <select id="orderStatus" class="bg-black/50 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white">
                    ${['All', 'Unpaid', 'Paid', 'Cancelled'].map(status => `<option value="${status}" ${orderStatusFilter === status ? 'selected' : ''}>${status}</option>`).join('')}
                </select>
                <button type="submit" class="bg-gold-500 hover:bg-gold-600 text-black px-4 py-2 rounded-lg text-sm font-bold">Search</button>
                <button type="button" onclick="showPendingOrders()" class="border border-yellow-500/40 text-yellow-300 px-3 py-2 rounded-lg text-sm font-semibold">Pending payments <span id="pendingOrderBadge">${pendingOrderCount}</span></button>
            </form>` : '';
        const pagination = currentAdminTab === 'orders' ? `
            <div class="p-4 border-t border-gray-800 flex items-center justify-between gap-3">
                <span class="text-xs text-gray-400">${orderPageTotal ? `${orderPageOffset + 1}–${Math.min(orderPageOffset + ORDER_PAGE_SIZE, orderPageTotal)} of ${orderPageTotal}` : '0 entries'}</span>
                <div class="flex gap-2">
                    <button type="button" onclick="changeOrderPage(-1)" ${orderPageOffset === 0 ? 'disabled' : ''} class="border border-gray-700 disabled:opacity-40 px-3 py-1.5 rounded-lg text-xs">Previous</button>
                    <button type="button" onclick="changeOrderPage(1)" ${orderPageOffset + ORDER_PAGE_SIZE >= orderPageTotal ? 'disabled' : ''} class="border border-gray-700 disabled:opacity-40 px-3 py-1.5 rounded-lg text-xs">Next</button>
                </div>
            </div>` : '';
        container.innerHTML = `
            <div class="bg-cardbg border border-gray-800 rounded-2xl overflow-hidden">
                <div class="p-4 border-b border-gray-800 flex justify-between items-center">
                    <h3 class="font-bold text-white">${currentAdminTab === 'customers' ? 'Membership Reservations' : 'Recent Registrations / Orders'}</h3>
                    <span class="text-xs text-gray-400">${currentAdminTab === 'customers' ? `${visibleOrders.length} entries` : `Pending: ${pendingOrderCount}`}</span>
                </div>
                ${ordersHeader}
                <div class="overflow-x-auto">
                    <table class="w-full text-left text-xs sm:text-sm text-gray-300">
                        <thead class="bg-black/50 text-gray-400 uppercase text-[11px] border-b border-gray-800">
                            <tr>
                                <th class="p-4">ID</th>
                                <th class="p-4">Customer</th>
                                <th class="p-4">Plan</th>
                                <th class="p-4">Trainer</th>
                                <th class="p-4">Total</th>
                                <th class="p-4">Date</th>
                                <th class="p-4">Status</th>
                                <th class="p-4">Action</th>
                            </tr>
                        </thead>
                        <tbody class="divide-y divide-gray-800/60">
                            ${visibleOrders.map(order => `
                                <tr class="hover:bg-black/30">
                                    <td class="p-4 font-mono font-bold text-gold-400">${escapeHtml(order.receiptId)}</td>
                                    <td class="p-4 font-semibold text-white">
                                        <div>${escapeHtml(order.name)}</div>
                                        <div class="text-xs text-gray-500 font-normal">${escapeHtml(order.phone)}</div>
                                    </td>
                                    <td class="p-4">${escapeHtml(order.plan)}</td>
                                    <td class="p-4">${order.trainer ? '<span class="text-xs bg-gold-500/10 text-gold-400 border border-gold-500/30 px-2 py-0.5 rounded">Yes</span>' : '<span class="text-gray-500">No</span>'}</td>
                                    <td class="p-4 font-bold text-white">₱${Number(order.total).toLocaleString()}</td>
                                    <td class="p-4 whitespace-nowrap">${escapeHtml(order.date)}</td>
                                    <td class="p-4">
                                        <span class="px-2.5 py-1 rounded-full text-[11px] font-bold ${order.status === 'Paid' ? 'bg-green-500/10 text-green-400 border border-green-500/30' : order.status === 'Cancelled' ? 'bg-red-500/10 text-red-300 border border-red-500/30' : 'bg-yellow-500/10 text-yellow-400 border border-yellow-500/30'}">
                                            ${escapeHtml(order.status)}
                                        </span>
                                        ${order.status === 'Unpaid' && Date.now() - Date.parse(order.createdAt) > 7 * 86400000 ? '<span class="block mt-1 text-[10px] text-orange-300">Stale · over 7 days</span>' : ''}
                                    </td>
                                    <td class="p-4">
                                        ${order.status === 'Unpaid'
                                            ? `<div class="flex flex-wrap gap-2"><button onclick="openPaymentModal(${order.id})" class="border border-green-500/40 bg-green-500/10 text-green-300 hover:bg-green-500 hover:text-black px-3 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap"><i class="fa-solid fa-check mr-1"></i>Confirm Payment</button><button onclick="cancelOrder(${order.id})" class="border border-red-500/40 text-red-300 hover:bg-red-500/20 px-3 py-1.5 rounded-lg text-xs font-semibold">Cancel</button></div>`
                                            : '<span class="text-xs text-gray-500">Recorded</span>'}
                                    </td>
                                </tr>
                            `).join('') || `<tr>                            <td colspan="8" class="p-8 text-center text-sm text-gray-400">No ${currentAdminTab === 'customers' ? 'membership reservations' : 'orders'} recorded yet.</td></tr>`}
                        </tbody>
                    </table>
                </div>
                ${pagination}
            </div>
        `;
    } else if (currentAdminTab === 'services') {
        container.innerHTML = `
            <div class="grid md:grid-cols-2 gap-6">
                <div class="bg-cardbg border border-gray-800 p-6 rounded-2xl space-y-4">
                    <h3 class="font-bold text-lg text-white">Gym Membership Plans</h3>
                    <div class="space-y-3 text-sm">
                        <div class="flex justify-between p-3 bg-black/40 rounded-xl border border-gray-800">
                            <span>Walk-in / Per Session</span>
                            <span class="font-bold text-gold-400">₱50</span>
                        </div>
                        <div class="flex justify-between p-3 bg-black/40 rounded-xl border border-gray-800">
                            <span>Monthly Standard</span>
                            <span class="font-bold text-gold-400">₱500</span>
                        </div>
                        <div class="flex justify-between p-3 bg-black/40 rounded-xl border border-gray-800">
                            <span>6-Month Plan</span>
                            <span class="font-bold text-gold-400">₱2,700</span>
                        </div>
                    </div>
                </div>

                <div class="bg-cardbg border border-gray-800 p-6 rounded-2xl space-y-4">
                    <h3 class="font-bold text-lg text-white">Add-on Services</h3>
                    <div class="space-y-3 text-sm">
                        <div class="flex justify-between p-3 bg-black/40 rounded-xl border border-gray-800">
                            <span>Personal Fitness Trainer</span>
                            <span class="font-bold text-gold-400">₱1,500 / mo</span>
                        </div>
                    </div>
                </div>
            </div>
        `;
    } else if (currentAdminTab === 'security') {
        container.innerHTML = `
            <section class="bg-cardbg border border-gray-800 p-6 rounded-2xl space-y-4">
                <div>
                    <h3 class="font-bold text-lg text-white">Change admin password</h3>
                    <p class="text-xs text-gray-400 mt-1">Use your current password to set a new password with at least 12 characters.</p>
                </div>
                <form id="adminPasswordForm" onsubmit="changeAdminPassword(event)" class="grid md:grid-cols-3 gap-3">
                    <label class="text-xs text-gray-400">Current password
                        <input id="currentAdminPassword" type="password" required autocomplete="current-password" class="mt-2 w-full bg-black/50 border border-gray-700 rounded-lg px-3 py-2.5 text-white">
                    </label>
                    <label class="text-xs text-gray-400">New password
                        <input id="newAdminPassword" type="password" minlength="12" required autocomplete="new-password" class="mt-2 w-full bg-black/50 border border-gray-700 rounded-lg px-3 py-2.5 text-white">
                    </label>
                    <button type="submit" class="self-end bg-gold-500 hover:bg-gold-600 text-black px-4 py-2.5 rounded-lg font-bold">Update password</button>
                    <p id="passwordChangeStatus" role="status" aria-live="polite" class="md:col-span-3 text-sm text-gray-400 min-h-[20px]"></p>
                </form>
            </section>
            <section class="bg-cardbg border border-red-900/60 p-6 rounded-2xl space-y-3">
                <div>
                    <h3 class="font-bold text-lg text-white">Admin sessions</h3>
                    <p class="text-xs text-gray-400 mt-1">Immediately log out all signed-in admin devices.</p>
                </div>
                <button type="button" onclick="logoutAllAdminSessions()" class="border border-red-700 hover:bg-red-950 text-red-200 px-4 py-2.5 rounded-lg font-bold">Log out all sessions</button>
            </section>
        `;
    } else if (currentAdminTab === 'reports') {
        container.innerHTML = `
            <div class="bg-cardbg border border-gray-800 p-6 rounded-2xl space-y-6">
                <h3 class="font-bold text-lg text-white">Revenue & Subscriptions Breakdown</h3>
                <div class="h-64">
                    <canvas id="revenueChart"></canvas>
                </div>
            </div>
        `;
        setTimeout(initChart, 50);
    } else if (currentAdminTab === 'audit') {
        renderAuditTab(container);
    } else {
        container.innerHTML = `
            <div class="bg-cardbg border border-gray-800 p-8 rounded-2xl text-center text-gray-400">
                <i class="fa-solid fa-wallet text-4xl text-gold-500 mb-3"></i>
                <p class="font-semibold text-white">Payments & Financial History</p>
                <p class="text-xs text-gray-500 mt-1">Payment reservations are listed under Orders & Registrations. Confirm payment only after receiving it.</p>
            </div>
        `;
    }
}

async function renderAuditTab(container) {
    container.innerHTML = `
        <div class="bg-cardbg border border-gray-800 rounded-2xl overflow-hidden">
            <div class="p-5 border-b border-gray-800 flex flex-wrap items-center justify-between gap-3">
                <div>
                    <h3 class="font-bold text-lg text-white">Change History</h3>
                    <p class="text-xs text-gray-400 mt-1">Recent member, payment, and administrator actions are recorded here.</p>
                </div>
            </div>
            <p class="px-5 py-3 text-xs text-gray-400 border-b border-gray-800">Database backups are managed by Turso. Configure Turso retention and keep an off-platform export for disaster recovery.</p>
            <div id="auditRows" class="divide-y divide-gray-800/60">
                <p class="p-6 text-sm text-gray-400">Loading activity…</p>
            </div>
        </div>
    `;

    try {
        const auditItems = await adminApi('/api/admin/audit');
        const rows = document.getElementById('auditRows');
        if (!rows || currentAdminTab !== 'audit') return;
        rows.innerHTML = auditItems.length ? auditItems.map(item => `
            <article class="p-4 flex flex-col sm:flex-row sm:items-start justify-between gap-2">
                <div>
                    <div class="text-sm font-semibold text-white">${escapeHtml(item.action.replaceAll('_', ' '))}</div>
                    <div class="text-xs text-gray-400 mt-1">${escapeHtml(item.actor)} · ${escapeHtml(item.entityType)} ${escapeHtml(item.entityId)}</div>
                    <pre class="text-[11px] text-gray-500 mt-2 whitespace-pre-wrap break-all">${escapeHtml(JSON.stringify(item.details, null, 2))}</pre>
                </div>
                <time class="text-xs text-gray-500 whitespace-nowrap">${escapeHtml(new Date(item.createdAt).toLocaleString())}</time>
            </article>
        `).join('') : '<p class="p-6 text-sm text-gray-400">No recorded activity yet.</p>';
    } catch (error) {
        console.error('Unable to load audit history.', error);
        const rows = document.getElementById('auditRows');
        if (rows) rows.innerHTML = `<p role="alert" class="p-6 text-sm text-red-300">${escapeHtml(error.message)}</p>`;
    }
}

function getTodayDateString() {
    const today = new Date();
    const month = String(today.getMonth() + 1).padStart(2, '0');
    const day = String(today.getDate()).padStart(2, '0');
    return `${today.getFullYear()}-${month}-${day}`;
}

function getMemberDaysRemaining(endDate) {
    const [year, month, day] = endDate.split('-').map(Number);
    const [todayYear, todayMonth, todayDay] = getTodayDateString().split('-').map(Number);
    const endUtc = Date.UTC(year, month - 1, day);
    const todayUtc = Date.UTC(todayYear, todayMonth - 1, todayDay);
    return Math.ceil((endUtc - todayUtc) / 86400000);
}

function isMemberActive(member) {
    return member.endDate >= getTodayDateString();
}

function formatMemberDate(dateString) {
    const [year, month, day] = dateString.split('-').map(Number);
    return new Date(year, month - 1, day).toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric'
    });
}

function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, character => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    })[character]);
}

function renderMembersTab(container) {
    const editingMember = membersData.find(member => member.id === editingMemberId);
    const today = getTodayDateString();
    const rows = membersData.length ? membersData.map(member => {
        const daysRemaining = getMemberDaysRemaining(member.endDate);
        const isExpired = daysRemaining < 0;
        const isExpiringSoon = !isExpired && daysRemaining <= 7;
        const rowClass = isExpired ? 'bg-red-500/5' : isExpiringSoon ? 'bg-yellow-500/5' : 'hover:bg-black/30';
        const statusClass = isExpired
            ? 'bg-red-500/10 text-red-300 border-red-500/30'
            : isExpiringSoon
                ? 'bg-yellow-500/10 text-yellow-300 border-yellow-500/30'
                : 'bg-green-500/10 text-green-300 border-green-500/30';
        const statusText = isExpired ? 'Expired' : isExpiringSoon ? 'Expiring soon' : 'Active';
        const daysText = isExpired ? 'Expired' : `${daysRemaining} day${daysRemaining === 1 ? '' : 's'}`;

        return `
            <tr class="${rowClass}">
                <td class="p-4 font-semibold text-white">
                    <div>${escapeHtml(member.name)}</div>
                    ${member.phone ? `<div class="text-xs text-gray-500 font-normal">${escapeHtml(member.phone)}</div>` : ''}
                </td>
                <td class="p-4">${member.membershipType === '6month' ? '6-Month' : 'Monthly'}</td>
                <td class="p-4 whitespace-nowrap">${formatMemberDate(member.startDate)}</td>
                <td class="p-4 whitespace-nowrap">${formatMemberDate(member.endDate)}</td>
                <td class="p-4 font-semibold ${isExpired ? 'text-red-300' : isExpiringSoon ? 'text-yellow-300' : 'text-gray-200'}">${daysText}</td>
                <td class="p-4"><span class="px-2.5 py-1 rounded-full border text-[11px] font-bold whitespace-nowrap ${statusClass}">${statusText}</span></td>
                <td class="p-4">
                    <div class="flex items-center gap-2">
                        ${isExpired ? `<button onclick="renewMember('${member.id}')" class="border border-green-500/40 bg-green-500/10 text-green-300 hover:bg-green-500 hover:text-black px-3 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap"><i class="fa-solid fa-rotate mr-1"></i>Renew</button>` : ''}
                        <button onclick="editMember('${member.id}')" class="border border-gray-700 hover:bg-gray-800 text-gray-300 px-3 py-1.5 rounded-lg text-xs font-semibold"><i class="fa-solid fa-pen"></i><span class="sr-only"> Edit ${escapeHtml(member.name)}</span></button>
                        <button onclick="deleteMember('${member.id}')" class="border border-red-500/40 bg-red-500/10 text-red-300 hover:bg-red-500 hover:text-white px-3 py-1.5 rounded-lg text-xs font-semibold"><i class="fa-solid fa-trash"></i><span class="sr-only"> Delete ${escapeHtml(member.name)}</span></button>
                    </div>
                </td>
            </tr>
        `;
    }).join('') : `
        <tr><td colspan="7" class="p-8 text-center text-sm text-gray-400">No members registered yet. Add a member using the form above.</td></tr>
    `;

    container.innerHTML = `
        <div class="grid lg:grid-cols-[minmax(280px,0.8fr)_minmax(0,2fr)] gap-6 items-start">
            <form id="memberForm" onsubmit="saveMember(event)" class="bg-cardbg border border-gray-800 p-6 rounded-2xl space-y-4">
                <div>
                    <h3 class="font-bold text-lg text-white">${editingMember ? 'Edit Member' : 'Register a Member'}</h3>
                    <p class="text-xs text-gray-400 mt-1">Membership dates are calculated automatically.</p>
                </div>
                <label class="block text-xs font-semibold text-gray-400 uppercase">
                    Full name
                    <input id="memberName" name="name" type="text" maxlength="100" required value="${editingMember ? escapeHtml(editingMember.name) : ''}" class="mt-2 w-full rounded-xl border border-gray-700 bg-black/40 px-3 py-2.5 text-sm text-white focus:border-yellow-500 focus:outline-none">
                </label>
                <label class="block text-xs font-semibold text-gray-400 uppercase">
                    Phone number <span class="normal-case font-normal">(optional)</span>
                    <input id="memberPhone" name="phone" type="tel" maxlength="30" value="${editingMember ? escapeHtml(editingMember.phone || '') : ''}" class="mt-2 w-full rounded-xl border border-gray-700 bg-black/40 px-3 py-2.5 text-sm text-white focus:border-yellow-500 focus:outline-none">
                </label>
                <label class="block text-xs font-semibold text-gray-400 uppercase">
                    Membership type
                    <select id="memberType" name="membershipType" required class="mt-2 w-full rounded-xl border border-gray-700 bg-black/40 px-3 py-2.5 text-sm text-white focus:border-yellow-500 focus:outline-none">
                        <option value="monthly" ${editingMember?.membershipType === 'monthly' ? 'selected' : ''}>Monthly (1 month)</option>
                        <option value="6month" ${editingMember?.membershipType === '6month' ? 'selected' : ''}>6-Month (6 months)</option>
                    </select>
                </label>
                <label class="block text-xs font-semibold text-gray-400 uppercase">
                    Start date
                    <input id="memberStartDate" name="startDate" type="date" required value="${editingMember ? editingMember.startDate : today}" class="mt-2 w-full rounded-xl border border-gray-700 bg-black/40 px-3 py-2.5 text-sm text-white focus:border-yellow-500 focus:outline-none">
                </label>
                <div class="flex gap-2">
                    <button type="submit" class="flex-1 bg-gold-500 hover:bg-gold-600 text-black px-4 py-2.5 rounded-xl font-bold text-sm">
                        <i class="fa-solid ${editingMember ? 'fa-floppy-disk' : 'fa-plus'} mr-1"></i>${editingMember ? 'Save Changes' : 'Add Member'}
                    </button>
                    ${editingMember ? '<button type="button" onclick="cancelMemberEdit()" class="border border-gray-700 hover:bg-gray-800 text-gray-300 px-4 py-2.5 rounded-xl text-sm font-semibold">Cancel</button>' : ''}
                </div>
            </form>
            <div class="bg-cardbg border border-gray-800 rounded-2xl overflow-hidden">
                <div class="p-4 border-b border-gray-800 flex flex-wrap justify-between items-center gap-2">
                    <div>
                        <h3 class="font-bold text-white">Gym Members</h3>
                        <p class="text-xs text-gray-400 mt-1">${membersData.filter(isMemberActive).length} active · ${membersData.length} total</p>
                    </div>
                    <span class="text-xs text-gray-400">Expiring within 7 days is highlighted</span>
                </div>
                <div class="overflow-x-auto">
                    <table class="w-full text-left text-xs sm:text-sm text-gray-300">
                        <thead class="bg-black/50 text-gray-400 uppercase text-[11px] border-b border-gray-800">
                            <tr>
                                <th class="p-4">Name</th><th class="p-4">Membership</th><th class="p-4">Start date</th>
                                <th class="p-4">End date</th><th class="p-4">Days remaining</th><th class="p-4">Status</th><th class="p-4">Actions</th>
                            </tr>
                        </thead>
                        <tbody class="divide-y divide-gray-800/60">${rows}</tbody>
                    </table>
                </div>
            </div>
        </div>
    `;
}

async function saveMember(event) {
    event.preventDefault();
    const name = document.getElementById('memberName').value.trim();
    const phone = document.getElementById('memberPhone').value.trim();
    const membershipType = document.getElementById('memberType').value;
    const startDate = document.getElementById('memberStartDate').value;
    if (!name || phone.length > 30 || !['monthly', '6month'].includes(membershipType) || !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
        window.alert('Enter a member name, valid membership type, and start date.');
        return;
    }

    const editingId = editingMemberId;
    try {
        const member = await adminApi(editingId ? `/api/admin/members/${encodeURIComponent(editingId)}` : '/api/admin/members', {
            method: editingId ? 'PATCH' : 'POST',
            body: JSON.stringify({ name, phone, membershipType, startDate })
        });
        if (editingId) {
            membersData = membersData.map(item => item.id === editingId ? member : item);
        } else {
            membersData = [member, ...membersData];
        }
    } catch (error) {
        console.error('Unable to save member.', error);
        window.alert(error.message);
        return;
    }
    editingMemberId = null;
    renderAdminTabContent();
    updateAdminStats();
}

function editMember(memberId) {
    editingMemberId = memberId;
    renderAdminTabContent();
    document.getElementById('memberName')?.focus();
}

function cancelMemberEdit() {
    editingMemberId = null;
    renderAdminTabContent();
}

async function renewMember(memberId) {
    const member = membersData.find(item => item.id === memberId);
    if (!member) {
        console.error(`Cannot renew member: ${memberId} was not found.`);
        return;
    }

    try {
        const renewedMember = await adminApi(`/api/admin/members/${encodeURIComponent(memberId)}/renew`, {
            method: 'POST',
            body: JSON.stringify({})
        });
        membersData = membersData.map(item => item.id === memberId ? renewedMember : item);
    } catch (error) {
        console.error('Unable to renew member.', error);
        window.alert(error.message);
        return;
    }
    editingMemberId = null;
    renderAdminTabContent();
    updateAdminStats();
}

async function deleteMember(memberId) {
    const member = membersData.find(item => item.id === memberId);
    if (!member) {
        console.error(`Cannot delete member: ${memberId} was not found.`);
        return;
    }
    if (!window.confirm(`Delete ${member.name} from the member list?`)) return;

    try {
        await adminApi(`/api/admin/members/${encodeURIComponent(memberId)}`, { method: 'DELETE' });
    } catch (error) {
        console.error('Unable to delete member.', error);
        window.alert(error.message);
        return;
    }
    membersData = membersData.filter(item => item.id !== memberId);
    if (editingMemberId === memberId) editingMemberId = null;
    renderAdminTabContent();
    updateAdminStats();
}

async function confirmPayment(orderId) {
    openPaymentModal(orderId);
}

async function cancelOrder(orderId) {
    const order = customersData.find(item => Number(item.id) === Number(orderId)) ||
        ordersPageData.find(item => Number(item.id) === Number(orderId));
    if (!order || order.status !== 'Unpaid') return;
    if (!window.confirm(`Cancel the unpaid order ${order.receiptId} for ${order.name}?`)) return;
    try {
        await adminApi(`/api/admin/orders/${orderId}/cancel`, {
            method: 'PATCH',
            body: JSON.stringify({})
        });
        await loadAdminData();
        updateAdminStats();
        if (currentAdminTab === 'orders') await loadOrdersPage();
        else renderAdminTabContent();
    } catch (error) {
        console.error('Unable to cancel order.', error);
        window.alert(error.message);
    }
}

async function changeAdminPassword(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const status = document.getElementById('passwordChangeStatus');
    try {
        const result = await adminApi('/api/admin/password', {
            method: 'PATCH',
            body: JSON.stringify({
                currentPassword: document.getElementById('currentAdminPassword').value,
                newPassword: document.getElementById('newAdminPassword').value
            })
        });
        status.textContent = result.message;
        status.className = 'text-sm text-green-300 min-h-[20px]';
        form.reset();
    } catch (error) {
        status.textContent = error.message;
        status.className = 'text-sm text-red-300 min-h-[20px]';
    }
}

async function logoutAllAdminSessions() {
    if (!window.confirm('Log out every admin session, including this device?')) return;
    try {
        await adminApi('/api/admin/sessions/revoke-all', {
            method: 'POST',
            body: JSON.stringify({})
        });
        closeAdminLoginModal();
        adminUnlocked = false;
        await showSection('admin');
        window.alert('All admin sessions have been logged out.');
    } catch (error) {
        window.alert(error.message);
    }
}

async function createNewWalkinModal() {
    const name = prompt("Enter Walk-in Customer Name:", "Walk-in Guest");
    if (!name || !name.trim()) return;

    try {
        const order = await adminApi('/api/registrations', {
            method: 'POST',
            body: JSON.stringify({
                name: name.trim(),
                phone: 'N/A',
                planKey: 'walkin',
                trainer: false
            })
        });
        customersData.unshift(order);
        updateAdminStats();
        if (currentAdminTab === 'orders') await loadOrdersPage();
        else renderAdminTabContent();
    } catch (error) {
        console.error('Unable to create walk-in registration.', error);
        window.alert(error.message);
    }
}

function csvCell(value) {
    let safeValue = String(value ?? '');
    if (/^[=+\-@\t\r]/.test(safeValue)) safeValue = `'${safeValue}`;
    return `"${safeValue.replaceAll('"', '""')}"`;
}

function exportDataCSV() {
    const lines = [[
        'Record type', 'ID', 'Name', 'Phone', 'Membership / plan', 'Start date', 'End date', 'Trainer', 'Total', 'Status', 'Date'
    ].map(csvCell).join(',')];
    membersData.forEach(member => {
        lines.push([
            'Member', member.id, member.name, member.phone, member.membershipType === '6month' ? '6-Month' : 'Monthly',
            member.startDate, member.endDate, '', '', isMemberActive(member) ? 'Active' : 'Expired', ''
        ].map(csvCell).join(','));
    });
    customersData.forEach(row => {
        lines.push([
            'Order', row.receiptId, row.name, row.phone, row.plan, '', '', row.trainer ? 'Yes' : 'No',
            row.total, row.status, row.date
        ].map(csvCell).join(','));
    });
    const encodedUri = `data:text/csv;charset=utf-8,${encodeURIComponent(lines.join('\r\n'))}`;
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", "Big_Bozz_Gym_Members.csv");
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

async function resetDashboardRecords() {
    const confirmed = window.confirm(
        'Permanently delete every member and reservation/order record, including paid, unpaid, and cancelled records? The dashboard metrics and revenue chart will be cleared. Admin accounts, sessions, and audit history will be kept. This cannot be undone.'
    );
    if (!confirmed) return;

    const button = document.getElementById('resetDashboardRecordsButton');
    button.disabled = true;
    try {
        const result = await adminApi('/api/admin/records/reset', {
            method: 'POST',
            body: JSON.stringify({ confirmed: true })
        });
        membersData = [];
        customersData = [];
        ordersPageData = [];
        orderPageOffset = 0;
        orderPageTotal = 0;
        pendingOrderCount = 0;
        editingMemberId = null;
        updateAdminStats();
        renderAdminTabContent();
        window.alert(
            `Dashboard records reset. Deleted ${result.membersDeleted} member(s) and ${result.ordersDeleted} reservation/order record(s). Audit history and admin accounts were kept.`
        );
    } catch (error) {
        console.error('Unable to reset dashboard records.', error);
        window.alert(error.message);
    } finally {
        button.disabled = false;
    }
}

function updateAdminStats() {
    const totalRev = customersData.filter(order => order.status === 'Paid').reduce((acc, order) => acc + Number(order.total), 0);
    pendingOrderCount = customersData.filter(order => order.status === 'Unpaid').length;
    updatePendingOrderBadge();
    document.getElementById('statTotalRevenue').textContent = `₱${totalRev.toLocaleString()}`;
    document.getElementById('statActiveMembers').textContent = membersData.filter(isMemberActive).length;
    const today = getTodayDateString();
    const walkinsToday = customersData.filter(order =>
        order.planKey === 'walkin' && order.status === 'Paid' && order.date === today
    ).length;
    document.getElementById('statWalkins').textContent = walkinsToday;

    const trainerCount = customersData.filter(order => order.trainer && order.status === 'Paid').length;
    const trainerStat = document.getElementById('statTrainers');
    if (trainerStat) {
        trainerStat.textContent = trainerCount;
    }
}

function scheduleMemberDailyRefresh() {
    clearTimeout(memberRefreshTimeout);
    const now = new Date();
    const nextMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    memberRefreshTimeout = setTimeout(() => {
        updateAdminStats();
        if (currentAdminTab === 'members') renderAdminTabContent();
        scheduleMemberDailyRefresh();
    }, nextMidnight.getTime() - now.getTime());
}

function getWeeklyRevenue() {
    const labels = [];
    const totals = [];
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    for (let daysAgo = 6; daysAgo >= 0; daysAgo -= 1) {
        const date = new Date(today);
        date.setDate(date.getDate() - daysAgo);
        const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
        labels.push(date.toLocaleDateString(undefined, { weekday: 'short' }));
        totals.push(customersData
            .filter(order => order.status === 'Paid' && order.date === key)
            .reduce((sum, order) => sum + Number(order.total), 0));
    }
    return { labels, totals };
}

function initChart() {
    const ctx = document.getElementById('revenueChart');
    if (!ctx) return;
    if (revenueChart) {
        revenueChart.destroy();
    }
    const weeklyRevenue = getWeeklyRevenue();
    revenueChart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: weeklyRevenue.labels,
            datasets: [{
                label: 'Revenue (₱)',
                data: weeklyRevenue.totals,
                backgroundColor: '#eab308',
                borderRadius: 8
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
                y: { ticks: { color: '#9ca3af' }, grid: { color: '#1f2937' } },
                x: { ticks: { color: '#9ca3af' }, grid: { display: false } }
            }
        }
    });
}

// Initialize default state on load
window.onload = function () {
    bindAdminLoginForm();
    initializeAdminAccess();
    calculateTotal();
    const startDateInput = document.getElementById('regStartDate');
    if (startDateInput) {
        const today = getTodayDateString();
        startDateInput.min = today;
        startDateInput.value = today;
    }
    document.getElementById('paymentConfirmationForm')?.addEventListener('submit', submitPaymentConfirmation);
    document.getElementById('paymentMethod')?.addEventListener('change', updatePaymentReferenceRequirement);
    document.addEventListener('keydown', handlePaymentModalKeydown);
    scheduleMemberDailyRefresh();
};