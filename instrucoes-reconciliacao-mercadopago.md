# Instruções: Reconciliação Mercado Pago contra Total a Pagar (R$ 12.814,49)

## Contexto do problema

A reconciliação atual compara a soma das transações contra o **bruto** (Consumos + Tarifas = R$ 12.994,53), mas o PDF mostra **"Total a pagar" = R$ 12.814,49** na capa. Isso confunde o usuário porque o "Total no PDF" exibido não corresponde ao que ele vê no documento.

A diferença de R$ 180,04 existe porque o cliente pagou R$ 12.675,52 em Pix contra um saldo anterior de R$ 12.495,48 — ou seja, pagou R$ 180,04 a mais, que virou crédito nesta fatura.

## Objetivo

Ajustar `lib/pdf-parsers/pipelines/mercadopago.js` para que a reconciliação feche contra o **Total a pagar (líquido) = R$ 12.814,49** usando a fórmula completa do ciclo da fatura.

## Fórmula de reconciliação desejada

```
sum(compras) + sum(tarifa_cartao) + saldo_anterior + juros + multas
- sum(pagamento_fatura) - sum(estornos)
= total_a_pagar

Exemplo com a fatura atual:
12.979,63 + 14,90 + 12.495,48 + 0,00 + 0,00 - 12.675,52 - 0
= R$ 12.814,49 ✅
```

## Transações extraídas (47 total, antes eram 45)

| Qtd | Tipo | Origem | Efeito |
|-----|------|--------|--------|
| 44 | `compra` | Seção "Cartão Visa" (págs 2-6) | DÉBITO (+) |
| 1 | `tarifa_cartao` | Seção "Movimentações" (pág 2) | DÉBITO (+) |
| 2 | `pagamento_fatura` | Seção "Movimentações" (pág 2) | CRÉDITO (-) ← NOVO |

## Metadata do Resumo (extraída pelo parser, NÃO são transações)

| Campo | Valor | Label no PDF (corrompido) |
|-------|-------|--------------------------|
| `saldo_anterior` | R$ 12.495,48 | "Total da fatura de debemêro" → `$4 12JM%3,M9` |
| `juros_anterior` | R$ 0,00 | "8uros do mDs anterior" → `$4 0,00` |
| `multas_atraso` | R$ 0,00 | "zultas por atraso" → `$4 0,00` |
| `pagamentos_creditos` | R$ 12.675,52 | "Pagamentos e créditos devolvidos" → `$4 12J6)3,32` |
| `total_a_pagar` | R$ 12.814,49 | "Total" → `R$ 12.814,49` (encoding limpo) |

---

## Mudanças no código: `lib/pdf-parsers/pipelines/mercadopago.js`

### MUDANÇA 1: Nova função `extrairResumoFatura(texto)`

Criar uma nova função que extrai TODOS os campos do "Resumo da fatura" da página 1. Esses campos estão em encoding corrompido (exceto o "Total" final que usa fonte limpa).

A função deve extrair 6 campos:
- `consumos` — "íonsumos de DD/MM a DD/MM" seguido de `$4 VALOR`
- `tarifas` — "Tarifas e encargos" seguido de `$4 VALOR`
- `multas` — "zultas por atraso" seguido de `$4 VALOR`
- `saldo_anterior` — "Total da fatura de" + nome_mes seguido de `$4 VALOR`
- `juros_anterior` — "8uros do mDs anterior" seguido de `$4 VALOR`  
- `pagamentos_creditos` — "Pagamentos e créditos devolvidos" seguido de `$4 VALOR`

**IMPORTANTE sobre encoding corrompido:**

O pdf-parse coloca label e valor em LINHAS SEPARADAS. Usar `[\s\S]{0,40}?` (não `\s+`) entre label e valor para capturar quebras de linha.

O character class para capturar valores corrompidos DEVE incluir a letra M (que representa o dígito 4): `([\d,J%\+\)\(M]+)`

A tabela de decodificação é (corrompido → real):
```
0→0, 1→1, 2→2, 3→5, 5→3, 6→6, 9→8, %→9, M→4, )→7, J→., ,→, +→3
```

