// Data Store (Mock Database & Subscriptions)
const PRICING = {
    walkin: { name: 'Walk-in / Per Session', price: 50, duration: '1 Session' },
    monthly: { name: 'Monthly Standard Plan', price: 500, duration: '1 Month' },
    '6month': { name: '6-Month Plan (₱450/mo)', price: 2700, duration: '6 Months' },
    trainer: 1500
};
const supabaseConfig = window.BBF_SUPABASE_CONFIG || {};
const supabaseClient = window.supabase?.createClient &&
    supabaseConfig.url && !supabaseConfig.url.includes('YOUR_') &&
    supabaseConfig.anonKey && !supabaseConfig.anonKey.includes('YOUR_')
    ? window.supabase.createClient(supabaseConfig.url, supabaseConfig.anonKey)
    : null;

let customersData = [];
let membersData = [];
let plansById = new Map();
let editingMemberId = null;
let memberRefreshTimeout;
let adminDataLoaded = false;

let currentAdminTab = 'customers';
let revenueChart;

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
    if (!supabaseClient) return { authenticated: false, user: null };
    try {
        const { data, error } = await supabaseClient.auth.getSession();
        if (error) throw error;
        const user = data.session?.user || null;
        return { authenticated: !!user, user };
    } catch (error) {
        console.error('Unable to check Supabase login session.', error);
        return { authenticated: false, user: null };
    }
}

function updatePortalButtonState(isAuthenticated) {
    const portalBtnText = document.getElementById('portalBtnText');
    if (portalBtnText) {
        portalBtnText.textContent = isAuthenticated ? 'Admin Dashboard' : 'Owner Login';
    }
}

function openAdminLoginModal() {
    const modal = document.getElementById('adminLoginModal');
    if (modal) {
        modal.classList.remove('hidden');
        const usernameInput = document.getElementById('adminUsername');
        if (usernameInput) {
            setTimeout(() => usernameInput.focus(), 100);
        }
    }
}

function closeAdminLoginModal() {
    const modal = document.getElementById('adminLoginModal');
    if (modal) {
        modal.classList.add('hidden');
    }
    const statusEl = document.getElementById('adminLoginStatus');
    if (statusEl) {
        statusEl.textContent = 'Only the gym owner/admin can access this dashboard.';
        statusEl.className = 'text-xs text-gray-400 min-h-[20px]';
    }
    const form = document.getElementById('adminLoginForm');
    if (form) {
        form.reset();
    }
}

async function showSection(view) {
    if (view === 'public') {
        document.getElementById('publicView').classList.remove('hidden');
        document.getElementById('adminView').classList.add('hidden');
        const session = await getAdminSessionState();
        updatePortalButtonState(session.authenticated);
        return;
    }

    if (view === 'admin') {
        const session = await getAdminSessionState();
        if (!session.authenticated) {
            openAdminLoginModal();
            return;
        }

        document.getElementById('publicView').classList.add('hidden');
        document.getElementById('adminView').classList.remove('hidden');
        updatePortalButtonState(true);
        await loadAdminRegistrations();
    }
}

function requireSupabase() {
    if (!supabaseClient) {
        throw new Error('Supabase is not configured. Add your project URL and anon key in BBFIndex.html.');
    }
}

async function adminApi(endpoint, options = {}) {
    const headers = { Accept: 'application/json', ...(options.headers || {}) };
    if (options.body) headers['Content-Type'] = 'application/json';

    const response = await fetch(endpoint, {
        ...options,
        credentials: 'same-origin',
        headers
    });
    if (response.status === 204) return null;

    const data = await response.json();
    if (!response.ok) {
        throw new Error(data.message || `Request failed (${response.status}).`);
    }
    return data;
}

async function loadPublicPlans() {
    requireSupabase();
    const { data, error } = await supabaseClient
        .from('plans')
        .select('id,name,price,duration,description');
    if (error) throw error;

    plansById = new Map(data.map(plan => [plan.id, plan]));
    for (const id of ['walkin', 'monthly', '6month']) {
        const plan = plansById.get(id);
        if (plan) PRICING[id] = { name: plan.name, price: Number(plan.price), duration: plan.duration };
    }
}

