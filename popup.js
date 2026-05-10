// Popup-Logik: Formular, Parser-Trigger, Senden, Ergebnis, Verlauf

// "Ka-ching"-Sound für erfolgreiche Sales-Tracks (Web Audio API, kein Asset nötig)
function playSaleSound() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const now = ctx.currentTime;
    const tone = (freq, start, dur, vol = 0.25) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, now + start);
      gain.gain.linearRampToValueAtTime(vol, now + start + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + start + dur);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now + start);
      osc.stop(now + start + dur);
    };
    tone(987.77, 0.00, 0.18); // B5
    tone(1318.51, 0.08, 0.30); // E6
    setTimeout(() => { try { ctx.close(); } catch (_) {} }, 700);
  } catch (_) { /* ignore */ }
}

const PRODUCT_LABELS = {
  V01PAK: "DHL Paket",
  V62KP: "DHL Kleinpaket",
};

// Adressentyp-Konfiguration
const ADDR_TYPE_CONFIG = {
  street: {
    f1Label: "Strasse",
    f2Label: "Nr.",
    f1Placeholder: "",
    f2Placeholder: "",
    f1Required: true,
    f2Required: true,
    hideF2: false,
  },
  packstation: {
    f1Label: "Postnummer",
    f2Label: "Station-Nr.",
    f1Placeholder: "6–12 Ziffern",
    f2Placeholder: "z.B. 123",
    f1Required: true,
    f2Required: true,
    hideF2: false,
  },
  filiale: {
    f1Label: "Postnummer (optional)",
    f2Label: "Filial-Nr.",
    f1Placeholder: "nur bei Filiale Direkt",
    f2Placeholder: "z.B. 456",
    f1Required: false,
    f2Required: true,
    hideF2: false,
  },
  postfach: {
    f1Label: "Postfach-Nr.",
    f2Label: "",
    f1Placeholder: "z.B. 123456",
    f2Placeholder: "",
    f1Required: true,
    f2Required: false,
    hideF2: true,
  },
};

const $ = (id) => document.getElementById(id);

function getAddrType() {
  const el = document.querySelector('input[name="addr_type"]:checked');
  return el ? el.value : "street";
}

function applyAddrType() {
  const type = getAddrType();
  const cfg = ADDR_TYPE_CONFIG[type] || ADDR_TYPE_CONFIG.street;

  const lblF1 = $("lbl-street");
  const lblF2 = $("lbl-street-number");
  const inpF1 = $("street");
  const inpF2 = $("street_number");
  const grpF2 = $("grp-street-number");

  lblF1.innerHTML = cfg.f1Required
    ? `${cfg.f1Label} <span class="req">*</span>`
    : cfg.f1Label;
  lblF2.innerHTML = cfg.f2Required
    ? `${cfg.f2Label} <span class="req">*</span>`
    : cfg.f2Label;

  inpF1.placeholder = cfg.f1Placeholder;
  inpF2.placeholder = cfg.f2Placeholder;

  grpF2.style.display = cfg.hideF2 ? "none" : "";

  // Kleinpaket ist bei Filiale nicht verfügbar
  const kpLabel = $("lbl-product-kleinpaket");
  const kpRadio = document.querySelector('input[name="product"][value="V62KP"]');
  if (kpLabel && kpRadio) {
    if (type === "filiale") {
      kpLabel.style.display = "none";
      if (kpRadio.checked) {
        const paket = document.querySelector('input[name="product"][value="V01PAK"]');
        if (paket) paket.checked = true;
      }
    } else {
      kpLabel.style.display = "";
    }
  }
}

function escapeHtml(s) {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function formatTime(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString("de-DE", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch (_) {
    return iso;
  }
}

function sendMessage(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ success: false, error: chrome.runtime.lastError.message });
      } else {
        resolve(response);
      }
    });
  });
}

// --- Datum / Sandbox / Absender beim Laden -------------------------------

