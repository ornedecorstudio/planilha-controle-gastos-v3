"""
Script de Treinamento - Modelo de Categorização de Transações ORNE

Treina 3 modelos de classificação:
  1. categorizer_tipo: PJ vs PF (binário)
  2. categorizer_pj: categorias PJ (multi-classe)
  3. categorizer_pf: categorias PF (multi-classe)

Uso:
  1. Iniciar o servidor Next.js: npm run dev
  2. Instalar dependências: pip install -r requirements.txt
  3. Rodar: python scripts/ml/train_categorizer.py

Os modelos ONNX são salvos em lib/ml/models/categorizer/
"""

import json
import os
import sys
import unicodedata
import re
from datetime import datetime

import numpy as np
import pandas as pd
import requests
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import SGDClassifier
from sklearn.model_selection import train_test_split
from sklearn.metrics import classification_report, accuracy_score
from sklearn.pipeline import Pipeline
from scipy.sparse import hstack, csr_matrix
import onnxruntime as ort

try:
    from skl2onnx import convert_sklearn
    from skl2onnx.common.data_types import FloatTensorType
except ImportError:
    print("ERRO: skl2onnx não instalado. Execute: pip install skl2onnx")
    sys.exit(1)


# ============================================================
# Configuração
# ============================================================
API_URL = os.getenv("TRAINING_DATA_URL", "http://localhost:3000/api/ml/training-data")
OUTPUT_DIR = os.path.join(os.path.dirname(__file__), "..", "..", "lib", "ml", "models", "categorizer")
MIN_SAMPLES_PER_CLASS = 3
MIN_TOTAL_SAMPLES = 50
TFIDF_MAX_FEATURES = 5000
TEST_SIZE = 0.2
RANDOM_STATE = 42

# Bancos conhecidos (mesma lista usada no JS para one-hot encoding)
BANCOS_CONHECIDOS = [
    "NUBANK", "MERCADO PAGO", "C6", "ITAU", "SANTANDER",
    "PICPAY", "XP", "RENNER", "BRADESCO", "INTER", "CAIXA"
]


# ============================================================
# Pré-processamento (DEVE ser idêntico ao JS feature-engineering.js)
# ============================================================
def normalize_description(text):
    """Normaliza descrição de transação bancária (espelha JS normalizeDescription)"""
    if not text:
        return ""

    # Uppercase + strip
    normalized = text.upper().strip()

    # Remove acentos
    normalized = unicodedata.normalize("NFD", normalized)
    normalized = re.sub(r"[\u0300-\u036f]", "", normalized)

    # Remove números de cartão (4+ dígitos)
    normalized = re.sub(r"\b\d{4,}\b", "", normalized)

    # Remove datas inline
    normalized = re.sub(r"\b\d{2}/\d{2}(/\d{2,4})?\b", "", normalized)

    # Normaliza prefixos de gateway
    normalized = re.sub(r"^DL\*", "GATEWAY*", normalized)
    normalized = re.sub(r"^MP\s?\*", "GATEWAY*", normalized)
    normalized = re.sub(r"^PAG\*", "GATEWAY*", normalized)
    normalized = re.sub(r"^IFD\*", "GATEWAY*", normalized)
    normalized = re.sub(r"^EC\s?\*", "GATEWAY*", normalized)
    normalized = re.sub(r"^EBN\*", "GATEWAY*", normalized)
    normalized = re.sub(r"^PG\s?\*", "GATEWAY*", normalized)
    normalized = re.sub(r"^PICPAY\*", "PICPAY*", normalized)

    # Espaços extras
    normalized = re.sub(r"\s+", " ", normalized).strip()

    return normalized


