# Prompt para Desenvolvimento de Machine Learning - ORNE Categorizador

> **Como usar:** Copie o prompt abaixo (tudo dentro do bloco) e cole diretamente em uma nova conversa com o Claude Code ou Claude.ai.

---

## O Prompt

```
Preciso implementar 3 modelos de Machine Learning no meu projeto ORNE Categorizador de Despesas.

## Contexto do Projeto

Sistema Next.js 16 (App Router) + Supabase (PostgreSQL) para controle de despesas PJ/PF.
Deploy no Vercel (serverless). Sem Python backend atualmente.

### Stack atual:
- Frontend: Next.js 16.1.6, React 18, Tailwind CSS 3.4
- Backend: Next.js API Routes (serverless)
- Database: Supabase (PostgreSQL)
- IA atual: Claude API para categorização de transações via PDF
- Deploy: Vercel

### Estrutura relevante:
- app/api/ - API Routes (serverless functions)
- lib/supabase.js - createBrowserClient() e createServerClient()
- lib/categorize-extrato.js - regras de categorização por regex/pattern matching
- lib/pdf-parsers/ - parsers PDF por banco (nubank, itau, santander, etc.)

### Schema do banco (Supabase/PostgreSQL):

faturas: id(UUID), cartao_id(FK), mes_referencia(DATE), valor_total(DECIMAL 12,2),
         valor_pj(DECIMAL 12,2), valor_pf(DECIMAL 12,2),
         status(pendente|pago|reembolsado), created_at

transacoes: id(UUID), fatura_id(FK), data(DATE), descricao(TEXT),
            valor(DECIMAL 12,2), categoria(VARCHAR), tipo(PJ|PF),
            tipo_lancamento(compra|iof|estorno|tarifa),
            metodo(automatico|manual), created_at

cartoes: id(UUID), nome(VARCHAR), banco(VARCHAR), tipo(credit|debit), ativo(BOOLEAN)

extratos: id(UUID), banco(VARCHAR), mes_referencia(DATE),
          total_entradas(DECIMAL), total_saidas(DECIMAL), saldo(DECIMAL)

movimentacoes: id(UUID), extrato_id(FK), data(DATE), descricao(TEXT),
               valor(DECIMAL 12,2), tipo(entrada|saida), categoria(VARCHAR)

### Categorias existentes:
- PJ: Marketing Digital, Pagamento Fornecedores, Fretes, Taxas Checkout,
      Câmbio, IA e Automação, Design, Telefonia, ERP, Gestão, Viagem PJ, IOF
- PF: Alimentação, Saúde/Farmácia, Moda, Supermercado, Transporte,
      Viagens, Entretenimento, Lojas, Serviços, Tarifas Bancárias, Pessoal

### Volume estimado de dados:
- ~500-2000 transações por mês
- ~12-24 meses de histórico
- ~8 cartões diferentes
- ~20+ categorias

---

## Os 3 Modelos que Preciso

### Modelo 1: Categorização Local de Transações

**Objetivo:** Substituir/complementar a Claude API com um modelo próprio treinado
nos meus dados para categorizar transações automaticamente (tipo PJ/PF + categoria).

**Input:** descricao (texto), valor (número), banco (texto)
**Output:** tipo (PJ|PF), categoria (uma das categorias acima), confiança (0-1)

**Requisitos:**
- Treinar com dados das tabelas transacoes + movimentacoes (campo metodo='manual'
  indica correção humana = dado de alta qualidade)
- Lidar com descrições em português, abreviadas, com caracteres especiais
- Confiança > 0.8 = aplicar automaticamente. < 0.8 = pedir revisão humana
- Fallback para Claude API quando confiança for muito baixa
- Deve ser mais rápido e sem custo de API por transação

**Dados de treino disponíveis:**
```sql
-- Transações já categorizadas (melhor: as corrigidas manualmente)
SELECT descricao, valor, categoria, tipo
FROM transacoes
WHERE categoria IS NOT NULL;

-- Movimentações categorizadas
SELECT descricao, valor, categoria, tipo
FROM movimentacoes
WHERE categoria IS NOT NULL;
```

### Modelo 2: Previsão de Gastos Futuros

**Objetivo:** Prever gastos do próximo mês por categoria, identificar tendências,
alertar sobre gastos acima do padrão.

**Input:** histórico mensal de gastos por categoria (últimos 6-12 meses)
**Output:** previsão por categoria para próximo mês, tendência (subindo/descendo/estável),
           alerta se previsão > 120% da média histórica

**Requisitos:**
- Agrupar transações por mês + categoria + tipo (PJ/PF)
- Considerar sazonalidade (ex: dezembro = mais gastos PF)
- Dashboard card mostrando previsão vs realizado
- Simples o suficiente para rodar em serverless (sem GPU)

**Dados de treino:**
```sql
-- Histórico mensal por categoria
SELECT
  date_trunc('month', data) as mes,
  tipo,
  categoria,
  SUM(valor) as total,
  COUNT(*) as qtd_transacoes
