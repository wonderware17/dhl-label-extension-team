// Service Worker — DHL API Calls + History-Persistenz
// Manifest V3 module worker.

try { importScripts("lib/pdf-lib.min.js"); } catch (e) { console.warn("pdf-lib import failed:", e); }

const SHIPPER_LOGOS = {
  czsshop: "icons/shop-logo.png",
};

const SANDBOX_URL = "https://api-sandbox.dhl.com/parcel/de/shipping/v2";
const PRODUCTION_URL = "https://api-eu.dhl.com/parcel/de/shipping/v2";
const RETURNS_SANDBOX_URL = "https://api-sandbox.dhl.com/parcel/de/shipping/returns/v1";
const RETURNS_PRODUCTION_URL = "https://api-eu.dhl.com/parcel/de/shipping/returns/v1";

// Sales/Produkte/Discord laufen primär über das lokale Flask-Backend,
// damit Web-App und Extension auf denselben State zugreifen.
// Wenn Flask nicht erreichbar ist, fällt die Extension transparent
// auf chrome.storage + direkten Discord-Post zurück.
const FLASK_URL = "http://localhost:5000";
// Team-Version: kein hardcoded Default-Webhook — Empfänger werden via Settings angelegt
const DISCORD_SALES_WEBHOOK_URL_DEFAULT = "";

const DEFAULT_SETTINGS = {
  api_key: "",
  username: "",
  password: "",
  sandbox: false,
  auto_print: false,
  print_format: "910-300-400", // 100×150mm — passt für die meisten Thermo-Label-Drucker (POLONO PL60 etc.)
  billing_paket: "",
  billing_paeckchen: "",
  billing_returns: "",
  returns_receiver_id: "",
  shippers: [],
  // Lokaler Fallback-State, falls Flask nicht erreichbar:
  products: [],
  // Multi-Empfänger Sales-State:
  recipients: [],
  sessions: {}, // { recipientId: { started_at, discord_message_id, items } }
  last_recipient_id: null,
};

// --- Settings -------------------------------------------------------------

function emptyLocalSession() {
  return { started_at: null, discord_message_ids: [], items: [] };
}

function migrateLocalSettings(raw) {
  const s = { ...DEFAULT_SETTINGS, ...(raw || {}) };
  // v1 → v2: alter Schlüssel sales_session in recipients/sessions migrieren
  if (raw && raw.sales_session && !s.recipients.length) {
    const christianId = "christian";
    s.recipients = [
      { id: christianId, name: "Christian", webhook_url: DISCORD_SALES_WEBHOOK_URL_DEFAULT },
    ];
    const oldId = raw.sales_session.discord_message_id;
    s.sessions = {
      [christianId]: {
        started_at: raw.sales_session.started_at || null,
        discord_message_ids: oldId ? [oldId] : [],
        items: raw.sales_session.items || [],
      },
    };
    s.last_recipient_id = christianId;
  }
  // sicherstellen, dass Strukturen da sind
  if (!Array.isArray(s.recipients)) s.recipients = [];
  if (!s.sessions || typeof s.sessions !== "object") s.sessions = {};
  // v2 → v3 Migration: discord_message_id (str) → discord_message_ids (list)
  for (const rid of Object.keys(s.sessions)) {
    const sess = s.sessions[rid];
    if (!sess || typeof sess !== "object") continue;
    if (!Array.isArray(sess.discord_message_ids)) {
      const legacy = sess.discord_message_id;
      sess.discord_message_ids = legacy ? [legacy] : [];
    }
    delete sess.discord_message_id;
  }
  // alten Schlüssel verwerfen, damit er nicht wieder migriert wird
  delete s.sales_session;
  return s;
}

async function getSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  const merged = migrateLocalSettings(settings);
  // Migration persistieren, damit der alte Key entfernt bleibt
  if (settings && (settings.sales_session !== undefined || !settings.recipients)) {
    await chrome.storage.local.set({ settings: merged });
  }
  return merged;
}

function findRecipient(settings, recipientId) {
  const rid = (recipientId || "").trim() || settings.last_recipient_id || "";
  if (rid) {
    const r = (settings.recipients || []).find((x) => x.id === rid);
    if (r) return r;
  }
  return (settings.recipients || [])[0] || null;
}

// --- DHL API --------------------------------------------------------------

function extractError(data, status) {
  const msgs = [];
  if (data && data.status && typeof data.status === "object") {
    if (data.status.title) msgs.push(data.status.title);
    if (data.status.detail) msgs.push(data.status.detail);
  }
  for (const item of (data && data.items) || []) {
    if (item.sstatus && item.sstatus.detail) msgs.push(item.sstatus.detail);
    for (const vm of item.validationMessages || []) {
      if (vm.validationMessage) {
        msgs.push(vm.property ? `${vm.property}: ${vm.validationMessage}` : vm.validationMessage);
      }
    }
  }
  if (!msgs.length) msgs.push(`HTTP ${status} — Unbekannter Fehler`);
  return msgs.join(" | ");
}