def encode_banco(banco, bancos_list):
    """One-hot encode do banco (espelha JS buildFeatureVector)"""
    banco_norm = unicodedata.normalize("NFD", (banco or "desconhecido").upper())
    banco_norm = re.sub(r"[\u0300-\u036f]", "", banco_norm)

    vec = np.zeros(len(bancos_list), dtype=np.float32)
    for i, b in enumerate(bancos_list):
        if b.upper() in banco_norm:
            vec[i] = 1.0
            break
    return vec


# ============================================================
# Buscar dados de treino
# ============================================================
def fetch_training_data():
    """Busca dados de treino via API do Next.js"""
    print(f"Buscando dados de treino em {API_URL}...")

    try:
        resp = requests.get(API_URL, timeout=30)
        resp.raise_for_status()
    except requests.ConnectionError:
        print(f"\nERRO: Não foi possível conectar em {API_URL}")
        print("Certifique-se de que o servidor Next.js está rodando: npm run dev")
        sys.exit(1)
    except requests.HTTPError as e:
        print(f"\nERRO: API retornou status {e.response.status_code}")
        sys.exit(1)

    data = resp.json()
    print(f"  Total de registros: {data['total']}")
    print(f"  Correções manuais: {data['manuais']}")
    print(f"  Categorias: {len(data['categorias'])}")

    return data["dados"]


# ============================================================
# Preparar dataset
# ============================================================
def prepare_dataset(dados):
    """Converte dados brutos em DataFrame com features processadas"""
    df = pd.DataFrame(dados)

    # Normalizar descrições
    df["descricao_norm"] = df["descricao"].apply(normalize_description)

    # Remover linhas sem descrição ou categoria
    df = df[df["descricao_norm"].str.len() > 0]
    df = df[df["categoria"].notna() & (df["categoria"] != "")]

    # Normalizar tipo para PJ/PF
    df["tipo"] = df["tipo"].apply(lambda x: x if x in ("PJ", "PF") else "PJ")

    # Peso: manual = 3, automático = 1
    df["sample_weight"] = df["metodo"].apply(lambda m: 3.0 if m == "manual" else 1.0)

    # Log(valor)
    df["log_valor"] = np.log1p(df["valor"].abs())

    print(f"\n  Dataset preparado: {len(df)} registros")
    print(f"  PJ: {(df['tipo'] == 'PJ').sum()}, PF: {(df['tipo'] == 'PF').sum()}")

    return df


# ============================================================
# Filtrar categorias com poucos exemplos
# ============================================================
def filter_rare_categories(df, tipo_col, cat_col, min_samples):
    """Remove categorias com menos de min_samples exemplos"""
    counts = df.groupby(cat_col).size()
    valid_cats = counts[counts >= min_samples].index
    removed = counts[counts < min_samples]

    if len(removed) > 0:
        print(f"  Categorias removidas (< {min_samples} exemplos):")
        for cat, n in removed.items():
            print(f"    - {cat}: {n} exemplos")

    return df[df[cat_col].isin(valid_cats)]


# ============================================================
# Treinar um modelo
# ============================================================
def train_model(X_train, y_train, weights_train, X_test, y_test, model_name):
    """Treina SGDClassifier (Logistic Regression) e avalia"""
    print(f"\n{'='*60}")
    print(f"Treinando: {model_name}")
    print(f"  Train: {X_train.shape[0]} amostras, {X_train.shape[1]} features")
    print(f"  Test: {X_test.shape[0]} amostras")
    print(f"  Classes: {len(np.unique(y_train))}")

    clf = SGDClassifier(
        loss="log_loss",
        penalty="l2",
        alpha=1e-4,
        max_iter=1000,
        tol=1e-3,
        random_state=RANDOM_STATE,
        class_weight="balanced"
    )

    clf.fit(X_train, y_train, sample_weight=weights_train)

    y_pred = clf.predict(X_test)
    accuracy = accuracy_score(y_test, y_pred)
    report = classification_report(y_test, y_pred, output_dict=True, zero_division=0)

    print(f"  Accuracy: {accuracy:.4f}")
    print(f"  Macro F1: {report['macro avg']['f1-score']:.4f}")

    # Mostrar performance por classe
    print(f"\n  Detalhes por classe:")
    for label in sorted(np.unique(y_test)):
        if label in report:
            r = report[label]
            print(f"    {label:30s} P={r['precision']:.2f} R={r['recall']:.2f} F1={r['f1-score']:.2f} n={r['support']}")

    return clf, accuracy, report


