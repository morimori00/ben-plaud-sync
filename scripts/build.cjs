'use strict';
// Dependency-free deterministic CommonJS bundler; no downloaded build code.
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const names = ['scope.cjs', 'core.cjs', 'transport.cjs', 'api.cjs', 'diagnostic.cjs', 'main.cjs'];
let result = '/* Ben Plaud Sync 0.1.4; MIT; derivative of Leonard Sellem Plaud Sync 1.0.1. See LICENSE. */\n';
result += 'const __nativeRequire = require;\nconst __factories = Object.create(null);\n';
for (const name of names) result += `__factories[${JSON.stringify('./' + name)}] = function(module, exports, require) {\n${fs.readFileSync(path.join(root,'src',name),'utf8')}\n};\n`;
result += `const __cache = Object.create(null);\nfunction __load(name) {\n if (!__factories[name]) return __nativeRequire(name);\n if (__cache[name]) return __cache[name].exports;\n const mod = { exports: {} }; __cache[name] = mod; __factories[name](mod, mod.exports, __load); return mod.exports;\n}\nmodule.exports = __load('./main.cjs');\n`;
fs.writeFileSync(path.join(root,'main.js'), result);
console.log('Built main.js with no external build dependencies');
