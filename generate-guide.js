const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');

const guidePath = path.join(__dirname, 'OPERATIONS_GUIDE.md');
const outputPath = path.join(__dirname, 'Big_Bozz_Fitness_Operations_Guide.pdf');

function parseMarkdown(markdown) {
  const blocks = [];
  const lines = markdown.split(/\r?\n/);
  let paragraph = [];
  let codeLines = [];
  let inCode = false;

  function flushParagraph() {
    if (paragraph.length) {
      blocks.push({ type: 'paragraph', text: paragraph.join(' ').trim() });
      paragraph = [];
    }
  }

  for (const line of lines) {
    if (line.startsWith('```')) {
      flushParagraph();
      if (inCode) {
        blocks.push({ type: 'code', text: codeLines.join('\n') });
        codeLines = [];
      }
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      codeLines.push(line);
      continue;
    }
    if (!line.trim()) {
      flushParagraph();
      continue;
    }
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      blocks.push({ type: `h${heading[1].length}`, text: heading[2].replaceAll('**', '') });
      continue;
    }
    const bullet = line.match(/^\s*-\s+(.+)$/);
    if (bullet) {
      flushParagraph();
      blocks.push({ type: 'bullet', text: bullet[1].replaceAll('**', '') });
      continue;
    }
    const numbered = line.match(/^\s*(\d+)\.\s+(.+)$/);
    if (numbered) {
      flushParagraph();
      blocks.push({ type: 'numbered', number: numbered[1], text: numbered[2].replaceAll('**', '') });
      continue;
    }
    paragraph.push(line.replaceAll('**', '').replaceAll('`', ''));
  }
  flushParagraph();
  return blocks;
}

function drawHeader(doc) {
  doc.save();
  doc.rect(0, 0, doc.page.width, 52).fill('#111318');
  doc.fillColor('#eab308').font('Helvetica-Bold').fontSize(13).text('BIG BOZZ FITNESS GYM', 48, 19);
  doc.fillColor('#b7bbc5').font('Helvetica').fontSize(9).text('ADMIN OPERATIONS GUIDE', 386, 22, { width: 160, align: 'right' });
  doc.restore();
  doc.x = doc.page.margins.left;
  doc.y = Math.max(doc.y, 70);
}

async function main() {
  const markdown = fs.readFileSync(guidePath, 'utf8');
  const blocks = parseMarkdown(markdown);
  const doc = new PDFDocument({
    size: 'LETTER',
    margins: { top: 70, bottom: 58, left: 52, right: 52 },
    bufferPages: true,
    info: {
      Title: 'Big Bozz Fitness Operations Guide',
      Author: 'Big Bozz Fitness Gym',
      Subject: 'Dashboard setup, membership management, payments, and backups'
    }
  });
  const output = fs.createWriteStream(outputPath);
  doc.pipe(output);
  drawHeader(doc);

  function ensureSpace(height) {
    if (doc.y + height > doc.page.height - doc.page.margins.bottom) {
      doc.addPage();
      drawHeader(doc);
    }
  }

  for (const block of blocks) {
    if (block.type === 'h1') {
      const fontSize = 24;
      const height = doc.heightOfString(block.text, { width: 500, font: 'Helvetica-Bold', fontSize }) + 18;
      ensureSpace(height);
      doc.fillColor('#111318').font('Helvetica-Bold').fontSize(fontSize)
        .text(block.text, 52, doc.y, { width: 508, lineGap: 2 });
      doc.moveDown(0.35);
      doc.save().moveTo(52, doc.y).lineTo(560, doc.y).lineWidth(2).strokeColor('#eab308').stroke().restore();
      doc.moveDown(0.8);
      continue;
    }
    if (block.type === 'h2' || block.type === 'h3') {
      const fontSize = block.type === 'h2' ? 15 : 12;
      const height = doc.heightOfString(block.text, { width: 500, font: 'Helvetica-Bold', fontSize }) + 14;
      ensureSpace(height);
      doc.fillColor('#927000').font('Helvetica-Bold').fontSize(fontSize)
        .text(block.text, 52, doc.y, { width: 508 });
      doc.moveDown(0.3);
      continue;
    }
    if (block.type === 'code') {
      const fontSize = 8.5;
      const height = doc.heightOfString(block.text, { width: 470, font: 'Courier', fontSize, lineGap: 2 }) + 20;
      ensureSpace(height);
      const top = doc.y;
      doc.save().roundedRect(52, top - 5, 508, height, 5).fill('#f0f1f4').restore();
      doc.fillColor('#24262d').font('Courier').fontSize(fontSize).text(block.text, 66, top + 3, {
        width: 480,
        lineGap: 2
      });
      doc.x = 52;
      doc.y = Math.max(doc.y, top + height + 3);
      continue;
    }

    const isList = block.type === 'bullet' || block.type === 'numbered';
    const fontSize = 9.5;
    const width = isList ? 474 : 508;
    const height = doc.heightOfString(block.text, { width, font: 'Helvetica', fontSize, lineGap: 3 }) + 8;
    ensureSpace(height);
    const top = doc.y;
    if (block.type === 'bullet') {
      doc.save().circle(60, top + 5, 2).fill('#eab308').restore();
      doc.fillColor('#343741').font('Helvetica').fontSize(fontSize).text(block.text, 70, top, {
        width: 478,
        lineGap: 3
      });
    } else if (block.type === 'numbered') {
      const number = `${block.number}.`;
      doc.fillColor('#927000').font('Helvetica-Bold').fontSize(fontSize).text(number, 54, top, { width: 18 });
      doc.fillColor('#343741').font('Helvetica').fontSize(fontSize).text(block.text, 72, top, {
        width: 474,
        lineGap: 3
      });
    } else {
      doc.fillColor('#343741').font('Helvetica').fontSize(fontSize).text(block.text, 52, top, {
        width: 508,
        lineGap: 3
      });
    }
    doc.moveDown(0.25);
  }

  const pageRange = doc.bufferedPageRange();
  for (let page = pageRange.start; page < pageRange.start + pageRange.count; page += 1) {
    doc.switchToPage(page);
    doc.save();
    doc.moveTo(52, 744).lineTo(560, 744).lineWidth(0.5).strokeColor('#d8d9de').stroke();
    doc.fillColor('#777b85').font('Helvetica').fontSize(8)
      .text('Keep member data and database backups private.', 52, 752, { width: 380 });
    doc.text(`Page ${page + 1} of ${pageRange.count}`, 460, 752, { width: 100, align: 'right' });
    doc.restore();
  }

  doc.end();
  await new Promise((resolve, reject) => {
    output.once('finish', resolve);
    output.once('error', reject);
  });
  console.log(`Generated ${outputPath}`);
}

main().catch(error => {
  console.error('Unable to generate the operations guide PDF.', error);
  process.exitCode = 1;
});
