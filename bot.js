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

const NINTENDO_CLIENT_ID = '71b963c1b7b6d119';
const NINTENDO_REDIRECT_URI = 'npf71b963c1b7b6d119://auth';

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
    const state = base64UrlClean(crypto.randomBytes(32));

    const record = { verifier, state, createdAt: Date.now() };
    oauthByState.set(state, record);
    if (discordId) oauthByUser.set(String(discordId), record);

    const authorizeUrl =
        `https://accounts.nintendo.com/connect/1.0.0/authorize` +
        `?state=${state}` +
        `&redirect_uri=npf${NINTENDO_CLIENT_ID}://auth` +
        `&client_id=${NINTENDO_CLIENT_ID}` +
        `&scope=openid%20user%20user.birthday%20user.mii%20user.screenName` +
        `&response_type=session_token_code` +
        `&session_token_code_challenge=${challenge}` +
        `&session_token_code_challenge_method=S256` +
        `&theme=login_form`;

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
  .badge { background: rgba(16,185,129,0.15); color: #34d399; padding: 11px 12px; border-radius: 10px; font-size: 0.84rem; line-height: 1.45; margin-bottom: 14px; border: 1px solid rgba(16,185,129,0.3); }
  label { display: block; font-size: 0.85rem; color: var(--muted); margin: 12px 0 4px; font-weight: 600; }
  input[type="text"], input[type="file"] { width: 100%; box-sizing: border-box; padding: 11px; border-radius: 8px; border: 1px solid #334155; background: #0f172a; color: var(--text); font-size: 0.92rem; }
  .btn, a.btn-link { display: block; text-align: center; text-decoration: none; width: 100%; box-sizing: border-box; padding: 12px; border-radius: 10px; border: none; font-weight: 700; font-size: 0.95rem; cursor: pointer; margin-top: 10px; }
  .btn-step1 { background: #6366f1; color: white; }
  .btn-primary { background: #3b82f6; color: white; }
  .btn-online { background: var(--accent); color: #052e16; }
  .btn-offline { background: #f59e0b; color: #1e293b; }
  .btn-unlink { background: transparent; border: 1px solid var(--danger); color: #f87171; margin-top: 16px; }
  .step-box { background: #0f172a; padding: 14px; border-radius: 10px; margin-top: 12px; border: 1px solid #334155; font-size: 0.88rem; line-height: 1.5; }
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
    🔒 <b>Privacidad Total:</b> Tus datos de sesión se guardan <b>únicamente en la memoria local de tu dispositivo</b>. Al ponerte Offline, se borran al instante.
  </div>

  <label id="lbl-discord">1. Tu ID de Usuario de Discord</label>
  <input type="text" id="discordId" value="${uid}" placeholder="Ej: 123456789012345678">

  <label id="lbl-fc">2. Tu Código de Amigo de 16 dígitos</label>
  <input type="text" id="friendCode" placeholder="Ej: 9370-0010-9308-6237">

  <div id="setup-section" class="step-box">
    <div id="setup-steps">
      <b>Configuración (Android, iOS y PC):</b><br><br>
      <b>Paso 1:</b> Inicia sesión en Nintendo.<br>
      <a href="https://accounts.nintendo.com/login" target="_blank" class="btn-link btn-step1">👤 Paso 1: Iniciar Sesión en Nintendo.com</a><br>
      <b>Paso 2:</b> Mantén presionado (o haz clic derecho) en el botón rojo <b>"Select this account"</b> y elige <b>"Copiar dirección de enlace"</b>.<br>
      <a href="${nintendoUrl}" target="_blank" class="btn-link btn-primary">🔗 Paso 2: Abrir Ventana Nintendo</a>
    </div>

    <label id="lbl-paste">Paso 3: Pega aquí el enlace copiado del botón rojo</label>
    <input type="text" id="copiedLink" placeholder="npf71b963c1b7b6d119://auth#session_token_code=...">
    <button class="btn btn-online" onclick="generateLocalToken()" id="btn-save-tok">💾 Guardar Token Localmente</button>
  </div>

  <div class="step-box">
    <label id="lbl-dcbin" style="margin-top:0">📂 Opcional: Añadir archivo dc.bin de tu cuenta principal</label>
    <input type="file" id="dcBinFile" accept=".bin" onchange="saveDcBin(event)">
    <small id="dcbin-status" style="color:var(--muted)"></small>
  </div>

  <div id="ready-section" class="step-box" style="display:none; border-color: var(--accent);">
    <div id="tok-ready-msg" style="color:#34d399; font-weight:700; margin-bottom:6px;">
      ✅ Token y sesión listos en tu dispositivo
    </div>
    <button class="btn btn-online" onclick="goOnline()" id="btn-go-online">🟢 PONERSE ONLINE (Activar Auto-Accept)</button>
    <button class="btn btn-offline" onclick="goOffline()" id="btn-go-offline">🔴 SALIR A OFFLINE (Borrar de RAM)</button>
    <button class="btn btn-unlink" onclick="unlinkToken()" id="btn-unlink">🔓 Desvincular y Borrar Token</button>
  </div>

  <div id="statusBox" class="status"></div>
</div>

<script>
const SERVER_STATE = "${oauthState}";
let currentLang = 'es';

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

  if (saved.discordId) document.getElementById('discordId').value = saved.discordId;
  if (saved.friendCode) document.getElementById('friendCode').value = saved.friendCode;
  if (saved.dcBinB64) document.getElementById('dcbin-status').innerText = '✅ dc.bin guardado localmente';

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
    document.getElementById('dcbin-status').innerText = '✅ dc.bin guardado (' + u8.byteLength + ' B)';
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
  if (!data.sessionToken) return showMsg(data.error || 'Error al canjear token.', false);

  const saved = JSON.parse(localStorage.getItem('zenith_local_vault') || '{}');
  saved.discordId = discordId;
  saved.friendCode = friendCode;
  saved.sessionToken = data.sessionToken;
  localStorage.setItem('zenith_local_vault', JSON.stringify(saved));
  refreshUI();
  showMsg('✅ Token guardado localmente.');
}

async function goOnline() {
  const saved = JSON.parse(localStorage.getItem('zenith_local_vault') || '{}');
  saved.discordId = document.getElementById('discordId').value.trim();
  saved.friendCode = document.getElementById('friendCode').value.replace(/\\D/g, '');
  localStorage.setItem('zenith_local_vault', JSON.stringify(saved));

  const res = await fetch('/api/online', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(saved)
  });
  const d = await res.json();
  if (d.ok) showMsg('🟢 ¡ESTÁS ONLINE! El Host ya acepta tus solicitudes.');
  else showMsg(d.error || 'Error', false);
}

async function goOffline() {
  const saved = JSON.parse(localStorage.getItem('zenith_local_vault') || '{}');
  await fetch('/api/offline', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ discordId: saved.discordId })
  });
  showMsg('🔴 OFFLINE: Sesión eliminada de RAM.');
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
            return res.end(JSON.stringify({ error: 'Sesión expirada. Recarga la Bóveda (F5).' }));
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
        .setDescription('**Usuarios Online:**\n' + (lines.length ? lines.join('\n') : '*Nadie online.*'))
        .setColor(0x10b981);
}

function buildMainPanelButtons() {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('guide_es').setLabel('🇪🇸 Español (Bóveda)').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('quick_offline').setLabel('🔴 Salir a Offline').setStyle(ButtonStyle.Danger),
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
        return interaction.followUp({ content: '🔴 **Offline:** Sesión borrada de RAM.', ephemeral: true });
    }

    if (interaction.customId === 'guide_es') {
        const vaultUrl = `${PUBLIC_URL}/vault?uid=${uid}&lang=es`;
        const embedEs = new EmbedBuilder()
            .setTitle('🇪🇸 Bóveda Local')
            .setColor(0x10b981)
            .setDescription('Toca el botón para abrir tu Bóveda y conectar tu cuenta.');
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setLabel('🔐 Abrir Mi Bóveda Local').setStyle(ButtonStyle.Link).setURL(vaultUrl)
        );
        return interaction.reply({ embeds: [embedEs], components: [row], ephemeral: true });
    }
});

server.listen(PORT, () => console.log(`[Zenith Vault] Port ${PORT}`));
client.login(DISCORD_TOKEN);
