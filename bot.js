const http = require('http');
const crypto = require('crypto');
const https = require('https');
const querystring = require('querystring');
const {
    Client,
    GatewayIntentBits,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder
} = require('discord.js');
const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const PUBLIC_URL = (process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : (process.env.PUBLIC_URL || `http://localhost:${PORT}`)).replace(/\/$/, '');

const NINTENDO_CLIENT_ID = '045ab1d9068381b3';

// RAM efímera: SOLO mantiene usuarios mientras están ONLINE.
const activeSessions = new Map();
const oauthByState = new Map();
const oauthByUser = new Map();
let hostSocket = null;

function base64UrlClean(buffer) {
    return buffer.toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
}

function createNintendoAuthForUser(discordId = '') {
    const verifier = base64UrlClean(crypto.randomBytes(32));
    const challenge = base64UrlClean(crypto.createHash('sha256').update(verifier).digest());
    const state = base64UrlClean(crypto.randomBytes(36));

    const record = { verifier, state, createdAt: Date.now() };
    oauthByState.set(state, record);
    if (discordId) oauthByUser.set(String(discordId), record);

    // CLAVE EXACTA DE LAS FOTOS:
    // 1. NUNCA incluir &theme=login_form (eso forzaba el re-login con código de correo y rompía la solicitud)
    // 2. Scope limpio openid user user.birthday
    const authorizeUrl =
        `https://accounts.nintendo.com/connect/1.0.0/authorize` +
        `?client_id=${NINTENDO_CLIENT_ID}` +
        `&redirect_uri=npf${NINTENDO_CLIENT_ID}%3A%2F%2Fauth` +
        `&response_type=session_token_code` +
        `&scope=openid+user+user.birthday` +
        `&session_token_code_challenge=${challenge}` +
        `&session_token_code_challenge_method=S256` +
        `&state=${state}`;

    return { state, verifier, url: authorizeUrl };
}

function exchangeCodeWithNintendo(sessionTokenCode, verifier) {
    return new Promise((resolve, reject) => {
        const postData = querystring.stringify({
            client_id: NINTENDO_CLIENT_ID,
            session_token_code: sessionTokenCode,
            session_token_code_verifier: verifier
        });
        const req = https.request('https://accounts.nintendo.com/connect/1.0.0/api/session_token', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(postData),
                'User-Agent': 'OnlineLounge/2.10.0 NASDKAPI Android'
            }
        }, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                try {
                    const data = JSON.parse(body);
                    if (data.session_token) return resolve(data.session_token);
                    reject(new Error(data.error_description || JSON.stringify(data)));
                } catch (e) {
                    reject(e);
                }
            });
        });
        req.on('error', reject);
        req.write(postData);
        req.end();
    });
}

function syncHostWorkers() {
    if (hostSocket && hostSocket.readyState === WebSocket.OPEN) {
        const payload = [];
        for (const [discordId, s] of activeSessions.entries()) {
            payload.push({
                discordId,
                friendCode: s.friendCode,
                sessionToken: s.sessionToken,
                dcBinB64: s.dcBinB64 || ''
            });
        }
        hostSocket.send(JSON.stringify({ type: 'SYNC_ONLINE_MAINS', mains: payload }));
    }
}

