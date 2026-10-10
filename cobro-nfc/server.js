// ============================================================
// COBRO NFC — conectado a Rampex (tarjeta/Apple Pay -> USDC en Polygon)
// ============================================================
// Flujo:
//   1) Tipeas el monto en la calculadora  -> POST /api/crear-cobro
//   2) El cliente toca el NFC -> /t/AB12 -> (pide email) -> /ir/<sid>
//   3) En /ir/<sid> el servidor le pide a Rampex un "payment link" (ya
//      con el email del cliente, que Rampex exige) y manda al cliente ahi.
//   4) Cuando paga, Rampex llama a /api/rampex-webhook. El aviso se acepta
//      SOLO si trae una firma valida (HMAC con tu webhook secret). Un aviso
//      sin firma o con firma mala se rechaza y NO marca nada como cobrado.
//
// Variables de entorno (se cargan en el panel de Render / tu servidor):
//   RAMPEX_API_KEY         tu API key de Rampex (es una contrasena).
//   RAMPEX_WEBHOOK_SECRET  tu webhook secret de Rampex (es una contrasena).
//   RAMPEX_API_URL         la URL base de la API que figura en rampex.io/api-docs
//                          (o la URL completa de /api-create-payment-link).
//   RAMPEX_PROVIDER        opcional: valor del campo "provider" (ej. "hosted").
//   BASE_URL               la URL publica de tu servidor. En Render se toma sola.
//   MONEDA                 EUR por defecto.
//   PEDIR_EMAIL            "si" (defecto) pide el email al cliente antes de pagar.
//                          "no" usa EMAIL_POR_DEFECTO para todos.
//   EMAIL_POR_DEFECTO      solo se usa si PEDIR_EMAIL=no.
//   La wallet de cobro se configura en el panel de Rampex
//   (Default Polygon Wallet), no aca.
//
// Si falta alguna de las variables de Rampex, corre en MODO PRUEBA (pago falso).
// ============================================================

const express = require("express");
const path = require("path");
const crypto = require("crypto");

