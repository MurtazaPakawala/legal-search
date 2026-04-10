import 'dotenv/config';
import cors from 'cors';
import express from 'express';
import Isaacus from 'isaacus';

const app = express();
const port = Number(process.env.PORT || 3001);

const documents = [
  {
    id: 'nda-1',
    title: 'Confidentiality Clause',
    sourceUrl: null,
    text: 'The receiving party must keep all proprietary information strictly confidential and may only disclose it with prior written consent.',
  },
  {
    id: 'payment-1',
    title: 'Payment Terms',
    sourceUrl: null,
    text: 'Invoices are payable within thirty days of receipt. Late payments accrue interest at one percent per month.',
  },
  {
    id: 'termination-1',
    title: 'Termination Rights',
    sourceUrl: null,
    text: 'Either party may terminate the agreement with fourteen days written notice if the other party materially breaches the contract.',
  },
  {
    id: 'ip-1',
    title: 'Intellectual Property',
    sourceUrl: null,
    text: 'All software, documentation, and derivative materials created under this agreement remain the exclusive property of the provider.',
  },
];

const client = process.env.ISAACUS_API_KEY
  ? new Isaacus({
      apiKey: process.env.ISAACUS_API_KEY,
      timeout: 20_000,
    })
  : null;

app.use(cors());
app.use(express.json());

function toDocumentSummary(document) {
  return {
    id: document.id,
    title: document.title,
    sourceUrl: document.sourceUrl,
    preview: document.text.slice(0, 180),
  };
}

function extractTitleFromUrl(url) {
  try {
    const parsedUrl = new URL(url);
    const lastSegment = parsedUrl.pathname.split('/').filter(Boolean).at(-1);
    return lastSegment || parsedUrl.hostname;
  } catch {
    return 'Linked document';
  }
}

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&');
}

function normalizeText(value) {
  return value.replace(/\s+/g, ' ').trim();
}

async function fetchDocumentText(sourceUrl) {
  const response = await fetch(sourceUrl);

  if (!response.ok) {
    throw new Error(`Unable to fetch URL. Upstream returned ${response.status}.`);
  }

  const contentType = response.headers.get('content-type') || '';
  const body = await response.text();

  if (contentType.includes('text/html')) {
    return normalizeText(stripHtml(body));
  }

  if (
    contentType.includes('text/plain') ||
    contentType.includes('application/json') ||
    contentType.includes('application/xml') ||
    contentType.includes('text/xml')
  ) {
    return normalizeText(body);
  }

  throw new Error(
    `Unsupported content type: ${contentType || 'unknown'}. Use a text or HTML URL for now.`,
  );
}

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    hasApiKey: Boolean(process.env.ISAACUS_API_KEY),
    documentCount: documents.length,
  });
});

app.get('/api/documents', (_req, res) => {
  res.json({
    documents: documents.map(toDocumentSummary),
  });
});

app.post('/api/documents', async (req, res) => {
  const sourceUrl =
    typeof req.body?.sourceUrl === 'string' ? req.body.sourceUrl.trim() : '';
  const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';

  if (!sourceUrl) {
    return res.status(400).json({ error: 'Document URL is required.' });
  }

  try {
    new URL(sourceUrl);
  } catch {
    return res.status(400).json({ error: 'Document URL must be a valid absolute URL.' });
  }

  try {
    const text = await fetchDocumentText(sourceUrl);

    if (!text) {
      return res.status(400).json({
        error: 'The fetched URL did not contain enough text to index.',
      });
    }

    const document = {
      id: `linked-${Date.now()}`,
      title: title || extractTitleFromUrl(sourceUrl),
      sourceUrl,
      text,
    };

    documents.unshift(document);

    return res.status(201).json({
      document: toDocumentSummary(document),
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Unable to add linked document.';

    return res.status(500).json({ error: message });
  }
});

app.post('/api/rerank', async (req, res) => {
  const query = typeof req.body?.query === 'string' ? req.body.query.trim() : '';

  if (!query) {
    return res.status(400).json({ error: 'Query is required.' });
  }

  if (!client) {
    return res.status(500).json({
      error: 'ISAACUS_API_KEY is missing. Add it to a local .env file before calling the API.',
    });
  }

  try {
    const response = await client.rerankings.create({
      model: 'kanon-universal-classifier',
      query,
      texts: documents.map((document) => document.text),
    });

    const results = response.results.map((result) => ({
      id: documents[result.index]?.id ?? `doc-${result.index}`,
      title: documents[result.index]?.title ?? `Document ${result.index + 1}`,
      text: documents[result.index]?.text ?? '',
      sourceUrl: documents[result.index]?.sourceUrl ?? null,
      score: result.score,
    }));

    return res.json({
      query,
      model: 'kanon-universal-classifier',
      results,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Unknown Isaacus API error';

    return res.status(500).json({
      error: message,
    });
  }
});

app.listen(port, () => {
  console.log(`Isaacus demo backend listening on http://localhost:${port}`);
});
