# -*- coding: utf-8 -*-
"""
MedMentor Local Server
======================
Runs on your computer. Reads PDFs directly from any folder — no page limits,
no upload limits. Extracts text locally, sends only text to Claude API.

SETUP (one time):
  pip install flask flask-cors pypdf2 anthropic

RUN:
  python medmentor_server.py

Then open http://localhost:5000 in your browser.
"""

import os
import json
import glob
import traceback
from pathlib import Path

# ── PERSISTENT CONFIG ────────────────────────────────────────────────────────
CONFIG_FILE = Path(__file__).parent / "medmentor_config.json"

def load_config():
    try:
        if CONFIG_FILE.exists():
            return json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
    except Exception:
        pass
    return {}

def save_config(data):
    try:
        existing = load_config()
        existing.update(data)
        CONFIG_FILE.write_text(json.dumps(existing, indent=2), encoding="utf-8")
    except Exception as e:
        print(f"[WARN] Could not save config: {e}")
from flask import Flask, request, jsonify, Response, send_from_directory
from flask_cors import CORS

try:
    import PyPDF2
    PDF_SUPPORT = True
except ImportError:
    try:
        import pypdf as PyPDF2
        PDF_SUPPORT = True
    except ImportError:
        PDF_SUPPORT = False
        print("[WARN] PDF support unavailable. Run: pip install pypdf2")

try:
    import anthropic
    ANTHROPIC_AVAILABLE = True
except ImportError:
    ANTHROPIC_AVAILABLE = False
    print("[WARN] Anthropic SDK unavailable. Run: pip install anthropic")

app = Flask(__name__, static_folder="medmentor_ui")
CORS(app)

# ── CONFIG ────────────────────────────────────────────────────────────────────
API_KEY = os.environ.get("GEMINI_API_KEY", "")   # set via env var or edit here
_cfg = load_config()
# Priority: env var → saved config → empty string (no default path)
STUDY_FOLDER = os.environ.get("MEDMENTOR_FOLDER", _cfg.get("study_folder", ""))

# ── HELPERS ───────────────────────────────────────────────────────────────────

def extract_pdf_text(filepath: str) -> dict:
    """Extract all text from a PDF — no page limit."""
    if not PDF_SUPPORT:
        return {"error": "PyPDF2 not installed", "text": "", "pages": 0}
    try:
        text_parts = []
        with open(filepath, "rb") as f:
            reader = PyPDF2.PdfReader(f)
            total_pages = len(reader.pages)
            for i, page in enumerate(reader.pages):
                try:
                    t = page.extract_text()
                    if t and t.strip():
                        text_parts.append(f"--- Page {i+1} ---\n{t.strip()}")
                except Exception:
                    text_parts.append(f"--- Page {i+1} [unreadable] ---")
        full_text = "\n\n".join(text_parts)
        return {
            "text": full_text,
            "pages": total_pages,
            "chars": len(full_text),
            "error": None
        }
    except Exception as e:
        return {"error": str(e), "text": "", "pages": 0}


def extract_txt_text(filepath: str) -> dict:
    """Read a plain text file."""
    try:
        with open(filepath, "r", encoding="utf-8", errors="ignore") as f:
            text = f.read()
        return {"text": text, "pages": 1, "chars": len(text), "error": None}
    except Exception as e:
        return {"error": str(e), "text": "", "pages": 0}


def get_file_info(filepath: str) -> dict:
    """Return metadata for a single file."""
    p = Path(filepath)
    ext = p.suffix.lower()
    size_kb = round(p.stat().st_size / 1024, 1)
    return {
        "name": p.name,
        "path": str(p),
        "ext": ext,
        "size_kb": size_kb,
        "supported": ext in (".pdf", ".txt", ".md"),
    }

# ── ROUTES ────────────────────────────────────────────────────────────────────

@app.route("/api/status")
def status():
    return jsonify({
        "ok": True,
        "pdf_support": PDF_SUPPORT,
        "anthropic_sdk": ANTHROPIC_AVAILABLE,
        "api_key_set": bool(API_KEY),
        "study_folder": STUDY_FOLDER,
        "folder_exists": os.path.isdir(STUDY_FOLDER),
    })


