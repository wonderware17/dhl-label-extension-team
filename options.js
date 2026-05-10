// Optionen-Seite: Settings laden / speichern / Absender + Rechnungs-Empfänger verwalten

const $ = (id) => document.getElementById(id);

const SHIPPER_FIELDS = ["label", "name", "street", "street_number", "postal_code", "city", "country"];
const RECIPIENT_FIELDS = ["id", "name", "webhook_url"];

const DEFAULT_SETTINGS = {
  api_key: "",
  username: "",
  password: "",
  sandbox: false,
  auto_print: false,
  print_format: "910-300-400",
  billing_paket: "",
  billing_paeckchen: "",
  billing_returns: "",
  returns_receiver_id: "",
  shippers: [],
  products: [],
  recipients: [],
  sessions: {},
  last_recipient_id: null,
};

function emptyShipper() {
  return { label: "", name: "", street: "", street_number: "", postal_code: "", city: "", country: "DEU" };
}

function emptyRecipient() {
  return { id: "", name: "", webhook_url: "" };
}

function sendMessage(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (response) => resolve(response));
  });
}

// --- Render: Absender ----------------------------------------------------

function addShipperCard(data) {
  const tpl = $("shipper-template");
  const node = tpl.content.firstElementChild.cloneNode(true);
  SHIPPER_FIELDS.forEach((f) => {
    const inp = node.querySelector(`[data-field="${f}"]`);
    if (inp && data[f] != null) inp.value = data[f];
  });
  node.querySelector('[data-act="remove"]').addEventListener("click", () => {
    node.remove();
    renumberShippers();
  });
  $("shippers-list").appendChild(node);
  renumberShippers();
}

function renumberShippers() {
  const cards = $("shippers-list").querySelectorAll(".shipper-card");
  cards.forEach((c, i) => {
    c.querySelector(".num").textContent = `Absender ${i + 1}`;
  });
}

function readShippers() {
  const result = [];
  const cards = $("shippers-list").querySelectorAll(".shipper-card");
  for (const card of cards) {
    const sh = {};
    SHIPPER_FIELDS.forEach((f) => {
      const inp = card.querySelector(`[data-field="${f}"]`);
      sh[f] = inp ? inp.value.trim() : "";
    });
    if (!sh.country) sh.country = "DEU";
    result.push(sh);
  }
  return result;
}

// --- Render: Rechnungs-Empfänger -----------------------------------------

function addRecipientCard(data) {
  const tpl = $("recipient-template");
  const node = tpl.content.firstElementChild.cloneNode(true);
  RECIPIENT_FIELDS.forEach((f) => {
    const inp = node.querySelector(`[data-field="${f}"]`);
    if (inp && data[f] != null) inp.value = data[f];
  });
  node.querySelector('[data-act="remove"]').addEventListener("click", () => {
    node.remove();
    renumberRecipients();
  });
  $("recipients-list").appendChild(node);
  renumberRecipients();
}

function renumberRecipients() {
  const cards = $("recipients-list").querySelectorAll(".shipper-card");
  cards.forEach((c, i) => {
    c.querySelector(".num").textContent = `Empfänger ${i + 1}`;
  });
}

function readRecipients() {
  const result = [];
  const cards = $("recipients-list").querySelectorAll(".shipper-card");
  for (const card of cards) {
    const r = {};
    RECIPIENT_FIELDS.forEach((f) => {
      const inp = card.querySelector(`[data-field="${f}"]`);
      r[f] = inp ? inp.value.trim() : "";
    });
    result.push(r);
  }
  return result;
}

// --- Load / Save ----------------------------------------------------------

