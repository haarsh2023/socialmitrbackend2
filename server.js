// server.js — SocialMitr Backend v5 (Bug fixes + Admin stats + Contact email)
require('dotenv').config();
const express = require('express');
const https = require('https');
const nodemailer = require('nodemailer');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const supabase = require('./supabase');
const { editorWelcomeEmail, businessWelcomeEmail, applicationNotificationEmail, applicationStatusEmail, paymentRequestEmail, paymentReleasedEmail } = require('./emailTemplates');
const { registerWalletRoutes, creditWallet, pendingCredit, confirmPendingCredit } = require('./wallet');

const app = express();
const PORT = process.env.PORT || 3000;

if (!process.env.JWT_SECRET) {
  if (process.env.NODE_ENV === 'production') {
    console.error('FATAL ERROR: JWT_SECRET is not defined. Exiting...');
    process.exit(1);
  } else {
    console.warn('⚠️ WARNING: JWT_SECRET is not defined. Using insecure fallback.');
  }
}
const JWT_SECRET = process.env.JWT_SECRET || 'socialmitr-secret';

function escapeHtml(unsafe) {
  if (!unsafe) return '';
  return String(unsafe)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

console.log('\n🔍 Environment:');
console.log('   SUPABASE_URL        :', process.env.SUPABASE_URL ? '✅ ' + process.env.SUPABASE_URL : '❌ MISSING');
console.log('   SUPABASE_SERVICE_KEY:', process.env.SUPABASE_SERVICE_KEY ? '✅ set' : '❌ MISSING');
console.log('   BREVO_LOGIN         :', process.env.BREVO_LOGIN ? '✅ ' + process.env.BREVO_LOGIN : '❌ MISSING');
console.log('   ANTHROPIC_API_KEY   :', process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY !== 'sk-ant-your-key-here' ? '✅ set (AI features enabled)' : '❌ MISSING (AI features disabled)');
console.log('   RAZORPAY_KEY_ID     :', process.env.RAZORPAY_KEY_ID ? '✅ set' : '❌ MISSING (payments disabled)');
console.log('   RAZORPAY_ACCT_NUM   :', process.env.RAZORPAY_ACCOUNT_NUMBER ? '✅ set (Payouts enabled)' : '⚠️  MISSING (Payouts will queue as processing)');
console.log('');

const allowedOrigins = process.env.FRONTEND_URL ? [process.env.FRONTEND_URL] : ['http://localhost:3000', 'http://127.0.0.1:3000'];
app.use(cors({
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.includes(origin) || !process.env.FRONTEND_URL) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  }
}));
app.use(express.json());
app.use(express.static(__dirname));

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 15, message: { success: false, message: 'Too many attempts, please try again later.' } });
const generalLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 50, message: { success: false, message: 'Too many requests, please try again later.' } });
const contactLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 5, message: { success: false, message: 'Too many messages sent, please try again later.' } });
const aiLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, message: { success: false, message: 'Too many AI requests, please try again later.' } });

// ─── EMAIL ────────────────────────────────────────────────────────────────────
const transporter = nodemailer.createTransport({
  host: 'smtp-relay.brevo.com', port: 465, secure: true,
  auth: { user: process.env.BREVO_LOGIN, pass: process.env.BREVO_SMTP_KEY }
});
transporter.verify(err => err
  ? console.error('❌ SMTP:', err.message)
  : console.log('   SMTP                : ✅ connected\n')
);

async function sendEmail(to, tpl) {
  if (!to || !tpl) return;
  const from = `"${process.env.MAIL_FROM_NAME || 'SocialMitr'}" <${process.env.MAIL_FROM_ADDRESS || process.env.BREVO_LOGIN}>`;
  try { return await transporter.sendMail({ from, to, subject: tpl.subject, html: tpl.html, text: tpl.text }); }
  catch (e) { console.error('Email error (non-fatal):', e.message); }
}


// ─── ANTHROPIC AI HELPER (uses built-in https, works on all Node versions) ─────
function callClaude(prompt, maxTokens = 400) {
  return new Promise((resolve, reject) => {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey || apiKey === 'sk-ant-your-key-here' || apiKey.includes('xxxx')) {
      return reject(new Error('Add your ANTHROPIC_API_KEY to .env — get it free at console.anthropic.com'));
    }
    const body = JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }]
    });
    const options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) return reject(new Error(parsed.error.message));
          const text = parsed.content?.[0]?.text || '';
          resolve(text);
        } catch (e) { reject(new Error('Invalid AI response: ' + data.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function notify(user_id, title, message, type = 'info', link = '') {
  try { await supabase.from('notifications').insert({ user_id, title, message, type, link }); }
  catch (e) { console.error('Notify error:', e.message); }
}

// ─── AUTH MIDDLEWARE ──────────────────────────────────────────────────────────
function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ success: false, message: 'Please log in' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ success: false, message: 'Session expired. Please log in again.' }); }
}

const COLORS = ['#ff6b2b', '#06d6a0', '#a855f7', '#0ea5e9', '#f59e0b', '#ec4899', '#10b981'];

// ═══════════════════════════════════════════════════════════════════════════════
//  AUTH
// ═══════════════════════════════════════════════════════════════════════════════
app.post('/api/register/editor', authLimiter, async (req, res) => {
  // Bank/UPI details are NOT required at signup — creators add them later before withdrawing
  const { name, email, city, primarySkill, niche, rate, password } = req.body;
  if (!name || !email || !city || !primarySkill || !niche || !rate || !password)
    return res.status(400).json({ success: false, message: 'All fields are required' });
  if (password.length < 6)
    return res.status(400).json({ success: false, message: 'Password must be at least 6 characters' });
  try {
    const { data: existing } = await supabase.from('users').select('id').eq('email', email).maybeSingle();
    if (existing) return res.status(400).json({ success: false, message: 'Email already registered. Please log in.' });
    const hash = await bcrypt.hash(password, 10);
    const initials = name.trim().split(/\s+/).map(w => w[0]).join('').toUpperCase().slice(0, 2);
    const color = COLORS[Math.floor(Math.random() * COLORS.length)];
    const { data: user, error: uErr } = await supabase.from('users').insert({ email, password_hash: hash, type: 'creator' }).select().single();
    if (uErr) throw uErr;
    const { data: creator, error: cErr } = await supabase.from('creators').insert({ user_id: user.id, name, city, primary_skill: primarySkill, niche, rate, avatar_initials: initials, avatar_color: color }).select().single();
    if (cErr) throw cErr;
    const token = jwt.sign({ userId: user.id, type: 'creator', creatorId: creator.id }, JWT_SECRET, { expiresIn: '90d' });
    const dashboardLink = `${req.protocol}://${req.get('host')}/creator-dashboard.html?autotoken=${token}`;
    sendEmail(email, editorWelcomeEmail({ name, city, primarySkill, niche, rate, dashboardLink }));
    res.json({ success: true, token, type: 'creator', message: `Welcome ${name}!` });
  } catch (err) { console.error('Register creator:', err.message); res.status(500).json({ success: false, message: err.message }); }
});

app.post('/api/register/business', authLimiter, async (req, res) => {
  const { businessName, name, email, businessType, city, budget, password } = req.body;
  if (!businessName || !name || !email || !businessType || !city || !budget || !password)
    return res.status(400).json({ success: false, message: 'All fields are required' });
  if (password.length < 6)
    return res.status(400).json({ success: false, message: 'Password must be at least 6 characters' });
  try {
    const { data: existing } = await supabase.from('users').select('id').eq('email', email).maybeSingle();
    if (existing) return res.status(400).json({ success: false, message: 'Email already registered. Please log in.' });
    const hash = await bcrypt.hash(password, 10);
    const { data: user, error: uErr } = await supabase.from('users').insert({ email, password_hash: hash, type: 'business' }).select().single();
    if (uErr) throw uErr;
    const { error: bErr } = await supabase.from('businesses').insert({ user_id: user.id, business_name: businessName, owner_name: name, business_type: businessType, city, budget });
    if (bErr) throw bErr;
    const token = jwt.sign({ userId: user.id, type: 'business' }, JWT_SECRET, { expiresIn: '90d' });
    const dashboardLink = `${req.protocol}://${req.get('host')}/business-dashboard.html?autotoken=${token}`;
    sendEmail(email, businessWelcomeEmail({ name, businessName, businessType, city, budget, dashboardLink }));
    res.json({ success: true, token, type: 'business', message: `${businessName} is live!` });
  } catch (err) { console.error('Register business:', err.message); res.status(500).json({ success: false, message: err.message }); }
});

