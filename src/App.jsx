import { useState, useEffect, useRef, useCallback, createContext, useContext } from "react";

const useLocalStorage = (key, initialValue) => {
  const [value, setValue] = useState(() => {
    try {
      const item = window.localStorage.getItem(key);
      return item ? JSON.parse(item) : initialValue;
    } catch { return initialValue; }
  });
  useEffect(() => {
    try { window.localStorage.setItem(key, JSON.stringify(value)); } catch {}
  }, [key, value]);
  return [value, setValue];
};

/* ─────────────────────────────────────────────────────────────
   Gemini API helpers
───────────────────────────────────────────────────────────── */
const claudeStream = async (system, userMsg, history, onChunk) => {
  const apiKey = window.localStorage.getItem("medmentor_gemini_key")?.replace(/"/g, '') || "";
  const useBackend = window.localStorage.getItem("medmentor_use_backend") === "true";
  const backendUrl = window.localStorage.getItem("medmentor_backend_url")?.replace(/"/g, '') || "http://127.0.0.1:5000";

  const thread = history || [{ role: "user", content: userMsg }];
  if (useBackend && backendUrl) {
    onChunk("⌛ Contacting backend...");
    const res = await fetch(`${backendUrl}/api/chat`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ system, messages: thread })
    });
    if (!res.ok) {
       const errData = await res.json().catch(()=>({}));
       throw new Error(errData.error || "Backend connection failed.");
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let full = "";
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += dec.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop(); // keep last incomplete line in buffer
      for (const line of lines) {
        if (line.trim().startsWith("data: ")) {
          let pendingError = null;
          try {
            const d = JSON.parse(line.replace(/^data:\s*/, ""));
            if (d.text) { full += d.text; onChunk(full); }
            if (d.error) pendingError = d.error;
          } catch(e) { /* ignore JSON parse error on incomplete final chunks if any */ }
          if (pendingError) throw new Error(pendingError);
        }
      }
    }
    return full;
  }

  if (!apiKey) { onChunk("⚠️ No Gemini API Key set in Settings."); return ""; }

  const contents = [];
  if (system) {
    contents.push({ role: "user", parts: [{ text: `System context: ${system}` }] });
    contents.push({ role: "model", parts: [{ text: "Understood." }] });
  }
  for (const m of thread) {
    contents.push({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content || " " }] });
  }

  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse&key=${apiKey}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents })
  });
  if (!res.ok) throw new Error((await res.json()).error?.message || "Gemini API Error");

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let full = "";
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += dec.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop(); 
    for (const line of lines) {
      if (line.trim().startsWith("data: ")) {
        let pendingError = null;
        try {
          const d = JSON.parse(line.replace(/^data:\s*/, ""));
          const text = d.candidates?.[0]?.content?.parts?.[0]?.text;
          if (text) { full += text; onChunk(full); }
          if (d.error) pendingError = d.error.message || d.error;
        } catch(e) { /* ignore JSON parse error */ }
        if (pendingError) throw new Error(pendingError);
      }
    }
  }
  return full;
};

const claudeOnce = async (system, userMsg) => {
  const apiKey = window.localStorage.getItem("medmentor_gemini_key")?.replace(/"/g, '') || "";
  const useBackend = window.localStorage.getItem("medmentor_use_backend") === "true";
  const backendUrl = window.localStorage.getItem("medmentor_backend_url")?.replace(/"/g, '') || "http://127.0.0.1:5000";

  let finalSystem = system;
  if (!userMsg && typeof system === "string") {
     userMsg = system;
     finalSystem = "";
  }

  if (useBackend && backendUrl) {
    const res = await fetch(`${backendUrl}/api/generate-mcq`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subject: finalSystem, num_q: typeof userMsg === "number" ? userMsg : (parseInt(userMsg.match(/\d+/)?.[0]) || 10), file_text: "" })
    });
    if (!res.ok) {
       const errData = await res.json().catch(()=>({}));
       throw new Error(errData.error || "Backend connection failed.");
    }
    const data = await res.json();
    if (data.questions) return JSON.stringify(data.questions);
    if (data.text) return data.text;
    return JSON.stringify(data);
  }

  if (!apiKey) throw new Error("No Gemini API Key set in Settings.");

  const contents = [];
  if (finalSystem) {
    contents.push({ role: "user", parts: [{ text: `System context: ${finalSystem}` }] });
    contents.push({ role: "model", parts: [{ text: "Understood." }] });
  }
  contents.push({ role: "user", parts: [{ text: String(userMsg) }] });

  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents, generationConfig: { responseMimeType: "application/json" } })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || "Gemini API Error");
  return data.candidates[0].content.parts[0].text;
};

/* ─────────────────────────────────────────────────────────────
   Constants & Subject Data
───────────────────────────────────────────────────────────── */
const SUBJECT_DATA = {
  "Medicine": { icon: "🩺", sub: ["Cardiology", "Neurology", "Gastroenterology", "Pulmonology", "Endocrinology", "Nephrology"] },
  "Surgery": { icon: "🔪", sub: ["General Surgery", "Oncology", "Trauma", "Urology", "Plastic Surgery"] },
  "OBG": { icon: "👶", sub: ["Obstetrics", "Gynecology", "Reproductive Endocrinology"] },
  "Pediatrics": { icon: "🧸", sub: ["Neonatology", "Genetics", "Developmental", "Nutrition"] },
  "Pathology": { icon: "🔬", sub: ["General Pathology", "Hematology", "Systemic Pathology"] },
  "Pharmacology": { icon: "💊", sub: ["General Pharm", "ANS", "CNS", "Cardiovascular", "Antimicrobials"] },
  "Microbiology": { icon: "🦠", sub: ["Bacteriology", "Virology", "Parasitology", "Mycology", "Immunology"] },
  "Anatomy": { icon: "🦴", sub: ["Gross Anatomy", "Embryology", "Histology", "Neuroanatomy"] },
  "Physiology": { icon: "⚡", sub: ["Nerve/Muscle", "CVS", "Respiratory", "CNS", "Endocrine"] },
  "Biochemistry": { icon: "🧬", sub: ["Metabolism", "Genetics", "Molecular Bio", "Vitamins"] },
  "ENT": { icon: "👂", sub: ["Ear", "Nose", "Throat", "Head & Neck"] },
  "Ophthalmology": { icon: "👁️", sub: ["Anterior Segment", "Retina", "Neuro-Ophthalmology", "Glaucoma"] },
  "Psychiatry": { icon: "🧠", sub: ["Schizophrenia", "Mood Disorders", "Addiction", "Child Psych"] },
  "Dermatology": { icon: "🧴", sub: ["Infections", "Autoimmune", "Papulosquamous"] },
  "Radiology": { icon: "☢️", sub: ["X-Ray", "CT/MRI basics", "Systemic Radiology", "Nuclear Med"] },
  "Orthopedics": { icon: "🦾", sub: ["Trauma", "Bone Infections", "Joint Replacements", "Pediatric Ortho"] },
  "Anesthesia": { icon: "💉", sub: ["Local/Regional", "General", "ICU/Resuscitation", "Pain Management"] },
  "Forensic Medicine": { icon: "⚖️", sub: ["Jurisprudence", "Toxicology", "Autopsy", "Injury"] },
  "Community Medicine": { icon: "🌍", sub: ["Epidemiology", "Biostatistics", "Vaccines", "Health Programs"] }
};
const SUBJECTS = Object.keys(SUBJECT_DATA);
const getDaysLeft = () => Math.max(0, Math.ceil((new Date("2026-08-30") - new Date()) / 86400000));

/* ─────────────────────────────────────────────────────────────
   Styles Context — provides theme-aware styles to all components
───────────────────────────────────────────────────────────── */
const StylesContext = createContext(null);

const getStyles = (theme) => {
  const isDark = theme === "dark";
  const G = {
    isDark,
    pageBg:        isDark ? "#0B0F19"  : "#F4F7FE",
    surface:       isDark ? "#111827"  : "#FFFFFF",
    surfaceHover:  isDark ? "#1F2937"  : "#F8F9FA",
    glassBorder:   isDark ? "rgba(255,255,255,0.1)" : "rgba(0,0,0,0.08)",
    glassShadow:   isDark ? "0 4px 24px rgba(0,0,0,0.4)" : "0 4px 24px rgba(112,144,176,0.15)",
    primary:       "#4318FF",
    primarySoft:   isDark ? "rgba(67,24,255,0.25)" : "rgba(67,24,255,0.1)",
    violet:        "#7551FF",
    violetSoft:    isDark ? "rgba(117,81,255,0.25)" : "rgba(117,81,255,0.1)",
    pink:          "#FF5E8E",
    pinkSoft:      isDark ? "rgba(255,94,142,0.25)" : "rgba(255,94,142,0.1)",
    cyan:          "#00E396",
    cyanSoft:      isDark ? "rgba(0,227,150,0.25)" : "rgba(0,227,150,0.1)",
    green:         "#05CD99",
    greenSoft:     isDark ? "rgba(5,205,153,0.25)" : "rgba(5,205,153,0.1)",
    amber:         "#FFCE20",
    amberSoft:     isDark ? "rgba(255,206,32,0.25)" : "rgba(255,206,32,0.15)",
    red:           "#EE5D50",
    textPrimary:   isDark ? "#F9FAFB" : "#2B3674",
    textSecondary: isDark ? "#D1D5DB" : "#4A5568",
    textMuted:     isDark ? "#9CA3AF" : "#A3AED0",
    gradPrimary:   "linear-gradient(135deg, #868CFF, #4318FF)",
    gradViolet:    "linear-gradient(135deg, #8A73FF, #7551FF)",
    gradPink:      "linear-gradient(135deg, #FF94B4, #FF5E8E)",
    gradCyan:      "linear-gradient(135deg, #33EABD, #00E396)",
    gradGreen:     "linear-gradient(135deg, #30E0A1, #05CD99)",
    gradAmber:     "linear-gradient(135deg, #FFDE59, #FFCE20)",
  };

  const glassCard = {
    background: G.surface,
    border: `1px solid ${G.glassBorder}`,
    borderRadius: 16,
    boxShadow: G.glassShadow,
    padding: 24,
    marginBottom: 20,
    position: "relative",
    overflow: "hidden",
  };

  const mkBtn = (grad = G.gradPrimary, sm = false) => ({
    background: grad,
    border: "none",
    borderRadius: sm ? 10 : 14,
    padding: sm ? "8px 16px" : "12px 24px",
    fontSize: sm ? 13 : 15,
    fontWeight: 700,
    color: "#fff",
    cursor: "pointer",
    fontFamily: "inherit",
    transition: "opacity 0.15s",
  });

  const mkGhostBtn = (color = G.primary) => ({
    background: `${color}15`,
    border: `1px solid ${color}40`,
    borderRadius: 12,
    padding: "8px 18px",
    fontSize: 13,
    fontWeight: 600,
    color: color,
    cursor: "pointer",
    fontFamily: "inherit",
    transition: "all 0.15s",
  });

  const mkPill = (color, bg) => ({
    display: "inline-block",
    padding: "4px 14px",
    borderRadius: 99,
    fontSize: 12,
    fontWeight: 700,
    background: bg || `${color}15`,
    color: color,
    marginRight: 6,
    marginBottom: 4,
  });

  const inp = {
    background: isDark ? "#1F2937" : "#F4F7FE",
    border: `1px solid ${G.glassBorder}`,
    borderRadius: 12,
    padding: "12px 18px",
    color: G.textPrimary,
    fontSize: 14,
    fontWeight: 500,
    fontFamily: "inherit",
    outline: "none",
    width: "100%",
    boxSizing: "border-box",
  };

  const sel = { ...inp, cursor: "pointer", width: "auto", minWidth: 170, paddingRight: 32 };

  return { G, glassCard, mkBtn, mkGhostBtn, mkPill, inp, sel };
};

