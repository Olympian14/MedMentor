import fs from 'fs';
let code = fs.readFileSync('C:/Users/Olympian/.gemini/antigravity/scratch/medmentor-app/src/App.jsx', 'utf8');

if (!code.includes('createContext')) {
  code = code.replace('from "react";', ', createContext, useContext } from "react";');
}

const newTokens = `/* ─────────────────────────────────────────────────────────────
   Theming & Styles Context
───────────────────────────────────────────────────────────── */
export const StylesContext = createContext();

function getStyles(theme) {
  const isDark = theme === "dark";
  const G = {
    isDark,
    pageBg: isDark ? "#080c16" : "#F4F7FE",
    surface: isDark ? "rgba(20, 24, 42, 0.55)" : "rgba(255, 255, 255, 0.65)",
    surfaceHover: isDark ? "rgba(28, 34, 58, 0.8)" : "rgba(255, 255, 255, 0.85)",
    glassBorder: isDark ? "rgba(255,255,255,0.08)" : "rgba(255,255,255,0.4)",
    glassShadow: isDark ? "0 8px 32px 0 rgba(0,0,0,0.4)" : "0 8px 32px 0 rgba(31,38,135,0.05)",

    primary: isDark ? "#8B5CF6" : "#4318FF",
    primarySoft: isDark ? "rgba(139, 92, 246, 0.15)" : "rgba(67, 24, 255, 0.1)",
    violet: isDark ? "#A78BFA" : "#7551FF",
    violetSoft: isDark ? "rgba(167, 139, 250, 0.15)" : "rgba(117, 81, 255, 0.1)",
    cyan: isDark ? "#22D3EE" : "#00E396",
    cyanSoft: isDark ? "rgba(34, 211, 238, 0.15)" : "rgba(0, 227, 150, 0.1)",
    green: isDark ? "#34D399" : "#05CD99",
    greenSoft: isDark ? "rgba(52, 211, 153, 0.15)" : "rgba(5, 205, 153, 0.1)",
    amber: isDark ? "#FBBF24" : "#FFCE20",
    amberSoft: isDark ? "rgba(251, 191, 36, 0.15)" : "rgba(255, 206, 32, 0.15)",
    red: isDark ? "#F87171" : "#EE5D50",
    pink: isDark ? "#F472B6" : "#FF5E8E",

    textPrimary: isDark ? "#FFFFFF" : "#2B3674",
    textSecondary: isDark ? "#A0AEC0" : "#4A5568",
    textMuted: isDark ? "#64748B" : "#A3AED0",

    gradPrimary: isDark ? "linear-gradient(135deg, #7C3AED, #4F46E5)" : "linear-gradient(135deg, #868CFF, #4318FF)",
    gradViolet: isDark ? "linear-gradient(135deg, #8B5CF6, #6D28D9)" : "linear-gradient(135deg, #8A73FF, #7551FF)",
    gradPink: isDark ? "linear-gradient(135deg, #EC4899, #8B5CF6)" : "linear-gradient(135deg, #FF94B4, #FF5E8E)",
    gradCyan: isDark ? "linear-gradient(135deg, #06B6D4, #3B82F6)" : "linear-gradient(135deg, #33EABD, #00E396)",
    gradGreen: isDark ? "linear-gradient(135deg, #10B981, #06B6D4)" : "linear-gradient(135deg, #30E0A1, #05CD99)",
    gradAmber: isDark ? "linear-gradient(135deg, #F59E0B, #EF4444)" : "linear-gradient(135deg, #FFDE59, #FFCE20)",
  };

  const glassCard = {
    background: G.surface,
    backdropFilter: "blur(24px) saturate(150%)",
    WebkitBackdropFilter: "blur(24px) saturate(150%)",
    border: \`1px solid \${G.glassBorder}\`,
    borderRadius: 24,
    boxShadow: G.glassShadow,
    padding: 24, marginBottom: 20, position: "relative", overflow: "hidden",
  };

  const mkBtn = (grad = G.gradPrimary, sm = false) => ({
    background: grad, border: "none", borderRadius: sm ? 10 : 14,
    padding: sm ? "8px 16px" : "12px 24px", fontSize: sm ? 13 : 15,
    fontWeight: 700, color: "#fff", cursor: "pointer", fontFamily: "inherit",
    boxShadow: isDark ? "none" : "0px 6px 14px rgba(67, 24, 255, 0.15)",
    transition: "transform 0.15s, box-shadow 0.15s",
  });

  const mkGhostBtn = (color = G.primary) => ({
    background: \`\${color}10\`, border: \`1px solid \${color}30\`, borderRadius: 12,
    padding: "8px 18px", fontSize: 13, fontWeight: 600, color, cursor: "pointer", fontFamily: "inherit"
  });

  const mkPill = (color, bg) => ({
    display: "inline-block", padding: "4px 14px", borderRadius: 99, fontSize: 12, fontWeight: 700,
    background: bg || \`\${color}15\`, color, marginRight: 6, marginBottom: 4,
  });

  const inp = {
    background: isDark ? "rgba(0,0,0,0.2)" : "#FFFFFF",
    border: \`1px solid \${isDark ? "rgba(255,255,255,0.1)" : "#E2E8F0"}\`,
    borderRadius: 14, padding: "12px 18px", color: G.textPrimary,
    fontSize: 14, fontWeight: 500, fontFamily: "inherit", outline: "none", width: "100%", boxSizing: "border-box",
  };

  const sel = { ...inp, cursor: "pointer", width: "auto", minWidth: 170, paddingRight: 32 };

  return { G, glassCard, mkBtn, mkGhostBtn, mkPill, inp, sel };
}`;