function setShipDate() {
  $("ship_date").value = new Date().toLocaleDateString("de-DE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

async function loadSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  const s = settings || {};

  // Sandbox-Banner
  $("sandbox-banner").style.display = s.sandbox ? "block" : "none";

  // Absender-Dropdown
  const sel = $("shipper");
  sel.innerHTML = "";
  const shippers = s.shippers || [];
  if (!shippers.length) {
    const opt = document.createElement("option");
    opt.textContent = "— kein Absender konfiguriert —";
    opt.disabled = true;
    sel.appendChild(opt);
  } else {
    shippers.forEach((sh, i) => {
      const opt = document.createElement("option");
      opt.value = String(i);
      opt.textContent = `${sh.label || sh.name} — ${sh.name}, ${sh.city}`;
      sel.appendChild(opt);
    });
  }

  // Retoure-Hinweis: Empfänger-ID
  const hint = $("returns-receiver-id-hint");
  if (hint) {
    hint.textContent = (s.returns_receiver_id || "").trim()
      ? `Empfänger-ID: ${s.returns_receiver_id}`
      : "⚠ Keine Retouren-Empfänger-ID konfiguriert. Siehe Einstellungen.";
  }
}

// --- Produkte / Sales ----------------------------------------------------
let PRODUCTS_CACHE = [];
let RECIPIENTS_CACHE = [];

async function loadRecipients() {
  const res = await sendMessage({ type: "sales-list-recipients" });
  RECIPIENTS_CACHE = (res && res.recipients) || [];
  renderRecipientDropdowns();
}

async function getLastRecipientId() {
  const { settings } = await chrome.storage.local.get("settings");
  return (settings && settings.last_recipient_id) || (RECIPIENTS_CACHE[0] && RECIPIENTS_CACHE[0].id) || "";
}

async function setLastRecipientId(rid) {
  const { settings } = await chrome.storage.local.get("settings");
  await chrome.storage.local.set({ settings: { ...(settings || {}), last_recipient_id: rid } });
}

async function renderRecipientDropdowns() {
  const formSel = $("recipient_select");
  const ovSel = $("overview_recipient_select");
  const last = await getLastRecipientId();

  for (const sel of [formSel, ovSel]) {
    if (!sel) continue;
    const current = sel.value;
    sel.innerHTML = "";
    if (!RECIPIENTS_CACHE.length) {
      const o = document.createElement("option");
      o.value = "";
      o.textContent = "— kein Empfänger angelegt —";
      sel.appendChild(o);
      continue;
    }
    RECIPIENTS_CACHE.forEach((r) => {
      const o = document.createElement("option");
      o.value = r.id;
      o.textContent = r.name;
      sel.appendChild(o);
    });
    sel.value = current || last || RECIPIENTS_CACHE[0].id;
  }
}

async function loadProducts() {
  const res = await sendMessage({ type: "sales-list-products" });
  PRODUCTS_CACHE = (res && res.products) || [];
  renderProductDropdown();
  renderProductsList();
}

function renderProductDropdown() {
  const sel = $("product_select");
  if (!sel) return;
  const current = sel.value;
  sel.innerHTML = '<option value="">— freier Artikel —</option>';
  PRODUCTS_CACHE.forEach((p) => {
    const o = document.createElement("option");
    o.value = p.id;
    o.textContent = `${p.name} — ${Number(p.default_price).toFixed(2)} €`;
    sel.appendChild(o);
  });
  sel.value = current;
}

function onProductSelected() {
  const sel = $("product_select");
  const articleEl = $("article");
  const priceEl = $("price");
  const codeEl = $("short_code");
  if (!sel.value) return;
  const p = PRODUCTS_CACHE.find((x) => x.id === sel.value);
  if (!p) return;
  // Vorbefüllen, aber editierbar lassen — der finale Text aus dem Feld
  // landet in Discord (Produkt-Auswahl dient nur der Aggregation per ID).
  articleEl.value = p.name;
  priceEl.value = Number(p.default_price).toFixed(2);
  if (codeEl && p.short_code) codeEl.value = p.short_code;
  recalcFinalPrice();
}

function renderProductsList() {
  const list = $("sales-products-list");
  if (!list) return;
  if (!PRODUCTS_CACHE.length) {
    list.innerHTML = '<div class="sales-empty">Noch keine Produkte angelegt.</div>';
    return;
  }
  list.innerHTML = PRODUCTS_CACHE.map(
    (p) => {
      const code = (p.short_code || "").trim();
      const codeChip = code ? `<span style="background:var(--c-yellow);color:var(--c-text-on-yellow);font-weight:700;padding:1px 6px;border-radius:4px;font-size:10px;margin-right:6px;">${escapeHtml(code)}</span>` : "";
      return `<div class="product-card" data-id="${escapeHtml(p.id)}">` +
        `<div class="pc-name">${codeChip}${escapeHtml(p.name)}</div>` +
        `<div class="pc-price">${Number(p.default_price).toFixed(2)} €</div>` +
        `<button class="pc-del" data-act="del" type="button">Löschen</button>` +
        `</div>`;
    }
  ).join("");
  list.querySelectorAll('[data-act="del"]').forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.closest(".product-card").getAttribute("data-id");
      if (!confirm("Produkt wirklich löschen?")) return;
      await sendMessage({ type: "sales-delete-product", product_id: id });
      await loadProducts();
    });
  });
}

