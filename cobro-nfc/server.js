// ============================================================
// COBRO NFC — conectado a Rampex (tarjeta/Apple Pay -> USDC en Polygon)
// ============================================================
// Flujo:
//   1) Tipeas el monto en la calculadora      -> POST /api/crear-cobro
//   2) El cliente toca el NFC                  -> /t/AB12 -> pantalla de email
//   3) El cliente pone su email                -> /ir/<sid>
//      Ahi creamos el link de pago en Rampex (necesita el email) y lo
//      mandamos al checkout.
//   4) Cuando paga, Rampex llama a /api/rampex-webhook. Ese aviso viene
//      FIRMADO: si la firma no coincide con tu secreto, se descarta.
//
// Variables de entorno (panel de Render):
//   RAMPEX_API_KEY         tu API key de Rampex.   (si falta -> MODO PRUEBA)
//   RAMPEX_WEBHOOK_SECRET  tu webhook secret de Rampex.
//   MONEDA                 EUR por defecto.
//   RAMPEX_PROVIDER_TITULAR   "banxa"  (primer medio que se intenta)
//   RAMPEX_PROVIDER_SUPLENTE  "revolut" (si el titular falla o no esta disponible)
//   ELEGIR_MEDIO              "si" (defecto): el cliente ve dos botones (Banxa / Revolut) y elige.
//                             "no": va directo al titular (Banxa), sin elegir.
//   RAMPEX_PROVIDER_FINAL     "hosted" (ultimo recurso: el cliente elige entre los disponibles)
//   Si los nombres no coinciden con los de Rampex, el sistema NO se rompe: cae al
//   siguiente de la lista. Los nombres exactos estan en "Payment Providers" de su API.
//   PEDIR_EMAIL            "si" (defecto) / "no" (usa EMAIL_POR_DEFECTO).
//   EMAIL_POR_DEFECTO      solo si PEDIR_EMAIL=no.
// La wallet donde cobras se configura en el panel de Rampex
// ("Default Polygon Wallet"), no aca.
// ============================================================

const express = require("express");
const path = require("path");
const crypto = require("crypto");