Regex para cada campo (testadas e validadas contra o PDF real):

```javascript
// saldo_anterior: "Total da fatura de NOMEMES"
// O nome do mês pode estar corrompido (ex: "debemêro" = "dezembro")
/Total da fatura de \w+[\s\S]{0,30}?\$4\s+([\d,J%\+\)\(M]+)/i

// pagamentos: "Pagamentos e créditos devolvidos"
/Pagamentos e cr[eé]ditos devolvidos[\s\S]{0,30}?\$4\s+([\d,J%\+\)\(M]+)/i

// juros: "8uros do mDs anterior" (J=Juros corrompido para 8uros)
/[8J]uros do m[DdÊê]s anterior[\s\S]{0,30}?\$4\s+([\d,J%\+\)\(M]+)/i

// multas: "zultas por atraso" (M=Multas corrompido para zultas)
/[zM]ultas por atraso[\s\S]{0,30}?\$4\s+([\d,J%\+\)\(M]+)/i

// total_a_pagar: "Total" seguido de "R$" (última linha do resumo, encoding LIMPO)
/Total\s+R\$\s*(\d{1,3}(?:\.\d{3})*,\d{2})/
```

A função deve retornar um objeto com todos os campos como números, usando `decodificarValorCorrompido()` para os campos corrompidos e `parseValorBR()` para o total_a_pagar (que é encoding limpo).

**Fallback:** Se algum campo não for encontrado via regex corrompida, tentar formato normal (R$ seguido de valor).

Retorno esperado:
```javascript
{
  consumos: 12979.63,
  tarifas: 14.90,
  multas: 0.00,
  saldo_anterior: 12495.48,
  juros_anterior: 0.00,
  pagamentos_creditos: 12675.52,
  total_a_pagar: 12814.49
}
```

### MUDANÇA 2: Atualizar `extractPipeline()`

Chamar `extrairResumoFatura(texto)` e incluir o resultado completo nos metadados.

```javascript
// Dentro de extractPipeline():

// 3. Extrair resumo completo da fatura (NOVO)
const resumo = extrairResumoFatura(texto);

// O total para reconciliação agora é o TOTAL A PAGAR (líquido),
// NÃO mais o bruto. Isso permite reconciliação contra o valor
// que o usuário vê na capa do PDF.
const totalParaReconciliacao = resumo?.total_a_pagar || totalBruto?.bruto || null;
```

E no objeto `metadados_verificacao`, adicionar:

```javascript
metadados_verificacao: {
  total_fatura_pdf: totalParaReconciliacao,  // Agora é o líquido (R$ 12.814,49)
  total_liquido_pdf: resumo?.total_a_pagar || totalLiquido,
  subtotais_bruto: totalBruto,
  resumo_fatura: resumo,                     // NOVO: resumo completo
  cartoes,
  ano_referencia: anoReferencia,
  encoding_corrompido: encoding.corrompido,
}
```

### MUDANÇA 3: Atualizar `buildAIPrompt()` — Incluir pagamentos da fatura

Na seção `<regras_extracao>`, REVERTER a instrução de ignorar pagamentos. Agora os pagamentos devem ser INCLUÍDOS:

**ANTES (ignorava pagamentos):**
```
2. Inclua tarifas da secao "Movimentacoes na fatura" (ex: "Tarifa de uso do credito emergencial").
```

**DEPOIS (inclui pagamentos E tarifas):**
```
2. Da secao "Movimentacoes na fatura", extraia TODOS os itens:
   a) "Pagamento da fatura de [mes]/[ano]" → tipo "pagamento_fatura" (são créditos/pagamentos feitos pelo cliente)
   b) "Tarifa de uso do crédito emergencial" → tipo "tarifa_cartao" (são débitos)
```

Na seção `<o_que_ignorar>`, REMOVER a linha que dizia para ignorar pagamentos:

**REMOVER esta linha:**
```
- "Pagamento da fatura de [mes]/[ano]" (sao pagamentos feitos pelo cliente — incluir quebraria a reconciliacao)
```

