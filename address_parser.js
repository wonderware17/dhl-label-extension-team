// Address-Parser — JS-Port von address_parser.py
// Erkennt Hausanschriften UND DHL-Packstationen.
// Liefert: { name, name2, addr_type, street, street_number, postal_code, city }

(function () {
  const PLZ_CITY_RE = /^(\d{5})\s+(.+)$/;
  const STREET_RE = /^(.+?)\s+(\d+\s*[a-zA-Z]?(?:\s*[-–/]\s*\d+\s*[a-zA-Z]?)?)$/;
  const PACKSTATION_RE = /\bpackstation\s+(\d{1,3})\b/i;
  const FILIALE_RE = /\b(?:post)?filiale\s+(\d{1,3})\b/i;
  const POSTNUMMER_LINE_RE = /^\s*(?:postnummer\s+)?(\d{6,12})\s*$/i;
  const COUNTRY_RE = /^(deutschland|germany|österreich|austria|schweiz|switzerland|de|deu|at|aut|ch|che)\.?$/i;

  function empty() {
    return {
      name: "",
      name2: "",
      addr_type: "street",
      street: "",
      street_number: "",
      postal_code: "",
      city: "",
    };
  }

  // Reine Ziffernfolgen 6-12 sind meist IDs (Postnummer), erst ab >12 Ziffern
  // werten wir es als Telefon. Mit Trennzeichen reicht 6+ Ziffern.
  function isPhoneLine(line) {
    if (/^\d+$/.test(line)) {
      return line.length > 12;
    }
    if (!/^[\d+()\s\/.-]+$/.test(line)) return false;
    const digits = (line.match(/\d/g) || []).length;
    return digits >= 6;
  }

  function parseAddress(rawText) {
    rawText = (rawText || "").trim();
    if (!rawText) return empty();

    const text = rawText.replace(/[,;]+/g, "\n").replace(/[ \t]+/g, " ");
    const lines = text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !COUNTRY_RE.test(l) && !isPhoneLine(l));

    if (!lines.length) return empty();

    // Packstation- / Filiale-Erkennung
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(PACKSTATION_RE);
      if (m) return parseLocker(lines, i, m[1], "packstation");
    }
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(FILIALE_RE);
      if (m) return parseLocker(lines, i, m[1], "filiale");
    }

    return parseStreet(lines);
  }

  function parseLocker(lines, psIdx, stationNo, addrType) {
    const result = empty();
    result.addr_type = addrType;
    result.street_number = stationNo;

    // Postnummer suchen
    let postNumber = "";
    const psLine = lines[psIdx];

    // 1) Gleiche Zeile, irgendwo eine 6-12-stellige Zahl die nicht die Station-Nr ist
    const matches = [...psLine.matchAll(/(?<!\d)(\d{6,12})(?!\d)/g)];
    for (const m of matches) {
      if (m[1] !== stationNo) {
        postNumber = m[1];
        break;
      }
    }

    // 2) Zeile davor / danach
    if (!postNumber) {
      for (const j of [psIdx - 1, psIdx + 1]) {
        if (j >= 0 && j < lines.length) {
          const m = lines[j].match(POSTNUMMER_LINE_RE);
          if (m) {
            postNumber = m[1];
            break;
          }
        }
      }
    }

    result.street = postNumber;

    // PLZ + Ort
    for (const line of lines) {
      const m = line.match(PLZ_CITY_RE);
      if (m) {
        result.postal_code = m[1];
        result.city = m[2].trim();
        break;
      }
    }

    // Name = erste Zeile, die nicht Packstation/Postnummer/PLZ+Ort ist
    const skip = new Set([psIdx]);
    if (postNumber) {
      for (const j of [psIdx - 1, psIdx + 1]) {
        if (j >= 0 && j < lines.length && POSTNUMMER_LINE_RE.test(lines[j])) {
          skip.add(j);
          break;
        }
      }
    }
    for (let i = 0; i < lines.length; i++) {
      if (skip.has(i)) continue;
      if (PLZ_CITY_RE.test(lines[i])) continue;
      if (POSTNUMMER_LINE_RE.test(lines[i])) continue;
      result.name = lines[i];
      break;
    }

    return result;
  }

  function parseStreet(lines) {
    const result = empty();
    result.addr_type = "street";
    const unmatched = [];

    for (const line of lines) {
      let m = line.match(PLZ_CITY_RE);
      if (m && !result.postal_code) {
        result.postal_code = m[1];
        result.city = m[2].trim();
        continue;
      }

      m = line.match(STREET_RE);
      if (m && !result.street) {
        const candStreet = m[1].trim();
        const candNumber = m[2].trim();
        if (!/^\d+$/.test(candStreet)) {
          result.street = candStreet;
          result.street_number = candNumber;
          continue;
        }
      }

      unmatched.push(line);
    }

    if (unmatched.length && !result.name) {
      result.name = unmatched.shift();
    }

    if (unmatched.length && !result.street) {
      const line = unmatched.shift();
      const m = line.match(STREET_RE);
      if (m) {
        result.street = m[1].trim();
        result.street_number = m[2].trim();
      } else {
        result.street = line;
      }
    }

    if (unmatched.length && !result.postal_code) {
      const line = unmatched.shift();
      const m = line.match(PLZ_CITY_RE);
      if (m) {
        result.postal_code = m[1];
        result.city = m[2].trim();
      }
    }

    // name2 wird nie automatisch befüllt.
    return result;
  }

  if (typeof window !== "undefined") {
    window.parseAddress = parseAddress;
  }
  if (typeof self !== "undefined" && typeof window === "undefined") {
    self.parseAddress = parseAddress;
  }
})();