async function renderSalesSession() {
  const view = $("sales-session-view");
  if (!view) return;
  const ovSel = $("overview_recipient_select");
  const recipientId = (ovSel && ovSel.value) || (await getLastRecipientId()) || "";
  const res = await sendMessage({
    type: "sales-get-session",
    payload: { recipient_id: recipientId },
  });
  const wrapper = (res && res.session) || { recipient: null, session: { items: [] } };
  // Backward-compat: alter Schema (nur session-objekt)
  const sess = wrapper.session || wrapper;
  const rcp = wrapper.recipient || null;
  const items = (sess.items || []).slice().sort((a, b) =>
    String(a.name || "").toLowerCase().localeCompare(String(b.name || "").toLowerCase(), "de")
  );

  let header = "";
  if (rcp && rcp.name) {
    header = `<div class="sales-meta" style="font-weight:700;color:var(--c-yellow);margin-bottom:6px;">📨 ${escapeHtml(rcp.name)}</div>`;
  }

  if (!items.length) {
    view.innerHTML = header +
      '<div class="sales-empty">Noch keine Sales in dieser Session. Beim nächsten Label mit ausgewähltem Empfänger wird automatisch gezählt.</div>';
    return;
  }
  let html = header;
  if (sess.started_at) {
    try {
      const d = new Date(sess.started_at);
      html += `<div class="sales-meta">Session seit ${d.toLocaleString("de-DE", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })}</div>`;
    } catch (_) {}
  }
  let grand = 0;
  items.forEach((it) => {
    const sub = Number(it.price || 0) * Number(it.qty || 0);
    grand += sub;
    const code = (it.short_code || "").trim();
    const codeChip = code ? `<span style="background:var(--c-yellow);color:var(--c-text-on-yellow);font-weight:700;padding:1px 6px;border-radius:4px;font-size:10px;margin-right:6px;">${escapeHtml(code)}</span>` : "";
    const pid = it.product_id || "";
    html += `<div class="sales-item" data-pid="${escapeHtml(pid)}">`;
    html += `<div class="sales-item-name">${codeChip}${escapeHtml(it.name || "?")}<span style="float:right">`;
    html += `<button class="hi-copy" data-act="edit" type="button" title="Bearbeiten" style="margin-left:4px">✏️</button>`;
    html += `<button class="hi-copy" data-act="del" type="button" title="Löschen" style="margin-left:4px;color:var(--c-error)">🗑</button>`;
    html += `</span></div>`;
    html += `<div class="sales-item-row"><span>Preis pro Unit:</span><span class="val">${Number(it.price || 0).toFixed(2)} €</span></div>`;
    html += `<div class="sales-item-row"><span>quantity:</span><span class="val">${Number(it.qty || 0)}</span></div>`;
    html += `<div class="sales-item-row sum"><span>Summe:</span><span class="val">${sub.toFixed(2)} €</span></div>`;
    html += `<div class="sales-edit-form" style="display:none;margin-top:8px;padding-top:8px;border-top:1px dashed var(--c-border-strong);">`;
    html += `<div class="form-row" style="margin-bottom:6px;"><div class="form-group"><span class="form-label">Artikel</span><input type="text" data-edit="name" value="${escapeHtml(it.name || "")}"></div></div>`;
    html += `<div class="form-row" style="margin-bottom:6px;"><div class="form-group" style="flex:0 0 100px"><span class="form-label">Kürzel</span><input type="text" data-edit="short_code" maxlength="12" value="${escapeHtml(code)}"></div>`;
    html += `<div class="form-group small"><span class="form-label">Preis €</span><input type="number" data-edit="price" step="0.01" min="0" value="${Number(it.price || 0).toFixed(2)}"></div>`;
    html += `<div class="form-group small"><span class="form-label">Qty</span><input type="number" data-edit="qty" min="1" step="1" value="${Number(it.qty || 1)}"></div></div>`;
    html += `<div style="display:flex;gap:6px;"><button class="btn-parse" data-act="save" type="button" style="flex:1">Speichern</button><button class="btn-parse" data-act="cancel" type="button" style="flex:0 0 90px">Abbrechen</button></div>`;
    html += `</div>`;
    html += "</div>";
  });
  html += `<div class="sales-grand">Gesamt: ${grand.toFixed(2)} €</div>`;
  view.innerHTML = html;

  // Event-Handler für Edit/Delete pro Item
  view.querySelectorAll(".sales-item").forEach((card) => {
    const pid = card.getAttribute("data-pid");
    const editBtn = card.querySelector('[data-act="edit"]');
    const delBtn = card.querySelector('[data-act="del"]');
    const editForm = card.querySelector(".sales-edit-form");
    const saveBtn = card.querySelector('[data-act="save"]');
    const cancelBtn = card.querySelector('[data-act="cancel"]');

    if (editBtn) editBtn.addEventListener("click", () => {
      editForm.style.display = editForm.style.display === "none" ? "block" : "none";
    });
    if (cancelBtn) cancelBtn.addEventListener("click", () => {
      editForm.style.display = "none";
    });
    if (saveBtn) saveBtn.addEventListener("click", async () => {
      const ovSel2 = $("overview_recipient_select");
      const rid = (ovSel2 && ovSel2.value) || "";
      const payload = { recipient_id: rid, product_id: pid };
      card.querySelectorAll("[data-edit]").forEach((inp) => {
        payload[inp.getAttribute("data-edit")] = inp.value;
      });
      saveBtn.disabled = true;
      saveBtn.textContent = "Speichert…";
      const res = await sendMessage({ type: "sales-update-item", payload });
      if (res && res.success) {
        await renderSalesSession();
      } else {
        saveBtn.disabled = false;
        saveBtn.textContent = "Speichern";
        alert("Fehler: " + ((res && res.error) || "unbekannt"));
      }
    });
    if (delBtn) delBtn.addEventListener("click", async () => {
      if (!confirm("Diesen Sale wirklich löschen?")) return;
      const ovSel2 = $("overview_recipient_select");
      const rid = (ovSel2 && ovSel2.value) || "";
      const res = await sendMessage({
        type: "sales-delete-item",
        payload: { recipient_id: rid, product_id: pid },
      });
      if (res && res.success) {
        await renderSalesSession();
      } else {
        alert("Fehler: " + ((res && res.error) || "unbekannt"));
      }
    });
  });
}

async function addProduct() {
  const name = $("new-product-name").value.trim();
  const price = $("new-product-price").value;
  const shortCode = ($("new-product-short") && $("new-product-short").value || "").trim().slice(0, 12);
  if (!name) {
    alert("Bitte Produktname angeben.");
    return;
  }
  const res = await sendMessage({
    type: "sales-upsert-product",
    payload: { name, default_price: price || 0, short_code: shortCode },
  });
  if (res && res.success) {
    $("new-product-name").value = "";
    $("new-product-price").value = "";
    if ($("new-product-short")) $("new-product-short").value = "";
    await loadProducts();
  } else {
    alert((res && res.error) || "Konnte Produkt nicht anlegen.");
  }
}

async function resetSales() {
  const ovSel = $("overview_recipient_select");
  const rid = (ovSel && ovSel.value) || "";
  const rcp = RECIPIENTS_CACHE.find((r) => r.id === rid);
  const label = rcp ? rcp.name : "diese";
  if (!confirm(`Aggregat von „${label}" wirklich schließen und auf 0 zurücksetzen?`)) return;
  await sendMessage({ type: "sales-reset", payload: { recipient_id: rid } });
  await renderSalesSession();
}

// --- Retoure -------------------------------------------------------------

function doParseReturnAddress() {
  const raw = $("ret-raw-address").value.trim();
  if (!raw) return;
  const d = parseAddress(raw);
  $("ret-name").value = d.name || "";
  $("ret-street").value = d.street || "";
  $("ret-street_number").value = d.street_number || "";
  $("ret-postal_code").value = d.postal_code || "";
  $("ret-city").value = d.city || "";
}

