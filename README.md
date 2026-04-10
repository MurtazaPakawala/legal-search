# Legal Search Demo

Small demo app for exploring legal documents with Isaacus.

## What it does

- Reranking: compares the loaded documents against your query and orders them by relevance.
- Extraction search: lets you ask a direct question about one document and returns the best answer only.
- Enrichment: structures each document into useful legal fields like title, headings, dates, terms, and more.

## Links

- Please visit the demo here: `https://legal-search-24q0.onrender.com/`
- Please visit Isaacus here: https://docs.isaacus.com/welcome

## Installation

```bash
npm install
python -m pip install -r requirements.txt
```

## Environment

Create a `.env` file in the project root and add:

```env
ISAACUS_API_KEY=your_api_key_here
PORT=3001
```

## Run locally

```bash
npm run dev
```