// ══════════════════════════════════════════════════════════════════════
// Bóveda Local (/vault) — Calcando el flujo de 2 pasos de las fotos
// ══════════════════════════════════════════════════════════════════════
function renderVaultHtml(uid, oauthState, nintendoUrl) {
    return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Zenith Local Vault — Auto-Accept</title>
<style>
  :root { --bg: #0f172a; --card: #1e293b; --accent: #10b981; --danger: #ef4444; --text: #f8fafc; --muted: #94a3b8; }
  body { font-family: system-ui, -apple-system, sans-serif; background: var(--bg); color: var(--text); margin: 0; padding: 16px; display: flex; justify-content: center; }
  .container { max-width: 500px; width: 100%; background: var(--card); border-radius: 16px; padding: 22px; box-shadow: 0 10px 30px rgba(0,0,0,0.45); }
  h2 { margin-top: 0; font-size: 1.3rem; }
  .lang-bar { display: flex; gap: 8px; margin-bottom: 16px; }
  .lang-btn { flex: 1; padding: 8px; border-radius: 8px; border: 1px solid #334155; background: #0f172a; color: var(--text); cursor: pointer; font-weight: 600; }
  .lang-btn.active { border-color: var(--accent); background: rgba(16, 185, 129, 0.15); }
  .badge { background: rgba(16,185,129,0.15); color: #34d399; padding: 10px 12px; border-radius: 10px; font-size: 0.84rem; line-height: 1.4; margin-bottom: 14px; border: 1px solid rgba(16,185,129,0.3); }
  label { display: block; font-size: 0.85rem; color: var(--muted); margin: 12px 0 4px; font-weight: 600; }
  input[type="text"], input[type="file"] { width: 100%; box-sizing: border-box; padding: 11px; border-radius: 8px; border: 1px solid #334155; background: #0f172a; color: var(--text); font-size: 0.92rem; }
  .btn, a.btn-link { display: block; text-align: center; text-decoration: none; width: 100%; box-sizing: border-box; padding: 12px; border-radius: 10px; border: none; font-weight: 700; font-size: 0.95rem; cursor: pointer; margin-top: 10px; }
  .btn-step1 { background: #6366f1; color: white; }
  .btn-primary { background: #3b82f6; color: white; }
  .btn-online { background: var(--accent); color: #052e16; }
  .btn-offline { background: #f59e0b; color: #1e293b; }
  .btn-unlink { background: transparent; border: 1px solid var(--danger); color: #f87171; margin-top: 16px; }
  .step-box { background: #0f172a; padding: 13px; border-radius: 10px; margin-top: 12px; border: 1px solid #334155; font-size: 0.88rem; line-height: 1.48; }
  .status { margin-top: 14px; padding: 12px; border-radius: 8px; font-weight: 600; text-align: center; display: none; }
</style>
</head>
<body>
<div class="container">
  <div class="lang-bar">
    <button class="lang-btn active" onclick="setLang('es')" id="btn-es">🇪🇸 Español</button>
    <button class="lang-btn" onclick="setLang('en')" id="btn-en">🇺🇸 English</button>
  </div>

  <h2 id="title">🛡️ Bóveda Local de Auto-Accept</h2>
  <div class="badge" id="privacy-note">
    🔒 <b>Privacidad Garantizada:</b> Nosotros <b>NUNCA</b> nos quedamos con tus datos de inicio de sesión. Tu token se guarda <b>únicamente de forma local en tu dispositivo</b>. Al ponerte Offline, se borra de la memoria RAM del servidor.
  </div>

  <label id="lbl-discord">1. Tu ID de Usuario de Discord</label>
  <input type="text" id="discordId" value="${uid}" placeholder="Ej: 123456789012345678">

  <label id="lbl-fc">2. Tu Código de Amigo (16 dígitos)</label>
  <input type="text" id="friendCode" placeholder="Ej: 9370-0010-9308-6237">

  <!-- Flujo idéntico a las fotos del otro servidor -->
  <div id="setup-section" class="step-box">
    <div id="setup-steps">
      <b>Sigue estos pasos en orden para evitar el error de correo:</b><br><br>
      <b>Paso 1 (Iniciar sesión primero):</b> Toca el botón morado para abrir <code>accounts.nintendo.com</code>. Inicia sesión ahí y mete el código de tu correo hasta ver tu perfil de Nintendo. <b>Luego regresa a esta pestaña.</b><br>
      <a href="https://accounts.nintendo.com/login" target="_blank" class="btn-link btn-step1" id="btn-step1">
        👤 Paso 1: Iniciar Sesión en Nintendo.com primero
      </a>
      <br>
      <b>Paso 2 (Obtener enlace del botón rojo):</b> Ahora que ya iniciaste sesión en el Paso 1, toca el botón azul de abajo. Te saldrá directo la pantalla <i>"Link an account"</i> sin pedirte correo. Mantén presionado (o haz clic derecho en) el botón rojo <b>"Select this account"</b> -> <b>"Copiar dirección de enlace"</b>.<br>
      <a href="${nintendoUrl}" target="_blank" class="btn-link btn-primary" id="btn-step2">
        🔗 Paso 2: Ir al Botón Rojo "Select this account"
      </a>
    </div>

    <label id="lbl-paste">Paso 3: Pega aquí el enlace copiado del botón rojo (npf045ab...)</label>
    <input type="text" id="copiedLink" placeholder="npf045ab1d9068381b3://auth#session_token_code=...">
    <button class="btn btn-online" onclick="generateLocalToken()" id="btn-save-tok">💾 Guardar Token en mi Dispositivo</button>
  </div>

  <!-- Opcional dc.bin -->
  <div class="step-box">
    <label id="lbl-dcbin" style="margin-top:0">📂 Opcional: Añadir archivo dc.bin (Para seguir jugando sin desconexiones)</label>
    <input type="file" id="dcBinFile" accept=".bin" onchange="saveDcBin(event)">
    <small id="dcbin-status" style="color:var(--muted)"></small>
  </div>

  <!-- Sección cuando el Token ya está cargado localmente -->
  <div id="ready-section" class="step-box" style="display:none; border-color: var(--accent);">
    <div id="tok-ready-msg" style="color:#34d399; font-weight:700; margin-bottom:6px;">
      ✅ Token local listo en este dispositivo
    </div>
    <small id="offline-hint" style="color:var(--muted); display:block; margin-bottom:10px;">
      Al ponerte Online, el Host aceptará solicitudes por ti usando una única IP fija. Puedes cerrar esta ventana o desconectarte de internet.
    </small>

    <button class="btn btn-online" onclick="goOnline()" id="btn-go-online">🟢 PONERSE ONLINE (Activar Auto-Accept)</button>
    <button class="btn btn-offline" onclick="goOffline()" id="btn-go-offline">🔴 SALIR A OFFLINE (Borrar de RAM)</button>
    <button class="btn btn-unlink" onclick="unlinkToken()" id="btn-unlink">🔓 Desvincular y Borrar Token de mi Dispositivo</button>
  </div>

  <div id="statusBox" class="status"></div>
</div>

<script>
const SERVER_STATE = "${oauthState}";
let currentLang = 'es';

const I18N = {
  es: {
    title: '🛡️ Bóveda Local de Auto-Accept',
    privacy: '🔒 <b>Privacidad Garantizada:</b> Nosotros <b>NUNCA</b> nos quedamos con tus datos de inicio de sesión. Tu token se guarda <b>únicamente de forma local en tu dispositivo</b>. Al ponerte Offline, se borra de la memoria RAM del servidor.',
    discord: '1. Tu ID de Usuario de Discord',
    fc: '2. Tu Código de Amigo (16 dígitos)',
    steps: '<b>Sigue estos pasos en orden para evitar el error de correo:</b><br><br><b>Paso 1 (Iniciar sesión primero):</b> Toca el botón morado para abrir <code>accounts.nintendo.com</code>. Inicia sesión ahí y mete el código de tu correo hasta ver tu perfil de Nintendo. <b>Luego regresa a esta pestaña.</b><br><a href="https://accounts.nintendo.com/login" target="_blank" class="btn-link btn-step1">👤 Paso 1: Iniciar Sesión en Nintendo.com primero</a><br><b>Paso 2 (Obtener enlace del botón rojo):</b> Ahora que ya iniciaste sesión en el Paso 1, toca el botón azul de abajo. Te saldrá directo la pantalla <i>"Link an account"</i> sin pedirte correo. Mantén presionado (o clic derecho en) el botón rojo <b>"Select this account"</b> -> <b>"Copiar dirección de enlace"</b>.<br><a href="${nintendoUrl}" target="_blank" class="btn-link btn-primary">🔗 Paso 2: Ir al Botón Rojo "Select this account"</a>',
    paste: 'Paso 3: Pega aquí el enlace copiado del botón rojo (npf045ab...)',
    saveTok: '💾 Guardar Token en mi Dispositivo',
    dcbin: '📂 Opcional: Añadir archivo dc.bin (Para seguir jugando sin desconexiones)',
    readyMsg: '✅ Token guardado localmente en este dispositivo',
    hint: 'Al ponerte Online, el Host aceptará tus solicitudes con 1 única IP fija. Ya puedes cerrar el navegador o desconectarte de internet.',
    online: '🟢 PONERSE ONLINE (Activar Auto-Accept)',
    offline: '🔴 SALIR A OFFLINE (Borrar de RAM)',
    unlink: '🔓 Desvincular Token (Borrar de este dispositivo)',
    unlinkAlert: '✅ El archivo de token ha sido eliminado de tu dispositivo y de la memoria del servidor.\\n\\n🔐 Para tu total tranquilidad, te sugerimos actualizar tu contraseña en accounts.nintendo.com.'
  },
  en: {
    title: '🛡️ Local Auto-Accept Vault',
    privacy: '🔒 <b>Guaranteed Privacy:</b> We <b>NEVER</b> keep your login credentials. Your token is stored <b>exclusively inside your own device\\'s local storage</b>. When you go Offline, it is wiped from server RAM immediately.',
    discord: '1. Your Discord User ID',
    fc: '2. Your 16-digit Friend Code',
    steps: '<b>Follow these steps in order to avoid the email verification error:</b><br><br><b>Step 1 (Login first):</b> Tap the purple button to open <code>accounts.nintendo.com</code>. Sign in there and enter your email verification code until you see your Nintendo profile. <b>Then come back to this tab.</b><br><a href="https://accounts.nintendo.com/login" target="_blank" class="btn-link btn-step1">👤 Step 1: Login at Nintendo.com First</a><br><b>Step 2 (Get the red button link):</b> Now that you are signed in from Step 1, tap the blue button below. It will take you straight to the <i>"Link an account"</i> screen without asking for an email code. Long-press (or right-click) the red <b>"Select this account"</b> button -> <b>"Copy link address"</b>.<br><a href="${nintendoUrl}" target="_blank" class="btn-link btn-primary">🔗 Step 2: Open Red Button Page "Select this account"</a>',
    paste: 'Step 3: Paste the copied red button link here (npf045ab...)',
    saveTok: '💾 Save Token to My Device',
    dcbin: '📂 Optional: Add dc.bin file (Play simultaneously without disconnects)',
    readyMsg: '✅ Local Token ready on this device',
    hint: 'Once Online, the Host accepts friend requests for you using a single fixed IP. You can close this window or turn off your internet.',
    online: '🟢 GO ONLINE (Start Auto-Accept)',
    offline: '🔴 GO OFFLINE (Wipe from Server RAM)',
    unlink: '🔓 Unlink Token (Delete from this device)',
    unlinkAlert: '✅ Your token file has been deleted from your device and wiped from server RAM.\\n\\n🔐 For complete peace of mind, we recommend updating your password at accounts.nintendo.com.'
  }
};

function setLang(lang) {
  currentLang = lang;
  document.getElementById('btn-es').classList.toggle('active', lang === 'es');
  document.getElementById('btn-en').classList.toggle('active', lang === 'en');
  const t = I18N[lang];
  document.getElementById('title').innerHTML = t.title;
  document.getElementById('privacy-note').innerHTML = t.privacy;
  document.getElementById('lbl-discord').innerText = t.discord;
  document.getElementById('lbl-fc').innerText = t.fc;
  document.getElementById('setup-steps').innerHTML = t.steps;
  document.getElementById('lbl-paste').innerText = t.paste;
  document.getElementById('btn-save-tok').innerText = t.saveTok;
  document.getElementById('lbl-dcbin').innerText = t.dcbin;
  document.getElementById('tok-ready-msg').innerText = t.readyMsg;
  document.getElementById('offline-hint').innerText = t.hint;
  document.getElementById('btn-go-online').innerText = t.online;
  document.getElementById('btn-go-offline').innerText = t.offline;
  document.getElementById('btn-unlink').innerText = t.unlink;
}

function showMsg(msg, ok = true) {
  const b = document.getElementById('statusBox');
  b.style.display = 'block';
  b.style.background = ok ? 'rgba(16,185,129,0.2)' : 'rgba(239,68,68,0.2)';
  b.style.color = ok ? '#34d399' : '#f87171';
  b.innerText = msg;
}

function refreshUI() {
  const saved = JSON.parse(localStorage.getItem('zenith_local_vault') || '{}');
  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get('uid') && !saved.discordId) saved.discordId = urlParams.get('uid');
  if (urlParams.get('lang')) setLang(urlParams.get('lang'));

  if (saved.discordId) document.getElementById('discordId').value = saved.discordId;
  if (saved.friendCode) document.getElementById('friendCode').value = saved.friendCode;
  if (saved.dcBinB64) document.getElementById('dcbin-status').innerText = '✅ dc.bin guardado localmente (80 bytes)';

  const hasToken = Boolean(saved.sessionToken);
  document.getElementById('setup-section').style.display = hasToken ? 'none' : 'block';
  document.getElementById('ready-section').style.display = hasToken ? 'block' : 'none';
}

function saveDcBin(ev) {
  const f = ev.target.files[0];
  if (!f) return;
  const r = new FileReader();
  r.onload = () => {
    const u8 = new Uint8Array(r.result);
    let bin = '';
    for (let i = 0; i < u8.byteLength; i++) bin += String.fromCharCode(u8[i]);
    const saved = JSON.parse(localStorage.getItem('zenith_local_vault') || '{}');
    saved.dcBinB64 = btoa(bin);
    localStorage.setItem('zenith_local_vault', JSON.stringify(saved));
    document.getElementById('dcbin-status').innerText = '✅ dc.bin guardado en este dispositivo (' + u8.byteLength + ' B)';
  };
  r.readAsArrayBuffer(f);
}

async function generateLocalToken() {
  const discordId = document.getElementById('discordId').value.trim();
  const friendCode = document.getElementById('friendCode').value.replace(/\\D/g, '');
  const copied = document.getElementById('copiedLink').value.trim();
  if (!discordId || friendCode.length !== 16) return showMsg('Ingresa tu Discord ID y tu Friend Code de 16 dígitos.', false);

  const m = copied.match(/session_token_code=([^&\\s]+)/);
  if (!m) return showMsg('El link pegado no contiene session_token_code=', false);

  const stMatch = copied.match(/state=([^&\\s]+)/);
  const res = await fetch('/api/exchange-token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ discordId, state: stMatch ? stMatch[1] : SERVER_STATE, code: m[1] })
  });
  const data = await res.json();
  if (!data.sessionToken) return showMsg(data.error || 'Error al canjear token', false);

  const saved = JSON.parse(localStorage.getItem('zenith_local_vault') || '{}');
  saved.discordId = discordId;
  saved.friendCode = friendCode;
  saved.sessionToken = data.sessionToken;
  localStorage.setItem('zenith_local_vault', JSON.stringify(saved));
  refreshUI();
  showMsg('✅ Token guardado localmente en tu dispositivo. Ya puedes tocar PONERSE ONLINE.');
}

async function goOnline() {
  const saved = JSON.parse(localStorage.getItem('zenith_local_vault') || '{}');
  saved.discordId = document.getElementById('discordId').value.trim();
  saved.friendCode = document.getElementById('friendCode').value.replace(/\\D/g, '');
  localStorage.setItem('zenith_local_vault', JSON.stringify(saved));

  if (!saved.discordId || saved.friendCode.length !== 16 || !saved.sessionToken) {
    return showMsg('Falta tu ID, Friend Code o Token local.', false);
  }
  const res = await fetch('/api/online', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(saved)
  });
  const d = await res.json();
  if (d.ok) showMsg('🟢 ¡ESTÁS ONLINE! El Host ya acepta tus solicitudes con IP fija. Puedes cerrar el navegador.');
  else showMsg(d.error || 'Error', false);
}

async function goOffline() {
  const saved = JSON.parse(localStorage.getItem('zenith_local_vault') || '{}');
  await fetch('/api/offline', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ discordId: saved.discordId })
  });
  showMsg('🔴 OFFLINE: Tu token fue eliminado de la memoria RAM del servidor.');
}

async function unlinkToken() {
  const saved = JSON.parse(localStorage.getItem('zenith_local_vault') || '{}');
  if (saved.discordId) {
    await fetch('/api/offline', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ discordId: saved.discordId })
    });
  }
  localStorage.removeItem('zenith_local_vault');
  alert(I18N[currentLang].unlinkAlert);
  window.location.reload();
}

window.onload = refreshUI;
</script>
</body>
</html>`;
}

function readJsonBody(req) {
    return new Promise((resolve) => {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try { resolve(JSON.parse(body || '{}')); } catch { resolve({}); }
        });
    });
}

const server = http.createServer(async (req, res) => {
    const urlObj = new URL(req.url, `http://${req.headers.host}`);

    if (urlObj.pathname === '/online' || urlObj.pathname === '/trainer' || urlObj.pathname === '/elite') {
        const codes = Array.from(activeSessions.values()).map(s => s.friendCode);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(codes));
    }

    if (urlObj.pathname === '/vault' || urlObj.pathname === '/') {
        const uid = urlObj.searchParams.get('uid') || '';
        const auth = createNintendoAuthForUser(uid);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(renderVaultHtml(uid, auth.state, auth.url));
    }

    if (urlObj.pathname === '/api/exchange-token' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const entry = oauthByState.get(body.state) || oauthByUser.get(String(body.discordId || ''));
        if (!entry) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'Sesión expirada. Recarga la Bóveda (F5) e intenta de nuevo.' }));
        }
        try {
            const sessionToken = await exchangeCodeWithNintendo(body.code, entry.verifier);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ sessionToken }));
        } catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: err.message }));
        }
    }

    if (urlObj.pathname === '/api/online' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const cleanFc = String(body.friendCode || '').replace(/\D/g, '');
        if (!body.discordId || cleanFc.length !== 16 || !body.sessionToken) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'Datos incompletos' }));
        }
        activeSessions.set(String(body.discordId).trim(), {
            friendCode: cleanFc,
            sessionToken: body.sessionToken,
            dcBinB64: body.dcBinB64 || '',
            acceptedCount: 0
        });
        syncHostWorkers();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true }));
    }

    if (urlObj.pathname === '/api/offline' && req.method === 'POST') {
        const body = await readJsonBody(req);
        activeSessions.delete(String(body.discordId || '').trim());
        syncHostWorkers();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true }));
    }

    res.writeHead(404);
    res.end('Not Found');
});

