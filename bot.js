const { makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason } = require('@whiskeysockets/baileys');
const fs = require('fs');
const qrcode = require('qrcode-terminal');

// Suprime erros específicos do Baileys
const originalConsoleError = console.error;
console.error = (...args) => {
  const msg = args.join(' ');
  if (
    msg.includes('No session found') ||
    msg.includes('No sender key') ||
    msg.includes('Failure in decoding') ||
    msg.includes('Decrypting message from') ||
    msg.includes('Decrypting media from')
  ) {
    return; // ignora no terminal
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

async function startBot() {
  const { version } = await fetchLatestBaileysVersion();
  const { state, saveCreds } = await useMultiFileAuthState('auth');

  const sock = makeWASocket({
    version,
    auth: state
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      const shouldReconnect = (lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut);
      console.log('❌ Conexão encerrada. Reconectando?', shouldReconnect);
      if (shouldReconnect) startBot();
    } else if (connection === 'open') {
      console.log('✅ Bot conectado com sucesso!');
    }
  });

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

    const local = clientes[clienteEncontrado];
    const enviados = new Set();

    for (const jid of mencoes) {
      if (enviados.has(jid)) continue; // Evita enviar 2x para o mesmo

      const contato = await sock.onWhatsApp(jid);
      const nomeMotorista = contato?.[0]?.notify || jid;

      await sock.sendMessage(jid, {
        text: `Sr Motorista! Segue a localização do cliente:\nCliente: ${clienteEncontrado}\n📍 https://maps.google.com/?q=${local.latitude},${local.longitude}`
      });

      enviados.add(jid);

      const dataHoje = new Date().toLocaleDateString('pt-BR');
      historico[clienteEncontrado] = historico[clienteEncontrado] || [];
      historico[clienteEncontrado].push({ data: dataHoje, motorista: jid });
      salvarHistorico();

      console.log(`✅ Localização enviada para ${jid} (Cliente: ${clienteEncontrado})`);
    }
  });
}

module.exports = startBot;
