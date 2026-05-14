import fs from 'fs';
let code = fs.readFileSync('C:/Users/Olympian/.gemini/antigravity/scratch/medmentor-app/src/App.jsx', 'utf8');

code = code.replace(/"\(G\.isDark \? "([^"]+)" : "([^"]+)"\)"/g, '(G.isDark ? "$1" : "$2")');

fs.writeFileSync('C:/Users/Olympian/.gemini/antigravity/scratch/medmentor-app/src/App.jsx', code);
