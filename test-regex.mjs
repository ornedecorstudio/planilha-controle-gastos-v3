import pdfParse from 'pdf-parse';
import fs from 'fs';
import path from 'path';

const pdfPath = path.join('C:', 'Users', 'Erick', 'Downloads', 'planilha-controle-gastos-main', 'modelos faturas', 'FATURA C6 - ORNE PJ.pdf');
const buffer = fs.readFileSync(pdfPath);
const data = await pdfParse(buffer);
const text = data.text;

// Test the regex
const regexTotalFatura = /(?:TOTAL\s+(?:A\s+)?PAGAR|VALOR\s+TOTAL\s+(?:DESTA\s+)?FATURA|TOTAL\s+DA\s+FATURA)\s*:?\s*R?\$?\s*(\d{1,3}(?:\.\d{3})*,\d{2})/gi;
let match;
let ultimoValor = null;

console.log('=== REGEX MATCHES ===');
while ((match = regexTotalFatura.exec(text)) !== null) {
  console.log(`Match: "${match[0]}" → Value: "${match[1]}"`);
  ultimoValor = match[1];
}

if (!ultimoValor) {
  console.log('NO REGEX MATCHES FOUND!');
  console.log('\n=== SEARCHING FOR "TOTAL" LINES ===');
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].toUpperCase().includes('TOTAL')) {
      console.log(`[${i}] "${lines[i]}"`);
    }
  }
}

console.log('\n=== SEARCHING SPECIFICALLY FOR "R$ 13.651,74" ===');
if (text.includes('13.651,74')) {
  console.log('✓ Found "13.651,74" in text');
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('13.651,74')) {
      console.log(`[${i}] "${lines[i]}"`);
    }
  }
} else {
  console.log('✗ "13.651,74" NOT found in text');
}
