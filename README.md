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
  "detailDelayMs": 1500
}
```

The collector excludes only products below the minimum price, deduplicates by Daraz item ID/URL, crawls PDPs, captures product URLs and available specifications, and pushes products plus a final summary to the default Apify Dataset.

## Apify Console

Create an Actor from this GitHub repository and use the repository root as the Actor source. The repository contains `Dockerfile`, `main.ts`, `package.json`, and `INPUT_SCHEMA.json`.
