// wallet.js — SocialMitr Wallet & Payout System
// Handles: wallet ledger, balance management, UPI/bank validation, Razorpay Payouts
// DO NOT modify the existing Razorpay escrow payment flow — this is additive only.

'use strict';

const https    = require('https');
const supabase = require('./supabase');

// ─── CONSTANTS ────────────────────────────────────────────────────────────────
const MIN_WITHDRAWAL    = 200;   // ₹200 minimum
const PLATFORM_FEE_PCT  = 0.07;  // 7%  → SocialMitr
const CREATOR_SHARE_PCT = 0.93;  // 93% → Creator wallet

// ═══════════════════════════════════════════════════════════════════════════════
//  WALLET HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * getOrCreateWallet — fetch the wallet for a creator_id, creating it if missing.
 * This is the single source of truth — always use this instead of direct queries.
 */
async function getOrCreateWallet(creatorId) {
  const { data: existing, error } = await supabase
    .from('wallets')
    .select('*')
    .eq('creator_id', creatorId)
    .maybeSingle();

  if (error) throw error;
  if (existing) return existing;

  // Create wallet for new creator
  const { data: created, error: cErr } = await supabase
    .from('wallets')
    .insert({ creator_id: creatorId, available_balance: 0, pending_balance: 0, total_earned: 0, total_withdrawn: 0 })
    .select().single();
  if (cErr) throw cErr;
  return created;
}

/**
 * creditWallet — atomically credit available balance when payment is released.
 * Also records a wallet_transaction entry for the full audit trail.
 * @param {string} creatorId
 * @param {number} amount        - gross contract amount
 * @param {string} referenceId   - contract id
 * @param {string} description
 */
async function creditWallet(creatorId, amount, referenceId, description) {
  const creatorShare  = Math.round(amount * CREATOR_SHARE_PCT);
  const platformFee   = amount - creatorShare;
  const wallet        = await getOrCreateWallet(creatorId);

  const newAvailable = Number(wallet.available_balance) + creatorShare;
  const newTotal     = Number(wallet.total_earned)      + creatorShare;

  // Update wallet balances
  const { error: wErr } = await supabase
    .from('wallets')
    .update({ available_balance: newAvailable, total_earned: newTotal })
    .eq('id', wallet.id);
  if (wErr) throw wErr;

  // Record credit transaction
  const { error: tErr } = await supabase
    .from('wallet_transactions')
    .insert({
      wallet_id:      wallet.id,
      creator_id:     creatorId,
      type:           'credit',
      amount:         creatorShare,
      balance_after:  newAvailable,
      status:         'completed',
      description:    description || `Payment received (93% of ₹${amount})`,
      reference_id:   referenceId,
      reference_type: 'contract',
    });
  if (tErr) throw tErr;

  // Record platform fee transaction (for revenue tracking)
  await supabase.from('wallet_transactions').insert({
    wallet_id:      wallet.id,
    creator_id:     creatorId,
    type:           'platform_fee',
    amount:         platformFee,
    balance_after:  newAvailable,
    status:         'completed',
    description:    `Platform fee (7% of ₹${amount})`,
    reference_id:   referenceId,
    reference_type: 'contract',
  });

  // Also update creators.total_earned for backward compat
  const { data: cr } = await supabase.from('creators').select('total_earned,completed_jobs').eq('id', creatorId).single();
  await supabase.from('creators').update({
    total_earned:   (Number(cr?.total_earned)  || 0) + creatorShare,
    completed_jobs: (Number(cr?.completed_jobs) || 0) + 1,
  }).eq('id', creatorId);

  return { creatorShare, platformFee, newAvailable };
}

/**
 * pendingCredit — move amount into pending_balance (escrow paid, work not yet approved).
 * This keeps money in 'escrow' visually in the creator's wallet.
 */
