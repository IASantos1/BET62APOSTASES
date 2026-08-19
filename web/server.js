// Servidor estático mínimo para o frontend Bet62.
// Gera /config.js a partir de variáveis de ambiente (definidas no Railway) em vez de
// hardcoded no HTML, para o mesmo build funcionar em qualquer ambiente sem alterar código.
const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 5500;
const API_BASE = process.env.BET62_API_BASE || "http://localhost:4000/api";
const WS_BASE = process.env.BET62_WS_BASE || "ws://localhost:4000";

app.get("/config.js", (_req, res) => {
  res.type("application/javascript");
  res.send(
    `window.BET62_CONFIG = ${JSON.stringify({ API_BASE, WS_BASE })};\n` +
      `if (localStorage.getItem('bet62_api_base')) window.BET62_CONFIG.API_BASE = localStorage.getItem('bet62_api_base');\n` +
      `if (localStorage.getItem('bet62_ws_base')) window.BET62_CONFIG.WS_BASE = localStorage.getItem('bet62_ws_base');\n`
  );
});

app.use(express.static(__dirname));

app.listen(PORT, () => {
  console.log(`Bet62 web a correr em http://localhost:${PORT} (API_BASE=${API_BASE})`);
});
