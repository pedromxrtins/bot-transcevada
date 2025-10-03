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
    return; // Não flooda, mas avisa uma vez
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

function salvarHistorico() {
  fs.writeFileSync(historicoPath, JSON.stringify(historico, null, 2));
}

// Adicionado: Backup de auth a cada 5min pra persistir sessões longas
function backupAuth() {
  setInterval(() => {
    // Copia auth/ pra auth_backup/ (manual restore se precisar)
    if (!fs.existsSync('./auth_backup')) fs.mkdirSync('./auth_backup');
    fs.copyFileSync('./auth/creds.json', './auth_backup/creds.json', fs.constants.FAIL_IF_EXISTS);
    console.log('💾 Auth backup salvo (pra semanas de uptime)');
  }, 300000); // 5min
}

async function startBot() {
  const { version } = await fetchLatestBaileysVersion();
  const { state, saveCreds } = await useMultiFileAuthState('auth');
  
  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }), // Pino pleno pra .child()
    // Estabilidade: Keep-alive pra semanas sem reset
    keepAliveIntervalMs: 30000, // Ping 30s (fix reconexões)
    connectTimeoutMs: 60000, // Timeout longo
    // User-agent fixo: Simula Chrome pra evitar Bad MAC
    browser: ['Chrome', '4.0.0'], // Versão estável
    // Sync mínimo: Evita overload em long-run
    syncFullHistory: false,
    generateHighQualityLinkPreview: false,
    defaultQueryTimeoutMs: 60000,
    // Ignora status broadcast (reduz Bad MAC em receives)
    shouldIgnoreJid: jid => jid === 'status@broadcast',
    markOnlineOnConnect: true, // Mantém "online" pra sync melhor
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
        await delay(5000); // Delay suave
        startBot(); // Reconecta sem reset total
      } else {
        console.log('🔄 Logout detectado. Gere novo QR.');
      }
    } else if (connection === 'open') {
      console.log('✅ Bot conectado com sucesso! (Estável pra semanas)');
      backupAuth(); // Inicia backups
      // Removido: Ping inicial pro dono
    }
  });

  // Monitor receipts: Loga sync pro primary (pra debug mensagens "sumidas")
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

  // Adicionado: Auto-refresh em crypto errors graves (sem reconectar total)
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

    // Comando histórico (igual)
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

    const local = clientes[clienteEncontrado];
    const enviados = new Set();

    for (const jid of mencoes) {
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
        enviados.add(jid);
        const dataHoje = new Date().toLocaleDateString('pt-BR');
        historico[clienteEncontrado] = historico[clienteEncontrado] || [];
        historico[clienteEncontrado].push({ data: dataHoje, motorista: jid });
        salvarHistorico();
        console.log(`✅ Localização enviada para ${jid} (Cliente: ${clienteEncontrado}) - ID: ${sent?.key?.id}`);
      } catch (err) {
        console.error(`❌ Falha envio pra ${jid}: ${err.message}`);
        errorCount++;
        // Retry só em crypto (e reset count a cada 10min)
        if ((err.message.includes('PreKey') || err.message.includes('Session')) && errorCount < 5) {
          console.log(`🔄 Retry pra ${jid} em 3s...`);
          await delay(3000);
          try {
            await sock.sendMessage(jid, mensagem);
            console.log(`✅ Retry OK pra ${jid}`);
            errorCount = 0; // Reset se sucesso
          } catch (retryErr) {
            console.error(`❌ Retry falhou: ${retryErr.message}`);
          }
        }
        // Se >5 erros, loga mas não reconecta (pra estabilidade)
        if (errorCount > 5) {
          console.log('⚠️ Muitos crypto errors - Monitore, mas continuo rodando.');
          setTimeout(() => errorCount = 0, 600000); // Reset count em 10min
        }
      }
    }
  });
}

module.exports = startBot;