async function createShipment(req) {
  const settings = await getSettings();

  if (!settings.api_key || !settings.username || !settings.password) {
    return { success: false, error: "Bitte zuerst API-Zugangsdaten in den Einstellungen hinterlegen." };
  }
  if (!settings.shippers || !settings.shippers.length) {
    return { success: false, error: "Kein Absender konfiguriert. Bitte in den Einstellungen anlegen." };
  }

  const baseUrl = settings.sandbox ? SANDBOX_URL : PRODUCTION_URL;
  const billing = req.product === "V62KP" ? settings.billing_paeckchen : settings.billing_paket;
  if (!billing) {
    return { success: false, error: "Keine Abrechnungsnummer für dieses Produkt hinterlegt." };
  }

  const idx = Math.max(0, Math.min(parseInt(req.shipper_index || 0, 10), settings.shippers.length - 1));
  const shipper = settings.shippers[idx];
  const weightInGrams = Math.round(parseFloat(req.weight) * 1000);

  // Consignee je nach Adresstyp aufbauen
  let consignee;
  switch (req.addr_type) {
    case "packstation":
      // Locker-Empfänger: DHL erwartet "name" (nicht "name1") und kein "name2"
      consignee = {
        name: req.name,
        keyword: "PACKSTATION",
        lockerID: parseInt(req.street_number, 10),
        postNumber: String(req.street),
        postalCode: req.postal_code,
        city: req.city,
        country: "DEU",
      };
      break;
    case "filiale":
      // Postfiliale: gleiches Locker-Schema wie Packstation, nur keyword="FILIALE"
      consignee = {
        name: req.name,
        keyword: "FILIALE",
        lockerID: parseInt(req.street_number, 10),
        postalCode: req.postal_code,
        city: req.city,
        country: "DEU",
      };
      if (req.street) consignee.postNumber = String(req.street); // optional bei Filiale Direkt
      break;
    case "postfach":
      consignee = {
        name1: req.name,
        addressStreet: "Postfach",
        addressHouse: req.street, // Postfach-Nummer
        postalCode: req.postal_code,
        city: req.city,
        country: "DEU",
      };
      break;
    case "street":
    default:
      consignee = {
        name1: req.name,
        addressStreet: req.street,
        addressHouse: req.street_number,
        postalCode: req.postal_code,
        city: req.city,
        country: "DEU",
      };
  }
  // name2 nur bei Hausanschrift / Postfach — Locker und PostOffice akzeptieren kein name2.
  if (req.name2 && (req.addr_type === "street" || req.addr_type === "postfach")) {
    consignee.name2 = req.name2;
  }

  const payload = {
    profile: "STANDARD_GRUPPENPROFIL",
    shipments: [
      {
        product: req.product,
        billingNumber: billing,
        refNo: req.ref_no,
        shipper: {
          name1: shipper.name,
          addressStreet: shipper.street,
          addressHouse: shipper.street_number,
          postalCode: shipper.postal_code,
          city: shipper.city,
          country: shipper.country || "DEU",
        },
        consignee,
        details: {
          weight: { uom: "g", value: weightInGrams },
        },
      },
    ],
  };

  const params = new URLSearchParams({ validate: "false", mustEncode: "false" });
  if (settings.print_format) params.set("printFormat", settings.print_format);
  const url = `${baseUrl}/orders?${params.toString()}`;
  const credentials = btoa(`${settings.username}:${settings.password}`);

  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "dhl-api-key": settings.api_key,
        Authorization: `Basic ${credentials}`,
      },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    return { success: false, error: "Verbindungsfehler: " + e.message };
  }

  let data = {};
  try {
    data = await response.json();
  } catch (_) {
    return { success: false, error: `HTTP ${response.status} — Antwort konnte nicht gelesen werden.` };
  }

  if (response.ok) {
    const item = (data.items || [])[0];
    if (item) {
      return {
        success: true,
        shipment_number: item.shipmentNo || "",
        label_pdf_base64: (item.label && item.label.b64) || "",
        label_url: (item.label && item.label.url) || "",
        sandbox: settings.sandbox,
      };
    }
    return { success: false, error: "Keine Sendungsdaten in der Antwort." };
  }

  return { success: false, error: extractError(data, response.status) };
}

// --- DHL Storno (DELETE /orders) -----------------------------------------

async function cancelShipment(shipmentNo) {
  const sn = String(shipmentNo || "").trim();
  if (!sn) return { success: false, error: "Keine Sendungsnummer übergeben." };

  const settings = await getSettings();
  if (!settings.api_key || !settings.username || !settings.password) {
    return { success: false, error: "Bitte zuerst API-Zugangsdaten in den Einstellungen hinterlegen." };
  }

  const baseUrl = settings.sandbox ? SANDBOX_URL : PRODUCTION_URL;
  const url = `${baseUrl}/orders?shipment=${encodeURIComponent(sn)}&profile=STANDARD_GRUPPENPROFIL`;
  const credentials = btoa(`${settings.username}:${settings.password}`);

  let response;
  try {
    response = await fetch(url, {
      method: "DELETE",
      headers: {
        Accept: "application/json",
        "dhl-api-key": settings.api_key,
        Authorization: `Basic ${credentials}`,
      },
    });
  } catch (e) {
    return { success: false, error: "Verbindungsfehler: " + e.message };
  }

  let data = {};
  try { data = await response.json(); } catch (_) {}

  if (response.ok) {
    const item = (data.items || [])[0];
    const code = item && item.sstatus && item.sstatus.statusCode;
    if (!item || code === 200 || code === 0 || !code) {
      // Erfolgreiche Stornierung → auch aus Verlauf entfernen
      try { await deleteHistoryEntry(sn); } catch (_) {}
      return { success: true };
    }
    return { success: false, error: extractError(data, response.status) };
  }
  return { success: false, error: extractError(data, response.status) };
}

// --- DHL Returns API ------------------------------------------------------

