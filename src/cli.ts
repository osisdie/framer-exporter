#!/usr/bin/env node
import { Command } from 'commander';
import path from 'node:path';
import { runExport } from './commands/export.js';
import { runServe } from './commands/serve.js';
import { logger } from './utils/logger.js';

const program = new Command();

program
  .name('framer-exporter')
  .description('Download a Framer site and output a fully decoupled static website.')
  .version('0.1.0');

program
  .command('export')
  .description('Crawl and export a Framer site to a local directory.')
  .argument('<url>', 'Framer editor / preview / published / custom-domain URL')
  .option('-o, --out <dir>', 'Output directory', './output')
  .option('-c, --concurrency <n>', 'Parallel page crawl', (v) => parseInt(v, 10), 3)
  .option('-d, --depth <n>', 'BFS max depth (0 = unlimited)', (v) => parseInt(v, 10), 10)
  .option('--headed', 'Force headed browser even if session exists', false)
  .option('--no-scroll', 'Skip lazy-load scroll trigger')
  .option('--viewport-width <n>', 'Capture viewport width', (v) => parseInt(v, 10), 1440)
  .option('--keep-cdn', "Don't rewrite CDN URLs (debug)", false)
  .option(
    '--canonical-url <url>',
    'Override <link rel=canonical> and og:url in the export so the static site no longer advertises its Framer preview URL',
  )
  .option(
    '--strip-selector <selector>',
    'Remove every element matching this CSS selector from every page (cheerio supports :has() and :contains()). Repeatable.',
    (value: string, prev: string[] = []) => prev.concat(value),
    [] as string[],
  )
  .option('--subscribe-url <url>', 'Keep the subscribe form but redirect clicks to this URL (opens in a new tab) instead of submitting')
  .option('--subscribe-text <text>', 'Label to show on the subscribe button when --subscribe-url is set', 'Subscribe')
  .option('--user-data-dir <dir>', 'Persistent browser profile dir', './.browser-data')
  .action(async (url: string, options: Record<string, unknown>) => {
    try {
      const subscribeUrl = options.subscribeUrl as string | undefined;
      await runExport({
        url,
        outDir: options.out as string,
        concurrency: options.concurrency as number,
        depth: options.depth as number,
        headed: options.headed as boolean,
        scroll: options.scroll as boolean,
        viewportWidth: options.viewportWidth as number,
        keepCdn: options.keepCdn as boolean,
        userDataDir: path.resolve(options.userDataDir as string),
        canonicalUrl: options.canonicalUrl as string | undefined,
        stripSelectors: options.stripSelector as string[] | undefined,
        subscribeRedirect: subscribeUrl
          ? { url: subscribeUrl, text: options.subscribeText as string }
          : undefined,
      });
    } catch (err) {
      logger.error({ err: (err as Error).message, stack: (err as Error).stack }, 'export-failed');
      process.exit(1);
    }
  });

program
  .command('serve')
  .description('Serve the exported static site via sirv.')
  .option('-o, --out <dir>', 'Directory to serve', './output')
  .option('-p, --port <n>', 'Port', (v) => parseInt(v, 10), 3000)
  .action(async (options: Record<string, unknown>) => {
    try {
      await runServe({
        outDir: options.out as string,
        port: options.port as number,
      });
    } catch (err) {
      logger.error({ err: (err as Error).message }, 'serve-failed');
      process.exit(1);
    }
  });

program.parseAsync(process.argv).catch((err) => {
  logger.error({ err: (err as Error).message }, 'cli-error');
  process.exit(1);
});