async function loadSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  const s = { ...DEFAULT_SETTINGS, ...(settings || {}) };

  $("api_key").value = s.api_key || "";
  $("username").value = s.username || "";
  $("password").value = s.password || "";
  $("sandbox").checked = !!s.sandbox;
  $("auto_print").checked = !!s.auto_print;
  $("print_format").value = s.print_format || "910-300-400";
  $("billing_paket").value = s.billing_paket || "";
  $("billing_paeckchen").value = s.billing_paeckchen || "";
  $("billing_returns").value = s.billing_returns || "";
  $("returns_receiver_id").value = s.returns_receiver_id || "";

  $("shippers-list").innerHTML = "";
  if (s.shippers && s.shippers.length) {
    s.shippers.forEach((sh) => addShipperCard(sh));
  } else {
    addShipperCard(emptyShipper());
  }

  // Empfänger via Message-API laden (Flask-first, lokal fallback)
  $("recipients-list").innerHTML = "";
  const r = await sendMessage({ type: "sales-list-recipients" });
  const recipients = (r && r.recipients) || [];
  if (recipients.length) {
    recipients.forEach((rcp) => addRecipientCard(rcp));
  } else {
    addRecipientCard(emptyRecipient());
  }
}

function validateShippers(shippers) {
  for (let i = 0; i < shippers.length; i++) {
    const sh = shippers[i];
    for (const f of ["label", "name", "street", "street_number", "postal_code", "city"]) {
      if (!sh[f]) {
        return `Absender ${i + 1}: Feld "${f}" ist leer.`;
      }
    }
    if (!/^\d{5}$/.test(sh.postal_code)) {
      return `Absender ${i + 1}: PLZ muss 5-stellig sein.`;
    }
  }
  return null;
}

function validateRecipients(recipients) {
  for (let i = 0; i < recipients.length; i++) {
    const r = recipients[i];
    if (!r.name) return `Empfänger ${i + 1}: Name ist leer.`;
  }
  return null;
}

async function saveSettings(opts) {
  const silent = !!(opts && opts.silent);
  const status = $("save-status");
  if (!silent) {
    status.className = "save-status";
    status.textContent = "";
  }

  // Bestehende Fallback-Sales-Daten beim Speichern bewahren
  const { settings: existing } = await chrome.storage.local.get("settings");
  const existingProducts = (existing && existing.products) || [];
  const existingRecipients = (existing && existing.recipients) || [];
  const existingSessions = (existing && existing.sessions) || {};
  const existingLast = (existing && existing.last_recipient_id) || null;

  const recipientsForm = readRecipients();
  // Leere/unausgefüllte Karten ignorieren (z. B. die initial leere)
  const recipientsCleaned = recipientsForm.filter((r) => r.name);

  const settings = {
    api_key: $("api_key").value.trim(),
    username: $("username").value.trim(),
    password: $("password").value,
    sandbox: $("sandbox").checked,
    auto_print: $("auto_print").checked,
    print_format: $("print_format").value || "910-300-400",
    billing_paket: $("billing_paket").value.trim(),
    billing_paeckchen: $("billing_paeckchen").value.trim(),
    billing_returns: $("billing_returns").value.trim(),
    returns_receiver_id: $("returns_receiver_id").value.trim(),
    shippers: readShippers(),
    products: existingProducts,
    // WICHTIG: bestehende recipients beibehalten — die Message-API unten
    // synchronisiert dann alles. Wenn wir hier auf [] setzen würden, würden
    // local-only Empfänger bei Flask-Offline verloren gehen.
    recipients: existingRecipients,
    sessions: existingSessions,
    last_recipient_id: existingLast,
  };

  // Validation
  const fail = (msg) => {
    if (silent) {
      // Im Auto-Save-Modus den Fehler dezent zeigen aber nicht aufhalten
      status.className = "save-status";
      status.textContent = "";
      return true;
    }
    status.className = "save-status error";
    status.textContent = msg;
    return true;
  };

  // Im manuellen Save: harte Validation (mit Abbruch).
  // Im Auto-Save: nur "weiche" Felder überspringen — leere Pflichtfelder = einfach noch nicht speichern.
  if (!settings.api_key || !settings.username || !settings.password) {
    if (silent) { status.textContent = ""; return; }
    return fail("Bitte API-Key, Benutzername und Passwort ausfüllen.") && undefined;
  }
  for (const k of ["billing_paket", "billing_paeckchen", "billing_returns"]) {
    if (settings[k] && !/^\d{14}$/.test(settings[k])) {
      if (silent) { status.textContent = ""; return; }
      return fail(`Abrechnungsnummer muss 14-stellig sein (${k}).`) && undefined;
    }
  }
  if (!settings.shippers.length) {
    if (silent) { status.textContent = ""; return; }
    return fail("Bitte mindestens einen Absender anlegen.") && undefined;
  }
  const shipperErr = validateShippers(settings.shippers);
  if (shipperErr) {
    if (silent) { status.textContent = ""; return; }
    return fail(shipperErr) && undefined;
  }
  const rcpErr = validateRecipients(recipientsCleaned);
  if (rcpErr) {
    if (silent) { status.textContent = ""; return; }
    return fail(rcpErr) && undefined;
  }

  // Erstmal die Basics speichern (alles außer recipients)
  await chrome.storage.local.set({ settings });

  // Empfänger via Message-API synchronisieren:
  // 1) bestehende Liste holen → Diff zu submitted bilden
  const before = (await sendMessage({ type: "sales-list-recipients" })) || {};
  const existingRcps = (before.recipients) || [];
  const submittedIds = new Set(recipientsCleaned.filter((r) => r.id).map((r) => r.id));

  // Gelöschte: existierten vorher, fehlen jetzt
  for (const ex of existingRcps) {
    if (!submittedIds.has(ex.id)) {
      await sendMessage({ type: "sales-delete-recipient", recipient_id: ex.id });
    }
  }
  // Hinzufügen / Aktualisieren
  for (const r of recipientsCleaned) {
    await sendMessage({ type: "sales-upsert-recipient", payload: r });
  }

  status.className = "save-status success";
  status.textContent = silent ? "✓ Auto-gespeichert" : "✓ Gespeichert";
  setTimeout(() => { status.textContent = ""; }, silent ? 1500 : 3000);
}