app.post('/api/auth/login', authLimiter, async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ success: false, message: 'Email and password required' });
  try {
    const { data: user } = await supabase.from('users').select('*').eq('email', email).single();
    if (!user) return res.status(401).json({ success: false, message: 'No account found with this email' });
    if (!await bcrypt.compare(password, user.password_hash))
      return res.status(401).json({ success: false, message: 'Incorrect password' });
    let extra = {};
    if (user.type === 'creator') {
      const { data: c } = await supabase.from('creators').select('id').eq('user_id', user.id).single();
      extra = { creatorId: c?.id };
    }
    const token = jwt.sign({ userId: user.id, type: user.type, ...extra }, JWT_SECRET, { expiresIn: '90d' });
    res.json({ success: true, token, type: user.type });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.get('/api/auth/me', auth, async (req, res) => {
  try {
    const { data: user } = await supabase.from('users').select('id,email,type').eq('id', req.user.userId).single();
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    const table = user.type === 'creator' ? 'creators' : 'businesses';
    const { data: profile } = await supabase.from(table).select('*').eq('user_id', user.id).single();
    res.json({ success: true, user: { ...user, profile } });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  CONTACT FORM — sends real email to socialmitr.company@gmail.com
// ═══════════════════════════════════════════════════════════════════════════════
app.post('/api/contact', contactLimiter, async (req, res) => {
  const { name, email, type, subject, message } = req.body;
  if (!name || !email || !subject || !message)
    return res.status(400).json({ success: false, message: 'All fields required' });
  try {
    const safeName = escapeHtml(name);
    const safeSubject = escapeHtml(subject);
    const safeMessage = escapeHtml(message);
    const safeType = escapeHtml(type);

    await sendEmail('socialmitr.company@gmail.com', {
      subject: `[SocialMitr Contact] ${safeSubject} — from ${safeName}`,
      html: `
        <div style="font-family:'Segoe UI',sans-serif;background:#0f0f0f;color:#f0ece4;padding:32px;border-radius:12px;max-width:560px">
          <h2 style="color:#ff6b2b;margin:0 0 20px">📧 New Contact Form Message</h2>
          <table width="100%" cellpadding="0" cellspacing="0" style="background:#1e1e1e;border:1px solid #2a2a2a;border-radius:10px;overflow:hidden">
            <tr><td style="padding:12px 18px;border-bottom:1px solid #2a2a2a"><span style="font-size:11px;color:#555;display:block">FROM</span><span style="font-weight:600">${safeName} (${email})</span></td></tr>
            <tr><td style="padding:12px 18px;border-bottom:1px solid #2a2a2a"><span style="font-size:11px;color:#555;display:block">TYPE</span><span style="font-weight:600">${safeType || 'General'}</span></td></tr>
            <tr><td style="padding:12px 18px;border-bottom:1px solid #2a2a2a"><span style="font-size:11px;color:#555;display:block">SUBJECT</span><span style="font-weight:600">${safeSubject}</span></td></tr>
            <tr><td style="padding:12px 18px"><span style="font-size:11px;color:#555;display:block;margin-bottom:8px">MESSAGE</span><p style="color:#aaa;line-height:1.7;margin:0">${safeMessage}</p></td></tr>
          </table>
          <p style="font-size:12px;color:#555;margin-top:16px">Reply directly to: <a href="mailto:${email}" style="color:#ff6b2b">${email}</a></p>
        </div>`,
      text: `Contact from ${safeName} (${email})\nType: ${safeType}\nSubject: ${safeSubject}\n\n${safeMessage}`
    });
    // Send auto-reply to user
    sendEmail(email, {
      subject: `We got your message, ${safeName}! — SocialMitr`,
      html: `<div style="font-family:'Segoe UI',sans-serif;background:#0f0f0f;color:#f0ece4;padding:32px;border-radius:12px;max-width:560px"><h2 style="color:#ff6b2b">Hey ${safeName}! 👋</h2><p style="color:#aaa;margin-top:12px;line-height:1.7">Thanks for reaching out to SocialMitr. We've received your message and will get back to you at <strong style="color:#ff6b2b">${email}</strong> within 24 hours.</p><p style="color:#555;font-size:12px;margin-top:20px">SocialMitr · Delhi, India · socialmitr.company@gmail.com</p></div>`,
      text: `Hi ${safeName}, thanks for contacting SocialMitr! We'll reply within 24 hours.`
    });
    res.json({ success: true, message: 'Message sent! We\'ll reply within 24 hours.' });
  } catch (err) { res.status(500).json({ success: false, message: 'Failed to send: ' + err.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  ADMIN STATS — how many users, creators, businesses
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/api/admin/stats', async (req, res) => {
  // Simple token check — only allow if request has admin secret
  const secret = req.headers['x-admin-secret'];
  if (!process.env.ADMIN_SECRET || secret !== process.env.ADMIN_SECRET)
    return res.status(403).json({ success: false, message: 'Forbidden' });
  try {
    const { count: totalUsers } = await supabase.from('users').select('*', { count: 'exact', head: true });
    const { count: creators } = await supabase.from('users').select('*', { count: 'exact', head: true }).eq('type', 'creator');
    const { count: businesses } = await supabase.from('users').select('*', { count: 'exact', head: true }).eq('type', 'business');
    const { count: jobs } = await supabase.from('jobs').select('*', { count: 'exact', head: true });
    const { count: applications } = await supabase.from('applications').select('*', { count: 'exact', head: true });
    const { count: contracts } = await supabase.from('contracts').select('*', { count: 'exact', head: true });
    const { data: recentUsers } = await supabase.from('users').select('email,type,created_at').order('created_at', { ascending: false }).limit(10);
    res.json({ success: true, stats: { totalUsers, creators, businesses, jobs, applications, contracts }, recentUsers });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  CREATOR PROFILE
// ═══════════════════════════════════════════════════════════════════════════════
app.put('/api/creators/me', auth, async (req, res) => {
  if (req.user.type !== 'creator') return res.status(403).json({ success: false, message: 'Not a creator' });
  const { bio, portfolio_url, instagram, rate } = req.body;
  try {
    await supabase.from('creators').update({ bio, portfolio_url, instagram, rate }).eq('user_id', req.user.userId);
    res.json({ success: true, message: 'Profile updated!' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  JOBS
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/api/jobs', auth, async (req, res) => {
  const { niche, search } = req.query;
  try {
    let query = supabase.from('jobs')
      .select('*, businesses(business_name,owner_name,business_type,city)')
      .eq('status', 'open')
      .order('created_at', { ascending: false });
    if (niche && niche !== 'All') query = query.eq('niche', niche);
    if (search) query = query.or(`title.ilike.%${search}%,description.ilike.%${search}%`);
    const { data: jobs, error } = await query;
    if (error) throw error;
    const withCounts = await Promise.all((jobs || []).map(async job => {
      const { count } = await supabase.from('applications').select('*', { count: 'exact', head: true }).eq('job_id', job.id);
      let saved = false;
      if (req.user.type === 'creator' && req.user.creatorId) {
        const { data: s } = await supabase.from('saved_jobs').select('id').eq('job_id', job.id).eq('creator_id', req.user.creatorId).maybeSingle();
        saved = !!s;
      }
      return { ...job, business_name: job.businesses?.business_name, owner_name: job.businesses?.owner_name, business_type: job.businesses?.business_type, biz_city: job.businesses?.city, app_count: count || 0, saved };
    }));
    res.json({ success: true, jobs: withCounts });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.post('/api/jobs', auth, async (req, res) => {
  if (req.user.type !== 'business') return res.status(403).json({ success: false, message: 'Only businesses can post jobs' });
  const { title, description, requirements, deliverables, budget, timeline, skills_needed, niche } = req.body;
  if (!title || !description || !budget || !timeline || !niche)
    return res.status(400).json({ success: false, message: 'Required fields missing' });
  try {
    const { data: biz } = await supabase.from('businesses').select('id').eq('user_id', req.user.userId).single();
    const { data: job, error } = await supabase.from('jobs').insert({ business_id: biz.id, title, description, requirements: requirements || '', deliverables: deliverables || '', budget, timeline, skills_needed: skills_needed || '', niche }).select().single();
    if (error) throw error;
    res.json({ success: true, jobId: job.id, message: 'Job posted!' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.get('/api/my/jobs', auth, async (req, res) => {
  if (req.user.type !== 'business') return res.status(403).json({ success: false, message: 'Not a business' });
  try {
    const { data: biz } = await supabase.from('businesses').select('id').eq('user_id', req.user.userId).single();
    if (!biz) return res.json({ success: true, jobs: [] });
    const { data: jobs, error } = await supabase.from('jobs').select('*').eq('business_id', biz.id).order('created_at', { ascending: false });
    if (error) throw error;
    const withCounts = await Promise.all((jobs || []).map(async job => {
      const { count: app_count } = await supabase.from('applications').select('*', { count: 'exact', head: true }).eq('job_id', job.id);
      const { count: pending_count } = await supabase.from('applications').select('*', { count: 'exact', head: true }).eq('job_id', job.id).eq('status', 'pending');
      return { ...job, app_count: app_count || 0, pending_count: pending_count || 0 };
    }));
    res.json({ success: true, jobs: withCounts });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.put('/api/jobs/:id/status', auth, async (req, res) => {
  if (req.user.type !== 'business') return res.status(403).json({ success: false, message: 'Not a business' });
  try {
    const { data: biz } = await supabase.from('businesses').select('id').eq('user_id', req.user.userId).single();
    await supabase.from('jobs').update({ status: req.body.status }).eq('id', req.params.id).eq('business_id', biz.id);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.post('/api/jobs/:id/save', auth, async (req, res) => {
  if (req.user.type !== 'creator') return res.status(403).json({ success: false, message: 'Not a creator' });
  try {
    const { data: existing } = await supabase.from('saved_jobs').select('id').eq('job_id', req.params.id).eq('creator_id', req.user.creatorId).maybeSingle();
    if (existing) {
      await supabase.from('saved_jobs').delete().eq('id', existing.id);
      res.json({ success: true, saved: false });
    } else {
      await supabase.from('saved_jobs').insert({ job_id: req.params.id, creator_id: req.user.creatorId });
      res.json({ success: true, saved: true });
    }
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.get('/api/saved-jobs', auth, async (req, res) => {
  if (req.user.type !== 'creator') return res.status(403).json({ success: false, message: 'Not a creator' });
  try {
    const { data } = await supabase.from('saved_jobs').select('*, jobs(*, businesses(business_name,business_type,city))').eq('creator_id', req.user.creatorId).order('created_at', { ascending: false });
    const jobs = (data || []).map(s => ({ ...s.jobs, business_name: s.jobs?.businesses?.business_name, business_type: s.jobs?.businesses?.business_type, biz_city: s.jobs?.businesses?.city, saved: true }));
    res.json({ success: true, jobs });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  APPLICATIONS — FIXED
// ═══════════════════════════════════════════════════════════════════════════════
app.post('/api/jobs/:id/apply', auth, async (req, res) => {
  if (req.user.type !== 'creator') return res.status(403).json({ success: false, message: 'Only creators can apply' });
  const { cover_letter } = req.body;
  try {
    const { data: creator } = await supabase.from('creators').select('*').eq('user_id', req.user.userId).single();
    if (!creator) return res.status(400).json({ success: false, message: 'Creator profile not found' });
    const { data: existing } = await supabase.from('applications').select('id').eq('job_id', req.params.id).eq('creator_id', creator.id).maybeSingle();
    if (existing) return res.status(400).json({ success: false, message: 'You already applied to this job' });
    const { data: job } = await supabase.from('jobs').select('*, businesses(id,business_name,owner_name,user_id)').eq('id', req.params.id).single();
    if (!job) return res.status(404).json({ success: false, message: 'Job not found' });
    const { error } = await supabase.from('applications').insert({ job_id: req.params.id, creator_id: creator.id, cover_letter: cover_letter || '' });
    if (error) throw error;
    const bizUserId = job.businesses?.user_id;
    // Get business owner email separately (avoids 3-level join)
    const { data: bizUser } = await supabase.from('users').select('email').eq('id', bizUserId).single();
    const bizEmail = bizUser?.email;
    const safeCoverLetter = escapeHtml(cover_letter || 'No message.');
    notify(bizUserId, '🎬 New Application!', `${creator.name} from ${creator.city} applied for "${job.title}"`, 'application');
    sendEmail(bizEmail, applicationNotificationEmail({ businessName: job.businesses.business_name, ownerName: job.businesses.owner_name, jobTitle: job.title, creatorName: creator.name, creatorCity: creator.city, creatorSkill: creator.primary_skill, creatorRate: creator.rate, coverLetter: safeCoverLetter, dashboardLink: `${req.protocol}://${req.get('host')}/business-dashboard.html` }));
    res.json({ success: true, message: 'Application submitted!' });
  } catch (err) { console.error('Apply error:', err); res.status(500).json({ success: false, message: err.message }); }
});

app.get('/api/my/applications', auth, async (req, res) => {
  if (req.user.type !== 'creator') return res.status(403).json({ success: false, message: 'Not a creator' });
  try {
    const { data: creator } = await supabase.from('creators').select('id').eq('user_id', req.user.userId).single();
    const { data: apps } = await supabase.from('applications').select('*, jobs(title,budget,timeline,niche,businesses(business_name,business_type,city))').eq('creator_id', creator.id).order('created_at', { ascending: false });
    const flat = (apps || []).map(a => ({ ...a, job_title: a.jobs?.title, job_budget: a.jobs?.budget, timeline: a.jobs?.timeline, niche: a.jobs?.niche, business_name: a.jobs?.businesses?.business_name, business_type: a.jobs?.businesses?.business_type, biz_city: a.jobs?.businesses?.city }));
    res.json({ success: true, applications: flat });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ─── KEY FIX: Get applicants for a job ───────────────────────────────────────
app.get('/api/jobs/:id/applications', auth, async (req, res) => {
  if (req.user.type !== 'business') return res.status(403).json({ success: false, message: 'Not a business' });
  try {
    const jobId = req.params.id;
    console.log(`\n📋 Getting applications for job: ${jobId}`);

    // First verify this job belongs to this business
    const { data: biz } = await supabase.from('businesses').select('id').eq('user_id', req.user.userId).single();
    console.log(`   Business ID: ${biz?.id}`);

    const { data: job } = await supabase.from('jobs').select('id,title,business_id').eq('id', jobId).single();
    console.log(`   Job: ${job?.title}, belongs to biz: ${job?.business_id}`);

    if (!job) return res.status(404).json({ success: false, message: 'Job not found' });
    if (job.business_id !== biz.id) return res.status(403).json({ success: false, message: 'Not authorized' });

    // Get applications with creator details - split into two queries to avoid join issues
    const { data: applications, error: appErr } = await supabase
      .from('applications')
      .select('id,job_id,creator_id,cover_letter,status,created_at')
      .eq('job_id', jobId)
      .order('created_at', { ascending: false });

    if (appErr) { console.error('App query error:', appErr); throw appErr; }
    console.log(`   Raw applications found: ${applications?.length || 0}`);

    if (!applications || applications.length === 0) {
      return res.json({ success: true, applications: [] });
    }

    // Get creator details for each application
    const creatorIds = applications.map(a => a.creator_id);
    const { data: creators, error: crErr } = await supabase
      .from('creators')
      .select('id,name,city,primary_skill,niche,rate,bio,avatar_initials,avatar_color,portfolio_url,instagram,rating,total_reviews')
      .in('id', creatorIds);

    if (crErr) { console.error('Creator query error:', crErr); throw crErr; }
    console.log(`   Creators found: ${creators?.length || 0}`);

    // Merge
    const creatorMap = {};
    (creators || []).forEach(cr => creatorMap[cr.id] = cr);
    const merged = applications.map(a => {
      const creator = creatorMap[a.creator_id] || {};
      return {
        ...creator,           // creator fields first (name, city, skill, etc.)
        ...a,                 // application fields LAST (so app.id always wins)
        // Explicitly guarantee these are always the application's values:
        id: a.id,
        job_id: a.job_id,
        creator_id: a.creator_id,
        cover_letter: a.cover_letter,
        status: a.status,
        created_at: a.created_at,
      };
    });

    console.log(`   ✅ Returning ${merged.length} applications`);
    res.json({ success: true, applications: merged });
  } catch (err) {
    console.error('GET /api/jobs/:id/applications error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

app.put('/api/applications/:id/status', auth, async (req, res) => {
  if (req.user.type !== 'business') return res.status(403).json({ success: false, message: 'Not a business' });
  const { status, agreed_amount } = req.body;
  if (!['accepted', 'rejected'].includes(status)) return res.status(400).json({ success: false, message: 'Invalid status' });
  try {
    console.log('\n🔄 Updating application:', req.params.id, '→', status);

    // Step 1: Get the application (simple query, no joins)
    const { data: app, error: appErr } = await supabase
      .from('applications').select('*').eq('id', req.params.id).single();
    if (appErr || !app) {
      console.error('App not found:', appErr);
      return res.status(404).json({ success: false, message: 'Application not found. ID: ' + req.params.id });
    }
    console.log('   Application found:', app.id, 'job:', app.job_id, 'creator:', app.creator_id);

    // Step 2: Get creator details
    const { data: creator } = await supabase
      .from('creators').select('id,name,user_id').eq('id', app.creator_id).single();
    const { data: creatorUser } = await supabase
      .from('users').select('email').eq('id', creator?.user_id).single();

    // Step 3: Get job + business details
    const { data: job } = await supabase
      .from('jobs').select('id,title,budget,business_id').eq('id', app.job_id).single();
    const { data: business } = await supabase
      .from('businesses').select('id,business_name,user_id').eq('id', job?.business_id).single();

    if (business?.user_id !== req.user.userId) {
      return res.status(403).json({ success: false, message: 'Not authorized to update this application' });
    }

    const creatorUserId = creator?.user_id;
    const creatorEmail = creatorUser?.email;
    const creatorName = creator?.name || 'Creator';
    const jobTitle = job?.title || 'your job';
    const businessName = business?.business_name || 'Business';
    const bizUserId = business?.user_id;

    // Step 4: Update application status
    await supabase.from('applications').update({ status }).eq('id', req.params.id);

    if (status === 'accepted') {
      // Get business id for this logged-in user
      const { data: myBiz } = await supabase.from('businesses').select('id').eq('user_id', req.user.userId).single();
      const amount = agreed_amount || parseFloat((job?.budget || '0').replace(/[^0-9.]/g, '')) || 0;

      // Create contract
      const { data: contract, error: cErr } = await supabase.from('contracts')
        .insert({ job_id: app.job_id, creator_id: app.creator_id, business_id: myBiz.id, application_id: app.id, agreed_amount: amount })
        .select().single();
      if (cErr) { console.error('Contract error:', cErr); throw cErr; }
      console.log('   ✅ Contract created:', contract.id);

      // Create chat room
      await supabase.from('chat_rooms').insert({ contract_id: contract.id });
      console.log('   ✅ Chat room created');

      // Update job status
      await supabase.from('jobs').update({ status: 'in_progress' }).eq('id', app.job_id);

      // Create payment record
      await supabase.from('payments').insert({ contract_id: contract.id, amount, status: 'pending' });
      console.log('   ✅ Payment record created, amount:', amount);

      // Notifications
      if (creatorUserId) notify(creatorUserId, '🎉 Proposal Accepted!', `${businessName} accepted your proposal for "${jobTitle}"! Go to Active Work to start chatting.`, 'accepted');
      if (bizUserId) notify(bizUserId, '✅ Contract Started', `You accepted ${creatorName} for "${jobTitle}". Chat is ready.`, 'info');
    } else {
      if (creatorUserId) notify(creatorUserId, '📋 Proposal Update', `${businessName} reviewed your proposal for "${jobTitle}".`, 'rejected');
    }

    // Send email to creator
    if (creatorEmail) {
      sendEmail(creatorEmail, applicationStatusEmail({
        creatorName, jobTitle, businessName, status,
        dashboardLink: `${req.protocol}://${req.get('host')}/creator-dashboard.html`
      }));
    }

    console.log('   ✅ Done:', status);
    res.json({ success: true, message: `Application ${status}` });
  } catch (err) {
    console.error('❌ Update app status error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  CONTRACTS
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/api/my/contracts', auth, async (req, res) => {
  try {
    let query;
    if (req.user.type === 'creator') {
      const { data: c } = await supabase.from('creators').select('id').eq('user_id', req.user.userId).single();
      query = supabase.from('contracts').select('*, jobs(title,niche,timeline), businesses(business_name,business_type,city), chat_rooms(id), payments(id,amount,status)').eq('creator_id', c.id);
    } else {
      const { data: b } = await supabase.from('businesses').select('id').eq('user_id', req.user.userId).single();
      query = supabase.from('contracts').select('*, jobs(title,niche,timeline), creators(name,city,primary_skill,avatar_initials,avatar_color,rate), chat_rooms(id), payments(id,amount,status)').eq('business_id', b.id);
    }
    const { data: contracts, error } = await query.order('created_at', { ascending: false });
    if (error) throw error;
    res.json({ success: true, contracts: contracts || [] });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.put('/api/contracts/:id/complete', auth, async (req, res) => {
  try {
    const { data: contractAuth } = await supabase.from('contracts').select('creators(user_id), businesses(user_id)').eq('id', req.params.id).single();
    if (contractAuth?.creators?.user_id !== req.user.userId && contractAuth?.businesses?.user_id !== req.user.userId) {
      return res.status(403).json({ success: false, message: 'Not authorized to modify this contract' });
    }

    const col = req.user.type === 'creator' ? 'creator_done' : 'business_done';
    await supabase.from('contracts').update({ [col]: true }).eq('id', req.params.id);
    const { data: contract } = await supabase.from('contracts').select('*').eq('id', req.params.id).single();
    if (contract.creator_done && contract.business_done) {
      await supabase.from('contracts').update({ status: 'completed', completed_at: new Date().toISOString() }).eq('id', req.params.id);
      await supabase.from('jobs').update({ status: 'completed' }).eq('id', contract.job_id);
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  CHAT
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/api/chat/:roomId/messages', auth, async (req, res) => {
  try {
    const { data: room } = await supabase.from('chat_rooms').select('contract_id').eq('id', req.params.roomId).single();
    if (!room) return res.status(404).json({ success: false, message: 'Room not found' });
    const { data: contract } = await supabase.from('contracts').select('creators(user_id), businesses(user_id)').eq('id', room.contract_id).single();
    if (contract?.creators?.user_id !== req.user.userId && contract?.businesses?.user_id !== req.user.userId) {
      return res.status(403).json({ success: false, message: 'Not authorized' });
    }

    const { data: messages, error } = await supabase.from('chat_messages').select('*, users(id,type)').eq('room_id', req.params.roomId).order('created_at', { ascending: true });
    if (error) throw error;
    await supabase.from('chat_messages').update({ read: true }).eq('room_id', req.params.roomId).neq('sender_id', req.user.userId);
    res.json({ success: true, messages: messages || [] });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.get('/api/chat/unread-counts', auth, async (req, res) => {
  try {
    let contractIds = [];
    if (req.user.type === 'creator') {
      const { data: creator } = await supabase.from('creators').select('id').eq('user_id', req.user.userId).single();
      if (creator?.id) {
        const { data: contracts } = await supabase.from('contracts').select('id').eq('creator_id', creator.id);
        contractIds = (contracts || []).map(c => c.id);
      }
    } else if (req.user.type === 'business') {
      const { data: business } = await supabase.from('businesses').select('id').eq('user_id', req.user.userId).single();
      if (business?.id) {
        const { data: contracts } = await supabase.from('contracts').select('id').eq('business_id', business.id);
        contractIds = (contracts || []).map(c => c.id);
      }
    }
    if (!contractIds.length) return res.json({ success: true, counts: {} });
    const { data: rooms } = await supabase.from('chat_rooms').select('id').in('contract_id', contractIds);
    const roomIds = (rooms || []).map(r => r.id).filter(Boolean);
    if (!roomIds.length) return res.json({ success: true, counts: {} });
    const { data: messages, error } = await supabase.from('chat_messages')
      .select('room_id')
      .in('room_id', roomIds)
      .eq('read', false)
      .neq('sender_id', req.user.userId);
    if (error) throw error;
    const counts = {};
    (messages || []).forEach(m => { counts[m.room_id] = (counts[m.room_id] || 0) + 1; });
    res.json({ success: true, counts });
  } catch (err) {
    console.error('Chat unread counts error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/chat/:roomId/send', auth, async (req, res) => {
  const { message } = req.body;
  if (!message?.trim()) return res.status(400).json({ success: false, message: 'Message cannot be empty' });
  try {
    const { data: room } = await supabase.from('chat_rooms').select('contract_id').eq('id', req.params.roomId).single();
    if (!room) return res.status(404).json({ success: false, message: 'Room not found' });
    const { data: contract } = await supabase.from('contracts').select('creators(user_id), businesses(user_id)').eq('id', room.contract_id).single();
    if (contract?.creators?.user_id !== req.user.userId && contract?.businesses?.user_id !== req.user.userId) {
      return res.status(403).json({ success: false, message: 'Not authorized to send messages in this room' });
    }

    const { data: msg, error } = await supabase.from('chat_messages').insert({ room_id: req.params.roomId, sender_id: req.user.userId, message: message.trim() }).select().single();
    if (error) throw error;
    res.json({ success: true, message: msg });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  PAYMENTS
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/api/my/payments', auth, async (req, res) => {
  try {
    let contractIds = [];
    if (req.user.type === 'creator') {
      const { data: c } = await supabase.from('creators').select('id').eq('user_id', req.user.userId).single();
      const { data: contracts } = await supabase.from('contracts').select('id').eq('creator_id', c.id);
      contractIds = (contracts || []).map(c => c.id);
    } else {
      const { data: b } = await supabase.from('businesses').select('id').eq('user_id', req.user.userId).single();
      const { data: contracts } = await supabase.from('contracts').select('id').eq('business_id', b.id);
      contractIds = (contracts || []).map(c => c.id);
    }
    if (!contractIds.length) return res.json({ success: true, payments: [] });
    const { data: payments } = await supabase.from('payments').select('*, contracts(id,agreed_amount,status,jobs(title),creators(name),businesses(business_name))').in('contract_id', contractIds).order('created_at', { ascending: false });
    res.json({ success: true, payments: payments || [] });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.post('/api/payments/:id/request', auth, async (req, res) => {
  if (req.user.type !== 'creator') return res.status(403).json({ success: false, message: 'Only creators can request payment' });
  try {
    const { data: paymentAuth } = await supabase.from('payments').select('contracts(creators(user_id))').eq('id', req.params.id).single();
    if (paymentAuth?.contracts?.creators?.user_id !== req.user.userId) {
      return res.status(403).json({ success: false, message: 'Not authorized to request this payment' });
    }

    const { note } = req.body;
    await supabase.from('payments').update({ status: 'requested', requested_at: new Date().toISOString(), note: note || '' }).eq('id', req.params.id);
    const { data: payment } = await supabase.from('payments').select('*, contracts(jobs(title),businesses(user_id,business_name),creators(name))').eq('id', req.params.id).single();
    const bizUserId = payment.contracts?.businesses?.user_id;
    const creatorName = payment.contracts?.creators?.name;
    const jobTitle = payment.contracts?.jobs?.title;
    notify(bizUserId, '💰 Payment Requested!', `${creatorName} has requested payment for "${jobTitle}". Please review and release.`, 'payment');
    res.json({ success: true, message: 'Payment requested!' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.post('/api/payments/:id/release', auth, async (req, res) => {
  if (req.user.type !== 'business') return res.status(403).json({ success: false, message: 'Only businesses can release payment' });
  try {
    const { data: paymentAuth } = await supabase.from('payments').select('contracts(businesses(user_id))').eq('id', req.params.id).single();
    if (paymentAuth?.contracts?.businesses?.user_id !== req.user.userId) {
      return res.status(403).json({ success: false, message: 'Not authorized to release this payment' });
    }

    const { upi_id, method, txn_id } = req.body;
    await supabase.from('payments').update({ status: 'released', released_at: new Date().toISOString(), note: `Paid via ${method || 'UPI'} | UPI: ${upi_id || 'N/A'} | TXN: ${txn_id || 'N/A'}` }).eq('id', req.params.id);
    const { data: payment } = await supabase.from('payments').select('*, contracts(agreed_amount,creator_id,jobs(title),creators(name,user_id),businesses(business_name))').eq('id', req.params.id).single();
    const creatorUserId = payment.contracts?.creators?.user_id;
    // Get creator email separately
    const creatorUid = payment.contracts?.creators?.user_id;
    const { data: crUserData } = creatorUid ? await supabase.from('users').select('email').eq('id', creatorUid).single() : { data: null };
    const creatorEmail = crUserData?.email;
    const creatorName = payment.contracts?.creators?.name;
    const bizName = payment.contracts?.businesses?.business_name;
    const jobTitle = payment.contracts?.jobs?.title;
    const amount = payment.contracts?.agreed_amount;
    if (payment.contracts?.creator_id) {
      const { data: creatorProfile } = await supabase.from('creators').select('total_earned,completed_jobs').eq('id', payment.contracts.creator_id).single();
      const currentEarned = Number(creatorProfile?.total_earned) || 0;
      const currentCompleted = Number(creatorProfile?.completed_jobs) || 0;
      await supabase.from('creators').update({
        total_earned: currentEarned + Number(amount || 0),
        completed_jobs: currentCompleted + 1
      }).eq('id', payment.contracts.creator_id);
      // ── Credit creator wallet (93% share) ──
      try {
        await creditWallet(payment.contracts.creator_id, Number(amount || 0), payment.contract_id, `Payment released by ${bizName} for "${jobTitle}"`);
      } catch (wErr) { console.error('Wallet credit error (non-fatal):', wErr.message); }
    }
    notify(creatorUserId, '💸 Payment Released!', `${bizName} has released ₹${amount} for "${jobTitle}". Check your UPI!`, 'payment');
    sendEmail(creatorEmail, paymentReleasedEmail({ creatorName, businessName: bizName, jobTitle, amount, upiId: upi_id, txnId: txn_id }));
    res.json({ success: true, message: 'Payment marked as released!' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  REVIEWS
// ═══════════════════════════════════════════════════════════════════════════════
app.post('/api/contracts/:id/review', auth, async (req, res) => {
  if (req.user.type !== 'business') return res.status(403).json({ success: false, message: 'Only businesses can leave reviews' });
  const { rating, comment } = req.body;
  if (!rating || rating < 1 || rating > 5) return res.status(400).json({ success: false, message: 'Rating must be 1-5' });
  try {
    const { data: contract } = await supabase.from('contracts').select('creator_id,business_id,businesses(user_id)').eq('id', req.params.id).single();
    if (contract?.businesses?.user_id !== req.user.userId) {
      return res.status(403).json({ success: false, message: 'Not authorized to leave a review for this contract' });
    }
    const { error } = await supabase.from('reviews').insert({ contract_id: req.params.id, creator_id: contract.creator_id, business_id: contract.business_id, rating, comment: comment || '' });
    if (error && error.code === '23505') return res.status(400).json({ success: false, message: 'Already reviewed' });
    if (error) throw error;
    const { data: reviews } = await supabase.from('reviews').select('rating').eq('creator_id', contract.creator_id);
    const avg = reviews.reduce((s, r) => s + r.rating, 0) / reviews.length;
    await supabase.from('creators').update({ rating: Math.round(avg * 10) / 10, total_reviews: reviews.length }).eq('id', contract.creator_id);
    res.json({ success: true, message: 'Review submitted!' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  NOTIFICATIONS
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/api/notifications', auth, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { data: notifications, error: nErr } = await supabase
      .from('notifications').select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(30);
    if (nErr) { console.error('Notifications fetch error:', nErr.message); throw nErr; }
    const { count: unread, error: cErr } = await supabase
      .from('notifications').select('*', { count: 'exact', head: true })
      .eq('user_id', userId).eq('read', false);
    res.json({ success: true, notifications: notifications || [], unread: unread || 0 });
  } catch (err) {
    console.error('Notifications error:', err.message);
    res.status(500).json({ success: false, message: err.message, notifications: [], unread: 0 });
  }
});


// Create notification (for testing)
app.post('/api/notifications/create', auth, async (req, res) => {
  const { title, message, type } = req.body;
  try {
    await supabase.from('notifications').insert({ user_id: req.user.userId, title, message, type: type || 'info' });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.put('/api/notifications/read-all', auth, async (req, res) => {
  try {
    await supabase.from('notifications').update({ read: true }).eq('user_id', req.user.userId);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.get('/api/health', (req, res) => res.json({ status: 'ok', version: '5.0', db: 'supabase' }));

// ═══════════════════════════════════════════════════════════════════════════════
//  WORK DELIVERY — creator submits deliverables link/message
// ═══════════════════════════════════════════════════════════════════════════════
app.post('/api/contracts/:id/deliver', auth, async (req, res) => {
  if (req.user.type !== 'creator') return res.status(403).json({ success: false, message: 'Only creators can submit deliverables' });
  const { title, description, link, file_type } = req.body;
  if (!description && !link) return res.status(400).json({ success: false, message: 'Please provide a description or link' });
  try {
    // Get contract + business info
    const { data: creator } = await supabase.from('creators').select('id,name').eq('user_id', req.user.userId).single();
    const { data: contract } = await supabase.from('contracts')
      .select('*, jobs(title), businesses(user_id,business_name), chat_rooms(id)')
      .eq('id', req.params.id).single();
    if (!contract) return res.status(404).json({ success: false, message: 'Contract not found' });
    if (String(contract.creator_id) !== String(creator.id))
      return res.status(403).json({ success: false, message: 'Not your contract' });

    const bizUserId = contract.businesses?.user_id;
    // Get biz email separately
    const { data: bizUserData } = await supabase.from('users').select('email').eq('id', bizUserId).single();
    const bizEmail = bizUserData?.email;
    const bizName = contract.businesses?.business_name;
    const jobTitle = contract.jobs?.title;
    const roomId = contract.chat_rooms?.[0]?.id || contract.chat_rooms?.id;

    const safeTitle = escapeHtml(title);
    const safeDesc = escapeHtml(description);
    const safeLink = escapeHtml(link);

    // Post delivery as a chat message so it shows in the chat
    const deliveryMsg = `📦 **WORK DELIVERY**\n\n📋 ${safeTitle || 'Deliverables Submitted'}\n\n${safeDesc}${safeLink ? '\n\n🔗 Link: ' + safeLink : ''}`;
    if (roomId) {
      await supabase.from('chat_messages').insert({ room_id: roomId, sender_id: req.user.userId, message: deliveryMsg });
    }

    // Notify business
    notify(bizUserId, '📦 Work Delivered!', `${creator.name} submitted deliverables for "${jobTitle}". Review and approve in your dashboard.`, 'delivery');

    // Email business
    sendEmail(bizEmail, {
      subject: `📦 Work Delivered — ${creator.name} for "${jobTitle}"`,
      html: `<div style="font-family:'Segoe UI',sans-serif;background:#0f0f0f;color:#f0ece4;padding:32px;border-radius:12px;max-width:560px">
        <h2 style="color:#ff6b2b;margin:0 0 16px">📦 Work Delivered!</h2>
        <p style="color:#aaa;margin-bottom:20px;line-height:1.7"><strong style="color:#f0ece4">${creator.name}</strong> has submitted deliverables for <strong style="color:#ff6b2b">"${jobTitle}"</strong>.</p>
        <div style="background:#1e1e1e;border:1px solid #2a2a2a;border-radius:10px;padding:20px;margin-bottom:20px">
          <div style="font-size:11px;color:#555;margin-bottom:8px;text-transform:uppercase;letter-spacing:1px">Delivery Note</div>
          <p style="color:#ccc;font-size:14px;line-height:1.7;margin:0">${safeDesc}</p>
          ${safeLink ? `<a href="${safeLink}" style="display:inline-block;margin-top:12px;color:#ff6b2b;font-size:13px">🔗 View Deliverable</a>` : ''}
        </div>
        <p style="color:#666;font-size:12px">Log in to review the work, leave feedback in chat, and release payment when satisfied.</p>
        <div style="margin-top:20px"><a href="${req.protocol}://${req.get('host')}/business-dashboard.html" style="background:#06d6a0;color:#0a0a0a;padding:12px 24px;border-radius:10px;text-decoration:none;font-weight:700;font-size:14px">Review Delivery →</a></div>
      </div>`,
      text: `${creator.name} delivered work for "${jobTitle}". ${safeLink ? 'Link: ' + safeLink : ''}\n\n${safeDesc}`
    });

    res.json({ success: true, message: 'Deliverables submitted! The business has been notified.' });
  } catch (err) { console.error('Deliver error:', err); res.status(500).json({ success: false, message: err.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  AI FEATURES
// ═══════════════════════════════════════════════════════════════════════════════

// AI: Generate cover letter for a creator applying to a job

// ─── TEST AI ROUTE ────────────────────────────────────────────────────────────
app.get('/api/ai/test', auth, aiLimiter, async (req, res) => {
  try {
    const text = await callClaude('Say exactly: "SocialMitr AI is working!" and nothing else.', 50);
    res.json({ success: true, message: text.trim() });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

app.post('/api/ai/cover-letter', auth, aiLimiter, async (req, res) => {
  if (req.user.type !== 'creator') return res.status(403).json({ success: false, message: 'Only creators can use this' });
  const { jobTitle, jobDescription, creatorSkill, creatorNiche, creatorCity, creatorBio } = req.body;
  const prompt = `Write a short, genuine cover letter (3-4 sentences) for a local Indian freelance creator applying for this job on SocialMitr. Be specific and direct. Do NOT start with "I am writing to express my interest".

Creator: ${creatorSkill} specialist, ${creatorNiche} niche, based in ${creatorCity}. ${creatorBio || ''}
Job: "${jobTitle}" — ${jobDescription}

Write only the cover letter text.`;
  try {
    const text = await callClaude(prompt, 300);
    res.json({ success: true, coverLetter: text.trim() });
  } catch (err) {
    console.error('AI cover letter:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// AI: Generate job description for a business
app.post('/api/ai/job-description', auth, aiLimiter, async (req, res) => {
  if (req.user.type !== 'business') return res.status(403).json({ success: false, message: 'Only businesses can use this' });
  const { businessType, niche, budget, timeline, keywords } = req.body;
  const prompt = `Write a clear job description (under 80 words) for a local Indian business posting on SocialMitr — a platform for hiring local video editors and social media managers.

Business: ${businessType}, ${niche} niche
Budget: ${budget}, Timeline: ${timeline}
Requirements: ${keywords || 'general content creation'}

Be specific about content type needed and expected output. Write only the description text.`;
  try {
    const text = await callClaude(prompt, 300);
    res.json({ success: true, description: text.trim() });
  } catch (err) {
    console.error('AI job desc:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// AI: Profile bio writer for creators
app.post('/api/ai/bio', auth, aiLimiter, async (req, res) => {
  if (req.user.type !== 'creator') return res.status(403).json({ success: false, message: 'Only creators can use this' });
  const { name, skill, niche, city, rate, experience } = req.body;
  const prompt = `Write a 2-3 sentence professional bio for a local Indian freelance creator on SocialMitr.

${name} is a ${skill} specialist focusing on ${niche} content, based in ${city}, charging ₹${rate}/month.
Experience: ${experience || 'passionate content creator'}

Make it confident, specific, and not generic. Write only the bio text.`;
  try {
    const text = await callClaude(prompt, 200);
    res.json({ success: true, bio: text.trim() });
  } catch (err) {
    console.error('AI bio:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  AI: SMART JOB MATCH — tells creator how good a match they are for a job
// ═══════════════════════════════════════════════════════════════════════════════
app.post('/api/ai/match-score', auth, aiLimiter, async (req, res) => {
  if (req.user.type !== 'creator') return res.status(403).json({ success: false, message: 'Only creators' });
  const { jobTitle, jobDescription, jobNiche, creatorSkill, creatorNiche, creatorBio, creatorCity } = req.body;
  const prompt = `You are a matching algorithm for SocialMitr, a local freelancing platform in India.

Rate how well this creator matches this job. Reply in EXACTLY this JSON format (no other text):
{"score":85,"reason":"Strong match because...","tip":"To improve, you should..."}

Creator: ${creatorSkill}, ${creatorNiche} niche, ${creatorCity}. Bio: ${creatorBio || 'no bio'}
Job: "${jobTitle}" — ${jobNiche} niche. ${jobDescription}

Score 0-100. Be honest and specific. Keep reason under 15 words. Keep tip under 15 words.`;
  try {
    const text = await callClaude(prompt, 150);
    const clean = text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);
    res.json({ success: true, ...parsed });
  } catch (err) {
    console.error('AI match:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  AI: SMART PRICE SUGGESTER — suggests a fair rate for a job
// ═══════════════════════════════════════════════════════════════════════════════
app.post('/api/ai/suggest-price', auth, aiLimiter, async (req, res) => {
  const { jobTitle, jobDescription, niche, timeline, deliverables } = req.body;
  const prompt = `You are a pricing expert for SocialMitr, an Indian local freelancing platform for video editors and social media managers.

Suggest a fair monthly rate in Indian Rupees for this freelance job. Reply in EXACTLY this JSON format (no other text):
{"min":3000,"max":6000,"recommended":4500,"reason":"Based on..."}

Job: "${jobTitle}", ${niche} niche, ${timeline} timeline.
Description: ${jobDescription}
Deliverables: ${deliverables || 'not specified'}

Consider typical Indian freelancer rates (₹2,000–₹20,000/month range). Be specific.`;
  try {
    const text = await callClaude(prompt, 150);
    const clean = text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);
    res.json({ success: true, ...parsed });
  } catch (err) {
    console.error('AI price:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  DISPUTES — creator or business can raise a dispute on a contract
// ═══════════════════════════════════════════════════════════════════════════════
app.post('/api/contracts/:id/dispute', auth, async (req, res) => {
  const { reason } = req.body;
  if (!reason?.trim()) return res.status(400).json({ success: false, message: 'Please describe the dispute' });
  try {
    await supabase.from('contracts').update({ status: 'disputed' }).eq('id', req.params.id);
    // Email SocialMitr admin
    const { data: contract } = await supabase.from('contracts')
      .select('*, jobs(title), creators(name), businesses(business_name)')
      .eq('id', req.params.id).single();
    sendEmail('socialmitr.company@gmail.com', {
      subject: `⚠️ Dispute Raised — ${contract?.jobs?.title}`,
      html: `<div style="font-family:sans-serif;padding:24px;background:#0a0a0a;color:#f0ece4;border-radius:12px">
        <h2 style="color:#ff6b2b">⚠️ Dispute Raised</h2>
        <p><strong>Contract:</strong> ${contract?.jobs?.title}</p>
        <p><strong>Creator:</strong> ${contract?.creators?.name}</p>
        <p><strong>Business:</strong> ${contract?.businesses?.business_name}</p>
        <p><strong>Raised by:</strong> ${req.user.type}</p>
        <p><strong>Reason:</strong> ${reason}</p>
      </div>`,
      text: `Dispute on ${contract?.jobs?.title} by ${req.user.type}: ${reason}`
    });
    res.json({ success: true, message: 'Dispute raised. Our team will review within 24 hours and contact both parties.' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  PROFILE COMPLETENESS SCORE
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/api/creators/me/score', auth, async (req, res) => {
  if (req.user.type !== 'creator') return res.status(403).json({ success: false });
  try {
    const { data: p } = await supabase.from('creators').select('*').eq('user_id', req.user.userId).single();
    if (!p) return res.status(404).json({ success: false, message: 'Creator profile not found' });
    let score = 0; const missing = [];
    if (p.name) score += 20; else missing.push('Add your name');
    if (p.bio?.length > 30) score += 25; else missing.push('Write a detailed bio (30+ chars)');
    if (p.portfolio_url) score += 25; else missing.push('Add a portfolio link');
    if (p.instagram) score += 15; else missing.push('Add your Instagram');
    if (p.total_reviews > 0) score += 15; else missing.push('Complete your first job to get reviews');
    res.json({ success: true, score, missing });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  SEARCH CREATORS (for businesses to browse)
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/api/creators/search', auth, async (req, res) => {
  const { niche, city, skill, sort } = req.query;
  try {
    let query = supabase.from('creators').select('id,name,city,primary_skill,niche,rate,bio,avatar_initials,avatar_color,portfolio_url,instagram,rating,total_reviews,completed_jobs');
    if (niche && niche !== 'All') query = query.eq('niche', niche);
    if (city) query = query.ilike('city', `%${city}%`);
    if (skill) query = query.ilike('primary_skill', `%${skill}%`);
    if (sort === 'rating') query = query.order('rating', { ascending: false });
    else if (sort === 'reviews') query = query.order('total_reviews', { ascending: false });
    else if (sort === 'jobs') query = query.order('completed_jobs', { ascending: false });
    else query = query.order('rating', { ascending: false });
    const { data: creators, error } = await query.limit(30);
    if (error) throw error;
    res.json({ success: true, creators: creators || [] });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});


// ═══════════════════════════════════════════════════════════════════════════════
//  RAZORPAY PAYMENT GATEWAY — Full Escrow Flow
//  Flow: Business pays → Escrow → Creator delivers → Business approves → Auto-split
// ═══════════════════════════════════════════════════════════════════════════════
const Razorpay = require('razorpay');
const crypto = require('crypto');

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// ─── 1. CREATE RAZORPAY ORDER (business initiates payment) ───────────────────
app.post('/api/payments/razorpay/create-order', auth, async (req, res) => {
  if (req.user.type !== 'business') return res.status(403).json({ success: false, message: 'Only businesses can initiate payments' });
  const { contractId } = req.body;
  if (!contractId) return res.status(400).json({ success: false, message: 'contractId required' });

  try {
    // Get contract details
    const { data: contract } = await supabase.from('contracts')
      .select('*, jobs(title), creators(name,user_id), businesses(business_name)')
      .eq('id', contractId).single();
    if (!contract) return res.status(404).json({ success: false, message: 'Contract not found' });

    const amountPaise = Math.round(contract.agreed_amount * 100); // Razorpay uses paise

    // Create Razorpay order
    const order = await razorpay.orders.create({
      amount: amountPaise,
      currency: 'INR',
      receipt: `sm_${contractId.slice(0, 12)}`,
      notes: {
        contract_id: contractId,
        job_title: contract.jobs?.title,
        creator_name: contract.creators?.name,
        business_name: contract.businesses?.business_name,
        platform: 'SocialMitr'
      }
    });

    // Store order ID in payment record
    await supabase.from('payments')
      .update({ razorpay_order_id: order.id, status: 'order_created' })
      .eq('contract_id', contractId);

    res.json({
      success: true,
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      keyId: process.env.RAZORPAY_KEY_ID,
      contractId,
      jobTitle: contract.jobs?.title,
      businessName: contract.businesses?.business_name
    });
  } catch (err) {
    console.error('Razorpay order error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── 2. VERIFY PAYMENT + HOLD IN ESCROW ──────────────────────────────────────
app.post('/api/payments/razorpay/verify', auth, async (req, res) => {
  if (req.user.type !== 'business') return res.status(403).json({ success: false, message: 'Not a business' });
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature, contractId } = req.body;

  try {
    // Verify signature (this is how you know payment is legit)
    const body = razorpay_order_id + '|' + razorpay_payment_id;
    const expected = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update(body).digest('hex');
    const isValid = expected === razorpay_signature;

    if (!isValid) return res.status(400).json({ success: false, message: 'Invalid payment signature. Payment not verified.' });

    // Payment is genuine — mark as HELD IN ESCROW (not yet released to creator)
    const { data: payment } = await supabase.from('payments')
      .update({
        razorpay_payment_id,
        razorpay_order_id,
        razorpay_signature,
        status: 'escrowed',          // money held, NOT released yet
        requested_at: new Date().toISOString()
      })
      .eq('contract_id', contractId)
      .select().single();

    // Get contract + creator info
    const { data: contract } = await supabase.from('contracts')
      .select('*, jobs(title), creators(name,user_id), businesses(business_name,user_id)')
      .eq('id', contractId).single();

    const creatorUserId = contract?.creators?.user_id;
    const bizUserId = contract?.businesses?.user_id;
    const jobTitle = contract?.jobs?.title;
    const amount = contract?.agreed_amount;

    // Notify creator — payment is in escrow, start working!
    if (creatorUserId) {
      notify(creatorUserId,
        '💰 Payment Secured in Escrow!',
        `${contract.businesses?.business_name} has paid ₹${amount} for "${jobTitle}". Money is held safely — deliver your work and click "Request Release" to get paid.`,
        'payment'
      );
    }
    // Notify business
    if (bizUserId) {
      notify(bizUserId,
        '✅ Payment Confirmed — In Escrow',
        `₹${amount} is securely held for "${jobTitle}". The creator will deliver the work. Once you approve, payment releases automatically.`,
        'payment'
      );
    }

    console.log(`✅ Payment verified & escrowed: ₹${amount} for contract ${contractId}`);
    res.json({ success: true, message: `₹${amount} payment verified and held in escrow. Creator has been notified to start work!` });
  } catch (err) {
    console.error('Verify error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── 3. CREATOR REQUESTS RELEASE (after delivering work) ─────────────────────
app.post('/api/payments/razorpay/request-release', auth, async (req, res) => {
  if (req.user.type !== 'creator') return res.status(403).json({ success: false, message: 'Only creators can request release' });
  const { contractId, note } = req.body;
  try {
    const { data: creator } = await supabase.from('creators').select('name').eq('user_id', req.user.userId).single();
    const { data: contract } = await supabase.from('contracts')
      .select('*, jobs(title), businesses(user_id,business_name), agreed_amount')
      .eq('id', contractId).single();

    await supabase.from('payments')
      .update({ status: 'release_requested', note: note || 'Work delivered' })
      .eq('contract_id', contractId)
      .eq('status', 'escrowed');

    const bizUserId = contract?.businesses?.user_id;
    notify(bizUserId,
      '📦 Work Delivered — Review & Release Payment',
      `${creator?.name} has delivered the work for "${contract?.jobs?.title}". Review it and click "Approve & Release" to send ₹${contract?.agreed_amount} to the creator.`,
      'payment'
    );

    res.json({ success: true, message: 'Release requested! Business has been notified to review and approve.' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ─── 4. BUSINESS APPROVES → AUTO TRANSFER TO CREATOR ────────────────────────
app.post('/api/payments/razorpay/release', auth, async (req, res) => {
  if (req.user.type !== 'business') return res.status(403).json({ success: false, message: 'Only businesses can release payment' });
  const { contractId } = req.body;
  try {
    const { data: contract } = await supabase.from('contracts')
      .select('*, jobs(title), creators(id,name,user_id,razorpay_account_id), businesses(business_name), agreed_amount, payments(razorpay_payment_id)')
      .eq('id', contractId).single();

    if (!contract) return res.status(404).json({ success: false, message: 'Contract not found' });

    const amount = contract.agreed_amount;
    const platformFee = Math.round(amount * 0.15); // 15% to SocialMitr
    const creatorShare = amount - platformFee;        // 85% to creator
    const paymentId = contract.payments?.[0]?.razorpay_payment_id;

    // If creator has a Razorpay linked account, do auto-transfer
    // Otherwise mark as manual payout pending
    const creatorAccountId = contract.creators?.razorpay_account_id;
    let transferId = null;

    if (creatorAccountId && paymentId && process.env.RAZORPAY_KEY_SECRET) {
      try {
        // Create transfer via Razorpay Route
        const transfer = await razorpay.payments.transfer(paymentId, {
          transfers: [{
            account: creatorAccountId,
            amount: creatorShare * 100,  // in paise
            currency: 'INR',
            notes: {
              job_title: contract.jobs?.title,
              creator_name: contract.creators?.name,
              platform: 'SocialMitr'
            },
            linked_account_notes: ['job_title'],
            on_hold: false
          }]
        });
        transferId = transfer.items?.[0]?.id;
        console.log(`✅ Auto-transfer: ₹${creatorShare} to creator, ₹${platformFee} to SocialMitr`);
      } catch (tErr) {
        console.error('Transfer error (will mark as manual):', tErr.message);
      }
    }

    // Update payment record
    await supabase.from('payments').update({
      status: 'released',
      released_at: new Date().toISOString(),
      creator_amount: creatorShare,
      platform_fee: platformFee,
      transfer_id: transferId,
      note: transferId
        ? `Auto-transferred ₹${creatorShare} (85%) to creator. SocialMitr fee: ₹${platformFee} (15%).`
        : `Manual payout pending: ₹${creatorShare} (85%) to creator. SocialMitr fee: ₹${platformFee} (15%).`
    }).eq('contract_id', contractId);

    // Update contract
    await supabase.from('contracts').update({
      status: 'completed',
      completed_at: new Date().toISOString(),
      business_done: true,
      creator_done: true
    }).eq('id', contractId);

    await supabase.from('jobs').update({ status: 'completed' }).eq('id', contract.job_id);

    // Update creator earnings
    const { data: creatorProfile } = await supabase.from('creators').select('total_earned,completed_jobs').eq('id', contract.creators?.id).single();
    const currentEarned = Number(creatorProfile?.total_earned) || 0;
    const currentCompleted = Number(creatorProfile?.completed_jobs) || 0;
    await supabase.from('creators')
      .update({
        total_earned: currentEarned + Number(creatorShare || 0),
        completed_jobs: currentCompleted + 1
      })
      .eq('id', contract.creators?.id);

    // Notify creator
    if (contract.creators?.user_id) {
      notify(contract.creators.user_id,
        '💸 Payment Released!',
        transferId
          ? `₹${creatorShare} has been transferred to your account for "${contract.jobs?.title}". SocialMitr kept ₹${platformFee} (15%) as platform fee.`
          : `₹${creatorShare} approved for "${contract.jobs?.title}". You'll receive it within 2-3 business days.`,
        'payment'
      );
    }

    res.json({
      success: true,
      message: `Payment released! Creator gets ₹${creatorShare} (85%), SocialMitr fee: ₹${platformFee} (15%).`,
      creatorShare,
      platformFee,
      transferred: !!transferId
    });
  } catch (err) {
    console.error('Release error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── 5. GET PAYMENT STATUS FOR CONTRACT ──────────────────────────────────────
app.get('/api/payments/contract/:contractId', auth, async (req, res) => {
  try {
    const { data: payment } = await supabase.from('payments')
      .select('*').eq('contract_id', req.params.contractId).single();
    res.json({ success: true, payment });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ─── 6. RAZORPAY WEBHOOK (for payment status updates from Razorpay) ───────────
app.post('/api/webhooks/razorpay', express.raw({ type: 'application/json' }), (req, res) => {
  const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (webhookSecret) {
    const sig = req.headers['x-razorpay-signature'];
    const expectedSig = crypto.createHmac('sha256', webhookSecret).update(req.body).digest('hex');
    if (sig !== expectedSig) return res.status(400).json({ error: 'Invalid signature' });
  }
  const event = JSON.parse(req.body);
  console.log('Razorpay webhook:', event.event);
  // Handle payment.failed events
  if (event.event === 'payment.failed') {
    const contractId = event.payload?.payment?.entity?.notes?.contract_id;
    if (contractId) {
      supabase.from('payments').update({ status: 'failed' }).eq('contract_id', contractId).then();
    }
  }
  res.json({ received: true });
});


// ─── Razorpay instance initialized above ───────────────────────────────────

// ─── CREATE RAZORPAY ORDER (business initiates payment) ────────────────────
app.post('/api/razorpay/create-order', auth, async (req, res) => {
  if (req.user.type !== 'business') return res.status(403).json({ success: false, message: 'Only businesses can initiate payment' });
  const { contract_id } = req.body;
  if (!contract_id) return res.status(400).json({ success: false, message: 'contract_id required' });
  try {
    const { data: contract } = await supabase.from('contracts')
      .select('*, jobs(title), creators(name), businesses(business_name, user_id)')
      .eq('id', contract_id).single();
    if (!contract) return res.status(404).json({ success: false, message: 'Contract not found' });
    if (contract.businesses.user_id !== req.user.userId)
      return res.status(403).json({ success: false, message: 'Not your contract' });

    const amount = contract.agreed_amount;
    if (!amount || amount <= 0) return res.status(400).json({ success: false, message: 'Invalid contract amount' });

    const order = await razorpay.orders.create({
      amount: Math.round(amount * 100), // Razorpay uses paise (₹1 = 100 paise)
      currency: 'INR',
      receipt: `sm_${contract_id.slice(0, 8)}_${Date.now()}`,
      notes: {
        contract_id,
        job_title: contract.jobs?.title,
        creator_name: contract.creators?.name,
        business_name: contract.businesses?.business_name,
        platform: 'SocialMitr'
      }
    });

    // Save order ID to payment record
    await supabase.from('payments')
      .update({ razorpay_order_id: order.id, status: 'awaiting_payment' })
      .eq('contract_id', contract_id);

    console.log(`\n💳 Razorpay order created: ${order.id} for ₹${amount} (contract: ${contract_id})`);

    res.json({
      success: true,
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      keyId: process.env.RAZORPAY_KEY_ID,
      contractId: contract_id,
      jobTitle: contract.jobs?.title,
      creatorName: contract.creators?.name,
      businessName: contract.businesses?.business_name
    });
  } catch (err) {
    console.error('Razorpay order error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── VERIFY PAYMENT & HOLD IN ESCROW ─────────────────────────────────────────
app.post('/api/razorpay/verify-payment', auth, async (req, res) => {
  if (req.user.type !== 'business') return res.status(403).json({ success: false, message: 'Not a business' });
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature, contract_id } = req.body;
  try {
    const crypto = require('crypto');
    const keySecret = process.env.RAZORPAY_KEY_SECRET;
    const expectedSig = crypto.createHmac('sha256', keySecret)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest('hex');

    if (expectedSig !== razorpay_signature)
      return res.status(400).json({ success: false, message: 'Payment verification failed. Signature mismatch.' });

    // Payment verified — update status to 'held' (escrow)
    await supabase.from('payments').update({
      status: 'held',
      razorpay_payment_id,
      razorpay_order_id,
      paid_at: new Date().toISOString()
    }).eq('contract_id', contract_id);

    // Get contract details for notifications
    const { data: contract } = await supabase.from('contracts')
      .select('*, jobs(title), creators(name,user_id), businesses(business_name, user_id)')
      .eq('id', contract_id).single();

    const creatorUserId = contract?.creators?.user_id;
    const creatorName = contract?.creators?.name;
    const businessName = contract?.businesses?.business_name;
    const jobTitle = contract?.jobs?.title;
    const amount = contract?.agreed_amount;

    // Notify creator that payment is held in escrow
    if (creatorUserId) {
      notify(creatorUserId,
        '💰 Payment Secured in Escrow!',
        `${businessName} has paid ₹${amount} for "${jobTitle}". Funds are held safely — deliver your work and request release.`,
        'payment'
      );
      // Move to creator's pending wallet balance
      try {
        const { data: cr } = await supabase.from('creators').select('id').eq('user_id', creatorUserId).single();
        if (cr) await pendingCredit(cr.id, Number(amount), contract_id, `Escrow for "${jobTitle}" from ${businessName}`);
      } catch (wErr) { console.error('Pending wallet credit error (non-fatal):', wErr.message); }
    }

    // Notify business
    notify(req.user.userId,
      '✅ Payment Held in Escrow',
      `₹${amount} is securely held for "${jobTitle}". Funds will release to ${creatorName} after you approve the work.`,
      'payment'
    );

    console.log(`\n✅ Payment verified & held: ₹${amount} for ${jobTitle}`);
    res.json({ success: true, message: `₹${amount} held in escrow. ${creatorName} will be notified to start work!` });
  } catch (err) {
    console.error('Payment verify error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── RELEASE PAYMENT (business approves work → auto-split) ───────────────────
app.post('/api/razorpay/release-payment', auth, async (req, res) => {
  if (req.user.type !== 'business') return res.status(403).json({ success: false, message: 'Only businesses can release payment' });
  const { contract_id } = req.body;
  try {
    // Get payment and contract details
    const { data: payment } = await supabase.from('payments')
      .select('*').eq('contract_id', contract_id).single();

    if (!payment) return res.status(404).json({ success: false, message: 'Payment not found' });
    if (payment.status !== 'held')
      return res.status(400).json({ success: false, message: `Cannot release — payment status is "${payment.status}"` });

    const { data: contract } = await supabase.from('contracts')
      .select('*, jobs(title), creators(name,user_id), businesses(business_name,user_id)')
      .eq('id', contract_id).single();

    if (contract?.businesses?.user_id !== req.user.userId) {
      return res.status(403).json({ success: false, message: 'Not authorized to release this payment' });
    }

    const amount = contract.agreed_amount;
    const creatorShare = Math.round(amount * 0.93);   // 93% to creator
    const platformShare = Math.round(amount * 0.07);   // 7% SocialMitr fee

    // ── If Razorpay Route is configured, do auto-split ──────────────────────
    // (Razorpay Route requires activation — for now we mark as released and notify)
    // In production: use razorpay.transfers.create() to auto-transfer to creator's bank
    // See: https://razorpay.com/docs/route/

    // Update payment status to released
    await supabase.from('payments').update({
      status: 'released',
      released_at: new Date().toISOString(),
      creator_share: creatorShare,
      platform_share: platformShare,
      note: `Auto-split: ₹${creatorShare} to creator (93%), ₹${platformShare} platform fee (7%)`
    }).eq('contract_id', contract_id);

    // Mark contract complete
    await supabase.from('contracts').update({
      status: 'completed',
      completed_at: new Date().toISOString(),
      business_done: true
    }).eq('id', contract_id);

    // Update creator earnings
    const { data: creator } = await supabase.from('creators')
      .select('id,total_earned').eq('user_id', contract.creators.user_id).single();
    if (creator) {
      await supabase.from('creators').update({
        total_earned: (creator.total_earned || 0) + creatorShare,
        completed_jobs: supabase.raw ? supabase.raw('completed_jobs + 1') : undefined
      }).eq('id', creator.id);
      // ── Confirm pending → available in wallet ──
      try {
        await confirmPendingCredit(creator.id, contract.agreed_amount, contract_id, `Payment approved by ${contract.businesses.business_name} for "${contract.jobs.title}"`);
      } catch (wErr) { console.error('Wallet confirm error (non-fatal):', wErr.message); }
    }

    // Notify creator
    const creatorUserId = contract.creators.user_id;
    notify(creatorUserId, '🎉 Payment Released!',
      `${contract.businesses.business_name} approved your work! ₹${creatorShare} has been released to you (${Math.round(amount * .93)}% of ₹${amount} after 7% platform fee).`,
      'payment'
    );

    // Send email to creator
    const { data: creatorUser } = await supabase.from('users').select('email').eq('id', creatorUserId).single();
    if (creatorUser?.email) {
      sendEmail(creatorUser.email, {
        subject: `💸 Payment of ₹${creatorShare} Released — ${contract.businesses.business_name}`,
        html: `<div style="font-family:'Segoe UI',sans-serif;background:#0f0f0f;color:#f0ece4;padding:32px;border-radius:12px;max-width:560px">
          <h2 style="color:#06d6a0;margin:0 0 16px">💸 Payment Released!</h2>
          <p style="color:#aaa;line-height:1.7">Great news! <strong style="color:#f0ece4">${contract.businesses.business_name}</strong> has approved your work for <strong style="color:#ff6b2b">"${contract.jobs.title}"</strong>.</p>
          <div style="background:#1e1e1e;border:1px solid #2a2a2a;border-radius:12px;padding:20px;margin:20px 0">
            <div style="display:flex;justify-content:space-between;margin-bottom:10px"><span style="color:#888">Total contract</span><span>₹${amount}</span></div>
            <div style="display:flex;justify-content:space-between;margin-bottom:10px"><span style="color:#888">Platform fee (7%)</span><span style="color:#f87171">- ₹${platformShare}</span></div>
            <div style="display:flex;justify-content:space-between;font-size:1.1rem;font-weight:700;border-top:1px solid #333;padding-top:10px"><span style="color:#06d6a0">Your earnings</span><span style="color:#06d6a0">₹${creatorShare}</span></div>
          </div>
          <p style="color:#666;font-size:12px">Funds will be transferred to your registered bank account within 2-3 business days via Razorpay.</p>
        </div>`,
        text: `Payment of ₹${creatorShare} released for "${contract.jobs.title}". Platform fee: ₹${platformShare}.`
      });
    }

    console.log(`\n✅ Payment released: ₹${creatorShare} to creator, ₹${platformShare} platform fee`);
    res.json({
      success: true,
      message: `Payment approved! ₹${creatorShare} released to ${contract.creators.name}.`,
      creatorShare,
      platformShare,
      totalAmount: amount
    });
  } catch (err) {
    console.error('Release payment error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── GET PAYMENT STATUS ───────────────────────────────────────────────────────
app.get('/api/razorpay/payment-status/:contractId', auth, async (req, res) => {
  try {
    const { data: payment } = await supabase.from('payments')
      .select('*').eq('contract_id', req.params.contractId).single();
    res.json({ success: true, payment: payment || null });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  WALLET & PAYOUT SYSTEM (additive — does not modify existing payment flow)
// ═══════════════════════════════════════════════════════════════════════════════
registerWalletRoutes(app, auth);

// Allow inline event handlers for local development (remove in production)
app.use((req, res, next) => {
  res.setHeader("Content-Security-Policy", "script-src-attr 'unsafe-inline'");
  next();
});

app.listen(PORT, () => {
  console.log(`\n🚀 SocialMitr v5 running at http://localhost:${PORT}`);
  console.log(`   Admin stats: GET /api/admin/stats (header: x-admin-secret)\n`);
});

