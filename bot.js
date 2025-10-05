const { makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason, delay } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const qrcode = require('qrcode-terminal');

// Supressão de erros: Ignora Bad MAC em receives, mas loga pra debug
const originalConsoleError = console.error;
console.error = (...args) => {
  const msg = args.join(' ');
  if (msg.includes('Bad MAC') && msg.includes('decrypt')) {
    console.log(`🔒 Bad MAC ignorado (comum em sync): ${new Date().toISOString()}`);
    return; 
  }
  if (
    msg.includes('No session found') ||
    msg.includes('Failure in decoding') ||
    msg.includes('Decrypting message from') ||
    msg.includes('Decrypting media from')
  ) {
    return;
  }
  if (msg.includes('PreKeyError') || msg.includes('SessionError')) {
    console.log(`🔒 Crypto Error: ${new Date().toISOString()} - ${msg}`);
  }
  originalConsoleError(...args);
};

const historicoPath = './historicoDB.json';
const historico = fs.existsSync(historicoPath) ? JSON.parse(fs.readFileSync(historicoPath)) : {};

const gruposPermitidos = [
  '120363415883857192@g.us',
  '120363067360288217@g.us',
  '120363327309862182@g.us',
  '556696361920-1456497459@g.us'
];

const donoDoBot = '5535997159139@s.whatsapp.net';

// Cache simples contra duplicação
const recentSends = new Map();

function salvarHistorico() {
  fs.writeFileSync(historicoPath, JSON.stringify(historico, null, 2));
}

// Cleanup do cache a cada 2min
setInterval(() => {
  const now = Date.now();
  for (const [key, timestamp] of recentSends.entries()) {
    if (now - timestamp > 120000) {
      recentSends.delete(key);
    }
  }
}, 120000);

// Backup de auth a cada 5min
function backupAuth() {
  setInterval(() => {
    if (!fs.existsSync('./auth_backup')) fs.mkdirSync('./auth_backup');
    fs.copyFileSync('./auth/creds.json', './auth_backup/creds.json', fs.constants.FAIL_IF_EXISTS);
    console.log('💾 Auth backup salvo (pra semanas de uptime)');
  }, 300000); 
}

// Aguardar ack de entrega (status 3)
function waitForDeliveryAck(sock, key) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      sock.ev.off('messages.update', handler); 
      reject(new Error('Timeout aguardando entrega (30s)'));
    }, 30000);

    const handler = (updates) => {
      for (const { key: updateKey, update } of updates) {
        if (updateKey.id === key.id && update.status === 3) { 
          clearTimeout(timeout);
          sock.ev.off('messages.update', handler);
          resolve('Entregue!');
        } else if (updateKey.id === key.id && update.status >= 4) { 
          clearTimeout(timeout);
          sock.ev.off('messages.update', handler);
          resolve('Lido!');
        }
      }
    };

    sock.ev.on('messages.update', handler);
  });
}