async function createReturnLabel() {
  const data = {
    name: $("ret-name").value.trim(),
    email: $("ret-email").value.trim(),
    street: $("ret-street").value.trim(),
    street_number: $("ret-street_number").value.trim(),
    postal_code: $("ret-postal_code").value.trim(),
    city: $("ret-city").value.trim(),
    weight: $("ret-weight").value,
    ref_no: $("ret-ref_no").value.trim(),
  };
  if (!data.name || !data.street || !data.street_number || !data.postal_code || !data.city) {
    showReturnError("Bitte Name, Strasse, Nr., PLZ und Ort ausfüllen.");
    return;
  }
  if (!data.weight || parseFloat(data.weight) <= 0) {
    showReturnError("Bitte ein gültiges Gewicht eingeben.");
    return;
  }
  if (!data.ref_no || data.ref_no.length < 8 || data.ref_no.length > 35) {
    showReturnError("Sendungsreferenz muss zwischen 8 und 35 Zeichen lang sein.");
    return;
  }

  const btn = $("btn-create-return");
  const loading = $("ret-loading");
  const div = $("ret-result");
  btn.disabled = true;
  loading.classList.add("show");
  div.classList.remove("show");

  const result = await sendMessage({ type: "create-return", payload: data });

  btn.disabled = false;
  loading.classList.remove("show");

  if (result && result.success) {
    showReturnSuccess(result, data.ref_no);
    refreshHistoryBadge();
  } else {
    showReturnError((result && result.error) || "Unbekannter Fehler");
  }
}

function showReturnSuccess(r, refNo) {
  const div = $("ret-result");
  const shipNo = r.shipment_number || "";
  let h = '<div class="result-success"><h3>✅ Retourenlabel erstellt</h3>';
  if (shipNo) h += `<p>Sendungsnummer: <span class="mono">${escapeHtml(shipNo)}</span></p>`;
  if (refNo) h += `<p>Referenz: <span class="mono">${escapeHtml(refNo)}</span></p>`;
  if (r.routing_code) h += `<p>Routing-Code: <span class="mono">${escapeHtml(r.routing_code)}</span></p>`;
  if (r.label_pdf_base64) {
    h += `<a class="btn-download" href="data:application/pdf;base64,${r.label_pdf_base64}" download="retoure_${escapeHtml(shipNo)}.pdf">📄 Retourenlabel (PDF)</a>`;
  }
  if (r.qr_pdf_base64) {
    h += `<a class="btn-download" href="data:application/pdf;base64,${r.qr_pdf_base64}" download="retoure_qr_${escapeHtml(shipNo)}.pdf">📱 QR-Label (PDF)</a>`;
  }
  h += '<button class="btn-new" id="btn-ret-new">+ Neue Retoure</button>';
  h += "</div>";
  div.innerHTML = h;
  div.classList.add("show");
  div.scrollIntoView({ behavior: "smooth", block: "nearest" });
  const newBtn = $("btn-ret-new");
  if (newBtn) newBtn.addEventListener("click", resetReturnForm);
}

