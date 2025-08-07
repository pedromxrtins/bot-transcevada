const express = require('express');
const path = require('path');
const axios = require('axios'); // Instale com: npm install axios

const app = express();
const port = process.env.PORT || 3000;

const startBot = require('./bot.js');
startBot();

const webServer = require('./index.js');
app.use(express.json());
app.use(express.static('public'));
app.use(webServer);

app.get('/healthz', (req, res) => {
  res.status(200).send('OK');
});

// Função para pingar a si mesmo
const keepAlive = async () => {
  try {
    await axios.get(`https://bot-transcevada.onrender.com/healthz`);
    console.log('Ping interno realizado');
  } catch (error) {
    console.error('Erro no ping interno:', error.message);
  }
};

// Chama keepAlive a cada 4 minutos (menos que 15 para evitar hibernação)
setInterval(keepAlive, 4 * 60 * 1000);

app.listen(port, () => {
  console.log(`Servidor rodando na porta ${port}`);
});