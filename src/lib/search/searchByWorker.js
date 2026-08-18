import lunr from 'lunr';
import {
  fetchIndexesByWorker as fetchIndexesByWorkerProd,
  searchByWorker as searchByWorkerProd,
} from '@easyops-cn/docusaurus-search-local/dist/client/client/theme/searchByWorker';
import {
  language,
  searchIndexUrl,
} from '@generated/@easyops-cn/docusaurus-search-local/default/generated-constants.js';
import {tokenize} from '@easyops-cn/docusaurus-search-local/dist/client/client/utils/tokenize';
import {smartQueries} from '@easyops-cn/docusaurus-search-local/dist/client/client/utils/smartQueries';
import {SearchDocumentType} from '@easyops-cn/docusaurus-search-local/dist/client/shared/interfaces';
import {sortSearchResults} from '@easyops-cn/docusaurus-search-local/dist/client/client/utils/sortSearchResults';
import {processTreeStatusOfSearchResults} from '@easyops-cn/docusaurus-search-local/dist/client/client/utils/processTreeStatusOfSearchResults';

const cache = new Map();

async function lowLevelFetchIndexes(baseUrl, searchContext) {
  const cacheKey = `${baseUrl}${searchContext}`;
  let promise = cache.get(cacheKey);

  if (!promise) {
    promise = legacyFetchIndexes(baseUrl, searchContext);
    cache.set(cacheKey, promise);
  }

  return promise;
}

async function legacyFetchIndexes(baseUrl, searchContext) {
  const url = `${baseUrl}${searchIndexUrl.replace(
    '{dir}',
    searchContext ? `-${searchContext.replace(/\//g, '-')}` : '',
  )}`;
  const fullUrl = new URL(url, location.origin);

  if (fullUrl.origin !== location.origin) {
    throw new Error('Unexpected version url');
  }

  const json = await (await fetch(url)).json();
  const wrappedIndexes = json.map(({documents, index}, type) => ({
    type,
    documents,
    index: lunr.Index.load(index),
  }));

  const zhDictionary = json.reduce((acc, item) => {
    for (const tuple of item.index.invertedIndex) {
      if (/\p{Unified_Ideograph}/u.test(tuple[0][0])) {
        acc.add(tuple[0]);
      }
    }

    return acc;
  }, new Set());

  return {
    wrappedIndexes,
    zhDictionary: Array.from(zhDictionary),
  };
}

async function searchLocally(baseUrl, searchContext, input, limit) {
  const rawTokens = tokenize(input, language);

  if (rawTokens.length === 0) {
    return [];
  }

  const {wrappedIndexes, zhDictionary} = await lowLevelFetchIndexes(baseUrl, searchContext);
  const queries = smartQueries(rawTokens, zhDictionary);
  const results = [];

  search: for (const {term, tokens} of queries) {
    for (const {documents, index, type} of wrappedIndexes) {
      results.push(
        ...index
          .query((query) => {
            for (const item of term) {
              query.term(item.value, {
                wildcard: item.wildcard,
                presence: item.presence,
                ...(item.editDistance ? {editDistance: item.editDistance} : null),
              });
            }
          })
          .slice(0, limit)
          .filter((result) => !results.some((item) => item.document.i.toString() === result.ref))
          .slice(0, limit - results.length)
          .map((result) => {
            const document = documents.find((doc) => doc.i.toString() === result.ref);

            return {
              document,
              type,
              page:
                type !== SearchDocumentType.Title &&
                wrappedIndexes[0].documents.find((doc) => doc.i === document.p),
              metadata: result.matchData.metadata,
              tokens,
              score: result.score,
            };
          }),
      );

      if (results.length >= limit) {
        break search;
      }
    }
  }

  sortSearchResults(results);
  processTreeStatusOfSearchResults(results);
  return results;
}

export async function fetchIndexesByWorker(baseUrl, searchContext) {
  if (process.env.NODE_ENV === 'production') {
    return fetchIndexesByWorkerProd(baseUrl, searchContext);
  }

  await lowLevelFetchIndexes(baseUrl, searchContext);
}

export async function searchByWorker(baseUrl, searchContext, input, limit) {
  if (process.env.NODE_ENV === 'production') {
    return searchByWorkerProd(baseUrl, searchContext, input, limit);
  }

  return searchLocally(baseUrl, searchContext, input, limit);
}
