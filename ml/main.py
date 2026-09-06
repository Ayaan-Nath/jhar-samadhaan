"""
SIH 26043 - AI Triage Microservice (FastAPI)

Generates 384-dimensional Sentence-BERT embeddings for complaint text and
suggests a domain category from the fixed taxonomy
(AGR, WAT, HLT, EDU, PWR, INF, SWM, OTH).

Run locally:
    pip install -r requirements.txt
    uvicorn main:app --reload --port 8000

Endpoints:
    GET  /health            liveness + model readiness
    POST /api/v1/embed      {"text": "..."} -> {"embedding": [...384 floats],
                                                "suggested_category": "WAT"}

Env vars (optional):
    MODEL_NAME      sentence-transformers model id (default all-MiniLM-L6-v2)
    CORS_ORIGINS    comma-separated origins (default: local Next.js dev servers)
"""

import logging
import os
from contextlib import asynccontextmanager

import numpy as np
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

logger = logging.getLogger("sih26-ai-triage")

EMBEDDING_DIM = 384  # all-MiniLM-L6-v2 output dimension
MODEL_NAME = os.environ.get("MODEL_NAME", "all-MiniLM-L6-v2")
COSINE_THRESHOLD = 0.28  # below this, cosine match is too weak -> OTH

# ---------------------------------------------------------------------------
# Fixed domain taxonomy (must mirror db/schema.sql Categories codes)
# ---------------------------------------------------------------------------

DOMAIN_CODES = ("AGR", "WAT", "HLT", "EDU", "PWR", "INF", "SWM", "OTH")

# Keyword classifier: {code: [keywords...]} (lower-case substring match)
DOMAIN_KEYWORDS: dict[str, tuple[str, ...]] = {
    "AGR": (
        "crop", "farmer", "farming", "agriculture", "pesticide", "fertiliser",
        "fertilizer", "irrigation", "mandi", "kisan", "fasal", "kheti",
        "sichai", "seed", "soil", "cattle", "livestock", "paddy", "wheat",
    ),
    "WAT": (
        "drinking water", "water supply", "pipeline", "leak", "sewage",
        "drainage", "drain", "borewell", "handpump", "hand pump", "jal",
        "paani", "nala", "toilet", "sanitation", "flood", "tap",
    ),
    "HLT": (
        "hospital", "health", "doctor", "medicine", "ambulance", "vaccine",
        "clinic", "asha", "swasthya", "pharmacy", "health centre", "drug",
    ),
    "EDU": (
        "school", "teacher", "student", "education", "college", "scholarship",
        "mid-day meal", "mid day meal", "classroom", "vidyalaya", "pathshala",
        "adhyapak", "exam",
    ),
    "PWR": (
        "electricity", "power cut", "power", "transformer", "voltage",
        "bijli", "current", "meter", "wire", "outage", "electrocution",
        "electric pole", "street light",
    ),
    "INF": (
        "road", "pothole", "bridge", "footpath", "culvert", "highway",
        "sadak", "pul", "pavement", "flyover", "construction",
    ),
    "SWM": (
        "garbage", "waste", "litter", "dumping", "dump", "kachra", "kuda",
        "cleanliness", "stench", "rubbish", "plastic", "bin", "odour",
    ),
    "OTH": (),
}

# Cosine-similarity classifier: representative exemplar complaints per domain.
# Embeddings of these sentences are averaged into one normalized centroid per
# code at startup; incoming text is matched by cosine similarity.
DOMAIN_EXEMPLARS: dict[str, tuple[str, ...]] = {
    "AGR": (
        "Crop damaged because the irrigation canal has no water supply",
        "Local farmer is not receiving the promised seed subsidy",
        "Pesticide spraying from the farm is affecting nearby cattle",
    ),
    "WAT": (
        "Water pipeline has been leaking on the street for a week",
        "No drinking water in our ward since morning",
        "Drain is blocked and sewage is overflowing into the lane",
    ),
    "HLT": (
        "The primary health centre has no doctor for several days",
        "Ambulance did not arrive despite repeated calls",
        "Vaccination camp scheduled by the ASHA worker was cancelled",
    ),
    "EDU": (
        "Government school has a shortage of teachers for primary classes",
        "Mid-day meal quality is poor at the local school",
        "Students cannot attend classes because the school building leaks",
    ),
    "PWR": (
        "Transformer blasted and the whole village has no electricity",
        "Power cut lasting more than a day in our colony",
        "Electric pole is damaged and wires are hanging low",
    ),
    "INF": (
        "Large potholes on the main road are causing accidents",
        "The bridge connecting two villages is broken",
        "Footpath is missing on a busy stretch near the market",
    ),
    "SWM": (
        "Garbage is not collected from the neighbourhood for weeks",
        "Solid waste is being dumped openly near the water body",
        "Street is littered and needs a cleanliness drive",
    ),
    "OTH": (
        "I need information about government schemes in my area",
        "A government office is not responding to citizens",
    ),
}

# ---------------------------------------------------------------------------
# Pydantic request model
# ---------------------------------------------------------------------------


class EmbedRequest(BaseModel):
    text: str = Field(
        ...,
        min_length=1,
        max_length=5000,
        description="Canonical complaint text (English, post Bhashini translation).",
        examples=["Water pipeline has been leaking on the street for a week"],
    )