async function loadAdminRegistrations() {
    const container = document.getElementById('adminRegistrations');
    const status = document.getElementById('adminStatus');
    if (!container || !status) return;
    container.innerHTML = '<div class="p-8 text-center text-gray-400">Loading registrations...</div>';
    status.textContent = '';

    try {
        requireSupabase();
        const { data, error } = await supabaseClient
            .from('registrations')
            .select('id,full_name,contact_number,email,plan_id,start_date,status,notes,created_at,plans(name,price,duration)')
            .order('created_at', { ascending: false });
        if (error) throw error;
        renderAdminRegistrations(data);
    } catch (error) {
        console.error('Unable to load registrations from Supabase.', error);
        container.innerHTML = '<div class="p-8 text-center text-red-300">Could not load registrations. Check Supabase configuration and owner access, then try again.</div>';
        status.textContent = error.message || 'The request failed. Check your connection and Supabase settings.';
        status.className = 'text-sm text-red-300';
    }
}

function renderAdminRegistrations(registrations) {
    const container = document.getElementById('adminRegistrations');
    const rows = registrations.map(registration => {
        const plan = registration.plans;
        const statusOptions = ['pending', 'confirmed', 'cancelled'].map(status => `
            <option value="${status}" ${registration.status === status ? 'selected' : ''}>${status}</option>
        `).join('');
        return `
            <tr class="border-t border-gray-800/60 align-top">
                <td class="p-4">
                    <div class="font-semibold text-white">${escapeHtml(registration.full_name)}</div>
                    <div class="text-xs text-gray-400">${escapeHtml(registration.contact_number)}</div>
                    <div class="text-xs text-gray-500">${escapeHtml(registration.email || '')}</div>
                    ${registration.notes ? `<div class="text-xs text-gold-400 mt-1">${escapeHtml(registration.notes)}</div>` : ''}
                </td>
                <td class="p-4 text-gray-300">${escapeHtml(plan?.name || 'Unknown plan')}<div class="text-xs text-gray-500">${plan ? `₱${Number(plan.price).toLocaleString()} / ${escapeHtml(plan.duration)}` : ''}</div></td>
                <td class="p-4 whitespace-nowrap text-gray-300">${escapeHtml(registration.start_date)}</td>
                <td class="p-4">
                    <select data-registration-status="${escapeHtml(registration.id)}" aria-label="Change status for ${escapeHtml(registration.full_name)}" class="bg-black/60 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm">
                        ${statusOptions}
                    </select>
                </td>
                <td class="p-4">
                    <button type="button" data-registration-delete="${escapeHtml(registration.id)}" class="border border-red-500/40 bg-red-500/10 text-red-300 hover:bg-red-500 hover:text-white px-3 py-2 rounded-lg text-xs font-semibold">Delete</button>
                </td>
            </tr>
        `;
    }).join('');

    container.innerHTML = `
        <div class="p-4 border-b border-gray-800 flex items-center justify-between">
            <h2 class="font-bold text-white">Customer Registrations</h2>
            <span class="text-xs text-gray-400">${registrations.length} total</span>
        </div>
        <div class="overflow-x-auto">
            <table class="w-full text-left text-sm">
                <thead class="bg-black/40 text-xs uppercase text-gray-400">
                    <tr><th class="p-4">Customer</th><th class="p-4">Plan</th><th class="p-4">Start date</th><th class="p-4">Status</th><th class="p-4">Action</th></tr>
                </thead>
                <tbody>${rows || '<tr><td colspan="5" class="p-8 text-center text-gray-400">No registrations yet.</td></tr>'}</tbody>
            </table>
        </div>
    `;

    container.querySelectorAll('[data-registration-status]').forEach(select => {
        select.addEventListener('change', () => updateRegistrationStatus(select.dataset.registrationStatus, select.value));
    });
    container.querySelectorAll('[data-registration-delete]').forEach(button => {
        button.addEventListener('click', () => deleteRegistration(button.dataset.registrationDelete));
    });
}