@app.route("/api/set-folder", methods=["POST"])
def set_folder():
    global STUDY_FOLDER
    data = request.json or {}
    folder = data.get("folder", "").strip()
    if not folder:
        return jsonify({"error": "No folder path provided"}), 400
    if not os.path.isdir(folder):
        return jsonify({"error": f"Folder not found: {folder}"}), 404
    STUDY_FOLDER = folder
    save_config({"study_folder": STUDY_FOLDER})   # persist across restarts
    return jsonify({"ok": True, "folder": STUDY_FOLDER})


@app.route("/api/set-key", methods=["POST"])
def set_key():
    global API_KEY
    data = request.json or {}
    key = data.get("key", "").strip()
    if not key:
        return jsonify({"error": "No API key provided"}), 400
    API_KEY = key
    return jsonify({"ok": True})


@app.route("/api/list-files")
def list_files():
    """List all study files in the configured folder."""
    if not os.path.isdir(STUDY_FOLDER):
        return jsonify({"error": f"Folder not found: {STUDY_FOLDER}", "files": []}), 200
    files = []
    for ext in ("*.pdf", "*.txt", "*.md"):
        for fp in glob.glob(os.path.join(STUDY_FOLDER, "**", ext), recursive=True):
            files.append(get_file_info(fp))
    files.sort(key=lambda x: x["name"].lower())
    return jsonify({"files": files, "folder": STUDY_FOLDER, "count": len(files)})


@app.route("/api/read-file", methods=["POST"])
def read_file():
    """Extract text from a file on disk — no page limit."""
    data = request.json or {}
    filepath = data.get("path", "").strip()
    if not filepath:
        return jsonify({"error": "No path provided"}), 400
    if not os.path.isfile(filepath):
        return jsonify({"error": f"File not found: {filepath}"}), 404

    ext = Path(filepath).suffix.lower()
    if ext == ".pdf":
        result = extract_pdf_text(filepath)
    elif ext in (".txt", ".md"):
        result = extract_txt_text(filepath)
    else:
        return jsonify({"error": f"Unsupported file type: {ext}"}), 400

    result["name"] = Path(filepath).name
    result["path"] = filepath
    return jsonify(result)


@app.route("/api/read-folder", methods=["POST"])
def read_folder():
    """Extract text from ALL files in the study folder — returns combined index."""
    data = request.json or {}
    folder = data.get("folder", STUDY_FOLDER)
    if not os.path.isdir(folder):
        return jsonify({"error": f"Folder not found: {folder}"}), 404

    results = []
    for ext in ("*.pdf", "*.txt", "*.md"):
        for fp in glob.glob(os.path.join(folder, "**", ext), recursive=True):
            p = Path(fp)
            if p.suffix.lower() == ".pdf":
                r = extract_pdf_text(fp)
            else:
                r = extract_txt_text(fp)
            results.append({
                "name": p.name,
                "path": fp,
                "pages": r.get("pages", 0),
                "chars": r.get("chars", 0),
                "text": r.get("text", "")[:5000],   # first 5000 chars as preview
                "error": r.get("error"),
            })

    total_chars = sum(r["chars"] for r in results)
    return jsonify({
        "files": results,
        "count": len(results),
        "total_chars": total_chars,
        "folder": folder,
    })


