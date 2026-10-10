const fs = require('node:fs');
const path = require('node:path');

const outputDirectory = path.join(__dirname, 'netlify-dist');
fs.rmSync(outputDirectory, { recursive: true, force: true });
fs.mkdirSync(outputDirectory, { recursive: true });

for (const [source, destination] of [
  ['BBFIndex.html', 'index.html'],
  ['BBFDesign.css', 'BBFDesign.css'],
  ['BBFfunc.js', 'BBFfunc.js']
]) {
  fs.copyFileSync(path.join(__dirname, source), path.join(outputDirectory, destination));
}

console.log(`Prepared Netlify static site in ${outputDirectory}`);
