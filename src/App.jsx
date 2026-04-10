import { useEffect, useState } from 'react';
import deleteIcon from './assets/delete.svg';
import documentIcon from './assets/document.svg';
import linkIcon from './assets/link-svgrepo-com.svg';

export default function App() {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState({ ok: false, hasApiKey: false });
  const [documents, setDocuments] = useState([]);
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [addingDocument, setAddingDocument] = useState(false);
  const [error, setError] = useState('');
  const [documentError, setDocumentError] = useState('');
  const [detailsError, setDetailsError] = useState('');
  const [selectedDocument, setSelectedDocument] = useState(null);
  const [selectedFieldId, setSelectedFieldId] = useState('');
  const [documentForm, setDocumentForm] = useState({
    title: '',
    sourceUrl: '',
  });

  useEffect(() => {
    fetch('/api/health')
      .then((response) => response.json())
      .then((data) => setStatus(data))
      .catch(() => {
        setStatus({ ok: false, hasApiKey: false });
      });

    fetch('/api/documents')
      .then((response) => response.json())
      .then((data) => setDocuments(data.documents || []))
      .catch(() => {
        setDocuments([]);
      });
  }, []);

  async function refreshDocuments() {
    const response = await fetch('/api/documents');
    const data = await response.json();
    setDocuments(data.documents || []);
  }

  async function openDocumentDetails(documentId) {
    setDetailsError('');

    try {
      const response = await fetch(`/api/documents/${documentId}`);
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || data.detail || 'Unable to load document.');
      }

      const availableFields = (data.fields || []).filter((field) => field.hasValue);
      setSelectedDocument({
        ...data.document,
        fields: availableFields,
      });
      setSelectedFieldId(availableFields[0]?.id || '');
    } catch (requestError) {
      setDetailsError(
        requestError instanceof Error
          ? requestError.message
          : 'Unable to load document.',
      );
    }
  }

  async function handleSubmit(event) {
    event.preventDefault();
    setLoading(true);
    setError('');

    try {
      const response = await fetch('/api/rerank', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || data.detail || 'Request failed.');
      }

      setResults(data.results);
    } catch (requestError) {
      setError(
        requestError instanceof Error ? requestError.message : 'Request failed.',
      );
      setResults([]);
    } finally {
      setLoading(false);
    }
  }

  async function handleAddDocument(event) {
    event.preventDefault();
    setAddingDocument(true);
    setDocumentError('');

    try {
      const response = await fetch('/api/documents', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(documentForm),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || data.detail || 'Unable to add document.');
      }

      setDocumentForm({ title: '', sourceUrl: '' });
      await refreshDocuments();
      await openDocumentDetails(data.document.id);
      setStatus((currentStatus) => ({
        ...currentStatus,
        documentCount: (currentStatus.documentCount || 0) + 1,
      }));
    } catch (requestError) {
      setDocumentError(
        requestError instanceof Error
          ? requestError.message
          : 'Unable to add document.',
      );
    } finally {
      setAddingDocument(false);
    }
  }

  async function handleDeleteDocument(documentId) {
    setDocumentError('');
    const wasSelected = selectedDocument?.id === documentId;

    try {
      const response = await fetch(`/api/documents/${documentId}`, {
        method: 'DELETE',
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || data.detail || 'Unable to delete document.');
      }

      setDocuments((currentDocuments) =>
        currentDocuments.filter((document) => document.id !== documentId),
      );
      setResults((currentResults) =>
        currentResults.filter((result) => result.id !== documentId),
      );
      setSelectedDocument((currentDocument) =>
        currentDocument?.id === documentId ? null : currentDocument,
      );
      setSelectedFieldId((currentFieldId) => (wasSelected ? '' : currentFieldId));
      setStatus((currentStatus) => ({
        ...currentStatus,
        documentCount: Math.max((currentStatus.documentCount || 1) - 1, 0),
      }));
    } catch (requestError) {
      setDocumentError(
        requestError instanceof Error
          ? requestError.message
          : 'Unable to delete document.',
      );
    }
  }

  const activeField =
    selectedDocument?.fields?.find((field) => field.id === selectedFieldId) || null;

  function renderFieldValue(value) {
    if (typeof value === 'string') {
      return <pre className="field-pre">{value}</pre>;
    }

    return (
      <pre className="field-pre">{JSON.stringify(value, null, 2)}</pre>
    );
  }

  return (
    <>
      <main className="app-shell">
        <section className="hero">
          <p className="eyebrow">Isaacus + React</p>
          <h1>Legal Search (Demo)</h1>
          <p className="intro">
            Add document links, review the current file list, then send a legal-style
            query to the backend and visualize how Isaacus reranks the indexed text.
          </p>
        </section>

        <section className="workspace">
          <section className="panel main-panel">
            {detailsError ? <p className="error-box">{detailsError}</p> : null}

            <form className="query-form" onSubmit={handleSubmit}>
              <label htmlFor="query">Query</label>
              <textarea
                id="query"
                rows="4"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Describe what you want to find in the documents"
              />
              <button type="submit" disabled={loading}>
                {loading ? 'Ranking...' : 'Run reranking'}
              </button>
            </form>

            <div className="status-row">
              <span className={status.ok ? 'pill pill-live' : 'pill'}>
                Backend: {status.ok ? 'online' : 'offline'}
              </span>
              <span className={status.hasApiKey ? 'pill pill-live' : 'pill pill-warn'}>
                API key: {status.hasApiKey ? 'configured' : 'missing'}
              </span>
              <span className="pill">Docs: {documents.length}</span>
            </div>

            {error ? <p className="error-box">{error}</p> : null}

            <div className="results">
              {results.length === 0 ? (
                <p className="placeholder">
                  Run the demo to see ranked documents and their scores.
                </p>
              ) : (
                results.map((result) => (
                  <article className="result-card" key={result.id}>
                    <div className="result-head">
                      <div className="result-title-row">
                        <h2>{result.title}</h2>
                        {result.sourceUrl ? (
                          <a
                            className="icon-link"
                            href={result.sourceUrl}
                            target="_blank"
                            rel="noreferrer"
                            aria-label={`Open ${result.title}`}
                          >
                            <img src={linkIcon} alt="" />
                          </a>
                        ) : null}
                      </div>
                      <strong>{(result.score * 100).toFixed(1)}%</strong>
                    </div>
                    <div className="bar-track">
                      <div
                        className="bar-fill"
                        style={{ width: `${Math.max(result.score * 100, 4)}%` }}
                      />
                    </div>
                  </article>
                ))
              )}
            </div>
          </section>

          <aside className="sidebar panel">
            <form className="link-form" onSubmit={handleAddDocument}>
              <div className="sidebar-head">
                <h2>Files</h2>
                <span className="file-count">{documents.length}</span>
              </div>

              <input
                id="title"
                value={documentForm.title}
                onChange={(event) =>
                  setDocumentForm((current) => ({
                    ...current,
                    title: event.target.value,
                  }))
                }
                placeholder="Optional title"
              />

              <input
                id="sourceUrl"
                type="url"
                value={documentForm.sourceUrl}
                onChange={(event) =>
                  setDocumentForm((current) => ({
                    ...current,
                    sourceUrl: event.target.value,
                  }))
                }
                placeholder="Paste file link"
                required
              />

              <button type="submit" disabled={addingDocument}>
                {addingDocument ? 'Adding...' : 'Add file'}
              </button>
            </form>

            {documentError ? <p className="error-box">{documentError}</p> : null}

            <div className="document-list">
              {documents.length === 0 ? (
                <p className="placeholder">No files yet.</p>
              ) : (
                documents.map((document) => (
                  <article className="document-item" key={document.id}>
                    <div className="document-row">
                      <h3>{document.title}</h3>
                      {document.sourceUrl ? (
                        <div className="document-actions">
                          <a
                            className="icon-link"
                            href={document.sourceUrl}
                            target="_blank"
                            rel="noreferrer"
                            aria-label={`Open ${document.title}`}
                          >
                            <img src={linkIcon} alt="" />
                          </a>
                          <button
                            className="icon-button"
                            type="button"
                            onClick={() => openDocumentDetails(document.id)}
                            aria-label={`Inspect ${document.title}`}
                          >
                            <img src={documentIcon} alt="" />
                          </button>
                          <button
                            className="icon-button icon-button-delete"
                            type="button"
                            onClick={() => handleDeleteDocument(document.id)}
                            aria-label={`Delete ${document.title}`}
                          >
                            <img src={deleteIcon} alt="" />
                          </button>
                        </div>
                      ) : null}
                    </div>
                  </article>
                ))
              )}
            </div>
          </aside>
        </section>
      </main>

      {selectedDocument ? (
        <div
          className="modal-backdrop"
          onClick={() => setSelectedDocument(null)}
          role="presentation"
        >
          <section
            className="details-modal"
            onClick={(event) => event.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="document-details-title"
          >
            <div className="details-modal-head">
              <div className="details-head">
                <h3 id="document-details-title">Document details</h3>
                <span>{selectedDocument.title}</span>
              </div>
              <button
                className="modal-close"
                type="button"
                onClick={() => setSelectedDocument(null)}
                aria-label="Close document details"
              >
                Close
              </button>
            </div>

            <div className="field-tabs">
              {selectedDocument.fields.map((field) => (
                <button
                  key={field.id}
                  type="button"
                  className={
                    field.id === selectedFieldId
                      ? 'field-tab field-tab-active'
                      : 'field-tab'
                  }
                  onClick={() => setSelectedFieldId(field.id)}
                >
                  {field.label}
                </button>
              ))}
            </div>

            <div className="field-viewer field-viewer-modal">
              {activeField ? (
                <>
                  <h4>{activeField.label}</h4>
                  {renderFieldValue(activeField.value)}
                </>
              ) : (
                <p className="placeholder">No field data available.</p>
              )}
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}
