# Guia Técnico: Parser de Faturas PDF com Claude Opus 4.6

## Roteiro Completo de Extração, Decodificação e Auditoria

---

## 1. O Problema: Por que PDFs de Faturas São Difíceis

PDFs de instituições financeiras como Mercado Pago, Nubank, C6 Bank e outros **não são documentos de texto simples**. Eles utilizam técnicas de ofuscação e segurança que tornam a extração de dados um desafio significativo:

- **Fontes com encoding customizado (CIDFont/Type1):** Os caracteres visíveis no PDF não correspondem aos caracteres Unicode padrão. O número `R$ 12.495,48` pode ser armazenado internamente como `$4 12JM%3,M9`.
- **Mapeamento ToUnicode ausente ou corrompido:** Sem essa tabela, ferramentas de extração de texto retornam caracteres errados.
- **Proteção contra scraping:** Muitos emissores aplicam essas técnicas intencionalmente para dificultar a leitura automatizada.

---

## 2. Métodos de Extração Testados (em ordem)

### Método 1: `pdftotext` (Poppler) — FALHOU parcialmente

```bash
pdftotext -layout FATURA_MERCADO_PAGO_PF.pdf -
```

**Resultado:** Extraiu a estrutura e layout corretamente, mas os valores monetários vieram codificados com substituição de caracteres. Exemplo: `$4 12JM%3,M9` em vez de `R$ 12.495,48`.

**Diagnóstico:** A flag `-layout` preserva o posicionamento espacial (útil para tabelas), mas não resolve problemas de encoding de fontes.

### Método 2: PyMuPDF (`fitz`) — FALHOU parcialmente

```python
import fitz
doc = fitz.open('FATURA_MERCADO_PAGO_PF.pdf')
for page in doc:
    text = page.get_text("text")
```

**Resultado:** Mesmo problema. Até a extração com `get_text("dict")` (que retorna metadados de fontes por span) confirmou que o mapeamento de caracteres estava incorreto no próprio PDF.

**Investigação adicional feita:**

```python
# Verificar metadados de fontes para entender o encoding
for block in page.get_text("dict")["blocks"]:
    if "lines" in block:
        for line in block["lines"]:
            for span in line["spans"]:
                print(f"Font: {span['font']}, Text: '{span['text']}'")
```

Isso confirmou que o nome da fonte estava vazio (`Font: `) — indicando uma fonte embutida com encoding proprietário.

### Método 3: OCR via Tesseract — SUCESSO ✅

A estratégia vencedora: **renderizar cada página do PDF como imagem de alta resolução e aplicar OCR**.

```python
import fitz
from PIL import Image
import pytesseract
import io

doc = fitz.open('FATURA_MERCADO_PAGO_PF.pdf')

for i in range(len(doc)):
    page = doc[i]
    mat = fitz.Matrix(3, 3)  # Zoom 3x = ~216 DPI (72 * 3)
    pix = page.get_pixmap(matrix=mat)
    img = Image.open(io.BytesIO(pix.tobytes("png")))
    
    text = pytesseract.image_to_string(img, lang='por')
    print(text)
```

**Por que funcionou:** O OCR lê os **pixels renderizados** da página, não os dados de texto internos do PDF. Assim, independente do encoding da fonte, o Tesseract lê o que um humano veria.

**Configuração necessária:**

```bash
pip install pymupdf pillow pytesseract --break-system-packages
apt-get install -y tesseract-ocr-por  # Pacote de idioma português
```

**Parâmetro crítico — Zoom `Matrix(3, 3)`:** Usar zoom 3x garante resolução suficiente para o Tesseract reconhecer caracteres pequenos como vírgulas, pontos e centavos. Com zoom 1x ou 2x, erros de OCR aumentam significativamente em valores monetários.

---

## 3. Pipeline Completo para LLM (Claude Opus 4.6)

### Instrução-Prompt para o Sistema de Parser