FROM transacoes
GROUP BY 1, 2, 3
ORDER BY 1;
```

### Modelo 3: Detecção de Anomalias

**Objetivo:** Identificar transações suspeitas - valores fora do padrão, possíveis
erros de parsing, duplicatas não detectadas, categorização errada.

**Input:** transação individual (descricao, valor, categoria, tipo, data)
**Output:** score de anomalia (0-1), motivo (valor_atipico|categoria_improvavel|possivel_duplicata|padrao_incomum)

**Requisitos:**
- Detectar valores outlier por categoria (ex: Alimentação > R$500 = suspeito)
- Detectar categorização provável errada (ex: "UBER" categorizado como "Moda")
- Detectar possíveis duplicatas mesmo com descrição ligeiramente diferente
- Detectar padrões incomuns (ex: 10 transações iguais no mesmo dia)
- Flag visual na interface: ícone de alerta laranja/vermelho

**Dados:**
```sql
-- Estatísticas por categoria para detecção de outliers
SELECT
  categoria,
  tipo,
  AVG(valor) as media,
  STDDEV(valor) as desvio,
  MIN(valor) as minimo,
  MAX(valor) as maximo,
  PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY valor) as p95
FROM transacoes
GROUP BY 1, 2;
```

---

## Restrições Técnicas

1. **Ambiente serverless:** Next.js no Vercel = sem processo persistente,
   sem GPU, cold start < 10s, execução < 60s
2. **Sem Python nativo no Vercel:** Preciso de uma solução que rode em
   Node.js/Edge ou como serviço externo
3. **Database:** Supabase PostgreSQL (pode usar Edge Functions em Deno)
4. **Budget:** Minimizar custos - preferir soluções que não dependam de
   APIs pagas por request

## Decisão de Arquitetura Necessária

Avalie e recomende a melhor abordagem:

**Opção A:** Python para treinar + exportar modelo para JavaScript
- Treinar em Python (scikit-learn, pandas)
- Exportar para ONNX ou TensorFlow.js
- Inferência no Next.js API Route

**Opção B:** Supabase Edge Functions (Deno)
- Treinar externamente, deploy como Edge Function
- Mais próximo do banco de dados
- Menos dependências no Next.js

**Opção C:** Microserviço Python separado (FastAPI/Flask)
- Deploy no Railway/Render/Fly.io
- Chamar via API do Next.js
- Mais flexível mas mais complexo

**Opção D:** TensorFlow.js puro (treinar + inferir em Node.js)
- Tudo em JavaScript
- Sem dependência externa
- Limitado em algoritmos

## O que Espero como Entrega

1. **Análise de viabilidade** de cada modelo com os dados disponíveis
2. **Recomendação de arquitetura** (qual opção A/B/C/D para cada modelo)
3. **Pipeline de dados:** queries SQL para extrair dados de treino do Supabase
4. **Implementação do Modelo 1** (categorização) como prioridade - é o de maior impacto
5. **Integração com o projeto:** nova API route /api/ml/categorize que:
   - Recebe: { descricao, valor, banco }
   - Retorna: { tipo, categoria, confianca }
   - Se confianca < 0.8, retorna também sugestões alternativas
6. **Modelo 2 e 3** como próximos passos
7. **Scripts de re-treino** para atualizar o modelo quando novos dados chegarem
8. **Card no Dashboard** mostrando insights de ML (previsão, anomalias)

Siga o ciclo APEI: Analise os dados disponíveis, Planeje a arquitetura,
Execute a implementação passo a passo, Itere sobre o desempenho.

Comece pela análise de viabilidade e recomendação de arquitetura antes de codar.
```

---

## Notas de Uso

### Quando usar este prompt:
- Em uma nova conversa do Claude Code com acesso ao projeto
- Certifique-se de que o `CLAUDE.md` está na raiz do projeto (o Claude irá lê-lo automaticamente)
- O Claude terá acesso ao banco Supabase via MCP para consultar dados reais

### Ordem recomendada de implementação:
1. **Modelo 1 (Categorização)** - Maior impacto, substitui custo de API
2. **Modelo 3 (Anomalias)** - Melhora qualidade dos dados
3. **Modelo 2 (Previsão)** - Valor analítico, depende de dados limpos

### Pré-requisitos antes de rodar o prompt:
- Ter pelo menos 3 meses de dados categorizados no Supabase
- Ter algumas correções manuais (campo `metodo='manual'`) para dados de alta qualidade
- Decidir se quer Python externo ou tudo em JavaScript