async function createReturn(req) {
  const settings = await getSettings();

  if (!settings.api_key || !settings.username || !settings.password) {
    return { success: false, error: "Bitte zuerst API-Zugangsdaten in den Einstellungen hinterlegen." };
  }
  const receiverId = (settings.returns_receiver_id || "").trim();
  if (!receiverId) {
    return { success: false, error: "Keine Retouren-Empfänger-ID konfiguriert. Bitte in den Einstellungen hinterlegen." };
  }

  const baseUrl = settings.sandbox ? RETURNS_SANDBOX_URL : RETURNS_PRODUCTION_URL;
  const weightInGrams = Math.round(parseFloat(req.weight) * 1000);

  const shipper = {
    name1: req.name,
    addressStreet: req.street,
    addressHouse: req.street_number,
    postalCode: req.postal_code,
    city: req.city,
    country: req.country || "DEU",
  };
  if (req.email) shipper.email = req.email;

  const payload = {
    receiverId,
    customerReference: req.ref_no,
    shipper,
    itemWeight: { uom: "g", value: weightInGrams },
  };
  if ((settings.billing_returns || "").trim()) {
    payload.billingNumber = settings.billing_returns.trim();
  }

  const credentials = btoa(`${settings.username}:${settings.password}`);

  let response;
  try {
    response = await fetch(`${baseUrl}/orders`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "dhl-api-key": settings.api_key,
        Authorization: `Basic ${credentials}`,
      },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    return { success: false, error: "Verbindungsfehler: " + e.message };
  }

  let data = {};
  try { data = await response.json(); }
  catch (_) { return { success: false, error: `HTTP ${response.status} — Antwort konnte nicht gelesen werden.` }; }

  if (response.ok) {
    let labelB64 = data.labelData || (data.label && (data.label.b64 || data.label.data)) || "";
    let qrB64 = data.qrLabelData || (data.qrLabel && (data.qrLabel.b64 || data.qrLabel.data)) || "";
    if (typeof labelB64 === "object" && labelB64) labelB64 = labelB64.b64 || labelB64.data || "";
    return {
      success: true,
      shipment_number: data.shipmentNo || "",
      label_pdf_base64: labelB64 || "",
      qr_pdf_base64: qrB64 || "",
      routing_code: data.routingCode || "",
      label_url: "",
      sandbox: settings.sandbox,
    };
  }

  if (response.status === 401) {
    return {
      success: false,
      error:
        'HTTP 401 — DHL hat die Retouren-Anfrage abgelehnt. ' +
        'Häufigste Ursache: dein API-Key ist NICHT für das Produkt "Parcel DE Returns" freigeschaltet. ' +
        'Lösung: developer.dhl.com → My Apps → API-Key auswählen → "Parcel DE Returns" abonnieren ' +
        '(Genehmigung kann 1–2 Werktage dauern). Falls schon freigeschaltet: Username/Passwort prüfen — ' +
        'manche GKP-Accounts brauchen für Retouren ein separates App-User-Login.',
    };
  }

  return { success: false, error: extractError(data, response.status) };
}

// --- Sales-Aggregation ---------------------------------------------------
// Primär: Flask-Backend (sales_state.json) — Web-App und Extension teilen
//         denselben State und dieselbe Discord-Live-Nachricht.
// Fallback: chrome.storage + direkter Discord-Post — falls Flask nicht
//         läuft, funktioniert die Extension trotzdem standalone.

async function flaskFetch(path, options) {
  let response;
  try {
    response = await fetch(`${FLASK_URL}${path}`, options);
  } catch (e) {
    return { ok: false, offline: true };
  }
  let data = {};
  try { data = await response.json(); } catch (_) {}
  if (!response.ok) {
    const detail = (data && (data.error || data.title)) || `HTTP ${response.status}`;
    return { ok: false, offline: false, status: response.status, error: `Flask: ${detail}`, data };
  }
  return { ok: true, data };
}

// === Lokale Fallback-Implementierung =====================================

function uuid() {
  if (crypto && crypto.randomUUID) return crypto.randomUUID();
  return "p_" + Date.now() + "_" + Math.random().toString(36).slice(2, 10);
}

function freeArticleKey(name) {
  return "free:" + String(name || "").toLowerCase().split(/\s+/).filter(Boolean).join(" ");
}

const DISCORD_CONTENT_LIMIT = 2000;
const DISCORD_SAFETY_LIMIT = 1950;

function formatSalesChunks(sess, recipientName) {
  const items = (sess.items || []).slice().sort((a, b) =>
    String(a.name || "").toLowerCase().localeCompare(String(b.name || "").toLowerCase(), "de")
  );
  const startedAt = sess.started_at || new Date().toISOString();
  let ts;
  try {
    ts = new Date(startedAt).toLocaleString("de-DE", {
      day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
    });
  } catch (_) { ts = startedAt; }

  const suffix = recipientName ? ` — ${recipientName}` : "";
  const pageHeader = `🛒 **Sales Overview${suffix}** (seit ${ts})`;
  const contHeader = `🛒 **Sales Overview${suffix}** (Fortsetzung)`;

  if (!items.length) return [`${pageHeader}\n_(noch keine Sales)_`];

  const blocks = [];
  let grand = 0;
  let totalQty = 0;
  for (const it of items) {
    const price = Number(it.price || 0);
    const qty = Number(it.qty || 0);
    const sub = price * qty;
    grand += sub;
    totalQty += qty;
    const code = String(it.short_code || "").trim();
    const title = code ? `[${code}] ${it.name || "?"}` : (it.name || "?");
    blocks.push(
      `**${title}**\n` +
      `Preis pro Unit: ${price.toFixed(2)} €\n` +
      `quantity: ${qty}\n` +
      `Summe: ${sub.toFixed(2)} €`
    );
  }
  const footer = `━━━━━━━━━━━━━━━━━━━━━━━\n**Gesamt: ${grand.toFixed(2)} €** (${totalQty} Artikel)`;

  const chunks = [];
  let current = pageHeader;
  for (const block of blocks.concat([footer])) {
    const candidate = current + "\n\n" + block;
    if (candidate.length > DISCORD_SAFETY_LIMIT) {
      chunks.push(current);
      current = contHeader + "\n\n" + block;
    } else {
      current = candidate;
    }
  }
  chunks.push(current);

  return chunks.map((c) => c.length > DISCORD_CONTENT_LIMIT
    ? c.slice(0, DISCORD_CONTENT_LIMIT - 4) + "\n…"
    : c
  );
}

