const express = require('express');
const path = require('path');

// Inicializa o servidor Express
const app = express();
const port = process.env.PORT || 3000;

// Importa e inicia o bot (bot.js)
const startBot = require('./bot.js');
startBot();

// Importa e configura o servidor web (index.js)
const webServer = require('./index.js');
app.use(express.json());
app.use(express.static('public')); // Serve arquivos estáticos da pasta public
app.use(webServer); // Integra as rotas do index.js

// Inicia o servidor
app.listen(port, () => {
  console.log(`Servidor rodando na porta ${port}`);
});