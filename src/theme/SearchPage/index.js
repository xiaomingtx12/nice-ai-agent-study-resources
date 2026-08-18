import React, {useCallback, useEffect, useMemo, useState} from 'react';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import Layout from '@theme/Layout';
import Head from '@docusaurus/Head';
import Link from '@docusaurus/Link';
import {translate} from '@docusaurus/Translate';
import {usePluralForm} from '@docusaurus/theme-common';
import clsx from 'clsx';
import useSearchQuery from '@easyops-cn/docusaurus-search-local/dist/client/client/theme/hooks/useSearchQuery';
import {fetchIndexesByWorker, searchByWorker} from '../../lib/search/searchByWorker';
import {SearchDocumentType} from '@easyops-cn/docusaurus-search-local/dist/client/shared/interfaces';
import {highlight} from '@easyops-cn/docusaurus-search-local/dist/client/client/utils/highlight';
import {highlightStemmed} from '@easyops-cn/docusaurus-search-local/dist/client/client/utils/highlightStemmed';
import {getStemmedPositions} from '@easyops-cn/docusaurus-search-local/dist/client/client/utils/getStemmedPositions';
import LoadingRing from '@easyops-cn/docusaurus-search-local/dist/client/client/theme/LoadingRing/LoadingRing';
import {concatDocumentPath} from '@easyops-cn/docusaurus-search-local/dist/client/client/utils/concatDocumentPath';
import {
  Mark,
  searchContextByPaths,
  useAllContextsWithNoSearchContext,
} from '@generated/@easyops-cn/docusaurus-search-local/default/generated.js';
import styles from '@easyops-cn/docusaurus-search-local/dist/client/client/theme/SearchPage/SearchPage.module.css';
import {normalizeContextByPath} from '@easyops-cn/docusaurus-search-local/dist/client/client/utils/normalizeContextByPath';

const DEV_SEARCH_INDEX_WARNING =
  '⚠️ 开发模式搜索索引未准备好，请先运行 npm run build 生成搜索索引。';

export default function SearchPage() {
  return (
    <Layout>
      <SearchPageContent />
    </Layout>
  );
}