async function startBot() {
  const { version } = await fetchLatestBaileysVersion();
  const { state, saveCreds } = await useMultiFileAuthState('auth');
  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    keepAliveIntervalMs: 20000,
    connectTimeoutMs: 60000,
    browser: ['Chrome', '4.0.0'],
    syncFullHistory: false,
    generateHighQualityLinkPreview: false,
    defaultQueryTimeoutMs: 60000,
    shouldIgnoreJid: jid => jid === 'status@broadcast',
    markOnlineOnConnect: true,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      qrcode.generate(qr, { small: true });
      console.log('📱 Escaneie o QR com o WhatsApp no celular!');
    }
    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = (statusCode !== DisconnectReason.loggedOut);
      console.log(`❌ Conexão close (code ${statusCode}). Reconectando? ${shouldReconnect}`);
      if (shouldReconnect) {
        const reconnectDelay = statusCode === 440 ? 30000 : 5000;
        console.log(`⏳ Aguardando ${reconnectDelay / 1000}s antes de reconectar...`);
        await delay(reconnectDelay);
        startBot(); 
      } else {
        console.log('🔄 Logout detectado. Gere novo QR.');
      }
    } else if (connection === 'open') {
      console.log('✅ Bot conectado com sucesso! (Estável pra semanas)');
      backupAuth();

      // Refresh de prekeys a cada 15min (sem mensagem pro dono)
      setInterval(async () => {
        try {
          const keys = await sock.generatePreKeys(1, 1);
          console.log('🔑 Prekeys refreshed:', keys.length);
        } catch (e) {
          console.error('❌ Refresh falhou:', e.message);
        }
      }, 900000);
    }
  });

  sock.ev.on('message-receipt.update', (receipts) => {
    for (const receipt of receipts) {
      const type = receipt.receipt.type;
      if (type === 'read' || type === 'delivered') {
        console.log(`📨 Msg ${receipt.key.id} ${type} em ${receipt.userJid}`);
      } else if (type === 'retry') {
        console.log(`🔄 Retry em ${receipt.key.id} - Sessão sendo refresh...`);
      }
    }
  });

  sock.ev.on('messages.update', (updates) => {
    for (const { key, update } of updates) {
      if (update.status) {
        console.log(`📋 Ack update para ${key.id}: ${update.status}`);
      }
    }
  });

  let errorCount = 0;
  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;
    const jidOrigem = msg.key.remoteJid;
    const isGroup = jidOrigem.endsWith('@g.us');
    const autorizado = gruposPermitidos.includes(jidOrigem);
    const remetente = msg.key.participant || msg.key.remoteJid;
    const texto = msg.message.conversation || msg.message.extendedTextMessage?.text || "";
    const mencoes = msg.message.extendedTextMessage?.contextInfo?.mentionedJid || [];
    const textoLimpo = texto.replace(/[@,]/g, '').toLowerCase();

    let clientes = {};
    try {
      clientes = JSON.parse(fs.readFileSync('./clientDB.json'));
    } catch (err) {
      console.error("❌ Erro ao ler clientDB.json:", err.message);
    }

    if (textoLimpo.includes("historico de viagens do cliente")) {
      const match = textoLimpo.match(/historico de viagens do cliente (.+)/i);
      if (!match) return;
      const nomeCliente = Object.keys(clientes).find(nome => nome.toLowerCase() === match[1].trim());
      if (!nomeCliente) {
        await sock.sendMessage(jidOrigem, { text: `❌ Cliente não encontrado.` });
        return;
      }
      const registros = historico[nomeCliente] || [];
      if (registros.length === 0) {
        await sock.sendMessage(jidOrigem, { text: `📭 Sem viagens registradas para ${nomeCliente}.` });
        return;
      }
      let resposta = `🗂️ Histórico de viagens - ${nomeCliente}:\n`;
      for (const r of registros) {
        const contato = await sock.onWhatsApp(r.motorista);
        const nome = contato?.[0]?.notify || r.motorista;
        resposta += `- ${r.data} - Motorista: ${nome}\n`;
      }
      await sock.sendMessage(jidOrigem, { text: resposta });
      return;
    }

    if (!isGroup || (!autorizado && remetente !== donoDoBot)) {
      console.log("❌ Grupo não autorizado.");
      return;
    }

    let clienteEncontrado = null;
    for (const nome in clientes) {
      if (textoLimpo.includes(nome.toLowerCase())) {
        clienteEncontrado = nome;
        break;
      }
    }
    if (!clienteEncontrado) {
      console.log("❌ Nenhum cliente reconhecido na mensagem.");
      return;
    }

    const cacheKey = `${jidOrigem}-${clienteEncontrado}`;
    const lastSent = recentSends.get(cacheKey);
    if (lastSent && Date.now() - lastSent < 60000) { 
      console.log('⏭️ Envio duplicado ignorado para cliente:', clienteEncontrado);
      return;
    }

    const local = clientes[clienteEncontrado];
    const enviados = new Set();
    for (const jid of [...new Set(mencoes)]) { 
      if (enviados.has(jid)) continue;
      try {
        const contato = await sock.onWhatsApp(jid);
        const nomeMotorista = contato?.[0]?.notify || jid;
        const mensagem = {
          text: `Sr Motorista! Segue a localização do cliente:\nCliente: ${clienteEncontrado}\n📍 https://maps.google.com/?q=${local.latitude},${local.longitude}`
        };
        const sent = await Promise.race([
          sock.sendMessage(jid, mensagem),
          delay(15000).then(() => { throw new Error('Timeout envio'); })
        ]);
        
        console.log(`📤 Enviado pro servidor (ID: ${sent.key.id}) - Aguardando entrega...`);
        
        try {
          await waitForDeliveryAck(sock, sent.key);
          console.log(`✅ Entregue com sucesso para ${jid} (Cliente: ${clienteEncontrado})`);
          const dataHoje = new Date().toLocaleDateString('pt-BR');
          historico[clienteEncontrado] = historico[clienteEncontrado] || [];
          historico[clienteEncontrado].push({ data: dataHoje, motorista: jid });
          salvarHistorico();
          recentSends.set(cacheKey, Date.now());
        } catch (deliveryErr) {
          console.error(`⚠️ Falha na entrega para ${jid}: ${deliveryErr.message} - Tentando retry...`);
          await delay(5000);
          try {
            const retrySent = await sock.sendMessage(jid, mensagem);
            await waitForDeliveryAck(sock, retrySent.key);
            console.log(`✅ Retry entregue para ${jid}`);
            const dataHoje = new Date().toLocaleDateString('pt-BR');
            historico[clienteEncontrado] = historico[clienteEncontrado] || [];
            historico[clienteEncontrado].push({ data: dataHoje, motorista: jid });
            salvarHistorico();
            recentSends.set(cacheKey, Date.now());
          } catch (retryErr) {
            console.error(`❌ Retry falhou para ${jid}: ${retryErr.message}`);
            await sock.sendMessage(donoDoBot, { text: `⚠️ Falha dupla de entrega para ${jid} (Cliente: ${clienteEncontrado})` });
          }
        }
        
        enviados.add(jid);
        await delay(2000);
      } catch (err) {
        console.error(`❌ Falha envio pra ${jid}: ${err.message}`);
        errorCount++;
        if ((err.message.includes('PreKey') || err.message.includes('Session')) && errorCount < 5) {
          console.log(`🔄 Retry pra ${jid} em 3s...`);
          await delay(3000);
          try {
            await sock.sendMessage(jid, mensagem);
            console.log(`✅ Retry OK pra ${jid}`);
            errorCount = 0; 
            recentSends.set(cacheKey, Date.now());
          } catch (retryErr) {
            console.error(`❌ Retry falhou: ${retryErr.message}`);
          }
        }
        if (errorCount > 5) {
          console.log('⚠️ Muitos crypto errors - Monitore, mas continuo rodando.');
          setTimeout(() => errorCount = 0, 600000);
        }
      }
    }
  });
}

module.exports = startBot;