Na seção de `tipo_lancamento`, ADICIONAR o novo tipo:

```
- "pagamento_fatura": pagamentos da fatura anterior feitos pelo cliente. 
  Aparecem na secao "Movimentacoes na fatura" como "Pagamento da fatura de [mes]/[ano]".
  Capture com valor POSITIVO. Sao creditos que REDUZEM o saldo da fatura.
```

Na seção `<reconciliacao>`, ATUALIZAR a fórmula:

**ANTES:**
```
soma(compras) + soma(iof) + soma(tarifa_cartao) - soma(estornos) - soma(pagamento_antecipado) = total bruto
```

**DEPOIS:**
```
soma(compras) + soma(iof) + soma(tarifa_cartao) + saldo_anterior + juros_anterior + multas_atraso
- soma(pagamento_fatura) - soma(estornos) - soma(pagamento_antecipado) 
= total a pagar (liquido)
```

E incluir os valores do resumo no prompt para verificação cruzada:

```
O total a pagar esperado e R$ {total_a_pagar}.
Valores do resumo para verificacao:
- Saldo anterior (fatura do mes passado): R$ {saldo_anterior}
- Juros do mes anterior: R$ {juros_anterior}  
- Multas por atraso: R$ {multas_atraso}
- Pagamentos e creditos devolvidos: R$ {pagamentos_creditos}
```

No bloco `<metadados_pdf>`, adicionar os novos campos:

```javascript
if (resumo) {
  metadadosBloco += `\n- Saldo anterior: R$ ${resumo.saldo_anterior}`;
  metadadosBloco += `\n- Juros anterior: R$ ${resumo.juros_anterior}`;
  metadadosBloco += `\n- Multas atraso: R$ ${resumo.multas}`;
  metadadosBloco += `\n- Pagamentos/créditos: R$ ${resumo.pagamentos_creditos}`;
  metadadosBloco += `\n- Total a pagar (líquido): R$ ${resumo.total_a_pagar}`;
}
```

Na seção `<formato_saida>`, atualizar o campo `total_a_pagar`:

**ANTES:**
```
- "total_a_pagar": valor BRUTO da fatura = Consumos + Tarifas e encargos
```

**DEPOIS:**
```
- "total_a_pagar": valor LIQUIDO da fatura = "Total a pagar" da pagina 1 do PDF (R$ 12.814,49 neste caso).
  Este e o valor que o cliente deve pagar. Inclui saldo anterior, juros, multas e desconta pagamentos feitos.
```

### MUDANÇA 4: Atualizar `postAICorrections()` — NÃO filtrar pagamentos

A função `filtrarTransacoesIA()` (em utils.js) provavelmente remove linhas que contém "Pagamento da fatura". Verificar e ajustar para que transações com `tipo_lancamento === "pagamento_fatura"` NÃO sejam filtradas.

Se `filtrarTransacoesIA` usa regex como `/pagamento/i` para remover, adicionar exceção:

```javascript
// Em filtrarTransacoesIA (utils.js):
// NÃO filtrar se tipo_lancamento === "pagamento_fatura"
// Filtrar apenas se tipo_lancamento NÃO foi definido ou é outro tipo
```

### MUDANÇA 5: Atualizar `calcularAuditoria()` — Nova fórmula

A função `calcularAuditoria` (em utils.js) precisa da nova fórmula que inclui saldo_anterior e os novos tipos.

A assinatura pode mudar para receber os metadados do resumo:

```javascript
calcularAuditoria(transacoes, totalPDF, resumoFatura)
```

Nova lógica interna:

```javascript
const somaCompras = sum(t.valor where t.tipo_lancamento in ['compra', 'iof']);
const somaTarifas = sum(t.valor where t.tipo_lancamento === 'tarifa_cartao');
const somaPagamentos = sum(t.valor where t.tipo_lancamento === 'pagamento_fatura');
const somaEstornos = sum(t.valor where t.tipo_lancamento in ['estorno', 'pagamento_antecipado']);

const saldoAnterior = resumoFatura?.saldo_anterior || 0;
const juros = resumoFatura?.juros_anterior || 0;
const multas = resumoFatura?.multas || 0;

const totalCalculado = somaCompras + somaTarifas + saldoAnterior + juros + multas 
                       - somaPagamentos - somaEstornos;

const diferenca = Math.abs(totalCalculado - totalPDF);
const reconciliado = diferenca <= 0.02; // tolerância de 2 centavos (floating point)
```

O retorno deve incluir o breakdown:

```javascript
return {
  total_calculado: totalCalculado,
  total_pdf: totalPDF,
  diferenca_centavos: Math.round(diferenca * 100),
  reconciliado,
  breakdown: {
    compras: somaCompras,
    tarifas: somaTarifas,
    saldo_anterior: saldoAnterior,
    juros: juros,
    multas: multas,
    pagamentos: somaPagamentos,
    estornos: somaEstornos,
  }
};
```

---

## Resultado esperado após as mudanças

### Transações extraídas: 47
```
44 compras (cartão)              → débitos    R$ 12.979,63
 1 tarifa (crédito emergencial)  → débito     R$     14,90
 2 pagamentos (fatura anterior)  → créditos   R$ 12.675,52  ← NOVO
```

### Reconciliação
```
  Total compras (gross)           R$ 12.979,63
+ Tarifas cartão                  R$     14,90
+ Saldo anterior                  R$ 12.495,48  ← metadata
+ Juros anterior                  R$      0,00  ← metadata
+ Multas atraso                   R$      0,00  ← metadata
- Pagamentos da fatura            R$ 12.675,52  ← 2 transações tipo pagamento_fatura
                                  ────────────
= Total calculado                 R$ 12.814,49
  Total no PDF                    R$ 12.814,49  ← "Total a pagar" da capa
  Diferença                       R$      0,00  ✅ Reconciliado
```

---

## Checklist de validação

Após implementar, testar re-importando o PDF `FATURA_MERCADO_PAGO_PF.pdf`:

- [ ] Badge: "IA Híbrido" 
- [ ] Badge: "Reconciliado" (verde)
- [ ] 47 transações encontradas (antes eram 45)
- [ ] Total no PDF: R$ 12.814,49 (= "Total a pagar" da capa)
- [ ] Total calculado: R$ 12.814,49
- [ ] Diferença: 0 centavos
- [ ] As 2 transações "Pagamento da fatura de dezembro/2025" aparecem na lista com tipo `pagamento_fatura`
- [ ] A tarifa emergencial continua com tipo `tarifa_cartao`
- [ ] As 44 compras do cartão continuam com tipo `compra`
- [ ] PJ/PF split mostra os pagamentos em algum lado (verificar se faz sentido)

---

## Arquivos afetados

1. **`lib/pdf-parsers/pipelines/mercadopago.js`** — Mudanças 1, 2, 3 (principal)
2. **`lib/pdf-parsers/utils.js`** — Mudanças 4, 5 (`filtrarTransacoesIA`, `calcularAuditoria`)
3. **Frontend de reconciliação** — Ajustar display para mostrar o breakdown completo (saldo anterior, pagamentos, etc.) em vez de apenas "Total compras (gross) + Tarifas"

## Notas técnicas

- O encoding corrompido do Mercado Pago mapeia caracteres assim: `R$` → `$4`, `.` → `J`, `4` → `M`, `3` → `+`, `5` → `3`, `7` → `)`, `8` → `9`, `9` → `%`
- A letra **M** no character class das regex é OBRIGATÓRIA — sem ela, qualquer valor contendo o dígito 4 é truncado (bug já corrigido na versão atual)
- Labels e valores aparecem em **linhas separadas** no pdf-parse — usar `[\s\S]{0,40}?` entre eles, nunca `\s+`
- O "Total" final do resumo usa encoding **limpo** (R$ 12.814,49), diferente dos outros campos
- Os nomes dos meses ficam corrompidos: "dezembro" → "debemêro", por isso a regex usa `\w+` genérico
