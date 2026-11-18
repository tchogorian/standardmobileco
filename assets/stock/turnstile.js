import { CONFIG } from './api.js';

let loading = null;

function load() {
  loading ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    s.async = true;
    s.onload = () => resolve(window.turnstile);
    s.onerror = () => { loading = null; reject(new Error('Could not load the verification check. Refresh and try again.')); };
    document.head.append(s);
  });
  return loading;
}

// Renders a Turnstile widget into slot. The returned object holds the current token.
export async function mountTurnstile(slot) {
  const captcha = { token: null, widgetId: null };
  captcha.reset = () => {
    captcha.token = null;
    if (window.turnstile && captcha.widgetId != null) window.turnstile.reset(captcha.widgetId);
  };
  const turnstile = await load();
  if (!slot.isConnected) return captcha;
  captcha.widgetId = turnstile.render(slot, {
    sitekey: CONFIG.TURNSTILE_SITE_KEY,
    callback: (t) => { captcha.token = t; },
    'expired-callback': () => { captcha.token = null; },
    'error-callback': () => { captcha.token = null; },
  });
  return captcha;
}