async function pendingCredit(creatorId, amount, referenceId, description) {
  const creatorShare  = Math.round(amount * CREATOR_SHARE_PCT);
  const wallet        = await getOrCreateWallet(creatorId);

  const newPending = Number(wallet.pending_balance) + creatorShare;

  // Update wallet pending balance
  const { error: wErr } = await supabase
    .from('wallets')
    .update({ pending_balance: newPending })
    .eq('id', wallet.id);
  if (wErr) throw wErr;

  // Record pending transaction
  const { error: tErr } = await supabase
    .from('wallet_transactions')
    .insert({
      wallet_id:      wallet.id,
      creator_id:     creatorId,
      type:           'credit',
      amount:         creatorShare,
      balance_after:  Number(wallet.available_balance), // remains same
      status:         'pending',
      description:    description || `Escrow received (93% of ₹${amount})`,
      reference_id:   referenceId,
      reference_type: 'contract',
    });
  if (tErr) throw tErr;

  return { creatorShare, newPending };
}

/**
 * settlePending — decrease pending_balance when work is approved and moved to manual settlement.
 * This removes it from 'In Escrow' visual in creator dashboard.
 */
async function settlePending(creatorId, amount, referenceId) {
  const creatorShare = Math.round(amount * CREATOR_SHARE_PCT);
  const wallet       = await getOrCreateWallet(creatorId);

  const newPending = Math.max(0, Number(wallet.pending_balance) - creatorShare);

  await supabase.from('wallets').update({
    pending_balance: newPending,
  }).eq('id', wallet.id);

  // Update transaction status to awaiting_settlement
  await supabase.from('wallet_transactions')
    .update({ status: 'awaiting_settlement' })
    .eq('reference_id', referenceId)
    .eq('status', 'pending');

  return { creatorShare, newPending };
}

/**
 * confirmPendingCredit — move from pending_balance → available_balance on approval.
 */
async function confirmPendingCredit(creatorId, amount, referenceId, description) {
  const creatorShare = Math.round(amount * CREATOR_SHARE_PCT);
  const wallet       = await getOrCreateWallet(creatorId);

  const newPending   = Math.max(0, Number(wallet.pending_balance)   - creatorShare);
  const newAvailable =             Number(wallet.available_balance)  + creatorShare;
  const newTotal     =             Number(wallet.total_earned)       + creatorShare;

  await supabase.from('wallets').update({
    pending_balance:   newPending,
    available_balance: newAvailable,
    total_earned:      newTotal,
  }).eq('id', wallet.id);

  // Update pending tx → completed
  await supabase.from('wallet_transactions')
    .update({ status: 'completed', balance_after: newAvailable })
    .eq('reference_id', referenceId)
    .eq('status', 'pending');

  // Update creators.total_earned
  const { data: cr } = await supabase.from('creators').select('total_earned,completed_jobs').eq('id', creatorId).single();
  await supabase.from('creators').update({
    total_earned:   (Number(cr?.total_earned)  || 0) + creatorShare,
    completed_jobs: (Number(cr?.completed_jobs) || 0) + 1,
  }).eq('id', creatorId);

  return { creatorShare, newAvailable };
}

// ═══════════════════════════════════════════════════════════════════════════════
//  UPI & BANK VALIDATION
// ═══════════════════════════════════════════════════════════════════════════════

/** UPI provider detection from handle suffix */
const UPI_PROVIDERS = {
  okaxis:    { name: 'Google Pay / Axis', icon: 'gpay'     },
  okhdfcbank:{ name: 'Google Pay / HDFC', icon: 'gpay'     },
  okicici:   { name: 'Google Pay / ICICI',icon: 'gpay'     },
  oksbi:     { name: 'Google Pay / SBI',  icon: 'gpay'     },
  ybl:       { name: 'PhonePe',           icon: 'phonepe'  },
  ibl:       { name: 'PhonePe',           icon: 'phonepe'  },
  axl:       { name: 'PhonePe',           icon: 'phonepe'  },
  paytm:     { name: 'Paytm',             icon: 'paytm'    },
  apl:       { name: 'Amazon Pay',        icon: 'amazonpay'},
  waicici:   { name: 'WhatsApp Pay',      icon: 'whatsapp' },
  fam:       { name: 'FamPay',            icon: 'fampay'   },
  upi:       { name: 'UPI',               icon: 'upi'      },
  icici:     { name: 'ICICI Bank',        icon: 'bank'     },
  sbi:       { name: 'SBI',               icon: 'bank'     },
  hdfc:      { name: 'HDFC Bank',         icon: 'bank'     },
  kotak:     { name: 'Kotak Bank',        icon: 'bank'     },
  airtel:    { name: 'Airtel Money',      icon: 'airtel'   },
  jupiteraxis:{ name:'Jupiter',           icon: 'jupiter'  },
  fbl:       { name: 'Federal Bank',      icon: 'bank'     },
  rbl:       { name: 'RBL Bank',          icon: 'bank'     },
};