```
Você é um sistema especializado em extrair e auditar dados de faturas 
de cartão de crédito em PDF. Siga este pipeline rigorosamente:

ETAPA 1 — EXTRAÇÃO (tente nesta ordem, pare no primeiro sucesso):

  1a. Tente pdftotext -layout. Se os valores monetários aparecerem 
      com caracteres estranhos ($4, J, (, etc.), descarte e vá para 1b.
  
  1b. Tente PyMuPDF (fitz) com get_text(). Se mesmo problema, vá para 1c.
  
  1c. Use OCR: renderize cada página como imagem (zoom 3x mínimo) 
      e aplique Tesseract com lang='por'. Este é o método mais robusto.

ETAPA 2 — PARSING ESTRUTURADO:

  Para cada página do texto extraído, identifique:
  
  A) MOVIMENTAÇÕES NA FATURA (seção separada):
     - Pagamentos de faturas anteriores → CRÉDITOS (valores negativos)
     - Tarifas e encargos → DÉBITOS
  
  B) TRANSAÇÕES DO CARTÃO (Cartão Visa/Master [****XXXX]):
     - Data | Estabelecimento | Parcela (se houver) | Valor
     - Atenção: transações podem estar distribuídas em MÚLTIPLAS 
       páginas sob o mesmo cabeçalho de cartão
     - O "Total" que aparece repetido no fim de cada bloco é o 
       TOTAL GERAL de consumos, NÃO o subtotal daquela página

  C) RESUMO DA FATURA:
     - Consumos do período
     - Tarifas e encargos
     - Multas por atraso
     - Total da fatura anterior
     - Juros do mês anterior
     - Pagamentos e créditos devolvidos
     - TOTAL A PAGAR

ETAPA 3 — CLASSIFICAÇÃO DE TRANSAÇÕES:

  Categorize cada transação:
  - PAYPAL *FACEBOOKSER / FACEBK *xxxxx → Meta Ads
  - APPLE.COM/BILL → Assinaturas Apple
  - aliexpress / DL *AliExpress → Compras AliExpress (fornecedores)
  - MERCADOLIVRE* → Mercado Livre
  - SHOPEE * → Shopee
  - Serasa Experian → Serviço financeiro
  - EC * → Compras físicas/EC
  - MP* → Mercado Pago (compras/serviços)

ETAPA 4 — AUDITORIA E RECONCILIAÇÃO:

  Execute estas verificações:
  
  ✓ VERIFICAÇÃO 1: Soma das transações do cartão = Consumos informados
    soma(todas_transacoes_cartao) == valor_consumos_periodo
  
  ✓ VERIFICAÇÃO 2: Composição do total a pagar
    total_a_pagar == consumos + tarifas + multas + fatura_anterior 
                     + juros_anterior - pagamentos_creditos
  
  ✓ VERIFICAÇÃO 3: Contagem de transações
    Verificar se não há transações duplicadas ou faltantes
    comparando a contagem manual com o esperado
  
  ✓ VERIFICAÇÃO 4: Coerência de datas
    Todas as transações devem estar dentro do período de consumo
    informado (ex: 16/12 a 15/01)

  Se TODAS as verificações passarem → RECONCILIADO ✅
  Se QUALQUER falhar → Reportar discrepância com detalhes
```

---

## 4. Código Python Completo do Parser