# ---------------------------------------------------------------------------
# Model + classifier internals
# ---------------------------------------------------------------------------


def _load_model(model_name: str):
    """Loads the SentenceTransformer; heavy, so only run once at startup."""
    from sentence_transformers import SentenceTransformer  # deferred import

    return SentenceTransformer(model_name)


def _build_domain_vectors(model) -> dict[str, np.ndarray]:
    """Encodes every exemplar sentence and returns one L2-normalized centroid
    vector per domain code."""
    texts: list[str] = []
    owners: list[str] = []
    for code, examples in DOMAIN_EXEMPLARS.items():
        for example in examples:
            texts.append(example)
            owners.append(code)

    encoded = model.encode(texts, normalize_embeddings=True, convert_to_numpy=True)

    by_code: dict[str, list[np.ndarray]] = {}
    for code, vector in zip(owners, encoded):
        by_code.setdefault(code, []).append(vector)

    centroids: dict[str, np.ndarray] = {}
    for code, vectors in by_code.items():
        centroid = np.mean(np.stack(vectors), axis=0)
        norm = np.linalg.norm(centroid)
        centroids[code] = (centroid / norm).astype(np.float32) if norm > 0 else centroid.astype(np.float32)
    return centroids


def _keyword_category(text_lower: str) -> str | None:
    """Deterministic first pass: domain with the most keyword hits (>=1)."""
    best_code: str | None = None
    best_hits = 0
    for code, keywords in DOMAIN_KEYWORDS.items():
        if not keywords:
            continue
        hits = sum(1 for keyword in keywords if keyword in text_lower)
        if hits > best_hits:
            best_hits = hits
            best_code = code
    return best_code if best_hits > 0 else None


def _cosine_category(
    vector: np.ndarray, domain_vectors: dict[str, np.ndarray]
) -> str:
    """Second pass: nearest domain centroid by cosine similarity (with a
    confidence floor so unrelated text falls back to OTH)."""
    best_code = "OTH"
    best_score = -1.0
    for code, centroid in domain_vectors.items():
        score = float(np.dot(vector, centroid))
        if score > best_score:
            best_score = score
            best_code = code
    return best_code if best_score >= COSINE_THRESHOLD else "OTH"


# ---------------------------------------------------------------------------
# App + lifespan (loads the model once, before serving)
# ---------------------------------------------------------------------------


@asynccontextmanager
async def lifespan(app: FastAPI):
    try:
        app.state.model = _load_model(MODEL_NAME)
        app.state.domain_vectors = _build_domain_vectors(app.state.model)
        logger.info("Model %s loaded (%d-dim embeddings ready)", MODEL_NAME, EMBEDDING_DIM)
    except Exception as exc:  # noqa: BLE001 - keep the API up, report degraded
        logger.exception("Failed to load model at startup: %s", exc)
        app.state.model = None
        app.state.domain_vectors = {}
    yield


app = FastAPI(
    title="SIH26 AI Triage",
    description="Sentence-BERT embedding + domain classification for complaint intake.",
    version="0.1.0",
    lifespan=lifespan,
)

# CORS for local development (Next.js dev server). Override via CORS_ORIGINS.
_default_origins = ["http://localhost:3000", "http://127.0.0.1:3000"]
_origins = [
    origin.strip()
    for origin in os.environ.get("CORS_ORIGINS", "").split(",")
    if origin.strip()
] or _default_origins

app.add_middleware(
    CORSMiddleware,
    allow_origins=_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@app.get("/health", tags=["ops"])
def health() -> dict:
    model = getattr(app.state, "model", None)
    return {
        "status": "ok" if model is not None else "degraded",
        "service": "sih26-ai-triage",
        "model": MODEL_NAME,
        "model_loaded": model is not None,
        "embedding_dim": EMBEDDING_DIM,
        "supported_categories": list(DOMAIN_CODES),
    }


@app.post("/api/v1/embed", tags=["triage"])
def embed_text(payload: EmbedRequest) -> dict:
    model = getattr(app.state, "model", None)
    domain_vectors: dict[str, np.ndarray] = getattr(app.state, "domain_vectors", {})

    if model is None:
        raise HTTPException(
            status_code=503,
            detail="Embedding model is not loaded. Check service logs.",
        )

    text = payload.text.strip()
    if not text:
        raise HTTPException(status_code=422, detail="text must not be empty.")

    # Single encode pass: used both for the returned vector and classification.
    vector: np.ndarray = model.encode(
        [text], normalize_embeddings=True, convert_to_numpy=True
    )[0]

    if vector.shape[0] != EMBEDDING_DIM:
        logger.warning(
            "Model returned %d dims instead of %d", vector.shape[0], EMBEDDING_DIM
        )

    # 1) deterministic keyword pass, 2) semantic cosine pass, 3) fallback
    category = _keyword_category(text.lower())
    if category is None and domain_vectors:
        category = _cosine_category(vector.astype(np.float32), domain_vectors)
    if category is None:
        category = "OTH"

    return {
        "embedding": vector.astype(float).tolist(),
        "suggested_category": category,
    }