const app = express();
// El webhook necesita el cuerpo CRUDO para poder verificar la firma.
app.use("/api/rampex-webhook", express.raw({ type: () => true, limit: "200kb" }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ---- Tiempos --------------------------------------------------
const TAP_TTL_MS = 45 * 1000;        // el cliente tiene 45s para tocar el NFC
const PAGO_TTL_MS = 10 * 60 * 1000;  // una vez que toco, 10 min para pagar

// ---- Configuracion --------------------------------------------
const BASE_URL = (process.env.BASE_URL || process.env.RENDER_EXTERNAL_URL || "").replace(/\/$/, "");
const MONEDA = (process.env.MONEDA || "EUR").toUpperCase();
const PEDIR_EMAIL = (process.env.PEDIR_EMAIL || "si").toLowerCase() === "si";
const EMAIL_POR_DEFECTO = (process.env.EMAIL_POR_DEFECTO || "").trim();

const RAMPEX_API_KEY = (process.env.RAMPEX_API_KEY || "").trim();
const RAMPEX_WEBHOOK_SECRET = (process.env.RAMPEX_WEBHOOK_SECRET || "").trim();
const RAMPEX_PROVIDER = (process.env.RAMPEX_PROVIDER || "").trim();
const RAMPEX_ENDPOINT = (() => {
  let u = (process.env.RAMPEX_API_URL || "").trim().replace(/\/+$/, "");
  if (!u) return "";
  if (!/api-create-payment-link$/.test(u)) u += "/api-create-payment-link";
  return u;
})();

const FALTAN = [];
if (!RAMPEX_API_KEY) FALTAN.push("RAMPEX_API_KEY");
if (!RAMPEX_WEBHOOK_SECRET) FALTAN.push("RAMPEX_WEBHOOK_SECRET");
if (!RAMPEX_ENDPOINT) FALTAN.push("RAMPEX_API_URL");
if (!BASE_URL) FALTAN.push("BASE_URL");
const MODO_REAL = FALTAN.length === 0;
const MONTO_MINIMO = 1;

// ---- Estado en memoria ----------------------------------------
const payments = new Map(); // sid -> cobro
const current = new Map();  // tagId -> sid del cobro vigente en ese cartel
const porLinkId = new Map(); // id del payment link en Rampex -> sid

function estadoActual(p) {
  if (p.status === "pagado" || p.status === "cancelado") return p.status;
  const ahora = Date.now();
  if (p.status === "esperando" && ahora > p.tapExpiresAt) return "expirado";
  if (p.status === "pagando" && ahora > p.payExpiresAt) return "expirado";
  return p.status;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function paginaMensaje(titulo, detalle) {
  return `<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head>
  <body style="font-family:sans-serif;text-align:center;padding:40px">
    <h2>${titulo}</h2><p>${detalle || ""}</p></body></html>`;
}

// ---- Utilidades para leer respuestas/avisos con nombres variables ----
function aplanar(obj, prefijo = "", prof = 0, out = []) {
  if (prof > 5 || obj === null || obj === undefined) return out;
  if (typeof obj === "object") {
    for (const [k, v] of Object.entries(obj)) aplanar(v, prefijo ? `${prefijo}.${k}` : k, prof + 1, out);
  } else {
    out.push([prefijo, obj]);
  }
  return out;
}
const ultimaClave = (ruta) => ruta.split(".").pop().toLowerCase().replace(/[-_\s]/g, "");

function buscarValor(plano, claves) {
  for (const clave of claves) {
    const k = clave.toLowerCase().replace(/[-_\s]/g, "");
    const hit = plano.find(([ruta, v]) => ultimaClave(ruta) === k && v !== "" && v !== null);
    if (hit) return hit[1];
  }
  return null;
}

// ---- Rampex: crear el payment link -----------------------------
async function crearLinkRampex(p, email) {
  const cuerpo = {
    amount: Number(p.amount.toFixed(2)),
    currency: MONEDA,
    customer_email: email,
    description: `Cobro NFC ${p.sid.slice(0, 8)}`,
    woo_order_id: p.sid,             // Rampex nos lo devuelve en el aviso: sirve para ubicar el cobro
    payment_url: `${BASE_URL}/gracias`,
    ipn_token: p.ipnToken,
  };
  if (RAMPEX_PROVIDER) cuerpo.provider = RAMPEX_PROVIDER;

  const resp = await fetch(RAMPEX_ENDPOINT, {
    method: "POST",
    headers: { "X-API-Key": RAMPEX_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify(cuerpo),
  });
  const texto = await resp.text();
  let data = null;
  try { data = JSON.parse(texto); } catch (_) { /* no era JSON */ }

  if (!resp.ok) {
    const e = new Error(`Rampex respondio ${resp.status}: ${texto.slice(0, 500)}`);
    e.detalle = `Rampex respondio ${resp.status}: ${texto.slice(0, 500)}`;
    throw e;
  }
  if (!data) {
    const e = new Error("Rampex no devolvio JSON: " + texto.slice(0, 300));
    e.detalle = "Rampex no devolvio JSON: " + texto.slice(0, 300);
    throw e;
  }

  const plano = aplanar(data);
  // 1) la URL de pago (preferimos la larga; la corta es plan B)
  const claves = ["payment_url", "paymentUrl", "checkout_url", "checkoutUrl", "url", "payment_link", "paymentLink", "link", "short_link", "shortLink", "short_url", "shortUrl"];
  let url = null;
  for (const c of claves) {
    const v = buscarValor(plano, [c]);
    if (typeof v === "string" && /^https:\/\//i.test(v)) { url = v; break; }
  }
  if (!url) {
    const e = new Error("Respuesta de Rampex sin URL de pago: " + texto.slice(0, 500));
    e.detalle = "Rampex no devolvio una URL de pago. Respuesta: " + texto.slice(0, 500);
    throw e;
  }
  // 2) el id del link (para reconocerlo en el aviso)
  const id = buscarValor(plano, ["id", "payment_id", "paymentId", "link_id", "linkId", "payment_link_id", "paymentLinkId", "reference"]);
  return { url, linkId: id !== null ? String(id) : null };
}

// ---- 1) La calculadora crea el cobro ---------------------------
app.post("/api/crear-cobro", (req, res) => {
  const { tagId } = req.body;
  const monto = Number(req.body.amount);

  if (!tagId || !(monto > 0)) {
    return res.status(400).json({ error: "Falta el cartel o el monto" });
  }
  if (monto < MONTO_MINIMO) {
    return res.status(400).json({ error: `El monto minimo es ${MONTO_MINIMO}` });
  }

  const sid = crypto.randomBytes(16).toString("hex"); // imposible de adivinar
  const ahora = Date.now();
  const cobro = {
    sid, tagId, amount: monto, status: "esperando",
    createdAt: ahora,
    tapExpiresAt: ahora + TAP_TTL_MS,
    payExpiresAt: ahora + PAGO_TTL_MS,
    ipnToken: crypto.randomBytes(16).toString("hex"),
    checkoutUrl: null, linkId: null, creando: null, email: null,
    valueCoin: null, txidOut: null,
  };
  payments.set(sid, cobro);
  current.set(tagId, sid);
  res.json({ ok: true, expiresInMs: TAP_TTL_MS, modo: MODO_REAL ? "real" : "prueba" });
});

// ---- 2) La calculadora consulta el estado ---------------------
app.get("/api/estado/:tagId", (req, res) => {
  const sid = current.get(req.params.tagId);
  const p = sid && payments.get(sid);
  if (!p) return res.json({ status: "ninguna" });
  res.json({ status: estadoActual(p), amount: p.amount, valueCoin: p.valueCoin });
});

// ---- Cancelar (solo si el cliente todavia no toco el NFC) -----
app.post("/api/cancelar", (req, res) => {
  const sid = current.get(req.body.tagId);
  const p = sid && payments.get(sid);
  if (p && p.status === "esperando") p.status = "cancelado";
  res.json({ ok: true });
});

// ---- 3) El cliente toca el NFC --------------------------------
app.get("/t/:tagId", (req, res) => {
  const sid = current.get(req.params.tagId);
  const p = sid && payments.get(sid);

  if (!p || estadoActual(p) !== "esperando") {
    const enCurso = p && estadoActual(p) === "pagando";
    return res.send(
      paginaMensaje(
        enCurso ? "Hay un cobro en curso" : "No hay ningun cobro activo en este momento",
        enCurso ? "Espera a que termine o pedile al comercio que genere uno nuevo."
                : "Pedile al comercio que ingrese el monto en su app."
      )
    );
  }

  if (PEDIR_EMAIL) {
    return res.redirect(302, `/email.html?sid=${p.sid}&monto=${p.amount.toFixed(2)}&moneda=${MONEDA}`);
  }
  return res.redirect(302, `/ir/${p.sid}?email=${encodeURIComponent(EMAIL_POR_DEFECTO)}`);
});

// ---- 3b) Paso final: crear el link en Rampex y mandar al cliente ----
app.get("/ir/:sid", async (req, res) => {
  const p = payments.get(req.params.sid);
  if (!p) return res.status(404).send(paginaMensaje("Cobro no encontrado"));

  const est = estadoActual(p);
  if (est === "pagado") return res.send(paginaMensaje("Este cobro ya fue pagado ✅"));
  if (est === "expirado" || est === "cancelado") {
    return res.send(paginaMensaje("Este cobro vencio", "Pedile al comercio que genere uno nuevo."));
  }

  const email = String(req.query.email || "").trim();
  const emailOk = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);
  if (!emailOk) {
    if (PEDIR_EMAIL) return res.redirect(302, `/email.html?sid=${p.sid}&monto=${p.amount.toFixed(2)}&moneda=${MONEDA}&error=1`);
    return res.status(500).send(paginaMensaje("Falta configurar EMAIL_POR_DEFECTO"));
  }

  if (!MODO_REAL) {
    p.status = "pagando";
    p.email = email;
    p.payExpiresAt = Date.now() + PAGO_TTL_MS;
    return res.redirect(302, `/checkout-demo.html?amount=${p.amount}&sid=${p.sid}`);
  }

  try {
    // Si el cliente recarga la pagina, reusamos el mismo link (no creamos otro).
    if (!p.checkoutUrl || p.email !== email) {
      if (!p.creando) {
        p.creando = crearLinkRampex(p, email).finally(() => { p.creando = null; });
      }
      const { url, linkId } = await p.creando;
      p.checkoutUrl = url;
      p.linkId = linkId;
      p.email = email;
      if (linkId) porLinkId.set(linkId, p.sid);
    }
    p.status = "pagando";
    p.payExpiresAt = Date.now() + PAGO_TTL_MS;
    return res.redirect(302, p.checkoutUrl);
  } catch (err) {
    console.error("[ERROR] No se pudo crear el link en Rampex:", err.message);
    return res.status(502).send(
      paginaMensaje("No se pudo iniciar el pago", esc(err.detalle || err.message))
    );
  }
});

app.get("/gracias", (req, res) => {
  res.send(paginaMensaje("Gracias ✅", "Si el pago se completo, el comercio lo va a ver en su pantalla."));
});

// ---- 4) Aviso de pago de Rampex (SE VERIFICA LA FIRMA, no se confia) --
function marcarPagado(p, datos) {
  p.status = "pagado";
  p.paidAt = Date.now();
  p.valueCoin = datos.valueCoin || null;
  p.txidOut = datos.txidOut || null;
  console.log(`[PAGADO] cartel=${p.tagId} monto=${p.amount} ${MONEDA} usdc_recibido=${p.valueCoin} tx=${p.txidOut}`);
}

function iguales(a, b) {
  const A = Buffer.from(String(a)), B = Buffer.from(String(b));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}

// Acepta la firma si: (a) alguna cabecera trae el HMAC-SHA256 del cuerpo
// calculado con tu webhook secret (hex o base64, con o sin prefijo, con o sin
// timestamp), o (b) alguna cabecera trae el secreto tal cual (esquema de
// "secreto compartido"). Sin el secreto nadie puede producir ninguna de las dos.
function firmaValida(req, raw) {
  const secret = RAMPEX_WEBHOOK_SECRET;
  const cuerpo = raw.toString("utf8");
  const esperados = new Set();
  const marcasDeTiempo = [""];
  for (const h of ["x-timestamp", "x-rampex-timestamp", "x-webhook-timestamp", "timestamp"]) {
    if (req.headers[h]) marcasDeTiempo.push(String(req.headers[h]));
  }
  // formato tipo Stripe: "t=123,v1=abc"
  for (const val of Object.values(req.headers)) {
    const m = /(?:^|[,;\s])t=(\d+)/.exec(String(val));
    if (m) marcasDeTiempo.push(m[1]);
  }
  for (const ts of marcasDeTiempo) {
    const mensaje = ts ? `${ts}.${cuerpo}` : cuerpo;
    const mac = crypto.createHmac("sha256", secret).update(mensaje);
    const buf = mac.digest();
    esperados.add(buf.toString("hex"));
    esperados.add(buf.toString("base64"));
  }
  for (const [nombre, valor] of Object.entries(req.headers)) {
    if (["host", "content-length", "content-type", "user-agent", "accept", "connection"].includes(nombre)) continue;
    const trozos = String(valor).split(/[,;\s]+/).flatMap((t) => [t, t.includes("=") ? t.slice(t.indexOf("=") + 1) : t]);
    for (let t of trozos) {
      t = t.replace(/^Bearer$/i, "");
      if (!t) continue;
      if (iguales(t, secret)) return true;                        // secreto compartido
      for (const e of esperados) if (iguales(t, e)) return true;  // HMAC
    }
  }
  return false;
}

const ESTADOS_PAGADO = new Set(["paid", "completed", "complete", "confirmed", "success", "succeeded", "settled", "paymentcompleted", "paymentpaid", "paymentsucceeded"]);

app.post("/api/rampex-webhook", (req, res) => {
  if (!MODO_REAL) return res.status(400).send("modo prueba");
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from("");

  if (!firmaValida(req, raw)) {
    console.log(`[AVISO RECHAZADO] firma invalida o ausente. cabeceras recibidas: ${Object.keys(req.headers).join(", ")} (cuerpo ${raw.length} bytes)`);
    return res.status(401).send("firma invalida");
  }

  let data;
  const texto = raw.toString("utf8");
  try { data = JSON.parse(texto); }
  catch (_) {
    try { data = Object.fromEntries(new URLSearchParams(texto)); } catch (_2) { data = null; }
  }
  if (!data || typeof data !== "object") return res.status(400).send("cuerpo ilegible");

  const plano = aplanar(data);

  // Ubicar el cobro: por nuestro sid (woo_order_id) o por el id del link de Rampex.
  let p = null;
  for (const [, v] of plano) {
    const s = String(v);
    if (payments.has(s)) { p = payments.get(s); break; }
  }
  if (!p) {
    for (const [, v] of plano) {
      const sid = porLinkId.get(String(v));
      if (sid) { p = payments.get(sid); break; }
    }
  }
  if (!p) {
    console.log("[AVISO] firma valida pero no reconozco el cobro. Campos:", plano.map(([k]) => k).join(", "));
    return res.status(404).send("cobro desconocido");
  }
  if (p.status === "pagado") return res.send("ok");

  // Si el aviso trae nuestro ipn_token, tiene que coincidir.
  const tokenAviso = buscarValor(plano, ["ipn_token", "ipnToken"]);
  if (tokenAviso !== null && !iguales(tokenAviso, p.ipnToken)) {
    console.log("[AVISO RECHAZADO] ipn_token no coincide");
    return res.status(401).send("token invalido");
  }

  // Estado: solo se marca pagado si dice explicitamente que esta pagado.
  const estadoCrudo = buscarValor(plano, ["status", "payment_status", "paymentStatus", "state", "event", "type"]);
  const estado = String(estadoCrudo || "").toLowerCase().replace(/[^a-z]/g, "");
  if (!ESTADOS_PAGADO.has(estado)) {
    console.log(`[AVISO] estado '${estadoCrudo}' (no es pagado). Campos: ${plano.map(([k]) => k).join(", ")}`);
    return res.status(202).send("pendiente");
  }

  // Monto: si el aviso informa monto y moneda y la moneda coincide, no puede ser menor.
  const moneda = buscarValor(plano, ["currency", "fiat_currency", "fiatCurrency"]);
  const monto = Number(buscarValor(plano, ["amount", "fiat_amount", "fiatAmount", "amount_fiat"]));
  if (moneda && String(moneda).toUpperCase() === MONEDA && Number.isFinite(monto) && monto + 0.01 < p.amount) {
    console.log(`[AVISO RECHAZADO] monto ${monto} menor al cobro ${p.amount}`);
    return res.status(400).send("monto menor");
  }

  const valueCoin = buscarValor(plano, ["value_coin", "valueCoin", "amount_out", "amountOut", "usdc_amount", "net_amount"]);
  const txidOut = buscarValor(plano, ["txid_out", "txidOut", "tx_hash", "txHash", "transaction_hash", "txid"]);
  marcarPagado(p, { valueCoin, txidOut });
  return res.send("ok");
});

// ---- Solo en MODO PRUEBA: el boton "Pagar" falso --------------
app.post("/api/demo-pagar", (req, res) => {
  if (MODO_REAL) return res.status(403).json({ error: "No disponible en modo real" });
  const p = payments.get(req.body.sid);
  if (!p) return res.status(404).json({ error: "no existe" });
  marcarPagado(p, { valueCoin: String(p.amount), txidOut: "demo" });
  res.json({ ok: true });
});

// ---- Limpieza de memoria --------------------------------------
setInterval(() => {
  const limite = Date.now() - 24 * 60 * 60 * 1000;
  for (const [sid, p] of payments) {
    if (p.createdAt < limite) {
      payments.delete(sid);
      if (p.linkId) porLinkId.delete(p.linkId);
    }
  }
}, 10 * 60 * 1000).unref();

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Cobro NFC en puerto ${PORT} — modo: ${MODO_REAL ? "REAL (Rampex)" : "PRUEBA (pago falso)"}`);
    if (!MODO_REAL) console.log(`[ATENCION] Para el modo real faltan: ${FALTAN.join(", ")}`);
    if (MODO_REAL) console.log(`[OK] Aviso de pago en: ${BASE_URL}/api/rampex-webhook  (cargalo como Webhook URL en el panel de Rampex)`);
    if (!PEDIR_EMAIL && !EMAIL_POR_DEFECTO) console.log("[ATENCION] PEDIR_EMAIL=no pero falta EMAIL_POR_DEFECTO");
  });
}
module.exports = app;
