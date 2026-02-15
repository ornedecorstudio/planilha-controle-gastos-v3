# CLAUDE.md - ORNE Categorizador de Despesas v2.0

## 1. Identidade e Contexto

Sistema full-stack de controle de despesas para **ORNE Decor Studio** (CNPJ: 46.268.741/0001-59).
Separa despesas PJ (empresa, reembolsáveis) e PF (pessoais) com rastreamento de reembolsos via PIX.
Sócio: Erick Beserra. Idioma de negócio: português. Idioma de código: inglês estrutural.

**Ciclo de Desenvolvimento (APEI):**
- **A**nalisar: ler arquivos afetados, entender dependências
- **P**lanejar: mudanças mínimas, um passo por vez
- **E**xecutar: implementar, testar, verificar build
- **I**terar: funciona? commit. Não? voltar a A.

## 2. Stack e Arquitetura

| Camada | Tecnologia |
|--------|-----------|
| Frontend | Next.js 16.1.6 (App Router), React 18.3.1, Tailwind CSS 3.4.4 |
| Backend | Next.js API Routes (serverless) |
| Database | Supabase (PostgreSQL) com RLS |
| IA | Claude API (categorização e parse de PDFs) |
| File Parsing | pdf-parse, pdf2json, OFX parser custom |
| Icons | lucide-react 0.400 |
| Deploy | Vercel |
| State | React hooks (useState, useEffect) - SEM Redux/Context |
| Path alias | `@/*` → `./*` (jsconfig.json) |

## 3. Estrutura do Projeto

```
app/
  page.js                    # Dashboard (KPIs, categorias, últimas faturas)
  layout.js                  # Root layout (Inter font, Header global)
  upload/page.js             # Import de faturas (2 steps: upload + revisão)
  faturas/page.js            # Listagem de faturas com CRUD
  faturas/[id]/page.js       # Detalhe fatura + transações editáveis
  extratos/page.js           # Listagem de extratos bancários
  extratos/[id]/page.js      # Detalhe extrato + movimentações
  reconciliacao/page.js      # Reconciliação PJ/PF e reembolsos
  api/
    faturas/route.js         # CRUD faturas (GET, POST, PATCH, DELETE)
    faturas/check-duplicate/ # Verificação duplicidade via IA
    faturas/upload-pdf/      # Upload PDF/OFX para Storage
    transacoes/route.js      # CRUD transações + bulk insert + recálculo totais
    transacoes/export/       # Export CSV (separador: ;)
    cartoes/route.js         # CRUD cartões
    categorias/route.js      # Lista categorias ativas
    dashboard/route.js       # Dados agregados PJ/PF/categorias
    extratos/route.js        # CRUD extratos com dedup
    movimentacoes/route.js   # CRUD movimentações + recálculo totais extrato
    parse-pdf/route.js       # Parser principal: detecta banco → pipeline
    parse-fatura-ofx/route.js # Parser OFX para faturas de cartão
    parse-extrato/route.js   # Parser dual: OFX ou PDF para extratos
    reembolsos/route.js      # Reconciliação: sugestão auto, match, duplicatas
    categorize/route.js      # Categorização IA (PJ/PF + categoria)

components/
  Header.js                  # Nav global (Dashboard, Faturas, Extratos, Reconciliação)
  DropZone.js                # Drag-and-drop de arquivos (PDF/OFX/QFX)
  MonthPicker.js             # Seletor mês/ano brasileiro
  ConfirmModal.js            # Modal confirmação (danger/warning)
  DuplicatesModal.js         # Modal gestão de duplicatas
  UploadButton.js            # Botão com estados (idle/loading/success)
  ReconciliationCard.js      # Card de auditoria com badges

lib/
  supabase.js                # createBrowserClient() e createServerClient()
  ofx-parser.js              # Parser OFX determinístico (Itaú, Nubank, Santander...)
  categorize-extrato.js      # Regras de categorização por padrão de descrição
  pdf-parsers/
    index.js                 # Registry: detectarBanco() + getPipeline()
    utils.js                 # parseValorBR(), parseDataBR(), calcularAuditoria()
    pipelines/               # Parsers por banco (nubank, itau, santander, c6bank,
                             #   mercadopago, picpay, xp, renner, generic)
```

## 4. Padrão de Código

### React/Components
- Functional components com hooks (`useState`, `useEffect`, `useRef`)
- `'use client'` obrigatório no topo de componentes interativos
- PascalCase para arquivos: `ConfirmModal.js`, `DropZone.js`
- Props com destructuring: `function Component({ prop1, prop2 })`
- Event handlers: prefixo `handle` (`handleDrop`, `handleConfirm`)
- Loading/error states em TODAS as páginas
- Formatação monetária: `.toLocaleString('pt-BR', { minimumFractionDigits: 2 })`

### Tailwind CSS
- Classes inline (NÃO CSS Modules)
- Palette: `neutral-50` a `neutral-950` (customizada)
- Font sizes semânticos: `text-page-title`, `text-section-title`, `text-kpi`, `text-body`, `text-label`
- Sombras: `shadow-subtle`, `shadow-card`
- Ícones: `lucide-react` com `size={14-24}` e `strokeWidth={1.5}`

### JavaScript
- ES6+ (arrow functions, destructuring, template literals)
- `async/await` para operações assíncronas
- SEM TypeScript (JavaScript puro)
- Imports com alias: `import X from '@/lib/...'`
- `console.error()` para logs (NÃO `console.log` em produção)

## 5. Padrão de API Routes