const wss = new WebSocket.Server({ server });
wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
        try {
            const msg = JSON.parse(raw.toString());
            if (msg.type === 'REGISTER_HOST') {
                hostSocket = ws;
                syncHostWorkers();
            } else if (msg.type === 'ACCEPTED_REPORT') {
                const s = activeSessions.get(String(msg.discordId));
                if (s) s.acceptedCount = (s.acceptedCount || 0) + Number(msg.count || 0);
            }
        } catch (e) {}
    });
});

const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

function buildMainPanelEmbed() {
    const lines = [];
    for (const [id, s] of activeSessions.entries()) {
        const fmt = s.friendCode.replace(/(\d{4})(\d{4})(\d{4})(\d{4})/, '$1-$2-$3-$4');
        lines.push(`🟢 <@${id}> — \`${fmt}\` *(Aceptadas: ${s.acceptedCount || 0})*`);
    }
    return new EmbedBuilder()
        .setTitle('⚡ Sistema de Auto-Accept — Zenith Rise')
        .setDescription(
            '**🇪🇸 Selecciona tu idioma abajo para ver la guía paso a paso y abrir tu Bóveda Local.**\n' +
            '**🇺🇸 Select your language below to view the step-by-step guide and open your Local Vault.**\n\n' +
            '**Usuarios Online / Active Collectors:**\n' +
            (lines.length ? lines.join('\n') : '*Nadie online en este momento / No active collectors.*')
        )
        .setColor(0x10b981)
        .setFooter({ text: `Online en RAM: ${lines.length} | 100% Local Device Storage` });
}