// Backward-Compat-Wrapper — Aufrufer die die volle Liste wollen, nutzen formatSalesChunks.
function formatSalesMessage(sess, recipientName) {
  return formatSalesChunks(sess, recipientName)[0];
}

async function pushSalesSessionToDiscord(webhookUrl, sess, recipientName) {
  const chunks = formatSalesChunks(sess, recipientName);

  // Schema-Migration im Lese-Pfad: discord_message_id (string) → discord_message_ids (list)
  let existing = Array.isArray(sess.discord_message_ids) ? sess.discord_message_ids.slice() : [];
  if (!existing.length && sess.discord_message_id) existing = [sess.discord_message_id];
  existing = existing.filter(Boolean);

  const newIds = [];
  let freshMode = false;

  for (let i = 0; i < chunks.length; i++) {
    const content = chunks[i];
    let msgId = null;

    if (!freshMode && i < existing.length) {
      const editUrl = `${webhookUrl.replace(/\/$/, "")}/messages/${existing[i]}`;
      try {
        const r = await fetch(editUrl, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content }),
        });
        if (r.ok || r.status === 204) {
          msgId = existing[i];
        } else if (r.status === 400 || r.status === 404) {
          let body = "";
          try { body = await r.text(); } catch (_) {}
          console.warn(`[discord] PATCH ${r.status} chunk ${i} (msg ${existing[i]}) → poste neu. body=${body.slice(0,200)}`);
          freshMode = true;
        } else {
          let body = "";
          try { body = await r.text(); } catch (_) {}
          return { success: false, error: `Discord PATCH HTTP ${r.status}: ${body.slice(0,200)}` };
        }
      } catch (e) {
        return { success: false, error: "Discord PATCH: " + e.message };
      }
    }

    if (msgId === null) {
      const sep = webhookUrl.includes("?") ? "&" : "?";
      try {
        const r = await fetch(`${webhookUrl}${sep}wait=true`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content }),
        });
        if (r.ok) {
          try { const j = await r.json(); msgId = String(j.id || ""); } catch (_) { msgId = ""; }
        } else {
          let body = "";
          try { body = await r.text(); } catch (_) {}
          return { success: false, error: `Discord POST HTTP ${r.status}: ${body.slice(0,300)}` };
        }
      } catch (e) {
        return { success: false, error: "Discord POST: " + e.message };
      }
    }

    newIds.push(msgId);
  }

  // Obsolete Messages löschen (Slot nicht mehr belegt oder nach freshMode abgehängt)
  const used = new Set(newIds);
  for (const stale of existing) {
    if (stale && !used.has(stale)) {
      try {
        await fetch(`${webhookUrl.replace(/\/$/, "")}/messages/${stale}`, { method: "DELETE" });
      } catch (e) {
        console.warn(`[discord] DELETE stale ${stale} failed: ${e.message}`);
      }
    }
  }

  return { success: true, message_ids: newIds };
}

async function trackSaleLocal({ recipient_id, product_id, name, price, qty, short_code }) {
  const settings = await getSettings();
  const rcp = findRecipient(settings, recipient_id);
  if (!rcp) {
    return { success: false, error: "Kein Empfänger konfiguriert. Bitte erst einen Rechnungs-Empfänger anlegen." };
  }

  const sessions = { ...(settings.sessions || {}) };
  const session = { ...emptyLocalSession(), ...(sessions[rcp.id] || {}) };
  if (!session.started_at) session.started_at = new Date().toISOString();

  const priceF = (() => {
    const v = parseFloat(String(price || "").replace(",", "."));
    return isFinite(v) ? v : 0;
  })();
  const qtyI = Math.max(1, parseInt(qty || 1, 10) || 1);
  const code = String(short_code || "").trim().slice(0, 12);
  const pid = (product_id || "").trim() || freeArticleKey(name);

  let item = (session.items || []).find((it) => it.product_id === pid);
  if (!item) {
    item = { product_id: pid, name: name || "?", price: priceF, qty: 0, short_code: code };
    session.items = (session.items || []).concat([item]);
  }
  item.qty = Number(item.qty || 0) + qtyI;
  item.name = name || item.name;
  if (code) item.short_code = code;

  const webhook = (rcp.webhook_url || "").trim();
  const discordResult = webhook
    ? await pushSalesSessionToDiscord(webhook, session, rcp.name)
    : { success: false, error: "Kein Webhook für diesen Empfänger konfiguriert." };
  if (discordResult.success && Array.isArray(discordResult.message_ids)) {
    session.discord_message_ids = discordResult.message_ids;
    // Legacy-Bridge für parallel-laufende Tools, die das ids-Schema noch nicht kennen
    if (discordResult.message_ids.length) {
      session.discord_message_id = discordResult.message_ids[0];
    } else {
      delete session.discord_message_id;
    }
  }
  sessions[rcp.id] = session;
  await chrome.storage.local.set({
    settings: { ...settings, sessions, last_recipient_id: rcp.id },
  });
  return { success: true, recipient: rcp, session, discord: discordResult };
}