/* ─────────────────────────────────────────────────────────────
   Background blobs (decorative)
───────────────────────────────────────────────────────────── */
function Blobs() {
  return (
    <div style={{ position: "fixed", inset: 0, pointerEvents: "none", zIndex: 0, overflow: "hidden" }}>
      <div style={{ position: "absolute", top: -120, left: -100, width: 800, height: 800, borderRadius: "50%", background: "radial-gradient(circle, rgba(67,24,255,0.03) 0%, transparent 70%)" }} />
      <div style={{ position: "absolute", top: "20%", right: -150, width: 600, height: 600, borderRadius: "50%", background: "radial-gradient(circle, rgba(0,227,150,0.03) 0%, transparent 70%)" }} />
      <div style={{ position: "absolute", bottom: -100, left: "30%", width: 500, height: 500, borderRadius: "50%", background: "radial-gradient(circle, rgba(255,94,142,0.03) 0%, transparent 70%)" }} />
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────
   Stat Card
───────────────────────────────────────────────────────────── */
function StatCard({ label, value, grad, icon }) {
  const { G, glassCard, mkBtn, mkGhostBtn, mkPill, inp, sel } = useContext(StylesContext);

  return (
    <div style={{ ...glassCard, padding: 18, marginBottom: 0, display: "flex", alignItems: "center", gap: 14 }}>
      <div style={{ width: 46, height: 46, borderRadius: 14, background: grad, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20, flexShrink: 0 }}>
        {icon}
      </div>
      <div>
        <div style={{ fontSize: 22, fontWeight: 800, color: G.textPrimary, lineHeight: 1.1 }}>{value}</div>
        <div style={{ fontSize: 11, color: G.textMuted, marginTop: 2, textTransform: "uppercase", letterSpacing: "0.8px" }}>{label}</div>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────
   DASHBOARD
───────────────────────────────────────────────────────────── */
function Dashboard({ scores }) {
  const { G, glassCard, mkBtn, mkGhostBtn, mkPill, inp, sel } = useContext(StylesContext);

  const days = getDaysLeft();
  const pct = Math.min(100, Math.round(((166 - days) / 166) * 100));
  const totalQ = Object.values(scores).reduce((a, b) => a + b.total, 0);
  const totalC = Object.values(scores).reduce((a, b) => a + b.correct, 0);
  const acc = totalQ ? Math.round((totalC / totalQ) * 100) : null;

  return (
    <div>
      {/* Hero card */}
      <div style={{ ...glassCard, background: G.gradPrimary, border: "none", color: "#FFFFFF" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 16 }}>
          <div>
            <div style={{ fontSize: 12, color: (G.isDark ? "rgba(255,255,255,0.6)" : "rgba(255,255,255,0.8)"), letterSpacing: "2px", textTransform: "uppercase", fontWeight: 600, marginBottom: 10 }}>NEET PG 2026 · August 30</div>
            <div style={{ fontSize: 32, fontWeight: 800, color: "#FFFFFF", lineHeight: 1.15, marginBottom: 6 }}>Good day, Doctor! 👋</div>
            <div style={{ fontSize: 15, color: "rgba(255,255,255,0.9)" }}>Your personal NEET PG command centre.</div>
          </div>
          <div style={{ textAlign: "center", background: "rgba(255,255,255,0.15)", border: "1px solid rgba(255,255,255,0.2)", borderRadius: 20, padding: "18px 32px" }}>
            <div style={{ fontSize: 56, fontWeight: 900, color: "#FFFFFF", lineHeight: 1, fontFamily: "monospace" }}>{days}</div>
            <div style={{ fontSize: 11, color: (G.isDark ? "rgba(255,255,255,0.6)" : "rgba(255,255,255,0.8)"), letterSpacing: "2px", marginTop: 8, textTransform: "uppercase", fontWeight: 600 }}>Days Left</div>
          </div>
        </div>
        {/* Progress */}
        <div style={{ marginTop: 24 }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, color: "rgba(255,255,255,0.9)", marginBottom: 8, fontWeight: 600 }}>
            <span>Preparation journey</span><span>{pct}%</span>
          </div>
          <div style={{ height: 8, background: "rgba(255,255,255,0.2)", borderRadius: 99, overflow: "hidden" }}>
            <div style={{ height: "100%", width: `${pct}%`, background: (G.isDark ? "rgba(255,255,255,0.06)" : "#FFFFFF"), borderRadius: 99, transition: "width 1s ease" }} />
          </div>
        </div>
      </div>

      {/* Stats row */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 12, marginBottom: 18 }}>
        <StatCard label="Subjects Attempted" value={Object.keys(scores).length || "—"} grad={G.gradViolet} icon="📚" />
        <StatCard label="MCQs Completed" value={totalQ || "—"} grad={G.gradCyan} icon="✏️" />
        <StatCard label="Overall Accuracy" value={acc !== null ? `${acc}%` : "—"} grad={G.gradGreen} icon="🎯" />
        <StatCard label="Days Remaining" value={days} grad={G.gradPink} icon="⏳" />
      </div>

      {/* Subject bars */}
      <div style={glassCard}>
        <div style={{ fontSize: 16, fontWeight: 700, color: G.textPrimary, marginBottom: 18, display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ width: 32, height: 32, borderRadius: 10, background: G.gradViolet, display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 16 }}>📊</span>
          Subject Performance
        </div>
        {SUBJECTS.map(s => {
          // Force Medicine to show at least 0% · 0Q if not started
          const sc = scores[s] || (s === "Medicine" ? { correct: 0, total: 0 } : null);
          const a = sc ? (sc.total > 0 ? Math.round((sc.correct / sc.total) * 100) : 0) : null;
          const barColor = a === null ? G.textMuted : a >= 70 ? G.green : a >= 50 ? G.amber : G.red;
          const sd = SUBJECT_DATA[s];
          return (
            <div key={s} style={{ marginBottom: 16 }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 14, marginBottom: 8, color: G.textPrimary, fontWeight: 600 }}>
                <span style={{ display: "flex", alignItems: "center", gap: 8 }}><span style={{ fontSize: 16 }}>{sd.icon}</span> {s}</span>
                <span style={{ fontFamily: "monospace", fontWeight: 700, color: barColor }}>
                  {a === null ? "not started" : `${a}% · ${sc.total}Q`}
                </span>
              </div>
              <div style={{ height: 8, background: (G.isDark ? "rgba(0,0,0,0.1)" : "#F4F7FE"), borderRadius: 99, overflow: "hidden" }}>
                <div style={{ height: "100%", width: `${a || 0}%`, background: a >= 70 ? G.gradGreen : a >= 50 ? G.gradAmber : a > 0 ? "linear-gradient(90deg,#EE5D50,#FF8A65)" : "transparent", borderRadius: 99, transition: "width 0.6s ease" }} />
              </div>
            </div>
          );
        })}
        {!totalQ && <div style={{ fontSize: 13, color: G.textMuted, marginTop: 8 }}>Take mock tests to populate your performance data.</div>}
      </div>
      
      {/* Merged Analytics Section */}
      <div style={{ marginTop: 24 }}>
        <h2 style={{ fontSize: 22, fontWeight: 800, color: G.textPrimary, marginBottom: 16 }}>In-Depth Analytics</h2>
        <Analytics scores={scores} />
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────
   AI CHAT
───────────────────────────────────────────────────────────── */
function AiChat({ uploadedText }) {
  const { G, glassCard, mkBtn, mkGhostBtn, mkPill, inp, sel } = useContext(StylesContext);

  const [msgs, setMsgs] = useLocalStorage("medmentor_chat_msgs", [{ role: "assistant", content: "Namaste Doctor! 🩺 I'm your NEET PG AI tutor. Ask me anything — concepts, mnemonics, case discussions, PYQ explanations. Or just say quiz me on Pathology!" }]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const endRef = useRef(null);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [msgs]);

  const send = async () => {
    if (!input.trim() || busy) return;
    const text = input.trim(); setInput("");
    const next = [...msgs, { role: "user", content: text }];
    setMsgs(next); setBusy(true);
    const history = next.slice(-12).map(m => ({ role: m.role, content: m.content }));
    const ctx = uploadedText ? `\n\nUploaded study material:\n${uploadedText.slice(0, 4000)}` : "";
    setMsgs(m => [...m, { role: "assistant", content: "" }]);
    try {
      await claudeStream(
        `You are an expert NEET PG tutor for an Indian doctor preparing for NEET PG 2026 (August 30). Deep knowledge of all 19 MBBS subjects. Concise, clinical, high-yield. Use mnemonics. Format clearly.${ctx}`,
        "", history,
        t => setMsgs(m => { const c = [...m]; c[c.length - 1] = { role: "assistant", content: t }; return c; })
      );
    } catch (err) { setMsgs(m => { const c = [...m]; c[c.length - 1] = { role: "assistant", content: "⚠️ Error: " + err.message }; return c; }); }
    finally { setBusy(false); }
  };

  const quickPrompts = ["Quiz me on Pharmacology", "Mnemonics for Cranial nerves", "High yield topics in Surgery", "Explain Cushings syndrome"];

  return (
    <div style={{ ...glassCard, display: "flex", flexDirection: "column", height: "calc(100vh - 160px)", padding: "24px 32px" }}>
      <div style={{ flexShrink: 0 }}>
        <div style={{ fontSize: 22, fontWeight: 800, color: G.textPrimary, marginBottom: 6, display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ width: 40, height: 40, borderRadius: 12, background: G.gradPrimary, color: "#FFF", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 18 }}>🧠</span>
          AI Tutor
        </div>
        <div style={{ fontSize: 14, color: G.textMuted, marginBottom: 18 }}>
          Ask anything · request mnemonics · "quiz me on [subject]"
          {uploadedText && <span style={{ color: G.primary }}> · 📎 {Math.round(uploadedText.length / 1000)}k chars loaded</span>}
        </div>

        {/* Quick prompts */}
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 20 }}>
          {quickPrompts.map(p => (
            <button key={p} style={{ ...mkGhostBtn(G.primary), padding: "8px 16px", fontSize: 13 }} onClick={() => { setInput(p); }}>
              {p}
            </button>
          ))}
        </div>
      </div>

      {/* Chat window */}
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column", gap: 16, marginBottom: 20, paddingRight: 10 }}>
        {msgs.map((m, i) => (
          <div key={i} style={{ display: "flex", justifyContent: m.role === "user" ? "flex-end" : "flex-start", alignItems: "flex-end", gap: 12 }}>
            {m.role === "assistant" && (
              <div style={{ width: 36, height: 36, borderRadius: 12, background: G.gradPrimary, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, flexShrink: 0, boxShadow: "0px 4px 10px rgba(67, 24, 255, 0.2)" }}>⚕</div>
            )}
            <div style={{
              maxWidth: "78%", padding: "16px 20px", fontSize: 15, lineHeight: 1.7, whiteSpace: "pre-wrap",
              borderRadius: m.role === "user" ? "20px 20px 6px 20px" : "20px 20px 20px 6px",
              background: m.role === "user" ? G.gradPrimary : (G.isDark ? "rgba(255,255,255,0.03)" : "#F8F9FA"),
              border: m.role === "user" ? "none" : `1px solid #E2E8F0`,
              color: m.role === "user" ? (G.isDark ? "rgba(255,255,255,0.06)" : "#FFFFFF") : G.textPrimary,
              boxShadow: m.role === "user" ? "0px 8px 16px rgba(67, 24, 255, 0.15)" : "none",
            }}>
              {m.content || (busy && i === msgs.length - 1 ? <span style={{ color: G.textMuted }}>●●●</span> : "")}
            </div>
          </div>
        ))}
        <div ref={endRef} />
      </div>

      <div style={{ display: "flex", gap: 12, flexShrink: 0 }}>
        <input style={{ ...inp, flex: 1, padding: "16px 22px", fontSize: 15, borderRadius: 16, border: "1px solid #E2E8F0" }} value={input} onChange={e => setInput(e.target.value)}
          onKeyDown={e => e.key === "Enter" && !e.shiftKey && send()}
          placeholder="Ask anything about NEET PG…" />
        <button style={{ ...mkBtn(G.gradPrimary), padding: "14px 32px", fontSize: 15, borderRadius: 16 }} onClick={send} disabled={busy}>
          {busy ? "…" : "Send →"}
        </button>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────
   PDF QUESTION BANK PARSER
   Extracts MCQs from common question bank PDF text formats.
───────────────────────────────────────────────────────────── */
const parseMcqText = (text) => {
  const questions = [];
  // Normalize line endings
  const t = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  // Strategy 1: Numbered question blocks with lettered options
  // Matches patterns like: "1. Question text\nA. option\nB. option\nC. option\nD. option"
  // Also handles: "1) Question", "Q1.", "Q.1", "1:", etc.
  const qBlocks = t.split(/\n(?=(?:Q?\s*\.?\s*)?(?:\d{1,4})\s*[.):\-]\s+)/i);

  for (const block of qBlocks) {
    // Extract question number and text
    const qMatch = block.match(/^(?:Q?\s*\.?\s*)?(\d{1,4})\s*[.):\-]\s+([\s\S]*?)(?=\n\s*[Aa][.):\s])/);
    if (!qMatch) continue;

    const qText = qMatch[2].trim().replace(/\n/g, " ").replace(/\s+/g, " ");
    if (qText.length < 10) continue; // too short to be a real question

    // Extract options A-D
    const optA = block.match(/\n\s*[Aa][.):\s]\s*(.*?)(?=\n\s*[Bb][.):\s])/s);
    const optB = block.match(/\n\s*[Bb][.):\s]\s*(.*?)(?=\n\s*[Cc][.):\s])/s);
    const optC = block.match(/\n\s*[Cc][.):\s]\s*(.*?)(?=\n\s*[Dd][.):\s])/s);
    const optD = block.match(/\n\s*[Dd][.):\s]\s*(.*?)(?=\n|$)/s);

    if (!optA || !optB || !optC || !optD) continue;

    const options = [
      "A. " + optA[1].trim().replace(/\n/g, " ").replace(/\s+/g, " "),
      "B. " + optB[1].trim().replace(/\n/g, " ").replace(/\s+/g, " "),
      "C. " + optC[1].trim().replace(/\n/g, " ").replace(/\s+/g, " "),
      "D. " + optD[1].trim().replace(/\n/g, " ").replace(/\s+/g, " "),
    ];

    // Try to find answer
    const ansMatch = block.match(/(?:answer|ans|correct|key)\s*[.:)\-]\s*([A-Da-d])/i);
    const answer = ansMatch ? ansMatch[1].toUpperCase() : null;

    // Try to find explanation
    const expMatch = block.match(/(?:explanation|exp|rationale|reason)\s*[.:)\-]\s*([\s\S]*?)(?=\n\s*(?:Q?\s*\.?\s*)?\d{1,4}\s*[.):\-]|$)/i);
    const explanation = expMatch ? expMatch[1].trim().replace(/\n/g, " ").replace(/\s+/g, " ").slice(0, 500) : "";

    questions.push({ q: qText, options, answer: answer || "A", explanation: explanation || "Refer to your textbook for detailed explanation.", subject: "" });
  }

  // Strategy 2: If strategy 1 found very few, try a simpler line-by-line approach
  if (questions.length < 3) {
    const lines = t.split("\n").map(l => l.trim()).filter(l => l.length > 0);
    let i = 0;
    while (i < lines.length) {
      // Look for a line that looks like a question (starts with number or is long enough)
      const qLine = lines[i];
      const isQ = /^(?:Q?\s*\.?\s*)?\d{1,4}\s*[.):\-]/.test(qLine) || (qLine.length > 30 && qLine.endsWith("?"));
      if (isQ && i + 4 < lines.length) {
        const qText = qLine.replace(/^(?:Q?\s*\.?\s*)?\d{1,4}\s*[.):\-]\s*/, "").trim();
        // Check if next 4 lines are options
        const nextLines = lines.slice(i + 1, i + 5);
        const areOpts = nextLines.every((l, j) => {
          const letter = ["a", "b", "c", "d"][j];
          return new RegExp(`^[${letter}${letter.toUpperCase()}][.):\\s]`).test(l);
        });
        if (areOpts && qText.length > 10) {
          const opts = nextLines.map((l, j) => {
            const letter = ["A", "B", "C", "D"][j];
            return letter + ". " + l.replace(/^[A-Da-d][.):\s]\s*/, "").trim();
          });
          // Check for answer on next line
          let answer = "A";
          let explanation = "";
          if (i + 5 < lines.length) {
            const ansLine = lines[i + 5];
            const am = ansLine.match(/(?:answer|ans|correct|key)\s*[.:)\-]?\s*([A-Da-d])/i);
            if (am) answer = am[1].toUpperCase();
          }
          if (i + 6 < lines.length && /^(?:explanation|exp|rationale)/i.test(lines[i + 6])) {
            explanation = lines[i + 6].replace(/^(?:explanation|exp|rationale)\s*[.:)\-]?\s*/i, "").trim();
          }
          questions.push({ q: qText, options: opts, answer, explanation: explanation || "Refer to your textbook.", subject: "" });
          i += 5;
          continue;
        }
      }
      i++;
    }
  }

  return questions;
};