async function updateRegistrationStatus(id, status) {
    if (!['pending', 'confirmed', 'cancelled'].includes(status)) return;
    const statusEl = document.getElementById('adminStatus');
    try {
        const { error } = await supabaseClient.from('registrations').update({ status }).eq('id', id);
        if (error) throw error;
        statusEl.textContent = 'Registration status updated.';
        statusEl.className = 'text-sm text-green-300';
    } catch (error) {
        console.error('Unable to update registration status.', error);
        statusEl.textContent = error.message || 'Could not update the registration. Check your connection and owner access.';
        statusEl.className = 'text-sm text-red-300';
        await loadAdminRegistrations();
    }
}

async function deleteRegistration(id) {
    if (!window.confirm('Delete this registration? This cannot be undone.')) return;
    const statusEl = document.getElementById('adminStatus');
    try {
        const { error } = await supabaseClient.from('registrations').delete().eq('id', id);
        if (error) throw error;
        statusEl.textContent = 'Registration deleted.';
        statusEl.className = 'text-sm text-green-300';
        await loadAdminRegistrations();
    } catch (error) {
        console.error('Unable to delete registration.', error);
        statusEl.textContent = error.message || 'Could not delete the registration. Check your connection and owner access.';
        statusEl.className = 'text-sm text-red-300';
    }
}

async function togglePortal() {
    const session = await getAdminSessionState();
    if (!session.authenticated) {
        openAdminLoginModal();
        return;
    }

    const isAdminVisible = !document.getElementById('adminView').classList.contains('hidden');
    if (isAdminVisible) {
        showSection('public');
    } else {
        showSection('admin');
    }
}

async function initializeAdminAccess() {
    const session = await getAdminSessionState();
    updatePortalButtonState(session.authenticated);
    if (session.authenticated) await showSection('admin');
}

async function logoutAdmin() {
    try {
        requireSupabase();
        const { error } = await supabaseClient.auth.signOut();
        if (error) throw error;
    } catch (error) {
        console.error('Unable to log out of Supabase.', error);
        window.alert(error.message || 'Logout failed. Check your connection and try again.');
        return;
    }

    closeAdminLoginModal();
    showSection('public');
    updatePortalButtonState(false);
}

