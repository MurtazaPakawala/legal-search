import os
import re
import time
from typing import Optional
from urllib.parse import urlparse

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from isaacus import Isaacus

load_dotenv()

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

documents: list[dict] = []

api_key = os.getenv("ISAACUS_API_KEY")
client = Isaacus(api_key=api_key, timeout=20.0) if api_key else None


class DocumentCreateRequest(BaseModel):
    title: str = ""
    sourceUrl: str


class RerankRequest(BaseModel):
    query: str


def to_document_summary(document: dict) -> dict:
    return {
        "id": document["id"],
        "title": document["title"],
        "sourceUrl": document["sourceUrl"],
    }


def extract_title_from_url(url: str) -> str:
    parsed = urlparse(url)
    last_segment = parsed.path.rstrip("/").split("/")[-1]
    return last_segment or parsed.netloc or "Linked document"


def strip_html(html: str) -> str:
    html = re.sub(r"<script[\s\S]*?</script>", " ", html, flags=re.IGNORECASE)
    html = re.sub(r"<style[\s\S]*?</style>", " ", html, flags=re.IGNORECASE)
    html = re.sub(r"<[^>]+>", " ", html)
    html = html.replace("&nbsp;", " ").replace("&amp;", "&")
    return html


def normalize_text(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip()


def looks_like_plain_text(body: str) -> bool:
    sample = body[:500]
    return re.search(r"<html[\s>]", sample, flags=re.IGNORECASE) is None and bool(
        re.search(r"[A-Za-z0-9]", sample)
    )


async def fetch_document_text(source_url: str) -> str:
    async with httpx.AsyncClient(follow_redirects=True, timeout=20.0) as http_client:
        response = await http_client.get(source_url)

    if response.status_code >= 400:
        raise HTTPException(
            status_code=500,
            detail=f"Unable to fetch URL. Upstream returned {response.status_code}.",
        )

    content_type = response.headers.get("content-type", "").lower()
    body = response.text
    pathname = urlparse(source_url).path.lower()

    if "text/html" in content_type:
        return normalize_text(strip_html(body))

    if any(
        entry in content_type
        for entry in [
            "text/plain",
            "text/markdown",
            "application/json",
            "application/xml",
            "text/xml",
        ]
    ):
        return normalize_text(body)

    if any(pathname.endswith(extension) for extension in [".md", ".txt", ".json", ".xml"]):
        return normalize_text(body)

    if looks_like_plain_text(body):
        return normalize_text(body)

    raise HTTPException(
        status_code=500,
        detail=f"Unsupported content type: {content_type or 'unknown'}. Use a text or HTML URL for now.",
    )


@app.get("/api/health")
async def health() -> dict:
    return {
        "ok": True,
        "hasApiKey": bool(api_key),
        "documentCount": len(documents),
    }


@app.get("/api/documents")
async def get_documents() -> dict:
    return {
        "documents": [to_document_summary(document) for document in documents],
    }


@app.post("/api/documents", status_code=201)
async def create_document(payload: DocumentCreateRequest) -> dict:
    source_url = payload.sourceUrl.strip()
    title = payload.title.strip()

    if not source_url:
        raise HTTPException(status_code=400, detail="Document URL is required.")

    parsed = urlparse(source_url)
    if not parsed.scheme or not parsed.netloc:
        raise HTTPException(
            status_code=400,
            detail="Document URL must be a valid absolute URL.",
        )

    text = await fetch_document_text(source_url)
    if not text:
        raise HTTPException(
            status_code=400,
            detail="The fetched URL did not contain enough text to index.",
        )

    document = {
        "id": f"linked-{int(time.time() * 1000)}",
        "title": title or extract_title_from_url(source_url),
        "sourceUrl": source_url,
        "text": text,
    }
    documents.insert(0, document)

    return {
        "document": to_document_summary(document),
    }


@app.delete("/api/documents/{document_id}", status_code=204)
async def delete_document(document_id: str) -> None:
    index: Optional[int] = next(
        (i for i, document in enumerate(documents) if document["id"] == document_id),
        None,
    )
    if index is None:
        raise HTTPException(status_code=404, detail="Document not found.")

    documents.pop(index)


@app.post("/api/rerank")
async def rerank_documents(payload: RerankRequest) -> dict:
    query = payload.query.strip()

    if not query:
        raise HTTPException(status_code=400, detail="Query is required.")

    if not client:
        raise HTTPException(
            status_code=500,
            detail="ISAACUS_API_KEY is missing. Add it to a local .env file before calling the API.",
        )

    if not documents:
        raise HTTPException(
            status_code=400,
            detail="Add at least one document before reranking.",
        )

    response = client.rerankings.create(
        model="kanon-2-reranker",
        query=query,
        texts=[document["text"] for document in documents],
    )

    results = []
    for result in response.results:
        document = documents[result.index] if result.index < len(documents) else None
        results.append(
            {
                "id": document["id"] if document else f"doc-{result.index}",
                "title": document["title"] if document else f"Document {result.index + 1}",
                "sourceUrl": document["sourceUrl"] if document else None,
                "score": result.score,
            }
        )

    return {
        "query": query,
        "model": "kanon-2-reranker",
        "results": results,
    }
