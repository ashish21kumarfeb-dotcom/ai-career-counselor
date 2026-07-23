"""Shared judge/embedding configuration for the offline evaluation harness.

No new vendors: the judge LLM is Groq via its OpenAI-compatible endpoint
(reuses GROQ_API_KEY from the repo's .env), and embeddings are Voyage (reuses
VOYAGE_API_KEY, the same provider the app's RAG embeddings use). Temperature 0
everywhere: judge variance is noise the regression comparison cannot afford.
"""

import os

from langchain_openai import ChatOpenAI
from langchain_voyageai import VoyageAIEmbeddings

GROQ_BASE_URL = "https://api.groq.com/openai/v1"
JUDGE_MODEL = os.environ.get("GROQ_EVAL_MODEL", "llama-3.3-70b-versatile")
EMBED_MODEL = os.environ.get("VOYAGE_EVAL_MODEL", "voyage-3.5-lite")


def require_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise SystemExit(f"[eval] {name} is required (set it in the environment or repo .env).")
    return value


def judge_llm() -> ChatOpenAI:
    return ChatOpenAI(
        base_url=GROQ_BASE_URL,
        api_key=require_env("GROQ_API_KEY"),
        model=JUDGE_MODEL,
        temperature=0,
    )


def embeddings() -> VoyageAIEmbeddings:
    return VoyageAIEmbeddings(
        voyage_api_key=require_env("VOYAGE_API_KEY"),
        model=EMBED_MODEL,
    )