@app.route("/api/chat", methods=["POST"])
def chat():
    """Stream a response from Gemini with local file context."""
    if not API_KEY:
        return jsonify({"error": "API key not set. POST to /api/set-key first."}), 400

    data = request.json or {}
    messages = data.get("messages", [])
    system = data.get("system", "You are an expert NEET PG tutor.")
    file_context = data.get("file_context", "")

    if file_context:
        system += f"\n\nStudy material from local files:\n{file_context[:8000]}"

    contents = []
    if system:
        contents.append({"role": "user", "parts": [{"text": f"System instructions: {system}"}]})
        contents.append({"role": "model", "parts": [{"text": "Understood."}]})
        
    for m in messages:
        contents.append({
            "role": "model" if m.get("role") == "assistant" else "user",
            "parts": [{"text": m.get("content", " ")}]
        })

    import urllib.request, json
    payload = json.dumps({"contents": contents}).encode()
    req = urllib.request.Request(
        f"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse&key={API_KEY}",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST"
    )

    def generate():
        try:
            with urllib.request.urlopen(req) as resp:
                for line in resp:
                    line_str = line.decode("utf-8").strip()
                    if line_str.startswith("data:"):
                        try:
                            d = json.loads(line_str.replace("data: ", "", 1))
                            txt = d.get("candidates", [{}])[0].get("content", {}).get("parts", [{}])[0].get("text", "")
                            if txt:
                                yield f"data: {json.dumps({'text': txt})}\n\n"
                        except:
                            pass
        except Exception as e:
            yield f"data: {json.dumps({'error': str(e)})}\n\n"

    return Response(generate(), mimetype="text/event-stream")


@app.route("/api/generate-mcq", methods=["POST"])
def generate_mcq():
    """Generate MCQs using Gemini REST API."""
    if not API_KEY:
        return jsonify({"error": "API key not set"}), 400

    data = request.json or {}
    subject = data.get("subject", "Medicine")
    num_q = data.get("num_q", 10)
    file_text = data.get("file_text", "")

    context = f"\n\nUse this study material as source:\n{file_text[:6000]}" if file_text else ""
    sys_prompt = f"Generate exactly {num_q} NEET PG-style MCQs on {subject}. Return ONLY valid JSON array. Format: [{{\"q\":\"question\",\"options\":[\"A. ...\",\"B. ...\",\"C. ...\",\"D. ...\"],\"answer\":\"A\",\"explanation\":\"brief\"}}]{context}"

    contents = [
        {"role": "user", "parts": [{"text": sys_prompt}]},
        {"role": "model", "parts": [{"text": "Understood."}]},
        {"role": "user", "parts": [{"text": f"Generate {num_q} NEET PG MCQs on {subject}."}]}
    ]

    import urllib.request, json
    payload = json.dumps({
        "contents": contents,
        "generationConfig": {"responseMimeType": "application/json"}
    }).encode()

    req = urllib.request.Request(
        f"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key={API_KEY}",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST"
    )
    try:
        with urllib.request.urlopen(req) as resp:
            result = json.loads(resp.read())
            text = result["candidates"][0]["content"]["parts"][0]["text"]
            text_clean = text.replace("```json", "").replace("```", "").strip()
            questions = json.loads(text_clean)
            return jsonify({"questions": questions})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ── SERVE UI (optional static build) ─────────────────────────────────────────
