import fs from 'fs';
import path from 'path';
import pdfParse from 'pdf-parse';
import { parseC6Bank } from './lib/pdf-parsers/pipelines/c6bank.js';
import { calcularAuditoria } from './lib/pdf-parsers/utils.js';

const pdfPath = path.join('C:\\Users\\Erick\\Downloads\\planilha-controle-gastos-main', 'modelos faturas', 'FATURA C6 - ORNE PJ.pdf');
const buffer = fs.readFileSync(pdfPath);

const pdfData = await pdfParse(buffer);
const texto = pdfData.text || '';

const result = parseC6Bank(texto);

console.log('=== RESULTADO DO PARSER C6 BANK ===');
console.log('Total transacoes:', result.total_encontrado);
console.log('Valor total (compras):', result.valor_total);
console.log('Total fatura PDF:', result.total_fatura_pdf);
console.log('');

// Agrupar por tipo_lancamento
const porTipo = {};
for (const t of result.transacoes) {
  if (!porTipo[t.tipo_lancamento]) porTipo[t.tipo_lancamento] = { count: 0, total: 0 };
  porTipo[t.tipo_lancamento].count++;
  porTipo[t.tipo_lancamento].total += t.valor;
}
console.log('=== POR TIPO ===');
for (const [tipo, info] of Object.entries(porTipo)) {
  console.log(`${tipo}: ${info.count} transacoes, total R$ ${info.total.toFixed(2)}`);
}

// Reconciliacao manual
const compras = porTipo['compra']?.total || 0;
const iof = porTipo['iof']?.total || 0;
const estornos = porTipo['estorno']?.total || 0;
const pgtoAnt = porTipo['pagamento_antecipado']?.total || 0;
const tarifa = porTipo['tarifa_cartao']?.total || 0;
const totalCalc = compras + iof + tarifa - estornos - pgtoAnt;
console.log('');
console.log('=== RECONCILIACAO ===');
console.log('Compras:     R$', compras.toFixed(2));
console.log('IOF:         R$', iof.toFixed(2));
console.log('Tarifa:      R$', tarifa.toFixed(2));
console.log('Estornos:   -R$', estornos.toFixed(2));
console.log('Pgto antec: -R$', pgtoAnt.toFixed(2));
console.log('Total calc:  R$', totalCalc.toFixed(2));
console.log('Total PDF:   R$', result.total_fatura_pdf?.toFixed(2));
console.log('Diferença:  ', ((result.total_fatura_pdf - totalCalc) * 100).toFixed(0), 'centavos');

// Reconciliacao via funcao compartilhada
const auditoria = calcularAuditoria(result.transacoes, result.total_fatura_pdf);
console.log('');
console.log('=== AUDITORIA (funcao compartilhada) ===');
console.log('Reconciliado:', auditoria.reconciliado);
console.log('Equacao:', auditoria.equacao);
console.log('Diferenca centavos:', auditoria.diferenca_centavos);

// Primeiras e ultimas transacoes
console.log('');
console.log('=== PRIMEIRAS 5 TRANSACOES ===');
result.transacoes.slice(0, 5).forEach((t, i) => {
  console.log(`${i+1}. [${t.tipo_lancamento}] ${t.data} ${t.descricao} R$ ${t.valor.toFixed(2)}`);
});
console.log('');
console.log('=== ULTIMAS 5 TRANSACOES ===');
result.transacoes.slice(-5).forEach((t, i) => {
  console.log(`${result.transacoes.length - 4 + i}. [${t.tipo_lancamento}] ${t.data} ${t.descricao} R$ ${t.valor.toFixed(2)}`);
});