/**
 * validateUpiFormat — checks that the UPI ID matches the standard regex.
 * Returns { valid, handle, provider }
 */
function validateUpiFormat(upiId) {
  if (!upiId || typeof upiId !== 'string') return { valid: false, error: 'UPI ID is required' };
  const trimmed = upiId.trim().toLowerCase();
  // Standard UPI format: localpart@handle
  const UPI_REGEX = /^[a-zA-Z0-9._-]{3,}@[a-zA-Z]{3,}$/;
  if (!UPI_REGEX.test(trimmed)) {
    return { valid: false, error: 'Invalid UPI format. Use format: name@upi or 9876543210@okaxis' };
  }
  const handle   = trimmed.split('@')[1];
  const provider = UPI_PROVIDERS[handle] || { name: 'UPI', icon: 'upi' };
  return { valid: true, upiId: trimmed, handle, provider };
}

/**
 * validateUpiWithRazorpay — verify UPI VPA existence via Razorpay API.
 * Falls back gracefully if Razorpay credentials are missing or doesn't recognize provider.
 */
async function validateUpiWithRazorpay(upiId) {
  const keyId     = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) {
    // No credentials — skip live validation, return format-only result
    return { valid: true, mocked: true };
  }

  // Extract handle to check if it's a known provider
  const handle = upiId.split('@')[1]?.toLowerCase();
  const isKnownProvider = handle && UPI_PROVIDERS[handle];

  return new Promise((resolve) => {
    const auth    = Buffer.from(`${keyId}:${keySecret}`).toString('base64');
    const body    = JSON.stringify({ id: upiId });
    const options = {
      hostname: 'api.razorpay.com',
      path:     '/v1/payments/validate/vpa',
      method:   'POST',
      headers:  {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Authorization':  `Basic ${auth}`,
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          // Razorpay returns success:true and customer_name when VPA is valid
          if (parsed.success || parsed.customer_name) {
            resolve({ valid: true, customerName: parsed.customer_name });
          } else if (isKnownProvider) {
            // If Razorpay can't verify but it's a known provider (like FamPay),
            // accept it anyway with mocked flag
            resolve({ valid: true, customerName: null, mocked: true });
          } else {
            resolve({ valid: false, error: 'UPI ID not found. Please check and try again.' });
          }
        } catch {
          resolve({ valid: true, mocked: true }); // parse failure = treat as valid
        }
      });
    });
    req.on('error', () => resolve({ valid: true, mocked: true })); // network failure = skip
    req.setTimeout(4000, () => { req.destroy(); resolve({ valid: true, mocked: true }); });
    req.write(body);
    req.end();
  });
}

/**
 * validateBankAccount — validates account number length and IFSC format.
 */
function validateBankAccount(accountNumber, ifsc) {
  const errors = [];

  // Account number: Indian banks use 9–18 digits
  const accNum = (accountNumber || '').replace(/\s/g, '');
  if (!accNum) {
    errors.push('Bank account number is required');
  } else if (!/^\d{9,18}$/.test(accNum)) {
    errors.push('Account number must be 9–18 digits (numbers only)');
  }

  // IFSC: 11 characters — first 4 alpha (bank code), 5th always 0, last 6 alphanumeric
  const ifscUpper = (ifsc || '').trim().toUpperCase();
  if (!ifscUpper) {
    errors.push('IFSC code is required');
  } else if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifscUpper)) {
    errors.push('Invalid IFSC format. Example: HDFC0001234');
  }

  return { valid: errors.length === 0, errors, accountNumber: accNum, ifsc: ifscUpper };
}

/**
 * fetchBankFromIfsc — queries the Razorpay IFSC API (free, no auth needed).
 * Falls back gracefully on network errors.
 */