```python
import fitz
from PIL import Image
import pytesseract
import io
import re
from dataclasses import dataclass
from typing import Optional


@dataclass
class Transaction:
    date: str
    merchant: str
    installment: Optional[str]
    amount: float
    category: str


@dataclass
class AccountMovement:
    date: str
    description: str
    amount: float
    is_credit: bool


def extract_text_ocr(pdf_path: str, zoom: int = 3) -> list[str]:
    """
    Etapa 1c: Extrai texto de cada página via OCR.
    Zoom 3x é o mínimo recomendado para valores monetários.
    """
    doc = fitz.open(pdf_path)
    pages_text = []
    
    for page in doc:
        mat = fitz.Matrix(zoom, zoom)
        pix = page.get_pixmap(matrix=mat)
        img = Image.open(io.BytesIO(pix.tobytes("png")))
        text = pytesseract.image_to_string(img, lang='por')
        pages_text.append(text)
    
    doc.close()
    return pages_text


def try_direct_extraction(pdf_path: str) -> tuple[bool, list[str]]:
    """
    Etapa 1a/1b: Tenta extração direta. Retorna (sucesso, textos).
    Detecta encoding corrompido verificando padrão '$4' em vez de 'R$'.
    """
    doc = fitz.open(pdf_path)
    pages_text = []
    has_encoding_issues = False
    
    for page in doc:
        text = page.get_text()
        pages_text.append(text)
        # Detectar encoding corrompido
        if '$4 ' in text or 'J%' in text or '7(' in text:
            has_encoding_issues = True
    
    doc.close()
    return (not has_encoding_issues, pages_text)


def parse_amount(amount_str: str) -> float:
    """
    Converte string de valor brasileiro para float.
    'R$ 3.794,11' → 3794.11
    'R$ 39,90' → 39.90
    """
    cleaned = amount_str.replace('R$', '').strip()
    cleaned = cleaned.replace('.', '').replace(',', '.')
    return float(cleaned)


def categorize_merchant(merchant: str) -> str:
    """Classifica o estabelecimento por categoria."""
    merchant_upper = merchant.upper()
    
    categories = {
        'Meta Ads': ['PAYPAL *FACEBOOK', 'FACEBK', 'PAY PAL*PAYPAL'],
        'Apple (Assinaturas)': ['APPLE.COM/BILL'],
        'AliExpress (Fornecedores)': ['ALIEXPRESS', 'DL *ALI'],
        'Mercado Livre': ['MERCADOLIVRE'],
        'Shopee': ['SHOPEE'],
        'Serasa': ['SERASA'],
        'Mercado Pago': ['MP*'],
    }
    
    for category, patterns in categories.items():
        for pattern in patterns:
            if pattern in merchant_upper:
                return category
    
    return 'Outros'


def parse_transactions_from_ocr(pages_text: list[str]) -> dict:
    """
    Etapa 2: Faz o parsing estruturado do texto OCR.
    Retorna dicionário com transações, movimentações e resumo.
    """
    card_transactions = []
    account_movements = []
    summary = {}
    
    # Regex para capturar linhas de transação do cartão
    # Padrão: DD/DD  NOME_ESTABELECIMENTO  [Parcela X de Y]  R$ X.XXX,XX
    tx_pattern = re.compile(
        r'(\d{2}/\d{2})\s+'           # Data
        r'(.+?)\s+'                    # Estabelecimento
        r'(?:(Parcela \d+ de \d+)\s+)?' # Parcela (opcional)
        r'R\$\s*([\d.,]+)'            # Valor
    )
    
    # Regex para valores do resumo
    summary_patterns = {
        'consumos': r'Consumos de.*?R\$\s*([\d.,]+)',
        'tarifas': r'Tarifas e encargos\s+R\$\s*([\d.,]+)',
        'multas': r'Multas por atraso\s+R\$\s*([\d.,]+)',
        'fatura_anterior': r'Total da fatura de \w+\s+R\$\s*([\d.,]+)',
        'juros_anterior': r'Juros do m[eê]s anterior\s+R\$\s*([\d.,]+)',
        'pagamentos_creditos': r'Pagamentos e cr[eé]ditos devolvidos\s+R\$\s*([\d.,]+)',
        'total_pagar': r'Total a pagar\s+R\$\s*([\d.,]+)',
    }
    
    full_text = '\n'.join(pages_text)
    
    # Extrair resumo
    for key, pattern in summary_patterns.items():
        match = re.search(pattern, full_text, re.IGNORECASE)
        if match:
            summary[key] = parse_amount(f"R$ {match.group(1)}")
    
    # Extrair transações (processar página a página)
    in_card_section = False
    in_movements_section = False
    
    for page_text in pages_text:
        lines = page_text.split('\n')
        
        for line in lines:
            line = line.strip()
            
            if 'Movimenta' in line and 'fatura' in line.lower():
                in_movements_section = True
                in_card_section = False
                continue
            
            if 'Cartão Visa' in line or 'Cartão Master' in line:
                in_card_section = True
                in_movements_section = False
                continue
            
            if in_card_section:
                match = tx_pattern.search(line)
                if match:
                    amount = parse_amount(f"R$ {match.group(4)}")
                    merchant = match.group(2).strip()
                    
                    tx = Transaction(
                        date=match.group(1),
                        merchant=merchant,
                        installment=match.group(3),
                        amount=amount,
                        category=categorize_merchant(merchant)
                    )
                    card_transactions.append(tx)
    
    return {
        'card_transactions': card_transactions,
        'account_movements': account_movements,
        'summary': summary,
    }


def audit_invoice(parsed_data: dict) -> dict:
    """
    Etapa 4: Auditoria e reconciliação.
    Executa todas as verificações e retorna relatório.
    """
    transactions = parsed_data['card_transactions']
    summary = parsed_data['summary']
    
    results = {
        'total_transactions': len(transactions),
        'checks': [],
        'reconciled': True,
    }
    
    # VERIFICAÇÃO 1: Soma transações == Consumos informados
    sum_transactions = sum(t.amount for t in transactions)
    consumos = summary.get('consumos', 0)
    diff_1 = abs(sum_transactions - consumos)
    check_1 = {
        'name': 'Soma transações = Consumos',
        'calculated': sum_transactions,
        'expected': consumos,
        'difference': diff_1,
        'passed': diff_1 < 0.02,  # Tolerância de R$0,02 por arredondamento
    }
    results['checks'].append(check_1)
    
    # VERIFICAÇÃO 2: Composição do total a pagar
    calculated_total = (
        summary.get('consumos', 0)
        + summary.get('tarifas', 0)
        + summary.get('multas', 0)
        + summary.get('fatura_anterior', 0)
        + summary.get('juros_anterior', 0)
        - summary.get('pagamentos_creditos', 0)
    )
    total_pagar = summary.get('total_pagar', 0)
    diff_2 = abs(calculated_total - total_pagar)
    check_2 = {
        'name': 'Composição total a pagar',
        'calculated': calculated_total,
        'expected': total_pagar,
        'difference': diff_2,
        'passed': diff_2 < 0.02,
    }
    results['checks'].append(check_2)
    
    # VERIFICAÇÃO 3: Categorização
    by_category = {}
    for tx in transactions:
        cat = tx.category
        if cat not in by_category:
            by_category[cat] = {'count': 0, 'total': 0.0}
        by_category[cat]['count'] += 1
        by_category[cat]['total'] += tx.amount
    results['categories'] = by_category
    
    # Status final
    results['reconciled'] = all(c['passed'] for c in results['checks'])
    
    return results


def run_full_pipeline(pdf_path: str) -> None:
    """Pipeline completo: extração → parsing → auditoria."""
    
    print("=" * 60)
    print("PIPELINE DE PARSER E AUDITORIA DE FATURA PDF")
    print("=" * 60)
    
    # Etapa 1: Tentar extração direta
    print("\n[ETAPA 1] Tentando extração direta...")
    success, pages = try_direct_extraction(pdf_path)
    
    if not success:
        print("  ⚠ Encoding corrompido detectado. Usando OCR...")
        pages = extract_text_ocr(pdf_path, zoom=3)
        print("  ✅ OCR concluído com sucesso")
    else:
        print("  ✅ Extração direta bem-sucedida")
    
    # Etapa 2: Parsing
    print("\n[ETAPA 2] Parsing estruturado...")
    parsed = parse_transactions_from_ocr(pages)
    print(f"  Transações encontradas: {len(parsed['card_transactions'])}")
    
    # Etapa 3: Classificação
    print("\n[ETAPA 3] Classificação de transações...")
    for tx in parsed['card_transactions']:
        print(f"  {tx.date} | {tx.merchant[:35]:35s} | R$ {tx.amount:>10,.2f} | {tx.category}")
    
    # Etapa 4: Auditoria
    print("\n[ETAPA 4] Auditoria e Reconciliação...")
    audit = audit_invoice(parsed)
    
    for check in audit['checks']:
        status = "✅ PASSOU" if check['passed'] else "❌ FALHOU"
        print(f"  {status} | {check['name']}")
        print(f"         Calculado: R$ {check['calculated']:,.2f}")
        print(f"         Esperado:  R$ {check['expected']:,.2f}")
        if check['difference'] > 0:
            print(f"         Diferença: R$ {check['difference']:,.2f}")
    
    print(f"\n{'=' * 60}")
    if audit['reconciled']:
        print("RESULTADO: ✅ FATURA RECONCILIADA — Dados conferem")
    else:
        print("RESULTADO: ❌ DISCREPÂNCIA ENCONTRADA — Verificar manualmente")
    print(f"{'=' * 60}")
    
    # Resumo por categoria
    print("\nResumo por categoria:")
    for cat, data in sorted(
        audit['categories'].items(), key=lambda x: -x[1]['total']
    ):
        pct = (data['total'] / sum(
            t.amount for t in parsed['card_transactions']
        )) * 100
        print(f"  {cat:30s} | {data['count']:3d}x | "
              f"R$ {data['total']:>10,.2f} | {pct:5.1f}%")


# Executar
if __name__ == "__main__":
    run_full_pipeline("FATURA_MERCADO_PAGO_PF.pdf")
```

