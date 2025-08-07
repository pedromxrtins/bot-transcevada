const express = require('express');
const fs = require('fs').promises;
const path = require('path');

const router = express.Router();
const dbPath = path.join(__dirname, 'clientDB.json');

async function loadClients() {
  try {
    const data = await fs.readFile(dbPath, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error('Erro ao carregar clientDB:', error.message);
    return {};
  }
}

async function saveClients(clients) {
  try {
    await fs.writeFile(dbPath, JSON.stringify(clients, null, 2));
    console.log('Arquivo salvo com sucesso');
  } catch (error) {
    console.error('Erro ao salvar clientDB:', error.message);
  }
}

router.get('/clients', async (req, res) => {
  const clients = await loadClients();
  res.json(Object.entries(clients).map(([nome, { latitude, longitude }]) => ({
    nome,
    localizacao: `${latitude}, ${longitude}`
  })));
});

router.post('/clients', async (req, res) => {
  const { nome, localizacao } = req.body;
  if (nome && localizacao) {
    const [latitude, longitude] = localizacao.split(', ').map(Number);
    const clients = await loadClients();
    clients[nome] = { latitude, longitude };
    await saveClients(clients);
    res.json({ success: true });
  } else {
    res.status(400).json({ success: false, message: 'Dados inválidos' });
  }
});

router.put('/clients/:nome', async (req, res) => {
  const { nome } = req.params;
  const { localizacao } = req.body;
  if (localizacao) {
    const [latitude, longitude] = localizacao.split(', ').map(Number);
    const clients = await loadClients();
    if (clients[nome]) {
      clients[nome] = { latitude, longitude };
      await saveClients(clients);
      res.json({ success: true });
    } else {
      res.status(404).json({ success: false, message: 'Cliente não encontrado' });
    }
  } else {
    res.status(400).json({ success: false, message: 'Dados inválidos' });
  }
});

router.delete('/clients/:nome', async (req, res) => {
  const { nome } = req.params;
  const clients = await loadClients();
  if (clients[nome]) {
    delete clients[nome];
    await saveClients(clients);
    res.json({ success: true });
  } else {
    res.status(404).json({ success: false, message: 'Cliente não encontrado' });
  }
});

module.exports = router;