async function resetSalesSessionLocal({ recipient_id } = {}) {
  const settings = await getSettings();
  const rcp = findRecipient(settings, recipient_id);
  if (!rcp) return { success: false, error: "Kein Empfänger konfiguriert." };

  const sessions = { ...(settings.sessions || {}) };
  const sess = sessions[rcp.id] || emptyLocalSession();
  const items = sess.items || [];
  const total = items.reduce((s, it) => s + Number(it.price || 0) * Number(it.qty || 0), 0);

  const webhook = (rcp.webhook_url || "").trim();
  if (webhook && items.length) {
    const now = new Date().toLocaleString("de-DE", {
      day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
    });
    const totalQty = items.reduce((s, it) => s + Number(it.qty || 0), 0);
    const content =
      `📋 **Rechnung finished - Lecker Profit😋!**\n` +
      `Schluss um ${now} — Gesamtsumme: **${total.toFixed(2)} €** (${totalQty} Artikel insg.)\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━`;
    try {
      await fetch(webhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });
    } catch (_) {}
  }

  sessions[rcp.id] = emptyLocalSession();
  await chrome.storage.local.set({ settings: { ...settings, sessions } });
  return { success: true, recipient: rcp, session: sessions[rcp.id], closed_total: total };
}

async function updateSaleItemLocal({ recipient_id, product_id, name, short_code, price, qty }) {
  const settings = await getSettings();
  const rcp = findRecipient(settings, recipient_id);
  if (!rcp) return { success: false, error: "Kein Empfänger konfiguriert." };
  const sessions = { ...(settings.sessions || {}) };
  const sess = { ...emptyLocalSession(), ...(sessions[rcp.id] || {}) };
  const items = (sess.items || []).slice();
  const idx = items.findIndex((it) => it.product_id === product_id);
  if (idx < 0) return { success: false, error: "Item nicht gefunden." };
  const it = { ...items[idx] };
  if (name !== undefined && String(name).trim()) it.name = String(name).trim();
  if (short_code !== undefined) it.short_code = String(short_code || "").trim().slice(0, 12);
  if (price !== undefined && String(price).trim() !== "") {
    const v = parseFloat(String(price).replace(",", "."));
    if (isFinite(v)) it.price = v;
  }
  if (qty !== undefined && String(qty).trim() !== "") {
    const q = parseInt(qty, 10);
    if (q >= 1) it.qty = q;
  }
  items[idx] = it;
  sess.items = items;

  const webhook = (rcp.webhook_url || "").trim();
  const discordResult = webhook
    ? await pushSalesSessionToDiscord(webhook, sess, rcp.name)
    : { success: false };
  if (discordResult.success && Array.isArray(discordResult.message_ids)) {
    sess.discord_message_ids = discordResult.message_ids;
    if (discordResult.message_ids.length) {
      sess.discord_message_id = discordResult.message_ids[0];
    } else {
      delete sess.discord_message_id;
    }
  }
  sessions[rcp.id] = sess;
  await chrome.storage.local.set({ settings: { ...settings, sessions } });
  return { success: true, recipient: rcp, session: sess, item: it, discord: discordResult };
}

async function deleteSaleItemLocal({ recipient_id, product_id }) {
  const settings = await getSettings();
  const rcp = findRecipient(settings, recipient_id);
  if (!rcp) return { success: false, error: "Kein Empfänger konfiguriert." };
  const sessions = { ...(settings.sessions || {}) };
  const sess = { ...emptyLocalSession(), ...(sessions[rcp.id] || {}) };
  const before = (sess.items || []).length;
  sess.items = (sess.items || []).filter((it) => it.product_id !== product_id);
  if (sess.items.length === before) return { success: false, error: "Item nicht gefunden." };

  const webhook = (rcp.webhook_url || "").trim();
  const discordResult = webhook
    ? await pushSalesSessionToDiscord(webhook, sess, rcp.name)
    : { success: false };
  if (discordResult.success && Array.isArray(discordResult.message_ids)) {
    sess.discord_message_ids = discordResult.message_ids;
    if (discordResult.message_ids.length) {
      sess.discord_message_id = discordResult.message_ids[0];
    } else {
      delete sess.discord_message_id;
    }
  }
  sessions[rcp.id] = sess;
  await chrome.storage.local.set({ settings: { ...settings, sessions } });
  return { success: true, recipient: rcp, session: sess, discord: discordResult };
}

// --- Recipients (lokal) ---

async function listRecipientsLocal() {
  const settings = await getSettings();
  return { recipients: settings.recipients || [] };
}

async function upsertRecipientLocal(rcp) {
  const name = (rcp.name || "").trim();
  if (!name) return { success: false, error: "Empfänger-Name darf nicht leer sein." };
  const webhook = (rcp.webhook_url || "").trim();
  const settings = await getSettings();
  const recipients = (settings.recipients || []).slice();
  if (rcp.id) {
    const idx = recipients.findIndex((r) => r.id === rcp.id);
    if (idx >= 0) {
      recipients[idx] = { ...recipients[idx], name, webhook_url: webhook };
      await chrome.storage.local.set({ settings: { ...settings, recipients } });
      return { success: true, recipient: recipients[idx] };
    }
  }
  const newR = { id: uuid(), name, webhook_url: webhook };
  recipients.push(newR);
  const next = { ...settings, recipients };
  if (!next.last_recipient_id) next.last_recipient_id = newR.id;
  await chrome.storage.local.set({ settings: next });
  return { success: true, recipient: newR };
}