/* ─────────────────────────────────────────────────────────────
   MOCK TEST
───────────────────────────────────────────────────────────── */
// NEET PG subject weightage (marks out of 200 in actual exam)
const NEET_PG_WEIGHTAGE = {
  "Medicine": 18, "Surgery": 14, "OBG": 13, "Pediatrics": 10,
  "Pathology": 10, "Pharmacology": 10, "Microbiology": 8,
  "Anatomy": 9, "Physiology": 8, "Biochemistry": 6,
  "Community Medicine": 7, "ENT": 6, "Ophthalmology": 6,
  "Psychiatry": 4, "Dermatology": 4, "Orthopedics": 5,
  "Anesthesia": 3, "Forensic Medicine": 3, "Radiology": 3,
};

function MockTest({ onScore }) {
  const { G, glassCard, mkBtn, mkGhostBtn, mkPill, inp, sel } = useContext(StylesContext);

  // State for test configuration
  const [mode, setMode] = useState("subject"); // "subject" | "grand"
  const [subjects, setSubjects] = useState(["Medicine"]);
  const [subtopics, setSubtopics] = useState([]);
  const [numQ, setNumQ] = useState(10);
  const [gtQuestionCount, setGtQuestionCount] = useState(200); // 100 or 200
  const [source, setSource] = useState("ai"); // "ai" | "pdf"

  // Instant answer reveal toggle
  const [instantReveal, setInstantReveal] = useLocalStorage("medmentor_instant_reveal", false);

  // Question bank from PDFs — stored per subject
  const [questionBanks, setQuestionBanks] = useLocalStorage("medmentor_question_banks", {});
  const bankFileRef = useRef(null);
  const bankAiFileRef = useRef(null);
  const [bankProcessing, setBankProcessing] = useState(false);

  // State for current test session — persisted to localStorage for save/resume
  const [currentTest, setCurrentTest] = useLocalStorage("medmentor_active_test", null);
  const [currentQIdx, setCurrentQIdx] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadingMsg, setLoadingMsg] = useState("");

  // State for test history
  const [testHistory, setTestHistory] = useLocalStorage("medmentor_test_history", []);

  // Total questions in bank for selected subjects
  const bankCount = subjects.reduce((sum, s) => sum + (questionBanks[s]?.length || 0), 0);
  const totalBankCount = Object.values(questionBanks).reduce((sum, qs) => sum + qs.length, 0);

  // Extract raw text from a PDF or text file
  const extractFileText = async (file, onProgress) => {
    if (file.type === "application/pdf") {
      await ensurePdfJs();
      const ab = await file.arrayBuffer();
      const pdf = await window.pdfjsLib.getDocument({ data: ab }).promise;
      const pages = [];
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const tc = await page.getTextContent();
        // Join items preserving newlines based on y-position changes
        let lastY = null;
        let lineText = "";
        const pageLines = [];
        for (const item of tc.items) {
          if (lastY !== null && Math.abs(item.transform[5] - lastY) > 2) {
            if (lineText.trim()) pageLines.push(lineText.trim());
            lineText = "";
          }
          lineText += item.str;
          lastY = item.transform[5];
        }
        if (lineText.trim()) pageLines.push(lineText.trim());
        pages.push(pageLines.join("\n"));
        onProgress && onProgress(i, pdf.numPages);
      }
      return pages.join("\n\n");
    } else {
      return new Promise((res, rej) => { const r = new FileReader(); r.onload = e => res(e.target.result); r.onerror = rej; r.readAsText(file); });
    }
  };

  // AI-assisted PDF parsing — sends chunks of raw text to Gemini to extract MCQs
  const aiParsePdf = async (text, targetSubject, fileName) => {
    const CHUNK = 6000; // chars per AI call
    const chunks = [];
    for (let i = 0; i < text.length; i += CHUNK) chunks.push(text.slice(i, i + CHUNK));
    
    const allQuestions = [];
    for (let ci = 0; ci < chunks.length; ci++) {
      setLoadingMsg(`AI parsing chunk ${ci + 1}/${chunks.length}...`);
      try {
        const raw = await claudeOnce(
          `You are an MCQ extractor. Extract ALL multiple choice questions from the following text.
Return ONLY a valid JSON array, no explanation, no markdown.
Format: [{"q":"question text","options":["A. option","B. option","C. option","D. option"],"answer":"A","explanation":"if present, else empty string"}]
If no answer key is given, put your best guess for "answer".
Text:\n${chunks[ci]}`,
          "Extract MCQs"
        );
        const parsed = JSON.parse(raw.replace(/```json|```/g, "").trim());
        if (Array.isArray(parsed)) allQuestions.push(...parsed);
      } catch (e) { /* skip bad chunk */ }
    }
    return allQuestions;
  };

  // Process uploaded PDF into question bank — tries regex first, then AI
  const processBankPdf = async (file, targetSubject, forceAi = false) => {
    setBankProcessing(true);
    setLoadingMsg(`Reading "${file.name}"...`);
    try {
      const text = await extractFileText(file, (cur, tot) => setLoadingMsg(`Reading page ${cur}/${tot}...`));

      let parsed = [];
      if (!forceAi) {
        setLoadingMsg("Trying fast extraction (regex)...");
        parsed = parseMcqText(text);
      }

      if (parsed.length < 3 || forceAi) {
        // Regex failed or user forced AI — use AI parser
        setLoadingMsg(`Regex found ${parsed.length} questions. Switching to AI parser...`);
        await new Promise(r => setTimeout(r, 600));
        parsed = await aiParsePdf(text, targetSubject, file.name);
      }

      if (parsed.length === 0) {
        alert(`Could not extract any MCQs from "${file.name}" even with AI.\n\nWorkarounds:\n• Make sure the PDF is not scanned/image-based (it must be selectable text)\n• Try copying questions into a .txt file manually and upload that\n• Use AI Generate mode instead`);
        return;
      }

      const tagged = parsed.map(q => ({ ...q, subject: targetSubject }));
      setQuestionBanks(prev => ({
        ...prev,
        [targetSubject]: [...(prev[targetSubject] || []), ...tagged]
      }));
      alert(`✅ Extracted ${tagged.length} questions from "${file.name}" into ${targetSubject} bank!\n\n(${forceAi || parsed.length < 3 ? "Used AI parser" : "Used fast regex parser"})`);
    } catch (e) { alert("Error parsing file: " + e.message); }
    finally { setBankProcessing(false); setLoadingMsg(""); }
  };

  // Timer state
  const [timeLeft, setTimeLeft] = useState(0);

  const fmt = (s) => {
    const m = Math.floor(s / 60);
    const ss = s % 60;
    return `${m}:${ss < 10 ? '0' : ''}${ss}`;
  };

  useEffect(() => {
    if (currentTest && !currentTest.endTime && timeLeft > 0) {
      const timer = setInterval(() => setTimeLeft(prev => prev - 1), 1000);
      return () => clearInterval(timer);
    } else if (currentTest && !currentTest.endTime && timeLeft === 0 && currentTest.startTime) {
      // Auto-submit if time runs out
      const hasAnswers = currentTest.answers.some(a => a !== undefined);
      if (hasAnswers) finishTest();
    }
  }, [currentTest, timeLeft]);

  // Helper to normalize AI-returned subject name to a known SUBJECTS key
  const normalizeSubject = (aiSubject, fallback) => {
    if (!aiSubject) return fallback;
    const lower = aiSubject.toLowerCase();
    const match = SUBJECTS.find(s => s.toLowerCase() === lower ||
      lower.includes(s.toLowerCase()) || s.toLowerCase().includes(lower));
    return match || fallback;
  };

  // Helper to build weighted prompt for grand test
  const buildGrandTestPrompt = (total) => {
    const totalW = Object.values(NEET_PG_WEIGHTAGE).reduce((a, b) => a + b, 0);
    const dist = Object.entries(NEET_PG_WEIGHTAGE).map(([s, w]) => {
      const n = Math.max(1, Math.round((w / totalW) * total));
      return `${s}: ${n} questions`;
    }).join(", ");
    return `Generate exactly ${total} NEET PG Grand Test MCQs across ALL subjects with this EXACT distribution: ${dist}.
Return ONLY valid JSON array, no markdown.
Format: [{"q":"question","options":["A. ...","B. ...","C. ...","D. ..."],"answer":"A","explanation":"brief","subject":"ExactSubjectNameFromDistribution"}]
Clinical vignette style. Maintain subject distribution strictly.`;
  };

  // Function to start a new test
  const startNewTest = async () => {
    setLoading(true);
    const actualNumQ = mode === "grand" ? gtQuestionCount : numQ;
    setLoadingMsg(`Preparing ${actualNumQ} questions...`);
    try {
      let questions;
      const testConfig = { mode, subjects, subtopics, numQ: actualNumQ, source };

      if (source === "pdf") {
        // Sample from question banks
        let pool = [];
        if (mode === "grand") {
          // Weighted sampling across all subjects that have banks
          const totalW = Object.values(NEET_PG_WEIGHTAGE).reduce((a, b) => a + b, 0);
          const sampled = [];
          for (const [subj, weight] of Object.entries(NEET_PG_WEIGHTAGE)) {
            const bank = questionBanks[subj] || [];
            if (bank.length === 0) continue;
            const needed = Math.max(1, Math.round((weight / totalW) * actualNumQ));
            const shuffled = [...bank].sort(() => Math.random() - 0.5);
            sampled.push(...shuffled.slice(0, needed).map(q => ({ ...q, subject: subj })));
          }
          pool = sampled.sort(() => Math.random() - 0.5).slice(0, actualNumQ);
        } else {
          // Pool from selected subjects
          for (const s of subjects) {
            const bank = questionBanks[s] || [];
            pool.push(...bank.map(q => ({ ...q, subject: s })));
          }
          pool = pool.sort(() => Math.random() - 0.5).slice(0, actualNumQ);
        }
        if (pool.length === 0) {
          alert("No questions found in your PDF banks for the selected subjects. Upload PDFs first!");
          setLoading(false); setLoadingMsg(""); return;
        }
        if (pool.length < actualNumQ) {
          setLoadingMsg(`Only ${pool.length} questions available (requested ${actualNumQ}). Using all available.`);
          await new Promise(r => setTimeout(r, 1000));
        }
        questions = pool;
      } else {
        // AI generation (existing logic)
        let raw;
        if (mode === "grand") {
          setLoadingMsg(`Generating ${actualNumQ}-question Grand Test across all 19 subjects...`);
          raw = await claudeOnce(buildGrandTestPrompt(actualNumQ), `Generate NEET PG Grand Test with ${actualNumQ} questions across all subjects.`);
        } else {
          const subjectList = subjects.join(", ");
          const subtopicList = subtopics.length > 0 ? ` specifically focusing on subtopics: ${subtopics.join(", ")}` : "";
          setLoadingMsg(`Generating ${actualNumQ} MCQs for ${subjectList}...`);
          raw = await claudeOnce(
            `Generate exactly ${actualNumQ} NEET PG-style MCQs spanning: ${subjectList}${subtopicList}. Return ONLY valid JSON array, no markdown.
Format: [{"q":"question","options":["A. ...","B. ...","C. ...","D. ..."],"answer":"A","explanation":"brief","subject":"SubjectName"}]
Clinical vignette style. Exam-level.`,
            `Generate ${actualNumQ} NEET PG MCQs on ${subjectList}${subtopicList}.`
          );
        }
        questions = JSON.parse(raw.replace(/```json|```/g, "").trim());
      }

      const newTest = {
        id: Date.now(),
        config: testConfig,
        questions,
        answers: Array(questions.length).fill(undefined),
        startTime: new Date().toISOString(),
        endTime: null,
        score: null,
        correctCount: 0,
        wrongCount: 0,
      };
      setCurrentTest(newTest);
      setCurrentQIdx(0);
      setTimeLeft(questions.length * 90);
      setTestHistory(prev => [newTest, ...prev]);
    } catch (e) { alert("Error generating: " + e.message); }
    finally { setLoading(false); setLoadingMsg(""); }
  };

  // Function to resume a test from history
  const resumeTest = (testId) => {
    const testToResume = testHistory.find(test => test.id === testId);
    if (testToResume) {
      setCurrentTest(testToResume);
      // Find the first unanswered question or go to the last one if all answered
      const firstUnanswered = testToResume.answers.findIndex(ans => ans === undefined);
      setCurrentQIdx(firstUnanswered !== -1 ? firstUnanswered : testToResume.questions.length - 1);
      
      if (!testToResume.endTime) {
        // Approximate remaining time (simple fallback)
        const elapsed = (Date.now() - new Date(testToResume.startTime).getTime()) / 1000;
        const total = (testToResume.config.mode === "grand" ? 200 : testToResume.config.numQ) * 90;
        setTimeLeft(Math.max(0, Math.round(total - elapsed)));
      }
    }
  };

  // Function to handle answer selection
  const handleAnswer = (qIdx, selectedOption) => {
    if (!currentTest || currentTest.endTime) return; // Cannot answer if test is finished

    const newAnswers = [...currentTest.answers];
    newAnswers[qIdx] = selectedOption;

    const updatedTest = { ...currentTest, answers: newAnswers };
    setCurrentTest(updatedTest);

    // Update history in localStorage immediately
    setTestHistory(prev => prev.map(test => test.id === updatedTest.id ? updatedTest : test));
  };

  // Function to navigate questions
  const navigateQuestion = (direction) => {
    if (!currentTest) return;
    const newIdx = currentQIdx + direction;
    if (newIdx >= 0 && newIdx < currentTest.questions.length) {
      setCurrentQIdx(newIdx);
    }
  };

  // Function to finish a test (calculate score, save to history)
  const finishTest = () => {
    console.log("🏁 Finishing test...", currentTest);
    if (!currentTest) return;

    let correctCount = 0;
    let wrongCount = 0;
    const subStats = {};
    const fallback = currentTest.config.mode === "grand" ? "Medicine" : currentTest.config.subjects[0];

    currentTest.questions.forEach((q, i) => {
      const userAnswer = currentTest.answers[i];
      if (userAnswer === undefined) return;

      const letter = userAnswer; // "A", "B", "C", or "D"
      const correctAnswerField = String(q.answer || "").trim();
      
      // Match if q.answer is just the letter (e.g., "A") or starts with the letter (e.g., "A. ...")
      let isCorrect = correctAnswerField.startsWith(letter);
      
      // Also check if q.answer matches the full text of the selected option (fallback)
      const optIdx = ["A", "B", "C", "D"].indexOf(letter);
      if (!isCorrect && optIdx !== -1 && q.options && q.options[optIdx]) {
        const selectedOptText = q.options[optIdx].replace(/^[A-D][.\s]+/, "").trim().toLowerCase();
        const correctOptText = correctAnswerField.replace(/^[A-D][.\s]+/, "").trim().toLowerCase();
        if (selectedOptText && selectedOptText === correctOptText) isCorrect = true;
      }

      if (isCorrect) {
        correctCount++;
      } else {
        wrongCount++;
      }

      // Update subject scores for dashboard
      const s = normalizeSubject(q.subject, fallback);
      if (!subStats[s]) subStats[s] = { c: 0, t: 0 };
      subStats[s].t += 1; // Count only attempted
      if (isCorrect) subStats[s].c += 1;
    });

    const finalScore = correctCount * 4 - wrongCount;

    const finishedTest = {
      ...currentTest,
      endTime: new Date().toISOString(),
      score: finalScore,
      correctCount,
      wrongCount,
    };
    setCurrentTest(finishedTest);

    // Update history in localStorage
    setTestHistory(prev => prev.map(test => test.id === finishedTest.id ? finishedTest : test));

    // Update global scores for dashboard
    Object.entries(subStats).forEach(([s, v]) => onScore(s, v.c, v.t));
  };

  // Render logic:
  // 1. If no current test, show test configuration and history.
  // 2. If a test is active, show current question, options, answer, navigation.

  // Initial screen: Test configuration and history
  if (!currentTest) return (
    <div style={glassCard}>
      <div style={{ fontSize: 18, fontWeight: 700, color: G.textPrimary, marginBottom: 4, display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ width: 34, height: 34, borderRadius: 10, background: G.gradCyan, display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 16 }}>📝</span>
        Mock Test Engine
      </div>
      <div style={{ fontSize: 12, color: G.textMuted, marginBottom: 20 }}>NEET PG-style MCQs · +4 correct · −1 wrong</div>

      {/* Mode Toggle */}
      <div style={{ display: "flex", gap: 10, marginBottom: 16 }}>
        {[["subject", "📚 Subject-wise", G.gradViolet], ["grand", "🏆 Grand Test (All Subjects)", "linear-gradient(135deg,#f43f5e,#e11d48)"]].map(([id, label, grad]) => (
          <button key={id} onClick={() => { setMode(id); setSubjects(["Medicine"]); setSubtopics([]); }}
            style={{ padding: "10px 20px", borderRadius: 14, border: "none", fontWeight: 700, fontSize: 13,
              background: mode === id ? grad : (G.isDark ? "#1F2937" : "#F1F5F9"),
              color: mode === id ? "#fff" : G.textSecondary, cursor: "pointer", fontFamily: "inherit",
              transition: "all 0.15s", boxShadow: mode === id ? "0 4px 14px rgba(0,0,0,0.15)" : "none" }}>
            {label}
          </button>
        ))}
      </div>

      {/* Source Toggle: AI vs PDF */}
      <div style={{ display: "flex", gap: 10, marginBottom: 24 }}>
        {[["ai", "🤖 AI Generated", G.gradPrimary], ["pdf", `📄 From PDF Bank (${totalBankCount}Q)`, G.gradGreen]].map(([id, label, grad]) => (
          <button key={id} onClick={() => setSource(id)}
            style={{ padding: "8px 18px", borderRadius: 12, border: "none", fontWeight: 700, fontSize: 12,
              background: source === id ? grad : (G.isDark ? "#1F2937" : "#F1F5F9"),
              color: source === id ? "#fff" : G.textSecondary, cursor: "pointer", fontFamily: "inherit",
              transition: "all 0.15s", boxShadow: source === id ? "0 3px 12px rgba(0,0,0,0.12)" : "none" }}>
            {label}
          </button>
        ))}
      </div>

      {/* Question Bank Manager — shown when PDF source is selected */}
      {source === "pdf" && (
        <div style={{ marginBottom: 20, padding: "16px 20px", background: G.isDark ? "rgba(5,205,153,0.06)" : "rgba(5,205,153,0.04)", borderRadius: 16, border: `1px solid ${G.green}30` }}>
          <div style={{ fontWeight: 700, color: G.green, marginBottom: 8, fontSize: 14, display: "flex", alignItems: "center", gap: 8 }}>
            📄 Question Bank Manager
            {totalBankCount > 0 && <span style={{ fontSize: 11, padding: "2px 10px", borderRadius: 8, background: `${G.green}20`, fontWeight: 800 }}>{totalBankCount} total questions</span>}
          </div>
          <div style={{ fontSize: 12, color: G.textSecondary, lineHeight: 1.6, marginBottom: 14 }}>
            Upload your subject-wise MCQ PDFs. Questions with numbered format and A/B/C/D options will be auto-extracted.<br/>
            <strong>Works fully offline</strong> — no API key needed!
          </div>

          {/* Per-subject bank status */}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 14 }}>
            {SUBJECTS.map(s => {
              const count = questionBanks[s]?.length || 0;
              return (
                <span key={s} style={{
                  fontSize: 11, padding: "3px 10px", borderRadius: 8, fontWeight: 700,
                  background: count > 0 ? `${G.green}15` : (G.isDark ? "rgba(255,255,255,0.04)" : "#F1F5F9"),
                  color: count > 0 ? G.green : G.textMuted,
                }}>{SUBJECT_DATA[s].icon} {s}: {count}Q</span>
              );
            })}
          </div>

          {/* Upload for specific subject */}
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginBottom: 10 }}>
            <select id="bank-subject-select" style={{ ...sel, minWidth: 160 }} defaultValue={subjects[0]}>
              {SUBJECTS.map(s => <option key={s} value={s}>{SUBJECT_DATA[s].icon} {s}</option>)}
            </select>
            <button disabled={bankProcessing} style={{ ...mkBtn(G.gradGreen), padding: "10px 18px", fontSize: 12, opacity: bankProcessing ? 0.6 : 1 }}
              onClick={() => bankFileRef.current?.click()}>
              {bankProcessing ? "⏳ Processing..." : "⚡ Fast Upload"}
            </button>
            <button disabled={bankProcessing} style={{ ...mkBtn(G.gradViolet), padding: "10px 18px", fontSize: 12, opacity: bankProcessing ? 0.6 : 1 }}
              onClick={() => bankAiFileRef.current?.click()}>
              {bankProcessing ? "⏳ Processing..." : "🤖 AI Parse Upload"}
            </button>
            {/* Fast regex parse */}
            <input ref={bankFileRef} type="file" accept=".pdf,.txt,.md" style={{ display: "none" }}
              onChange={e => {
                const file = e.target.files?.[0];
                if (!file) return;
                const subj = document.getElementById("bank-subject-select")?.value || subjects[0];
                processBankPdf(file, subj, false);
                e.target.value = "";
              }} />
            {/* Force AI parse */}
            <input ref={bankAiFileRef} type="file" accept=".pdf,.txt,.md" style={{ display: "none" }}
              onChange={e => {
                const file = e.target.files?.[0];
                if (!file) return;
                const subj = document.getElementById("bank-subject-select")?.value || subjects[0];
                processBankPdf(file, subj, true);
                e.target.value = "";
              }} />
            {totalBankCount > 0 && (
              <button style={{ ...mkGhostBtn(G.red), padding: "8px 14px", fontSize: 12 }}
                onClick={() => { if (confirm("Clear ALL question banks?")) setQuestionBanks({}); }}>
                🗑 Clear All
              </button>
            )}
          </div>
          {bankProcessing && (
            <div style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 8 }}>
              <div style={{ display: "flex", gap: 4 }}>
                {[0,1,2].map(i => <div key={i} style={{ width: 6, height: 6, borderRadius: 3, background: G.green, animation: `bounce 1.4s ${i*0.16}s infinite ease-in-out both` }} />)}
              </div>
              <span style={{ fontSize: 12, color: G.amber, fontWeight: 600 }}>{loadingMsg}</span>
              <style>{`@keyframes bounce{0%,80%,100%{transform:scale(0)}40%{transform:scale(1)}}`}</style>
            </div>
          )}
        </div>
      )}

      {mode === "grand" && (
        <div style={{ marginBottom: 20, padding: "16px 20px", background: "linear-gradient(135deg,rgba(244,63,94,0.06),rgba(225,29,72,0.04))", borderRadius: 16, border: "1px solid rgba(244,63,94,0.2)" }}>
          <div style={{ fontWeight: 700, color: "#e11d48", marginBottom: 8, fontSize: 14 }}>🏆 NEET PG Grand Test Mode</div>
          <div style={{ fontSize: 12, color: G.textSecondary, lineHeight: 1.6 }}>
            Questions distributed across <strong>all 19 subjects</strong> based on actual NEET PG weightage.
            High-yield subjects (Medicine, Surgery, OBG) get more questions, just like the real exam.
          </div>
          <div style={{ display: "flex", gap: 10, marginTop: 14, marginBottom: 12 }}>
            {[100, 200].map(n => (
              <button key={n} onClick={() => setGtQuestionCount(n)} style={{
                padding: "8px 20px", borderRadius: 12, border: "none", fontWeight: 700, fontSize: 13, cursor: "pointer", fontFamily: "inherit",
                background: gtQuestionCount === n ? "linear-gradient(135deg,#f43f5e,#e11d48)" : (G.isDark ? "#1F2937" : "#F1F5F9"),
                color: gtQuestionCount === n ? "#fff" : G.textSecondary, transition: "all 0.15s",
                boxShadow: gtQuestionCount === n ? "0 4px 12px rgba(244,63,94,0.3)" : "none",
              }}>{n} Questions ({n * 4} marks)</button>
            ))}
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {Object.entries(NEET_PG_WEIGHTAGE).map(([s, w]) => (
              <span key={s} style={{ fontSize: 10, padding: "2px 8px", borderRadius: 99, background: "rgba(244,63,94,0.1)", color: "#e11d48", fontWeight: 700 }}>{s} ~{Math.max(1, Math.round((w / Object.values(NEET_PG_WEIGHTAGE).reduce((a,b)=>a+b,0)) * gtQuestionCount))}</span>
            ))}
          </div>
        </div>
      )}

      {mode === "subject" && (
        <div style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 12, color: G.textMuted, marginBottom: 16, textTransform: "uppercase", letterSpacing: "1px", fontWeight: 700 }}>Select Subjects</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
            {SUBJECTS.map(s => {
              const isSel = subjects.includes(s);
              const sd = SUBJECT_DATA[s];
              return (
                <div key={s}
                  onClick={() => { setSubjects(prev => isSel ? (prev.length > 1 ? prev.filter(x => x !== s) : prev) : [...prev, s]); setSubtopics([]); }}
                  style={{ padding: "8px 16px", borderRadius: 16, border: "2px solid",
                           borderColor: isSel ? G.primary : G.glassBorder,
                           background: isSel ? G.primarySoft : "transparent", cursor: "pointer", fontSize: 14, fontWeight: 600, color: isSel ? G.primary : G.textSecondary, transition: "all 0.15s", display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 16 }}>{sd.icon}</span> {s}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {mode === "subject" && subjects.length === 1 && (
         <div style={{ marginBottom: 24, padding: "16px 20px", background: (G.isDark ? "rgba(255,255,255,0.03)" : "#F8F9FA"), borderRadius: 16, border: "1px solid #E2E8F0" }}>
           <div style={{ fontSize: 12, color: G.textPrimary, marginBottom: 12, textTransform: "uppercase", letterSpacing: "1px", fontWeight: 700 }}>Drill down into {subjects[0]} Subtopics (Optional)</div>
           <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {SUBJECT_DATA[subjects[0]].sub.map(sub => (
                 <div key={sub} onClick={() => setSubtopics(prev => prev.includes(sub) ? prev.filter(x=>x!==sub) : [...prev, sub])}
                    style={{ padding: "6px 14px", borderRadius: 12, fontSize: 13, border: "1px solid",
                             borderColor: subtopics.includes(sub) ? G.primary : G.glassBorder,
                             background: subtopics.includes(sub) ? G.primary : "#FFF",
                             color: subtopics.includes(sub) ? "#FFF" : G.textSecondary, cursor: "pointer", transition: "all 0.15s", fontWeight: 600 }}>
                    {sub}
                 </div>
              ))}
           </div>
         </div>
      )}

      {/* Instant Reveal Toggle */}
      <div style={{ marginBottom: 20, display: "flex", alignItems: "center", gap: 12 }}>
        <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 13, color: G.textSecondary, fontWeight: 600 }}>
          <div onClick={() => setInstantReveal(!instantReveal)} style={{
            width: 44, height: 24, borderRadius: 12, background: instantReveal ? G.green : G.glassBorder,
            position: "relative", cursor: "pointer", transition: "background 0.2s",
          }}>
            <div style={{ width: 18, height: 18, borderRadius: 9, background: "#fff", position: "absolute", top: 3, left: instantReveal ? 23 : 3, transition: "left 0.2s", boxShadow: "0 1px 4px rgba(0,0,0,0.2)" }} />
          </div>
          Show answer immediately after selecting
        </label>
      </div>

      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "center", marginBottom: 24 }}>
        <div>
          <div style={{ fontSize: 11, color: G.textMuted, marginBottom: 8, textTransform: "uppercase", letterSpacing: "1px" }}>Questions</div>
          {mode === "grand" ? (
            <div style={{ ...sel, background: (G.isDark ? "#1F2937" : "#F4F7FE"), border: "1px solid #E2E8F0", display: "flex", alignItems: "center", fontWeight: 700, color: G.textPrimary }}>
              {gtQuestionCount} Questions ({gtQuestionCount * 4} marks)
            </div>
          ) : (
            <select style={sel} value={numQ} onChange={e => setNumQ(+e.target.value)}>
              {[10, 30, 50, 100].map(n => <option key={n} value={n}>{n} Questions</option>)}
            </select>
          )}
        </div>
        <button disabled={loading} style={{ ...mkBtn(mode === "grand" ? "linear-gradient(135deg,#f43f5e,#e11d48)" : G.gradViolet), padding: "12px 32px", fontSize: 14, opacity: loading ? 0.6 : 1 }} onClick={() => {
          startNewTest();
        }}>
          {loading ? "⏳ Generating..." : (mode === "grand" ? "🏆 Start Grand Test" : "▶ Start Test")}
        </button>
        {loading && (
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ display: "flex", gap: 4 }}>
              {[0,1,2].map(i => <div key={i} style={{ width: 8, height: 8, borderRadius: 4, background: G.primary, animation: `bounce 1.4s ${i*0.16}s infinite ease-in-out both` }} />)}
            </div>
            <span style={{ fontSize: 13, color: G.amber, fontWeight: 700, animation: "pulse 1.5s ease-in-out infinite" }}>{loadingMsg}</span>
            <style>{`@keyframes bounce{0%,80%,100%{transform:scale(0)}40%{transform:scale(1)}} @keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}`}</style>
          </div>
        )}
      </div>
      <div style={{ fontSize: 12, color: G.textMuted, background: "rgba(255,255,255,0.04)", borderRadius: 12, padding: "10px 16px", marginBottom: 24 }}>
        ⏱ Time allowed: {(mode === "grand" ? gtQuestionCount : numQ) * 1.5} min · Max score: {(mode === "grand" ? gtQuestionCount : numQ) * 4} marks
      </div>

      {/* Saved Tests History */}
      {(() => {
        const mcqTests = testHistory.filter(t => t.config?.mode !== "grand");
        const gtTests = testHistory.filter(t => t.config?.mode === "grand");
        const renderList = (tests, prefix) => tests.map((t, i) => {
          const num = tests.length - i;
          const label = `${prefix} ${num}`;
          const answered = t.answers?.filter(a => a !== undefined).length || 0;
          const total = t.questions?.length || 0;
          const isDone = !!t.endTime;
          const subj = t.config?.mode === "grand" ? "All Subjects" : (t.config?.subjects?.join(", ") || "—");
          const acc = isDone && t.correctCount !== undefined ? Math.round((t.correctCount / Math.max(1, t.correctCount + t.wrongCount)) * 100) : null;
          return (
            <div key={t.id} onClick={() => resumeTest(t.id)} style={{
              display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12,
              padding: "12px 16px", borderRadius: 14, cursor: "pointer", transition: "all 0.15s",
              background: G.isDark ? "rgba(255,255,255,0.03)" : "#F8FAFC",
              border: `1px solid ${G.glassBorder}`, marginBottom: 8,
            }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 700, fontSize: 14, color: G.textPrimary }}>{label}</div>
                <div style={{ fontSize: 11, color: G.textMuted, marginTop: 2 }}>{subj} · {total}Q · {new Date(t.startTime).toLocaleDateString()}</div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
                {isDone ? (
                  <>
                    <span style={{ fontSize: 12, fontWeight: 700, color: acc >= 60 ? G.green : G.amber }}>{acc}%</span>
                    <span style={{ fontSize: 11, padding: "3px 10px", borderRadius: 8, background: `${G.green}15`, color: G.green, fontWeight: 700 }}>✓ Done</span>
                  </>
                ) : (
                  <span style={{ fontSize: 11, padding: "3px 10px", borderRadius: 8, background: `${G.amber}15`, color: G.amber, fontWeight: 700 }}>{answered}/{total} answered</span>
                )}
                <span style={{ fontSize: 13, color: G.primary, fontWeight: 700 }}>→</span>
              </div>
            </div>
          );
        });
        if (!testHistory.length) return null;
        return (
          <div>
            {mcqTests.length > 0 && (
              <div style={{ marginBottom: 20 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: G.textPrimary, marginBottom: 10, display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 16 }}>📚</span> Subject Tests ({mcqTests.length})
                </div>
                {renderList(mcqTests, "Test")}
              </div>
            )}
            {gtTests.length > 0 && (
              <div>
                <div style={{ fontSize: 13, fontWeight: 700, color: G.textPrimary, marginBottom: 10, display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 16 }}>🏆</span> Grand Tests ({gtTests.length})
                </div>
                {renderList(gtTests, "GT")}
              </div>
            )}
          </div>
        );
      })()}
    </div>
  );

  const submitted = !!currentTest.endTime;
  const qs = currentTest.questions;
  const answers = currentTest.answers;
  const correct = submitted ? qs.filter((q, i) => answers[i] === (q.answer ? q.answer[0] : null)).length : 0;
  const wrong = submitted ? answers.filter(a => a !== undefined).length - correct : 0;
  const score = currentTest.score !== null ? currentTest.score : (correct * 4 - wrong);

  return (
    <div>
      {/* Header bar */}
      <div style={{ ...glassCard, display: "flex", justifyContent: "space-between", alignItems: "center", padding: "16px 24px", marginBottom: 20 }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <span style={mkPill(G.cyan, G.cyanSoft)}>{currentTest.config.subjects.length > 2 ? `${currentTest.config.subjects.length} Subjects` : currentTest.config.subjects.join(", ")}</span>
          <span style={mkPill(G.primary, G.primarySoft)}>{qs.length} Questions</span>
          {submitted && <span style={mkPill(G.amber, G.amberSoft)}>Score: {score}/{qs.length * 4}</span>}
        </div>
        {!submitted
          ? <div style={{ fontFamily: "monospace", fontSize: 24, fontWeight: 800, color: timeLeft < 60 ? G.red : G.primary }}>{fmt(timeLeft)}</div>
          : <div style={{ fontSize: 14, color: G.textMuted, fontWeight: 600 }}>{correct} correct · {wrong} wrong</div>
        }
      </div>

      {/* Question Card */}
      {(() => {
        const answered = answers[currentQIdx] !== undefined;
        const showReveal = (submitted || (instantReveal && answered));
        const correctLetter = qs[currentQIdx].answer ? qs[currentQIdx].answer[0] : null;
        const isCurrentCorrect = answers[currentQIdx] === correctLetter;
        return (
        <div style={{ ...glassCard, border: showReveal ? `2px solid ${isCurrentCorrect ? G.green : answers[currentQIdx] ? G.red : G.glassBorder}` : "1px solid #E2E8F0" }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12 }}>
           <div style={{ fontSize: 12, color: G.textMuted, fontWeight: 700, letterSpacing: "1px" }}>QUESTION {currentQIdx + 1} OF {qs.length}</div>
           <div style={mkPill(G.violet)}>{qs[currentQIdx].subject || currentTest.config.subjects[0]}</div>
        </div>
        
        <div style={{ fontSize: 16, lineHeight: 1.7, color: G.textPrimary, marginBottom: 24, fontWeight: 500 }}>{qs[currentQIdx].q}</div>
        
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {qs[currentQIdx].options.map((opt, j) => {
            const letter = ["A", "B", "C", "D"][j];
            const isSel = answers[currentQIdx] === letter;
            const isCorr = showReveal && letter === correctLetter;
            const isWrong = showReveal && isSel && !isCorr;
            const canClick = !submitted && !(instantReveal && answered);
            
            return (
              <div key={j} onClick={() => canClick && handleAnswer(currentQIdx, letter)}
                style={{
                  padding: "16px 20px", borderRadius: 14, fontSize: 15, fontWeight: isSel || isCorr ? 600 : 500,
                  border: `1px solid ${isCorr ? G.green : isWrong ? G.red : isSel ? G.primary : G.glassBorder}`,
                  background: isCorr ? `${G.green}15` : isWrong ? `${G.red}12` : isSel ? G.primarySoft : (G.isDark ? "rgba(255,255,255,0.03)" : "#F8F9FA"),
                  cursor: canClick ? "pointer" : "default",
                  color: G.textPrimary, transition: "all 0.15s",
                  boxShadow: isSel && !showReveal ? "0px 4px 12px rgba(67, 24, 255, 0.1)" : "none",
                }}>
                {opt}
              </div>
            );
          })}
        </div>

        {showReveal && (
          <div style={{ marginTop: 24, padding: "20px", background: `${G.green}10`, borderRadius: 16, fontSize: 14, color: G.textSecondary, borderLeft: `4px solid ${G.green}`, lineHeight: 1.7 }}>
            <div style={{ fontWeight: 800, color: G.green, marginBottom: 8, fontSize: 13, textTransform: 'uppercase', letterSpacing: '1px' }}>Explanation</div>
            {qs[currentQIdx].explanation}
          </div>
        )}
        </div>
        );
      })()}

      {/* Navigation */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 20 }}>
        <div style={{ display: "flex", gap: 10 }}>
          <button style={{ ...mkGhostBtn(G.textSecondary), padding: "10px 20px" }} onClick={() => navigateQuestion(-1)} disabled={currentQIdx === 0}>← Prev</button>
          <button style={{ ...mkGhostBtn(G.textSecondary), padding: "10px 20px" }} onClick={() => navigateQuestion(1)} disabled={currentQIdx === qs.length - 1}>Next →</button>
        </div>
        
        <div style={{ display: "flex", gap: 12 }}>
          {!submitted && <button style={{ ...mkBtn(G.gradAmber), padding: "12px 28px", fontSize: 14 }} onClick={() => finishTest()}>Finish & Submit</button>}
          <button style={{ ...mkBtn(G.gradPrimary), padding: "12px 28px", fontSize: 14 }} onClick={() => setCurrentTest(null)}>{submitted ? "← Back to Hub" : "Quit Test"}</button>
        </div>
      </div>

      {/* Question Grid */}
      <div style={{ marginTop: 32, display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(36px, 1fr))", gap: 8 }}>
        {qs.map((_, i) => {
          const qAnswered = answers[i] !== undefined;
          const qCorrectLetter = qs[i].answer ? qs[i].answer[0] : null;
          const qIsCorrect = answers[i] === qCorrectLetter;
          const showColor = submitted || (instantReveal && qAnswered);
          return (
          <div key={i} onClick={() => setCurrentQIdx(i)}
            style={{
              width: 36, height: 36, borderRadius: 10, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 700, cursor: "pointer",
              background: i === currentQIdx ? G.primary : (showColor ? (qIsCorrect ? G.green : answers[i] ? G.red : G.glassBorder) : (answers[i] ? G.primarySoft : (G.isDark ? "rgba(255,255,255,0.03)" : "#F1F5F9"))),
              color: i === currentQIdx || (showColor && answers[i]) ? "#FFF" : (answers[i] ? G.primary : G.textSecondary),
              border: i === currentQIdx ? `1px solid ${G.primary}` : `1px solid ${G.glassBorder}`,
              transition: "all 0.15s"
            }}>
            {i + 1}
          </div>
          );
        })}
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────
   FLASHCARDS
───────────────────────────────────────────────────────────── */
function Flashcards({ uploadedText }) {
  const { G, glassCard, mkBtn, mkGhostBtn, mkPill, inp, sel } = useContext(StylesContext);

  const [subject, setSubject] = useState("Pharmacology");
  const [cards, setCards] = useState(null);
  const [idx, setIdx] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [loading, setLoading] = useState(false);
  const [ratings, setRatings] = useLocalStorage("medmentor_flash_ratings", {});

  const generate = async () => {
    setLoading(true); setCards(null); setIdx(0); setFlipped(false); setRatings({});
    const ctx = uploadedText ? `\nAlso use:\n${uploadedText.slice(0, 2000)}` : "";
    try {
      const raw = await claudeOnce(
        `Generate 15 high-yield NEET PG flashcards for ${subject}. ONLY valid JSON array, no markdown.
[{"front":"concise question or term","back":"answer with key facts"}]
Focus on named signs, eponyms, drug facts, one-liners, classifications.${ctx}`,
        `Generate 15 NEET PG flashcards for ${subject}.`
      );
      setCards(JSON.parse(raw.replace(/```json|```/g, "").trim()));
    } catch(err) { alert("Error: " + err.message); }
    finally { setLoading(false); }
  };

  if (!cards && !loading) return (
    <div style={glassCard}>
      <div style={{ fontSize: 20, fontWeight: 800, color: G.textPrimary, marginBottom: 6, display: "flex", alignItems: "center", gap: 12 }}>
        <span style={{ width: 40, height: 40, borderRadius: 12, background: G.gradPrimary, color: "#FFF", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 18 }}>🃏</span>
        Flashcards
      </div>
      <div style={{ fontSize: 13, color: G.textMuted, marginBottom: 24 }}>High-yield one-liners, eponyms, drug facts. Rate each card to master it!</div>
      <div style={{ display: "flex", gap: 16, alignItems: "flex-end", flexWrap: "wrap" }}>
        <div>
          <div style={{ fontSize: 12, color: G.textMuted, marginBottom: 10, textTransform: "uppercase", letterSpacing: "1px", fontWeight: 700 }}>Subject</div>
          <select style={{ ...sel, background: (G.isDark ? "rgba(0,0,0,0.1)" : "#F4F7FE"), border: "1px solid #E2E8F0" }} value={subject} onChange={e => setSubject(e.target.value)}>
            {SUBJECTS.map(s => <option key={s} value={s}>{SUBJECT_DATA[s].icon} {s}</option>)}
          </select>
        </div>
        <button style={{ ...mkBtn(G.gradPrimary), padding: "14px 32px", fontSize: 15 }} onClick={generate}>Generate Cards ✦</button>
      </div>
      {uploadedText && <div style={{ marginTop: 16 }}><span style={mkPill(G.cyan, G.cyanSoft)}>📎 uploaded material will be used</span></div>}
    </div>
  );

  if (loading) return (
    <div style={{ ...glassCard, textAlign: "center", padding: 60 }}>
      <div style={{ fontSize: 48, marginBottom: 16 }}>🃏</div>
      <div style={{ background: G.gradPink, WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent", fontWeight: 700, fontSize: 16 }}>Creating {subject} flashcards…</div>
    </div>
  );

  const cf = cards[idx];
  const mastered = Object.values(ratings).filter(r => r === "easy").length;

  return (
    <div style={glassCard}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span style={mkPill(G.pink, G.pinkSoft)}>{subject}</span>
          <span style={{ fontSize: 12, color: G.textMuted, fontFamily: "monospace" }}>{idx + 1}/{cards.length} · {mastered} mastered</span>
        </div>
        <button style={{ ...mkGhostBtn(G.textMuted), padding: "6px 14px", fontSize: 12 }} onClick={() => setCards(null)}>← Back</button>
      </div>

      {/* Progress */}
      <div style={{ height: 5, background: "rgba(255,255,255,0.06)", borderRadius: 99, marginBottom: 24, overflow: "hidden" }}>
        <div style={{ height: "100%", width: `${((idx + 1) / cards.length) * 100}%`, background: G.gradPink, borderRadius: 99, transition: "width 0.3s ease" }} />
      </div>

      {/* Card */}
      <div onClick={() => setFlipped(!flipped)}
        style={{
          minHeight: 200, borderRadius: 18, display: "flex", alignItems: "center", justifyContent: "center",
          textAlign: "center", padding: 32, cursor: "pointer", marginBottom: 22, transition: "all 0.3s",
          background: flipped ? "linear-gradient(135deg,rgba(16,185,129,0.12),rgba(6,182,212,0.08))" : "linear-gradient(135deg,rgba(139,92,246,0.12),rgba(236,72,153,0.08))",
          border: `1px solid ${flipped ? G.green + "40" : G.violet + "40"}`,
        }}>
        <div>
          <div style={{ fontSize: 10, letterSpacing: "2px", textTransform: "uppercase", fontWeight: 600, marginBottom: 14, color: flipped ? G.green : G.violet }}>
            {flipped ? "ANSWER" : "QUESTION · tap to flip"}
          </div>
          <div style={{ fontSize: 17, lineHeight: 1.7, color: G.textPrimary }}>{flipped ? cf.back : cf.front}</div>
        </div>
      </div>

      {flipped && (
        <div style={{ display: "flex", gap: 10, justifyContent: "center" }}>
          {[["Again", G.gradAmber], ["Hard", "linear-gradient(135deg,#f59e0b,#fbbf24)"], ["Good", G.gradCyan], ["Easy", G.gradGreen]].map(([label, grad]) => (
            <button key={label} style={{ ...mkBtn(grad), padding: "9px 20px" }}
              onClick={() => {
                setRatings(r => ({ ...r, [idx]: label.toLowerCase() }));
                if (idx < cards.length - 1) { setIdx(i => i + 1); setFlipped(false); }
              }}>
              {label}
            </button>
          ))}
        </div>
      )}
      {!flipped && <div style={{ textAlign: "center", fontSize: 12, color: G.textMuted }}>Tap the card to reveal the answer</div>}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────
   SMART NOTES
───────────────────────────────────────────────────────────── */
function SmartNotes({ uploadedText }) {
  const { G, glassCard, mkBtn, mkGhostBtn, mkPill, inp, sel } = useContext(StylesContext);

  const [subject, setSubject] = useState("Pathology");
  const [topic, setTopic] = useState("");
  const [notes, setNotes] = useState("");
  const [loading, setLoading] = useState(false);

  const generate = async () => {
    setLoading(true); setNotes("");
    const ctx = uploadedText ? `\nUse this material:\n${uploadedText.slice(0, 3000)}` : "";
    try {
      await claudeStream(
        `You are a NEET PG notes creator. Create concise exam-ready notes: clear headings, bullet points, named signs, eponyms, one-liners likely to be MCQs, mnemonics. Subject: ${subject}${ctx}`,
        `Create high-yield NEET PG notes for: ${topic || subject}`, null, t => setNotes(t)
      );
    } catch(err) { setNotes("⚠️ Error: " + err.message); }
    finally { setLoading(false); }
  };

  return (
    <div style={glassCard}>
      <div style={{ fontSize: 20, fontWeight: 800, color: G.textPrimary, marginBottom: 6, display: "flex", alignItems: "center", gap: 12 }}>
        <span style={{ width: 40, height: 40, borderRadius: 12, background: G.gradPrimary, color: "#FFF", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 18 }}>📖</span>
        Smart Notes
      </div>
      <div style={{ fontSize: 13, color: G.textMuted, marginBottom: 24 }}>Generate high-yield exam-ready notes on any topic instantly.</div>
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "flex-end", marginBottom: 20 }}>
        <div>
          <div style={{ fontSize: 12, color: G.textMuted, marginBottom: 10, textTransform: "uppercase", letterSpacing: "1px", fontWeight: 700 }}>Subject</div>
          <select style={{ ...sel, background: (G.isDark ? "rgba(0,0,0,0.1)" : "#F4F7FE"), border: "1px solid #E2E8F0" }} value={subject} onChange={e => setSubject(e.target.value)}>
            {SUBJECTS.map(s => <option key={s} value={s}>{SUBJECT_DATA[s].icon} {s}</option>)}
          </select>
        </div>
        <div style={{ flex: 1, minWidth: 200 }}>
          <div style={{ fontSize: 12, color: G.textMuted, marginBottom: 10, textTransform: "uppercase", letterSpacing: "1px", fontWeight: 700 }}>Topic (Optional)</div>
          <select style={{ ...sel, width: "100%", background: (G.isDark ? "rgba(0,0,0,0.1)" : "#F4F7FE"), border: "1px solid #E2E8F0", marginBottom: 8 }} value={topic} onChange={e => setTopic(e.target.value)}>
            <option value="">-- Select or type below --</option>
            {SUBJECT_DATA[subject].sub.map(sub => <option key={sub} value={sub}>{sub}</option>)}
          </select>
          <input style={{...inp, border: "1px solid #E2E8F0", background: (G.isDark ? "rgba(255,255,255,0.06)" : "#FFFFFF") }} value={topic} onChange={e => setTopic(e.target.value)}
            placeholder={`Or type specific topic (e.g. Beta blockers)…`}
            onKeyDown={e => e.key === "Enter" && generate()} />
        </div>
        <button style={{ ...mkBtn(G.gradPrimary), padding: "14px 32px", fontSize: 15 }} onClick={generate} disabled={loading}>
          {loading ? "Generating…" : "Generate ✦"}
        </button>
      </div>
      {uploadedText && <div style={{ marginBottom: 14 }}><span style={mkPill(G.cyan, G.cyanSoft)}>📎 {Math.round(uploadedText.length / 1000)}k chars loaded</span></div>}
      {notes && (
        <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 16, padding: 20, fontSize: 13, lineHeight: 1.85, whiteSpace: "pre-wrap", color: G.textSecondary }}>
          {notes}
        </div>
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────
   UPLOAD HUB  (with Folder Picker)
───────────────────────────────────────────────────────────── */
let pdfJsReady = false;
const ensurePdfJs = () => new Promise(res => {
  if (pdfJsReady || window.pdfjsLib) { pdfJsReady = true; res(); return; }
  const s = document.createElement("script");
  s.src = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
  s.onload = () => { window.pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js"; pdfJsReady = true; res(); };
  document.head.appendChild(s);
});

const extractPdfText = async (file, onProg) => {
  await ensurePdfJs();
  const ab = await file.arrayBuffer();
  const pdf = await window.pdfjsLib.getDocument({ data: ab }).promise;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const tc = await page.getTextContent();
    pages.push(`--- Page ${i} ---\n` + tc.items.map(it => it.str).join(" "));
    onProg && onProg(i, pdf.numPages);
  }
  return { text: pages.join("\n\n"), pages: pdf.numPages };
};

const readTextFile = f => new Promise((res, rej) => {
  const r = new FileReader(); r.onload = e => res({ text: e.target.result, pages: 1 }); r.onerror = rej; r.readAsText(f);
});

const isSupported = f => f.type === "application/pdf" || f.type === "text/plain" || f.name?.endsWith(".md") || f.name?.endsWith(".txt");

function UploadHub({ onUpload }) {
  const { G, glassCard, mkBtn, mkGhostBtn, mkPill, inp, sel } = useContext(StylesContext);

  const [loadedFiles, setLoadedFiles] = useState({});
  const [folderFiles, setFolderFiles] = useState([]);
  const [folderName, setFolderName] = useState("");
  const [processing, setProcessing] = useState({});
  const [drag, setDrag] = useState(false);
  const [pasted, setPasted] = useState("");
  const [mode, setMode] = useState("drop");
  const fileRef = useRef(null);
  const folderSupported = "showDirectoryPicker" in window;
  
  const useBackend = window.localStorage.getItem("medmentor_use_backend") === "true";
  const backendUrl = window.localStorage.getItem("medmentor_backend_url")?.replace(/"/g, '') || "http://127.0.0.1:5000";
  const [backendFiles, setBackendFiles] = useState(null);

  useEffect(() => {
    let active = true;
    if (useBackend) {
      fetch(`${backendUrl}/api/list-files`).then(r => r.json())
        .then(d => { if (active && d.files) setBackendFiles(d); })
        .catch(() => { if (active) setBackendFiles({ error: "Could not connect to backend." }); });
    }
    return () => { active = false; };
  }, [useBackend, backendUrl]);

  useEffect(() => {
    const combined = Object.entries(loadedFiles).map(([n, d]) => `\n\n===== ${n} =====\n${d.text}`).join("");
    onUpload(combined, Object.keys(loadedFiles).length > 0 ? `${Object.keys(loadedFiles).length} file(s)` : "");
  }, [loadedFiles]);

  const processFile = async file => {
    if (!isSupported(file)) return;
    const name = file.name;
    setProcessing(p => ({ ...p, [name]: "Starting…" }));
    try {
      const result = file.type === "application/pdf"
        ? await extractPdfText(file, (cur, tot) => setProcessing(p => ({ ...p, [name]: `Page ${cur}/${tot}` })))
        : await readTextFile(file);
      setLoadedFiles(prev => ({ ...prev, [name]: result }));
    } catch (e) { alert(`Could not read ${name}: ${e.message}`); }
    setProcessing(p => { const n = { ...p }; delete n[name]; return n; });
  };

  const handleFiles = files => Array.from(files).filter(isSupported).forEach(processFile);

  const openFolder = async () => {
    try {
      const dir = await window.showDirectoryPicker({ mode: "read" });
      setFolderName(dir.name);
      const collected = [];
      for await (const entry of dir.values()) {
        if (entry.kind === "file") collected.push(await entry.getFile());
        if (entry.kind === "directory") {
          try { for await (const sub of entry.values()) if (sub.kind === "file") collected.push(await sub.getFile()); } catch {}
        }
      }
      setFolderFiles(collected.filter(isSupported));
      setMode("folder");
    } catch (e) { if (e.name !== "AbortError") alert(e.message); }
  };

  const totalLoaded = Object.keys(loadedFiles).length;
  const totalPages = Object.values(loadedFiles).reduce((a, b) => a + b.pages, 0);
  const totalChars = Object.values(loadedFiles).reduce((a, b) => a + b.text.length, 0);

  return (
    <div>
      {totalLoaded > 0 && (
        <div style={{ ...glassCard, background: `${G.green}0d`, border: `1px solid ${G.green}30`, padding: "14px 20px", marginBottom: 14 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
            <div>
              <span style={{ fontWeight: 700, color: G.green }}>✅ {totalLoaded} file{totalLoaded > 1 ? "s" : ""} loaded</span>
              <span style={{ fontSize: 12, color: G.textMuted, marginLeft: 12 }}>{totalPages} pages · {(totalChars / 1000).toFixed(0)}k chars · AI-ready</span>
            </div>
            <button style={{ ...mkGhostBtn(G.red), padding: "5px 14px", fontSize: 12 }} onClick={() => setLoadedFiles({})}>Clear all</button>
          </div>
          <div style={{ marginTop: 10, display: "flex", flexWrap: "wrap", gap: 6 }}>
            {Object.entries(loadedFiles).map(([name, d]) => (
              <div key={name} style={{ display: "flex", alignItems: "center", gap: 6, background: "rgba(255,255,255,0.05)", border: `1px solid ${G.glassBorder}`, borderRadius: 10, padding: "3px 12px", fontSize: 12 }}>
                <span style={{ color: G.cyan }}>📄</span>
                <span style={{ color: G.textSecondary }}>{name.length > 28 ? name.slice(0, 25) + "…" : name}</span>
                <span style={{ color: G.textMuted }}>({d.pages}p)</span>
                <span onClick={() => setLoadedFiles(p => { const n = { ...p }; delete n[name]; return n; })}
                  style={{ color: G.red, cursor: "pointer", fontWeight: 700, marginLeft: 4 }}>×</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div style={glassCard}>
        <div style={{ fontSize: 18, fontWeight: 700, color: G.textPrimary, marginBottom: 4, display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ width: 34, height: 34, borderRadius: 10, background: G.gradAmber, display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 16 }}>📤</span>
          Upload Hub
        </div>
        <div style={{ fontSize: 12, color: G.textMuted, marginBottom: 20 }}>Load PDFs and notes — extracted in your browser, no server needed.</div>

        {/* Mode buttons */}
        <div style={{ display: "flex", gap: 10, marginBottom: 22, flexWrap: "wrap" }}>
          {[
            { id: "drop", label: "📎 Drop Files" },
            { id: "folder", label: "📁 Open Folder", disabled: !folderSupported, hint: !folderSupported ? "Chrome/Edge only" : "" },
            { id: "paste", label: "📋 Paste Text" },
          ].map(m => (
            <button key={m.id} disabled={m.disabled} title={m.hint}
              onClick={() => m.id === "folder" ? openFolder() : setMode(m.id)}
              style={{
                ...mkBtn(mode === m.id ? G.gradViolet : "linear-gradient(135deg,rgba(255,255,255,0.08),rgba(255,255,255,0.04))"),
                opacity: m.disabled ? 0.4 : 1,
                border: mode === m.id ? "none" : `1px solid ${G.glassBorder}`,
                padding: "10px 20px",
              }}>
              {m.label}
              {m.hint && <span style={{ fontSize: 10, display: "block", opacity: 0.6, marginTop: 2 }}>{m.hint}</span>}
            </button>
          ))}
        </div>

        {/* Drop zone */}
        {mode === "drop" && (
          <div onDragOver={e => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
            onDrop={e => { e.preventDefault(); setDrag(false); handleFiles(e.dataTransfer.files); }}
            onClick={() => fileRef.current.click()}
            style={{
              border: `2px dashed ${drag ? G.violet : "rgba(255,255,255,0.12)"}`,
              borderRadius: 18, padding: "44px 20px", textAlign: "center", cursor: "pointer",
              background: drag ? G.violetSoft : "rgba(255,255,255,0.02)", transition: "all 0.2s",
            }}>
            <div style={{ fontSize: 44, marginBottom: 12 }}>📎</div>
            <div style={{ fontWeight: 600, fontSize: 15, color: G.textPrimary, marginBottom: 6 }}>Drop files or click to select</div>
            <div style={{ fontSize: 12, color: G.textMuted }}>PDF · TXT · MD · multiple files OK</div>
            <div style={{ fontSize: 11, color: G.textMuted, marginTop: 4 }}>PDFs extracted page-by-page in your browser — no page limits</div>
            <input ref={fileRef} type="file" style={{ display: "none" }} accept=".pdf,.txt,.md" multiple onChange={e => handleFiles(e.target.files)} />
          </div>
        )}

        {/* Folder mode */}
        {mode === "folder" && (
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14, flexWrap: "wrap", gap: 8 }}>
              <div>
                <div style={{ fontWeight: 600, color: G.cyan, fontSize: 14 }}>📁 {folderName || "No folder selected"}</div>
                <div style={{ fontSize: 12, color: G.textMuted, marginTop: 2 }}>{folderFiles.length} compatible files found</div>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                {folderFiles.length > 0 && <button style={{ ...mkBtn(G.gradAmber, true), padding: "8px 16px" }} onClick={() => folderFiles.forEach(f => !loadedFiles[f.name] && !processing[f.name] && processFile(f))}>Load All</button>}
                <button style={{ ...mkGhostBtn(G.cyan), padding: "8px 16px", fontSize: 12 }} onClick={openFolder}>Select Folder</button>
              </div>
            </div>
            {folderFiles.length === 0
              ? (
                <div style={{ textAlign: "center", padding: "40px 20px", border: `2px dashed rgba(255,255,255,0.1)`, borderRadius: 18 }}>
                  <div style={{ fontSize: 44, marginBottom: 12 }}>📁</div>
                  <div style={{ fontWeight: 600, color: G.textPrimary, marginBottom: 4 }}>Click "Select Folder" above</div>
                  <div style={{ fontSize: 12, color: G.textMuted }}>Browser will ask permission — works in Chrome and Edge</div>
                </div>
              ) : (
                <div style={{ maxHeight: 360, overflowY: "auto", display: "flex", flexDirection: "column", gap: 8 }}>
                  {folderFiles.map(f => {
                    const loaded = !!loadedFiles[f.name], prog = processing[f.name];
                    return (
                      <div key={f.name} style={{ display: "flex", alignItems: "center", gap: 12, padding: "11px 16px", borderRadius: 14,
                        background: loaded ? `${G.green}0d` : "rgba(255,255,255,0.03)",
                        border: `1px solid ${loaded ? G.green + "35" : G.glassBorder}` }}>
                        <span style={{ fontSize: 20 }}>{f.type === "application/pdf" ? "📄" : "📝"}</span>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 13, fontWeight: 600, color: G.textPrimary, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.name}</div>
                          <div style={{ fontSize: 11, color: G.textMuted }}>{(f.size / 1024).toFixed(0)} KB</div>
                        </div>
                        {loaded
                          ? <span style={{ fontSize: 11, color: G.green, fontWeight: 700 }}>✅ {loadedFiles[f.name].pages}p</span>
                          : prog
                            ? <span style={{ fontSize: 11, color: G.amber, fontFamily: "monospace" }}>{prog}</span>
                            : <button style={{ ...mkBtn(G.gradCyan, true), padding: "6px 14px" }} onClick={() => processFile(f)}>Load →</button>
                        }
                      </div>
                    );
                  })}
                </div>
              )}
          </div>
        )}

        {/* Paste mode */}
        {mode === "paste" && (
          <textarea style={{ ...inp, minHeight: 160, resize: "vertical" }}
            placeholder="Paste notes, textbook excerpts, PYQ content…"
            value={pasted}
            onChange={e => {
              setPasted(e.target.value);
              if (e.target.value.trim()) setLoadedFiles(p => ({ ...p, "Pasted text": { text: e.target.value, pages: 1 } }));
              else setLoadedFiles(p => { const n = { ...p }; delete n["Pasted text"]; return n; });
            }} />
        )}
      </div>

      {Object.keys(processing).length > 0 && (
        <div style={{ ...glassCard, padding: 14 }}>
          <div style={{ fontSize: 12, color: G.amber, fontWeight: 700, marginBottom: 8 }}>⏳ Processing…</div>
          {Object.entries(processing).map(([name, prog]) => (
            <div key={name} style={{ fontSize: 12, color: G.textMuted, marginBottom: 4 }}>📄 {name} — <span style={{ color: G.amber, fontFamily: "monospace" }}>{prog}</span></div>
          ))}
        </div>
      )}
      
      {useBackend && (
        <div style={{ ...glassCard, marginTop: 24, padding: "20px 24px" }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: G.textPrimary, marginBottom: 16, display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ width: 32, height: 32, borderRadius: 10, background: G.gradGreen, display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 16 }}>📚</span>
            My Server Materials
          </div>
          {backendFiles && !backendFiles.error ? (
            <div>
              <div style={{ fontSize: 12, color: G.green, marginBottom: 14 }}>✅ Synced folder: {backendFiles.folder} — {backendFiles.count} files detected</div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 10, maxHeight: 300, overflowY: "auto", paddingRight: 6 }}>
                {backendFiles.files.map(f => (
                  <div key={f.path} style={{ background: "rgba(255,255,255,0.04)", border: `1px solid ${G.glassBorder}`, padding: "10px 14px", borderRadius: 12 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: G.textPrimary, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }} title={f.name}>{f.name}</div>
                    <div style={{ fontSize: 11, color: G.textMuted, marginTop: 4 }}>{f.size_kb} KB</div>
                  </div>
                ))}
              </div>
            </div>
          ) : backendFiles?.error ? (
             <div style={{ fontSize: 13, color: G.red }}>{backendFiles.error}</div>
          ) : (
             <div style={{ fontSize: 13, color: G.textMuted }}>Loading server materials...</div>
          )}
        </div>
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────
   STUDY PLANNER
───────────────────────────────────────────────────────────── */
function StudyPlanner({ scores }) {
  const { G, glassCard, mkBtn, mkGhostBtn, mkPill, inp, sel } = useContext(StylesContext);

  const [plan, setPlan] = useLocalStorage("medmentor_plan", "");
  const [loading, setLoading] = useState(false);
  const [hours, setHours] = useState(6);

  const generate = async () => {
    setLoading(true); setPlan("");
    const weak = Object.entries(scores).filter(([, v]) => v.total > 0 && v.correct / v.total < 0.6).map(([s]) => s);
    const notStarted = SUBJECTS.filter(s => !scores[s]);
    try {
      await claudeStream(
        `You are a NEET PG study planner. Create a realistic week-by-week schedule.
Today: ${new Date().toDateString()}. Exam: Aug 30 2026. Days left: ${getDaysLeft()}. Hours/day: ${hours}.
Weak: ${weak.join(", ") || "none"}. Not started: ${notStarted.join(", ")}.
Format week-by-week with specific daily topics. Be practical.`,
        "Create my NEET PG 2026 study schedule.", null, t => setPlan(t)
      );
    } catch(err) { setPlan("⚠️ Error planning: " + err.message); }
    finally { setLoading(false); }
  };

  return (
    <div style={glassCard}>
      <div style={{ fontSize: 20, fontWeight: 800, color: G.textPrimary, marginBottom: 6, display: "flex", alignItems: "center", gap: 12 }}>
        <span style={{ width: 40, height: 40, borderRadius: 12, background: G.gradPrimary, color: "#FFF", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 18 }}>🗓️</span>
        Study Planner
      </div>
      <div style={{ fontSize: 13, color: G.textMuted, marginBottom: 24 }}>AI-generated schedule based on your analytics and weak areas.</div>

      <div style={{ marginBottom: 24 }}>
        <div style={{ fontSize: 12, color: G.textMuted, marginBottom: 12, textTransform: "uppercase", letterSpacing: "1px", fontWeight: 700 }}>Hours available per day</div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          {[3, 4, 5, 6, 8, 10].map(h => (
            <button key={h} style={h === hours ? { ...mkBtn(G.gradAmber, true), padding: "8px 20px" } : { ...mkGhostBtn(G.textMuted), padding: "8px 20px", fontSize: 14 }}
              onClick={() => setHours(h)}>{h} Hours</button>
          ))}
        </div>
      </div>

      {Object.keys(scores).length > 0 && (
        <div style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 11, color: G.textMuted, marginBottom: 8, textTransform: "uppercase", letterSpacing: "1px" }}>Weak areas (auto-detected)</div>
          {Object.entries(scores).filter(([, v]) => v.total > 0 && v.correct / v.total < 0.6).map(([s]) => <span key={s} style={mkPill(G.red)}>{s}</span>)}
          {!Object.entries(scores).some(([, v]) => v.correct / v.total < 0.6) && <span style={{ fontSize: 12, color: G.textMuted }}>Take mock tests to auto-detect weak areas</span>}
        </div>
      )}

      <button style={{ ...mkBtn(G.gradAmber), padding: "12px 28px", fontSize: 14, marginBottom: 20 }} onClick={generate} disabled={loading}>
        {loading ? "Planning…" : "Generate My Schedule 📅"}
      </button>

      {plan && <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 16, padding: 20, fontSize: 13, lineHeight: 1.85, whiteSpace: "pre-wrap", color: G.textSecondary }}>{plan}</div>}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────
   ANALYTICS
───────────────────────────────────────────────────────────── */
function Analytics({ scores }) {
  const { G, glassCard, mkBtn, mkGhostBtn, mkPill, inp, sel } = useContext(StylesContext);

  const [insight, setInsight] = useState("");
  const [loading, setLoading] = useState(false);

  const getInsight = async () => {
    setLoading(true); setInsight("");
    const summary = Object.entries(scores).map(([s, v]) => `${s}: ${v.correct}/${v.total}`).join(", ");
    try {
      await claudeStream(
        "You are a NEET PG performance analyst. Give specific, actionable, subject-by-subject recommendations.",
        `Performance: ${summary || "no data yet — give general strategy"}. Priorities, time allocation, weak topic strategies.`,
        null, t => setInsight(t)
      );
    } catch(err) { setInsight("⚠️ Error: " + err.message); }
    finally { setLoading(false); }
  };

  const all = SUBJECTS.map(s => ({ name: s, acc: scores[s] ? Math.round(scores[s].correct / scores[s].total * 100) : null, total: scores[s]?.total || 0 }));

  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 12, marginBottom: 18 }}>
        {[
          { label: "Strong (≥70%)", val: all.filter(s => s.acc >= 70).length, grad: G.gradGreen, icon: "💪" },
          { label: "Needs Work", val: all.filter(s => s.acc !== null && s.acc < 70).length, grad: G.gradAmber, icon: "⚠️" },
          { label: "Not Started", val: all.filter(s => s.acc === null).length, grad: G.gradPink, icon: "📋" },
        ].map(s => <StatCard key={s.label} {...s} value={s.val} />)}
      </div>

      <div style={glassCard}>
        <div style={{ fontSize: 16, fontWeight: 700, color: G.textPrimary, marginBottom: 18, display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ width: 32, height: 32, borderRadius: 10, background: G.gradViolet, display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 15 }}>📊</span>
          All 19 Subjects
        </div>
        {all.map(s => (
          <div key={s.name} style={{ marginBottom: 12, paddingBottom: 12, borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 5 }}>
              <span style={{ color: G.textSecondary }}>{s.name}</span>
              <span style={{ fontFamily: "monospace", fontSize: 12, color: s.acc === null ? G.textMuted : s.acc >= 70 ? G.green : s.acc >= 50 ? G.amber : G.red }}>
                {s.acc === null ? "—" : `${s.acc}% · ${s.total}Q`}
              </span>
            </div>
            <div style={{ height: 5, background: "rgba(255,255,255,0.05)", borderRadius: 99 }}>
              <div style={{ height: "100%", width: `${s.acc || 0}%`, background: s.acc >= 70 ? G.gradGreen : s.acc >= 50 ? G.gradAmber : s.acc > 0 ? "linear-gradient(90deg,#ef4444,#f97316)" : "transparent", borderRadius: 99, transition: "width 0.5s" }} />
            </div>
          </div>
        ))}
        {!Object.keys(scores).length && <div style={{ fontSize: 13, color: G.textMuted }}>Take mock tests to populate your analytics.</div>}
      </div>

      <div style={glassCard}>
        <div style={{ fontSize: 16, fontWeight: 700, color: G.textPrimary, marginBottom: 14, display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ width: 32, height: 32, borderRadius: 10, background: G.gradViolet, display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 15 }}>🤖</span>
          AI Recommendations
        </div>
        <button style={{ ...mkBtn(G.gradViolet), padding: "11px 24px", marginBottom: 16 }} onClick={getInsight} disabled={loading}>
          {loading ? "Analysing…" : "Get Personalised Advice ✦"}
        </button>
        {insight && <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 16, padding: 20, fontSize: 13, lineHeight: 1.85, whiteSpace: "pre-wrap", color: G.textSecondary }}>{insight}</div>}
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────
   ROOT APP
───────────────────────────────────────────────────────────── */
function Settings() {
  const { G, glassCard, mkBtn, mkGhostBtn, mkPill, inp, sel } = useContext(StylesContext);

  const [apiKey, setApiKey] = useLocalStorage("medmentor_gemini_key", "");
  const [useBackend, setUseBackend] = useLocalStorage("medmentor_use_backend", false);
  const [backendUrl, setBackendUrl] = useLocalStorage("medmentor_backend_url", "http://127.0.0.1:5000");
  const [backendFolder, setBackendFolder] = useLocalStorage("medmentor_backend_folder", "");
  const [folderStatus, setFolderStatus] = useState("");

  const syncFolder = async (folder) => {
    const target = folder || backendFolder;
    if (!target?.trim()) { setFolderStatus("❌ Please enter a folder path first."); return; }
    setFolderStatus("Syncing...");
    try {
      const r = await fetch(`${backendUrl}/api/set-folder`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ folder: target })
      });
      const d = await r.json();
      if (d.ok) setFolderStatus(`✅ Synced: ${d.folder}`);
      else setFolderStatus(`❌ Error: ${d.error}`);
    } catch(e) { setFolderStatus(`❌ Connection error: ${e.message}`); }
  };

  // Auto-sync saved folder to backend on mount (restores path after restart)
  useEffect(() => {
    if (useBackend && backendFolder?.trim()) {
      fetch(`${backendUrl}/api/status`)
        .then(r => r.json())
        .then(d => {
          // Only push if backend doesn't already have the right folder
          if (d.ok && d.study_folder !== backendFolder) {
            syncFolder(backendFolder);
          } else if (d.ok && d.study_folder === backendFolder) {
            setFolderStatus(`✅ Active: ${d.study_folder}`);
          }
        })
        .catch(() => {}); // silently ignore if backend not running
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [useBackend, backendUrl]);

  return (
    <div style={glassCard}>
      <div style={{ fontSize: 18, fontWeight: 700, color: G.textPrimary, marginBottom: 20 }}>⚙️ Settings</div>
      
      <div style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 12, color: G.textMuted, marginBottom: 8, textTransform: "uppercase" }}>Gemini API Key</div>
        <div style={{ display: "flex", gap: 10 }}>
          <input style={{...inp, flex: 1}} type="password" value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder="AIzaSy..." />
          {useBackend && <button style={{ ...mkBtn(G.gradCyan), padding: "0 22px" }} onClick={async () => {
             try { await fetch(`${backendUrl}/api/set-key`, { method: "POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({key: apiKey}) }); alert("Synced key to server!"); } catch(e) { alert("Failed to connect to server."); }
          }}>Sync to Server</button>}
        </div>
        <div style={{ fontSize: 11, color: G.textMuted, marginTop: 4 }}>Required for AI features. Click "Sync to Server" if using Python backend.</div>
      </div>

      <div style={{ marginBottom: 20, borderTop: `1px solid ${G.glassBorder}`, paddingTop: 20 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: G.textPrimary, marginBottom: 12 }}>Advanced: Python Backend</div>
        <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 13, marginBottom: 12 }}>
          <input type="checkbox" checked={useBackend} onChange={e => setUseBackend(e.target.checked)} />
          Use Python Backend (bypasses browser memory limits, parses full folders system-wide)
        </label>
        
        {useBackend && (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div>
              <div style={{ fontSize: 11, color: G.textMuted, marginBottom: 6 }}>Backend URL</div>
              <input style={inp} value={backendUrl} onChange={e => setBackendUrl(e.target.value)} placeholder="http://127.0.0.1:5000" />
            </div>
            <div>
              <div style={{ fontSize: 11, color: G.textMuted, marginBottom: 6 }}>Study Folder Path (persists across restarts)</div>
              <div style={{ display: "flex", gap: 10 }}>
                <input
                  style={{...inp, flex: 1}}
                  value={backendFolder}
                  onChange={e => setBackendFolder(e.target.value)}
                  placeholder="e.g. D:\NEET MATERIAL  or  C:\Users\Olympian\Documents"
                />
                <button style={{ ...mkBtn(G.gradCyan), padding: "0 22px" }} onClick={() => syncFolder()}>Sync Folder</button>
              </div>
              {folderStatus && <div style={{ fontSize: 12, marginTop: 6, color: folderStatus.includes("✅") ? G.green : G.red }}>{folderStatus}</div>}
              <div style={{ fontSize: 11, color: G.textMuted, marginTop: 6 }}>Your path is saved in the browser and automatically pushed to the server on every launch.</div>
            </div>
            <div style={{ fontSize: 12, color: G.green, background: `${G.green}15`, padding: "10px 14px", borderRadius: 10, borderLeft: `3px solid ${G.green}` }}>
               ✅ Backend integrated — folder path persists across all restarts.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────
   NEET PG 2026 INTERACTIVE SCHEDULE
───────────────────────────────────────────────────────────── */
function NeetSchedule() {
  const { G } = useContext(StylesContext);
  // Optional: pass theme to iframe via query param or postMessage if needed, 
  // but the HTML has its own theme toggle for now.
  useEffect(() => {
    // try to sync theme with iframe
    const syncTheme = () => {
      const iframe = document.getElementById('tracker-iframe');
      if (iframe && iframe.contentWindow) {
        try {
          const doc = iframe.contentWindow.document;
          const currentTheme = doc.documentElement.getAttribute('data-theme');
          if (currentTheme !== (G.isDark ? 'dark' : 'light')) {
            iframe.contentWindow.toggleTheme && iframe.contentWindow.toggleTheme();
          }
        } catch(e) {} // cross-origin/loading ignore
      }
    };
    const t = setTimeout(syncTheme, 500);
    return () => clearTimeout(t);
  }, [G.isDark]);

  return (
    <div style={{ background: G.surface, borderRadius: 16, overflow: 'hidden', border: `1px solid ${G.glassBorder}`, boxShadow: G.glassShadow }}>
      <iframe id="tracker-iframe" src={`/mastery-tracker.html?theme=${G.isDark ? 'dark' : 'light'}`} style={{ width: '100%', height: 'calc(100vh - 160px)', border: 'none', display: 'block' }} title="Mastery Tracker" />
    </div>
  );
}

const DEFAULT_TABS = [
  { id: "dash",     label: "🏠", full: "Dashboard" },
  { id: "mock",     label: "📝", full: "Mock Test" },
  { id: "flash",    label: "🃏", full: "Flashcards" },
  { id: "schedule", label: "📅", full: "Schedule" },
  { id: "upload",   label: "📤", full: "Upload" },
  { id: "settings", label: "⚙️", full: "Settings" },
];

export default function App() {
  const [theme, setTheme] = useLocalStorage("medmentor_theme", "light");
  const styles = getStyles(theme);
  const { G } = styles;

  const [tab, setTab]                   = useLocalStorage("medmentor_tab", "dash");
  const [tabOrder, setTabOrder]         = useLocalStorage("medmentor_tab_order", DEFAULT_TABS.map(t => t.id));
  // Initialize scores with Medicine at 0 so it doesn't show as "not started"
  const [scores, setScores]             = useLocalStorage("medmentor_scores", { "Medicine": { correct: 0, total: 0 } });
  const [uploadedText, setUploadedText] = useState("");
  const [uploadedName, setUploadedName] = useState("");
  const days = getDaysLeft();

  // Sidebar drag state
  const [dragIdx, setDragIdx] = useState(null);
  const [dragOverIdx, setDragOverIdx] = useState(null);

  // Ensure tabOrder has all tabs (handles new tabs being added)
  const orderedTabs = tabOrder
    .map(id => DEFAULT_TABS.find(t => t.id === id))
    .filter(Boolean)
    .concat(DEFAULT_TABS.filter(t => !tabOrder.includes(t.id)));

  const addScore = (subject, correct, total) =>
    setScores(prev => ({ ...prev, [subject]: { correct: (prev[subject]?.correct || 0) + correct, total: (prev[subject]?.total || 0) + total } }));

  const handleUpload = (text, name) => { setUploadedText(text); setUploadedName(name); };

  const activeTab = DEFAULT_TABS.find(t => t.id === tab);

  const handleDragStart = (idx) => { setDragIdx(idx); };
  const handleDragOver = (e, idx) => { e.preventDefault(); setDragOverIdx(idx); };
  const handleDragEnd = () => { setDragIdx(null); setDragOverIdx(null); };
  const handleDrop = (idx) => {
    if (dragIdx === null || dragIdx === idx) return;
    const newOrder = [...orderedTabs.map(t => t.id)];
    const [moved] = newOrder.splice(dragIdx, 1);
    newOrder.splice(idx, 0, moved);
    setTabOrder(newOrder);
    setDragIdx(null);
    setDragOverIdx(null);
  };

  return (
    <StylesContext.Provider value={styles}>
    <div style={{ fontFamily: "'Inter', 'Segoe UI', system-ui, sans-serif", background: G.pageBg, minHeight: "100vh", color: G.textPrimary, position: "relative" }}>
      <Blobs />

      {/* Sidebar */}
      <div style={{
        position: "fixed", left: 0, top: 0, bottom: 0, width: 280,
        background: G.surface,
        borderRight: "1px solid #E2E8F0",
        display: "flex", flexDirection: "column",
        zIndex: 100, padding: "0 0 24px",
        boxShadow: "10px 0px 40px rgba(112, 144, 176, 0.05)",
      }}>
        {/* Logo */}
        <div style={{ padding: "32px 30px 24px", borderBottom: "1px solid #F4F7FE" }}>
          <div style={{ fontWeight: 800, fontSize: 28, background: G.gradPrimary, WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent", letterSpacing: "-0.5px" }}>
            ⚕ MedMentor
          </div>
          <div style={{ fontSize: 13, color: G.textMuted, marginTop: 6, fontWeight: 600 }}>NEET PG 2026 Companion</div>
        </div>

        {/* Nav items — draggable */}
        <div style={{ flex: 1, padding: "24px 20px", display: "flex", flexDirection: "column", gap: 8, overflowY: "auto" }}>
          {orderedTabs.map((t, idx) => {
            const active = tab === t.id;
            const isDragging = dragIdx === idx;
            const isDragOver = dragOverIdx === idx && dragIdx !== idx;
            return (
              <button key={t.id}
                draggable
                onDragStart={() => handleDragStart(idx)}
                onDragOver={(e) => handleDragOver(e, idx)}
                onDragEnd={handleDragEnd}
                onDrop={() => handleDrop(idx)}
                onClick={() => setTab(t.id)}
                style={{
                display: "flex", alignItems: "center", gap: 16,
                padding: "16px 20px", borderRadius: 16, border: "none",
                background: active ? G.primary : "transparent",
                color: active ? "#FFFFFF" : G.textSecondary,
                cursor: "grab", fontFamily: "inherit", fontSize: 15,
                fontWeight: active ? 700 : 600,
                transition: "all 0.2s", textAlign: "left", width: "100%",
                boxShadow: active ? "0px 8px 18px rgba(67, 24, 255, 0.25)" : "none",
                opacity: isDragging ? 0.4 : 1,
                borderTop: isDragOver ? `2px solid ${G.primary}` : "none",
              }}>
                <span style={{ fontSize: 14, opacity: 0.3, cursor: "grab", userSelect: "none", marginRight: -8 }}>⠿</span>
                <span style={{ fontSize: 20, opacity: active ? 1 : 0.6 }}>{t.label}</span>
                {t.full}
              </button>
            );
          })}
        </div>

        {/* Bottom info */}
        
        <button onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')} style={{ 
          margin: "0 20px 20px", padding: "12px", borderRadius: 16, border: `1px solid ${G.glassBorder}`,
          background: G.surface, color: G.textPrimary, cursor: "pointer", fontWeight: 700, display: "flex", alignItems: "center", gap: 10,
          boxShadow: G.glassShadow
        }}>
          {theme === 'light' ? '🌙 Dark Mode' : '☀️ Light Mode'}
        </button>
        <div style={{ padding: "20px", margin: "0 20px", background: (G.isDark ? "rgba(0,0,0,0.1)" : "#F4F7FE"), borderRadius: 20, border: `1px solid #E2E8F0` }}>
          <div style={{ fontSize: 11, color: G.textMuted, marginBottom: 6, textTransform: "uppercase", letterSpacing: "1px", fontWeight: 700 }}>Exam countdown</div>
          <div style={{ fontSize: 34, fontWeight: 800, color: G.primary, fontFamily: "monospace" }}>{days}</div>
          <div style={{ fontSize: 12, color: G.textSecondary, fontWeight: 600 }}>days remaining</div>
          <div style={{ height: 6, background: G.glassBorder, borderRadius: 99, marginTop: 14, overflow: "hidden" }}>
            <div style={{ height: "100%", width: `${Math.min(100, Math.round(((166 - days) / 166) * 100))}%`, background: G.gradPrimary, borderRadius: 99 }} />
          </div>
          {uploadedName && <div style={{ fontSize: 12, color: G.green, marginTop: 12, fontWeight: 700, wordBreak: "break-all" }}>📎 {uploadedName}</div>}
        </div>
      </div>

      {/* Main content */}
      <div style={{ marginLeft: 280, padding: "40px", position: "relative", zIndex: 1, minHeight: "100vh", display: "flex", flexDirection: "column" }}>
        {/* Page header */}
        <div style={{ marginBottom: 32 }}>
          <div style={{ fontSize: 34, fontWeight: 800, color: G.textPrimary, letterSpacing: "-0.5px" }}>{activeTab?.label} {activeTab?.full}</div>
          <div style={{ fontSize: 14, color: G.textMuted, marginTop: 8, fontWeight: 500 }}>NEET PG 2026 · August 30, 2026</div>
        </div>

        {tab === "dash"     && <Dashboard scores={scores} />}
        {tab === "mock"     && <MockTest onScore={addScore} />}
        {tab === "flash"    && <Flashcards uploadedText={uploadedText} />}
        {tab === "schedule" && <NeetSchedule />}
        {tab === "upload"   && <UploadHub onUpload={handleUpload} />}
        {tab === "settings" && <Settings />}
      </div>
    </div>
    </StylesContext.Provider>
  );
}