function showReturnError(msg) {
  const div = $("ret-result");
  div.innerHTML = `<div class="result-error"><h3>❌ Fehler</h3><p>${escapeHtml(msg)}</p></div>`;
  div.classList.add("show");
  div.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function resetReturnForm() {
  ["ret-raw-address", "ret-name", "ret-email", "ret-street", "ret-street_number", "ret-postal_code", "ret-city", "ret-weight", "ret-ref_no"].forEach(
    (id) => {
      const el = $(id);
      if (el) el.value = "";
    }
  );
  $("ret-result").classList.remove("show");
  window.scrollTo({ top: 0, behavior: "smooth" });
}

// --- Adresse parsen ------------------------------------------------------

function doParseAddress() {
  const raw = $("raw-address").value.trim();
  if (!raw) return;
  const d = parseAddress(raw);

  // Wenn der Parser einen Adresstyp erkennt (z.B. packstation), Button umschalten
  if (d.addr_type && ADDR_TYPE_CONFIG[d.addr_type]) {
    const radio = document.querySelector(`input[name="addr_type"][value="${d.addr_type}"]`);
    if (radio && !radio.checked) {
      radio.checked = true;
      applyAddrType();
    }
  }

  const type = getAddrType();

  $("name").value = d.name || "";
  // name2 wird nie automatisch befüllt (Land/Telefon-Müll vermeiden)
  $("postal_code").value = d.postal_code || "";
  $("city").value = d.city || "";

  // street/street_number befüllen für street und packstation
  // (bei street → Strasse+Nr, bei packstation → Postnummer+Station-Nr)
  if (type === "street" || type === "packstation") {
    $("street").value = d.street || "";
    $("street_number").value = d.street_number || "";
  }

  const ids = ["name", "postal_code", "city"];
  if (type === "street" || type === "packstation") ids.push("street", "street_number");
  ids.forEach((id) => {
    const el = $(id);
    if (!el || !el.value) return;
    el.style.borderColor = "#00884A";
    setTimeout(() => {
      el.style.borderColor = "";
    }, 1500);
  });
}

// --- Label erstellen -----------------------------------------------------

async function createLabel() {
  const addrType = getAddrType();
  const cfg = ADDR_TYPE_CONFIG[addrType] || ADDR_TYPE_CONFIG.street;

  const data = {
    name: $("name").value.trim(),
    name2: $("name2").value.trim(),
    addr_type: addrType,
    street: $("street").value.trim(),
    street_number: $("street_number").value.trim(),
    postal_code: $("postal_code").value.trim(),
    city: $("city").value.trim(),
    weight: $("weight").value,
    product: document.querySelector('input[name="product"]:checked').value,
    ref_no: $("ref_no").value.trim(),
    shipper_index: $("shipper").value,
    article: $("article").value.trim(),
    short_code: ($("short_code") && $("short_code").value || "").trim().slice(0, 12),
    price: $("price").value,
    fees: $("fees").value,
    final_price: computeFinalPrice($("price").value, $("fees").value),
    qty: Math.max(1, parseInt($("qty") && $("qty").value || "1", 10) || 1),
  };

  // Adresstyp-spezifische Pflichtfelder
  if (!data.name || !data.postal_code || !data.city) {
    showError("Bitte Name, PLZ und Ort ausfüllen.");
    return;
  }
  if (cfg.f1Required && !data.street) {
    showError(`Bitte "${cfg.f1Label}" ausfüllen.`);
    return;
  }
  if (cfg.f2Required && !data.street_number) {
    showError(`Bitte "${cfg.f2Label}" ausfüllen.`);
    return;
  }

  // Format-Checks für DHL-Sondertypen
  if (addrType === "packstation") {
    if (!/^\d{6,12}$/.test(data.street)) {
      showError("Postnummer muss aus 6 bis 12 Ziffern bestehen.");
      return;
    }
    if (!/^\d{1,3}$/.test(data.street_number)) {
      showError("Packstation-Nummer muss aus 1 bis 3 Ziffern bestehen.");
      return;
    }
  }
  if (addrType === "filiale") {
    if (data.street && !/^\d{6,12}$/.test(data.street)) {
      showError("Postnummer muss aus 6 bis 12 Ziffern bestehen (oder leer lassen).");
      return;
    }
    if (!/^\d{1,3}$/.test(data.street_number)) {
      showError("Filial-Nummer muss aus 1 bis 3 Ziffern bestehen.");
      return;
    }
  }
  if (!data.weight || parseFloat(data.weight) <= 0) {
    showError("Bitte ein gültiges Gewicht eingeben.");
    return;
  }
  if (!data.ref_no || data.ref_no.length < 8 || data.ref_no.length > 35) {
    showError("Sendungsreferenz muss zwischen 8 und 35 Zeichen lang sein.");
    return;
  }
  if (data.product === "V62KP" && parseFloat(data.weight) > 1.0) {
    showError("DHL Kleinpaket: maximales Gewicht ist 1 kg.");
    return;
  }
  if (addrType === "filiale" && data.product === "V62KP") {
    showError("DHL Kleinpaket ist bei Lieferung an eine Filiale nicht verfügbar.");
    return;
  }
  if (data.product === "V01PAK" && parseFloat(data.weight) > 31.5) {
    showError("DHL Paket: maximales Gewicht ist 31,5 kg.");
    return;
  }

  const btn = $("btn-create");
  const loading = $("loading");
  const resultDiv = $("result");

  btn.disabled = true;
  loading.classList.add("show");
  resultDiv.classList.remove("show");

  const result = await sendMessage({ type: "create-label", payload: data });

  btn.disabled = false;
  loading.classList.remove("show");

  if (result && result.success) {
    showSuccess(result, data.ref_no);
    refreshHistoryBadge();

    // Sales-Aggregation: ausgewähltes Produkt ODER frei eingegebener Artikel.
    // Discord-Anzeige nutzt IMMER den Text aus dem Artikel-Feld (data.article);
    // product_id (falls vorhanden) bestimmt nur, wie aggregiert wird.
    const productId = ($("product_select") && $("product_select").value) || "";
    const recipientId = ($("recipient_select") && $("recipient_select").value) || "";
    if (data.article || productId) {
      // Letzte Auswahl merken
      if (recipientId) await setLastRecipientId(recipientId);

      // Robuster Name-Fallback: Cache → Dropdown-Text → Platzhalter.
      // Wichtig: Flask weist Tracks mit leerem name als 400 ab (silent fail im UI).
      let resolvedName = (data.article || "").trim();
      if (!resolvedName && productId) {
        const fromCache = ((PRODUCTS_CACHE || []).find((p) => p.id === productId) || {}).name;
        const selEl = $("product_select");
        const fromDropdown = selEl && selEl.selectedOptions && selEl.selectedOptions[0]
          ? (selEl.selectedOptions[0].textContent || "").trim()
          : "";
        resolvedName = fromCache || fromDropdown || "";
      }
      // Letzte Notbremse — niemals leer absenden
      if (!resolvedName) resolvedName = data.short_code || "Artikel";

      const trackRes = await sendMessage({
        type: "sales-track",
        payload: {
          recipient_id: recipientId,
          product_id: productId,
          name: resolvedName,
          short_code: data.short_code || "",
          price: data.final_price || data.price || "",
          qty: data.qty || 1,
        },
      }).catch((e) => ({ success: false, error: String(e && e.message || e) }));

      // Bei Erfolg: Overview-Switcher auf den TATSÄCHLICH getrackten Empfänger ziehen
      // (Server kann auf last_recipient_id / ersten Empfänger zurückfallen, wenn rid leer ist)
      const trackedId = (trackRes && trackRes.recipient && trackRes.recipient.id)
        || recipientId
        || (await getLastRecipientId());
      const ovSel = $("overview_recipient_select");
      if (ovSel && trackedId) ovSel.value = trackedId;

      // Render erzwingen, AWAIT damit Folge-Aktionen die neue Liste sehen
      try { await renderSalesSession(); } catch (_) {}

      if (trackRes && trackRes.success) {
        playSaleSound();
      } else {
        // Sichtbar machen statt silent zu schlucken — Warnung an die Erfolgsmeldung anhängen,
        // damit die Sendungsnummer nicht überschrieben wird.
        const errMsg = (trackRes && trackRes.error) || "Sales-Track fehlgeschlagen.";
        console.warn("[sales-track]", errMsg, trackRes);
        const resultBox = $("result");
        if (resultBox) {
          const warn = document.createElement("div");
          warn.style.cssText = "margin-top:8px;padding:6px 10px;background:#fef3c7;color:#92400e;border-radius:6px;font-size:12px;";
          warn.textContent = "⚠ Sales-Tracking fehlgeschlagen: " + errMsg;
          resultBox.appendChild(warn);
        }
      }

      // Flask-Status neu prüfen — falls dazwischen offline gefallen
      const health = await sendMessage({ type: "flask-health" });
      updateFlaskBanner(health && health.online);
    }

    // Auto-Druck, falls in den Optionen aktiviert
    const { settings } = await chrome.storage.local.get("settings");
    if (settings && settings.auto_print && result.label_pdf_base64) {
      openPrintWindow(result.label_pdf_base64, result.shipment_number);
    }
  } else {
    showError((result && result.error) || "Unbekannter Fehler");
  }
}

async function openPrintWindow(pdfBase64, shipmentNumber) {
  if (!pdfBase64) return;
  await chrome.storage.local.set({
    pending_print_pdf: pdfBase64,
    pending_print_name: shipmentNumber ? `Label ${shipmentNumber}` : "Label drucken",
  });
  const url = chrome.runtime.getURL("print.html");
  if (chrome.windows && chrome.windows.create) {
    chrome.windows.create({ url, type: "popup", width: 820, height: 920 });
  } else {
    chrome.tabs.create({ url });
  }
}

function computeFinalPrice(priceRaw, feesRaw) {
  const price = parseFloat(String(priceRaw || "").replace(",", "."));
  if (!isFinite(price) || price <= 0) return "";
  const fees = parseFloat(String(feesRaw || "").replace(",", "."));
  const f = isFinite(fees) ? fees : 0;
  const final = price - (price * f / 100);
  return final.toFixed(2);
}

function recalcFinalPrice() {
  const finalEl = $("final-price");
  const amountEl = $("final-price-amount");
  if (!finalEl || !amountEl) return;
  const final = computeFinalPrice($("price").value, $("fees").value);
  if (final === "") {
    finalEl.classList.remove("show");
    return;
  }
  amountEl.textContent = String(final).replace(".", ",") + " €";
  finalEl.classList.add("show");
}

function showSuccess(r, refNo) {
  const div = $("result");
  const shipmentNo = r.shipment_number || "";
  refNo = refNo || "";
  let h = `
    <div class="result-success">
      <h3>✅ Sendung erfolgreich beauftragt</h3>
      <p>Sendungsnummer: <span class="mono">${escapeHtml(shipmentNo)}</span></p>
  `;
  if (refNo) {
    h += `<p>Sendungsreferenz: <span class="mono">${escapeHtml(refNo)}</span></p>`;
  }
  if (r.label_pdf_base64) {
    h += `
      <a class="btn-download" href="data:application/pdf;base64,${r.label_pdf_base64}"
         download="label_${escapeHtml(shipmentNo)}.pdf">📄 Versandlabel herunterladen (PDF)</a>
    `;
    h += `<button class="btn-new" id="btn-print-label" type="button">🖨 Label drucken</button>`;
  } else if (r.label_url) {
    h += `<a class="btn-download" href="${escapeHtml(r.label_url)}" target="_blank" rel="noopener">📄 Versandlabel öffnen</a>`;
  }
  if (shipmentNo) {
    h += `<button class="btn-cancel" id="btn-cancel-shipment" type="button">⛔ Stornieren</button>`;
  }
  h += `<button class="btn-new" id="btn-new">+ Neue Sendung</button>`;
  h += `</div>`;
  div.innerHTML = h;
  div.classList.add("show");
  div.scrollIntoView({ behavior: "smooth", block: "nearest" });
  $("btn-new").addEventListener("click", resetForm);
  const printBtn = $("btn-print-label");
  if (printBtn) {
    printBtn.addEventListener("click", () => openPrintWindow(r.label_pdf_base64, shipmentNo));
  }
  const cancelBtn = $("btn-cancel-shipment");
  if (cancelBtn) {
    cancelBtn.addEventListener("click", () => cancelShipmentFromResult(shipmentNo, cancelBtn));
  }
}

async function cancelShipmentFromResult(shipmentNo, btn) {
  if (!shipmentNo) return;
  if (!confirm(`Sendung ${shipmentNo} im DHL-GKP wirklich stornieren?\n\nDas Label wird ungültig und der Verlauf-Eintrag entfernt.`)) return;
  const originalLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Storniert…";
  const result = await sendMessage({ type: "cancel-shipment", shipment_number: shipmentNo });
  if (result && result.success) {
    const div = $("result");
    div.innerHTML = `<div class="result-success" style="border-color:var(--c-error-border);background:var(--c-error-bg)"><h3 style="color:var(--c-error)">⛔ Sendung storniert</h3><p>Sendungsnummer <span class="mono">${escapeHtml(shipmentNo)}</span> wurde im DHL-GKP storniert.</p><button class="btn-new" id="btn-new">+ Neue Sendung</button></div>`;
    $("btn-new").addEventListener("click", resetForm);
    refreshHistoryBadge();
  } else {
    btn.disabled = false;
    btn.textContent = originalLabel;
    alert("Stornierung fehlgeschlagen: " + ((result && result.error) || "Unbekannter Fehler"));
  }
}

function showError(msg) {
  const div = $("result");
  div.innerHTML = `<div class="result-error"><h3>❌ Fehler</h3><p>${escapeHtml(msg)}</p></div>`;
  div.classList.add("show");
  div.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function resetForm() {
  const qtyEl = $("qty");
  if (qtyEl) qtyEl.value = "1";
  ["raw-address", "name", "name2", "street", "street_number", "postal_code", "city", "weight", "ref_no", "article", "short_code", "price", "fees"].forEach(
    (id) => {
      const el = $(id);
      if (el) el.value = "";
    }
  );
  const finalEl = $("final-price");
  if (finalEl) finalEl.classList.remove("show");
  $("result").classList.remove("show");
  window.scrollTo({ top: 0, behavior: "smooth" });
}

// --- Verlauf -------------------------------------------------------------

async function refreshHistoryBadge() {
  const history = (await sendMessage({ type: "get-history" })) || [];
  const badge = $("history-badge");
  if (Array.isArray(history) && history.length) {
    badge.textContent = history.length;
    badge.style.display = "inline-flex";
  } else {
    badge.style.display = "none";
  }
}

async function openHistory() {
  $("panel-history").classList.add("show");
  await renderHistory();
}

function closeHistory() {
  $("panel-history").classList.remove("show");
}

async function renderHistory() {
  const list = $("history-list");
  const count = $("history-count");
  const history = (await sendMessage({ type: "get-history" })) || [];
  count.textContent = history.length;

  if (!history.length) {
    list.innerHTML = `<div class="history-empty"><div class="icon">📭</div><div>Noch keine Labels erstellt.</div></div>`;
    return;
  }

  list.innerHTML = history
    .map((e) => {
      const r = e.recipient || {};
      const product = PRODUCT_LABELS[e.product] || e.product || "";
      const weight = typeof e.weight_kg === "number" ? e.weight_kg.toFixed(2) + " kg" : "";
      const fullName = r.name2
        ? `${escapeHtml(r.name)} <span style="color:var(--dhl-gray);font-weight:500">/ ${escapeHtml(r.name2)}</span>`
        : escapeHtml(r.name || "");
      const addr = `${escapeHtml(r.street || "")} ${escapeHtml(r.street_number || "")}, ${escapeHtml(r.postal_code || "")} ${escapeHtml(r.city || "")}`;
      const refLine = e.ref_no
        ? `<div class="hi-no"><span class="hi-no-text">Ref: ${escapeHtml(e.ref_no)}</span></div>`
        : "";
      const sandboxChip = e.sandbox ? `<span class="chip sandbox">Sandbox</span>` : "";

      return `
        <div class="history-item" data-no="${escapeHtml(e.shipment_number)}">
          <div class="hi-head">
            <div class="hi-name">${fullName}</div>
            <div class="hi-time">${formatTime(e.created_at)}</div>
          </div>
          <div class="hi-addr">${addr}</div>
          <div class="hi-meta">
            <span class="chip yellow">${escapeHtml(product)}</span>
            ${weight ? `<span class="chip">${weight}</span>` : ""}
            ${sandboxChip}
          </div>
          ${refLine}
          <div class="hi-no">
            <span class="hi-no-text">Sendnr: ${escapeHtml(e.shipment_number)}</span>
          </div>
          <div class="hi-actions">
            <button class="btn-mini" data-act="download" ${e.has_pdf || e.label_url ? "" : "disabled"}>
              ${e.has_pdf ? "📄 Download" : e.label_url ? "🔗 Öffnen" : "— kein PDF —"}
            </button>
            <button class="btn-mini danger" data-act="delete">🗑 Löschen</button>
          </div>
        </div>
      `;
    })
    .join("");

  list.querySelectorAll(".history-item").forEach((el) => {
    const no = el.getAttribute("data-no");
    const downloadBtn = el.querySelector('[data-act="download"]');
    const deleteBtn = el.querySelector('[data-act="delete"]');
    if (downloadBtn) {
      downloadBtn.addEventListener("click", () => downloadHistoryPdf(no));
    }
    if (deleteBtn) {
      deleteBtn.addEventListener("click", () => deleteHistoryItem(no));
    }
  });
}

async function downloadHistoryPdf(shipmentNumber) {
  const history = (await sendMessage({ type: "get-history" })) || [];
  const entry = history.find((e) => e.shipment_number === shipmentNumber);
  if (!entry) return;

  if (entry.has_pdf) {
    const { pdf } = (await sendMessage({ type: "get-pdf", shipment_number: shipmentNumber })) || {};
    if (!pdf) {
      alert("PDF nicht gefunden.");
      return;
    }
    const a = document.createElement("a");
    a.href = `data:application/pdf;base64,${pdf}`;
    a.download = `label_${shipmentNumber}.pdf`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } else if (entry.label_url) {
    chrome.tabs.create({ url: entry.label_url });
  }
}

async function deleteHistoryItem(shipmentNumber) {
  if (!confirm("Diesen Eintrag wirklich löschen?")) return;
  const res = await sendMessage({ type: "delete-history", shipment_number: shipmentNumber });
  if (res && res.success) {
    await renderHistory();
    await refreshHistoryBadge();
  } else {
    alert("Eintrag konnte nicht gelöscht werden.");
  }
}

// --- Tabs ----------------------------------------------------------------

function switchTab(name) {
  document.querySelectorAll(".tab").forEach((t) => {
    t.classList.toggle("active", t.getAttribute("data-tab") === name);
  });
  document.querySelectorAll(".tab-panel").forEach((p) => {
    p.classList.toggle("active", p.id === `tab-${name}`);
  });
  if (name === "sales") {
    renderSalesSession();
    renderProductsList();
  }
}

// --- Init ----------------------------------------------------------------

// Cooldown, damit der Native-Host nicht alle 30s erneut start.bat anwirft.
let _flaskAutoStartTriedAt = 0;
const FLASK_AUTOSTART_COOLDOWN_MS = 60_000;

async function tryAutoStartFlask({ force = false } = {}) {
  if (!force && Date.now() - _flaskAutoStartTriedAt < FLASK_AUTOSTART_COOLDOWN_MS) {
    return { skipped: true };
  }
  _flaskAutoStartTriedAt = Date.now();
  updateFlaskBanner(false, { state: "starting" });
  const r = await sendMessage({ type: "ensure-flask-running" });
  if (r && r.online) return { started: false, alreadyOnline: true };
  if (r && (r.action === "started" || r.action === "noop")) {
    // bis zu 8s auf Flask-Bind warten
    for (let i = 0; i < 8; i++) {
      await new Promise((res) => setTimeout(res, 1000));
      const h = await sendMessage({ type: "flask-health" });
      if (h && h.online) return { started: true };
    }
    return { started: false, timedOut: true };
  }
  // Native-Host nicht registriert -> User muss register_autostart.bat ausführen
  return { started: false, noNativeHost: r && r.action === "no-native-host" };
}

async function syncAndCheckFlask() {
  // 1) Erst Health-Check. Wenn offline -> Auto-Start versuchen.
  let health = await sendMessage({ type: "flask-health" });
  if (!health || !health.online) {
    await tryAutoStartFlask();
    health = await sendMessage({ type: "flask-health" });
  }

  // 2) Wenn online: Sync + Banner aus.
  if (health && health.online) {
    const sync = await sendMessage({ type: "sales-sync-from-flask" });
    updateFlaskBanner(!!(sync && sync.synced));
  } else {
    updateFlaskBanner(false, { state: "offline" });
  }

  await loadRecipients();
  const salesTabActive = document.querySelector('.tab-panel.active[id="tab-sales"]');
  if (salesTabActive) {
    try { await renderSalesSession(); } catch (_) {}
  }
}

// Periodischer Sync während Popup geöffnet ist (alle 30s).
// Holt automatisch neue Empfänger / Sales-Items aus dem Flask-Backend
// (bzw. zeigt den Offline-Banner wenn Flask runterfällt).
let _flaskSyncInterval = null;
function startPeriodicFlaskSync() {
  if (_flaskSyncInterval) return;
  _flaskSyncInterval = setInterval(() => {
    if (document.visibilityState === "visible") {
      syncAndCheckFlask().catch(() => {});
    }
  }, 30000);
}

function updateFlaskBanner(online, opts = {}) {
  const banner = $("flask-banner");
  if (!banner) return;
  if (online) {
    banner.style.display = "none";
    return;
  }
  banner.style.display = "block";

  if (opts.state === "starting") {
    banner.innerHTML =
      '⏳ Backend wird gestartet … (start.bat öffnet ein Konsolenfenster, kann 3-5s dauern)';
    return;
  }

  // Offline-Banner mit manuellem "Backend starten"-Button
  banner.innerHTML = `
    <div style="margin-bottom:8px;">⚠ Flask-Backend (localhost:5000) ist offline — Sales gehen in den lokalen Speicher und sind nicht mit dem Web-UI synchron.</div>
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
      <button id="btn-start-flask" type="button" style="padding:6px 12px;border-radius:4px;border:1px solid var(--c-error);background:#fff;color:var(--c-error);font-weight:600;cursor:pointer;">Backend starten</button>
      <span style="font-weight:400;font-size:11px;opacity:0.85;">Falls das nichts tut: <code>register_autostart.bat</code> einmalig ausführen.</span>
    </div>
  `;
  const btn = $("btn-start-flask");
  if (btn) {
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      btn.textContent = "Starte …";
      const r = await tryAutoStartFlask({ force: true });
      if (r && r.noNativeHost) {
        banner.innerHTML =
          '⚠ Auto-Start nicht eingerichtet. Bitte einmalig <code>register_autostart.bat</code> ausführen (siehe README) oder <code>start.bat</code> manuell starten.';
        return;
      }
      // health wird nach 1s erneut geprüft
      setTimeout(() => syncAndCheckFlask().catch(() => {}), 500);
    });
  }
}