function bindAdminLoginForm() {
    const form = document.getElementById('adminLoginForm');
    if (!form) return;

    form.addEventListener('submit', async function (event) {
        event.preventDefault();

        const username = document.getElementById('adminUsername').value.trim();
        const password = document.getElementById('adminPassword').value;
        const statusEl = document.getElementById('adminLoginStatus');

        if (!username || !password) {
            statusEl.textContent = 'Please enter both username/email and password.';
            statusEl.className = 'text-xs text-red-300 min-h-[20px]';
            return;
        }

        statusEl.textContent = 'Checking credentials...';
        statusEl.className = 'text-xs text-yellow-300 min-h-[20px]';

        try {
            requireSupabase();
            const { error } = await supabaseClient.auth.signInWithPassword({ email: username, password });
            if (error) throw error;

            statusEl.textContent = 'Login successful. Opening dashboard...';
            statusEl.className = 'text-xs text-green-300 min-h-[20px]';
            closeAdminLoginModal();
            updatePortalButtonState(true);
            await showSection('admin');
        } catch (error) {
            console.error('Owner sign-in failed.', error);
            if (error.message === 'Invalid login credentials') {
                statusEl.textContent = 'That email or password is incorrect. Please check both and try again.';
            } else if (error.name === 'AuthRetryableFetchError' || error instanceof TypeError || /network|fetch/i.test(error.message || '')) {
                statusEl.textContent = 'Network error: Supabase could not be reached. Check your internet connection and project URL.';
            } else {
                statusEl.textContent = error.message || 'Sign-in failed. Check your Supabase Auth settings and try again.';
            }
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
    const name = document.getElementById('regName').value.trim();
    const phone = document.getElementById('regPhone').value.trim();
    const email = document.getElementById('regEmail').value.trim();
    const startDate = document.getElementById('regStartDate').value;
    const statusEl = document.getElementById('registrationStatus');
    const calc = calculateTotal();

    statusEl.textContent = 'Saving your registration...';
    statusEl.className = 'text-sm text-yellow-300 min-h-[20px]';

    const dateStr = new Date().toLocaleDateString('en-PH', { year: 'numeric', month: 'short', day: 'numeric' });

    try {
        requireSupabase();
        if (!plansById.has(calc.selectedPlan)) {
            throw new Error('This plan is unavailable right now. Please refresh the page and try again.');
        }
        const registrationId = crypto.randomUUID();
        const notes = calc.hasTrainer ? 'Customer requested the personal trainer add-on.' : null;
        const { error } = await supabaseClient.from('registrations').insert({
            id: registrationId,
            full_name: name,
            contact_number: phone,
            email: email || null,
            plan_id: calc.selectedPlan,
            start_date: startDate,
            notes
        });
        if (error) throw error;

        const plan = plansById.get(calc.selectedPlan);
        const order = {
            receiptId: `BB-${registrationId.slice(0, 8).toUpperCase()}`,
            name,
            phone,
            plan: plan.name,
            total: calc.total,
            trainer: calc.hasTrainer
        };

        document.getElementById('rcptNo').textContent = `#${order.receiptId}`;
        document.getElementById('rcptDate').textContent = dateStr;
        document.getElementById('rcptName').textContent = order.name;
        document.getElementById('rcptPhone').textContent = order.phone;
        document.getElementById('rcptPlanName').textContent = order.plan;
        document.getElementById('rcptPlanPrice').textContent = `₱${Number(plan.price).toLocaleString()}`;
        document.getElementById('rcptTrainerRow').classList.toggle('hidden', !order.trainer);
        document.getElementById('rcptTotal').textContent = `₱${Number(order.total).toLocaleString()}`;

        statusEl.textContent = 'Registration saved. Your request is pending gym confirmation.';
        statusEl.className = 'text-sm text-green-300 min-h-[20px]';
        document.getElementById('receiptModal').classList.remove('hidden');
    } catch (error) {
        console.error('Unable to submit customer registration to Supabase.', error);
        statusEl.textContent = error.name === 'AuthRetryableFetchError' || error instanceof TypeError
            ? 'Network error: could not reach the registration service. Check your internet connection and try again.'
            : error.message || 'Registration could not be saved. Please try again.';
        statusEl.className = 'text-sm text-red-300 min-h-[20px]';
    }
}

function closeReceiptModal() {
    document.getElementById('receiptModal').classList.add('hidden');
}

// Download Receipt as PDF
function downloadReceiptPDF() {
    const { jsPDF } = window.jspdf;
    const element = document.getElementById('printableReceipt');

    html2canvas(element, { scale: 2 }).then(canvas => {
        const imgData = canvas.toDataURL('image/png');
        const pdf = new jsPDF('p', 'mm', 'a6');
        const imgProps = pdf.getImageProperties(imgData);
        const pdfWidth = pdf.internal.pageSize.getWidth();
        const pdfHeight = (imgProps.height * pdfWidth) / imgProps.width;

        pdf.addImage(imgData, 'PNG', 0, 0, pdfWidth, pdfHeight);
        pdf.save(`BigBozz_Receipt_${document.getElementById('rcptNo').textContent}.pdf`);
    });
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

    if (adminDataLoaded) renderAdminTabContent();
}

function renderAdminTabContent() {
    const container = document.getElementById('adminTabContent');

    if (currentAdminTab === 'members') {
        renderMembersTab(container);
    } else if (currentAdminTab === 'customers' || currentAdminTab === 'orders') {
        const visibleOrders = currentAdminTab === 'customers'
            ? customersData.filter(order => order.planKey !== 'walkin')
            : customersData;
        container.innerHTML = `
            <div class="bg-cardbg border border-gray-800 rounded-2xl overflow-hidden">
                <div class="p-4 border-b border-gray-800 flex justify-between items-center">
                    <h3 class="font-bold text-white">${currentAdminTab === 'customers' ? 'Membership Reservations' : 'Recent Registrations / Orders'}</h3>
                    <span class="text-xs text-gray-400">${visibleOrders.length} entries</span>
                </div>
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
                                        <span class="px-2.5 py-1 rounded-full text-[11px] font-bold ${order.status === 'Paid' ? 'bg-green-500/10 text-green-400 border border-green-500/30' : 'bg-yellow-500/10 text-yellow-400 border border-yellow-500/30'}">
                                            ${escapeHtml(order.status)}
                                        </span>
                                    </td>
                                    <td class="p-4">
                                        ${order.status === 'Unpaid'
                                            ? `<button onclick="confirmPayment(${order.id})" class="border border-green-500/40 bg-green-500/10 text-green-300 hover:bg-green-500 hover:text-black px-3 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap"><i class="fa-solid fa-check mr-1"></i>Confirm Payment</button>`
                                            : '<span class="text-xs text-gray-500">Recorded</span>'}
                                    </td>
                                </tr>
                            `).join('') || `<tr>                            <td colspan="8" class="p-8 text-center text-sm text-gray-400">No ${currentAdminTab === 'customers' ? 'membership reservations' : 'orders'} recorded yet.</td></tr>`}
                        </tbody>
                    </table>
                </div>
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
                    <h3 class="font-bold text-lg text-white">Change History & Backups</h3>
                    <p class="text-xs text-gray-400 mt-1">Recent member, payment, and backup actions are recorded here.</p>
                </div>
                <button onclick="createDatabaseBackup()" class="bg-gold-500 hover:bg-gold-600 text-black px-4 py-2.5 rounded-xl font-bold text-sm">
                    <i class="fa-solid fa-database mr-1"></i>Create Backup
                </button>
            </div>
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

async function createDatabaseBackup() {
    try {
        const result = await adminApi('/api/admin/backups', {
            method: 'POST',
            body: JSON.stringify({})
        });
        const link = document.createElement('a');
        link.href = `/api/admin/backups/${encodeURIComponent(result.filename)}`;
        link.download = result.filename;
        document.body.appendChild(link);
        link.click();
        link.remove();
        if (currentAdminTab === 'audit') renderAuditTab(document.getElementById('adminTabContent'));
        window.alert(`Backup downloaded and also saved on the server as ${result.filename}. Keep another copy somewhere safe.`);
    } catch (error) {
        console.error('Unable to create a database backup.', error);
        window.alert(error.message);
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
    const order = customersData.find(item => item.id === orderId);
    if (!order) {
        console.error(`Cannot confirm payment: order ${orderId} was not found.`);
        return;
    }
    if (order.status === 'Paid') return;
    if (!window.confirm(`Confirm that you received ₱${Number(order.total).toLocaleString()} from ${order.name}? A paid membership plan will activate or extend their membership.`)) return;

    try {
        await adminApi(`/api/admin/orders/${orderId}/payment`, {
            method: 'PATCH',
            body: JSON.stringify({ status: 'Paid' })
        });
        await loadAdminData();
        updateAdminStats();
        renderAdminTabContent();
    } catch (error) {
        console.error('Unable to confirm order payment.', error);
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
        renderAdminTabContent();
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

function updateAdminStats() {
    const totalRev = customersData.filter(order => order.status === 'Paid').reduce((acc, order) => acc + Number(order.total), 0);
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
window.addEventListener('load', async function () {
    bindAdminLoginForm();
    calculateTotal();
    const today = new Date();
    document.getElementById('regStartDate').value = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    try {
        await loadPublicPlans();
    } catch (error) {
        console.error('Unable to load public plans from Supabase.', error);
        const statusEl = document.getElementById('registrationStatus');
        statusEl.textContent = 'Plans could not be loaded from the registration service. Please try again later.';
        statusEl.className = 'text-sm text-red-300 min-h-[20px]';
    }
    await initializeAdminAccess();
});