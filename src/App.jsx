import { useState, useCallback, useRef } from "react";

// ─── Design tokens ───────────────────────────────────────────────────────────
const T = {
  ink:     "#1A1A2E",
  slate:   "#2D3561",
  accent:  "#4361EE",
  mint:    "#06D6A0",
  amber:   "#FFB703",
  rose:    "#EF476F",
  surface: "#F7F8FC",
  card:    "#FFFFFF",
  muted:   "#8892A4",
  border:  "#E4E8F0",
};

const fmt = (n) =>
  new Intl.NumberFormat("nl-BE", { style: "currency", currency: "EUR" }).format(n ?? 0);

// ─── Parsing helpers ─────────────────────────────────────────────────────────
function parseAmount(str) {
  if (!str) return 0;
  // Handle formats like "4.337,62" (BE) or "2995.66" (US)
  const s = String(str).replace(/[€\s]/g, "").trim();
  // Belgian format: dots as thousands separator, comma as decimal
  const beFormat = s.replace(/\./g, "").replace(",", ".");
  const n = parseFloat(beFormat);
  return isNaN(n) ? 0 : n;
}

function parseBankCSV(text) {
  const lines = text.trim().split("\n").slice(1);
  return lines.map((l) => {
    const cols = l.split(";");
    return {
      date:        cols[4]?.trim(),
      valutaDate:  cols[5]?.trim(),
      amount:      parseAmount(cols[6]),
      desc:        (cols[8] || "").trim(),
      detail:      (cols[9] || "").trim(),
      msg:         (cols[10] || "").trim(),
      counterpart: (cols[2] || "").trim(),
    };
  }).filter((r) => r.date);
}