async function deleteRecipientLocal(recipientId) {
  const settings = await getSettings();
  const before = (settings.recipients || []).length;
  const recipients = (settings.recipients || []).filter((r) => r.id !== recipientId);
  if (recipients.length === before) return { success: false };
  const sessions = { ...(settings.sessions || {}) };
  delete sessions[recipientId];
  let last = settings.last_recipient_id;
  if (last === recipientId) last = recipients[0] ? recipients[0].id : null;
  await chrome.storage.local.set({
    settings: { ...settings, recipients, sessions, last_recipient_id: last },
  });
  return { success: true };
}

async function listProductsLocal() {
  const settings = await getSettings();
  return { products: settings.products || [] };
}

async function upsertProductLocal(product) {
  const name = (product.name || "").trim();
  if (!name) return { success: false, error: "Produktname darf nicht leer sein." };
  const priceF = (() => {
    const v = parseFloat(String(product.default_price || "0").replace(",", "."));
    return isFinite(v) ? v : 0;
  })();
  const code = String(product.short_code || "").trim().slice(0, 12);
  const settings = await getSettings();
  const products = (settings.products || []).slice();
  if (product.id) {
    const idx = products.findIndex((p) => p.id === product.id);
    if (idx >= 0) {
      products[idx] = { ...products[idx], name, default_price: priceF, short_code: code };
      await chrome.storage.local.set({ settings: { ...settings, products } });
      return { success: true, product: products[idx] };
    }
  }
  const newProduct = { id: uuid(), name, default_price: priceF, short_code: code };
  products.push(newProduct);
  await chrome.storage.local.set({ settings: { ...settings, products } });
  return { success: true, product: newProduct };
}

async function deleteProductLocal(productId) {
  const settings = await getSettings();
  const before = (settings.products || []).length;
  const products = (settings.products || []).filter((p) => p.id !== productId);
  if (products.length === before) return { success: false };
  await chrome.storage.local.set({ settings: { ...settings, products } });
  return { success: true };
}

async function getSalesSessionLocal({ recipient_id } = {}) {
  const settings = await getSettings();
  const rcp = findRecipient(settings, recipient_id);
  if (!rcp) return { session: { recipient: null, session: emptyLocalSession() } };
  const sess = (settings.sessions || {})[rcp.id] || emptyLocalSession();
  return { session: { recipient: rcp, session: sess } };
}

// === Public API: Flask zuerst, bei Offline silent fallback auf Local ====

async function trackSale(payload) {
  const r = await flaskFetch("/api/sales/track", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload || {}),
  });
  if (r.ok) return { success: true, ...r.data };
  if (r.offline) return await trackSaleLocal(payload || {});
  return { success: false, error: r.error };
}

async function resetSalesSession(payload) {
  const r = await flaskFetch("/api/sales/reset", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload || {}),
  });
  if (r.ok) return { success: true, ...r.data };
  if (r.offline) return await resetSalesSessionLocal(payload || {});
  return { success: false, error: r.error };
}

async function updateSaleItem(payload) {
  const r = await flaskFetch("/api/sales/items/update", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload || {}),
  });
  if (r.ok) return { success: true, ...r.data };
  if (r.offline) return await updateSaleItemLocal(payload || {});
  return { success: false, error: r.error };
}

async function deleteSaleItem(payload) {
  const r = await flaskFetch("/api/sales/items/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload || {}),
  });
  if (r.ok) return { success: true, ...r.data };
  if (r.offline) return await deleteSaleItemLocal(payload || {});
  return { success: false, error: r.error };
}

// Sync Flask -> chrome.storage: spiegelt recipients + sessions + last_recipient_id,
// damit der Offline-Fallback beim nächsten Sale dieselben Webhooks/Message-IDs nutzt.
async function syncStateFromFlask() {
  const r1 = await flaskFetch("/api/sales/recipients");
  if (!r1.ok) return { synced: false, reason: r1.offline ? "offline" : (r1.error || "error") };
  const recipients = (r1.data && r1.data.recipients) || [];
  const sessions = {};
  for (const rcp of recipients) {
    const r2 = await flaskFetch(`/api/sales/session?recipient_id=${encodeURIComponent(rcp.id)}`);
    if (r2.ok && r2.data && r2.data.session) {
      const s = r2.data.session;
      // Server gibt Wrapper {recipient, session} zurück
      sessions[rcp.id] = s.session || s;
    }
  }
  const settings = await getSettings();
  const last = settings.last_recipient_id || (recipients[0] && recipients[0].id) || null;
  await chrome.storage.local.set({
    settings: { ...settings, recipients, sessions, last_recipient_id: last },
  });
  return { synced: true, count: recipients.length };
}

// Schneller Flask-Online-Check fürs Popup
async function flaskHealthCheck() {
  const r = await flaskFetch("/api/sales/recipients");
  return { online: r.ok };
}

// Auto-Start: Flask via Native-Messaging-Host (start.bat) anstoßen,
// wenn das Backend offline ist. Setup einmalig per register_autostart.bat.
const NATIVE_HOST_NAME = "com.dhl_label_tool.starter";

async function ensureFlaskRunning() {
  const health = await flaskHealthCheck();
  if (health.online) return { online: true, action: "noop" };

  try {
    const resp = await chrome.runtime.sendNativeMessage(NATIVE_HOST_NAME, { action: "start" });
    if (resp && resp.ok) {
      return { online: false, action: "started", already_running: !!resp.already_running };
    }
    return { online: false, action: "failed", error: (resp && resp.error) || "Native-Host meldet Fehler." };
  } catch (e) {
    // Native Host nicht registriert oder nicht erreichbar — kein harter Fehler.
    return {
      online: false,
      action: "no-native-host",
      error: (e && e.message) || String(e),
    };
  }
}

