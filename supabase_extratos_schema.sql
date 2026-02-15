-- ==============================================
-- ORNE Categorizador - Schema para Extratos Bancários
-- Execute este SQL no Supabase SQL Editor
-- ==============================================

-- 1. Criar tabela de extratos bancários
CREATE TABLE IF NOT EXISTS public.extratos (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    banco VARCHAR(100) NOT NULL,
    conta VARCHAR(50),
    mes_referencia DATE NOT NULL,
    total_entradas DECIMAL(12, 2) DEFAULT 0,
    total_saidas DECIMAL(12, 2) DEFAULT 0,
    saldo DECIMAL(12, 2) DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Criar tabela de movimentações do extrato
CREATE TABLE IF NOT EXISTS public.movimentacoes (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    extrato_id UUID NOT NULL REFERENCES public.extratos(id) ON DELETE CASCADE,
    data DATE,
    descricao TEXT NOT NULL,
    valor DECIMAL(12, 2) NOT NULL,
    tipo VARCHAR(20) NOT NULL CHECK (tipo IN ('entrada', 'saida')),
    categoria VARCHAR(50) DEFAULT 'Outros',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Criar índices para performance
CREATE INDEX IF NOT EXISTS idx_extratos_mes ON public.extratos(mes_referencia);
CREATE INDEX IF NOT EXISTS idx_extratos_banco ON public.extratos(banco);
CREATE INDEX IF NOT EXISTS idx_movimentacoes_extrato ON public.movimentacoes(extrato_id);
CREATE INDEX IF NOT EXISTS idx_movimentacoes_data ON public.movimentacoes(data);
CREATE INDEX IF NOT EXISTS idx_movimentacoes_categoria ON public.movimentacoes(categoria);

-- 4. Habilitar RLS (Row Level Security)
ALTER TABLE public.extratos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.movimentacoes ENABLE ROW LEVEL SECURITY;

-- 5. Criar políticas permissivas (ajuste conforme necessário)
CREATE POLICY "Allow all operations on extratos" ON public.extratos
    FOR ALL USING (true) WITH CHECK (true);

CREATE POLICY "Allow all operations on movimentacoes" ON public.movimentacoes
    FOR ALL USING (true) WITH CHECK (true);

-- 6. Verificar criação
SELECT 'Tabelas criadas com sucesso!' AS status;
