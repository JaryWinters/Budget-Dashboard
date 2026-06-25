import { useState, useCallback, useRef } from "react";
import * as XLSX from "xlsx";

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
  const s = String(str).replace(/[€\s]/g, "").replace(",", ".");
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

function parseBankCSV(text) {
  const lines = text.trim().split("\n").slice(1);
  return lines.map((l) => {
    const cols = l.split(";");
    return {
      date:   cols[4]?.trim(),
      amount: parseAmount(cols[6]),
      desc:   (cols[8] || "").trim(),
      detail: (cols[9] || "").trim(),
      msg:    (cols[10] || "").trim(),
    };
  }).filter((r) => r.date);
}

function parsePluxeeCSV(text) {
  const lines = text.trim().split("\n").slice(1);
  return lines.map((l) => {
    const cols = l.split(";");
    const raw = cols[2]?.replace(/"/g, "").trim() || "";
    const amount = parseAmount(raw.replace("+", "").replace("€", "").trim());
    return {
      date: cols[0]?.trim(),
      desc: (cols[1] || "").replace(/"/g, "").trim(),
      amount,
    };
  }).filter((r) => r.date);
}

function parsePDF(text) {
  const find = (patterns) => {
    for (const p of patterns) {
      const m = text.match(p);
      if (m) return parseFloat(m[1].replace(",", ".").replace(".", "").replace(",", ".")) || 0;
    }
    return null;
  };
  const findRaw = (patterns) => {
    for (const p of patterns) {
      const m = text.match(p);
      if (m) return m[1].trim();
    }
    return null;
  };

  return {
    brutoloon:    find([/Bruto\s+([\d.,]+)/i, /9011B00\s+Bruto\s+([\d.,]+)/i]),
    rsz:          find([/Afhouding R\.S\.Z\. bruto\s+-?([\d.,]+)/i]),
    bv:           find([/Bedrijfsvoorheffing\s+-?([\d.,]+)/i, /9411B00\s+Bedrijfsvoorheffing\s+-?([\d.,]+)/i]),
    netto:        find([/Netto totaal\s+([\d.,]+)/i, /9801B00\s+Netto totaal\s+([\d.,]+)/i]),
    nettoBetalen: find([/Netto te betalen.*?([\d.,]+)\s*$/im]),
    periode:      findRaw([/LOONSTROOK\s+(\w+\s+\d{4})/i, /Periode van (\d{2}\.\d{2}\.\d{4})/]),
    maandloon:    find([/Maandloon\s*:\s*([\d.,]+)/i]),
  };
}

// ─── Category detection ───────────────────────────────────────────────────────
const CATS = [
  { key: "hypotheek",    label: "Hypotheek",        color: T.rose,   icon: "🏠", keywords: ["woningfonds","hypothe"] },
  { key: "energie",      label: "Energie",           color: T.amber,  icon: "⚡", keywords: ["electrabel","engie","luminus","fluvius","eandis"] },
  { key: "internet",     label: "Internet/Telco",    color: T.accent, icon: "📡", keywords: ["telenet","proximus","scarlet","voo","orange"] },
  { key: "boodschappen", label: "Boodschappen",      color: T.mint,   icon: "🛒", keywords: ["aldi","delhaize","colruyt","lidl","carrefour","albert","jumbo","okay"] },
  { key: "uiteten",      label: "Uit eten",          color: "#FF9F1C",icon: "🍽️", keywords: ["quick","mcdonald","burger","friet","resto","cafetaria","pizza","sushi","kebab","fast"] },
  { key: "verzekering",  label: "Verzekeringen",     color: "#7209B7",icon: "🛡️", keywords: ["vivium","ag insur","axa","ethias","ageas","allianz"] },
  { key: "bankkosten",   label: "Bankkosten",        color: T.muted,  icon: "🏦", keywords: ["kostenafrekening","ing go","maandelijkse bijdrage ing"] },
  { key: "paypal",       label: "Online/PayPal",     color: "#0096C7",icon: "🛍️", keywords: ["paypal","temu","amazon","bol.com"] },
  { key: "apotheek",     label: "Medisch",           color: "#E63946",icon: "💊", keywords: ["apotheek","farma","dokter","az waas","vision direct"] },
  { key: "sparen",       label: "Spaaroverschrijving",color: T.mint,  icon: "💰", keywords: ["BE70363641672925","spaarpot","spaarrekening"] },
  { key: "loon",         label: "Loon ontvangen",    color: T.mint,   icon: "💼", keywords: ["mediahuis","attentia"] },
  { key: "transfer",     label: "Doorstorting/Terugbetaling", color: T.slate, icon: "↔️", keywords: ["winters-huybrechts","sam de ley","debby"] },
];

function categorize(tx) {
  const haystack = (tx.desc + " " + tx.detail + " " + tx.msg).toLowerCase();
  for (const cat of CATS) {
    if (cat.keywords.some((k) => haystack.includes(k))) return cat;
  }
  return { key: "overig", label: "Overig", color: T.muted, icon: "📦" };
}

// ─── Spaarpot config ─────────────────────────────────────────────────────────
const DEFAULT_POTS = [
  { key: "trouw",    label: "Trouwpot 💍",      color: T.rose,   target: 15000, current: 2800,  priority: 1 },
  { key: "renovatie",label: "Renovatiepot 🔨",  color: T.amber,  target: 5000,  current: 2000,  priority: 2 },
  { key: "nood",     label: "Noodpot 🛡️",       color: T.accent, target: 15000, current: 15000, priority: 0 },
];

const FIXED_EXPENSES = {
  hypotheek:   899.58,
  verzekering: 47.48,
  internet:    51.55,
  water:       33.33,
  energie:     150,
};

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function App() {
  const [payslip,  setPayslip]  = useState(null);
  const [bank,     setBank]     = useState(null);
  const [pluxee,   setPluxee]   = useState(null);
  const [pots,     setPots]     = useState(DEFAULT_POTS);
  const [tab,      setTab]      = useState("dashboard");
  const [loading,  setLoading]  = useState({});
  const [month,    setMonth]    = useState(null);

  const bankRef   = useRef();
  const pluxeeRef = useRef();
  const pdfRef    = useRef();

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
        const text = ev.target.result;
        const parsed = parsePDF(text);
        setPayslip(parsed);
      } catch { setPayslip({}); }
      setLoading((l) => ({ ...l, pdf: false }));
    };
    r.readAsText(file, "latin1");
  }, []);

  const netto = payslip?.nettoBetalen || payslip?.netto || 0;

  const mcThisMonth = (() => {
    if (!pluxee || !month) return 0;
    const [m, y] = (month || "").split("/");
    const stortingen = pluxee.filter((r) => {
      if (!r.desc.toLowerCase().includes("storting")) return false;
      const [, rm, ry] = (r.date || "").split("-");
      return rm === m && ry === y;
    });
    return stortingen.reduce((s, r) => s + r.amount, 0);
  })();

  const totalIncome = netto + mcThisMonth;

  const categorized = bank?.map((tx) => ({ ...tx, cat: categorize(tx) })) || [];

  const expenses = {};
  categorized.filter((t) => t.amount < 0 && t.cat.key !== "sparen").forEach((t) => {
    expenses[t.cat.key] = (expenses[t.cat.key] || 0) + Math.abs(t.amount);
  });

  const totalExpenses = Object.values(expenses).reduce((a, b) => a + b, 0);
  const savings = categorized.filter((t) => t.cat.key === "sparen" && t.amount < 0)
                              .reduce((s, t) => s + Math.abs(t.amount), 0);

  const overschot = totalIncome - totalExpenses - savings;

  const activePots = pots.filter((p) => p.key !== "nood" && p.current < p.target)
                         .sort((a, b) => a.priority - b.priority);
  const suggestedAlloc = (() => {
    let remaining = overschot;
    return activePots.map((pot) => {
      const needed = pot.target - pot.current;
      const alloc  = Math.min(remaining, needed > 0 ? Math.ceil(remaining * (pot.priority === 1 ? 0.6 : 0.4)) : 0);
      remaining -= alloc;
      return { ...pot, alloc: Math.max(0, alloc) };
    });
  })();

  const UploadCard = ({ label, icon, accept, onChange, loaded, inputRef }) => (
    <div onClick={() => inputRef.current?.click()}
      style={{
        border: `2px dashed ${loaded ? T.mint : T.border}`,
        borderRadius: 14, padding: "20px 16px", cursor: "pointer",
        background: loaded ? "#F0FDF9" : T.card,
        display: "flex", flexDirection: "column", alignItems: "center", gap: 8,
        transition: "all .2s", minWidth: 160,
      }}>
      <span style={{ fontSize: 28 }}>{loaded ? "✅" : icon}</span>
      <span style={{ fontSize: 13, fontWeight: 600, color: loaded ? T.mint : T.slate }}>{label}</span>
      <span style={{ fontSize: 11, color: T.muted }}>{loaded ? "Geladen ✓" : "Klik om te uploaden"}</span>
      <input ref={inputRef} type="file" accept={accept} onChange={onChange} style={{ display: "none" }} />
    </div>
  );

  const StatCard = ({ label, value, color, sub }) => (
    <div style={{ background: T.card, borderRadius: 16, padding: "20px 22px", boxShadow: "0 2px 12px #0001", flex: 1, minWidth: 140 }}>
      <div style={{ fontSize: 12, color: T.muted, fontWeight: 600, letterSpacing: 1, textTransform: "uppercase", marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 26, fontWeight: 800, color: color || T.ink }}>{fmt(value)}</div>
      {sub && <div style={{ fontSize: 12, color: T.muted, marginTop: 4 }}>{sub}</div>}
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
    .slice(0, 6)
    .map(([key, amt]) => ({ ...CATS.find((c) => c.key === key) || { key, label: key, color: T.muted, icon: "📦" }, amt }));

  const maxCat = topCats[0]?.amt || 1;

  return (
    <div style={{ fontFamily: "'Inter', system-ui, sans-serif", background: T.surface, minHeight: "100vh", color: T.ink }}>
      <div style={{ background: T.slate, padding: "0 24px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ padding: "18px 0", display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ width: 36, height: 36, borderRadius: 10, background: T.accent, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18 }}>💶</div>
          <div>
            <div style={{ fontWeight: 800, fontSize: 17, color: "#fff" }}>BudgetDashboard</div>
            <div style={{ fontSize: 11, color: "rgba(255,255,255,.5)", letterSpacing: .5 }}>Jary Winters {month ? `• ${month}` : ""}</div>
          </div>
        </div>
        <div style={{ display: "flex", gap: 4 }}>
          {["dashboard","transacties","spaarpotten"].map((t) => (
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
        <div style={{ background: T.card, borderRadius: 18, padding: "20px 24px", marginBottom: 24, boxShadow: "0 2px 12px #0001" }}>
          <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 16, color: T.slate }}>📂 Documenten laden</div>
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
            <UploadCard label="Loonstrook (PDF)" icon="📄" accept=".pdf,.txt" onChange={handlePDF} loaded={!!payslip} inputRef={pdfRef} />
            <UploadCard label="Bankuitreksel (CSV)" icon="🏦" accept=".csv" onChange={handleBank} loaded={!!bank} inputRef={bankRef} />
            <UploadCard label="Pluxee export (CSV)" icon="🥗" accept=".csv" onChange={handlePluxee} loaded={!!pluxee} inputRef={pluxeeRef} />
          </div>
          {!payslip && !bank && !pluxee && (
            <div style={{ marginTop: 16, padding: "12px 16px", background: T.surface, borderRadius: 10, fontSize: 13, color: T.muted }}>
              💡 <strong>Tip:</strong> Laad je loonstrook (PDF), bankuitreksel van ING (CSV) en Pluxee export (CSV) om een volledig overzicht te krijgen.
            </div>
          )}
        </div>

        {tab === "dashboard" && (
          <>
            <div style={{ display: "flex", gap: 16, marginBottom: 24, flexWrap: "wrap" }}>
              <StatCard label="Netto loon" value={netto} color={T.mint} sub="Van loonstrook" />
              <StatCard label="Maaltijdcheques" value={mcThisMonth} color={T.accent} sub="Pluxee storting" />
              <StatCard label="Totaal inkomen" value={totalIncome} color={T.mint} sub="Loon + cheques" />
              <StatCard label="Uitgaven" value={totalExpenses} color={T.rose} sub="Bankuitreksel" />
              <StatCard label="Overschot" value={overschot} color={overschot >= 0 ? T.mint : T.rose} sub="Beschikbaar voor sparen" />
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20, marginBottom: 24 }}>
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

              <div style={{ background: T.card, borderRadius: 16, padding: "20px 22px", boxShadow: "0 2px 12px #0001" }}>
                <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 4, color: T.slate }}>💡 Spaarpot advies</div>
                <div style={{ fontSize: 12, color: T.muted, marginBottom: 16 }}>Op basis van huidig overschot van {fmt(overschot)}</div>
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

            <div style={{ background: T.card, borderRadius: 16, padding: "20px 22px", boxShadow: "0 2px 12px #0001" }}>
              <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 16, color: T.slate }}>📊 Maandoverzicht</div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 12 }}>
                {[
                  { label: "Hypotheek", exp: expenses["hypotheek"] || 0, budget: FIXED_EXPENSES.hypotheek },
                  { label: "Energie", exp: expenses["energie"] || 0, budget: FIXED_EXPENSES.energie },
                  { label: "Internet", exp: expenses["internet"] || 0, budget: FIXED_EXPENSES.internet },
                  { label: "Boodschappen", exp: expenses["boodschappen"] || 0, budget: 275 },
                  { label: "Uit eten", exp: expenses["uiteten"] || 0, budget: 275 },
                  { label: "Apotheek/Medisch", exp: expenses["apotheek"] || 0, budget: 70 },
                ].map(({ label, exp, budget }) => {
                  const over = exp > budget;
                  return (
                    <div key={label} style={{ padding: "12px 14px", background: T.surface, borderRadius: 12 }}>
                      <div style={{ fontSize: 12, color: T.muted, marginBottom: 4 }}>{label}</div>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                        <span style={{ fontWeight: 700, color: over ? T.rose : T.ink }}>{fmt(exp)}</span>
                        <span style={{ fontSize: 11, color: T.muted }}>/ {fmt(budget)}</span>
                      </div>
                      {over && <div style={{ fontSize: 11, color: T.rose, marginTop: 2 }}>+{fmt(exp - budget)} over budget</div>}
                      {!over && exp > 0 && <div style={{ fontSize: 11, color: T.mint, marginTop: 2 }}>{fmt(budget - exp)} onder budget ✓</div>}
                    </div>
                  );
                })}
              </div>
            </div>
          </>
        )}

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
                    {["Datum","Omschrijving","Categorie","Bedrag"].map((h) => (
                      <th key={h} style={{ padding: "8px 12px", textAlign: h === "Bedrag" ? "right" : "left", color: T.muted, fontWeight: 600 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {categorized.map((tx, i) => (
                    <tr key={i} style={{ borderBottom: `1px solid ${T.border}`, background: i % 2 === 0 ? T.surface : T.card }}>
                      <td style={{ padding: "8px 12px", color: T.muted, whiteSpace: "nowrap" }}>{tx.date}</td>
                      <td style={{ padding: "8px 12px", maxWidth: 280, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {tx.desc.slice(0, 70)}{tx.desc.length > 70 ? "…" : ""}
                      </td>
                      <td style={{ padding: "8px 12px" }}>
                        <span style={{ background: tx.cat.color + "22", color: tx.cat.color, borderRadius: 99, padding: "2px 10px", fontWeight: 600, fontSize: 12 }}>
                          {tx.cat.icon} {tx.cat.label}
                        </span>
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
