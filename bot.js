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
    EmbedBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle
} = require('discord.js');
const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const PUBLIC_URL = (process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : (process.env.PUBLIC_URL || `http://localhost:${PORT}`)).replace(/\/$/, '');

const NINTENDO_CLIENT_ID = '045ab1d9068381b3';

// RAM efímera: solo usuarios ONLINE en este momento
const activeSessions = new Map();
// Verificadores PKCE indexados tanto por state como por discordId (para que nunca expire en Android al ir a Gmail)
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

    // SIN theme=login_form (para que use tu sesión ya abierta y NO pida correo otra vez)
    // Y SIN user.mii / user.screenName (que causaban "La solicitud no es válida" en TCG Pocket)
    const authorizeUrl =
        `https://accounts.nintendo.com/connect/1.0.0/authorize` +
        `?client_id=${NINTENDO_CLIENT_ID}` +
        `&redirect_uri=${encodeURIComponent(`npf${NINTENDO_CLIENT_ID}://auth`)}` +
        `&response_type=session_token_code` +
        `&scope=${encodeURIComponent('openid user user.birthday')}` +
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
                'User-Agent': 'NASDKAPI; Android'
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

// Bóveda Web Móvil corregida para Android (sin target="_blank" que rompa la verificación por correo)
function renderVaultHtml(uid, oauthState, nintendoUrl) {
    return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Zenith Local Vault</title>
<style>
  :root { --bg: #0f172a; --card: #1e293b; --accent: #10b981; --danger: #ef4444; --text: #f8fafc; --muted: #94a3b8; }
  body { font-family: system-ui, -apple-system, sans-serif; background: var(--bg); color: var(--text); margin: 0; padding: 16px; display: flex; justify-content: center; }
  .container { max-width: 480px; width: 100%; background: var(--card); border-radius: 16px; padding: 20px; box-shadow: 0 10px 30px rgba(0,0,0,0.45); }
  .badge { background: rgba(16,185,129,0.15); color: #34d399; padding: 10px; border-radius: 10px; font-size: 0.84rem; margin-bottom: 14px; border: 1px solid rgba(16,185,129,0.3); }
  label { display: block; font-size: 0.85rem; color: var(--muted); margin: 10px 0 4px; font-weight: 600; }
  input[type="text"], input[type="file"] { width: 100%; box-sizing: border-box; padding: 11px; border-radius: 8px; border: 1px solid #334155; background: #0f172a; color: var(--text); font-size: 0.95rem; }
  .btn, a.btn-link { display: block; text-align: center; text-decoration: none; width: 100%; box-sizing: border-box; padding: 12px; border-radius: 10px; border: none; font-weight: 700; font-size: 0.95rem; cursor: pointer; margin-top: 12px; }
  .btn-primary { background: #3b82f6; color: white; }
  .btn-online { background: var(--accent); color: #052e16; }
  .btn-offline { background: #f59e0b; color: #1e293b; }
  .btn-unlink { background: transparent; border: 1px solid var(--danger); color: #f87171; margin-top: 16px; }
  .step-box { background: #0f172a; padding: 12px; border-radius: 10px; margin-top: 12px; border: 1px solid #334155; font-size: 0.88rem; }
  .status { margin-top: 14px; padding: 12px; border-radius: 8px; font-weight: 600; text-align: center; display: none; }
</style>
</head>
<body>
<div class="container">
  <h2>🛡️ Bóveda Local / Local Vault</h2>
  <div class="badge">
    🔒 <b>100% Local:</b> Tu token se guarda únicamente en este dispositivo. Al dar Offline se borra de la RAM del servidor.
  </div>

  <label>1. Discord ID</label>
  <input type="text" id="discordId" value="${uid}" placeholder="123456789012345678">

  <label>2. Friend Code (16 dígitos)</label>
  <input type="text" id="friendCode" placeholder="9370-0010-9308-6237">

  <div id="setup-section" class="step-box">
    <b>Paso 1:</b> Abre el enlace de Nintendo, inicia sesión y mantén presionado el botón rojo <b>"Select this account"</b> -> <b>"Copiar dirección de enlace"</b>:<br>
    <a href="${nintendoUrl}" target="_blank" class="btn-link btn-primary">🔗 1. Abrir Nintendo Login</a>

    <label>Paso 2: Pega aquí el enlace del botón rojo (npf045ab...)</label>
    <input type="text" id="copiedLink" placeholder="npf045ab1d9068381b3://auth#session_token_code=...">
    <button class="btn btn-online" onclick="generateLocalToken()">💾 2. Guardar Token en mi Dispositivo</button>
  </div>

  <div class="step-box">
    <label style="margin-top:0">📂 Opcional: Archivo dc.bin (80 bytes)</label>
    <input type="file" accept=".bin" onchange="saveDcBin(event)">
    <small id="dcbin-status" style="color:var(--muted)"></small>
  </div>

  <div id="ready-section" class="step-box" style="display:none; border-color: var(--accent);">
    <div style="color:#34d399; font-weight:700; margin-bottom:8px;">✅ Token Local Listo en tu Dispositivo</div>
    <button class="btn btn-online" onclick="goOnline()">🟢 PONERSE ONLINE (Activar Auto-Accept)</button>
    <button class="btn btn-offline" onclick="goOffline()">🔴 SALIR A OFFLINE (Borrar de RAM)</button>
    <button class="btn btn-unlink" onclick="unlinkToken()">🔓 Desvincular y Borrar Token Local</button>
  </div>

  <div id="statusBox" class="status"></div>
</div>

<script>
const SERVER_STATE = "${oauthState}";
function showMsg(msg, ok = true) {
  const b = document.getElementById('statusBox');
  b.style.display = 'block';
  b.style.background = ok ? 'rgba(16,185,129,0.2)' : 'rgba(239,68,68,0.2)';
  b.style.color = ok ? '#34d399' : '#f87171';
  b.innerText = msg;
}
function refreshUI() {
  const saved = JSON.parse(localStorage.getItem('zenith_local_vault') || '{}');
  if (saved.discordId) document.getElementById('discordId').value = saved.discordId;
  if (saved.friendCode) document.getElementById('friendCode').value = saved.friendCode;
  if (saved.dcBinB64) document.getElementById('dcbin-status').innerText = '✅ dc.bin cargado localmente';
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
    document.getElementById('dcbin-status').innerText = '✅ dc.bin guardado en este dispositivo';
  };
  r.readAsArrayBuffer(f);
}
async function generateLocalToken() {
  const discordId = document.getElementById('discordId').value.trim();
  const friendCode = document.getElementById('friendCode').value.replace(/\\D/g, '');
  const copied = document.getElementById('copiedLink').value.trim();
  if (!discordId || friendCode.length !== 16) return showMsg('Pon tu Discord ID y tu Friend Code de 16 dígitos.', false);
  const m = copied.match(/session_token_code=([^&\\s]+)/);
  if (!m) return showMsg('El link no tiene session_token_code=', false);
  const stMatch = copied.match(/state=([^&\\s]+)/);
  const res = await fetch('/api/exchange-token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ discordId, state: stMatch ? stMatch[1] : SERVER_STATE, code: m[1] })
  });
  const data = await res.json();
  if (!data.sessionToken) return showMsg(data.error || 'Error', false);
  const saved = JSON.parse(localStorage.getItem('zenith_local_vault') || '{}');
  saved.discordId = discordId;
  saved.friendCode = friendCode;
  saved.sessionToken = data.sessionToken;
  localStorage.setItem('zenith_local_vault', JSON.stringify(saved));
  refreshUI();
  showMsg('✅ Token guardado en tu dispositivo.');
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
  if (d.ok) showMsg('🟢 ¡ESTÁS ONLINE! Ya puedes cerrar el navegador.');
  else showMsg(d.error || 'Error', false);
}
async function goOffline() {
  const saved = JSON.parse(localStorage.getItem('zenith_local_vault') || '{}');
  await fetch('/api/offline', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ discordId: saved.discordId })
  });
  showMsg('🔴 OFFLINE: Token eliminado de la RAM del servidor.');
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
  alert('Token eliminado de tu dispositivo. Te sugerimos actualizar tu contraseña en accounts.nintendo.com.');
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
            return res.end(JSON.stringify({ error: 'Sesión expirada. Recarga la página e intenta de nuevo.' }));
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

// ══════════════════════════════════════════════════════════════════════
// Bot de Discord con Modal Directo (Funciona en Android sin abrir el Vault)
// ══════════════════════════════════════════════════════════════════════
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
            '**🇪🇸 Elige tu idioma para ver la guía paso a paso y conectarte desde Android, iPhone o PC.**\n' +
            '**🇺🇸 Select your language to view the step-by-step guide and connect from Android, iPhone, or PC.**\n\n' +
            '**Usuarios Online / Active Collectors:**\n' +
            (lines.length ? lines.join('\n') : '*Nadie online en este momento / No active collectors.*')
        )
        .setColor(0x10b981)
        .setFooter({ text: `Online en RAM: ${lines.length}` });
}

function buildMainPanelButtons() {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('guide_es').setLabel('🇪🇸 Español (Guía y Conexión)').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('guide_en').setLabel('🇺🇸 English (Guide & Connect)').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('quick_offline').setLabel('🔴 Offline / Borrar de RAM').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('refresh_panel').setLabel('🔄 Actualizar').setStyle(ButtonStyle.Secondary)
    );
}

client.on('messageCreate', async (msg) => {
    if (msg.content === '!panel_main') {
        await msg.channel.send({ embeds: [buildMainPanelEmbed()], components: [buildMainPanelButtons()] });
    }
});

client.on('interactionCreate', async (interaction) => {
    const uid = interaction.user.id;

    if (interaction.isButton()) {
        if (interaction.customId === 'refresh_panel') {
            return interaction.update({ embeds: [buildMainPanelEmbed()], components: [buildMainPanelButtons()] });
        }

        if (interaction.customId === 'quick_offline') {
            activeSessions.delete(uid);
            syncHostWorkers();
            await interaction.update({ embeds: [buildMainPanelEmbed()], components: [buildMainPanelButtons()] });
            return interaction.followUp({
                content: '🔴 **Offline:** Tu sesión fue eliminada por completo de la memoria RAM del servidor.',
                ephemeral: true
            });
        }

        if (interaction.customId === 'guide_es' || interaction.customId === 'guide_en') {
            const isEs = interaction.customId === 'guide_es';
            const auth = createNintendoAuthForUser(uid);
            const vaultUrl = `${PUBLIC_URL}/vault?uid=${uid}&lang=${isEs ? 'es' : 'en'}`;

            const embed = new EmbedBuilder()
                .setTitle(isEs ? '🇪🇸 Conexión Directa desde Discord (Especial Android / Móvil)' : '🇺🇸 Direct Connection from Discord (Android / Mobile)')
                .setColor(0x10b981)
                .setDescription(
                    isEs
                        ? '**Si estás en Android (Samsung / Xiaomi), puedes hacerlo 100% aquí mismo en Discord en 2 toques:**\n\n' +
                          '1️⃣ Toca el botón **"1. Abrir Link Oficial de Nintendo"** abajo. Inicia sesión y en la pantalla *"Link an account"* **mantén presionado el botón rojo "Select this account"** -> **"Copiar dirección de enlace"**.\n' +
                          '2️⃣ Regresa aquí a Discord y toca el botón verde **"2. Pegar Link y Ponerse Online"**.\n\n' +
                          '*(También tienes el botón de la **Bóveda Web** por si deseas guardar el token localmente en tu navegador o subir tu archivo `dc.bin`).*'
                        : '**If you are on Android, you can connect 100% right here inside Discord in 2 taps:**\n\n' +
                          '1️⃣ Tap **"1. Open Official Nintendo Link"** below. Sign in, and on the *"Link an account"* screen **long-press the red "Select this account" button** -> **"Copy link address"**.\n' +
                          '2️⃣ Come back to Discord and tap the green **"2. Paste Link & Go Online"** button.\n\n' +
                          '*(You can also use the **Web Vault** button if you want to store the token in your browser or upload `dc.bin`).*'
                );

            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setLabel(isEs ? '1. Abrir Link Oficial de Nintendo' : '1. Open Official Nintendo Link')
                    .setStyle(ButtonStyle.Link)
                    .setURL(auth.url),
                new ButtonBuilder()
                    .setCustomId('open_modal_paste')
                    .setLabel(isEs ? '2. Pegar Link y Ponerse Online' : '2. Paste Link & Go Online')
                    .setStyle(ButtonStyle.Success),
                new ButtonBuilder()
                    .setLabel(isEs ? '🔐 Bóveda Web (dc.bin)' : '🔐 Web Vault (dc.bin)')
                    .setStyle(ButtonStyle.Link)
                    .setURL(vaultUrl)
            );

            return interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
        }

        if (interaction.customId === 'open_modal_paste') {
            const modal = new ModalBuilder()
                .setCustomId('modal_submit_link')
                .setTitle('Conectar Cuenta / Connect Account');

            const fcInput = new TextInputBuilder()
                .setCustomId('fc_input')
                .setLabel('Tu Friend Code (16 dígitos / 16 digits)')
                .setPlaceholder('9370-0010-9308-6237')
                .setStyle(TextInputStyle.Short)
                .setRequired(true);

            const linkInput = new TextInputBuilder()
                .setCustomId('link_input')
                .setLabel('Pega el link del botón rojo (npf045ab...)')
                .setPlaceholder('npf045ab1d9068381b3://auth#session_token_code=...')
                .setStyle(TextInputStyle.Paragraph)
                .setRequired(true);

            modal.addComponents(
                new ActionRowBuilder().addComponents(fcInput),
                new ActionRowBuilder().addComponents(linkInput)
            );
            return interaction.showModal(modal);
        }
    }

    if (interaction.isModalSubmit() && interaction.customId === 'modal_submit_link') {
        const rawFc = interaction.fields.getTextInputValue('fc_input');
        const copiedLink = interaction.fields.getTextInputValue('link_input').trim();
        const cleanFc = rawFc.replace(/\D/g, '');

        if (cleanFc.length !== 16) {
            return interaction.reply({ content: '❌ El Friend Code debe tener exactamente 16 dígitos.', ephemeral: true });
        }

        let sessionToken = '';
        // Si ya pegó un sessionToken guardado previamente o si pegó el link npf045ab...
        const codeMatch = copiedLink.match(/session_token_code=([^&\s]+)/);
        const stateMatch = copiedLink.match(/state=([^&\s]+)/);

        if (codeMatch) {
            const entry = (stateMatch && oauthByState.get(stateMatch[1])) || oauthByUser.get(uid);
            if (!entry) {
                return interaction.reply({
                    content: '❌ El enlace expiró. Vuelve a pulsar el botón de Idioma en el panel para generar un enlace nuevo.',
                    ephemeral: true
                });
            }
            try {
                sessionToken = await exchangeCodeWithNintendo(codeMatch[1], entry.verifier);
            } catch (err) {
                return interaction.reply({ content: `❌ Error al canjear con Nintendo: ${err.message}`, ephemeral: true });
            }
        } else if (copiedLink.length > 40) {
            sessionToken = copiedLink;
        } else {
            return interaction.reply({ content: '❌ Enlace inválido. Asegúrate de copiar el enlace del botón rojo "Select this account".', ephemeral: true });
        }

        activeSessions.set(uid, {
            friendCode: cleanFc,
            sessionToken,
            dcBinB64: '',
            acceptedCount: 0
        });
        syncHostWorkers();

        return interaction.reply({
            content:
                `🟢 **¡ESTÁS ONLINE!** (ID: \`${cleanFc}\`)\n` +
                `El Host ya está aceptando solicitudes por ti con una IP fija. Puedes cerrar Discord o apagar tu pantalla.\n\n` +
                `💾 **Tu Token personal para próximas veces:**\n` +
                `Guarda este código en tus notas o portapapeles. La próxima vez que quieras ponerte Online, ya no tendrás que entrar a Nintendo; solo abre el botón **2. Pegar Link** y pega este código directo:\n` +
                `\`\`\`${sessionToken}\`\`\``,
            ephemeral: true
        });
    }
});

server.listen(PORT, () => console.log(`[Zenith Gateway] Port ${PORT} (${PUBLIC_URL})`));
client.login(DISCORD_TOKEN);