async function listRecipients() {
  const r = await flaskFetch("/api/sales/recipients");
  if (r.ok) return { recipients: (r.data && r.data.recipients) || [] };
  if (r.offline) return await listRecipientsLocal();
  return { recipients: [], error: r.error };
}

async function upsertRecipient(rcp) {
  const r = await flaskFetch("/api/sales/recipients", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(rcp || {}),
  });
  if (r.ok) return { success: true, ...r.data };
  if (r.offline) return await upsertRecipientLocal(rcp || {});
  return { success: false, error: r.error };
}

async function deleteRecipient(recipientId) {
  const r = await flaskFetch(`/api/sales/recipients/${encodeURIComponent(recipientId)}`, {
    method: "DELETE",
  });
  if (r.ok) return { success: true };
  if (r.offline) return await deleteRecipientLocal(recipientId);
  return { success: false, error: r.error };
}

async function listProducts() {
  const r = await flaskFetch("/api/sales/products");
  if (r.ok) return { products: (r.data && r.data.products) || [] };
  if (r.offline) return await listProductsLocal();
  return { products: [], error: r.error };
}

async function upsertProduct(product) {
  const r = await flaskFetch("/api/sales/products", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(product || {}),
  });
  if (r.ok) return { success: true, ...r.data };
  if (r.offline) return await upsertProductLocal(product || {});
  return { success: false, error: r.error };
}

async function deleteProduct(productId) {
  const r = await flaskFetch(`/api/sales/products/${encodeURIComponent(productId)}`, {
    method: "DELETE",
  });
  if (r.ok) return { success: true };
  if (r.offline) return await deleteProductLocal(productId);
  return { success: false, error: r.error };
}

async function getSalesSession(payload) {
  const rid = payload && payload.recipient_id ? `?recipient_id=${encodeURIComponent(payload.recipient_id)}` : "";
  const r = await flaskFetch(`/api/sales/session${rid}`);
  if (r.ok) return { session: (r.data && r.data.session) || { recipient: null, session: { items: [] } } };
  if (r.offline) return await getSalesSessionLocal(payload || {});
  return { session: { recipient: null, session: { items: [] } }, error: r.error };
}

// --- History --------------------------------------------------------------

async function saveToHistory(req, result) {
  if (!result.success || !result.shipment_number) return;

  const entry = {
    shipment_number: result.shipment_number,
    created_at: new Date().toISOString(),
    recipient: {
      name: req.name,
      name2: req.name2 || "",
      street: req.street,
      street_number: req.street_number,
      postal_code: req.postal_code,
      city: req.city,
    },
    weight_kg: parseFloat(req.weight),
    product: req.product,
    ref_no: req.ref_no || "",
    article: req.article || "",
    short_code: req.short_code || "",
    price: req.final_price || req.price || "",
    has_pdf: !!result.label_pdf_base64,
    label_url: result.label_url || "",
    sandbox: !!result.sandbox,
  };

  const { history = [], pdfs = {} } = await chrome.storage.local.get(["history", "pdfs"]);
  history.unshift(entry);
  if (result.label_pdf_base64) {
    pdfs[result.shipment_number] = result.label_pdf_base64;
  }
  await chrome.storage.local.set({ history, pdfs });
}

async function deleteHistoryEntry(shipmentNumber) {
  const { history = [], pdfs = {} } = await chrome.storage.local.get(["history", "pdfs"]);
  const newHistory = history.filter((e) => e.shipment_number !== shipmentNumber);
  delete pdfs[shipmentNumber];
  await chrome.storage.local.set({ history: newHistory, pdfs });
}

// --- Logo-Overlay aufs Label ----------------------------------------------

