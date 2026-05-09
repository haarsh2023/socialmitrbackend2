// EVENT LISTENERS to replace inline handlers (CSP fix #script-src-attr)
document.addEventListener('DOMContentLoaded', function() {
  // Tab buttons
  document.querySelectorAll('[data-tab]').forEach(btn => {
    btn.addEventListener('click', function() { showTab(this.getAttribute('data-tab'), this); });
  });
  
  // Notification button
  const notifBtn = document.getElementById('notif-btn');
  if (notifBtn) notifBtn.addEventListener('click', toggleNotifPanel);
  
  // Logout buttons
  const logoutBtn = document.getElementById('logout-btn');
  if(logoutBtn) logoutBtn.addEventListener('click', logout);
  const sidebarLogout = document.getElementById('sidebar-logout');
  if(sidebarLogout) sidebarLogout.addEventListener('click', logout);
  
  // Hamburger and sidebar
  document.getElementById('hamburger-btn').addEventListener('click', openSB);
  document.getElementById('sb-overlay').addEventListener('click', closeSB);
  document.getElementById('sidebar-close').addEventListener('click', closeSB);
  const themeToggle = document.getElementById('th-tog');
  if(themeToggle) themeToggle.addEventListener('click', toggleTheme);
  
  // Mark all read button
  const markAllBtn = document.getElementById('mark-all-read-btn');
  if(markAllBtn) markAllBtn.addEventListener('click', markAllRead);
  
  // Search and filter
  const searchInput = document.getElementById('search-input');
  if(searchInput) searchInput.addEventListener('input', debounce);
  const nicheFilter = document.getElementById('niche-filter');
  if(nicheFilter) nicheFilter.addEventListener('change', loadJobs);
  
  // Payout buttons
  const addPayoutBtn1 = document.getElementById('add-payout-btn-1');
  if(addPayoutBtn1) addPayoutBtn1.addEventListener('click', () => openPayoutSetup());
  const editPayoutBtn = document.getElementById('edit-payout-btn');
  if(editPayoutBtn) editPayoutBtn.addEventListener('click', () => openPayoutSetup());
  
  // Withdraw button
  const withdrawBtn = document.getElementById('withdraw-btn');
  if(withdrawBtn) {
    withdrawBtn.addEventListener('click', openWithdrawModal);
    withdrawBtn.addEventListener('mouseover', function() { this.style.background = '#08f2b8'; });
    withdrawBtn.addEventListener('mouseout', function() { this.style.background = 'var(--gr)'; });
  }
  
  // Save profile button
  const saveProfileBtn = document.getElementById('save-profile-btn');
  if(saveProfileBtn) saveProfileBtn.addEventListener('click', saveProfile);
  
  // AI Bio button
  const aiBioBtn = document.getElementById('ai-bio-btn');
  if(aiBioBtn) aiBioBtn.addEventListener('click', function() { document.getElementById('ai-bio-overlay').classList.add('open'); });
  
  // Modal close buttons
  const modalClose = [['apply-modal-close', 'apply-overlay'], ['pay-req-modal-close', 'pay-req-overlay'], ['delivery-modal-close', 'delivery-overlay'], ['ai-bio-modal-close', 'ai-bio-overlay'], ['withdraw-modal-close', 'withdraw-overlay'], ['payout-setup-modal-close', 'payout-setup-overlay']];
  modalClose.forEach(pair => { const b = document.getElementById(pair[0]); if(b) b.addEventListener('click', () => closeOverlay(pair[1])); });
  
  // Modal overlay clicks
  ['apply-overlay', 'pay-req-overlay', 'delivery-overlay', 'ai-bio-overlay', 'withdraw-overlay', 'payout-setup-overlay'].forEach(id => {
    const el = document.getElementById(id);
    if(el) el.addEventListener('click', (e) => closeOverlay(id, e));
  });
  
  // Apply form
  const aiClBtn = document.getElementById('ai-cl-btn');
  if(aiClBtn) aiClBtn.addEventListener('click', generateCoverLetter);
  const applySubmit = document.getElementById('apply-submit');
  if(applySubmit) applySubmit.addEventListener('click', submitApply);
  
  // Payment request form
  const payReqSubmit = document.getElementById('pay-req-submit');
  if(payReqSubmit) payReqSubmit.addEventListener('click', submitPaymentRequest);
  
  // Delivery form
  const deliverySubmit = document.getElementById('delivery-submit');
  if(deliverySubmit) deliverySubmit.addEventListener('click', submitDelivery);
  
  // AI Bio form
  const aiBioSubmit = document.getElementById('ai-bio-submit');
  if(aiBioSubmit) aiBioSubmit.addEventListener('click', generateBio);
  const usebio = document.getElementById('use-bio-btn');
  if(usebio) usebio.addEventListener('click', useBio);
  
  // Withdraw form
  const wdSubmit = document.getElementById('wd-submit');
  if(wdSubmit) wdSubmit.addEventListener('click', submitWithdraw);
  
  // Payout setup form
  const psUpiTab = document.getElementById('ps-upi-tab');
  if(psUpiTab) psUpiTab.addEventListener('click', () => switchPayoutMethod('upi'));
  const psBankTab = document.getElementById('ps-bank-tab');
  if(psBankTab) psBankTab.addEventListener('click', () => switchPayoutMethod('bank'));
  const psVerifyBtn = document.getElementById('ps-verify-upi-btn');
  if(psVerifyBtn) psVerifyBtn.addEventListener('click', verifyUpi);
  const psUpi = document.getElementById('ps-upi');
  if(psUpi) psUpi.addEventListener('input', clearPayoutProvider);
  const psBankIfsc = document.getElementById('ps-bank-ifsc');
  if(psBankIfsc) psBankIfsc.addEventListener('blur', lookupIfsc);
  const psSaveBtn = document.getElementById('ps-save-btn');
  if(psSaveBtn) psSaveBtn.addEventListener('click', savePayoutInfo);
  
  // Initialize profile tab loading
  const profileTabBtn = document.querySelector('[data-tab="profile"]');
  if(profileTabBtn) profileTabBtn.addEventListener('click', () => { setTimeout(loadProfile, 100); });
});