@app.route("/")
def index():
    return """<!DOCTYPE html>
<html>
<head>
<title>MedMentor Local Server</title>
<meta charset="utf-8">
<style>
  body { font-family: system-ui; background: #0f172a; color: #f1f5f9; padding: 40px; max-width: 700px; margin: 0 auto; }
  h1 { color: #2dd4bf; }
  .card { background: #1e293b; border-radius: 12px; padding: 24px; margin: 16px 0; border: 1px solid rgba(255,255,255,0.07); }
  code { background: #0f172a; padding: 3px 8px; border-radius: 5px; font-size: 13px; color: #38bdf8; }
  .ok { color: #4ade80; } .warn { color: #fbbf24; } .err { color: #f87171; }
  input { background: #0f172a; border: 1px solid rgba(255,255,255,0.15); border-radius: 8px; padding: 10px 14px; color: #f1f5f9; font-size: 14px; width: 100%; box-sizing: border-box; margin-bottom: 10px; }
  button { background: rgba(45,212,191,0.15); border: 1px solid rgba(45,212,191,0.4); color: #2dd4bf; border-radius: 8px; padding: 10px 20px; font-size: 14px; cursor: pointer; }
  #files { font-size: 13px; color: #94a3b8; line-height: 1.8; }
</style>
</head>
<body>
<h1>⚕ MedMentor Local Server</h1>
<p style="color:#94a3b8">Your server is running. Use this page to configure it, or open MedMentor in Claude.</p>

<div class="card">
  <h3 style="margin-top:0">🔑 Anthropic API Key</h3>
  <input id="apikey" type="password" placeholder="sk-ant-..." />
  <button onclick="setKey()">Save Key</button>
  <div id="keyStatus" style="margin-top:8px;font-size:13px"></div>
</div>

<div class="card">
  <h3 style="margin-top:0">📁 Study Folder Path</h3>
  <input id="folder" placeholder="e.g. C:\\Users\\Doctor\\NEET_Study or /home/doctor/neet_study" />
  <button onclick="setFolder()">Set Folder</button>
  <div id="folderStatus" style="margin-top:8px;font-size:13px"></div>
</div>

<div class="card">
  <h3 style="margin-top:0">📄 Files Detected</h3>
  <button onclick="listFiles()">Scan Folder</button>
  <div id="files" style="margin-top:12px"></div>
</div>

<div class="card">
  <h3 style="margin-top:0">🔌 API Endpoints (for MedMentor app)</h3>
  <p style="font-size:13px;color:#94a3b8;margin:0">
    <code>GET  /api/status</code> — server status<br>
    <code>GET  /api/list-files</code> — list all study files<br>
    <code>POST /api/read-file</code> — extract text from one file<br>
    <code>POST /api/read-folder</code> — extract all files<br>
    <code>POST /api/chat</code> — streaming Claude chat<br>
    <code>POST /api/generate-mcq</code> — generate MCQs from file
  </p>
</div>

<script>
async function setKey() {
  const key = document.getElementById('apikey').value.trim();
  const r = await fetch('/api/set-key', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key})});
  const d = await r.json();
  document.getElementById('keyStatus').innerHTML = d.ok ? '<span class="ok">✅ Key saved</span>' : '<span class="err">❌ ' + d.error + '</span>';
}
async function setFolder() {
  const folder = document.getElementById('folder').value.trim();
  const r = await fetch('/api/set-folder', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({folder})});
  const d = await r.json();
  document.getElementById('folderStatus').innerHTML = d.ok ? '<span class="ok">✅ Folder set: ' + d.folder + '</span>' : '<span class="err">❌ ' + d.error + '</span>';
}
async function listFiles() {
  const r = await fetch('/api/list-files');
  const d = await r.json();
  if (d.error) { document.getElementById('files').innerHTML = '<span class="err">' + d.error + '</span>'; return; }
  if (!d.files.length) { document.getElementById('files').innerHTML = '<span class="warn">No PDF/TXT files found in folder.</span>'; return; }
  document.getElementById('files').innerHTML = d.files.map(f =>
    `📄 <b>${f.name}</b> <span style="color:#475569">(${f.size_kb} KB)</span>`
  ).join('<br>');
}
// Load status on open
fetch('/api/status').then(r=>r.json()).then(d=>{
  document.getElementById('folder').placeholder = d.study_folder || 'Enter folder path...';
});
</script>
</body>
</html>"""


if __name__ == "__main__":
    print("\n" + "="*55)
    print("  +  MedMentor Local Server")
    print("="*55)
    print(f"  Study folder : {STUDY_FOLDER or '(not set - use Settings to configure)'}")
    print(f"  Config file  : {CONFIG_FILE}")
    print(f"  PDF support  : {'[OK] Yes' if PDF_SUPPORT else '[X] pip install pypdf2'}")
    print(f"  Anthropic SDK: {'[OK] Yes' if ANTHROPIC_AVAILABLE else '[WARN] pip install anthropic'}")
    print(f"  API key      : {'[OK] Set via env' if API_KEY else '[WARN] Set via browser UI'}")
    print("="*55)
    print("  Open: http://localhost:5000")
    print("="*55 + "\n")
    app.run(host="127.0.0.1", port=5000, debug=False)