function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes) {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

async function overlayLogoOnPdf(pdfBase64, logoPath) {
  if (typeof PDFLib === "undefined") return pdfBase64;
  try {
    const logoUrl = chrome.runtime.getURL(logoPath);
    const logoBytes = new Uint8Array(await (await fetch(logoUrl)).arrayBuffer());
    const pdfDoc = await PDFLib.PDFDocument.load(base64ToBytes(pdfBase64));
    const logo = await pdfDoc.embedPng(logoBytes);
    const page = pdfDoc.getPages()[0];
    const { width, height } = page.getSize();

    // Position oben rechts neben dem Empfänger-Block (gelbe Markierung im Layout).
    const logoW = width * 0.22;
    const logoH = (logo.height / logo.width) * logoW;
    const x = width - logoW - width * 0.08;
    const y = height - logoH - height * 0.08;
    page.drawImage(logo, { x, y, width: logoW, height: logoH });

    return bytesToBase64(await pdfDoc.save());
  } catch (e) {
    console.warn("Logo overlay failed:", e);
    return pdfBase64;
  }
}

async function applyShipperLogoIfNeeded(req, result) {
  if (!result || !result.success || !result.label_pdf_base64) return;
  const settings = await getSettings();
  const idx = Math.max(0, Math.min(parseInt(req.shipper_index || 0, 10), (settings.shippers || []).length - 1));
  const shipper = (settings.shippers || [])[idx];
  if (!shipper) return;
  const key = (shipper.name || "").toLowerCase().trim();
  const logoPath = SHIPPER_LOGOS[key];
  if (!logoPath) return;
  result.label_pdf_base64 = await overlayLogoOnPdf(result.label_pdf_base64, logoPath);
}

// --- Kürzel-Overlay aufs Label -------------------------------------------

async function overlayShortCodeOnPdf(pdfBase64, shortCode, qty, productType) {
  if (typeof PDFLib === "undefined") return pdfBase64;
  const code = String(shortCode || "").trim().slice(0, 12);
  if (!code) return pdfBase64;
  const q = Math.max(1, parseInt(qty || 1, 10) || 1);
  const text = `${q}x ${code}`;
  try {
    const pdfDoc = await PDFLib.PDFDocument.load(base64ToBytes(pdfBase64));
    const font = await pdfDoc.embedFont(PDFLib.StandardFonts.HelveticaBold);
    const page = pdfDoc.getPages()[0];
    const { width, height } = page.getSize();

    // Position: ganz unten am Label, horizontal zentriert.
    // Überdeckt die "Common Label PLG@DHL Business Portal"-Zeile mit einer weißen Box.
    // Gleiche Position bei Paket und Kleinpaket. Kleine Schrift (5pt) für Thermo-Druck.
    const fontSize = 5;
    // Weiße Box über die volle Breite am Fuß, damit der DHL-Footer-Text komplett verschwindet
    page.drawRectangle({
      x: 0,
      y: 0,
      width: width,
      height: height * 0.028,
      color: PDFLib.rgb(1, 1, 1),
    });
    const textWidth = font.widthOfTextAtSize(text, fontSize);
    const x = (width - textWidth) / 2;
    const y = height * 0.012;

    page.drawText(text, {
      x, y,
      size: fontSize,
      font,
      color: PDFLib.rgb(0, 0, 0),
    });

    return bytesToBase64(await pdfDoc.save());
  } catch (e) {
    console.warn("Short-code overlay failed:", e);
    return pdfBase64;
  }
}

async function applyShortCodeIfNeeded(req, result) {
  if (!result || !result.success || !result.label_pdf_base64) return;
  const code = String(req.short_code || "").trim();
  if (!code) return;
  result.label_pdf_base64 = await overlayShortCodeOnPdf(
    result.label_pdf_base64,
    code,
    req.qty,
    req.product
  );
}

// --- Message Handler ------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      switch (msg && msg.type) {
        case "create-label": {
          const result = await createShipment(msg.payload);
          await applyShipperLogoIfNeeded(msg.payload, result);
          await applyShortCodeIfNeeded(msg.payload, result);
          await saveToHistory(msg.payload, result);
          sendResponse(result);
          break;
        }
        case "get-history": {
          const { history = [] } = await chrome.storage.local.get("history");
          sendResponse(history);
          break;
        }
        case "get-pdf": {
          const { pdfs = {} } = await chrome.storage.local.get("pdfs");
          sendResponse({ pdf: pdfs[msg.shipment_number] || null });
          break;
        }
        case "delete-history": {
          await deleteHistoryEntry(msg.shipment_number);
          sendResponse({ success: true });
          break;
        }
        case "cancel-shipment": {
          const result = await cancelShipment(msg.shipment_number);
          sendResponse(result);
          break;
        }
        case "create-return": {
          const result = await createReturn(msg.payload);
          await saveToHistory(msg.payload, result);
          sendResponse(result);
          break;
        }
        case "sales-list-products": {
          const r = await listProducts();
          sendResponse({ success: !r.error, products: r.products, error: r.error });
          break;
        }
        case "sales-upsert-product": {
          sendResponse(await upsertProduct(msg.payload || {}));
          break;
        }
        case "sales-delete-product": {
          sendResponse(await deleteProduct(msg.product_id));
          break;
        }
        case "sales-get-session": {
          const r = await getSalesSession(msg.payload || {});
          sendResponse({ success: !r.error, session: r.session, error: r.error });
          break;
        }
        case "sales-track": {
          sendResponse(await trackSale(msg.payload || {}));
          break;
        }
        case "sales-reset": {
          sendResponse(await resetSalesSession(msg.payload || {}));
          break;
        }
        case "sales-update-item": {
          sendResponse(await updateSaleItem(msg.payload || {}));
          break;
        }
        case "sales-delete-item": {
          sendResponse(await deleteSaleItem(msg.payload || {}));
          break;
        }
        case "sales-sync-from-flask": {
          sendResponse(await syncStateFromFlask());
          break;
        }
        case "flask-health": {
          sendResponse(await flaskHealthCheck());
          break;
        }
        case "ensure-flask-running": {
          sendResponse(await ensureFlaskRunning());
          break;
        }
        case "sales-list-recipients": {
          const r = await listRecipients();
          sendResponse({ success: !r.error, recipients: r.recipients, error: r.error });
          break;
        }
        case "sales-upsert-recipient": {
          sendResponse(await upsertRecipient(msg.payload || {}));
          break;
        }
        case "sales-delete-recipient": {
          sendResponse(await deleteRecipient(msg.recipient_id));
          break;
        }
        default:
          sendResponse({ success: false, error: "Unbekannte Anfrage." });
      }
    } catch (e) {
      sendResponse({ success: false, error: e.message || String(e) });
    }
  })();
  return true; // keep channel open for async sendResponse
});

// --- Side Panel: Klick aufs Extension-Icon öffnet die Seitenleiste --------

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((e) => console.error("setPanelBehavior:", e));

// --- Erstinstallation: Optionen direkt öffnen -----------------------------

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === "install") {
    const { settings } = await chrome.storage.local.get("settings");
    if (!settings) {
      await chrome.storage.local.set({ settings: { ...DEFAULT_SETTINGS } });
    }
    chrome.runtime.openOptionsPage();
  }
  // Auch nach Reload/Update versuchen Flask hochzufahren (best-effort, schweigt bei Fehler)
  ensureFlaskRunning().catch(() => {});
});

// --- Auto-Start beim Browser-Start ----------------------------------------
// Sobald Chrome (und damit die Extension) hochfährt, einmal versuchen
// das Flask-Backend per Native-Messaging zu starten.
chrome.runtime.onStartup.addListener(() => {
  ensureFlaskRunning().catch(() => {});
});
