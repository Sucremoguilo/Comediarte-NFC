// ============================================================
// COBRO NFC — conectado a Chain2Pay (tarjeta/Apple Pay -> USDC en Polygon)
// ============================================================
// Flujo:
//   1) Tipeas el monto en la calculadora  -> POST /api/crear-cobro
//   2) El servidor le pide a Chain2Pay una "direccion de cobro" unica
//      (wallet.php) ligada a TU wallet y a una URL de aviso (callback).
//   3) El cliente toca el NFC -> /t/AB12 -> (pide email) -> /ir/<sid>
//      -> lo mandamos al checkout de Chain2Pay con el monto.
//   4) Cuando paga, Chain2Pay llama a /api/callback. Nosotros NO nos
//      creemos el aviso: lo verificamos preguntandole a Chain2Pay
//      (payment-status.php) antes de marcar "pagado".
//
// Variables de entorno (se cargan en el panel de Render / tu servidor):
//   MERCHANT_WALLET  tu direccion USDC en Polygon (0x...). Si falta,
//                    el sistema corre en MODO PRUEBA (pago falso).
//   BASE_URL         la URL publica de tu servidor. En Render se toma sola.
//   MONEDA           EUR por defecto.
//   PEDIR_EMAIL      "si" (defecto) pide el email al cliente antes de pagar.
//                    "no" usa EMAIL_POR_DEFECTO para todos.
//   EMAIL_POR_DEFECTO  solo se usa si PEDIR_EMAIL=no.
// ============================================================

const express = require("express");
const path = require("path");
const crypto = require("crypto");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ---- Tiempos --------------------------------------------------
const TAP_TTL_MS = 45 * 1000;        // el cliente tiene 45s para tocar el NFC
const PAGO_TTL_MS = 10 * 60 * 1000;  // una vez que toco, 10 min para pagar

// ---- Configuracion --------------------------------------------
const MERCHANT_WALLET = (process.env.MERCHANT_WALLET || "").trim();
const BASE_URL = (process.env.BASE_URL || process.env.RENDER_EXTERNAL_URL || "").replace(/\/$/, "");
const MONEDA = (process.env.MONEDA || "EUR").toUpperCase();
const PEDIR_EMAIL = (process.env.PEDIR_EMAIL || "si").toLowerCase() === "si";
const EMAIL_POR_DEFECTO = (process.env.EMAIL_POR_DEFECTO || "").trim();
const C2P_API = process.env.C2P_API_BASE || "https://api.chain2pay.net/control/";
const C2P_CHECKOUT = process.env.C2P_CHECKOUT_BASE || "https://checkout.chain2pay.net/";

const WALLET_OK = /^0x[a-fA-F0-9]{40}$/.test(MERCHANT_WALLET);
const MODO_REAL = WALLET_OK && !!BASE_URL;
const MONTO_MINIMO = 1;

// ---- Estado en memoria ----------------------------------------
const payments = new Map(); // sid -> cobro
const current = new Map();  // tagId -> sid del cobro vigente en ese cartel

function estadoActual(p) {
  if (p.status === "pagado" || p.status === "cancelado") return p.status;
  const ahora = Date.now();
  if (p.status === "esperando" && ahora > p.tapExpiresAt) return "expirado";
  if (p.status === "pagando" && ahora > p.payExpiresAt) return "expirado";
  return p.status;
}

function paginaMensaje(titulo, detalle) {
  return `<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head>
  <body style="font-family:sans-serif;text-align:center;padding:40px">
    <h2>${titulo}</h2><p>${detalle || ""}</p></body></html>`;
}

// ---- Chain2Pay -------------------------------------------------
async function crearCobroEnChain2Pay(sid) {
  const callback = `${BASE_URL}/api/callback?sid=${sid}`;
  const url =
    `${C2P_API}wallet.php?address=${encodeURIComponent(MERCHANT_WALLET)}` +
    `&callback=${encodeURIComponent(callback)}`;

  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`wallet.php respondio ${resp.status}`);
  const data = await resp.json();
  if (!data.address_in || !data.ipn_token) {
    throw new Error("Respuesta inesperada de wallet.php: " + JSON.stringify(data));
  }
  // address_in ya viene listo para usar en la URL (con %3D etc). No lo re-codifiques.
  return { addressIn: data.address_in, ipnToken: data.ipn_token };
}