async function resetSettings() {
  if (!confirm("Alle Einstellungen wirklich zurücksetzen? Verlauf bleibt erhalten.")) return;
  await chrome.storage.local.set({ settings: { ...DEFAULT_SETTINGS } });
  await loadSettings();
}

// --- Init -----------------------------------------------------------------

// Auto-Save: debounced bei jeder Input-/Change-Aktion
let _autoSaveTimer = null;
let _autoSaveSilent = false;
function scheduleAutoSave() {
  if (_autoSaveSilent) return;
  if (_autoSaveTimer) clearTimeout(_autoSaveTimer);
  const status = $("save-status");
  if (status) {
    status.className = "save-status";
    status.textContent = "Speichert…";
  }
  _autoSaveTimer = setTimeout(async () => {
    _autoSaveTimer = null;
    await saveSettings({ silent: true });
  }, 800);
}

function bindAutoSave() {
  // Alle Inputs + Selects + Checkboxes auf den Optionen-Bereichen
  document.querySelectorAll("#api_key, #username, #password, #sandbox, #auto_print, #print_format, #billing_paket, #billing_paeckchen, #billing_returns, #returns_receiver_id").forEach((el) => {
    const evt = (el.type === "checkbox" || el.tagName === "SELECT") ? "change" : "input";
    el.addEventListener(evt, scheduleAutoSave);
  });
  // Shipper-Karten + Empfänger-Karten: per Event-Delegation auf den Containern
  ["shippers-list", "recipients-list"].forEach((id) => {
    const container = $(id);
    if (!container) return;
    container.addEventListener("input", scheduleAutoSave);
    container.addEventListener("change", scheduleAutoSave);
  });
}

document.addEventListener("DOMContentLoaded", async () => {
  // Erst Sync von Flask, damit die Empfänger-Liste mit Flask aktuell ist
  // (best-effort — schlägt still fehl wenn Flask offline)
  try { await sendMessage({ type: "sales-sync-from-flask" }); } catch (_) {}
  _autoSaveSilent = true; // beim initialen Laden keinen Auto-Save triggern
  await loadSettings();
  _autoSaveSilent = false;
  bindAutoSave();
  $("btn-save").addEventListener("click", () => saveSettings({ silent: false }));
  $("btn-reset").addEventListener("click", resetSettings);
  $("btn-add-shipper").addEventListener("click", () => {
    addShipperCard(emptyShipper());
    scheduleAutoSave();
  });
  $("btn-add-recipient").addEventListener("click", () => {
    addRecipientCard(emptyRecipient());
    // Nicht direkt speichern — leerer Empfänger wäre invalid
  });
});