function buildMainPanelButtons() {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('guide_es').setLabel('🇪🇸 Guía y Bóveda (Español)').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('guide_en').setLabel('🇺🇸 Guide & Vault (English)').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('quick_offline').setLabel('🔴 Salir a Offline / Unlink').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('refresh_panel').setLabel('🔄 Actualizar').setStyle(ButtonStyle.Secondary)
    );
}

client.on('messageCreate', async (msg) => {
    if (msg.content === '!panel_main') {
        await msg.channel.send({ embeds: [buildMainPanelEmbed()], components: [buildMainPanelButtons()] });
    }
});

client.on('interactionCreate', async (interaction) => {
    if (!interaction.isButton()) return;
    const uid = interaction.user.id;

    if (interaction.customId === 'refresh_panel') {
        return interaction.update({ embeds: [buildMainPanelEmbed()], components: [buildMainPanelButtons()] });
    }

    if (interaction.customId === 'quick_offline') {
        activeSessions.delete(uid);
        syncHostWorkers();
        await interaction.update({ embeds: [buildMainPanelEmbed()], components: [buildMainPanelButtons()] });
        return interaction.followUp({
            content: '🔴 **Offline / RAM Purgada:** Tu sesión activa ha sido borrada de la memoria del servidor inmediatamente.',
            ephemeral: true
        });
    }

    if (interaction.customId === 'guide_es') {
        const vaultUrl = `${PUBLIC_URL}/vault?uid=${uid}&lang=es`;
        const embedEs = new EmbedBuilder()
            .setTitle('🇪🇸 Guía Paso a Paso — Cómo funciona nuestro Auto-Accept')
            .setColor(0x10b981)
            .setDescription(
                '### 🛡️ Privacidad y Seguridad\n' +
                '* **Datos 100% locales:** Nosotros **NUNCA** nos quedamos con tus datos de inicio de sesión. Tu token se guarda **únicamente en la memoria local de tu dispositivo**.\n' +
                '* **1 Única IP Fija + Sin gastar internet:** Al ponerte **Online**, el Host acepta tus solicitudes con una única IP fija. Puedes cerrar el navegador o desconectarte de internet.\n' +
                '* **Borrado en Offline y Desvinculación:** Al dar **Offline**, el token se borra de la RAM del servidor. También puedes usar **Desvincular Token** para borrar el archivo local de tu dispositivo.\n\n' +
                '### 📋 Pasos para crear tu Token sin error de verificación:\n' +
                '1. Abre tu **Bóveda Local** en el botón de abajo.\n' +
                '2. **Paso 1:** Toca el botón morado (**"Iniciar Sesión en Nintendo.com primero"**) e inicia sesión ahí con el código de tu correo hasta ver tu perfil.\n' +
                '3. **Paso 2:** Regresa a la Bóveda y toca el botón azul (**"Ir al Botón Rojo"**). Como ya iniciaste sesión en el Paso 1, te saldrá directo el botón rojo **"Select this account"** sin pedirte correo.\n' +
                '4. Mantén presionado (o haz clic derecho en) el botón rojo **"Select this account"** -> **"Copiar dirección de enlace"**.\n' +
                '5. Pégalo en el Paso 3 de la Bóveda, sube tu `dc.bin` opcional y toca **🟢 PONERSE ONLINE**.'
            );

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setLabel('🔐 Abrir Mi Bóveda Local (Español)')
                .setStyle(ButtonStyle.Link)
                .setURL(vaultUrl)
        );
        return interaction.reply({ embeds: [embedEs], components: [row], ephemeral: true });
    }

    if (interaction.customId === 'guide_en') {
        const vaultUrl = `${PUBLIC_URL}/vault?uid=${uid}&lang=en`;
        const embedEn = new EmbedBuilder()
            .setTitle('🇺🇸 Step-by-Step Guide — How Our Auto-Accept Works')
            .setColor(0x3b82f6)
            .setDescription(
                '### 🛡️ Privacy & Security\n' +
                '* **100% Local Storage:** We **NEVER** keep your login credentials. Your token is stored **exclusively in your device\'s local storage**.\n' +
                '* **Single Fixed IP + No Internet Needed:** Once **Online**, our Host accepts friend requests using a single fixed IP. You can close the browser or turn off your internet.\n' +
                '* **RAM Wipe & Unlink Option:** Going **Offline** wipes your token from server RAM. You can also tap **Unlink Token** anytime to delete the local token from your device.\n\n' +
                '### 📋 Steps to Create Your Token (No Email Error):\n' +
                '1. Open your **Local Vault** using the button below.\n' +
                '2. **Step 1:** Tap the purple button (**"Login at Nintendo.com First"**) and sign in with your email code until you see your profile.\n' +
                '3. **Step 2:** Return to the Vault and tap the blue button (**"Open Red Button Page"**). Since you already signed in during Step 1, the red **"Select this account"** button will appear immediately without asking for an email code.\n' +
                '4. Long-press (or right-click) the red **"Select this account"** button -> **"Copy link address"**.\n' +
                '5. Paste it in Step 3 of the Vault, optionally add your `dc.bin`, and tap **🟢 GO ONLINE**.'
            );

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setLabel('🔐 Open My Local Vault (English)')
                .setStyle(ButtonStyle.Link)
                .setURL(vaultUrl)
        );
        return interaction.reply({ embeds: [embedEn], components: [row], ephemeral: true });
    }
});

server.listen(PORT, () => console.log(`[Zenith Vault] Port ${PORT} (${PUBLIC_URL})`));
client.login(DISCORD_TOKEN);
