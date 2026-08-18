import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type {LoadContext, Plugin} from '@docusaurus/types';
import type {SiteStats} from '../../lib/siteStats';

const CONTENT_ROOTS = ['docs/resources', 'docs/application-notes', 'docs/notes'];
const MARKDOWN_EXTENSIONS = new Set(['.md', '.mdx']);

function walkFiles(directory: string): string[] {
  if (!fs.existsSync(directory)) {
    return [];
  }

  return fs.readdirSync(directory, {withFileTypes: true}).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    return entry.isDirectory() ? walkFiles(entryPath) : [entryPath];
  });
}

function isContentPage(filePath: string): boolean {
  const fileName = path.basename(filePath);
  const baseName = path.basename(filePath, path.extname(filePath));
  return (
    MARKDOWN_EXTENSIONS.has(path.extname(fileName).toLowerCase()) &&
    baseName !== 'index' &&
    !baseName.startsWith('_category_')
  );
}

function countResourceEntries(resourcesRoot: string): number {
  if (!fs.existsSync(resourcesRoot)) {
    return 0;
  }

  return fs
    .readdirSync(resourcesRoot, {withFileTypes: true})
    .flatMap((category) => {
      if (!category.isDirectory()) {
        return [];
      }

      const categoryPath = path.join(resourcesRoot, category.name);
      return fs
        .readdirSync(categoryPath, {withFileTypes: true})
        .filter(
          (entry) =>
            entry.isDirectory() &&
            fs.existsSync(path.join(categoryPath, entry.name, 'index.md')),
        );
    }).length;
}

function getLatestContentDate(siteDir: string, contentRoots: string[]): string {
  try {
    const latestCommitDate = execFileSync(
      'git',
      ['log', '-1', '--format=%cs', '--', ...contentRoots],
      {cwd: siteDir, encoding: 'utf8'},
    ).trim();

    if (latestCommitDate) {
      return latestCommitDate.slice(0, 7);
    }
  } catch {
    // Local folders without Git metadata still get a useful fallback below.
  }

  const latestFile = contentRoots
    .flatMap((root) => walkFiles(path.join(siteDir, root)))
    .filter(isContentPage)
    .map((filePath) => fs.statSync(filePath))
    .sort((left, right) => right.mtimeMs - left.mtimeMs)[0];

  return latestFile
    ? latestFile.mtime.toISOString().slice(0, 7)
    : new Date().toISOString().slice(0, 7);
}

function collectSiteStats(siteDir: string): SiteStats {
  const resourcesRoot = path.join(siteDir, 'docs/resources');
  const applicationNotesRoot = path.join(siteDir, 'docs/application-notes');
  const notesRoot = path.join(siteDir, 'docs/notes');

  return {
    resources: countResourceEntries(resourcesRoot),
    applicationNotes: walkFiles(applicationNotesRoot).filter(isContentPage).length,
    notes: walkFiles(notesRoot).filter(isContentPage).length,
    updatedAt: getLatestContentDate(siteDir, CONTENT_ROOTS),
  };
}

export default function siteStatsPlugin(context: LoadContext): Plugin<SiteStats> {
  return {
    name: 'site-stats',
    loadContent() {
      return collectSiteStats(context.siteDir);
    },
    contentLoaded({content, actions}) {
      actions.setGlobalData(content);
    },
  };
}