// Strip out existing G to sel
const rgx = /\/\* ───+\s+Design tokens[a-zA-Z0-9\s—\-().,{}:;"'=]+?\n\/\* ───/ms;
code = code.replace(rgx, newTokens + "\n\n/* ───");

// Fix hardcoded color strings BEFORE applying React Context so I don't break JS code structurally
code = code.replace(/"#FFFFFF"/g, '(G.isDark ? "rgba(255,255,255,0.06)" : "#FFFFFF")');
code = code.replace(/"#F4F7FE"/g, '(G.isDark ? "rgba(0,0,0,0.1)" : "#F4F7FE")');
code = code.replace(/"#F8F9FA"/g, '(G.isDark ? "rgba(255,255,255,0.03)" : "#F8F9FA")');
code = code.replace(/"#E2E8F0"/g, 'G.glassBorder');
code = code.replace(/rgba\(255,255,255,0\.8\)/g, '(G.isDark ? "rgba(255,255,255,0.6)" : "rgba(255,255,255,0.8)")');

// Inject useContext loop into every component
const components = ["Blobs", "StatCard", "Dashboard", "AiChat", "MockTest", "Flashcards", "SmartNotes", "UploadHub", "StudyPlanner", "Analytics", "Settings"];

for (const c of components) {
  const compRegex = new RegExp(`function \\s*${c}\\s*\\([^)]*\\)\\s*\\{`, 'g');
  code = code.replace(compRegex, match => `${match}\n  const { G, glassCard, mkBtn, mkGhostBtn, mkPill, inp, sel } = useContext(StylesContext);\n`);
}

// Inject it into App too and wrap the UI in ThemeContext.Provider
const appRegex = /export default function App\(\) \{/;
code = code.replace(appRegex, `export default function App() {\n  const [theme, setTheme] = useLocalStorage("medmentor_theme", "light");\n  const styles = getStyles(theme);\n  const { G } = styles;\n`);

const returnRegex = /return \(\n\s*<div style={{/m;
code = code.replace(returnRegex, `return (\n    <StylesContext.Provider value={styles}>\n    <div style={{`);

// Close the provider at the very end
code = code.replace(/(\n\s*)<\/div>\n  \);\n}/, `$1</div>\n    </StylesContext.Provider>\n  );\n}`);

// AiChat height rework
const aiChatRegex = /height: "calc\\(100vh - 160px\\)"/g;
code = code.replace(aiChatRegex, `height: "calc(100vh - 80px)", marginTop: "-20px"`);

// Append a theme toggle button in Sidebar
const sidebarInfoRegex = /<div style={{ padding: "20px", margin: "0 20px", background/m;
code = code.replace(sidebarInfoRegex, `
        <button onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')} style={{ 
          margin: "0 20px 20px", padding: "12px", borderRadius: 16, border: \`1px solid \${G.glassBorder}\`,
          background: G.surface, color: G.textPrimary, cursor: "pointer", fontWeight: 700, display: "flex", alignItems: "center", gap: 10,
          boxShadow: G.glassShadow
        }}>
          {theme === 'light' ? '🌙 Dark Mode' : '☀️ Light Mode'}
        </button>
        <div style={{ padding: "20px", margin: "0 20px", background`);

// Sidebar colors
const sbBgRegex = /background: \(G\.isDark \? "rgba\(255,255,255,0\.06\)" : "#FFFFFF"\),\s*borderRight:/g;
code = code.replace(sbBgRegex, 'background: G.surface,\n        borderRight:');

// Also remove maxWidth from App.jsx main content so it utilizes WHOLE page
const maxWidthRegex = /, display: "flex", flexDirection: "column", maxWidth: 1600/g;
code = code.replace(maxWidthRegex, ', display: "flex", flexDirection: "column"');

// Fix an edge case where #FFFFFF replacement broke the color values that are expected to literally be #FFFFFF text color manually
code = code.replace(/color: \(G\.isDark \? "rgba\(255,255,255,0\.06\)" : "#FFFFFF"\)/g, 'color: "#FFFFFF"');

fs.writeFileSync('C:/Users/Olympian/.gemini/antigravity/scratch/medmentor-app/src/App.jsx', code);