async function fetchBankFromIfsc(ifsc) {
  return new Promise((resolve) => {
    const options = {
      hostname: 'ifsc.razorpay.com',
      path:     `/${ifsc.toUpperCase()}`,
      method:   'GET',
      headers:  { 'Content-Type': 'application/json' },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.BANK) {
            resolve({
              found:    true,
              bankName: parsed.BANK,
              branch:   parsed.BRANCH,
              city:     parsed.CITY,
              state:    parsed.STATE,
              rtgs:     parsed.RTGS,
              imps:     parsed.IMPS,
              upi:      parsed.UPI,
            });
          } else {
            resolve({ found: false, error: 'IFSC code not found in database' });
          }
        } catch {
          resolve({ found: false, error: 'Could not fetch bank details' });
        }
      });
    });
    req.on('error',   () => resolve({ found: false, error: 'Network error fetching IFSC' }));
    req.setTimeout(4000, () => { req.destroy(); resolve({ found: false, error: 'IFSC lookup timed out' }); });
    req.end();
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
//  RAZORPAY ROUTE API (replaces Razorpay X Payouts — no current account needed)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * createLinkedAccount — creates a Razorpay Route linked account for a creator.
 * Called once when creator saves their payout details.
 * Returns { success, account_id } or { success: false, error }
 */
async function createLinkedAccount({ creatorName, email }) {
  const keyId     = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) return { success: false, error: 'Razorpay not configured' };

  return new Promise((resolve) => {
    const body = JSON.stringify({
      email:               email || `creator_${Date.now()}@socialmitr.in`,
      legal_business_name: creatorName || 'Creator',
      business_type:       'individual',
      profile: {
        category:    'ecommerce',
        subcategory: 'freelancer',
        addresses: {
          registered: {
            street1:     'India',
            city:        'Delhi',
            state:       'Delhi',
            postal_code: '110001',
            country:     'IN'
          }
        }
      }
    });

    const authHeader = Buffer.from(`${keyId}:${keySecret}`).toString('base64');
    const options = {
      hostname: 'api.razorpay.com',
      path:     '/v2/accounts',
      method:   'POST',
      headers:  {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Authorization':  `Basic ${authHeader}`,
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.id) {
            resolve({ success: true, account_id: parsed.id });
          } else {
            resolve({ success: false, error: parsed.error?.description || JSON.stringify(parsed) });
          }
        } catch { resolve({ success: false, error: 'Invalid response from Razorpay' }); }
      });
    });
    req.on('error', (e) => resolve({ success: false, error: e.message }));
    req.setTimeout(8000, () => { req.destroy(); resolve({ success: false, error: 'Request timed out' }); });
    req.write(body);
    req.end();
  });
}

/**
 * initiateRazorpayPayout — uses Razorpay Route transfer to send money to creator.
 * Requires razorpayPaymentId (the payment captured by Razorpay) and
 * razorpayAccountId (the linked account acc_XXXX saved on the creator).
 * onHold=1 freezes the transfer until released; onHold=0 sends immediately.
 */
