// Druck-Viewer: lädt PDF aus Storage als Blob-URL, zeigt es im Iframe
// und druckt mit der nativen PDF-Seitengröße.

function base64ToBlob(base64, mime) {
  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

function triggerPrint(iframe) {
  // Chrome druckt PDFs aus Iframes mit deren eigener Seitengröße,
  // wenn contentWindow.focus()+print() klappt. Bei sehr frühem Aufruf
  // (PDF-Viewer noch nicht ready) verschluckt Chrome den Aufruf, deshalb
  // erzwingen wir vor dem Druck den Fokus + ein zweiter Versuch nach kurzer Zeit.
  try {
    iframe.contentWindow.focus();
    iframe.contentWindow.print();
  } catch (e) {
    console.warn("contentWindow.print fehlgeschlagen, Fallback window.print:", e);
    try { window.print(); } catch (_) {}
  }
}

async function init() {
  const iframe = document.getElementById("pdf-frame");

  const { pending_print_pdf, pending_print_name } =
    await chrome.storage.local.get(["pending_print_pdf", "pending_print_name"]);

  if (!pending_print_pdf) {
    document.body.innerHTML =
      '<div class="empty">Kein PDF zum Drucken gefunden.<br><button onclick="window.close()">Schließen</button></div>';
    return;
  }

  if (pending_print_name) document.title = pending_print_name;

  const blob = base64ToBlob(pending_print_pdf, "application/pdf");
  const blobUrl = URL.createObjectURL(blob);

  let printed = false;
  iframe.addEventListener("load", () => {
    if (printed) return;
    printed = true;
    // PDF-Viewer braucht einen Moment zum Initialisieren — danach drucken.
    setTimeout(() => triggerPrint(iframe), 800);
  });

  // #toolbar=0 blendet die eingebaute Chrome-PDF-Toolbar aus.
  iframe.src = blobUrl + "#toolbar=0&view=Fit";

  await chrome.storage.local.remove(["pending_print_pdf", "pending_print_name"]);

  document.getElementById("btn-print").addEventListener("click", () => triggerPrint(iframe));
  document.getElementById("btn-close").addEventListener("click", () => {
    URL.revokeObjectURL(blobUrl);
    window.close();
  });
}

init();
