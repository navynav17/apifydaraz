# Daraz Nepal Apify Collector

Puppeteer-based Daraz Nepal collector for Apify. One category is processed per Actor run.

## Supported categories

- smartphone
- tablet
- laptop
- desktop computer
- printer
- camera
- smart tv
- computer monitor
- refrigerator
- washing machine
- air conditioner
- dishwasher

## Input example

```json
{
  "category": "smartphone",
  "maxPages": 1000,
  "minPrice": 5000,
  "pageDelayMs": 1500,
  "detailDelayMs": 1500,
  "maxRunSeconds": 900
}
```

The collector excludes only products below the minimum price, deduplicates by Daraz item ID/URL, crawls PDPs, captures product URLs and available specifications, and pushes products plus a final summary to the default Apify Dataset.

## Supabase persistence

The Actor also writes each successful Daraz PDP directly to the NepalMarketPrice Supabase project:

- `products` — current product information, URL, price, marketplace and Daraz item ID
- `price_history` — a price snapshot for each successful collection
- `product_enrichment_queue` — raw full PDP specifications in the `specifications` JSONB column

The Actor uses the existing Daraz marketplace ID and the unique `(marketplace_id, external_id)` product key.

### Required Apify environment variable

In the Actor's **Settings → Environment variables**, add:

```text
SUPABASE_SERVICE_ROLE_KEY=<your Supabase service-role/secret key>
```

`SUPABASE_URL` is optional because the NepalMarketPrice project URL is configured as the default. If you prefer, it can also be set explicitly.

**Never put the Supabase service-role/secret key in GitHub, `INPUT_SCHEMA.json`, or Actor input.** Store it only as an Apify secret/environment variable.

## Apify Console

Create an Actor from this GitHub repository and use the repository root as the Actor source. The repository contains `Dockerfile`, `main.ts`, `package.json`, and `INPUT_SCHEMA.json`.

For the current PDP workload, set the Apify run timeout to at least **900 seconds (15 minutes)**. The `maxRunSeconds` input controls the collector's own time budget; the Apify run timeout must also be long enough for the collector to finish.