// ---- 1) La calculadora crea el cobro ---------------------------
app.post("/api/crear-cobro", async (req, res) => {
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
    addressIn: null, ipnToken: null, email: null,
    valueCoin: null, txidOut: null,
  };

  try {
    if (MODO_REAL) {
      const { addressIn, ipnToken } = await crearCobroEnChain2Pay(sid);
      cobro.addressIn = addressIn;
      cobro.ipnToken = ipnToken;
    }
    payments.set(sid, cobro);
    current.set(tagId, sid);
    res.json({ ok: true, expiresInMs: TAP_TTL_MS, modo: MODO_REAL ? "real" : "prueba" });
  } catch (err) {
    console.error("Error creando cobro:", err);
    res.status(502).json({ error: "No se pudo crear el cobro en el proveedor" });
  }
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
    return res.redirect(302, `/email.html?sid=${sid}&monto=${p.amount.toFixed(2)}&moneda=${MONEDA}`);
  }
  return res.redirect(302, `/ir/${sid}?email=${encodeURIComponent(EMAIL_POR_DEFECTO)}`);
});

// ---- 3b) Paso final: armar el checkout y mandar al cliente ----
app.get("/ir/:sid", (req, res) => {
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

  p.status = "pagando";
  p.email = email;
  p.payExpiresAt = Date.now() + PAGO_TTL_MS;

  if (!MODO_REAL) {
    return res.redirect(302, `/checkout-demo.html?amount=${p.amount}&sid=${p.sid}`);
  }

  const checkoutUrl =
    `${C2P_CHECKOUT}pay.php?address=${p.addressIn}` +
    `&amount=${p.amount.toFixed(2)}` +
    `&currency=${MONEDA}` +
    `&email=${encodeURIComponent(email)}`;
  res.redirect(302, checkoutUrl);
});

// ---- 4) Aviso de pago de Chain2Pay (SE VERIFICA, no se confia) --
function marcarPagado(p, datos) {
  p.status = "pagado";
  p.paidAt = Date.now();
  p.valueCoin = datos.value_coin || null;
  p.txidOut = datos.txid_out || null;
  console.log(`[PAGADO] cartel=${p.tagId} monto=${p.amount} ${MONEDA} usdc_recibido=${p.valueCoin} tx=${p.txidOut}`);
}

app.get("/api/callback", async (req, res) => {
  const p = payments.get(String(req.query.sid || ""));
  if (!p) return res.status(404).send("unknown");
  if (p.status === "pagado") return res.send("*ok*");
  if (!MODO_REAL) return res.status(400).send("modo prueba");

  try {
    const url = `${C2P_API}payment-status.php?ipn_token=${encodeURIComponent(p.ipnToken)}`;
    const r = await fetch(url);
    const data = await r.json();
    if (data.status === "paid") {
      marcarPagado(p, data);
      return res.send("*ok*");
    }
    console.log("[AVISO] callback recibido pero el estado todavia no es 'paid':", data);
    return res.status(202).send("pending");
  } catch (err) {
    console.error("Error verificando el pago:", err);
    return res.status(500).send("error");
  }
});

// ---- Solo en MODO PRUEBA: el boton "Pagar" falso --------------
app.post("/api/demo-pagar", (req, res) => {
  if (MODO_REAL) return res.status(403).json({ error: "No disponible en modo real" });
  const p = payments.get(req.body.sid);
  if (!p) return res.status(404).json({ error: "no existe" });
  marcarPagado(p, { value_coin: String(p.amount), txid_out: "demo" });
  res.json({ ok: true });
});

// ---- Limpieza de memoria --------------------------------------
setInterval(() => {
  const limite = Date.now() - 24 * 60 * 60 * 1000;
  for (const [sid, p] of payments) if (p.createdAt < limite) payments.delete(sid);
}, 10 * 60 * 1000).unref();

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Cobro NFC en puerto ${PORT} — modo: ${MODO_REAL ? "REAL (Chain2Pay)" : "PRUEBA (pago falso)"}`);
  if (MERCHANT_WALLET && !WALLET_OK) console.log("[ATENCION] MERCHANT_WALLET no parece una direccion 0x valida");
  if (WALLET_OK && !BASE_URL) console.log("[ATENCION] Falta BASE_URL: sin eso Chain2Pay no puede avisarte del pago");
  if (!PEDIR_EMAIL && !EMAIL_POR_DEFECTO) console.log("[ATENCION] PEDIR_EMAIL=no pero falta EMAIL_POR_DEFECTO");
});