document.addEventListener("DOMContentLoaded", () => {
  setShipDate();
  loadSettings();
  loadProducts();
  loadRecipients();
  refreshHistoryBadge();
  applyAddrType();
  syncAndCheckFlask();
  startPeriodicFlaskSync();
  // Wenn das Side-Panel wieder sichtbar wird (z.B. Tab-Wechsel zurück),
  // sofort einmal syncen statt auf den nächsten 30s-Tick zu warten.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      syncAndCheckFlask().catch(() => {});
    }
  });

  $("btn-parse").addEventListener("click", doParseAddress);
  $("btn-create").addEventListener("click", createLabel);
  $("btn-history").addEventListener("click", openHistory);
  $("btn-history-close").addEventListener("click", closeHistory);
  $("btn-options").addEventListener("click", () => chrome.runtime.openOptionsPage());

  // Produkt-Dropdown
  const prodSel = $("product_select");
  if (prodSel) prodSel.addEventListener("change", onProductSelected);

  // Empfänger-Dropdown im Form: bei Wechsel last_recipient_id merken
  const recSel = $("recipient_select");
  if (recSel) recSel.addEventListener("change", () => {
    if (recSel.value) setLastRecipientId(recSel.value);
  });

  // Overview-Switcher: bei Wechsel die Liste neu rendern
  const ovSel = $("overview_recipient_select");
  if (ovSel) ovSel.addEventListener("change", () => renderSalesSession());

  // Retoure
  const btnRetParse = $("btn-ret-parse");
  if (btnRetParse) btnRetParse.addEventListener("click", doParseReturnAddress);
  const btnRet = $("btn-create-return");
  if (btnRet) btnRet.addEventListener("click", createReturnLabel);
  const retWeight = $("ret-weight");
  if (retWeight) retWeight.addEventListener("keydown", (e) => { if (e.key === "Enter") createReturnLabel(); });
  const retRef = $("ret-ref_no");
  if (retRef) retRef.addEventListener("keydown", (e) => { if (e.key === "Enter") createReturnLabel(); });

  // Sales
  const btnAddProd = $("btn-add-product");
  if (btnAddProd) btnAddProd.addEventListener("click", addProduct);
  const btnReset = $("btn-sales-reset");
  if (btnReset) btnReset.addEventListener("click", resetSales);

  document.querySelectorAll(".tab").forEach((t) => {
    t.addEventListener("click", () => switchTab(t.getAttribute("data-tab")));
  });

  document.querySelectorAll('input[name="addr_type"]').forEach((r) => {
    r.addEventListener("change", applyAddrType);
  });

  $("weight").addEventListener("keydown", (e) => {
    if (e.key === "Enter") createLabel();
  });
  $("ref_no").addEventListener("keydown", (e) => {
    if (e.key === "Enter") createLabel();
  });
  $("price").addEventListener("input", recalcFinalPrice);
  $("fees").addEventListener("input", recalcFinalPrice);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeHistory();
  });
});
