const http = require('http');
const { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');
const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;

// Mapa en RAM: discordId -> { ws, friendCode, username, active, lastPing }
const collectors = new Map();

// 1. Servidor HTTP + WebSocket unificado para Railway
const server = http.createServer((req, res) => {
    // Endpoint compatible con fetch_live_worker_codes() de inject.py (--worker-url)
    if (req.url === '/online' || req.url === '/trainer' || req.url === '/elite') {
        const activeCodes = [];
        for (const data of collectors.values()) {
            if (data.active && data.ws.readyState === WebSocket.OPEN && data.friendCode) {
                activeCodes.push(data.friendCode);
            }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(activeCodes));
    }

    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Zenith Rise Collector Gateway Running\n');
});

const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
    let boundDiscordId = null;

    ws.on('message', (raw) => {
        try {
            const msg = JSON.parse(raw.toString());

            if (msg.type === 'REGISTER') {
                boundDiscordId = String(msg.discordId || '').trim();
                const cleanCode = String(msg.friendCode || '').replace(/\D/g, '');
                if (!boundDiscordId || cleanCode.length !== 16) {
                    ws.send(JSON.stringify({ type: 'ERROR', message: 'discordId o friendCode (16 dígitos) inválido.' }));
                    return;
                }

                const prev = collectors.get(boundDiscordId);
                const isActive = prev ? prev.active : false;

                collectors.set(boundDiscordId, {
                    ws,
                    friendCode: cleanCode,
                    active: isActive,
                    acceptedCount: prev ? prev.acceptedCount : 0,
                    lastSeen: Date.now()
                });

                ws.send(JSON.stringify({
                    type: 'REGISTERED',
                    active: isActive,
                    message: `Conectado a Railway. Estado actual: ${isActive ? 'ONLINE' : 'OFFLINE'}`
                }));
            } else if (msg.type === 'ACCEPTED_REPORT' && boundDiscordId) {
                const entry = collectors.get(boundDiscordId);
                if (entry) {
                    entry.acceptedCount = (entry.acceptedCount || 0) + Number(msg.count || 0);
                    entry.lastSeen = Date.now();
                }
            }
        } catch (e) {
            console.error('[WS Error]', e.message);
        }
    });

    ws.on('close', () => {
        if (boundDiscordId && collectors.has(boundDiscordId)) {
            const entry = collectors.get(boundDiscordId);
            if (entry.ws === ws) {
                // Si se cierra Termux o la PC, se desactiva automáticamente de la cola
                entry.active = false;
            }
        }
    });
});

// Heartbeat cada 25s para evitar que Railway cierre conexiones inactivas
setInterval(() => {
    for (const [id, entry] of collectors.entries()) {
        if (entry.ws.readyState === WebSocket.OPEN) {
            entry.ws.ping();
        }
    }
}, 25000);

// 2. Bot de Discord
const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

function buildCollectorEmbed() {
    const onlineList = [];
    for (const [id, data] of collectors.entries()) {
        if (data.active && data.ws.readyState === WebSocket.OPEN) {
            const formattedCode = data.friendCode.replace(/(\d{4})(\d{4})(\d{4})(\d{4})/, '$1-$2-$3-$4');
            onlineList.push(`🟢 <@${id}> — \`${formattedCode}\` *(Aceptadas: ${data.acceptedCount || 0})*`);
        }
    }

    return new EmbedBuilder()
        .setTitle('⚡ Cola de Collectors Auto-Accept (IP Local)')
        .setDescription(
            onlineList.length > 0
                ? onlineList.join('\n')
                : '*No hay collectors activos en este momento.*\n\nAbre tu `main_acceptor.py` en Termux o PC y presiona **Ponerse Online**.'
        )
        .setColor(0x2ecc71)
        .setFooter({ text: `Collectors activos: ${onlineList.length}` })
        .setTimestamp();
}

function buildCollectorButtons() {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('collector_online')
            .setLabel('🟢 Ponerse Online')
            .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
            .setCustomId('collector_offline')
            .setLabel('🔴 Salir (Offline)')
            .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
            .setCustomId('collector_refresh')
            .setLabel('🔄 Actualizar Lista')
            .setStyle(ButtonStyle.Secondary)
    );
}

client.on('messageCreate', async (msg) => {
    if (msg.content === '!panel_main') {
        await msg.channel.send({
            embeds: [buildCollectorEmbed()],
            components: [buildCollectorButtons()]
        });
    }
});

client.on('interactionCreate', async (interaction) => {
    if (!interaction.isButton()) return;

    const userId = interaction.user.id;
    const entry = collectors.get(userId);

    if (interaction.customId === 'collector_refresh') {
        return interaction.update({
            embeds: [buildCollectorEmbed()],
            components: [buildCollectorButtons()]
        });
    }

    if (interaction.customId === 'collector_online') {
        if (!entry || entry.ws.readyState !== WebSocket.OPEN) {
            return interaction.reply({
                content: '❌ **No se detecta tu script activo.** Primero ejecuta `python main_acceptor.py` en tu Termux (Android) o en tu PC y vuelve a pulsar este botón.',
                ephemeral: true
            });
        }

        entry.active = true;
        entry.ws.send(JSON.stringify({ type: 'SET_ACTIVE', active: true }));

        await interaction.update({
            embeds: [buildCollectorEmbed()],
            components: [buildCollectorButtons()]
        });
        return interaction.followUp({
            content: `✅ **Estás ONLINE.** Tu Termux/PC ahora está aceptando solicitudes automáticamente desde tu propia IP para el ID \`${entry.friendCode}\`.`,
            ephemeral: true
        });
    }

    if (interaction.customId === 'collector_offline') {
        if (entry) {
            entry.active = false;
            if (entry.ws.readyState === WebSocket.OPEN) {
                entry.ws.send(JSON.stringify({ type: 'SET_ACTIVE', active: false }));
            }
        }

        await interaction.update({
            embeds: [buildCollectorEmbed()],
            components: [buildCollectorButtons()]
        });
        return interaction.followUp({
            content: '🔴 **Has pasado a OFFLINE.** Tu script local ha pausado la aceptación de solicitudes.',
            ephemeral: true
        });
    }
});

server.listen(PORT, () => {
    console.log(`[Server] HTTP & WebSocket escuchando en puerto ${PORT}`);
});

client.login(DISCORD_TOKEN);
