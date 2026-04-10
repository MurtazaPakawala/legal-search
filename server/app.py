import os
import re
import time
from pathlib import Path
from typing import Any, Optional
from urllib.parse import urlparse

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from starlette.staticfiles import StaticFiles

from isaacus import Isaacus

load_dotenv()

BASE_DIR = Path(__file__).resolve().parent.parent
DIST_DIR = BASE_DIR / "dist"

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

documents: list[dict] = []

DEFAULT_DOCUMENTS = [
    {
        "id": "default-apple-tos",
        "title": "apple-tos.txt",
        "sourceUrl": "https://examples.isaacus.com/apple-tos.txt",
    },
    {
        "id": "default-github-tos",
        "title": "github-tos.md",
        "sourceUrl": "https://examples.isaacus.com/github-tos.md",
    },
]

api_key = os.getenv("ISAACUS_API_KEY")
client = Isaacus(api_key=api_key, timeout=20.0) if api_key else None


class DocumentCreateRequest(BaseModel):
    title: str = ""
    sourceUrl: str


class RerankRequest(BaseModel):
    query: str


class DocumentSearchRequest(BaseModel):
    query: str


def to_document_summary(document: dict) -> dict:
    return {
        "id": document["id"],
        "title": document["title"],
        "sourceUrl": document["sourceUrl"],
        "hasEnrichment": document.get("enrichment") is not None,
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


def find_document(document_id: str) -> Optional[dict]:
    return next((document for document in documents if document["id"] == document_id), None)


def span_payload(span: Optional[dict], text: str) -> Optional[dict]:
    if not span:
        return None

    start = span.get("start")
    end = span.get("end")
    if not isinstance(start, int) or not isinstance(end, int):
        return span

    return {
        **span,
        "text": text[start:end],
    }


def serialize_enrichment_value(value: Any, source_text: str) -> Any:
    if hasattr(value, "to_dict"):
        value = value.to_dict(mode="json", exclude_none=False)

    if isinstance(value, list):
        return [serialize_enrichment_value(item, source_text) for item in value]

    if isinstance(value, dict):
        if set(value.keys()) == {"start", "end"}:
            return span_payload(value, source_text)

        return {
            key: serialize_enrichment_value(item, source_text)
            for key, item in value.items()
        }

    return value


def has_content(value: Any) -> bool:
    if value is None:
        return False

    if isinstance(value, str):
        return bool(value.strip())

    if isinstance(value, list):
        return len(value) > 0

    if isinstance(value, dict):
        return len(value) > 0

    return True


def build_document_fields(document: dict) -> list[dict]:
    enrichment = document.get("enrichment")
    if not enrichment:
        return []

    source_text = enrichment["text"]
    raw_fields = [
        ("text", "Text", source_text),
        ("title", "Title", enrichment.get("title")),
        ("subtitle", "Subtitle", enrichment.get("subtitle")),
        ("type", "Type", enrichment.get("type")),
        ("jurisdiction", "Jurisdiction", enrichment.get("jurisdiction")),
        ("segments", "Segments", enrichment.get("segments")),
        ("crossreferences", "Crossreferences", enrichment.get("crossreferences")),
        ("locations", "Locations", enrichment.get("locations")),
        ("persons", "Persons", enrichment.get("persons")),
        ("emails", "Emails", enrichment.get("emails")),
        ("websites", "Websites", enrichment.get("websites")),
        ("phone_numbers", "Phone Numbers", enrichment.get("phone_numbers")),
        ("id_numbers", "ID Numbers", enrichment.get("id_numbers")),
        ("terms", "Terms", enrichment.get("terms")),
        ("external_documents", "External Documents", enrichment.get("external_documents")),
        ("quotes", "Quotes", enrichment.get("quotes")),
        ("dates", "Dates", enrichment.get("dates")),
        ("headings", "Headings", enrichment.get("headings")),
        ("junk", "Junk", enrichment.get("junk")),
        ("version", "Version", enrichment.get("version")),
    ]

    fields = []
    for field_id, label, value in raw_fields:
        serialized = serialize_enrichment_value(value, source_text)
        fields.append(
            {
                "id": field_id,
                "label": label,
                "hasValue": has_content(serialized),
                "value": serialized,
            }
        )

    return fields


def build_document_record(
    *,
    document_id: str,
    title: str,
    source_url: str,
    text: str,
    enrichment: dict,
) -> dict:
    return {
        "id": document_id,
        "title": title,
        "sourceUrl": source_url,
        "text": text,
        "enrichment": enrichment,
    }


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


async def enrich_document_text(text: str) -> dict:
    if not client:
        raise HTTPException(
            status_code=500,
            detail="ISAACUS_API_KEY is missing. Add it to a local .env file before calling the API.",
        )

    enrichment_response = client.enrichments.create(
        model="kanon-2-enricher",
        texts=text,
        overflow_strategy="auto",
    )
    return enrichment_response.results[0].document.to_dict(
        mode="json",
        exclude_none=False,
    )


async def ensure_default_documents() -> None:
    if documents:
        return

    for item in DEFAULT_DOCUMENTS:
        text = await fetch_document_text(item["sourceUrl"])
        enrichment = await enrich_document_text(text)
        documents.append(
            build_document_record(
                document_id=item["id"],
                title=item["title"],
                source_url=item["sourceUrl"],
                text=text,
                enrichment=enrichment,
            )
        )


@app.get("/api/health")
async def health() -> dict:
    await ensure_default_documents()
    return {
        "ok": True,
        "hasApiKey": bool(api_key),
        "documentCount": len(documents),
    }


@app.get("/api/documents")
async def get_documents() -> dict:
    await ensure_default_documents()
    return {
        "documents": [to_document_summary(document) for document in documents],
    }


@app.get("/api/documents/{document_id}")
async def get_document(document_id: str) -> dict:
    await ensure_default_documents()
    document = find_document(document_id)
    if document is None:
        raise HTTPException(status_code=404, detail="Document not found.")

    return {
        "document": to_document_summary(document),
        "fields": build_document_fields(document),
    }


@app.post("/api/documents/{document_id}/search")
async def search_document(document_id: str, payload: DocumentSearchRequest) -> dict:
    await ensure_default_documents()
    document = find_document(document_id)
    if document is None:
        raise HTTPException(status_code=404, detail="Document not found.")

    query = payload.query.strip()
    if not query:
        raise HTTPException(status_code=400, detail="Search query is required.")

    if not client:
        raise HTTPException(
            status_code=500,
            detail="ISAACUS_API_KEY is missing. Add it to a local .env file before calling the API.",
        )

    response = client.extractions.qa.create(
        model="kanon-answer-extractor",
        query=query,
        texts=[document["text"]],
    )

    extraction = response.extractions[0] if response.extractions else None
    answer = extraction.answers[0] if extraction and extraction.answers else None

    return {
        "query": query,
        "answer": {
            "text": answer.text if answer else None,
            "score": answer.score if answer else None,
        },
    }


@app.post("/api/documents", status_code=201)
async def create_document(payload: DocumentCreateRequest) -> dict:
    await ensure_default_documents()
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

    enriched_document = await enrich_document_text(text)

    document = build_document_record(
        document_id=f"linked-{int(time.time() * 1000)}",
        title=title or extract_title_from_url(source_url),
        source_url=source_url,
        text=text,
        enrichment=enriched_document,
    )
    documents.insert(0, document)

    return {
        "document": to_document_summary(document),
    }


@app.delete("/api/documents/{document_id}", status_code=204)
async def delete_document(document_id: str) -> None:
    await ensure_default_documents()
    index: Optional[int] = next((i for i, document in enumerate(documents) if document["id"] == document_id), None)
    if index is None:
        raise HTTPException(status_code=404, detail="Document not found.")

    documents.pop(index)


@app.post("/api/rerank")
async def rerank_documents(payload: RerankRequest) -> dict:
    await ensure_default_documents()
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


if (DIST_DIR / "assets").exists():
    app.mount("/assets", StaticFiles(directory=DIST_DIR / "assets"), name="assets")


@app.get("/{full_path:path}", include_in_schema=False)
async def serve_frontend(full_path: str) -> FileResponse:
    if full_path.startswith("api/"):
        raise HTTPException(status_code=404, detail="Not found.")

    index_file = DIST_DIR / "index.html"
    if not index_file.exists():
        raise HTTPException(status_code=404, detail="Frontend build not found.")

    return FileResponse(index_file)