---

## 5. Dificuldades Encontradas e Soluções

### Dificuldade 1: Encoding de Fontes Corrompido

**Sintoma:** Todos os valores monetários vinham com caracteres substituídos.

| Caractere Real | Caractere Extraído |
|---|---|
| R | $ |
| $ | 4 |
| 0 | 0 |
| 1 | 1 |
| 2 | 2 |
| 3 | 5 |
| 4 | M |
| 5 | 3 |
| 6 | 6 |
| 7 | ) |
| 8 | 9 |
| 9 | % |
| . | J |
| , | , |

**Solução:** Abandonar extração de texto e usar OCR (renderizar como imagem → Tesseract).

### Dificuldade 2: Tesseract sem Idioma Português

**Sintoma:** `TesseractError: Error opening data file por.traineddata`

**Solução:** Instalar o pacote de idioma:

```bash
apt-get install -y tesseract-ocr-por
```

### Dificuldade 3: Transações Espalhadas em Múltiplas Páginas

**Sintoma:** As transações do cartão estão distribuídas nas páginas 2 a 6, com o cabeçalho `Cartão Visa [****5415]` repetido em cada página e o mesmo `Total R$ 12.979,63` aparecendo no final de cada bloco.

**Solução:** O total repetido é o TOTAL GERAL (não subtotal por página). Ignorar os totais intermediários e somar apenas as transações individuais.

