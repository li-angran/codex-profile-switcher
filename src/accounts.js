'use strict';

// Account details from a Codex home's auth.json. The ID token is decoded locally for its e-mail, plan
// and account id. The access and refresh tokens are not used, and nothing is logged or sent anywhere.

const fs = require('fs');
const path = require('path');

const cache = new Map(); // auth.json path -> { key, info }

function decodeJwt(token) {
  try {
    const part = token.split('.')[1];
    return JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch (_) {
    return null;
  }
}

function accountInfoFromAuth(auth) {
  const tokens = (auth && auth.tokens) || {};
  if (tokens.id_token || tokens.access_token) {
    const claims = decodeJwt(tokens.id_token || '') || {};
    const openai = claims['https://api.openai.com/auth'] || {};
    return {
      signedIn: true,
      mode: 'chatgpt',
      email: claims.email || null,
      plan: openai.chatgpt_plan_type || null,
      accountId: openai.chatgpt_account_id || tokens.account_id || null,
      userId: openai.chatgpt_user_id || openai.user_id || null,
    };
  }
  if (auth && auth.OPENAI_API_KEY) return { signedIn: true, mode: 'apikey', email: null, plan: null, accountId: null };
  return { signedIn: false };
}

function accountInfo(home) {
  const file = path.join(home, 'auth.json');
  let st;
  try {
    st = fs.statSync(file);
  } catch (_) {
    cache.delete(file);
    return { signedIn: false };
  }
  const key = `${st.size}:${st.mtimeMs}`;
  const hit = cache.get(file);
  if (hit && hit.key === key) return hit.info;
  let info;
  try {
    info = accountInfoFromAuth(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch (_) {
    info = { signedIn: false };
  }
  cache.set(file, { key, info });
  return info;
}

const PLAN_NAMES = {
  free: 'Free plan', go: 'Go plan', plus: 'Plus plan', pro: 'Pro plan', prolite: 'Pro Lite plan',
  team: 'Team', business: 'Business', enterprise: 'Enterprise', edu: 'Edu',
};

function planLabel(plan) {
  if (!plan) return null;
  return PLAN_NAMES[plan] || `${plan.charAt(0).toUpperCase()}${plan.slice(1)} plan`;
}

function accountLabel(info) {
  if (!info.signedIn) return 'Not signed in';
  if (info.mode === 'apikey') return 'API key';
  return [info.email || 'Signed in', planLabel(info.plan)].filter(Boolean).join(' · ');
}

module.exports = { decodeJwt, accountInfo, accountInfoFromAuth, accountLabel, planLabel };