# ============================================================
# Exportar para ONNX
# ============================================================
def export_to_onnx(model, n_features, output_path, model_name):
    """Exporta sklearn model para ONNX"""
    initial_type = [("float_input", FloatTensorType([None, n_features]))]

    onnx_model = convert_sklearn(
        model,
        model_name,
        initial_types=initial_type,
        target_opset=15
    )

    with open(output_path, "wb") as f:
        f.write(onnx_model.SerializeToString())

    size_kb = os.path.getsize(output_path) / 1024
    print(f"  Exportado: {output_path} ({size_kb:.1f} KB)")

    # Validar ONNX
    sess = ort.InferenceSession(output_path)
    test_input = np.random.randn(1, n_features).astype(np.float32)
    result = sess.run(None, {"float_input": test_input})
    print(f"  Validação ONNX OK (output shape: {result[0].shape})")

    return True


# ============================================================
# Pipeline principal
# ============================================================
def main():
    print("=" * 60)
    print("ORNE Categorizador - Treinamento ML")
    print(f"Data: {datetime.now().strftime('%Y-%m-%d %H:%M')}")
    print("=" * 60)

    # 1. Buscar dados
    dados = fetch_training_data()

    if len(dados) < MIN_TOTAL_SAMPLES:
        print(f"\nERRO: Poucos dados para treino ({len(dados)} < {MIN_TOTAL_SAMPLES})")
        print("Importe mais faturas e categorize transações antes de treinar.")
        sys.exit(1)

    # 2. Preparar dataset
    df = prepare_dataset(dados)

    # 3. TF-IDF Vectorizer (character n-grams)
    print("\nFitando TF-IDF vectorizer...")
    tfidf = TfidfVectorizer(
        analyzer="char_wb",
        ngram_range=(2, 4),
        max_features=TFIDF_MAX_FEATURES,
        lowercase=False,  # já normalizamos manualmente
        strip_accents=None  # já removemos acentos
    )
    tfidf_matrix = tfidf.fit_transform(df["descricao_norm"])
    print(f"  Vocabulário: {len(tfidf.vocabulary_)} termos")

    # 4. Features adicionais: banco (one-hot) + log(valor)
    banco_features = np.array([
        encode_banco(b, BANCOS_CONHECIDOS) for b in df["banco"]
    ])
    valor_features = df["log_valor"].values.reshape(-1, 1).astype(np.float32)

    # Combinar features
    X_full = hstack([
        tfidf_matrix,
        csr_matrix(banco_features),
        csr_matrix(valor_features)
    ])

    n_features = X_full.shape[1]
    print(f"  Features totais: {n_features} (TF-IDF: {tfidf_matrix.shape[1]}, banco: {banco_features.shape[1]}, valor: 1)")

    # 5. Salvar vocabulário para o JS
    vocabulary_data = {
        "terms": tfidf.get_feature_names_out().tolist(),
        "idf": tfidf.idf_.tolist(),
        "bancos": BANCOS_CONHECIDOS,
        "n_features": n_features,
        "tfidf_size": len(tfidf.vocabulary_),
        "banco_size": len(BANCOS_CONHECIDOS),
        "numeric_size": 1
    }

    os.makedirs(OUTPUT_DIR, exist_ok=True)
    vocab_path = os.path.join(OUTPUT_DIR, "vocabulary.json")
    with open(vocab_path, "w", encoding="utf-8") as f:
        json.dump(vocabulary_data, f, ensure_ascii=False)
    print(f"  Vocabulário salvo: {vocab_path}")

    # ========================================================
    # MODELO 1: Classificador PJ vs PF (tipo)
    # ========================================================
    print("\n" + "=" * 60)
    print("ESTÁGIO 1: Classificador PJ vs PF")

    y_tipo = df["tipo"].values
    weights = df["sample_weight"].values

    X_train, X_test, y_train, y_test, w_train, w_test = train_test_split(
        X_full, y_tipo, weights,
        test_size=TEST_SIZE,
        stratify=y_tipo,
        random_state=RANDOM_STATE
    )

    clf_tipo, acc_tipo, report_tipo = train_model(
        X_train, y_train, w_train,
        X_test, y_test,
        "categorizer_tipo"
    )

    # ========================================================
    # MODELO 2: Classificador de categorias PJ
    # ========================================================
    print("\n" + "=" * 60)
    print("ESTÁGIO 2a: Classificador categorias PJ")

    df_pj = df[df["tipo"] == "PJ"].copy()
    df_pj = filter_rare_categories(df_pj, "tipo", "categoria", MIN_SAMPLES_PER_CLASS)

    acc_pj = 0
    report_pj = {}
    clf_pj = None
    pj_labels = []

    if len(df_pj) >= 10:
        X_pj = X_full[df_pj.index]
        y_pj = df_pj["categoria"].values
        w_pj = df_pj["sample_weight"].values
        pj_labels = sorted(df_pj["categoria"].unique().tolist())

        if len(pj_labels) >= 2:
            X_tr, X_te, y_tr, y_te, w_tr, _ = train_test_split(
                X_pj, y_pj, w_pj,
                test_size=TEST_SIZE,
                stratify=y_pj,
                random_state=RANDOM_STATE
            )

            clf_pj, acc_pj, report_pj = train_model(
                X_tr, y_tr, w_tr,
                X_te, y_te,
                "categorizer_pj"
            )
        else:
            print("  SKIP: Apenas 1 categoria PJ. Modelo não treinado.")
    else:
        print(f"  SKIP: Poucos dados PJ ({len(df_pj)} registros)")

    # ========================================================
    # MODELO 3: Classificador de categorias PF
    # ========================================================
    print("\n" + "=" * 60)
    print("ESTÁGIO 2b: Classificador categorias PF")

    df_pf = df[df["tipo"] == "PF"].copy()
    df_pf = filter_rare_categories(df_pf, "tipo", "categoria", MIN_SAMPLES_PER_CLASS)

    acc_pf = 0
    report_pf = {}
    clf_pf = None
    pf_labels = []

    if len(df_pf) >= 10:
        X_pf = X_full[df_pf.index]
        y_pf = df_pf["categoria"].values
        w_pf = df_pf["sample_weight"].values
        pf_labels = sorted(df_pf["categoria"].unique().tolist())

        if len(pf_labels) >= 2:
            X_tr, X_te, y_tr, y_te, w_tr, _ = train_test_split(
                X_pf, y_pf, w_pf,
                test_size=TEST_SIZE,
                stratify=y_pf,
                random_state=RANDOM_STATE
            )

            clf_pf, acc_pf, report_pf = train_model(
                X_tr, y_tr, w_tr,
                X_te, y_te,
                "categorizer_pf"
            )
        else:
            print("  SKIP: Apenas 1 categoria PF. Modelo não treinado.")
    else:
        print(f"  SKIP: Poucos dados PF ({len(df_pf)} registros)")

    # ========================================================
    # Exportar modelos ONNX
    # ========================================================
    print("\n" + "=" * 60)
    print("Exportando modelos ONNX...")

    exported = []

    # Tipo
    tipo_path = os.path.join(OUTPUT_DIR, "categorizer_tipo.onnx")
    if export_to_onnx(clf_tipo, n_features, tipo_path, "categorizer_tipo"):
        exported.append("categorizer_tipo.onnx")

    # PJ
    if clf_pj is not None:
        pj_path = os.path.join(OUTPUT_DIR, "categorizer_pj.onnx")
        if export_to_onnx(clf_pj, n_features, pj_path, "categorizer_pj"):
            exported.append("categorizer_pj.onnx")

    # PF
    if clf_pf is not None:
        pf_path = os.path.join(OUTPUT_DIR, "categorizer_pf.onnx")
        if export_to_onnx(clf_pf, n_features, pf_path, "categorizer_pf"):
            exported.append("categorizer_pf.onnx")

    # ========================================================
    # Salvar label maps
    # ========================================================
    label_maps = {
        "tipo": ["PF", "PJ"],
        "pj": pj_labels,
        "pf": pf_labels
    }

    labels_path = os.path.join(OUTPUT_DIR, "label_maps.json")
    with open(labels_path, "w", encoding="utf-8") as f:
        json.dump(label_maps, f, ensure_ascii=False, indent=2)
    print(f"\nLabel maps salvos: {labels_path}")

    # ========================================================
    # Salvar relatório de treinamento
    # ========================================================
    training_report = {
        "timestamp": datetime.now().isoformat(),
        "total_samples": len(df),
        "manual_corrections": int(df[df["metodo"] == "manual"].shape[0]),
        "models": {
            "tipo": {
                "accuracy": acc_tipo,
                "macro_f1": report_tipo.get("macro avg", {}).get("f1-score", 0),
                "classes": list(np.unique(y_tipo)),
                "n_train": X_train.shape[0],
                "n_test": X_test.shape[0]
            },
            "pj": {
                "accuracy": acc_pj,
                "macro_f1": report_pj.get("macro avg", {}).get("f1-score", 0) if report_pj else 0,
                "classes": pj_labels,
                "n_train": len(df_pj) - int(len(df_pj) * TEST_SIZE) if len(df_pj) > 0 else 0,
                "n_test": int(len(df_pj) * TEST_SIZE) if len(df_pj) > 0 else 0
            },
            "pf": {
                "accuracy": acc_pf,
                "macro_f1": report_pf.get("macro avg", {}).get("f1-score", 0) if report_pf else 0,
                "classes": pf_labels,
                "n_train": len(df_pf) - int(len(df_pf) * TEST_SIZE) if len(df_pf) > 0 else 0,
                "n_test": int(len(df_pf) * TEST_SIZE) if len(df_pf) > 0 else 0
            }
        },
        "feature_config": {
            "tfidf_max_features": TFIDF_MAX_FEATURES,
            "ngram_range": [2, 4],
            "n_features_total": n_features,
            "bancos": BANCOS_CONHECIDOS
        },
        "exported_files": exported
    }

    report_path = os.path.join(OUTPUT_DIR, "training_report.json")
    with open(report_path, "w", encoding="utf-8") as f:
        json.dump(training_report, f, ensure_ascii=False, indent=2)

    # ========================================================
    # Resumo final
    # ========================================================
    print("\n" + "=" * 60)
    print("RESUMO DO TREINAMENTO")
    print("=" * 60)
    print(f"  Dados: {len(df)} transações ({df[df['metodo'] == 'manual'].shape[0]} manuais)")
    print(f"  Tipo (PJ/PF): accuracy={acc_tipo:.4f}")
    if clf_pj:
        print(f"  Categorias PJ: accuracy={acc_pj:.4f} ({len(pj_labels)} classes)")
    if clf_pf:
        print(f"  Categorias PF: accuracy={acc_pf:.4f} ({len(pf_labels)} classes)")
    print(f"  Modelos exportados: {', '.join(exported)}")
    print(f"  Diretório: {OUTPUT_DIR}")
    print(f"\nRelatório salvo: {report_path}")
    print("\nPróximo passo: faça deploy ou rode 'npm run dev' para usar os modelos.")


if __name__ == "__main__":
    main()