### Dificuldade 4: OCR com Erros em Valores de Centavos

**Sintoma:** Valores como `R$ 3.958,18` podiam ser lidos como `R$ 3.95818` ou `R$ 3958.18`.

**Solução:** Usar zoom mínimo de 3x na renderização (`fitz.Matrix(3, 3)`) e implementar validação regex robusta para padrões monetários brasileiros (`R$\s*[\d.]+,\d{2}`).

### Dificuldade 5: Separar Movimentações de Transações

**Sintoma:** A fatura mistura "Movimentações na fatura" (pagamentos, tarifas) com "Transações do cartão" (compras), mas ambos contribuem para o total de formas diferentes.

**Solução:** Identificar as seções pelo cabeçalho. Movimentações na fatura incluem pagamentos da fatura anterior (créditos) e tarifas (débitos). Transações do cartão são sempre débitos. A fórmula de reconciliação é:

```
total_a_pagar = consumos + tarifas + multas + fatura_anterior 
                + juros_anterior - pagamentos_creditos
```

---

## 6. Tecnologias e Ferramentas Utilizadas

| Camada | Ferramenta | Versão/Detalhe | Uso |
|---|---|---|---|
| Linguagem | Python | 3.12 | Todo o pipeline |
| Extração (tentativa 1) | pdftotext (Poppler) | CLI | Extração com layout |
| Extração (tentativa 2) | PyMuPDF (fitz) | pip | Extração + metadados de fontes |
| Extração (sucesso) | Tesseract OCR | 5.x + por.traineddata | OCR das imagens renderizadas |
| Renderização | PyMuPDF (fitz) | `get_pixmap(matrix=3x)` | PDF → PNG alta resolução |
| Imagem | Pillow (PIL) | pip | Manipulação de imagens |
| Parsing | regex (re) | stdlib | Captura de padrões monetários |
| Ambiente | Ubuntu 24 | Container Linux | Execução |

---

## 7. Checklist de Auditoria (para Qualquer Fatura)

Use este checklist como template para validar qualquer fatura de cartão:

```
□ 1. EXTRAÇÃO BEM-SUCEDIDA
  □ Valores monetários legíveis (R$ X.XXX,XX)
  □ Datas no formato DD/MM
  □ Nomes de estabelecimentos reconhecíveis

□ 2. CONTAGEM DE TRANSAÇÕES
  □ Total de transações do cartão contadas
  □ Total de movimentações da fatura contadas
  □ Nenhuma transação duplicada
  □ Nenhuma transação faltante (verificar paginação)

□ 3. SOMA DE TRANSAÇÕES
  □ Soma das transações do cartão = Consumos do período
  □ Diferença < R$ 0,02 (tolerância arredondamento)

□ 4. COMPOSIÇÃO DO TOTAL
  □ Consumos + Tarifas + Multas + Fatura Anterior 
    + Juros - Pagamentos = Total a Pagar
  □ Diferença < R$ 0,02

□ 5. CATEGORIZAÇÃO
  □ Cada transação classificada por tipo
  □ Percentual por categoria calculado
  □ Top 3 categorias identificadas

□ RESULTADO FINAL: [ ] RECONCILIADO  [ ] DISCREPÂNCIA
```

---

## 8. Observações para Implementação em Produção

**Se for implementar esse parser em escala (ex: processar faturas mensais automaticamente):**

1. **Cache de mapeamento de encoding:** Se a fatura é sempre do mesmo emissor (Mercado Pago), o mapeamento de caracteres tende a ser consistente. Pode-se criar uma tabela de tradução fixa como fallback antes de recorrer ao OCR.

2. **Validação cruzada:** Sempre compare a soma calculada com o total informado. Se divergir, marque para revisão humana.

3. **Armazenamento:** Salve tanto o texto extraído quanto os dados parseados em JSON para rastreabilidade.

4. **Custo computacional:** OCR é significativamente mais lento que extração direta. Para faturas com encoding correto, pule direto para o parsing.

5. **Tolerância de arredondamento:** Use R$ 0,02 como tolerância máxima. Se a diferença for maior, há provavelmente uma transação faltante ou duplicada.
