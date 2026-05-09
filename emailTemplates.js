// emailTemplates.js — SocialMitr v4

function baseEmail(accentColor, badgeText, badgeColor, subheading, bodyHtml, ctaText, ctaLink) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#0f0f0f;font-family:'Segoe UI',Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#0f0f0f;padding:32px 0;">
<tr><td align="center">
<table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;">
  <tr><td style="background:#1a1a1a;border:1px solid #2a2a2a;border-radius:20px 20px 0 0;padding:32px 40px 24px;text-align:center;">
    <div style="display:inline-block;background:${badgeColor};border-radius:100px;padding:5px 16px;margin-bottom:18px;">
      <span style="color:${accentColor};font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;">${badgeText}</span>
    </div>
    <h1 style="margin:0;font-size:26px;font-weight:800;color:#f0ece4;letter-spacing:-1px;">Welcome to <span style="color:#ff6b2b;">SocialMitr</span></h1>
    <p style="margin:10px 0 0;font-size:13px;color:#888;">${subheading}</p>
  </td></tr>
  <tr><td style="background:${accentColor};padding:2px 0;"></td></tr>
  <tr><td style="background:#161616;border:1px solid #2a2a2a;border-top:none;padding:32px 40px;">
    ${bodyHtml}
    <div style="text-align:center;margin-top:28px;">
      <a href="${ctaLink}" style="display:inline-block;background:${accentColor};color:${accentColor==='#06d6a0'?'#0a0a0a':'#fff'};text-decoration:none;padding:12px 28px;border-radius:10px;font-size:14px;font-weight:700;">${ctaText}</a>
    </div>
  </td></tr>
  <tr><td style="background:#111;border:1px solid #2a2a2a;border-top:none;border-radius:0 0 20px 20px;padding:18px 40px;text-align:center;">
    <p style="margin:0;font-size:11px;color:#444;"><strong style="color:#ff6b2b;">SocialMitr</strong> · Connecting Local Talent with Local Business</p>
  </td></tr>