const app = express();
// El webhook necesita el cuerpo CRUDO para poder verificar la firma.
app.use("/api/rampex-webhook", express.raw({ type: "*/*", limit: "200kb" }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ---- Tiempos --------------------------------------------------
const TAP_TTL_MS = 45 * 1000;        // 45s para que el cliente toque el NFC
const PAGO_TTL_MS = 10 * 60 * 1000;  // despues del toque, 10 min para pagar

// ---- Configuracion --------------------------------------------
const RAMPEX_API_KEY = (process.env.RAMPEX_API_KEY || "").trim();
const RAMPEX_WEBHOOK_SECRET = (process.env.RAMPEX_WEBHOOK_SECRET || "").trim();
const RAMPEX_API = (process.env.RAMPEX_API_BASE || "https://api.rampex.io").replace(/\/$/, "");
const BASE_URL = (process.env.BASE_URL || process.env.RENDER_EXTERNAL_URL || "").replace(/\/$/, "");
const MONEDA = (process.env.MONEDA || "EUR").toUpperCase();
// Orden de intento al crear el link de pago: titular -> suplente -> final.
const PROV_TITULAR = (process.env.RAMPEX_PROVIDER_TITULAR || "banxa").trim();
const PROV_SUPLENTE = (process.env.RAMPEX_PROVIDER_SUPLENTE || "revolut").trim();
const PROV_FINAL = (process.env.RAMPEX_PROVIDER_FINAL || "hosted").trim();
const ELEGIR_MEDIO = (process.env.ELEGIR_MEDIO || "si").toLowerCase() === "si";
// Los dos botones que ve el cliente: titular y suplente (sin repetir ni incluir "hosted").
const BOTONES = [...new Set([PROV_TITULAR, PROV_SUPLENTE].filter((x) => x && x !== PROV_FINAL))];
const ORDEN_PROVEEDORES = [...new Set([PROV_TITULAR, PROV_SUPLENTE, PROV_FINAL].filter(Boolean))];
const PEDIR_EMAIL = (process.env.PEDIR_EMAIL || "si").toLowerCase() === "si";
const EMAIL_POR_DEFECTO = (process.env.EMAIL_POR_DEFECTO || "").trim();
const MONTO_MINIMO = Number(process.env.MONTO_MINIMO || 1);
const MOSTRAR_DETALLE = (process.env.MOSTRAR_DETALLE_ERRORES || "si").toLowerCase() === "si";
const MODO_REAL = !!RAMPEX_API_KEY;

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

function escapar(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// Recorre cualquier JSON y devuelve todos los textos/numeros con su nombre de campo.
function recolectarValores(obj, clave = "", out = []) {
  if (obj === null || obj === undefined) return out;
  if (Array.isArray(obj)) { obj.forEach((x) => recolectarValores(x, clave, out)); return out; }
  if (typeof obj === "object") {
    for (const [k, v] of Object.entries(obj)) recolectarValores(v, k, out);
    return out;
  }
  out.push({ key: clave, value: String(obj) });
  return out;
}


function etiquetaMedio(m) {
  const n = m.toLowerCase();
  if (n === "banxa") return `Tarjeta, Apple Pay o Google Pay<small>Banxa</small>`;
  if (n === "revolut") return `Revolut<small>Si tenés cuenta de Revolut</small>`;
  return escapar(m.charAt(0).toUpperCase() + m.slice(1));
}

function paginaElegir(p) {
  const simbolo = MONEDA === "EUR" ? "€" : MONEDA + " ";
  const botones = BOTONES.map(
    (m) => `<a class="btn" href="/elegir/${p.sid}/${encodeURIComponent(m)}">${etiquetaMedio(m)}</a>`
  ).join("");
  return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1"><title>Pagar</title>
  <style>
    body{font-family:-apple-system,system-ui,sans-serif;background:#f5f5f7;margin:0;padding:24px;
         display:flex;align-items:center;justify-content:center;min-height:100vh}
    .card{background:#fff;border-radius:20px;padding:28px;max-width:360px;width:100%;text-align:center;
          box-shadow:0 10px 30px rgba(0,0,0,.1)}
    .monto{font-size:44px;font-weight:800;margin:6px 0 22px}
    .btn{display:block;background:#000;color:#fff;text-decoration:none;border-radius:14px;padding:18px;
         font-size:19px;font-weight:600;margin-top:12px}
    .btn small{display:block;font-size:13px;font-weight:400;opacity:.7;margin-top:4px}
  </style></head><body><div class="card">
    <div>Total a pagar</div><div class="monto">${simbolo}${p.amount.toFixed(2)}</div>
    <div>¿Cómo querés pagar?</div>${botones}
  </div>
  <script>
    var yaElegido = false;
    document.querySelectorAll(".btn").forEach(function (b) {
      b.addEventListener("click", function (e) {
        if (yaElegido) { e.preventDefault(); return; }
        yaElegido = true;
        document.querySelectorAll(".btn").forEach(function (x) { if (x !== b) x.style.opacity = ".3"; });
        b.innerHTML = "Conectando…<small>Esto puede tardar unos segundos</small>";
      });
    });
  </script></body></html>`;
}

// ---- Rampex: crear el link de pago ----------------------------
async function crearLinkEnRampex(p, email, proveedor) {
  const resp = await fetch(`${RAMPEX_API}/api-create-payment-link`, {
    method: "POST",
    headers: { "X-API-Key": RAMPEX_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      amount: Number(p.amount.toFixed(2)),
      currency: MONEDA,
      customer_email: email,
      description: "Pago en mostrador",
      provider: proveedor,
      ipn_token: p.refToken, // nuestro identificador para reconocer el pago despues
    }),
  });

  const texto = await resp.text();
  let data = null;
  try { data = JSON.parse(texto); } catch (e) {}
  if (!resp.ok || !data) {
    throw new Error(`Rampex respondio ${resp.status}: ${texto.slice(0, 300)}`);
  }

  const valores = recolectarValores(data);
  const urls = valores.filter((v) => /^https?:\/\//i.test(v.value));
  // Preferimos el link largo; si no hay, el corto.
  const elegido = urls.find((v) => !/short/i.test(v.key)) || urls[0];
  if (!elegido) {
    throw new Error("Rampex no devolvio un link de pago reconocible: " + texto.slice(0, 300));
  }

  // Identificadores que Rampex pueda repetir en el aviso de pago.
  const refs = valores
    .map((v) => v.value)
    .filter((v) => /^[A-Za-z0-9_-]{8,64}$/.test(v) || (/^https?:\/\//i.test(v) && v.length > 30));

  return { url: elegido.value, refs: [...new Set(refs)] };
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

  const sid = crypto.randomBytes(16).toString("hex");
  const ahora = Date.now();
  payments.set(sid, {
    sid, tagId, amount: monto, status: "esperando",
    refToken: crypto.randomBytes(8).toString("hex"),
    createdAt: ahora,
    tapExpiresAt: ahora + TAP_TTL_MS,
    payExpiresAt: ahora + PAGO_TTL_MS,
    email: null, checkoutUrl: null, linkRefs: [],
    valueCoin: null, txidOut: null,
  });
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

// ---- Cancelar (solo si el cliente todavia no llego al checkout) --
app.post("/api/cancelar", (req, res) => {
  const sid = current.get(req.body.tagId);
  const p = sid && payments.get(sid);
  if (p && (p.status === "esperando" || (p.status === "pagando" && !p.checkoutUrl))) {
    p.status = "cancelado";
  }
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

  if (ELEGIR_MEDIO && BOTONES.length > 1) {
    // Desde el toque el cobro queda "en curso": nadie mas puede tomarlo.
    p.status = "pagando";
    p.payExpiresAt = Date.now() + PAGO_TTL_MS;
    return res.redirect(302, `/elegir/${sid}`);
  }

  if (PEDIR_EMAIL) {
    // Desde el toque el cobro queda "en curso": nadie mas puede tomarlo
    // y el cliente tiene tiempo de sobra para escribir su email.
    p.status = "pagando";
    p.payExpiresAt = Date.now() + PAGO_TTL_MS;
    return res.redirect(302, `/email.html?sid=${sid}&monto=${p.amount.toFixed(2)}&moneda=${MONEDA}`);
  }
  return res.redirect(302, `/ir/${sid}?email=${encodeURIComponent(EMAIL_POR_DEFECTO)}`);
});


// ---- 3a) El cliente elige: Banxa o Revolut ----------------------
function siguientePaso(p) {
  if (PEDIR_EMAIL) return `/email.html?sid=${p.sid}&monto=${p.amount.toFixed(2)}&moneda=${MONEDA}`;
  return `/ir/${p.sid}?email=${encodeURIComponent(EMAIL_POR_DEFECTO)}`;
}

app.get("/elegir/:sid", (req, res) => {
  const p = payments.get(req.params.sid);
  if (!p) return res.status(404).send(paginaMensaje("Cobro no encontrado"));
  const est = estadoActual(p);
  if (est === "pagado") return res.send(paginaMensaje("Este cobro ya fue pagado ✅"));
  if (est === "expirado" || est === "cancelado") {
    return res.send(paginaMensaje("Este cobro vencio", "Pedile al comercio que genere uno nuevo."));
  }
  if (p.checkoutUrl) return res.redirect(302, p.checkoutUrl);
  res.send(paginaElegir(p));
});

app.get("/elegir/:sid/:medio", (req, res) => {
  const p = payments.get(req.params.sid);
  if (!p) return res.status(404).send(paginaMensaje("Cobro no encontrado"));
  if (p.checkoutUrl) return res.redirect(302, p.checkoutUrl);
  if (!BOTONES.includes(req.params.medio)) return res.redirect(302, `/elegir/${p.sid}`);
  p.medio = req.params.medio;
  res.redirect(302, siguientePaso(p));
});

// ---- 3b) Armar el link de pago y mandar al cliente ------------
app.get("/ir/:sid", async (req, res) => {
  const p = payments.get(req.params.sid);
  if (!p) return res.status(404).send(paginaMensaje("Cobro no encontrado"));

  const est = estadoActual(p);
  if (est === "pagado") return res.send(paginaMensaje("Este cobro ya fue pagado ✅"));
  if (est === "expirado" || est === "cancelado") {
    return res.send(paginaMensaje("Este cobro vencio", "Pedile al comercio que genere uno nuevo."));
  }
  // Si ya tiene link creado, el cliente simplemente vuelve al mismo checkout.
  if (p.checkoutUrl) return res.redirect(302, p.checkoutUrl);

  const email = String(req.query.email || "").trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    if (PEDIR_EMAIL) return res.redirect(302, `/email.html?sid=${p.sid}&monto=${p.amount.toFixed(2)}&moneda=${MONEDA}&error=1`);
    return res.status(500).send(paginaMensaje("Falta configurar EMAIL_POR_DEFECTO"));
  }

  p.status = "pagando";
  p.email = email;
  p.payExpiresAt = Date.now() + PAGO_TTL_MS;

  if (!MODO_REAL) {
    p.checkoutUrl = `/checkout-demo.html?amount=${p.amount}&sid=${p.sid}`;
    return res.redirect(302, p.checkoutUrl);
  }

  // Probamos titular -> suplente -> final. El primero que responda con un link gana.
  const fallos = [];
  const orden = p.medio ? [p.medio, ...ORDEN_PROVEEDORES.filter((x) => x !== p.medio)] : ORDEN_PROVEEDORES;
  for (const proveedor of orden) {
    try {
      const t0 = Date.now();
      const { url, refs } = await crearLinkEnRampex(p, email, proveedor);
      const tardo = Date.now() - t0;
      p.checkoutUrl = url;
      p.linkRefs = refs;
      p.proveedor = proveedor;
      console.log(`[PROVEEDOR] cartel=${p.tagId} monto=${p.amount} usado=${proveedor} tardo=${tardo}ms` +
                  (fallos.length ? ` (antes fallaron: ${fallos.map((f) => f.proveedor).join(", ")})` : ""));
      return res.redirect(302, url);
    } catch (err) {
      console.error(`[PROVEEDOR] fallo "${proveedor}":`, err.message);
      fallos.push({ proveedor, mensaje: err.message });
    }
  }

  p.status = "cancelado";
  const detalle = fallos.map((f) => `${escapar(f.proveedor)}: ${escapar(f.mensaje)}`).join("<br>");
  return res.status(502).send(
    paginaMensaje(
      "No se pudo iniciar el pago",
      MOSTRAR_DETALLE ? `<small>${detalle}</small>` : "Proba de nuevo en un momento."
    )
  );
});

// ---- 4) Aviso de pago de Rampex (FIRMADO) ----------------------
function marcarPagado(p, datos) {
  p.status = "pagado";
  p.paidAt = Date.now();
  p.valueCoin = datos.valueCoin || null;
  console.log(`[PAGADO] cartel=${p.tagId} monto=${p.amount} ${MONEDA} usdc=${p.valueCoin || "?"}`);
}

function firmaValida(raw, headerFirma) {
  if (!RAMPEX_WEBHOOK_SECRET) return false;
  const firma = String(headerFirma || "").trim().toLowerCase().replace(/^sha256=/, "");
  const esperada = crypto.createHmac("sha256", RAMPEX_WEBHOOK_SECRET).update(raw).digest("hex");
  if (firma.length !== esperada.length) return false;
  return crypto.timingSafeEqual(Buffer.from(firma), Buffer.from(esperada));
}

app.post("/api/rampex-webhook", (req, res) => {
  if (!RAMPEX_WEBHOOK_SECRET) {
    console.log("[WEBHOOK] llego un aviso pero falta RAMPEX_WEBHOOK_SECRET: se descarta");
    return res.status(503).send("webhook secret no configurado");
  }
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from("");

  if (!firmaValida(raw, req.get("x-rampex-signature"))) {
    console.log("[WEBHOOK] firma invalida o ausente: se descarta");
    return res.status(401).send("bad signature");
  }

  let data;
  try { data = JSON.parse(raw.toString("utf8")); } catch (e) { return res.status(400).send("bad json"); }
  console.log("[WEBHOOK] aviso valido:", JSON.stringify(data).slice(0, 800));

  const valores = recolectarValores(data);
  const textos = valores.map((v) => v.value);

  // Estado del pago segun el aviso
  const estados = valores.filter((v) => /status|event|type|state/i.test(v.key)).map((v) => v.value.toLowerCase());
  const malo = estados.some((v) => /(fail|cancel|expire|refund|reject|declin|pend)/.test(v));
  const bueno = estados.some((v) => /(paid|success|succeed|complet|confirm|settled|approv)/.test(v));
  if (estados.length && (malo || !bueno)) {
    console.log("[WEBHOOK] el aviso no indica pago completado:", estados.join(", "));
    return res.send("ok");
  }
  if (!estados.length) console.log("[AVISO] el aviso no trae campo de estado; se toma como pago confirmado");

  // Reconocer a que cobro pertenece
  const candidatos = [...payments.values()].filter((c) => c.status === "pagando");
  let p = candidatos.find((c) => textos.includes(c.refToken))
       || candidatos.find((c) => c.linkRefs.some((r) => textos.includes(r)));
  if (!p) {
    const montosAviso = valores.map((v) => Number(v.value)).filter((n) => !Number.isNaN(n));
    p = candidatos
      .filter((c) => c.email && textos.some((t) => t.toLowerCase() === c.email.toLowerCase())
                     && montosAviso.some((n) => Math.abs(n - c.amount) < 0.01))
      .sort((a, b) => b.createdAt - a.createdAt)[0];
  }
  if (!p) {
    console.log("[WEBHOOK] aviso valido pero no pude asociarlo a ningun cobro en curso");
    return res.send("ok");
  }

  const usdc = valores.find((v) => /usdc|value_coin|settle|payout|received/i.test(v.key) && !Number.isNaN(Number(v.value)));
  marcarPagado(p, { valueCoin: usdc ? usdc.value : null });
  res.send("ok");
});

// ---- Solo en MODO PRUEBA: el boton "Pagar" falso --------------
app.post("/api/demo-pagar", (req, res) => {
  if (MODO_REAL) return res.status(403).json({ error: "No disponible en modo real" });
  const p = payments.get(req.body.sid);
  if (!p) return res.status(404).json({ error: "no existe" });
  marcarPagado(p, { valueCoin: String(p.amount) });
  res.json({ ok: true });
});

// ---- Limpieza de memoria --------------------------------------
setInterval(() => {
  const limite = Date.now() - 24 * 60 * 60 * 1000;
  for (const [sid, p] of payments) if (p.createdAt < limite) payments.delete(sid);
}, 10 * 60 * 1000).unref();

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Cobro NFC en puerto ${PORT} — modo: ${MODO_REAL ? "REAL (Rampex)" : "PRUEBA (pago falso)"}`);
  if (MODO_REAL) {
    console.log(`Orden de medios de pago: ${ORDEN_PROVEEDORES.join(" -> ")}`);
    console.log(`El cliente elige el medio: ${ELEGIR_MEDIO && BOTONES.length > 1 ? "SI (botones " + BOTONES.join(" / ") + ")" : "no (va directo al titular)"}`);
    console.log(`Webhook para pegar en Rampex: ${BASE_URL || "(falta BASE_URL)"}/api/rampex-webhook`);
    if (!RAMPEX_WEBHOOK_SECRET) console.log("[ATENCION] Falta RAMPEX_WEBHOOK_SECRET: no se van a poder confirmar los pagos");
  }
  if (!PEDIR_EMAIL && !EMAIL_POR_DEFECTO) console.log("[ATENCION] PEDIR_EMAIL=no pero falta EMAIL_POR_DEFECTO");
});
