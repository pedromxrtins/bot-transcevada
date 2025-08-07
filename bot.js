const { makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason } = require('@whiskeysockets/baileys');
const fs = require('fs');
const qrcode = require('qrcode-terminal');

const historicoPath = './historicoDB.json';
const historico = fs.existsSync(historicoPath) ? JSON.parse(fs.readFileSync(historicoPath)) : {};

const gruposPermitidos = [
  '120363415883857192@g.us',
  '120363067360288217@g.us',
  '120363327309862182@g.us',
  '556696361920-1456497459@g.us'
];

const donoDoBot = '5535997159139@s.whatsapp.net';

// Função para mostrar lista simplificada de clientes no console
function mostrarListaClientesSimplificada(clientesObj) {
  const clientes = Object.entries(clientesObj).map(([nome, data]) => ({ nome, ...data }));
  console.log('\n📋 Lista de Clientes:');
  if (clientes.length === 0) {
    console.log('(vazia)\n');
    return;
  }
  clientes.forEach((cliente, i) => {
    console.log(`${i + 1}. ${cliente.nome} - Lat: ${cliente.latitude}, Lon: ${cliente.longitude}`);
  });
  console.log('');
}

async function listarGrupos(sock) {
  const grupos = await sock.groupFetchAllParticipating();
  console.log("\n📃 Lista de Grupos:");
  for (const [jid, info] of Object.entries(grupos)) {
    console.log(`🟢 Nome: ${info.subject}`);
    console.log(`🔑 ID: ${jid}`);
    console.log('---');
  }
}

function salvarHistorico() {
  fs.writeFileSync(historicoPath, JSON.stringify(historico, null, 2));
}

async function startBot() {
  const { version } = await fetchLatestBaileysVersion();
  const { state, saveCreds } = await useMultiFileAuthState('auth');

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: true
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
      await listarGrupos(sock);

      // Log da lista de clientes ao conectar
      try {
        const clientes = JSON.parse(fs.readFileSync('./clientDB.json'));
        mostrarListaClientesSimplificada(clientes);
      } catch (err) {
        console.error('Erro ao ler clientDB.json no início:', err.message);
      }
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

    // Carrega clientes atualizados toda vez que chega mensagem
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
        mostrarListaClientesSimplificada(clientes);
        return;
      }

      const registros = historico[nomeCliente] || [];
      if (registros.length === 0) {
        await sock.sendMessage(jidOrigem, { text: `📭 Sem viagens registradas para ${nomeCliente}.` });
        mostrarListaClientesSimplificada(clientes);
        return;
      }

      let resposta = `🗂️ Histórico de viagens - ${nomeCliente}:\n`;
      for (const r of registros) {
        const contato = await sock.onWhatsApp(r.motorista);
        const nome = contato?.[0]?.notify || r.motorista;
        resposta += `- ${r.data} - Motorista: ${nome}\n`;
      }

      await sock.sendMessage(jidOrigem, { text: resposta });
      mostrarListaClientesSimplificada(clientes);
      return;
    }

    if (!isGroup || (!autorizado && remetente !== donoDoBot)) {
      console.log("❌ Grupo não autorizado.");
      mostrarListaClientesSimplificada(clientes);
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
      mostrarListaClientesSimplificada(clientes);
      return;
    }

    const local = clientes[clienteEncontrado];

    for (const jid of mencoes) {
      const contato = await sock.onWhatsApp(jid);
      const nomeMotorista = contato?.[0]?.notify || jid;

      await sock.sendMessage(jid, {
        text: `Sr Motorista! Segue a localização do cliente:\nCliente: ${clienteEncontrado}\n📍 https://maps.google.com/?q=${local.latitude},${local.longitude}`
      });

      const dataHoje = new Date().toLocaleDateString('pt-BR');
      historico[clienteEncontrado] = historico[clienteEncontrado] || [];
      historico[clienteEncontrado].push({ data: dataHoje, motorista: jid });
      salvarHistorico();

      console.log(`✅ Localização enviada para ${jid} (Cliente: ${clienteEncontrado})`);
    }

    // Log da lista de clientes após processar comando
    mostrarListaClientesSimplificada(clientes);
  });

}

module.exports = startBot;