```javascript
// Padrão: app/api/[recurso]/route.js
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'

export async function GET(request) {
  try {
    const supabase = createServerClient()
    const { searchParams } = new URL(request.url)
    // ... query com filtros
    const { data, error } = await supabase.from('tabela').select('*')
    if (error) {
      console.error('Erro ao buscar [recurso]:', error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    return NextResponse.json({ recurso: data })
  } catch (error) {
    console.error('Erro na API [recurso]:', error)
    return NextResponse.json({ error: 'Erro interno do servidor' }, { status: 500 })
  }
}
```

**Convenções:**
- `createServerClient()` no início de cada função (NUNCA `createBrowserClient` em API)
- Query params: `searchParams.get('param')`
- Body: `await request.json()` (POST/PATCH) ou `await request.formData()` (uploads)
- Deleção em lote: `?ids=uuid1,uuid2` → `ids.split(',').filter(Boolean)`
- Deleção cascata manual: deletar filhos antes do pai (transações → faturas)
- Recálculo automático: `recalcularTotaisFatura()` após PATCH/DELETE em transações
- Mensagens de erro em português

## 6. Banco de Dados (Supabase)

### Tabelas
- `faturas`: id(UUID), cartao_id(FK), mes_referencia(DATE), valor_total/pj/pf(DECIMAL 12,2), status(pendente|pago|reembolsado)
- `transacoes`: id(UUID), fatura_id(FK), data, descricao, valor(DECIMAL 12,2), categoria, tipo(PJ|PF), metodo(automatico|manual)
- `cartoes`: id(UUID), nome, banco, tipo(credit|debit), ativo(BOOLEAN)
- `extratos`: id(UUID), banco, mes_referencia(DATE), total_entradas/saidas/saldo
- `movimentacoes`: id(UUID), extrato_id(FK), data, descricao, valor, tipo(entrada|saida), categoria
- `categorias`: id, nome, tipo(PJ|PF), ativo(BOOLEAN)

### Convenções
- PKs: UUID via `gen_random_uuid()`
- Colunas: `snake_case` em português (`mes_referencia`, `valor_total`)
- Timestamps: `created_at TIMESTAMPTZ DEFAULT NOW()`
- RLS habilitado em todas as tabelas
- Índices: `idx_[tabela]_[coluna]` para campos filtrados

### Clientes Supabase (`lib/supabase.js`)
- Browser: `createBrowserClient()` com `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- Server: `createServerClient()` com `SUPABASE_SERVICE_ROLE_KEY` + `autoRefreshToken: false`

## 7. Regras de Negócio

### PJ vs PF
- **PJ** (Pessoa Jurídica): despesas da ORNE Decor - reembolsáveis ao sócio
- **PF** (Pessoa Física): despesas pessoais - NÃO reembolsáveis
- Categorias PJ: Marketing, Fornecedores, Fretes, Taxas Checkout, IA, Design, Telefonia, ERP
- Categorias PF: Alimentação, Saúde, Moda, Supermercado, Transporte, Entretenimento

### Reembolsos
- Fluxo: PF paga fatura → extrai gastos PJ → PJ reembolsa via PIX → status `reembolsado`
- Sugestão automática: match por valor com tolerância R$ 0,50
- Categoria especial: `Reembolso Sócio` para movimentações de reembolso

### Processamento de Arquivos
- **OFX/QFX**: parser determinístico (`lib/ofx-parser.js`) - PREFERIDO
- **PDF**: parser com IA (Claude API) - fallback quando OFX indisponível
- Detecção automática de banco por conteúdo do arquivo
- Cada banco tem pipeline isolado em `lib/pdf-parsers/pipelines/[banco].js`
- Bancos: Nubank, Itaú, Santander, C6 Bank, Mercado Pago, PicPay, XP, Renner

### Duplicatas
- Hash triplo: `${data}|${valor.toFixed(2)}|${descNormalizada}`
- Verificação contra banco de dados E dentro do mesmo lote
- Modal interativo para revisão antes de remoção

### Formatação
- Moeda: `R$ 1.234,56` (formato brasileiro)
- Datas exibição: `DD/MM/YYYY`
- Datas banco: `YYYY-MM-DD`
- CSV export: separador `;` (ponto-e-vírgula), charset UTF-8

## 8. Segurança

### Variáveis de Ambiente (obrigatórias)
- `NEXT_PUBLIC_SUPABASE_URL` - URL do projeto Supabase
- `NEXT_PUBLIC_SUPABASE_ANON_KEY` - chave pública (browser)
- `SUPABASE_SERVICE_ROLE_KEY` - chave de serviço (NUNCA expor no client)
- `ANTHROPIC_API_KEY` - chave Claude API (apenas server-side)

### Regras
- NUNCA commitar `.env` ou chaves em código
- Service key somente em API routes
- Validar inputs obrigatórios antes de queries (retornar 400)
- Upload: `upsert: true` para prevenir arquivos órfãos

## 9. Ciclo de Desenvolvimento

### Commits
Formato: `tipo(escopo): descrição em português`
Tipos: `feat`, `fix`, `refactor`, `docs`, `chore`
Exemplo: `feat(parsers): adicionar suporte ao banco Sicoob`

### Validação
- `npm run build` deve passar sem erros
- Testar manualmente fluxos afetados
- Status de testes: NENHUM configurado (prioridade: testes nos parsers)

### Tratamento de Erros
- API: `try/catch` + `console.error('Erro na API [nome]:', error)` + `NextResponse.json({ error })`
- Client: `try/catch` + `setError(mensagem)` ou feedback visual

## 10. Deploy

- **Plataforma:** Vercel (auto-deploy via git push)
- **Build:** `npm run build` (Next.js)
- **Config:** `vercel.json`

### Checklist Pré-Deploy
- [ ] `npm run build` sem erros
- [ ] Variáveis de ambiente configuradas no Vercel
- [ ] Sem `console.log` de debug
- [ ] Sem credenciais no código
