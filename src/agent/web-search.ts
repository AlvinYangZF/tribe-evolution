const BRAVE_SEARCH_URL = 'https://api.search.brave.com/res/v1/web/search';
const SEARCH_TIMEOUT_MS = 15_000;

export interface SearchResult {
  title?: string;
  snippet?: string;
  url?: string;
}

/**
 * Search the web using the Brave Search API.
 * Returns an array of result snippets.
 */
export async function searchWeb(query: string): Promise<string[]> {
  const apiKey = process.env.BRAVE_API_KEY;
  if (!apiKey) {
    return [];
  }

  try {
    const url = new URL(BRAVE_SEARCH_URL);
    url.searchParams.set('q', query);

    let response: Response;
    try {
      response = await fetch(url.toString(), {
        headers: {
          Accept: 'application/json',
          'Accept-Encoding': 'gzip',
          'X-Subscription-Token': apiKey,
        },
        signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
      });
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'TimeoutError') {
        console.error(`Brave Search timed out after ${SEARCH_TIMEOUT_MS / 1000}s`);
        return [];
      }
      throw err;
    }

    if (!response.ok) {
      console.error(`Brave Search API error: ${response.status} ${response.statusText}`);
      return [];
    }

    const data = await response.json() as {
      web?: { results?: SearchResult[] };
    };

    return (data.web?.results ?? []).map((r) => r.snippet ?? '').filter(Boolean);
  } catch (error) {
    console.error('Brave Search API call failed:', error);
    return [];
  }
}