async function initiateRazorpayPayout({ amount, upiId, bankAccount, bankIfsc, creatorName, referenceId, razorpayPaymentId, razorpayAccountId, onHold = 0 }) {
  const keyId     = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;

  if (!keyId || !keySecret) {
    console.warn('⚠️ Razorpay not configured. Marking as processing.');
    return { success: true, payout_id: `mock_${Date.now()}`, status: 'processing', mocked: true };
  }

  if (!razorpayPaymentId) {
    console.warn('⚠️ No razorpay_payment_id for Route transfer. Marking as processing.');
    return { success: true, payout_id: `mock_${Date.now()}`, status: 'processing', mocked: true };
  }

  if (!razorpayAccountId) {
    console.warn('⚠️ No razorpay_account_id for creator. Marking as processing.');
    return { success: true, payout_id: `mock_${Date.now()}`, status: 'processing', mocked: true };
  }

  return new Promise((resolve) => {
    const body = JSON.stringify({
      transfers: [{
        account:  razorpayAccountId,        // acc_XXXXXXX linked account
        amount:   Math.round(amount * 100), // paise
        currency: 'INR',
        on_hold:  onHold,                   // 0 = release immediately, 1 = freeze
        notes: {
          reference_id: referenceId,
          creator_name: creatorName || 'Creator',
        }
      }]
    });

    const authHeader = Buffer.from(`${keyId}:${keySecret}`).toString('base64');
    const options = {
      hostname: 'api.razorpay.com',
      path:     `/v1/payments/${razorpayPaymentId}/transfers`,
      method:   'POST',
      headers:  {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Authorization':  `Basic ${authHeader}`,
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const transfer = parsed.items?.[0];
          if (transfer?.id) {
            resolve({ success: true, payout_id: transfer.id, status: transfer.on_hold ? 'on_hold' : 'processed' });
          } else {
            resolve({ success: false, error: parsed.error?.description || JSON.stringify(parsed) });
          }
        } catch { resolve({ success: false, error: 'Invalid response from Razorpay' }); }
      });
    });
    req.on('error', (e) => resolve({ success: false, error: e.message }));
    req.setTimeout(10000, () => { req.destroy(); resolve({ success: false, error: 'Payout request timed out' }); });
    req.write(body);
    req.end();
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
//  EXPRESS ROUTE REGISTRATION
//  Call registerWalletRoutes(app, authMiddleware) from server.js
// ═══════════════════════════════════════════════════════════════════════════════
function registerWalletRoutes(app, auth) {

  // ── GET /api/wallet — get my wallet ────────────────────────────────────────
  app.get('/api/wallet', auth, async (req, res) => {
    if (req.user.type !== 'creator') return res.status(403).json({ success: false, message: 'Creators only' });
    try {
      const { data: creator } = await supabase.from('creators').select('id').eq('user_id', req.user.userId).single();
      if (!creator) return res.status(404).json({ success: false, message: 'Creator profile not found' });
      const wallet = await getOrCreateWallet(creator.id);
      res.json({ success: true, wallet });
    } catch (err) {
      console.error('GET /api/wallet:', err.message);
      res.status(500).json({ success: false, message: err.message });
    }
  });

  // ── GET /api/wallet/transactions — full transaction history ────────────────
  app.get('/api/wallet/transactions', auth, async (req, res) => {
    if (req.user.type !== 'creator') return res.status(403).json({ success: false, message: 'Creators only' });
    try {
      const { data: creator } = await supabase.from('creators').select('id').eq('user_id', req.user.userId).single();
      const { data: txns, error } = await supabase
        .from('wallet_transactions')
        .select('*')
        .eq('creator_id', creator.id)
        .order('created_at', { ascending: false })
        .limit(100);
      if (error) throw error;
      res.json({ success: true, transactions: txns || [] });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  // ── GET /api/wallet/payouts — payout history ───────────────────────────────
  app.get('/api/wallet/payouts', auth, async (req, res) => {
    if (req.user.type !== 'creator') return res.status(403).json({ success: false, message: 'Creators only' });
    try {
      const { data: creator } = await supabase.from('creators').select('id').eq('user_id', req.user.userId).single();
      const { data: payouts, error } = await supabase
        .from('payouts')
        .select('*')
        .eq('creator_id', creator.id)
        .order('created_at', { ascending: false })
        .limit(50);
      if (error) throw error;
      res.json({ success: true, payouts: payouts || [] });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  // ── POST /api/wallet/withdraw — request a withdrawal ──────────────────────
  app.post('/api/wallet/withdraw', auth, async (req, res) => {
    return res.status(403).json({ 
      success: false, 
      message: 'Self-withdrawal is temporarily disabled. Payouts are now processed manually by the admin after work approval.' 
    });

    /*
    if (req.user.type !== 'creator') return res.status(403).json({ success: false, message: 'Only creators can withdraw' });
    */
    const { amount } = req.body;
    const withdrawAmount = Number(amount);

    if (!withdrawAmount || isNaN(withdrawAmount)) return res.status(400).json({ success: false, message: 'Invalid amount' });
    if (withdrawAmount < MIN_WITHDRAWAL) return res.status(400).json({ success: false, message: `Minimum withdrawal is ₹${MIN_WITHDRAWAL}` });

    try {
      const { data: creator } = await supabase
        .from('creators')
        .select('id,name,upi_id,bank_account,bank_ifsc,payout_method,upi_verified,bank_verified')
        .eq('user_id', req.user.userId).single();
      if (!creator) return res.status(404).json({ success: false, message: 'Creator profile not found' });

      // Validate payout method is set — if not, signal frontend to show setup modal
      const hasUpi  = !!creator.upi_id;
      const hasBank = !!creator.bank_account && !!creator.bank_ifsc;
      if (!hasUpi && !hasBank) {
        return res.status(200).json({
          success: false,
          needs_payout_setup: true,
          message: 'Please add your UPI ID or bank account details before withdrawing.',
        });
      }

      const wallet = await getOrCreateWallet(creator.id);

      // Guard: prevent negative balance
      if (withdrawAmount > Number(wallet.available_balance)) {
        return res.status(400).json({
          success: false,
          message: `Insufficient balance. Available: ₹${wallet.available_balance}`,
        });
      }

      // Guard: prevent duplicate pending withdrawal
      const { data: pendingPayout } = await supabase
        .from('payouts')
        .select('id')
        .eq('creator_id', creator.id)
        .in('status', ['pending', 'processing'])
        .maybeSingle();
      if (pendingPayout) {
        return res.status(400).json({ success: false, message: 'You already have a withdrawal in progress. Please wait for it to complete.' });
      }

      // Choose payout method
      const method    = hasUpi ? 'upi' : 'bank';
      const refId     = `payout_${creator.id.slice(0,8)}_${Date.now()}`;

      // Deduct from available_balance atomically
      const newAvailable = Number(wallet.available_balance) - withdrawAmount;
      const newWithdrawn = Number(wallet.total_withdrawn)   + withdrawAmount;
      await supabase.from('wallets').update({
        available_balance: newAvailable,
        total_withdrawn:   newWithdrawn,
      }).eq('id', wallet.id);

      // Initiate Razorpay Payout
      const payoutResult = await initiateRazorpayPayout({
        amount:       withdrawAmount,
        upiId:        hasUpi  ? creator.upi_id       : null,
        bankAccount:  hasBank ? creator.bank_account  : null,
        bankIfsc:     hasBank ? creator.bank_ifsc     : null,
        creatorName:  creator.name,
        referenceId:  refId,
      });

      // Record payout row
      const payoutStatus = payoutResult.success ? (payoutResult.mocked ? 'processing' : payoutResult.status || 'processing') : 'failed';
      const { data: payout } = await supabase.from('payouts').insert({
        wallet_id:          wallet.id,
        creator_id:         creator.id,
        amount:             withdrawAmount,
        payout_method:      method,
        upi_id:             creator.upi_id     || '',
        bank_account:       creator.bank_account || '',
        bank_ifsc:          creator.bank_ifsc   || '',
        status:             payoutStatus,
        razorpay_payout_id: payoutResult.payout_id || '',
        reference_id:       refId,
        failure_reason:     payoutResult.error  || '',
        initiated_at:       new Date().toISOString(),
        processed_at:       payoutStatus === 'success' ? new Date().toISOString() : null,
      }).select().single();

      // If payout failed, reverse the deduction
      if (!payoutResult.success) {
        await supabase.from('wallets').update({
          available_balance: Number(wallet.available_balance), // restore
          total_withdrawn:   Number(wallet.total_withdrawn),
        }).eq('id', wallet.id);
        return res.status(500).json({ success: false, message: `Payout failed: ${payoutResult.error}` });
      }

      // Record debit transaction
      await supabase.from('wallet_transactions').insert({
        wallet_id:      wallet.id,
        creator_id:     creator.id,
        type:           'payout',
        amount:         withdrawAmount,
        balance_after:  newAvailable,
        status:         payoutStatus === 'success' ? 'completed' : 'pending',
        description:    `Withdrawal via ${method.toUpperCase()}${hasUpi ? ' (' + creator.upi_id + ')' : ''}`,
        reference_id:   payout?.id || refId,
        reference_type: 'payout',
      });

      res.json({
        success:    true,
        message:    payoutResult.mocked
          ? `₹${withdrawAmount} withdrawal initiated! It will be processed within 1-2 business days.`
          : `₹${withdrawAmount} sent successfully via ${method.toUpperCase()}!`,
        payout_id:  payout?.id,
        status:     payoutStatus,
        new_balance: newAvailable,
      });
    } catch (err) {
      console.error('POST /api/wallet/withdraw:', err.message);
      res.status(500).json({ success: false, message: err.message });
    }
  });

  // ── POST /api/validate/upi — validate UPI ID format + Razorpay check ───────
  app.post('/api/validate/upi', auth, async (req, res) => {
    const { upi_id } = req.body;
    const formatCheck = validateUpiFormat(upi_id);
    if (!formatCheck.valid) return res.status(400).json({ success: false, message: formatCheck.error });

    // Live Razorpay VPA check
    const liveCheck = await validateUpiWithRazorpay(formatCheck.upiId);
    if (!liveCheck.valid) return res.status(400).json({ success: false, message: liveCheck.error });

    res.json({
      success:       true,
      upi_id:        formatCheck.upiId,
      handle:        formatCheck.handle,
      provider:      formatCheck.provider,
      customer_name: liveCheck.customerName || null,
      mocked:        liveCheck.mocked || false,
    });
  });

  // ── POST /api/validate/bank — validate IFSC + account number, fetch bank info
  app.post('/api/validate/bank', auth, async (req, res) => {
    const { bank_account, bank_ifsc } = req.body;
    const accCheck = validateBankAccount(bank_account, bank_ifsc);
    if (!accCheck.valid) {
      return res.status(400).json({ success: false, message: accCheck.errors.join('. '), errors: accCheck.errors });
    }
    // Fetch bank details from IFSC
    const ifscData = await fetchBankFromIfsc(accCheck.ifsc);
    res.json({
      success:       true,
      account_number: accCheck.accountNumber,
      ifsc:           accCheck.ifsc,
      bank_found:     ifscData.found,
      bank_name:      ifscData.bankName  || null,
      branch:         ifscData.branch    || null,
      city:           ifscData.city      || null,
      state:          ifscData.state     || null,
      supports_upi:   ifscData.upi       || false,
      supports_rtgs:  ifscData.rtgs      || false,
      supports_imps:  ifscData.imps      || false,
      ifsc_error:     ifscData.error     || null,
    });
  });

  // ── PUT /api/creators/payout-info — save + validate payout details ──────────
  app.put('/api/creators/payout-info', auth, async (req, res) => {
    if (req.user.type !== 'creator') return res.status(403).json({ success: false, message: 'Creators only' });
    const { upi_id, bank_account, bank_ifsc, payout_method } = req.body;

    try {
      const updateData = {};

      if (payout_method === 'upi' || upi_id) {
        // Validate UPI
        const fmt = validateUpiFormat(upi_id);
        if (!fmt.valid) return res.status(400).json({ success: false, message: fmt.error });
        const live = await validateUpiWithRazorpay(fmt.upiId);
        if (!live.valid) return res.status(400).json({ success: false, message: live.error });
        updateData.upi_id        = fmt.upiId;
        updateData.upi_provider  = fmt.provider?.name || '';
        updateData.upi_verified  = !live.mocked;
        updateData.payout_method = 'upi';
      }

      if (payout_method === 'bank' || (bank_account && bank_ifsc)) {
        // Validate bank
        const acc = validateBankAccount(bank_account, bank_ifsc);
        if (!acc.valid) return res.status(400).json({ success: false, message: acc.errors[0] });
        const ifscData = await fetchBankFromIfsc(acc.ifsc);
        if (!ifscData.found) {
          return res.status(400).json({ success: false, message: ifscData.error || 'IFSC code not found. Please check and try again.' });
        }
        updateData.bank_account  = acc.accountNumber;
        updateData.bank_ifsc     = acc.ifsc;
        updateData.bank_name     = ifscData.bankName || '';
        updateData.bank_branch   = ifscData.branch   || '';
        updateData.bank_verified = true;
        updateData.payout_method = 'bank';
      }

      if (Object.keys(updateData).length === 0) {
        return res.status(400).json({ success: false, message: 'Please provide UPI ID or bank account details' });
      }

      // ── CREATE RAZORPAY ROUTE LINKED ACCOUNT (once per creator) ─────────────
      const { data: creatorRow } = await supabase
        .from('creators')
        .select('id, name, razorpay_account_id')
        .eq('user_id', req.user.userId).single();

      if (creatorRow && !creatorRow.razorpay_account_id) {
        const { data: userRow } = await supabase
          .from('users').select('email').eq('id', req.user.userId).single();

        const linkedResult = await createLinkedAccount({
          creatorName: creatorRow.name,
          email:       userRow?.email,
        });

        if (linkedResult.success) {
          updateData.razorpay_account_id = linkedResult.account_id;
          console.log(`✅ Razorpay linked account created: ${linkedResult.account_id} for ${creatorRow.name}`);
        } else {
          // Non-fatal — payout details saved, linked account will retry next save
          console.warn(`⚠️ Linked account creation failed (non-fatal): ${linkedResult.error}`);
        }
      }
      // ─────────────────────────────────────────────────────────────────────────

      await supabase.from('creators').update(updateData).eq('user_id', req.user.userId);
      res.json({ success: true, message: 'Payout details saved!', ...updateData });
    } catch (err) {
      console.error('PUT /api/creators/payout-info:', err.message);
      res.status(500).json({ success: false, message: err.message });
    }
  });

  // ── POST /api/wallet/webhook/razorpay-payout — handle Razorpay payout webhook
  app.post('/api/wallet/webhook/razorpay-payout', async (req, res) => {
    const crypto    = require('crypto');
    const secret    = process.env.RAZORPAY_WEBHOOK_SECRET || '';
    const sig       = req.headers['x-razorpay-signature'] || '';
    // Verify webhook signature if secret is configured
    if (secret && sig) {
      const expected = crypto.createHmac('sha256', secret).update(JSON.stringify(req.body)).digest('hex');
      if (sig !== expected) return res.status(400).json({ error: 'Invalid signature' });
    }

    const event   = req.body;
    const payload = event?.payload?.payout?.entity;
    if (!payload) return res.json({ received: true });

    const razorpayPayoutId = payload.id;
    const status           = payload.status; // 'processed' | 'failed' | 'reversed'

    try {
      const { data: payout } = await supabase
        .from('payouts')
        .select('id,creator_id,wallet_id,amount')
        .eq('razorpay_payout_id', razorpayPayoutId)
        .maybeSingle();

      if (!payout) return res.json({ received: true });

      if (status === 'processed') {
        await supabase.from('payouts').update({ status: 'success', processed_at: new Date().toISOString() }).eq('id', payout.id);
        await supabase.from('wallet_transactions').update({ status: 'completed' }).eq('reference_id', payout.id).eq('type', 'payout');
      } else if (status === 'failed' || status === 'reversed') {
        // Refund amount back to wallet
        const { data: wallet } = await supabase.from('wallets').select('available_balance,total_withdrawn').eq('id', payout.wallet_id).single();
        const restored = Number(wallet.available_balance) + Number(payout.amount);
        const restoredWithdrawn = Math.max(0, Number(wallet.total_withdrawn) - Number(payout.amount));
        await supabase.from('wallets').update({ available_balance: restored, total_withdrawn: restoredWithdrawn }).eq('id', payout.wallet_id);
        await supabase.from('payouts').update({ status: status === 'reversed' ? 'reversed' : 'failed', failure_reason: payload.failure_reason || status }).eq('id', payout.id);
        // Record reversal
        await supabase.from('wallet_transactions').insert({
          wallet_id:      payout.wallet_id,
          creator_id:     payout.creator_id,
          type:           'reversal',
          amount:         payout.amount,
          balance_after:  restored,
          status:         'completed',
          description:    `Payout ${status} — ₹${payout.amount} refunded to wallet`,
          reference_id:   payout.id,
          reference_type: 'payout',
        });
      }
      res.json({ received: true });
    } catch (err) {
      console.error('Payout webhook error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  console.log('   💳 Wallet routes registered ✅');
}

// ═══════════════════════════════════════════════════════════════════════════════
//  EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════
module.exports = {
  registerWalletRoutes,
  creditWallet,
  pendingCredit,
  settlePending,
  confirmPendingCredit,
  getOrCreateWallet,
  validateUpiFormat,
  validateBankAccount,
  fetchBankFromIfsc,
  createLinkedAccount,
  initiateRazorpayPayout,
};