function parsePluxeeCSV(text) {
  const lines = text.trim().split("\n").slice(1);
  return lines.map((l) => {
    // Format: date;"desc";"+ 144 €"
    const cols = l.split(";");
    const raw = (cols[2] || "").replace(/"/g, "").replace("+", "").replace("€", "").trim();
    const amount = parseFloat(raw.replace(",", ".")) || 0;
    return {
      date: cols[0]?.trim(),  // format: DD-MM-YYYY
      desc: (cols[1] || "").replace(/"/g, "").trim(),
      amount,
    };
  }).filter((r) => r.date && r.amount > 0);
}

// Parse loonstrook data from PDF text
// The PDF context already extracted the key values, so we accept manual input too
function parsePDF(text) {
  // Try multiple patterns for Belgian payslip format
  const findAmount = (patterns) => {
    for (const p of patterns) {
      const m = text.match(p);
      if (m) {
        // Handle Belgian number format: 2.995,66 or 2995,66
        const raw = m[1].trim();
        const cleaned = raw.replace(/\./g, "").replace(",", ".");
        const n = parseFloat(cleaned);
        if (!isNaN(n) && n > 0) return n;
      }
    }
    return null;
  };

  const findText = (patterns) => {
    for (const p of patterns) {
      const m = text.match(p);
      if (m) return m[1].trim();
    }
    return null;
  };

  return {
    // "Netto te betalen" is the actual bank transfer amount
    nettoBetalen: findAmount([
      /9881B00\s+Netto te betalen[^\d]*([\d.,]+)/i,
      /Netto te betalen[^\d]*([\d.,]+)/i,
    ]),
    // "Netto totaal" is before the "Positief uit bestand" addition
    nettoTotaal: findAmount([
      /9801B00\s+Netto totaal\s+([\d.,]+)/i,
      /Netto totaal\s+([\d.,]+)/i,
    ]),
    bruto: findAmount([
      /9011B00\s+Bruto\s+([\d.,]+)/i,
      /Bruto\s+([\d.,]+)/i,
    ]),
    rsz: findAmount([
      /9111B00\s+Afhouding R\.S\.Z\. bruto\s+-?([\d.,]+)/i,
      /Afhouding R\.S\.Z\. bruto\s+-?([\d.,]+)/i,
    ]),
    bv: findAmount([
      /9411B00\s+Bedrijfsvoorheffing\s+-?([\d.,]+)/i,
      /Bedrijfsvoorheffing\s+-?([\d.,]+)/i,
    ]),
    periode: findText([
      /LOONSTROOK\s+(\w+\s+\d{4})/i,
      /Periode van \d{2}\.\d{2}\.\d{4} tot \d{2}\.\d{2}\.(\d{4})/,
    ]),
    maandloon: findAmount([/Maandloon\s*:\s*([\d.,]+)/i]),
  };
}

// ─── Category detection ───────────────────────────────────────────────────────
// Transactions to IGNORE from budget (loon dat voor volgende maand is)
const LOON_IGNORE_KEYWORDS = ["mediahuis", "attentia"];

const CATS = [
  { key: "hypotheek",    label: "Hypotheek",         color: T.rose,    icon: "🏠", keywords: ["woningfonds","hypothe"] },
  { key: "energie",      label: "Energie",            color: T.amber,   icon: "⚡", keywords: ["electrabel","engie","luminus","fluvius","eandis"] },
  { key: "internet",     label: "Internet/Telco",     color: T.accent,  icon: "📡", keywords: ["telenet","proximus","scarlet","voo","orange"] },
  { key: "boodschappen", label: "Boodschappen",       color: T.mint,    icon: "🛒", keywords: ["aldi","delhaize","colruyt","lidl","carrefour","albert","jumbo","okay"] },
  { key: "uiteten",      label: "Uit eten",           color: "#FF9F1C", icon: "🍽️", keywords: ["quick","mcdonald","burger","friet","resto","cafetaria","pizza","sushi","kebab","fast","colrest","plopsa","korfmaker","delvican","ticketmaster","kinepolis"] },
  { key: "verzekering",  label: "Verzekeringen",      color: "#7209B7", icon: "🛡️", keywords: ["vivium","ag insur","axa","ethias","ageas","allianz"] },
  { key: "bankkosten",   label: "Bankkosten",         color: T.muted,   icon: "🏦", keywords: ["kostenafrekening","ing go","maandelijkse bijdrage ing"] },
  { key: "paypal",       label: "Online/PayPal",      color: "#0096C7", icon: "🛍️", keywords: ["paypal","temu","amazon","bol.com"] },
  { key: "apotheek",     label: "Medisch",            color: "#E63946", icon: "💊", keywords: ["apotheek","farma","dokter","az waas","vision direct"] },
  { key: "reizen",       label: "Reizen",             color: "#8338EC", icon: "✈️", keywords: ["antalya","tur ","turkler","hasan huseyin","delmaya","bfa outlet","cfd havacilik","tunnel liefkenshoek","arrive belgium"] },
  { key: "sparen",       label: "Spaaroverschrijving",color: T.mint,    icon: "💰", keywords: ["be70363641672925"] },
  { key: "transfer",     label: "Doorstorting",       color: T.slate,   icon: "↔️", keywords: ["winters-huybrechts","sam de ley","debby"] },
  { key: "loon",         label: "Loon (genegeerd)",   color: T.muted,   icon: "💼", keywords: LOON_IGNORE_KEYWORDS },
];

function categorize(tx) {
  const haystack = (tx.desc + " " + tx.detail + " " + tx.msg + " " + tx.counterpart).toLowerCase();
  for (const cat of CATS) {
    if (cat.keywords.some((k) => haystack.includes(k))) return cat;
  }
  return { key: "overig", label: "Overig", color: T.muted, icon: "📦" };
}

// ─── Spaarpot config ─────────────────────────────────────────────────────────
const DEFAULT_POTS = [
  { key: "trouw",     label: "Trouwpot 💍",     color: T.rose,   target: 15000, current: 2800,  priority: 1 },
  { key: "renovatie", label: "Renovatiepot 🔨", color: T.amber,  target: 5000,  current: 2000,  priority: 2 },
  { key: "nood",      label: "Noodpot 🛡️",      color: T.accent, target: 15000, current: 15000, priority: 0 },
];

const FIXED_EXPENSES = {
  hypotheek:   899.58,
  verzekering: 47.48,
  internet:    51.55,
  water:       33.33,
  energie:     150,
};

// ─── Manual payslip input component ──────────────────────────────────────────
function PayslipManualInput({ onSave }) {
  const [vals, setVals] = useState({ nettoBetalen: "", nettoTotaal: "", bruto: "", periode: "" });
  const set = (k, v) => setVals((p) => ({ ...p, [k]: v }));
  const inputStyle = {
    width: "100%", padding: "8px 10px", borderRadius: 8,
    border: `1px solid ${T.border}`, fontSize: 13, fontFamily: "inherit",
  };
  return (
    <div style={{ marginTop: 16, padding: "16px", background: T.surface, borderRadius: 12 }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: T.slate, marginBottom: 12 }}>
        📝 Gegevens loonstrook handmatig invullen
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 12 }}>
        <div>
          <label style={{ fontSize: 11, color: T.muted, display: "block", marginBottom: 4 }}>Netto te betalen (9881B00)</label>
          <input type="number" step="0.01" placeholder="bv. 2995.66" value={vals.nettoBetalen}
            onChange={(e) => set("nettoBetalen", e.target.value)} style={inputStyle} />
        </div>
        <div>
          <label style={{ fontSize: 11, color: T.muted, display: "block", marginBottom: 4 }}>Netto totaal (9801B00)</label>
          <input type="number" step="0.01" placeholder="bv. 2806.97" value={vals.nettoTotaal}
            onChange={(e) => set("nettoTotaal", e.target.value)} style={inputStyle} />
        </div>
        <div>
          <label style={{ fontSize: 11, color: T.muted, display: "block", marginBottom: 4 }}>Bruto (9011B00)</label>
          <input type="number" step="0.01" placeholder="bv. 4337.62" value={vals.bruto}
            onChange={(e) => set("bruto", e.target.value)} style={inputStyle} />
        </div>
        <div>
          <label style={{ fontSize: 11, color: T.muted, display: "block", marginBottom: 4 }}>Periode (bv. APRIL 2026)</label>
          <input type="text" placeholder="bv. APRIL 2026" value={vals.periode}
            onChange={(e) => set("periode", e.target.value)} style={inputStyle} />
        </div>
      </div>
      <button onClick={() => onSave({
        nettoBetalen: parseFloat(vals.nettoBetalen) || 0,
        nettoTotaal:  parseFloat(vals.nettoTotaal) || 0,
        bruto:        parseFloat(vals.bruto) || 0,
        periode:      vals.periode,
      })}
        style={{
          background: T.accent, color: "#fff", border: "none", borderRadius: 8,
          padding: "8px 20px", fontWeight: 600, fontSize: 13, cursor: "pointer",
        }}>
        Opslaan
      </button>
    </div>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function App() {
  const [payslip,       setPayslip]       = useState(null);
  const [bank,          setBank]          = useState(null);
  const [pluxee,        setPluxee]        = useState(null);
  const [pots,          setPots]          = useState(DEFAULT_POTS);
  const [tab,           setTab]           = useState("dashboard");
  const [loading,       setLoading]       = useState({});
  const [month,         setMonth]         = useState(null);  // "MM/YYYY" of de geselecteerde maand
  const [showManual,    setShowManual]    = useState(false);
  const [pdfParseFail,  setPdfParseFail]  = useState(false);

  const bankRef   = useRef();
  const pluxeeRef = useRef();
  const pdfRef    = useRef();

  // ── file handlers ──────────────────────────────────────────────────────────
  const handleBank = useCallback((e) => {
    const file = e.target.files[0]; if (!file) return;
    setLoading((l) => ({ ...l, bank: true }));
    const r = new FileReader();
    r.onload = (ev) => {
      try {
        const rows = parseBankCSV(ev.target.result);
        if (rows[0]?.date) {
          const [d, m, y] = rows[0].date.split("/");
          setMonth(`${m}/${y}`);
        }
        setBank(rows);
      } catch { setBank([]); }
      setLoading((l) => ({ ...l, bank: false }));
    };
    r.readAsText(file, "utf-8");
  }, []);

  const handlePluxee = useCallback((e) => {
    const file = e.target.files[0]; if (!file) return;
    setLoading((l) => ({ ...l, pluxee: true }));
    const r = new FileReader();
    r.onload = (ev) => {
      try { setPluxee(parsePluxeeCSV(ev.target.result)); }
      catch { setPluxee([]); }
      setLoading((l) => ({ ...l, pluxee: false }));
    };
    r.readAsText(file, "utf-8");
  }, []);

  const handlePDF = useCallback((e) => {
    const file = e.target.files[0]; if (!file) return;
    setLoading((l) => ({ ...l, pdf: true }));
    const r = new FileReader();
    r.onload = (ev) => {
      try {
        const parsed = parsePDF(ev.target.result);
        // Check if we got useful data
        if (parsed.nettoBetalen && parsed.nettoBetalen > 100) {
          setPayslip(parsed);
          setPdfParseFail(false);
        } else {
          // PDF text extraction failed (binary PDF), show manual input
          setPdfParseFail(true);
          setShowManual(true);
        }
      } catch {
        setPdfParseFail(true);
        setShowManual(true);
      }
      setLoading((l) => ({ ...l, pdf: false }));
    };
    r.readAsText(file, "latin1");
  }, []);

  // ── derived numbers ────────────────────────────────────────────────────────

  // "Netto te betalen" = het bedrag dat op je rekening komt (incl. onkostenvergoedingen)
  // "Netto totaal" = enkel het loon na RSZ en BV
  // We gebruiken nettoBetalen als het beschikbaar is
  const nettoLoon = payslip?.nettoBetalen || payslip?.nettoTotaal || 0;

  // Maaltijdcheques: enkel stortingen in de geselecteerde maand
  const mcThisMonth = (() => {
    if (!pluxee || !month) return 0;
    const [selM, selY] = month.split("/");
    return pluxee
      .filter((r) => {
        if (!r.desc.toLowerCase().includes("storting")) return false;
        const [dd, mm, yyyy] = r.date.split("-");
        return mm === selM && yyyy === selY;
      })
      .reduce((s, r) => s + r.amount, 0);
  })();

  const totalIncome = nettoLoon + mcThisMonth;

  // Categoriseer banktransacties
  const categorized = (bank || []).map((tx) => ({ ...tx, cat: categorize(tx) }));

  // Uitgaven = negatieve transacties, ZONDER spaarpot en ZONDER loon-transacties
  const EXCLUDED_CATS = ["sparen", "loon", "transfer"];
  const expenses = {};
  categorized
    .filter((t) => t.amount < 0 && !EXCLUDED_CATS.includes(t.cat.key))
    .forEach((t) => {
      expenses[t.cat.key] = (expenses[t.cat.key] || 0) + Math.abs(t.amount);
    });

  const totalExpenses = Object.values(expenses).reduce((a, b) => a + b, 0);

  const savings = categorized
    .filter((t) => t.cat.key === "sparen" && t.amount < 0)
    .reduce((s, t) => s + Math.abs(t.amount), 0);

  // Loon-transacties in bank (worden genegeerd voor budget)
  const loonTransacties = categorized.filter((t) => t.cat.key === "loon" && t.amount > 0);

  const overschot = totalIncome - totalExpenses - savings;

  // Spaarpot allocatie suggestie
  const activePots = pots
    .filter((p) => p.key !== "nood" && p.current < p.target)
    .sort((a, b) => a.priority - b.priority);

  const suggestedAlloc = (() => {
    let remaining = overschot;
    return activePots.map((pot) => {
      const needed = pot.target - pot.current;
      const alloc = Math.min(remaining, needed > 0 ? Math.ceil(remaining * (pot.priority === 1 ? 0.6 : 0.4)) : 0);
      remaining -= alloc;
      return { ...pot, alloc: Math.max(0, alloc) };
    });
  })();

  // ── UI helpers ─────────────────────────────────────────────────────────────
  const UploadCard = ({ label, icon, accept, onChange, loaded, inputRef, warning }) => (
    <div onClick={() => inputRef.current?.click()}
      style={{
        border: `2px dashed ${warning ? T.amber : loaded ? T.mint : T.border}`,
        borderRadius: 14, padding: "20px 16px", cursor: "pointer",
        background: warning ? "#FFFBEB" : loaded ? "#F0FDF9" : T.card,
        display: "flex", flexDirection: "column", alignItems: "center", gap: 8,
        transition: "all .2s", minWidth: 160,
      }}>
      <span style={{ fontSize: 28 }}>{warning ? "⚠️" : loaded ? "✅" : icon}</span>
      <span style={{ fontSize: 13, fontWeight: 600, color: warning ? T.amber : loaded ? T.mint : T.slate }}>{label}</span>
      <span style={{ fontSize: 11, color: T.muted }}>
        {warning ? "Handmatig invullen" : loaded ? "Geladen ✓" : "Klik om te uploaden"}
      </span>
      <input ref={inputRef} type="file" accept={accept} onChange={onChange} style={{ display: "none" }} />
    </div>
  );

  const StatCard = ({ label, value, color, sub, note }) => (
    <div style={{ background: T.card, borderRadius: 16, padding: "20px 22px", boxShadow: "0 2px 12px #0001", flex: 1, minWidth: 140 }}>
      <div style={{ fontSize: 12, color: T.muted, fontWeight: 600, letterSpacing: 1, textTransform: "uppercase", marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 26, fontWeight: 800, color: color || T.ink }}>{fmt(value)}</div>
      {sub && <div style={{ fontSize: 12, color: T.muted, marginTop: 4 }}>{sub}</div>}
      {note && <div style={{ fontSize: 11, color: T.amber, marginTop: 4 }}>⚠️ {note}</div>}
    </div>
  );

  const PotBar = ({ pot }) => {
    const pct = Math.min(100, (pot.current / pot.target) * 100);
    return (
      <div style={{ background: T.card, borderRadius: 14, padding: "16px 20px", boxShadow: "0 2px 8px #0001" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <span style={{ fontWeight: 700, color: T.ink, fontSize: 15 }}>{pot.label}</span>
          <span style={{ fontSize: 13, color: pot.color, fontWeight: 700 }}>{fmt(pot.current)} / {fmt(pot.target)}</span>
        </div>
        <div style={{ background: T.surface, borderRadius: 99, height: 10, overflow: "hidden" }}>
          <div style={{ width: `${pct}%`, background: pot.color, height: "100%", borderRadius: 99, transition: "width .5s" }} />
        </div>
        <div style={{ fontSize: 12, color: T.muted, marginTop: 6 }}>{pct.toFixed(0)}% bereikt</div>
      </div>
    );
  };

  const topCats = Object.entries(expenses)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([key, amt]) => ({ ...CATS.find((c) => c.key === key) || { key, label: key, color: T.muted, icon: "📦" }, amt }));

  const maxCat = topCats[0]?.amt || 1;

  // ── render ─────────────────────────────────────────────────────────────────
  return (
    <div style={{ fontFamily: "'Inter', system-ui, sans-serif", background: T.surface, minHeight: "100vh", color: T.ink }}>
      {/* Header */}
      <div style={{ background: T.slate, padding: "0 24px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ padding: "18px 0", display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ width: 36, height: 36, borderRadius: 10, background: T.accent, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18 }}>💶</div>
          <div>
            <div style={{ fontWeight: 800, fontSize: 17, color: "#fff" }}>BudgetDashboard</div>
            <div style={{ fontSize: 11, color: "rgba(255,255,255,.5)", letterSpacing: .5 }}>
              Jary Winters {month ? `• ${month}` : ""}
              {payslip?.periode ? ` • ${payslip.periode}` : ""}
            </div>
          </div>
        </div>
        <div style={{ display: "flex", gap: 4 }}>
          {["dashboard", "transacties", "spaarpotten"].map((t) => (
            <button key={t} onClick={() => setTab(t)}
              style={{
                background: tab === t ? T.accent : "transparent",
                color: tab === t ? "#fff" : "rgba(255,255,255,.6)",
                border: "none", borderRadius: 8, padding: "8px 16px",
                fontSize: 13, fontWeight: 600, cursor: "pointer", textTransform: "capitalize",
              }}>{t}</button>
          ))}
        </div>
      </div>

      <div style={{ maxWidth: 960, margin: "0 auto", padding: "24px 16px" }}>

        {/* Upload section */}
        <div style={{ background: T.card, borderRadius: 18, padding: "20px 24px", marginBottom: 24, boxShadow: "0 2px 12px #0001" }}>
          <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 16, color: T.slate }}>📂 Documenten laden</div>
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
            <UploadCard label="Loonstrook (PDF)" icon="📄" accept=".pdf,.txt" onChange={handlePDF}
              loaded={!!payslip} warning={pdfParseFail && !payslip} inputRef={pdfRef} />
            <UploadCard label="Bankuitreksel (CSV)" icon="🏦" accept=".csv" onChange={handleBank}
              loaded={!!bank} inputRef={bankRef} />
            <UploadCard label="Pluxee export (CSV)" icon="🥗" accept=".csv" onChange={handlePluxee}
              loaded={!!pluxee} inputRef={pluxeeRef} />
          </div>

          {/* Manual payslip input — altijd tonen als er nog geen payslip is of als parse mislukt */}
          {(!payslip || pdfParseFail) && (
            <div style={{ marginTop: 12 }}>
              <button onClick={() => setShowManual((s) => !s)}
                style={{ background: "none", border: `1px solid ${T.border}`, borderRadius: 8, padding: "6px 14px", fontSize: 12, cursor: "pointer", color: T.slate }}>
                {showManual ? "▲ Verberg handmatige invoer" : "▼ Loonstrook handmatig invullen"}
              </button>
              {showManual && <PayslipManualInput onSave={(data) => { setPayslip(data); setShowManual(false); setPdfParseFail(false); }} />}
            </div>
          )}

          {payslip && (
            <div style={{ marginTop: 12, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <span style={{ fontSize: 12, color: T.mint, fontWeight: 600 }}>✅ Loonstrook geladen</span>
              {payslip.nettoBetalen && <span style={{ fontSize: 12, color: T.muted }}>Netto te betalen: {fmt(payslip.nettoBetalen)}</span>}
              {payslip.bruto && <span style={{ fontSize: 12, color: T.muted }}>Bruto: {fmt(payslip.bruto)}</span>}
              <button onClick={() => setShowManual((s) => !s)}
                style={{ background: "none", border: `1px solid ${T.border}`, borderRadius: 6, padding: "3px 10px", fontSize: 11, cursor: "pointer", color: T.muted }}>
                Aanpassen
              </button>
              {showManual && <PayslipManualInput onSave={(data) => { setPayslip(data); setShowManual(false); }} />}
            </div>
          )}

          {loonTransacties.length > 0 && (
            <div style={{ marginTop: 12, padding: "10px 14px", background: "#FFFBEB", borderRadius: 10, fontSize: 12, color: "#92400E" }}>
              ⚠️ <strong>{loonTransacties.length} loon-storting(en) gevonden in je bankuitreksel</strong> en worden <u>genegeerd</u> voor je budget — dit is je loon voor de volgende maand:
              {loonTransacties.map((t, i) => (
                <span key={i} style={{ marginLeft: 8, fontWeight: 600 }}>{t.date}: {fmt(t.amount)}</span>
              ))}
            </div>
          )}

          {!payslip && !bank && !pluxee && (
            <div style={{ marginTop: 16, padding: "12px 16px", background: T.surface, borderRadius: 10, fontSize: 13, color: T.muted }}>
              💡 <strong>Tip:</strong> Laad je bankuitreksel van ING (CSV) en Pluxee export (CSV). Je netto loon kan je handmatig invullen via "Loonstrook handmatig invullen".
            </div>
          )}
        </div>

        {/* ── DASHBOARD TAB ── */}
        {tab === "dashboard" && (
          <>
            <div style={{ display: "flex", gap: 16, marginBottom: 24, flexWrap: "wrap" }}>
              <StatCard label="Netto loon" value={nettoLoon} color={T.mint}
                sub={payslip ? "Van loonstrook (netto te betalen)" : "Nog niet ingevuld"}
                note={!payslip ? "Vul je loonstrook in" : undefined} />
              <StatCard label="Maaltijdcheques" value={mcThisMonth} color={T.accent}
                sub={`Pluxee storting ${month || ""}`} />
              <StatCard label="Totaal inkomen" value={totalIncome} color={T.mint}
                sub="Loon + maaltijdcheques" />
              <StatCard label="Uitgaven" value={totalExpenses} color={T.rose}
                sub="Bankuitreksel (excl. sparen & loon)" />
              <StatCard label="Overschot" value={overschot}
                color={overschot >= 0 ? T.mint : T.rose}
                sub="Beschikbaar voor sparen" />
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20, marginBottom: 24 }}>
              {/* Spending */}
              <div style={{ background: T.card, borderRadius: 16, padding: "20px 22px", boxShadow: "0 2px 12px #0001" }}>
                <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 16, color: T.slate }}>💸 Uitgaven per categorie</div>
                {topCats.length === 0 && <div style={{ color: T.muted, fontSize: 13 }}>Laad je bankuitreksel om uitgaven te zien.</div>}
                {topCats.map((cat) => (
                  <div key={cat.key} style={{ marginBottom: 12 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 4 }}>
                      <span>{cat.icon} {cat.label}</span>
                      <span style={{ fontWeight: 700, color: cat.color }}>{fmt(cat.amt)}</span>
                    </div>
                    <div style={{ background: T.surface, borderRadius: 99, height: 7 }}>
                      <div style={{ width: `${(cat.amt / maxCat) * 100}%`, background: cat.color, height: "100%", borderRadius: 99 }} />
                    </div>
                  </div>
                ))}
              </div>

              {/* Pot allocation */}
              <div style={{ background: T.card, borderRadius: 16, padding: "20px 22px", boxShadow: "0 2px 12px #0001" }}>
                <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 4, color: T.slate }}>💡 Spaarpot advies</div>
                <div style={{ fontSize: 12, color: T.muted, marginBottom: 16 }}>Op basis van overschot van {fmt(overschot)}</div>
                {overschot <= 0 && <div style={{ color: T.rose, fontSize: 13 }}>⚠️ Geen overschot beschikbaar deze maand.</div>}
                {suggestedAlloc.map((pot) => (
                  <div key={pot.key} style={{ marginBottom: 14, padding: "12px 14px", background: T.surface, borderRadius: 12 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <span style={{ fontWeight: 700, fontSize: 14, color: pot.color }}>{pot.label}</span>
                      <span style={{ fontWeight: 800, fontSize: 16, color: pot.color }}>+{fmt(pot.alloc)}</span>
                    </div>
                    <div style={{ fontSize: 12, color: T.muted, marginTop: 3 }}>
                      {fmt(pot.current)} → {fmt(pot.current + pot.alloc)} / {fmt(pot.target)}
                    </div>
                    <div style={{ background: T.border, borderRadius: 99, height: 6, marginTop: 8 }}>
                      <div style={{ width: `${Math.min(100, ((pot.current + pot.alloc) / pot.target) * 100)}%`, background: pot.color, height: "100%", borderRadius: 99, transition: "width .5s" }} />
                    </div>
                  </div>
                ))}
                {activePots.length === 0 && <div style={{ color: T.mint, fontSize: 13 }}>🎉 Alle spaarpotten zijn vol!</div>}
              </div>
            </div>

            {/* Monthly summary */}
            <div style={{ background: T.card, borderRadius: 16, padding: "20px 22px", boxShadow: "0 2px 12px #0001" }}>
              <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 16, color: T.slate }}>📊 Maandoverzicht vs budget</div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 12 }}>
                {[
                  { label: "Hypotheek",        exp: expenses["hypotheek"] || 0,    budget: FIXED_EXPENSES.hypotheek },
                  { label: "Energie",           exp: expenses["energie"] || 0,      budget: FIXED_EXPENSES.energie },
                  { label: "Internet",          exp: expenses["internet"] || 0,     budget: FIXED_EXPENSES.internet },
                  { label: "Boodschappen",      exp: expenses["boodschappen"] || 0, budget: 275 },
                  { label: "Uit eten/ontspanning", exp: expenses["uiteten"] || 0,   budget: 275 },
                  { label: "Apotheek/Medisch",  exp: expenses["apotheek"] || 0,     budget: 70 },
                  { label: "Reizen",            exp: expenses["reizen"] || 0,       budget: 0 },
                ].filter(({ budget, exp }) => budget > 0 || exp > 0).map(({ label, exp, budget }) => {
                  const over = budget > 0 && exp > budget;
                  return (
                    <div key={label} style={{ padding: "12px 14px", background: T.surface, borderRadius: 12 }}>
                      <div style={{ fontSize: 12, color: T.muted, marginBottom: 4 }}>{label}</div>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                        <span style={{ fontWeight: 700, color: over ? T.rose : T.ink }}>{fmt(exp)}</span>
                        {budget > 0 && <span style={{ fontSize: 11, color: T.muted }}>/ {fmt(budget)}</span>}
                      </div>
                      {over && <div style={{ fontSize: 11, color: T.rose, marginTop: 2 }}>+{fmt(exp - budget)} over budget</div>}
                      {!over && exp > 0 && budget > 0 && <div style={{ fontSize: 11, color: T.mint, marginTop: 2 }}>{fmt(budget - exp)} onder budget ✓</div>}
                    </div>
                  );
                })}
              </div>
            </div>
          </>
        )}

        {/* ── TRANSACTIES TAB ── */}
        {tab === "transacties" && (
          <div style={{ background: T.card, borderRadius: 16, padding: "20px 22px", boxShadow: "0 2px 12px #0001" }}>
            <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 16, color: T.slate }}>
              🏦 Transacties {month ? `(${month})` : ""} — {categorized.length} rijen
            </div>
            {categorized.length === 0 && <div style={{ color: T.muted, fontSize: 13 }}>Laad je bankuitreksel om transacties te zien.</div>}
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead>
                  <tr style={{ borderBottom: `2px solid ${T.border}` }}>
                    {["Datum", "Omschrijving", "Categorie", "Bedrag"].map((h) => (
                      <th key={h} style={{ padding: "8px 12px", textAlign: h === "Bedrag" ? "right" : "left", color: T.muted, fontWeight: 600 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {categorized.map((tx, i) => (
                    <tr key={i} style={{
                      borderBottom: `1px solid ${T.border}`,
                      background: tx.cat.key === "loon" ? "#FFFBEB" : i % 2 === 0 ? T.surface : T.card,
                      opacity: tx.cat.key === "loon" ? 0.7 : 1,
                    }}>
                      <td style={{ padding: "8px 12px", color: T.muted, whiteSpace: "nowrap" }}>{tx.date}</td>
                      <td style={{ padding: "8px 12px", maxWidth: 280, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {tx.desc.slice(0, 70)}{tx.desc.length > 70 ? "…" : ""}
                      </td>
                      <td style={{ padding: "8px 12px" }}>
                        <span style={{ background: tx.cat.color + "22", color: tx.cat.color, borderRadius: 99, padding: "2px 10px", fontWeight: 600, fontSize: 12 }}>
                          {tx.cat.icon} {tx.cat.label}
                        </span>
                        {tx.cat.key === "loon" && <span style={{ fontSize: 10, color: T.amber, marginLeft: 6 }}>genegeerd</span>}
                      </td>
                      <td style={{ padding: "8px 12px", textAlign: "right", fontWeight: 700, color: tx.amount >= 0 ? T.mint : T.rose }}>
                        {tx.amount >= 0 ? "+" : ""}{fmt(tx.amount)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ── SPAARPOTTEN TAB ── */}
        {tab === "spaarpotten" && (
          <>
            <div style={{ display: "flex", flexDirection: "column", gap: 16, marginBottom: 24 }}>
              {pots.map((pot) => <PotBar key={pot.key} pot={pot} />)}
            </div>
            <div style={{ background: T.card, borderRadius: 16, padding: "20px 22px", boxShadow: "0 2px 12px #0001" }}>
              <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 16, color: T.slate }}>✏️ Spaarpotten bijwerken</div>
              {pots.map((pot, i) => (
                <div key={pot.key} style={{ display: "flex", gap: 16, alignItems: "center", marginBottom: 14, flexWrap: "wrap" }}>
                  <span style={{ fontWeight: 700, color: pot.color, minWidth: 150, fontSize: 14 }}>{pot.label}</span>
                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <label style={{ fontSize: 12, color: T.muted }}>Huidig</label>
                    <input type="number" value={pot.current}
                      onChange={(e) => setPots((p) => p.map((x, j) => j === i ? { ...x, current: +e.target.value } : x))}
                      style={{ width: 110, padding: "6px 10px", borderRadius: 8, border: `1px solid ${T.border}`, fontSize: 13, fontFamily: "inherit" }} />
                  </div>
                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <label style={{ fontSize: 12, color: T.muted }}>Doel</label>
                    <input type="number" value={pot.target}
                      onChange={(e) => setPots((p) => p.map((x, j) => j === i ? { ...x, target: +e.target.value } : x))}
                      style={{ width: 110, padding: "6px 10px", borderRadius: 8, border: `1px solid ${T.border}`, fontSize: 13, fontFamily: "inherit" }} />
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