function SearchPageContent() {
  const {
    siteConfig: {baseUrl},
    i18n: {currentLocale},
  } = useDocusaurusContext();
  const {selectMessage} = usePluralForm();
  const {
    searchValue,
    searchContext,
    searchVersion,
    updateSearchPath,
    updateSearchContext,
  } = useSearchQuery();
  const [searchQuery, setSearchQuery] = useState(searchValue);
  const [searchResults, setSearchResults] = useState();
  const [searchWorkerReady, setSearchWorkerReady] = useState(false);
  const [searchIndexAvailable, setSearchIndexAvailable] = useState(true);
  const versionUrl = `${baseUrl}${searchVersion}`;
  const pageTitle = useMemo(
    () =>
      searchQuery
        ? translate(
            {
              id: 'theme.SearchPage.existingResultsTitle',
              message: 'Search results for "{query}"',
              description: 'The search page title for non-empty query',
            },
            {
              query: searchQuery,
            },
          )
        : translate({
            id: 'theme.SearchPage.emptyResultsTitle',
            message: 'Search the documentation',
            description: 'The search page title for empty query',
          }),
    [searchQuery],
  );

  useEffect(() => {
    updateSearchPath(searchQuery);

    if (!searchQuery) {
      setSearchResults(undefined);
      return;
    }

    if (!searchWorkerReady) {
      return;
    }

    if (!searchIndexAvailable) {
      setSearchResults([]);
      return;
    }

    (async () => {
      const results = await searchByWorker(versionUrl, searchContext, searchQuery, 100);
      setSearchResults(results);
    })();
  }, [searchQuery, versionUrl, searchContext, searchWorkerReady, searchIndexAvailable]);

  const handleSearchInputChange = useCallback((event) => {
    setSearchQuery(event.target.value);
  }, []);

  useEffect(() => {
    if (searchValue && searchValue !== searchQuery) {
      setSearchQuery(searchValue);
    }
  }, [searchValue, searchQuery]);

  useEffect(() => {
    async function doFetchIndexes() {
      try {
        if (
          !Array.isArray(searchContextByPaths) ||
          searchContext ||
          useAllContextsWithNoSearchContext
        ) {
          await fetchIndexesByWorker(versionUrl, searchContext);
        }

        setSearchIndexAvailable(true);
      } catch (error) {
        setSearchIndexAvailable(false);
      }

      setSearchWorkerReady(true);
    }

    doFetchIndexes();
  }, [searchContext, versionUrl]);

  return (
    <>
      <Head>
        <meta property="robots" content="noindex, follow" />
        <title>{pageTitle}</title>
      </Head>

      <div className="container margin-vert--lg">
        <h1>{pageTitle}</h1>

        <div className="row">
          <div
            className={clsx('col', {
              [styles.searchQueryColumn]: Array.isArray(searchContextByPaths),
              'col--9': Array.isArray(searchContextByPaths),
              'col--12': !Array.isArray(searchContextByPaths),
            })}>
            <input
              type="search"
              name="q"
              className={styles.searchQueryInput}
              aria-label="Search"
              onChange={handleSearchInputChange}
              value={searchQuery}
              autoComplete="off"
              autoFocus
            />
          </div>
          {Array.isArray(searchContextByPaths) ? (
            <div className={clsx('col', 'col--3', 'padding-left--none', styles.searchContextColumn)}>
              <select
                name="search-context"
                className={styles.searchContextInput}
                id="context-selector"
                value={searchContext}
                onChange={(event) => updateSearchContext(event.target.value)}>
                {useAllContextsWithNoSearchContext && (
                  <option value="">
                    {translate({
                      id: 'theme.SearchPage.searchContext.everywhere',
                      message: 'Everywhere',
                    })}
                  </option>
                )}
                {searchContextByPaths.map((context) => {
                  const {label, path} = normalizeContextByPath(context, currentLocale);
                  return (
                    <option key={path} value={path}>
                      {label}
                    </option>
                  );
                })}
              </select>
            </div>
          ) : null}
        </div>

        {!searchWorkerReady && searchQuery && (
          <div>
            <LoadingRing />
          </div>
        )}

        {searchResults &&
          (searchResults.length > 0 ? (
            <p>
              {selectMessage(
                searchResults.length,
                translate(
                  {
                    id: 'theme.SearchPage.documentsFound.plurals',
                    message: '1 document found|{count} documents found',
                    description:
                      'Pluralized label for "{count} documents found".',
                  },
                  {count: searchResults.length},
                ),
              )}
            </p>
          ) : searchIndexAvailable ? (
            <p>
              {translate({
                id: 'theme.SearchPage.noResultsText',
                message: 'No documents were found',
                description: 'The paragraph for empty search result',
              })}
            </p>
          ) : (
            <p>{DEV_SEARCH_INDEX_WARNING}</p>
          ))}

        <section>
          {searchResults &&
            searchResults.map((item) => (
              <SearchResultItem key={item.document.i} searchResult={item} />
            ))}
        </section>
      </div>
    </>
  );
}

function SearchResultItem({
  searchResult: {document, type, page, tokens, metadata},
}) {
  const isTitle = type === SearchDocumentType.Title;
  const isKeywords = type === SearchDocumentType.Keywords;
  const isDescription = type === SearchDocumentType.Description;
  const isDescriptionOrKeywords = isDescription || isKeywords;
  const isTitleRelated = isTitle || isDescriptionOrKeywords;
  const isContent = type === SearchDocumentType.Content;
  const pathItems = (isTitle ? document.b : page.b).slice();
  const articleTitle = isContent || isDescriptionOrKeywords ? document.s : document.t;
  let search = '';

  if (!isTitleRelated) {
    pathItems.push(page.t);
  }

  if (Mark && tokens.length > 0) {
    const params = new URLSearchParams();

    for (const token of tokens) {
      params.append('_highlight', token);
    }

    search = `?${params.toString()}`;
  }

  return (
    <article className={styles.searchResultItem}>
      <h2>
        <Link
          to={document.u + search + (document.h || '')}
          dangerouslySetInnerHTML={{
            __html:
              isContent || isDescriptionOrKeywords
                ? highlight(articleTitle, tokens)
                : highlightStemmed(articleTitle, getStemmedPositions(metadata, 't'), tokens, 100),
          }}
        />
      </h2>
      {pathItems.length > 0 && (
        <p className={styles.searchResultItemPath}>{concatDocumentPath(pathItems)}</p>
      )}
      {(isContent || isDescription) && (
        <p
          className={styles.searchResultItemSummary}
          dangerouslySetInnerHTML={{
            __html: highlightStemmed(
              document.t,
              getStemmedPositions(metadata, 't'),
              tokens,
              100,
            ),
          }}
        />
      )}
    </article>
  );
}