</table>
</td></tr></table></body></html>`;
}

function row(label, value, color) {
  return `<tr><td style="padding:7px 0;border-bottom:1px solid #222;"><span style="font-size:10px;color:#555;display:block;margin-bottom:2px;">${label}</span><span style="font-size:13px;color:${color||'#f0ece4'};font-weight:600;">${value}</span></td></tr>`;
}
function card(rows) {
  return `<table width="100%" cellpadding="0" cellspacing="0" style="background:#1e1e1e;border:1px solid #2a2a2a;border-radius:12px;margin-bottom:20px;"><tr><td style="padding:16px 20px;"><table width="100%" cellpadding="0" cellspacing="0">${rows}</table></td></tr></table>`;
}

const editorWelcomeEmail = ({ name, city, primarySkill, niche, rate, dashboardLink }) => ({
  subject: `🎬 Welcome to SocialMitr, ${name}!`,
  html: baseEmail('#ff6b2b','Creator Confirmed','rgba(255,107,43,0.15)','Your profile is live — businesses can discover you now.',
    `<p style="font-size:15px;color:#f0ece4;margin:0 0 18px;">Hey <strong style="color:#ff6b2b;">${name}</strong>! You're on SocialMitr 🎬</p>
    <p style="font-size:13px;color:#888;margin:0 0 20px;line-height:1.7;">Browse job posts from local gyms, cafes, and clothing stores. Apply, chat, and get paid — all in one place.</p>
    ${card(row('NAME',name)+row('CITY',city)+row('SKILL',primarySkill)+row('NICHE',niche)+row('RATE',`₹${rate}/month`,'#ff6b2b'))}`,
    'Go to Dashboard →', dashboardLink),
  text: `Welcome ${name}! Your SocialMitr profile is live. Dashboard: ${dashboardLink}`
});

const businessWelcomeEmail = ({ name, businessName, businessType, city, budget, dashboardLink }) => ({
  subject: `🏪 Welcome to SocialMitr, ${businessName}!`,
  html: baseEmail('#06d6a0','Business Confirmed','rgba(6,214,160,0.12)','Your business is registered — start finding creators today.',
    `<p style="font-size:15px;color:#f0ece4;margin:0 0 18px;">Hey <strong style="color:#06d6a0;">${name}</strong>! <strong>${businessName}</strong> is now live 🏪</p>
    <p style="font-size:13px;color:#888;margin:0 0 20px;line-height:1.7;">Post a job, review proposals from local creators, and build your social media presence.</p>
    ${card(row('BUSINESS',businessName)+row('OWNER',name)+row('TYPE',businessType)+row('CITY',city)+row('BUDGET',budget,'#06d6a0'))}`,
    'Post Your First Job →', dashboardLink),
  text: `Welcome ${name}! ${businessName} is live on SocialMitr. Dashboard: ${dashboardLink}`
});

const applicationNotificationEmail = ({ businessName, ownerName, jobTitle, creatorName, creatorCity, creatorSkill, creatorRate, coverLetter, dashboardLink }) => ({
  subject: `📩 New Proposal for "${jobTitle}" — ${creatorName} is interested`,
  html: baseEmail('#ff6b2b','New Proposal Received','rgba(255,107,43,0.15)','A local creator applied to your job.',
    `<p style="font-size:15px;color:#f0ece4;margin:0 0 18px;">Hey <strong style="color:#ff6b2b;">${ownerName}</strong>! You have a new proposal 📩</p>
    ${card(row('CREATOR',creatorName)+row('CITY',creatorCity)+row('SKILL',creatorSkill)+row('RATE',`₹${creatorRate}/month`,'#ff6b2b'))}
    ${coverLetter ? `<div style="background:#1e1e1e;border:1px solid #2a2a2a;border-radius:10px;padding:14px 18px;font-size:13px;color:#aaa;font-style:italic;margin-bottom:16px;">"${coverLetter}"</div>` : ''}
    <p style="font-size:12px;color:#666;">Log in to review their full profile and accept or reject the proposal.</p>`,
    'Review Application →', dashboardLink),
  text: `${creatorName} applied for "${jobTitle}". Review at: ${dashboardLink}`
});

const applicationStatusEmail = ({ creatorName, jobTitle, businessName, status, dashboardLink }) => {
  const accepted = status === 'accepted';
  return {
    subject: accepted ? `🎉 Proposal Accepted — ${businessName}` : `📋 Proposal Update — ${businessName}`,
    html: baseEmail(accepted?'#06d6a0':'#888', accepted?'Proposal Accepted!':'Proposal Update', accepted?'rgba(6,214,160,0.12)':'rgba(100,100,100,0.1)', '',
      `<p style="font-size:15px;color:#f0ece4;margin:0 0 18px;">${accepted?'🎉':'📋'} Hey <strong>${creatorName}</strong>!</p>
      <p style="font-size:13px;color:#aaa;margin:0 0 20px;line-height:1.75;">${accepted ? `<strong style="color:#06d6a0;">${businessName}</strong> accepted your proposal for <strong>"${jobTitle}"</strong>! A chat room has been created — log in to start the conversation.` : `<strong>${businessName}</strong> has reviewed your proposal for <strong>"${jobTitle}"</strong> and decided to go a different direction this time. Keep applying — more opportunities await!`}</p>`,
      'Go to Dashboard →', dashboardLink),
    text: `${accepted?'Accepted':'Update'}: Your proposal for "${jobTitle}" at ${businessName}. Dashboard: ${dashboardLink}`
  };
};

const paymentRequestEmail = ({ businessName, ownerName, creatorName, jobTitle, amount, dashboardLink }) => ({
  subject: `💰 Payment Requested — ${creatorName} for "${jobTitle}"`,
  html: baseEmail('#ffd166','Payment Request','rgba(255,209,102,0.12)','',
    `<p style="font-size:15px;color:#f0ece4;margin:0 0 18px;">Hey <strong>${ownerName}</strong>! Payment has been requested 💰</p>
    ${card(row('CREATOR',creatorName)+row('JOB',jobTitle)+row('AMOUNT',`₹${amount}`,'#ffd166'))}
    <p style="font-size:12px;color:#666;">Log in to your dashboard to release the payment via UPI or bank transfer.</p>`,
    'Release Payment →', dashboardLink),
  text: `${creatorName} requested ₹${amount} payment for "${jobTitle}". Dashboard: ${dashboardLink}`
});

const paymentReleasedEmail = ({ creatorName, businessName, jobTitle, amount, upiId, txnId, dashboardLink }) => ({
  subject: `💸 Payment of ₹${amount} Released — ${businessName}`,
  html: baseEmail('#06d6a0','Payment Released!','rgba(6,214,160,0.12)','',
    `<p style="font-size:15px;color:#f0ece4;margin:0 0 18px;">Hey <strong style="color:#06d6a0;">${creatorName}</strong>! You've been paid 💸</p>
    ${card(row('JOB',jobTitle)+row('AMOUNT',`₹${amount}`,'#06d6a0')+row('UPI',upiId||'N/A')+row('TXN ID',txnId||'N/A'))}
    <p style="font-size:12px;color:#666;">The payment has been transferred. Check your UPI app for the credit.</p>`,
    'View My Earnings →', dashboardLink),
  text: `₹${amount} released by ${businessName} for "${jobTitle}". TXN: ${txnId}`
});

module.exports = { editorWelcomeEmail, businessWelcomeEmail, applicationNotificationEmail, applicationStatusEmail, paymentRequestEmail, paymentReleasedEmail };
