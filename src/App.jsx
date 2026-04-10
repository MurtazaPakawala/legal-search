import { useEffect, useState } from 'react';

const defaultQuery = 'Find the clause about confidentiality obligations.';

export default function App() {
  const [query, setQuery] = useState(defaultQuery);
  const [status, setStatus] = useState({ ok: false, hasApiKey: false });
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    fetch('/api/health')
      .then((response) => response.json())
      .then((data) => setStatus(data))
      .catch(() => {
        setStatus({ ok: false, hasApiKey: false });
      });
  }, []);

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
        throw new Error(data.error || 'Request failed.');
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

  return (
    <main className="app-shell">
      <section className="hero">
        <p className="eyebrow">Isaacus + React</p>
        <h1>Minimal legal search demo</h1>
        <p className="intro">
          Type a legal-style question, send it to the backend, and visualize how
          Isaacus reranks a tiny set of sample clauses.
        </p>
      </section>

      <section className="panel">
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
        </div>

        {error ? <p className="error-box">{error}</p> : null}

        <div className="results">
          {results.length === 0 ? (
            <p className="placeholder">
              Run the demo to see ranked clauses and their scores.
            </p>
          ) : (
            results.map((result) => (
              <article className="result-card" key={result.id}>
                <div className="result-head">
                  <h2>{result.title}</h2>
                  <strong>{(result.score * 100).toFixed(1)}%</strong>
                </div>
                <div className="bar-track">
                  <div
                    className="bar-fill"
                    style={{ width: `${Math.max(result.score * 100, 4)}%` }}
                  />
                </div>
                <p>{result.text}</p>
              </article>
            ))
          )}
        </div>
      </section>
    </main>
  );
}
