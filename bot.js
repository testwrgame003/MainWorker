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

// Sesiones en RAM (se borran en cuanto el usuario pasa a Offline)
const activeSessions = new Map();
// Verificadores PKCE temporales en memoria
const oauthVerifiers = new Map();
let hostSocket = null;

// Generador de cadenas alfanuméricas limpias (exactamente como exige Nintendo Auth)
function randomAlphaNum(len) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const bytes = crypto.randomBytes(len);
    let out = '';
    for (let i = 0; i < len; i++) {
        out += chars[bytes[i] % chars.length];
    }
    return out;
}

function createNintendoAuthSession() {
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const state = crypto.randomBytes(32).toString('base64url');

    oauthVerifiers.set(state, { verifier, createdAt: Date.now() });

    // Parámetros exactos que no disparan bloqueo tras verificar el código de correo en Android
    const authorizeUrl =
        `https://accounts.nintendo.com/connect/1.0.0/authorize` +
        `?state=${state}` +
        `&redirect_uri=npf${NINTENDO_CLIENT_ID}%3A%2F%2Fauth` +
        `&client_id=${NINTENDO_CLIENT_ID}` +
        `&scope=openid+user+user.birthday+user.mii+user.screenName` +
        `&response_type=session_token_code` +
        `&session_token_code_challenge=${challenge}` +
        `&session_token_code_challenge_method=S256` +
        `&theme=login_form`;

    return { state, url: authorizeUrl };
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

// Renderiza la página con el link de Nintendo YA GENERADO directamente en el HTML (como el Paso 5 de la guía)
function renderVaultHtml(oauthState, nintendoUrl) {
    return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Zenith Local Vault — Auto-Accept</title>
<style>
  :root { --bg: #0f172a; --card: #1e293b; --accent: #10b981; --danger: #ef4444; --text: #f8fafc; --muted: #94a3b8; }
  body { font-family: system-ui, -apple-system, sans-serif; background: var(--bg); color: var(--text); margin: 0; padding: 16px; display: flex; justify-content: center; }
  .container { max-width: 480px; width: 100%; background: var(--card); border-radius: 16px; padding: 22px; box-shadow: 0 10px 30px rgba(0,0,0,0.45); }
  h2 { margin-top: 0; font-size: 1.3rem; }
  .lang-bar { display: flex; gap: 8px; margin-bottom: 16px; }
  .lang-btn { flex: 1; padding: 8px; border-radius: 8px; border: 1px solid #334155; background: #0f172a; color: var(--text); cursor: pointer; font-weight: 600; }
  .lang-btn.active { border-color: var(--accent); background: rgba(16, 185, 129, 0.15); }
  .badge { background: rgba(16,185,129,0.15); color: #34d399; padding: 10px 12px; border-radius: 10px; font-size: 0.85rem; line-height: 1.4; margin-bottom: 14px; border: 1px solid rgba(16,185,129,0.3); }
  .warn-box { background: rgba(239,68,68,0.15); color: #fca5a5; padding: 10px 12px; border-radius: 10px; font-size: 0.83rem; line-height: 1.4; margin-bottom: 14px; border: 1px solid rgba(239,68,68,0.35); }
  label { display: block; font-size: 0.85rem; color: var(--muted); margin: 12px 0 4px; font-weight: 600; }
  input[type="text"], input[type="file"] { width: 100%; box-sizing: border-box; padding: 11px; border-radius: 8px; border: 1px solid #334155; background: #0f172a; color: var(--text); font-size: 0.95rem; }
  .btn, a.btn-link { display: block; text-align: center; text-decoration: none; width: 100%; box-sizing: border-box; padding: 12px; border-radius: 10px; border: none; font-weight: 700; font-size: 0.95rem; cursor: pointer; margin-top: 12px; }
  .btn-primary { background: #3b82f6; color: white; }
  .btn-online { background: var(--accent); color: #052e16; }
  .btn-offline { background: #f59e0b; color: #1e293b; }
  .btn-unlink { background: transparent; border: 1px solid var(--danger); color: #f87171; margin-top: 18px; }
  .step-box { background: #0f172a; padding: 12px; border-radius: 10px; margin-top: 12px; border: 1px solid #334155; font-size: 0.88rem; line-height: 1.45; }
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
    🔒 <b>Privacidad Garantizada:</b> Tu correo y contraseña jamás pasan por nosotros. El archivo de token se guarda <b>únicamente en la memoria local de este dispositivo</b>. Al ponerte Offline, se borra de la RAM del sistema.
  </div>

  <label id="lbl-discord">1. Tu ID de Usuario de Discord</label>
  <input type="text" id="discordId" placeholder="Ej: 123456789012345678">

  <label id="lbl-fc">2. Tu Código de Amigo (16 dígitos)</label>
  <input type="text" id="friendCode" placeholder="Ej: 9370-0010-9308-6237">

  <div id="setup-section" class="step-box">
    <div class="warn-box" id="warn-note">
      ⚠️ <b>ATENCIÓN:</b> Cuando toques el botón azul para ir a Nintendo, <b>NO CIERRES NI RECARGUES ESTA PÁGINA</b> hasta pegar el enlace copiado en el Paso 3.
    </div>
    <div id="setup-steps">
      <b>Configuración de 1 sola vez:</b><br>
      <b>Paso 1:</b> Toca el botón azul de abajo para abrir Nintendo en otra pestaña.<br>
      <b>Paso 2:</b> Inicia sesión. En la ventana <i>"Link an account"</i>, <b>NO hagas clic izquierdo en el botón rojo</b>. Haz clic derecho (o mantén presionado en el celular) sobre el botón rojo <b>"Select this account"</b> y elige <b>"Copiar dirección de enlace"</b>.<br>
      <b>Paso 3:</b> Regresa a esta pestaña, pega el enlace abajo y guarda tu Token.
    </div>

    <!-- Hipervínculo directo idéntico al Paso 5 de la guía -->
   <!-- Aviso automático para Android si abrieron desde adentro de Discord -->
    <div id="android-chrome-box" style="display:none; margin-bottom:12px;">
      <a id="btn-force-chrome" href="#" class="btn-link" style="background:#f59e0b; color:#0f172a;">
        📲 Estás en Android: Toca aquí primero para abrir en Chrome (Evita error al verificar correo)
      </a>
    </div>

    <a href="${nintendoUrl}" target="_blank" class="btn-link btn-primary" id="btn-open-nin">
      🔗 Paso 1: Click aquí para iniciar sesión en Nintendo
    </a>
      🔗 Paso 1: Click aquí para iniciar sesión en Nintendo
    </a>
    <label id="lbl-paste">Paso 3: Pega aquí el enlace copiado (npf045ab...)</label>
    <input type="text" id="copiedLink" placeholder="npf045ab1d9068381b3://auth#session_token_code=...">
    <button class="btn btn-online" onclick="generateLocalToken()" id="btn-save-tok">💾 Guardar Token en mi Dispositivo</button>
  </div>

  <div class="step-box">
    <label id="lbl-dcbin" style="margin-top:0">📂 Opcional: Añadir archivo dc.bin (Para jugar a la vez)</label>
    <input type="file" id="dcBinFile" accept=".bin" onchange="saveDcBin(event)">
    <small id="dcbin-status" style="color:var(--muted)"></small>
  </div>

  <div id="ready-section" class="step-box" style="display:none; border-color: var(--accent);">
    <div id="tok-ready-msg" style="color:#34d399; font-weight:700; margin-bottom:8px;">
      ✅ Token local detectado en tu dispositivo
    </div>
    <small id="offline-hint" style="color:var(--muted); display:block; margin-bottom:8px;">
      Al ponerte Online, el Host aceptará solicitudes por ti con una IP única fija. Puedes cerrar esta página o apagar tu internet.
    </small>
    <button class="btn btn-online" onclick="goOnline()" id="btn-go-online">🟢 PONERSE ONLINE (Activar Auto-Accept)</button>
    <button class="btn btn-offline" onclick="goOffline()" id="btn-go-offline">🔴 SALIR A OFFLINE (Borrar de RAM)</button>
    <button class="btn btn-unlink" onclick="unlinkToken()" id="btn-unlink">🔓 Desvincular y Borrar Token de mi Dispositivo</button>
  </div>

  <div id="statusBox" class="status"></div>
</div>

<script>
const SERVER_OAUTH_STATE = "${oauthState}";
let currentLang = 'es';

const I18N = {
  es: {
    title: '🛡️ Bóveda Local de Auto-Accept',
    privacy: '🔒 <b>Privacidad Garantizada:</b> Tu correo y contraseña jamás pasan por nosotros. El archivo de token se guarda <b>únicamente en la memoria local de este dispositivo</b>. Al ponerte Offline, se borra de la RAM del sistema.',
    warn: '⚠️ <b>ATENCIÓN:</b> Cuando toques el botón azul para ir a Nintendo, <b>NO CIERRES NI RECARGUES ESTA PÁGINA</b> hasta pegar el enlace copiado en el Paso 3.',
    discord: '1. Tu ID de Usuario de Discord',
    fc: '2. Tu Código de Amigo (16 dígitos)',
    steps: '<b>Configuración de 1 sola vez:</b><br><b>Paso 1:</b> Toca el botón azul de abajo para abrir Nintendo en otra pestaña.<br><b>Paso 2:</b> Inicia sesión. En <i>"Link an account"</i>, <b>NO toques el botón rojo</b>. Mantén presionado (o clic derecho) sobre el botón rojo <b>"Select this account"</b> y elige <b>"Copiar dirección de enlace"</b>.<br><b>Paso 3:</b> Regresa a esta pestaña, pega el enlace abajo y guarda tu Token.',
    openNin: '🔗 Paso 1: Click aquí para iniciar sesión en Nintendo',
    paste: 'Paso 3: Pega aquí el enlace copiado (npf045ab...)',
    saveTok: '💾 Guardar Token en mi Dispositivo',
    dcbin: '📂 Opcional: Añadir archivo dc.bin (Para jugar a la vez)',
    readyMsg: '✅ Token guardado localmente en este dispositivo',
    hint: 'Al ponerte Online, el Host aceptará tus solicitudes con 1 única IP fija. Ya puedes cerrar el navegador o desconectarte de internet.',
    online: '🟢 PONERSE ONLINE (Activar Auto-Accept)',
    offline: '🔴 SALIR A OFFLINE (Borrar de RAM)',
    unlink: '🔓 Desvincular Token (Borrar de este dispositivo)',
    unlinkAlert: '✅ El archivo de token ha sido eliminado de tu dispositivo y de la memoria del servidor.\\n\\n🔐 Para tu total tranquilidad, te sugerimos actualizar tu contraseña en accounts.nintendo.com.'
  },
  en: {
    title: '🛡️ Local Auto-Accept Vault',
    privacy: '🔒 <b>Guaranteed Privacy:</b> Your email and password are never seen by us. Your token is stored <b>exclusively in this device\\'s local storage</b>. When you go Offline, it is wiped from server RAM immediately.',
    warn: '⚠️ <b>ATTENTION:</b> When you click the blue link in Step 1, <b>DO NOT CLOSE AND DO NOT REFRESH THIS PAGE</b> until you paste the copied link in Step 3.',
    discord: '1. Your Discord User ID',
    fc: '2. Your 16-digit Friend Code',
    steps: '<b>One-time setup:</b><br><b>Step 1:</b> Tap the blue button below to open Nintendo in a new tab.<br><b>Step 2:</b> Sign in. On the <i>"Link an account"</i> page, <b>DO NOT tap the red button</b>. Long-press (or right-click) the red <b>"Select this account"</b> button and select <b>"Copy link address"</b>.<br><b>Step 3:</b> Return to this tab, paste the link below, and save your Token.',
    openNin: '🔗 Step 1: Click here to login to Nintendo',
    paste: 'Step 3: Paste the copied link code here (npf045ab...)',
    saveTok: '💾 Save Token to My Device',
    dcbin: '📂 Optional: Add dc.bin file (Play simultaneously)',
    readyMsg: '✅ Local Token detected on your device',
    hint: 'Once Online, the Host accepts friend requests for you using a single dedicated IP. You can close this page or turn off your internet.',
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
  document.getElementById('warn-note').innerHTML = t.warn;
  document.getElementById('lbl-discord').innerText = t.discord;
  document.getElementById('lbl-fc').innerText = t.fc;
  document.getElementById('setup-steps').innerHTML = t.steps;
  document.getElementById('btn-open-nin').innerText = t.openNin;
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
  const file = ev.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const bytes = new Uint8Array(reader.result);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
    const b64 = btoa(binary);
    const saved = JSON.parse(localStorage.getItem('zenith_local_vault') || '{}');
    saved.dcBinB64 = b64;
    localStorage.setItem('zenith_local_vault', JSON.stringify(saved));
    document.getElementById('dcbin-status').innerText = '✅ dc.bin cargado en tu dispositivo (' + bytes.byteLength + ' B)';
  };
  reader.readAsArrayBuffer(file);
}

async function generateLocalToken() {
  const discordId = document.getElementById('discordId').value.trim();
  const friendCode = document.getElementById('friendCode').value.replace(/\\D/g, '');
  const copied = document.getElementById('copiedLink').value.trim();
  if (!discordId || friendCode.length !== 16) return showMsg('Ingresa tu Discord ID y tu Friend Code de 16 dígitos.', false);

  const m = copied.match(/session_token_code=([^&\\s]+)/);
  if (!m) return showMsg('El enlace pegado no contiene session_token_code=', false);

  // Si el enlace copiado incluye el state de Nintendo, lo usamos directamente para que nunca falle
  const stateMatch = copied.match(/state=([^&\\s]+)/);
  const stateToUse = stateMatch ? stateMatch[1] : SERVER_OAUTH_STATE;

  const res = await fetch('/api/exchange-token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ state: stateToUse, code: m[1] })
  });
  const data = await res.json();
  if (!data.sessionToken) return showMsg(data.error || 'Error al canjear token. Recarga la página con F5 e intenta de nuevo.', false);

  const saved = JSON.parse(localStorage.getItem('zenith_local_vault') || '{}');
  saved.discordId = discordId;
  saved.friendCode = friendCode;
  saved.sessionToken = data.sessionToken;
  localStorage.setItem('zenith_local_vault', JSON.stringify(saved));
  refreshUI();
  showMsg('✅ Token guardado únicamente en tu dispositivo. Ya puedes ponerte Online.');
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
  const data = await res.json();
  if (data.ok) {
    showMsg('🟢 ¡ESTÁS ONLINE! El Host ya está aceptando tus solicitudes. Puedes cerrar esta ventana.');
  } else {
    showMsg(data.error || 'Error', false);
  }
}

async function goOffline() {
  const saved = JSON.parse(localStorage.getItem('zenith_local_vault') || '{}');
  await fetch('/api/offline', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ discordId: saved.discordId })
  });
  showMsg('🔴 Has salido a OFFLINE. Tu token fue borrado de la memoria RAM del servidor.');
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
  window.location.reload();
  alert(I18N[currentLang].unlinkAlert);
}
// Si es Android, ofrece saltar directo a Chrome para que al ir a Gmail por el código no se pierda la sesión
if (/Android/i.test(navigator.userAgent)) {
  const cleanHostPath = window.location.host + window.location.pathname + window.location.search;
  const chromeIntent = 'intent://' + cleanHostPath + '#Intent;scheme=https;package=com.android.chrome;end';
  const box = document.getElementById('android-chrome-box');
  const btn = document.getElementById('btn-force-chrome');
  if (box && btn) {
    box.style.display = 'block';
    btn.href = chromeIntent;
  }
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
        const auth = createNintendoAuthSession();
        // Guardamos también la URL exacta asociada a ese state
        const saved = oauthVerifiers.get(auth.state);
        if (saved) saved.url = auth.url;

        res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate'
        });
        return res.end(renderVaultHtml(auth.state, auth.url));
    }

    // Ruta puente para evitar que Android (Samsung / Xiaomi) corrompa los parámetros OAuth
    if (urlObj.pathname === '/go-nintendo') {
        const state = urlObj.searchParams.get('state') || '';
        const entry = oauthVerifiers.get(state);
        if (!entry || !entry.url) {
            const fresh = createNintendoAuthSession();
            res.writeHead(302, { 'Location': fresh.url, 'Cache-Control': 'no-store' });
            return res.end();
        }
        res.writeHead(302, {
            'Location': entry.url,
            'Cache-Control': 'no-store, no-cache, must-revalidate',
            'Referrer-Policy': 'no-referrer'
        });
        return res.end();
    }

    if (urlObj.pathname === '/api/exchange-token' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const entry = oauthVerifiers.get(body.state);
        oauthVerifiers.delete(body.state);
        if (!entry) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'Sesión expirada. Presiona F5 para recargar la página y vuelve a abrir el link del Paso 1.' }));
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
            (lines.length ? lines.join('\n') : '*Nadie online en este momento / No active collectors right now.*')
        )
        .setColor(0x10b981)
        .setFooter({ text: `Activos en RAM: ${lines.length} | 100% Local Token Storage` });
}

function buildMainPanelButtons() {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('guide_es').setLabel('🇪🇸 Guía y Acceso (Español)').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('guide_en').setLabel('🇺🇸 Guide & Access (English)').setStyle(ButtonStyle.Primary),
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
        const vaultLink = `${PUBLIC_URL}/vault?uid=${uid}&lang=es`;
        const embedEs = new EmbedBuilder()
            .setTitle('🇪🇸 Guía Paso a Paso — Cómo funciona nuestro Auto-Accept')
            .setColor(0x10b981)
            .setDescription(
                '### 🛡️ ¿Cómo protegemos tu cuenta?\n' +
                '* **Cero almacenamiento en servidor:** Nosotros **NUNCA** vemos tu correo ni tu contraseña, ni guardamos tu token en ninguna base de datos.\n' +
                '* **Guardado 100% en tu dispositivo:** La primera vez que creas tu token, se guarda en la memoria local del navegador de **tu propio teléfono/PC**.\n' +
                '* **Sin gastar datos móviles + 1 Única IP fija:** Una vez que presionas **Ponerse Online**, nuestro Host mantiene tu recepción activa usando **una única IP dedicada para ti**. Puedes apagar la pantalla o desconectarte de internet.\n' +
                '* **Borrado total al dar Offline:** En cuanto presionas **Offline**, tu token desaparece de la memoria RAM del sistema.\n\n' +
                '### 📋 Pasos para la primera vez:\n' +
                '1. Abre tu **Bóveda Local** en el botón de abajo.\n' +
                '2. Toca **"Paso 1: Click aquí para iniciar sesión en Nintendo"** (no cierres la pestaña de la Bóveda).\n' +
                '3. En la pantalla *"Link an account"*, **NO toques el botón rojo**. Mantén presionado el botón rojo **"Select this account"** y selecciona **"Copiar dirección de enlace"**.\n' +
                '4. Regresa a la Bóveda, pega el enlace y toca **"Guardar Token en mi Dispositivo"**.\n' +
                '5. *(Opcional)* Sube tu archivo `dc.bin` si deseas jugar al mismo tiempo sin desconexiones.\n' +
                '6. Toca **🟢 PONERSE ONLINE**.'
            );
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setLabel('🔐 Abrir Mi Bóveda Local (Español)').setStyle(ButtonStyle.Link).setURL(vaultLink)
        );
        return interaction.reply({ embeds: [embedEs], components: [row], ephemeral: true });
    }

    if (interaction.customId === 'guide_en') {
        const vaultLink = `${PUBLIC_URL}/vault?uid=${uid}&lang=en`;
        const embedEn = new EmbedBuilder()
            .setTitle('🇺🇸 Step-by-Step Guide — How Our Auto-Accept Works')
            .setColor(0x3b82f6)
            .setDescription(
                '### 🛡️ How Is Your Account Protected?\n' +
                '* **Zero Server Storage:** We **NEVER** see your email or password, and we never store your token in any database.\n' +
                '* **100% Local Device Storage:** The first time you generate your token, it is saved exclusively inside **your own phone/PC browser storage**.\n' +
                '* **No Internet Required After Going Online + Single Dedicated IP:** Once you tap **Go Online**, our Host handles incoming requests using **a single sticky IP assigned to you**. You can lock your phone or go offline.\n' +
                '* **Instant RAM Wipe on Offline:** As soon as you tap **Offline**, your session is completely erased from system RAM.\n\n' +
                '### 📋 First-Time Setup Steps:\n' +
                '1. Open your **Local Vault** using the button below.\n' +
                '2. Tap **"Step 1: Click here to login to Nintendo"** (keep the Vault tab open).\n' +
                '3. On the *"Link an account"* page, **DO NOT tap the red button**. Long-press (or right-click) the red **"Select this account"** button and choose **"Copy link address"**.\n' +
                '4. Return to the Vault, paste the link, and tap **"Save Token to My Device"**.\n' +
                '5. *(Optional)* Select your `dc.bin` file to play at the same time without disconnects.\n' +
                '6. Tap **🟢 GO ONLINE**.'
            );
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setLabel('🔐 Open My Local Vault (English)').setStyle(ButtonStyle.Link).setURL(vaultLink)
        );
        return interaction.reply({ embeds: [embedEn], components: [row], ephemeral: true });
    }
});

server.listen(PORT, () => console.log(`[Zenith Vault & Bot] Listening on port ${PORT} (${PUBLIC_URL})`));
client.login(DISCORD_TOKEN);
